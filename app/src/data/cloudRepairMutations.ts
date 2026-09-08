/**
 * 云端「维修单」写操作（仅受控 SECURITY DEFINER RPC）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudContractMutations 同级别的安全边界）：
 * - repair_orders 为「封闭业务表」，仅 SELECT，写入必须走受控 RPC：
 *   create_repair_order / start_repair / complete_repair（SECURITY DEFINER，
 *   服务端完整校验 + 原子提交，并同步维护 rental_items.status）。
 *   本层绝不直接对 repair_orders / rental_items.status 做 INSERT/UPDATE/DELETE。
 * - 只调用 rdb.rpc，参数名与 migration 中函数签名严格一致：
 *   create_repair_order(p_item_id, p_contractor_id, p_request_date, p_fault_description) → bigint(新 repair_id)；
 *   start_repair(p_repair_id) → void；
 *   complete_repair(p_repair_id, p_repair_date, p_repair_hours, p_notes) → void。
 * - 角色语义（与 RPC 内部一致）：
 *   create_repair_order 仅 admin/staff；start_repair / complete_repair 仅 contractor
 *   （且 RPC 内部用 auth.uid() 关联 contractor_id，自动校验「只能操作本人承接的维修单」，
 *   因此 start/complete 前端不传 contractor_id，绝不信客户端）。
 * - RPC 成功后绝不本地伪造维修单数据：create 仅透传 RPC 返回的 repair_id，
 *   start/complete 为 void，均由 Hook 触发「重新查询云端列表」（re-read），
 *   页面展示的均为云端真实数据。
 * - 结构校验（正安全整数 / 严格日期 / 工时 0.25 步进 / 非空文本）在 rpc 之前完成，
 *   非法字段/ID 直接返回字段级错误，绝不触达 rpc；存在性/状态/业务约束由 RPC 服务端兜底。
 * - 统一安全错误映射，不泄露 SQL、表名、约束名、原始 details/hint、Token、以及 RPC 内部业务细节。
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 */
import type { OpResult } from './types'
import { parsePositiveIntId, parseOptionalDate } from './cloudMaster'

// ---------------------------------------------------------------------------
// 安全错误常量（不包含底层细节）
// ---------------------------------------------------------------------------

/** 维修单写操作统一安全错误 */
export const SAFE_REPAIR_WRITE_ERROR = '维修操作失败，请稍后重试'
/** 维修单无权限（42501 / 前端角色门禁） */
export const REPAIR_PERMISSION_ERROR = '无权限执行该操作'

// ---------------------------------------------------------------------------
// 云端输入类型（与 RPC 参数一一对应，仅业务字段）
// ---------------------------------------------------------------------------

/** 创建维修单输入（rate_id 由 RPC 服务端按 request_date 冻结，前端不传） */
export interface RepairCreateCloudInput {
  item_id: number
  contractor_id: number
  request_date: string
  fault_description: string
}

/** 完成维修输入（calculated_cost 由 RPC 服务端按冻结费率 × 工时复算，前端不传金额） */
export interface RepairCompleteCloudInput {
  repair_id: number
  repair_date: string
  repair_hours: number
  notes: string
}

// ---------------------------------------------------------------------------
// 可注入的最小 RPC 写客户端（Node 可用 fake client 验证 rpc 调用链）
// ---------------------------------------------------------------------------

/** RPC 返回结果（真实 SDK 为 PostgrestResponse：data + error） */
export interface RepairMutationRpcResponse {
  data: unknown
  error: unknown
}

/** 维修单写操作所需的最小 RPC 客户端（仅 rpc 方法） */
export interface RepairMutationRpcClient {
  rpc(fn: string, args?: unknown): Promise<RepairMutationRpcResponse>
}

// ---------------------------------------------------------------------------
// 输入归一化与校验（结构校验，在 rpc 之前完成）
// ---------------------------------------------------------------------------

/** 正安全整数校验（所有外键 / ID 精确校验前必须通过） */
export function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/** 严格日期校验：真实 YYYY-MM-DD（复用 cloudMaster.parseOptionalDate） */
function isValidDate(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const r = parseOptionalDate(v)
  return r !== 'INVALID' && r !== null
}

/** 非空文本校验（trim 后非空，口径与 DataService/RPC btrim 一致） */
function isNonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 工时 0.25 步进校验（浮点容差 1e-9，口径与 validate.ts 一致） */
function isQuarterHourStep(v: number): boolean {
  return Math.abs(v * 4 - Math.round(v * 4)) <= 1e-9
}

/**
 * 创建维修单字段校验（结构校验，不校验存在性/在库/费率，那些由 RPC 服务端兜底）：
 * - item_id / contractor_id：正安全整数；
 * - request_date：严格 YYYY-MM-DD 真实日期；
 * - fault_description：非空文本。
 */
export function validateCreateRepairFields(
  input: RepairCreateCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.item_id)) {
    return { ok: false, error: '设备不能为空', field: 'item_id' }
  }
  if (!isPositiveSafeInt(input.contractor_id)) {
    return { ok: false, error: '承包商不能为空', field: 'contractor_id' }
  }
  if (!isValidDate(input.request_date)) {
    return { ok: false, error: '申请日期不能为空且须为合法日期', field: 'request_date' }
  }
  if (!isNonBlank(input.fault_description)) {
    return { ok: false, error: '故障描述不能为空', field: 'fault_description' }
  }
  return { ok: true }
}

