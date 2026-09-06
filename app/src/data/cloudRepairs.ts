/**
 * 云端「维修单」只读查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 两条云端数据源（按登录角色分派）：
 *   1) admin / staff —— 直接读取 repair_orders + rental_items + contractors +
 *      contractor_rates 四张表（逐张显式列名，绝不用 select('*')），在客户端做
 *      主外键、费率归属与关联完整性校验，并组装出设备编号/名称、承包商名称、
 *      冻结费率（rate_hourly）到统一只读视图 RepairRowView；
 *   2) contractor —— 必须经 SECURITY DEFINER RPC `list_my_repairs()` 读取本人
 *      维修单，绝不额外读取 rental_items / contractors / contractor_rates 绕过其 RLS
 *      （这三张表对 contractor 无 SELECT Policy，直读会被 RLS 挡住/报错）。
 *      RPC 返回聚合列，不含 item_id / contractor_id / rate_id 三个内部 ID，
 *      在 RepairRowView 中明确建模为 null（不可用），绝不伪造。
 *
 * local 模式也统一渲染 RepairRowView（见 repairDataSource.ts 的本地组装），
 * local 的 CRUD / 写操作行为完全不受影响。
 *
 * 严格映射与业务校验（两条路径共享 validateRepairFields 核心，任一错误整体 fail-closed，
 * 返回统一安全错误，绝不泄露 SQL/Token/UID/底层错误或数据值，绝不回退 localStorage）：
 *   - repair_id / item_id / contractor_id / rate_id：正安全整数（超 MAX_SAFE_INTEGER、
 *     非整数、空值一律拒绝）；
 *   - request_date / repair_date：严格 YYYY-MM-DD 真实日期（2026-02-30 之类拒绝）；
 *   - rate_hourly / repair_hours / calculated_cost：兼容 PostgreSQL numeric 字符串
 *     （"1.50" / "300.00"）并归一化为有限 number；
 *   - fault_description / item_code / item_name / contractor_name：必填非空；
 *   - repair_date / repair_hours / calculated_cost / notes：按数据库 nullable 保留 null，
 *     绝不转成 0、空日期或字符串 "null"；
 *   - status 仅允许 待维修 / 维修中 / 已完成；
 *   - 待维修/维修中：repair_date / repair_hours / calculated_cost 必须全部为空；
 *     已完成：三者必须全部非空；
 *   - repair_date 不早于 request_date；
 *   - repair_hours > 0 且为 0.25 的整数倍（浮点容差 1e-9，口径与 validate.ts 一致）；
 *   - calculated_cost = repair_hours × 冻结 hourly_rate（容差 0.005，口径与
 *     validate.ts 一致，服务端复算语义）；
 *   - admin/staff 路径额外校验 rate_id 确实属于 contractor_id（费率归属），
 *     以及 item_id / contractor_id / rate_id 的引用完整性；
 *   - 重复 repair_id 拒绝。
 */
import type { RepairStatus } from './types'
import {
  parsePositiveIntId,
  parseOptionalString,
  parseOptionalDate,
  parseNonBlankString,
  type Invalid,
} from './cloudMaster'
import type { MasterRdbClient } from './cloudMaster'

/** 安全错误文案（不含底层错误细节 / 数据值） */
export const SAFE_REPAIR_ERROR = '维修单数据加载失败'

// ---------------------------------------------------------------------------
// 只读视图模型（两条云端路径 + local 模式共同渲染）
// ---------------------------------------------------------------------------

/**
 * 维修单统一只读视图。
 * item_id / contractor_id / rate_id 三个内部 ID：
 *   - admin/staff 直读路径：真实存在，非 null；
 *   - contractor RPC 路径：list_my_repairs 不返回，建模为 null（不可用，绝不伪造）；
 *   - local 路径：真实存在，非 null。
 * 其余展示字段（item_code/item_name/contractor_name/rate_hourly）两条路径均可用。
 */
export interface RepairRowView {
  repair_id: number
  item_id: number | null
  item_code: string
  item_name: string
  contractor_id: number | null
  contractor_name: string
  rate_id: number | null
  rate_hourly: number
  request_date: string
  fault_description: string
  repair_date: string | null
  repair_hours: number | null
  calculated_cost: number | null
  notes: string | null
  status: RepairStatus
}

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string；可空列类型与数据库一致）
// ---------------------------------------------------------------------------

