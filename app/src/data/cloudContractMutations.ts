/**
 * 云端「租赁合同」写操作（仅受控 SECURITY DEFINER RPC）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudContractorMutations / cloudCustomerMutations 同级别的安全边界）：
 * - 合同 / 明细 / 变更 / 设备状态为「封闭业务表」，仅 SELECT，写入必须走受控 RPC：
 *   create_contract / exchange_item / return_items（SECURITY DEFINER，服务端完整校验 + 原子提交）。
 *   本层绝不直接对 rental_contracts / contract_lines / contract_changes / rental_items.status
 *   做 INSERT/UPDATE/DELETE（那是 RPC 内部的职责）。
 * - 只调用 rdb.rpc，参数名与 migration 中函数签名严格一致：
 *   create_contract(p_customer_id, p_contract_date, p_duration_days, p_item_ids) → bigint(新合同 id)；
 *   exchange_item(p_contract_id, p_old_line_id, p_new_item_id, p_return_store_id, p_change_date) → void；
 *   return_items(p_contract_id, p_line_ids, p_return_store_id) → void。
 * - RPC 成功后绝不本地伪造合同数据：仅把 RPC 返回的 contract_id 透传给调用方，
 *   由 Hook 触发「重新查询云端列表/详情」（re-read），页面展示的均为云端真实数据。
 * - 结构校验（正安全整数 / 严格日期 / 正整数 / 非空且去重数组）在 rpc 之前完成，
 *   非法字段/ID 直接返回字段级错误，绝不触达 rpc；存在性/状态/业务约束由 RPC 服务端兜底。
 * - 统一安全错误映射，不泄露 SQL、表名、约束名、原始 details/hint、Token、以及 RPC 内部业务细节。
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 */
import type { OpResult } from './types'
import { parsePositiveIntId, parseOptionalDate } from './cloudMaster'

// ---------------------------------------------------------------------------
// 安全错误常量（不包含底层细节）
// ---------------------------------------------------------------------------

/** 合同写操作统一安全错误 */
export const SAFE_CONTRACT_WRITE_ERROR = '合同操作失败，请稍后重试'
/** 合同无权限（42501 / 前端角色门禁） */
export const CONTRACT_PERMISSION_ERROR = '无权限执行该操作'

// ---------------------------------------------------------------------------
// 云端输入类型（与 RPC 参数一一对应，仅业务字段）
// ---------------------------------------------------------------------------

/** 创建合同并借出输入（quantity 恒为 1，item_ids 每项一件） */
export interface ContractCreateCloudInput {
  customer_id: number
  contract_date: string
  duration_days: number
  item_ids: number[]
}

/** 换货输入（change_date 为本地日期 YYYY-MM-DD，须为服务器当天） */
export interface ContractExchangeCloudInput {
  contract_id: number
  old_line_id: number
  new_item_id: number
  return_store_id: number
  change_date: string
}

/** 归还输入（批量归还待归还明细） */
export interface ContractReturnCloudInput {
  contract_id: number
  line_ids: number[]
  return_store_id: number
}

// ---------------------------------------------------------------------------
// 可注入的最小 RPC 写客户端（Node 可用 fake client 验证 rpc 调用链）
// ---------------------------------------------------------------------------

/** RPC 返回结果（真实 SDK 为 PostgrestResponse：data + error） */
export interface ContractRpcResponse {
  data: unknown
  error: unknown
}

/** 合同写操作所需的最小 RPC 客户端（仅 rpc 方法） */
export interface ContractRpcClient {
  rpc(fn: string, args?: unknown): Promise<ContractRpcResponse>
}

// ---------------------------------------------------------------------------
// 输入归一化与校验（结构校验，在 rpc 之前完成）
// ---------------------------------------------------------------------------

/** 正安全整数校验（所有外键 / ID 精确校验前必须通过） */
export function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/** 严格日期校验：真实 YYYY-MM-DD（复用 cloudMaster.parseOptionalDate） */
function isValidDate(v: string): boolean {
  return typeof v === 'string' && parseOptionalDate(v) !== 'INVALID' && parseOptionalDate(v) !== null
}

/** 非空且无重复的正安全整数数组（item_ids / line_ids） */
function validateIdArray(
  ids: unknown,
  field: string,
  label: string,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: `请至少选择一件${label}`, field }
  }
  const seen = new Set<number>()
  for (const id of ids) {
    if (!isPositiveSafeInt(id)) {
      return { ok: false, error: `${label}编号不合法`, field }
    }
    if (seen.has(id)) {
      return { ok: false, error: `同一合同不得重复加入相同${label}`, field }
    }
    seen.add(id)
  }
  return { ok: true }
}

/**
 * 创建合同字段校验（结构校验，不校验存在性/在库状态，那些由 RPC 服务端兜底）：
 * - customer_id：正安全整数；
 * - contract_date：严格 YYYY-MM-DD 真实日期；
 * - duration_days：正安全整数；
 * - item_ids：非空、无重复、全部正安全整数。
 */