/**
 * 完成维修字段校验（结构校验，不校验归属/状态/日期顺序，那些由 RPC 服务端兜底）：
 * - repair_id：正安全整数；
 * - repair_date：严格 YYYY-MM-DD 真实日期；
 * - repair_hours：> 0 且 0.25 步进；
 * - notes：非空文本。
 */
export function validateCompleteRepairFields(
  input: RepairCompleteCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.repair_id)) {
    return { ok: false, error: '维修单不能为空', field: 'repair_id' }
  }
  if (!isValidDate(input.repair_date)) {
    return { ok: false, error: '维修完成日期不能为空且须为合法日期', field: 'repair_date' }
  }
  if (typeof input.repair_hours !== 'number' || !Number.isFinite(input.repair_hours) || input.repair_hours <= 0) {
    return { ok: false, error: '维修工时必须大于 0', field: 'repair_hours' }
  }
  if (!isQuarterHourStep(input.repair_hours)) {
    return { ok: false, error: '维修工时须按 0.25 小时步进', field: 'repair_hours' }
  }
  if (!isNonBlank(input.notes)) {
    return { ok: false, error: '维修说明不能为空', field: 'notes' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 安全错误映射（依据 PostgREST error.code = PostgreSQL SQLSTATE）
// ---------------------------------------------------------------------------

function toSqlState(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    return (error as { code?: unknown }).code
  }
  return undefined
}

/**
 * 维修单 RPC 错误映射，绝不泄露底层细节：
 * - 42501：权限不足（虽然前端已做角色门禁，作为纵深防护）；
 * - P0001：RAISE EXCEPTION（我们的 SECURITY DEFINER RPC 抛出的业务校验错误），
 *   统一收口为通用安全错误（具体业务校验已由前端结构校验兜底，其余为服务端竞态/约束兜底）；
 * - 其余未知错误一律通用安全错误。
 */
function mapRepairRpcError(error: unknown): { ok: false; error: string } {
  const code = toSqlState(error)
  if (code === '42501') {
    return { ok: false, error: REPAIR_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_REPAIR_WRITE_ERROR }
}

/** 解析 create_repair_order RPC 返回值（bigint 新 repair_id）：兼容标量 / 单元素数组 / 数字字符串 */
function parseReturnedRepairId(data: unknown): number | 'INVALID' {
  let v: unknown = data
  if (Array.isArray(data)) {
    if (data.length !== 1) return 'INVALID'
    v = data[0]
  }
  return parsePositiveIntId(v as number | string | null | undefined)
}

// ---------------------------------------------------------------------------
// 云端维修单写操作（可注入 RPC 客户端，仅 rdb.rpc）
// ---------------------------------------------------------------------------

/**
 * 云端创建维修单：rpc create_repair_order；成功后仅透传 RPC 返回的 repair_id，
 * 绝不本地伪造维修单对象（由 Hook 触发重新查询云端列表）。
 */
export async function createRepairOrder(
  rpcClient: RepairMutationRpcClient,
  input: RepairCreateCloudInput,
): Promise<OpResult<{ repair_id: number }>> {
  const v = validateCreateRepairFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  try {
    const { data, error } = await rpcClient.rpc('create_repair_order', {
      p_item_id: input.item_id,
      p_contractor_id: input.contractor_id,
      p_request_date: input.request_date,
      p_fault_description: input.fault_description,
    })
    if (error) return mapRepairRpcError(error)
    const repairId = parseReturnedRepairId(data)
    if (repairId === 'INVALID') return { ok: false, error: SAFE_REPAIR_WRITE_ERROR }
    return { ok: true, data: { repair_id: repairId } }
  } catch {
    return { ok: false, error: SAFE_REPAIR_WRITE_ERROR }
  }
}

/** 云端开始维修：rpc start_repair（void）；成功后由 Hook 触发重新查询云端列表 */
export async function startRepair(
  rpcClient: RepairMutationRpcClient,
  repairId: number,
): Promise<OpResult> {
  try {
    const { error } = await rpcClient.rpc('start_repair', {
      p_repair_id: repairId,
    })
    if (error) return mapRepairRpcError(error)
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_REPAIR_WRITE_ERROR }
  }
}

/** 云端完成维修：rpc complete_repair（void）；成功后由 Hook 触发重新查询云端列表 */
export async function completeRepair(
  rpcClient: RepairMutationRpcClient,
  input: RepairCompleteCloudInput,
): Promise<OpResult> {
  const v = validateCompleteRepairFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  try {
    const { error } = await rpcClient.rpc('complete_repair', {
      p_repair_id: input.repair_id,
      p_repair_date: input.repair_date,
      p_repair_hours: input.repair_hours,
      p_notes: input.notes,
    })
    if (error) return mapRepairRpcError(error)
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_REPAIR_WRITE_ERROR }
  }
}