/** repair_orders 行（11 列，与 REPAIR_ORDER_SELECT_COLUMNS 一一对应） */
export interface CloudRepairOrderRow {
  repair_id: number | string | null | undefined
  item_id: number | string | null | undefined
  contractor_id: number | string | null | undefined
  rate_id: number | string | null | undefined
  request_date: string | null | undefined
  fault_description: string | null | undefined
  repair_date: string | null | undefined
  repair_hours: number | string | null | undefined
  calculated_cost: number | string | null | undefined
  notes: string | null | undefined
  status: string | null | undefined
}

/** rental_items 精简行（仅 item_id/item_code/name，供维修页组装设备名） */
export interface CloudRepairItemRow {
  item_id: number | string | null | undefined
  item_code: string | null | undefined
  name: string | null | undefined
}

/** contractors 精简行（仅 contractor_id/name） */
export interface CloudRepairContractorRow {
  contractor_id: number | string | null | undefined
  name: string | null | undefined
}

/** contractor_rates 精简行（rate_id/contractor_id/hourly_rate，供费率归属 + 成本复算） */
export interface CloudRepairRateRow {
  rate_id: number | string | null | undefined
  contractor_id: number | string | null | undefined
  hourly_rate: number | string | null | undefined
}

/** list_my_repairs RPC 返回行（12 列，不含 item_id/contractor_id/rate_id） */
export interface CloudMyRepairRow {
  repair_id: number | string | null | undefined
  item_code: string | null | undefined
  item_name: string | null | undefined
  contractor_name: string | null | undefined
  rate_hourly: number | string | null | undefined
  request_date: string | null | undefined
  fault_description: string | null | undefined
  repair_date: string | null | undefined
  repair_hours: number | string | null | undefined
  calculated_cost: number | string | null | undefined
  notes: string | null | undefined
  status: string | null | undefined
}

export type RepairReadResult =
  | { ok: true; rows: RepairRowView[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 解析助手（本模块专属）
// ---------------------------------------------------------------------------

const REPAIR_STATUSES: readonly RepairStatus[] = ['待维修', '维修中', '已完成']

function isRepairStatus(v: string): v is RepairStatus {
  return (REPAIR_STATUSES as readonly string[]).includes(v)
}

/** 有限正数（rate_hourly，numeric(10,2) CHECK > 0）：null/空 → INVALID；非有限数或 <= 0 → INVALID */
function parsePositiveNumber(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 'INVALID'
  return n
}

/** 必填日期（request_date，date NOT NULL）：null/空 → INVALID；非空须严格 YYYY-MM-DD 真实日期 */
function parseRequiredDate(v: string | null | undefined): string | Invalid {
  const r = parseOptionalDate(v)
  if (r === null) return 'INVALID'
  return r
}

/** 可空工时（repair_hours，numeric(4,2)）：null/空 → null；非有限数 → INVALID；正数/0.25 步进在校验核心 */
function parseOptionalRepairHours(v: number | string | null | undefined): number | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 'INVALID'
  return n
}

/** 可空成本（calculated_cost，numeric(10,2) CHECK >= 0）：null/空 → null；非有限数或 < 0 → INVALID */
function parseOptionalRepairCost(v: number | string | null | undefined): number | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 'INVALID'
  return n
}

// ---------------------------------------------------------------------------
// 业务校验核心（admin/staff 直读与 contractor RPC 两条路径共享）
// ---------------------------------------------------------------------------

/** 已解析的维修单字段（item_id/contractor_id/rate_id 在 RPC 路径为 null） */
interface ParsedRepairFields {
  repair_id: number
  item_id: number | null
  item_code: string
  item_name: string
  contractor_id: number | null
  contractor_name: string
  rate_id: number | null
  rate_hourly: number
  request_date: string
  fault_description: string
  repair_date: string | null
  repair_hours: number | null
  calculated_cost: number | null
  notes: string | null
  status: RepairStatus
}

/**
 * 状态空值规则 + 时间顺序 + 工时步进 + 成本复算（口径与 validate.ts 完全一致）：
 *   - 待维修/维修中：repair_date / repair_hours / calculated_cost 全空；
 *   - 已完成：三者全非空；
 *   - repair_date >= request_date；
 *   - repair_hours > 0 且为 0.25 的整数倍（浮点容差 1e-9）；
 *   - calculated_cost = repair_hours × rate_hourly（容差 0.005）。
 */