export function validateCreateContractFields(
  input: ContractCreateCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.customer_id)) {
    return { ok: false, error: '客户不能为空', field: 'customer_id' }
  }
  if (!isValidDate(input.contract_date)) {
    return { ok: false, error: '合同日期不能为空且须为合法日期', field: 'contract_date' }
  }
  if (!isPositiveSafeInt(input.duration_days)) {
    return { ok: false, error: '租赁天数必须为正整数', field: 'duration_days' }
  }
  return validateIdArray(input.item_ids, 'item_ids', '设备')
}

/** 换货字段校验：所有 ID 正安全整数 + change_date 严格日期 */
export function validateExchangeFields(
  input: ContractExchangeCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.contract_id)) {
    return { ok: false, error: '合同不能为空', field: 'contract_id' }
  }
  if (!isPositiveSafeInt(input.old_line_id)) {
    return { ok: false, error: '旧明细不能为空', field: 'old_line_id' }
  }
  if (!isPositiveSafeInt(input.new_item_id)) {
    return { ok: false, error: '新设备不能为空', field: 'new_item_id' }
  }
  if (!isPositiveSafeInt(input.return_store_id)) {
    return { ok: false, error: '归还门店不能为空', field: 'return_store_id' }
  }
  if (!isValidDate(input.change_date)) {
    return { ok: false, error: '换货日期不能为空且须为合法日期', field: 'change_date' }
  }
  return { ok: true }
}

/** 归还字段校验：contract_id / return_store_id 正安全整数 + line_ids 非空无重复 */
export function validateReturnFields(
  input: ContractReturnCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.contract_id)) {
    return { ok: false, error: '合同不能为空', field: 'contract_id' }
  }
  if (!isPositiveSafeInt(input.return_store_id)) {
    return { ok: false, error: '归还门店不能为空', field: 'return_store_id' }
  }
  return validateIdArray(input.line_ids, 'line_ids', '待归还明细')
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
 * 合同 RPC 错误映射，绝不泄露底层细节：
 * - 42501：权限不足（虽然前端已做角色门禁，作为纵深防护）；
 * - P0001：RAISE EXCEPTION（我们的 SECURITY DEFINER RPC 抛出的业务校验错误），
 *   统一收口为通用安全错误（具体业务校验已由前端结构校验兜底，其余为服务端竞态/约束兜底）；
 * - 其余未知错误一律通用安全错误。
 */
function mapContractRpcError(error: unknown): { ok: false; error: string } {
  const code = toSqlState(error)
  if (code === '42501') {
    return { ok: false, error: CONTRACT_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_CONTRACT_WRITE_ERROR }
}

/** 解析 create_contract RPC 返回值（bigint 新合同 id）：兼容标量 / 单元素数组 / 数字字符串 */
function parseReturnedContractId(data: unknown): number | 'INVALID' {
  let v: unknown = data
  if (Array.isArray(data)) {
    if (data.length !== 1) return 'INVALID'
    v = data[0]
  }
  return parsePositiveIntId(v as number | string | null | undefined)
}

// ---------------------------------------------------------------------------
// 云端合同写操作（可注入 RPC 客户端，仅 rdb.rpc）
// ---------------------------------------------------------------------------

/**
 * 云端创建合同：rpc create_contract；成功后仅透传 RPC 返回的 contract_id，
 * 绝不本地伪造合同对象（由 Hook 触发重新查询云端列表/详情）。
 */
export async function createContract(
  rpcClient: ContractRpcClient,
  input: ContractCreateCloudInput,
): Promise<OpResult<{ contract_id: number }>> {
  const v = validateCreateContractFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  try {
    const { data, error } = await rpcClient.rpc('create_contract', {
      p_customer_id: input.customer_id,
      p_contract_date: input.contract_date,
      p_duration_days: input.duration_days,
      p_item_ids: input.item_ids,
    })
    if (error) return mapContractRpcError(error)
    const contractId = parseReturnedContractId(data)
    if (contractId === 'INVALID') return { ok: false, error: SAFE_CONTRACT_WRITE_ERROR }
    return { ok: true, data: { contract_id: contractId } }
  } catch {
    return { ok: false, error: SAFE_CONTRACT_WRITE_ERROR }
  }
}

/** 云端换货：rpc exchange_item（void）；成功后由 Hook 触发重新查询详情 */
export async function exchangeItem(
  rpcClient: ContractRpcClient,
  input: ContractExchangeCloudInput,
): Promise<OpResult> {
  const v = validateExchangeFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  try {
    const { error } = await rpcClient.rpc('exchange_item', {
      p_contract_id: input.contract_id,
      p_old_line_id: input.old_line_id,
      p_new_item_id: input.new_item_id,
      p_return_store_id: input.return_store_id,
      p_change_date: input.change_date,
    })
    if (error) return mapContractRpcError(error)
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_CONTRACT_WRITE_ERROR }
  }
}

/** 云端归还：rpc return_items（void）；成功后由 Hook 触发重新查询详情 */
export async function returnItems(
  rpcClient: ContractRpcClient,
  input: ContractReturnCloudInput,
): Promise<OpResult> {
  const v = validateReturnFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  try {
    const { error } = await rpcClient.rpc('return_items', {
      p_contract_id: input.contract_id,
      p_line_ids: input.line_ids,
      p_return_store_id: input.return_store_id,
    })
    if (error) return mapContractRpcError(error)
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_CONTRACT_WRITE_ERROR }
  }
}