function validateRepairFields(f: ParsedRepairFields): boolean {
  if (f.status === '已完成') {
    if (f.repair_date === null || f.repair_hours === null || f.calculated_cost === null) {
      return false
    }
  } else {
    if (f.repair_date !== null || f.repair_hours !== null || f.calculated_cost !== null) {
      return false
    }
  }

  if (f.repair_date !== null && f.repair_date < f.request_date) {
    return false
  }

  if (f.repair_hours !== null) {
    if (!(f.repair_hours > 0)) return false
    // 0.25 步进：repair_hours * 4 必须为整数（浮点容差 1e-9）
    if (Math.abs(f.repair_hours * 4 - Math.round(f.repair_hours * 4)) > 1e-9) {
      return false
    }
    // 成本复算：calculated_cost = repair_hours × 冻结 hourly_rate（容差 0.005）
    if (f.calculated_cost !== null) {
      const expected = f.repair_hours * f.rate_hourly
      if (Math.abs(f.calculated_cost - expected) > 0.005) {
        return false
      }
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// 引用映射（admin/staff 直读用）：逐行解析并构建外键集合，重复主键拒绝
// ---------------------------------------------------------------------------

function buildRepairItemMap(rows: unknown): Map<number, { item_code: string; item_name: string }> | null {
  if (!Array.isArray(rows)) return null
  const map = new Map<number, { item_code: string; item_name: string }>()
  for (const raw of rows) {
    const r = raw as CloudRepairItemRow
    if (typeof raw !== 'object' || raw === null) return null
    const item_id = parsePositiveIntId(r.item_id)
    const item_code = parseNonBlankString(r.item_code)
    const item_name = parseNonBlankString(r.name)
    if (item_id === 'INVALID' || item_code === 'INVALID' || item_name === 'INVALID') return null
    if (map.has(item_id)) return null
    map.set(item_id, { item_code, item_name })
  }
  return map
}

function buildRepairContractorMap(rows: unknown): Map<number, string> | null {
  if (!Array.isArray(rows)) return null
  const map = new Map<number, string>()
  for (const raw of rows) {
    const r = raw as CloudRepairContractorRow
    if (typeof raw !== 'object' || raw === null) return null
    const contractor_id = parsePositiveIntId(r.contractor_id)
    const name = parseNonBlankString(r.name)
    if (contractor_id === 'INVALID' || name === 'INVALID') return null
    if (map.has(contractor_id)) return null
    map.set(contractor_id, name)
  }
  return map
}

function buildRepairRateMap(
  rows: unknown,
): Map<number, { contractor_id: number; hourly_rate: number }> | null {
  if (!Array.isArray(rows)) return null
  const map = new Map<number, { contractor_id: number; hourly_rate: number }>()
  for (const raw of rows) {
    const r = raw as CloudRepairRateRow
    if (typeof raw !== 'object' || raw === null) return null
    const rate_id = parsePositiveIntId(r.rate_id)
    const contractor_id = parsePositiveIntId(r.contractor_id)
    const hourly_rate = parsePositiveNumber(r.hourly_rate)
    if (rate_id === 'INVALID' || contractor_id === 'INVALID' || hourly_rate === 'INVALID') return null
    if (map.has(rate_id)) return null
    map.set(rate_id, { contractor_id, hourly_rate })
  }
  return map
}

// ---------------------------------------------------------------------------
// 组装（admin/staff 直读四表）
// ---------------------------------------------------------------------------

/**
 * admin/staff 直读：四表联立组装 + 主外键 / 费率归属 / 关联完整性 / 业务约束校验。
 * 任一环节失败即返回安全错误，绝不返回部分数据。
 */
export function assembleCloudRepairsFromTables(
  repairsRows: unknown,
  itemsRows: unknown,
  contractorsRows: unknown,
  ratesRows: unknown,
): RepairReadResult {
  if (!Array.isArray(repairsRows)) return { ok: false, error: SAFE_REPAIR_ERROR }

  const itemMap = buildRepairItemMap(itemsRows)
  if (itemMap === null) return { ok: false, error: SAFE_REPAIR_ERROR }
  const contractorMap = buildRepairContractorMap(contractorsRows)
  if (contractorMap === null) return { ok: false, error: SAFE_REPAIR_ERROR }
  const rateMap = buildRepairRateMap(ratesRows)
  if (rateMap === null) return { ok: false, error: SAFE_REPAIR_ERROR }

  const rows: RepairRowView[] = []
  const seenRepair = new Set<number>()
  for (const raw of repairsRows) {
    const r = raw as CloudRepairOrderRow
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_REPAIR_ERROR }

    const repair_id = parsePositiveIntId(r.repair_id)
    if (repair_id === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const item_id = parsePositiveIntId(r.item_id)
    if (item_id === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const contractor_id = parsePositiveIntId(r.contractor_id)
    if (contractor_id === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const rate_id = parsePositiveIntId(r.rate_id)
    if (rate_id === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }

    // 引用完整性：设备 / 承包商 / 费率必须存在
    const item = itemMap.get(item_id)
    if (item === undefined) return { ok: false, error: SAFE_REPAIR_ERROR }
    const contractorName = contractorMap.get(contractor_id)
    if (contractorName === undefined) return { ok: false, error: SAFE_REPAIR_ERROR }
    const rate = rateMap.get(rate_id)
    if (rate === undefined) return { ok: false, error: SAFE_REPAIR_ERROR }

    // 费率归属：rate_id 必须属于 contractor_id（复合外键 (contractor_id, rate_id)）
    if (rate.contractor_id !== contractor_id) return { ok: false, error: SAFE_REPAIR_ERROR }

    const request_date = parseRequiredDate(r.request_date)
    if (request_date === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const fault_description = parseNonBlankString(r.fault_description)
    if (fault_description === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const repair_date = parseOptionalDate(r.repair_date)
    if (repair_date === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const repair_hours = parseOptionalRepairHours(r.repair_hours)
    if (repair_hours === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const calculated_cost = parseOptionalRepairCost(r.calculated_cost)
    if (calculated_cost === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const notes = parseOptionalString(r.notes)
    if (notes === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    if (typeof r.status !== 'string' || !isRepairStatus(r.status)) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }
    const status = r.status

    if (!validateRepairFields({
      repair_id,
      item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      contractor_id,
      contractor_name: contractorName,
      rate_id,
      rate_hourly: rate.hourly_rate,
      request_date,
      fault_description,
      repair_date,
      repair_hours,
      calculated_cost,
      notes,
      status,
    })) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }

    if (seenRepair.has(repair_id)) return { ok: false, error: SAFE_REPAIR_ERROR }
    seenRepair.add(repair_id)
    rows.push({
      repair_id,
      item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      contractor_id,
      contractor_name: contractorName,
      rate_id,
      rate_hourly: rate.hourly_rate,
      request_date,
      fault_description,
      repair_date,
      repair_hours,
      calculated_cost,
      notes,
      status,
    })
  }
  rows.sort((a, b) => a.repair_id - b.repair_id)
  return { ok: true, rows }
}

// ---------------------------------------------------------------------------
// 组装（contractor RPC：list_my_repairs）
// ---------------------------------------------------------------------------

/**
 * contractor RPC 结果映射：repair_id 正安全整数；item_code/item_name/contractor_name
 * 必填非空；rate_hourly 有限正数；日期 / nullable / 状态空值 / 成本复算逐项校验。
 * item_id / contractor_id / rate_id 未由 RPC 返回 → 明确建模为 null（不可用，绝不伪造）。
 */
export function assembleCloudRepairsFromRpc(rows: unknown): RepairReadResult {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_REPAIR_ERROR }
  const result: RepairRowView[] = []
  const seenRepair = new Set<number>()
  for (const raw of rows) {
    const r = raw as CloudMyRepairRow
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_REPAIR_ERROR }

    const repair_id = parsePositiveIntId(r.repair_id)
    if (repair_id === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const item_code = parseNonBlankString(r.item_code)
    if (item_code === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const item_name = parseNonBlankString(r.item_name)
    if (item_name === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const contractor_name = parseNonBlankString(r.contractor_name)
    if (contractor_name === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const rate_hourly = parsePositiveNumber(r.rate_hourly)
    if (rate_hourly === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const request_date = parseRequiredDate(r.request_date)
    if (request_date === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const fault_description = parseNonBlankString(r.fault_description)
    if (fault_description === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const repair_date = parseOptionalDate(r.repair_date)
    if (repair_date === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const repair_hours = parseOptionalRepairHours(r.repair_hours)
    if (repair_hours === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const calculated_cost = parseOptionalRepairCost(r.calculated_cost)
    if (calculated_cost === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    const notes = parseOptionalString(r.notes)
    if (notes === 'INVALID') return { ok: false, error: SAFE_REPAIR_ERROR }
    if (typeof r.status !== 'string' || !isRepairStatus(r.status)) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }
    const status = r.status

    if (!validateRepairFields({
      repair_id,
      item_id: null,
      item_code,
      item_name,
      contractor_id: null,
      contractor_name,
      rate_id: null,
      rate_hourly,
      request_date,
      fault_description,
      repair_date,
      repair_hours,
      calculated_cost,
      notes,
      status,
    })) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }

    if (seenRepair.has(repair_id)) return { ok: false, error: SAFE_REPAIR_ERROR }
    seenRepair.add(repair_id)
    result.push({
      repair_id,
      item_id: null,
      item_code,
      item_name,
      contractor_id: null,
      contractor_name,
      rate_id: null,
      rate_hourly,
      request_date,
      fault_description,
      repair_date,
      repair_hours,
      calculated_cost,
      notes,
      status,
    })
  }
  result.sort((a, b) => a.repair_id - b.repair_id)
  return { ok: true, rows: result }
}

// ---------------------------------------------------------------------------
// 查询构造器（复用 cloudMaster 的 MasterRdbClient 注入 fake client；RPC 用独立注入接口）
// ---------------------------------------------------------------------------

/** repair_orders 精确列（11 列） */
export const REPAIR_ORDER_SELECT_COLUMNS =
  'repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status'
/** rental_items 精简列（3 列，仅设备编号/名称） */
export const REPAIR_ITEM_SELECT_COLUMNS = 'item_id, item_code, name'
/** contractors 精简列（2 列，仅名称） */
export const REPAIR_CONTRACTOR_SELECT_COLUMNS = 'contractor_id, name'
/** contractor_rates 精简列（3 列，费率归属 + 冻结 hourly_rate） */
export const REPAIR_RATE_SELECT_COLUMNS = 'rate_id, contractor_id, hourly_rate'

/** 维修单查询：from('repair_orders') + 精确列 + repair_id 升序 */
export async function queryRepairOrders(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('repair_orders').select(REPAIR_ORDER_SELECT_COLUMNS).order('repair_id', { ascending: true })
}

/** 设备精简查询：from('rental_items') + 精确列 + item_id 升序 */
export async function queryRepairItems(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('rental_items').select(REPAIR_ITEM_SELECT_COLUMNS).order('item_id', { ascending: true })
}

/** 承包商精简查询：from('contractors') + 精确列 + contractor_id 升序 */
export async function queryRepairContractors(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('contractors').select(REPAIR_CONTRACTOR_SELECT_COLUMNS).order('contractor_id', { ascending: true })
}

/** 费率精简查询：from('contractor_rates') + 精确列 + rate_id 升序 */
export async function queryRepairRates(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('contractor_rates').select(REPAIR_RATE_SELECT_COLUMNS).order('rate_id', { ascending: true })
}

/**
 * admin/staff 主查询：并行读取四表，任一返回 error 或抛异常 → 整体安全错误
 * （不返回部分数据）。成功后联立组装并做关联 / 费率归属 / 业务约束校验。
 */
export async function queryRepairsAdmin(rdb: MasterRdbClient): Promise<RepairReadResult> {
  try {
    const [repairs, items, contractors, rates] = await Promise.all([
      queryRepairOrders(rdb),
      queryRepairItems(rdb),
      queryRepairContractors(rdb),
      queryRepairRates(rdb),
    ])
    if (repairs.error || items.error || contractors.error || rates.error) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }
    return assembleCloudRepairsFromTables(repairs.data, items.data, contractors.data, rates.data)
  } catch {
    return { ok: false, error: SAFE_REPAIR_ERROR }
  }
}

// ---------------------------------------------------------------------------
// contractor RPC 调用（依据当前安装的 @cloudbase/js-sdk 类型确认）
// ---------------------------------------------------------------------------

/**
 * 可注入的最小 RPC 客户端（对应 app.rdb() 返回的 PostgrestClient 的 rpc 方法）。
 * 实际 @cloudbase/js-sdk 运行时 app.rdb() 经 generatePGClient 返回 PostgrestClient，
 * 其 rpc(fn, args?, options?) 返回 PromiseLike<{ data, error }>（data 为返回行数组）。
 * 这里仅声明 rpc 的最小契约，供 Node fake client 单测与运行时 cast 复用，
 * 绝不凭印象猜测具体实现细节。
 */
export interface RepairRpcClient {
  rpc(
    fn: string,
    args?: unknown,
    options?: unknown,
  ): Promise<{ data: unknown; error: unknown }>
}

/** contractor 查询本人维修单：调用 SECURITY DEFINER RPC list_my_repairs()（无参数） */
export async function queryMyRepairsRpc(
  rpcClient: RepairRpcClient,
): Promise<{ data: unknown; error: unknown }> {
  return rpcClient.rpc('list_my_repairs')
}

/**
 * contractor RPC 主查询：RPC 失败（error / 抛异常）→ 整体安全错误，
 * 绝不退回直接表查询或 localStorage。
 */
export async function queryRepairsContractor(rpcClient: RepairRpcClient): Promise<RepairReadResult> {
  try {
    const { data, error } = await queryMyRepairsRpc(rpcClient)
    if (error) {
      return { ok: false, error: SAFE_REPAIR_ERROR }
    }
    return assembleCloudRepairsFromRpc(data)
  } catch {
    return { ok: false, error: SAFE_REPAIR_ERROR }
  }
}
