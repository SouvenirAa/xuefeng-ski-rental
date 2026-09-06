/**
 * 云端「租赁合同 / 明细 / 变更」只读查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点：
 * - 数值字段归一化为 number（云端 bigint/numeric/integer 可能返回 string）；
 * - 显式列名查询，绝不用 select('*')；
 * - 主键 / 外键 / 唯一约束 / 关联完整性 / 状态与可空字段一致性 / 时间顺序 /
 *   换货组结构 / amount_delta 与 total_amount 独立复算 逐项校验，任一真实错误
 *   fail-closed，返回安全错误（绝不泄露底层错误细节或原始数据值）；
 * - 多表任一查询失败 → 整体失败（空数据 + 安全错误），绝不返回部分数据、
 *   绝不回退 localStorage。
 *
 * 查询范围与关联完整性：
 *   * 列表（assembleContractList / queryContractList）仅关联 rental_contracts、
 *     customers、employees 三表，校验合同主键唯一、contract_no 唯一、客户/员工
 *     外键、completed_at 与 status 一致；不做明细/变更级校验（那是详情页职责）。
 *   * 详情（assembleContractDetail / queryContractDetail）关联 rental_contracts、
 *     contract_lines、contract_changes、customers、employees、rental_items、stores
 *     七表，做全套校验（含换货组结构与差价复算、total_amount 复算、时间顺序、
 *     同一设备借出唯一等）。
 *   * 详情只需设备/门店的基础展示，故只查询 item_id/item_code/name 与
 *     store_id/store_name 精简引用列，绝不查询 skill_levels，避免无关数据错误
 *     拖垮合同页。
 *
 * timestamp 格式策略（不假设格式、不用本地时区转换导致日期偏移）：
 *   数据库 checkout_time / return_time / completed_at / change_date 为
 *   timestamp without time zone。真实云库只读核验返回 "YYYY-MM-DD HH:MM:SS"
 *   （空格分隔，如 "2026-08-03 18:00:00"），无小数秒。parseTimestamp 同时接受
 *   "T" 与空格分隔、并支持 1~6 位小数秒（如 "2026-08-16 14:00:00.5"），
 *   统一归一化为 "YYYY-MM-DDTHH:mm:ss"（小数全 0 省略、非零去尾 0 保留），
 *   全程字符串级校验（Date.UTC 往返核验真实日期，不引入本地时区偏移），
 *   绝不把非法时间静默转成当前时间或空字符串。范围 / 顺序比较统一用
 *   Date.UTC 微秒（timezone 无关，单调），杜绝字符串比较误差。
 *
 * nullable 与 TypeScript 类型映射策略（只读视图模型显式保留 NULL，绝不静默转换）：
 *   * rental_contracts.completed_at → string | null（进行中为 null）；
 *   * contract_lines.return_time / return_store_id → string | null / number | null；
 *   * contract_changes.change_group_id / item_id / amount_delta / note → 可空；
 *   * customers.email 等在本模块不查询（仅取 customer_id/full_name 引用）。
 *   NULL 一律保留为 null，页面以占位符「—」展示，绝不把 NULL 转成 0 / 空串 / 虚构值。
 *   local 模式领域类型（RentalContract/ContractLine/ContractChange）与 DataService 行为
 *   完全不变，只读视图模型与之一一对应（结构相同，无加宽），属零成本安全映射。
 */
import type { ContractStatus, ContractLineStatus, ChangeType } from './types'
import {
  parsePositiveIntId,
  parseOptionalString,
  parseNonBlankString,
  parseOptionalDate,
  type Invalid,
  type MasterRdbClient,
} from './cloudMaster'

/** 安全错误文案（不含底层错误细节 / 数据值） */
export const SAFE_CONTRACT_ERROR = '合同数据加载失败'

// ---------------------------------------------------------------------------
// 只读视图模型（与可写领域类型 RentalContract/ContractLine/ContractChange 结构一致）
// ---------------------------------------------------------------------------

/** 合同只读视图 */
export interface RentalContractView {
  contract_id: number
  contract_no: string
  customer_id: number
  employee_id: number
  contract_date: string
  duration_days: number
  total_amount: number
  completed_at: string | null
  status: ContractStatus
}

/** 合同明细只读视图 */
export interface ContractLineView {
  contract_line_id: number
  contract_id: number
  item_id: number
  quantity: number
  daily_rate: number
  checkout_time: string
  checkout_store_id: number
  return_time: string | null
  return_store_id: number | null
  status: ContractLineStatus
}

/** 合同变更只读视图 */
export interface ContractChangeView {
  change_id: number
  contract_id: number
  change_group_id: number | null
  change_date: string
  change_type: ChangeType
  item_id: number | null
  quantity: number
  amount_delta: number | null
  note: string | null
}

/** 客户精简引用视图（列表/详情仅需姓名） */
export interface CustomerRefView {
  customer_id: number
  full_name: string
}

/** 员工精简引用视图 */
export interface EmployeeRefView {
  employee_id: number
  full_name: string
}

/** 设备精简引用视图（详情仅需编号/名称，不含日租金，金额一律用明细快照） */
export interface ItemRefView {
  item_id: number
  item_code: string
  name: string
}

/** 门店精简引用视图 */
export interface StoreRefView {
  store_id: number
  store_name: string
}

/** 合同列表行（合同 + 客户/员工姓名，供列表页直接渲染） */
export interface ContractListRowView extends RentalContractView {
  customer_name: string
  employee_name: string
}

/** 合同明细 + 设备引用（详情页渲染用） */
export interface ContractLineDetailView {
  line: ContractLineView
  item: ItemRefView | null
}

/** 合同详情聚合视图（stores 随详情一并返回，供页面解析借出/归还门店名，避免二次查询） */
export interface ContractDetailView {
  contract: RentalContractView
  customer: CustomerRefView | null
  employee: EmployeeRefView | null
  lines: ContractLineDetailView[]
  changes: ContractChangeView[]
  stores: StoreRefView[]
}

export type ContractListReadResult =
  | { ok: true; rows: ContractListRowView[] }
  | { ok: false; error: string }

/** detail 为 null 且 ok=true 表示「查询成功但 contract_id 不存在」（区别于 loading / error） */
export type ContractDetailReadResult =
  | { ok: true; detail: ContractDetailView | null }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string；可空列类型与数据库一致）
// ---------------------------------------------------------------------------
export interface CloudContractRow {
  contract_id: number | string | null | undefined
  contract_no: string | null | undefined
  customer_id: number | string | null | undefined
  employee_id: number | string | null | undefined
  contract_date: string | null | undefined
  duration_days: number | string | null | undefined
  total_amount: number | string | null | undefined
  completed_at: string | null | undefined
  status: string | null | undefined
}

export interface CloudContractLineRow {
  contract_line_id: number | string | null | undefined
  contract_id: number | string | null | undefined
  item_id: number | string | null | undefined
  quantity: number | string | null | undefined
  daily_rate: number | string | null | undefined
  checkout_time: string | null | undefined
  checkout_store_id: number | string | null | undefined
  return_time: string | null | undefined
  return_store_id: number | string | null | undefined
  status: string | null | undefined
}

export interface CloudContractChangeRow {
  change_id: number | string | null | undefined
  contract_id: number | string | null | undefined
  change_group_id: number | string | null | undefined
  change_date: string | null | undefined
  change_type: string | null | undefined
  item_id: number | string | null | undefined
  quantity: number | string | null | undefined
  amount_delta: number | string | null | undefined
  note: string | null | undefined
}

export interface CloudCustomerRefRow {
  customer_id: number | string | null | undefined
  full_name: string | null | undefined
}

export interface CloudEmployeeRefRow {
  employee_id: number | string | null | undefined
  full_name: string | null | undefined
}

export interface CloudItemRefRow {
  item_id: number | string | null | undefined
  item_code: string | null | undefined
  name: string | null | undefined
}

export interface CloudStoreRefRow {
  store_id: number | string | null | undefined
  store_name: string | null | undefined
}

// ---------------------------------------------------------------------------
// 解析助手（本模块专属；基础 ID/字符串/日期复用 cloudMaster）
// ---------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

/** 已校验 canonical 时间戳 → Date.UTC 微秒（时区无关，单调），用于顺序比较 */
function tsMicros(ts: string): number {
  const m = TS_RE.exec(ts)
  if (!m) return 0
  const [y, mo, d, hh, mm, ss] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number)
  const frac = m[7] ?? ''
  return Date.UTC(y, mo - 1, d, hh, mm, ss) * 1000 + Number(frac.padEnd(6, '0'))
}

interface ParsedTs {
  canonical: string
  micros: number
}

/**
 * 必填时间戳（timestamp without time zone）：
 * 接受 "YYYY-MM-DD HH:MM:SS"（真实云库返回）与 "YYYY-MM-DDTHH:MM:SS"，
 * 及 1~6 位小数秒；严格校验真实日期与时分秒范围；归一化为 "YYYY-MM-DDTHH:MM:SS(.f)"。
 * 全字符串 + Date.UTC 往返校验，不引入本地时区偏移。
 */
function parseTimestamp(v: string | null | undefined): ParsedTs | Invalid {
  if (typeof v !== 'string') return 'INVALID'
  const m = TS_RE.exec(v.trim())
  if (!m) return 'INVALID'
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const hh = Number(m[4])
  const mm = Number(m[5])
  const ss = Number(m[6])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 'INVALID'
  if (hh > 23 || mm > 59 || ss > 59) return 'INVALID'
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return 'INVALID'
  }
  const frac = m[7] ?? ''
  const micros = dt.getTime() * 1000 + Number(frac.padEnd(6, '0'))
  const trimmed = frac.replace(/0+$/, '')
  const base = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  return { canonical: trimmed === '' ? base : `${base}.${trimmed}`, micros }
}

/** 必填日期（contract_date，date NOT NULL）：null/空 → INVALID；严格 YYYY-MM-DD 真实日期 */
function parseRequiredDate(v: string | null | undefined): string | Invalid {
  const r = parseOptionalDate(v)
  if (r === null) return 'INVALID'
  return r
}

/** 租赁天数（duration_days，integer > 0）：正整数，且须为安全整数 */
function parseDurationDays(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n) || n <= 0) return 'INVALID'
  return n
}

/** 数量（quantity，integer CHECK = 1）：必须严格等于 1 */
function parseQuantity(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n) || n !== 1) return 'INVALID'
  return n
}

/** 非负金额（total_amount / daily_rate，numeric >= 0）：有限数且非负 */
function parseNonNegativeNumber(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 'INVALID'
  return n
}

/** 可空金额（amount_delta，numeric 可空，可为负）：null/空 → null；非有限数 → INVALID */
function parseOptionalAmount(v: number | string | null | undefined): number | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 'INVALID'
  return n
}

/** 可空 bigint 外键：null/空 → null；非空须为正的安全整数 */
function parseNullablePositiveIntId(v: number | string | null | undefined): number | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  return parsePositiveIntId(v)
}

// ---------------------------------------------------------------------------
// 枚举校验
// ---------------------------------------------------------------------------
const CONTRACT_STATUSES: readonly ContractStatus[] = ['进行中', '已完成']
const LINE_STATUSES: readonly ContractLineStatus[] = ['借出中', '已归还', '已更换']
const CHANGE_TYPES: readonly ChangeType[] = ['增加', '归还']

function isContractStatus(v: string): v is ContractStatus {
  return (CONTRACT_STATUSES as readonly string[]).includes(v)
}
function isLineStatus(v: string): v is ContractLineStatus {
  return (LINE_STATUSES as readonly string[]).includes(v)
}
function isChangeType(v: string): v is ChangeType {
  return (CHANGE_TYPES as readonly string[]).includes(v)
}

/** 自然日差：to − from（取日期部分，UTC 基准，与 validate.ts / DataService 口径一致） */
function dateDiffDays(from: string, to: string): number {
  const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`)
  return Math.round((parse(to) - parse(from)) / 86400000)
}

// ---------------------------------------------------------------------------
// 单行映射（字段异常即 fail-closed；可空字段的 NULL 为合法值，保留为 null）
// ---------------------------------------------------------------------------
function mapContractRow(
  raw: CloudContractRow,
  customerIds: ReadonlySet<number>,
  employeeIds: ReadonlySet<number>,
): { ok: true; contract: RentalContractView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const contract_id = parsePositiveIntId(raw.contract_id)
  if (contract_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const contract_no = parseNonBlankString(raw.contract_no)
  if (contract_no === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const customer_id = parsePositiveIntId(raw.customer_id)
  if (customer_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const employee_id = parsePositiveIntId(raw.employee_id)
  if (employee_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const contract_date = parseRequiredDate(raw.contract_date)
  if (contract_date === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const duration_days = parseDurationDays(raw.duration_days)
  if (duration_days === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const total_amount = parseNonNegativeNumber(raw.total_amount)
  if (total_amount === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  // completed_at：可空时间戳（进行中为 null）
  let completed_at: string | null
  if (raw.completed_at === null || raw.completed_at === undefined || raw.completed_at === '') {
    completed_at = null
  } else {
    const p = parseTimestamp(raw.completed_at)
    if (p === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
    completed_at = p.canonical
  }

  if (typeof raw.status !== 'string' || !isContractStatus(raw.status)) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }
  const status = raw.status

  // 状态与 completed_at 一致性：已完成 ⟺ completed_at 非空
  if (status === '已完成' && completed_at === null) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (status === '进行中' && completed_at !== null) return { ok: false, error: SAFE_CONTRACT_ERROR }

  // 外键：客户 / 员工必须存在
  if (!customerIds.has(customer_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (!employeeIds.has(employee_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }

  return {
    ok: true,
    contract: {
      contract_id,
      contract_no,
      customer_id,
      employee_id,
      contract_date,
      duration_days,
      total_amount,
      completed_at,
      status,
    },
  }
}

function mapContractLineRow(
  raw: CloudContractLineRow,
  contractIds: ReadonlySet<number>,
  itemIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true; line: ContractLineView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const contract_line_id = parsePositiveIntId(raw.contract_line_id)
  if (contract_line_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const contract_id = parsePositiveIntId(raw.contract_id)
  if (contract_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const item_id = parsePositiveIntId(raw.item_id)
  if (item_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const quantity = parseQuantity(raw.quantity)
  if (quantity === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const daily_rate = parseNonNegativeNumber(raw.daily_rate)
  if (daily_rate === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const checkout = parseTimestamp(raw.checkout_time)
  if (checkout === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const checkout_store_id = parsePositiveIntId(raw.checkout_store_id)
  if (checkout_store_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  // return_time / return_store_id：可空（借出中为 null）
  let returnParsed: ParsedTs | null
  if (raw.return_time === null || raw.return_time === undefined || raw.return_time === '') {
    returnParsed = null
  } else {
    const p = parseTimestamp(raw.return_time)
    if (p === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
    returnParsed = p
  }
  const return_store_id = parseNullablePositiveIntId(raw.return_store_id)
  if (return_store_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  if (typeof raw.status !== 'string' || !isLineStatus(raw.status)) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }
  const status = raw.status

  // 明细状态与归还字段一致性：借出中 → return 字段均空；已归还/已更换 → 均非空
  const isReturned = status !== '借出中'
  if (!isReturned) {
    if (returnParsed !== null || return_store_id !== null) {
      return { ok: false, error: SAFE_CONTRACT_ERROR }
    }
  } else {
    if (returnParsed === null || return_store_id === null) {
      return { ok: false, error: SAFE_CONTRACT_ERROR }
    }
  }

  // 时间顺序：return_time > checkout_time（归还/更换时）
  if (returnParsed !== null && returnParsed.micros <= checkout.micros) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }

  // 外键：合同 / 设备 / 借出门店 / 归还门店
  if (!contractIds.has(contract_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (!itemIds.has(item_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (!storeIds.has(checkout_store_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (return_store_id !== null && !storeIds.has(return_store_id)) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }

  return {
    ok: true,
    line: {
      contract_line_id,
      contract_id,
      item_id,
      quantity,
      daily_rate,
      checkout_time: checkout.canonical,
      checkout_store_id,
      return_time: returnParsed ? returnParsed.canonical : null,
      return_store_id,
      status,
    },
  }
}

function mapContractChangeRow(
  raw: CloudContractChangeRow,
  contractIds: ReadonlySet<number>,
  itemIds: ReadonlySet<number>,
): { ok: true; change: ContractChangeView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const change_id = parsePositiveIntId(raw.change_id)
  if (change_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const contract_id = parsePositiveIntId(raw.contract_id)
  if (contract_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const change_group_id = parseNullablePositiveIntId(raw.change_group_id)
  if (change_group_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const change_date = parseTimestamp(raw.change_date)
  if (change_date === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  if (typeof raw.change_type !== 'string' || !isChangeType(raw.change_type)) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }
  const change_type = raw.change_type

  const item_id = parseNullablePositiveIntId(raw.item_id)
  if (item_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const quantity = parseQuantity(raw.quantity)
  if (quantity === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const amount_delta = parseOptionalAmount(raw.amount_delta)
  if (amount_delta === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  const note = parseOptionalString(raw.note)
  if (note === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }

  if (!contractIds.has(contract_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  if (item_id !== null && !itemIds.has(item_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }

  return {
    ok: true,
    change: {
      change_id,
      contract_id,
      change_group_id,
      change_date: change_date.canonical,
      change_type,
      item_id,
      quantity,
      amount_delta,
      note,
    },
  }
}

// ---------------------------------------------------------------------------
// 引用行映射（客户/员工/设备/门店精简视图）
// ---------------------------------------------------------------------------
function mapCustomerRefRow(
  raw: CloudCustomerRefRow,
): { ok: true; customer: CustomerRefView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const customer_id = parsePositiveIntId(raw.customer_id)
  if (customer_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const full_name = parseNonBlankString(raw.full_name)
  if (full_name === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  return { ok: true, customer: { customer_id, full_name } }
}

function mapEmployeeRefRow(
  raw: CloudEmployeeRefRow,
): { ok: true; employee: EmployeeRefView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const employee_id = parsePositiveIntId(raw.employee_id)
  if (employee_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const full_name = parseNonBlankString(raw.full_name)
  if (full_name === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  return { ok: true, employee: { employee_id, full_name } }
}

function mapItemRefRow(
  raw: CloudItemRefRow,
): { ok: true; item: ItemRefView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const item_id = parsePositiveIntId(raw.item_id)
  if (item_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const item_code = parseNonBlankString(raw.item_code)
  if (item_code === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const name = parseNonBlankString(raw.name)
  if (name === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  return { ok: true, item: { item_id, item_code, name } }
}

function mapStoreRefRow(
  raw: CloudStoreRefRow,
): { ok: true; store: StoreRefView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const store_id = parsePositiveIntId(raw.store_id)
  if (store_id === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  const store_name = parseNonBlankString(raw.store_name)
  if (store_name === 'INVALID') return { ok: false, error: SAFE_CONTRACT_ERROR }
  return { ok: true, store: { store_id, store_name } }
}

// ---------------------------------------------------------------------------
// 批量映射：逐行校验 + 重复主键 / 唯一约束拒绝 + 稳定排序
// ---------------------------------------------------------------------------
function mapCloudCustomers(rows: unknown): { ok: true; customers: CustomerRefView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: CustomerRefView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapCustomerRefRow(raw as CloudCustomerRefRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seen.has(r.customer.customer_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seen.add(r.customer.customer_id)
    out.push(r.customer)
  }
  out.sort((a, b) => a.customer_id - b.customer_id)
  return { ok: true, customers: out }
}

function mapCloudEmployees(rows: unknown): { ok: true; employees: EmployeeRefView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: EmployeeRefView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapEmployeeRefRow(raw as CloudEmployeeRefRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seen.has(r.employee.employee_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seen.add(r.employee.employee_id)
    out.push(r.employee)
  }
  out.sort((a, b) => a.employee_id - b.employee_id)
  return { ok: true, employees: out }
}

function mapCloudItems(rows: unknown): { ok: true; items: ItemRefView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: ItemRefView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapItemRefRow(raw as CloudItemRefRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seen.has(r.item.item_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seen.add(r.item.item_id)
    out.push(r.item)
  }
  out.sort((a, b) => a.item_id - b.item_id)
  return { ok: true, items: out }
}

function mapCloudStores(rows: unknown): { ok: true; stores: StoreRefView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: StoreRefView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapStoreRefRow(raw as CloudStoreRefRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seen.has(r.store.store_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seen.add(r.store.store_id)
    out.push(r.store)
  }
  out.sort((a, b) => a.store_id - b.store_id)
  return { ok: true, stores: out }
}

export function mapCloudContracts(
  rows: unknown,
  customerIds: ReadonlySet<number>,
  employeeIds: ReadonlySet<number>,
): { ok: true; contracts: RentalContractView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: RentalContractView[] = []
  const seenId = new Set<number>()
  const seenNo = new Set<string>()
  for (const raw of rows) {
    const r = mapContractRow(raw as CloudContractRow, customerIds, employeeIds)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seenId.has(r.contract.contract_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seenNo.has(r.contract.contract_no)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seenId.add(r.contract.contract_id)
    seenNo.add(r.contract.contract_no)
    out.push(r.contract)
  }
  out.sort((a, b) => a.contract_id - b.contract_id)
  return { ok: true, contracts: out }
}

export function mapCloudContractLines(
  rows: unknown,
  contractIds: ReadonlySet<number>,
  itemIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true; lines: ContractLineView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: ContractLineView[] = []
  const seenLine = new Set<number>()
  const seenComposite = new Set<string>() // `${contract_id}:${item_id}`
  const activeItems = new Set<number>() // 借出中的 item_id（全局唯一）
  for (const raw of rows) {
    const r = mapContractLineRow(raw as CloudContractLineRow, contractIds, itemIds, storeIds)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seenLine.has(r.line.contract_line_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    const compositeKey = `${r.line.contract_id}:${r.line.item_id}`
    if (seenComposite.has(compositeKey)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (r.line.status === '借出中') {
      // 同一设备不得同时存在多条「借出中」明细（跨合同全局唯一）
      if (activeItems.has(r.line.item_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
      activeItems.add(r.line.item_id)
    }
    seenLine.add(r.line.contract_line_id)
    seenComposite.add(compositeKey)
    out.push(r.line)
  }
  out.sort((a, b) => a.contract_line_id - b.contract_line_id)
  return { ok: true, lines: out }
}

export function mapCloudContractChanges(
  rows: unknown,
  contractIds: ReadonlySet<number>,
  itemIds: ReadonlySet<number>,
): { ok: true; changes: ContractChangeView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const out: ContractChangeView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapContractChangeRow(raw as CloudContractChangeRow, contractIds, itemIds)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
    if (seen.has(r.change.change_id)) return { ok: false, error: SAFE_CONTRACT_ERROR }
    seen.add(r.change.change_id)
    out.push(r.change)
  }
  out.sort((a, b) => a.change_id - b.change_id)
  return { ok: true, changes: out }
}

// ---------------------------------------------------------------------------
// 跨实体校验：换货组结构 + amount_delta / total_amount 独立复算 + 时间顺序
// 返回 true 表示全部一致；任一不一致返回 false（fail-closed，不泄露详情）。
// ---------------------------------------------------------------------------
function validateContractIntegrity(
  contracts: RentalContractView[],
  lines: ContractLineView[],
  changes: ContractChangeView[],
): boolean {
  const contractById = new Map(contracts.map((c) => [c.contract_id, c]))
  const linesByContract = new Map<number, ContractLineView[]>()
  for (const l of lines) {
    const arr = linesByContract.get(l.contract_id) ?? []
    arr.push(l)
    linesByContract.set(l.contract_id, arr)
  }
  const changesByContract = new Map<number, ContractChangeView[]>()
  for (const ch of changes) {
    const arr = changesByContract.get(ch.contract_id) ?? []
    arr.push(ch)
    changesByContract.set(ch.contract_id, arr)
  }

  // 换货变更按 change_group_id 分组（仅非空分组）
  const groupById = new Map<number, ContractChangeView[]>()
  for (const ch of changes) {
    if (ch.change_group_id === null) continue
    const arr = groupById.get(ch.change_group_id) ?? []
    arr.push(ch)
    groupById.set(ch.change_group_id, arr)
  }

  // 逐换货组：结构校验 + amount_delta 独立复算
  const deltaByContract = new Map<number, number>()
  for (const group of groupById.values()) {
    // 恰好两条，且一条归还 + 一条增加
    if (group.length !== 2) return false
    const returnRec = group.find((ch) => ch.change_type === '归还')
    const addRec = group.find((ch) => ch.change_type === '增加')
    if (!returnRec || !addRec) return false
    if (returnRec.contract_id !== addRec.contract_id) return false
    if (tsMicros(returnRec.change_date) !== tsMicros(addRec.change_date)) return false
    if (returnRec.item_id === null || addRec.item_id === null) return false
    if (returnRec.quantity !== 1 || addRec.quantity !== 1) return false
    const nonNullDelta = group.filter((ch) => ch.amount_delta !== null)
    if (nonNullDelta.length !== 1) return false

    const contract = contractById.get(returnRec.contract_id)
    if (!contract) return false
    const elapsedDays = dateDiffDays(contract.contract_date, returnRec.change_date)
    if (elapsedDays < 0) return false
    const remainingDays = contract.duration_days - elapsedDays
    if (remainingDays <= 0) return false

    const cLines = linesByContract.get(returnRec.contract_id) ?? []
    const outLine = cLines.find((l) => l.item_id === returnRec.item_id)
    const inLine = cLines.find((l) => l.item_id === addRec.item_id)
    if (!outLine || !inLine) return false
    // 换出明细 return_time == change_date；换入明细 checkout_time == change_date（微秒级相等）
    if (tsMicros(outLine.return_time ?? '') !== tsMicros(returnRec.change_date)) return false
    if (tsMicros(inLine.checkout_time) !== tsMicros(addRec.change_date)) return false

    // 独立复算差价：amount_delta = (换入快照日租金 − 换出快照日租金) × 剩余天数（不用目录价）
    const expectedDelta = (inLine.daily_rate - outLine.daily_rate) * remainingDays
    if (Math.abs((nonNullDelta[0].amount_delta as number) - expectedDelta) > 0.005) return false

    const cid = returnRec.contract_id
    deltaByContract.set(cid, (deltaByContract.get(cid) ?? 0) + expectedDelta)
  }

  // 逐合同：total_amount 独立复算 + 时间顺序 + 完成态一致性
  for (const c of contracts) {
    const cLines = linesByContract.get(c.contract_id) ?? []
    const cChanges = changesByContract.get(c.contract_id) ?? []

    // 换入 item（change_type='增加'）
    const exchangedIn = new Set(
      cChanges.filter((ch) => ch.change_type === '增加' && ch.item_id !== null).map((ch) => ch.item_id as number),
    )
    // 初始金额 = 排除换入明细后的 Σ(daily_rate × quantity × duration_days)
    const initial = cLines
      .filter((l) => !exchangedIn.has(l.item_id))
      .reduce((sum, l) => sum + l.daily_rate * l.quantity * c.duration_days, 0)
    const expectedTotal = initial + (deltaByContract.get(c.contract_id) ?? 0)
    if (Math.abs(c.total_amount - expectedTotal) > 0.005) return false

    for (const l of cLines) {
      // checkout_time 不得早于 contract_date（日期部分）
      if (l.checkout_time.slice(0, 10) < c.contract_date) return false
      // return_time 不得晚于合同 completed_at
      if (c.completed_at !== null && l.return_time !== null) {
        if (tsMicros(l.return_time) > tsMicros(c.completed_at)) return false
      }
    }

    // 已完成合同不得存在借出中明细
    if (c.status === '已完成') {
      for (const l of cLines) {
        if (l.status === '借出中') return false
      }
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// 联立组装
// ---------------------------------------------------------------------------
export function assembleContractList(
  contractsRows: unknown,
  customersRows: unknown,
  employeesRows: unknown,
): ContractListReadResult {
  const cus = mapCloudCustomers(customersRows)
  if (!cus.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const emp = mapCloudEmployees(employeesRows)
  if (!emp.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const customerIds = new Set(cus.customers.map((x) => x.customer_id))
  const employeeIds = new Set(emp.employees.map((x) => x.employee_id))
  const customerName = new Map(cus.customers.map((x) => [x.customer_id, x.full_name]))
  const employeeName = new Map(emp.employees.map((x) => [x.employee_id, x.full_name]))

  const c = mapCloudContracts(contractsRows, customerIds, employeeIds)
  if (!c.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const rows: ContractListRowView[] = c.contracts.map((x) => ({
    ...x,
    customer_name: customerName.get(x.customer_id) ?? '',
    employee_name: employeeName.get(x.employee_id) ?? '',
  }))
  return { ok: true, rows }
}

export function assembleContractDetail(
  contractId: number,
  contractsRows: unknown,
  linesRows: unknown,
  changesRows: unknown,
  customersRows: unknown,
  employeesRows: unknown,
  itemsRows: unknown,
  storesRows: unknown,
): ContractDetailReadResult {
  const stores = mapCloudStores(storesRows)
  if (!stores.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const items = mapCloudItems(itemsRows)
  if (!items.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const customers = mapCloudCustomers(customersRows)
  if (!customers.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const employees = mapCloudEmployees(employeesRows)
  if (!employees.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }

  const storeIds = new Set(stores.stores.map((x) => x.store_id))
  const itemIds = new Set(items.items.map((x) => x.item_id))
  const customerIds = new Set(customers.customers.map((x) => x.customer_id))
  const employeeIds = new Set(employees.employees.map((x) => x.employee_id))

  const c = mapCloudContracts(contractsRows, customerIds, employeeIds)
  if (!c.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const contractIds = new Set(c.contracts.map((x) => x.contract_id))

  const linesRes = mapCloudContractLines(linesRows, contractIds, itemIds, storeIds)
  if (!linesRes.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }
  const changesRes = mapCloudContractChanges(changesRows, contractIds, itemIds)
  if (!changesRes.ok) return { ok: false, error: SAFE_CONTRACT_ERROR }

  // 跨实体完整性：换货组 + 金额复算 + 时间顺序 + 完成态
  if (!validateContractIntegrity(c.contracts, linesRes.lines, changesRes.changes)) {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }

  const contract = c.contracts.find((x) => x.contract_id === contractId) ?? null
  if (contract === null) {
    return { ok: true, detail: null }
  }

  const itemById = new Map(items.items.map((x) => [x.item_id, x]))
  const customerById = new Map(customers.customers.map((x) => [x.customer_id, x]))
  const employeeById = new Map(employees.employees.map((x) => [x.employee_id, x]))

  const detailLines: ContractLineDetailView[] = linesRes.lines
    .filter((l) => l.contract_id === contractId)
    .map((l) => ({ line: l, item: itemById.get(l.item_id) ?? null }))
  const detailChanges = changesRes.changes.filter((ch) => ch.contract_id === contractId)

  return {
    ok: true,
    detail: {
      contract,
      customer: customerById.get(contract.customer_id) ?? null,
      employee: employeeById.get(contract.employee_id) ?? null,
      lines: detailLines,
      changes: detailChanges,
      stores: stores.stores,
    },
  }
}

// ---------------------------------------------------------------------------
// 查询构造器（复用 cloudMaster 的 MasterRdbClient，注入 fake client 供 Node 单测）
// ---------------------------------------------------------------------------

/** 合同精确列（9 列） */
export const CONTRACT_SELECT_COLUMNS =
  'contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status'
/** 合同明细精确列（10 列） */
export const CONTRACT_LINE_SELECT_COLUMNS =
  'contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status'
/** 合同变更精确列（9 列） */
export const CONTRACT_CHANGE_SELECT_COLUMNS =
  'change_id, contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note'
/** 客户引用精确列（2 列） */
export const CUSTOMER_REF_SELECT_COLUMNS = 'customer_id, full_name'
/** 员工引用精确列（2 列） */
export const EMPLOYEE_REF_SELECT_COLUMNS = 'employee_id, full_name'
/** 设备引用精确列（3 列） */
export const ITEM_REF_SELECT_COLUMNS = 'item_id, item_code, name'
/** 门店引用精确列（2 列） */
export const STORE_REF_SELECT_COLUMNS = 'store_id, store_name'

export async function queryContracts(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('rental_contracts').select(CONTRACT_SELECT_COLUMNS).order('contract_id', { ascending: true })
}

export async function queryContractLines(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('contract_lines')
    .select(CONTRACT_LINE_SELECT_COLUMNS)
    .order('contract_line_id', { ascending: true })
}

export async function queryContractChanges(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('contract_changes')
    .select(CONTRACT_CHANGE_SELECT_COLUMNS)
    .order('change_id', { ascending: true })
}

export async function queryContractCustomers(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('customers').select(CUSTOMER_REF_SELECT_COLUMNS).order('customer_id', { ascending: true })
}

export async function queryContractEmployees(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('employees').select(EMPLOYEE_REF_SELECT_COLUMNS).order('employee_id', { ascending: true })
}

export async function queryContractItems(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('rental_items').select(ITEM_REF_SELECT_COLUMNS).order('item_id', { ascending: true })
}

export async function queryContractStores(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('stores').select(STORE_REF_SELECT_COLUMNS).order('store_id', { ascending: true })
}

/** 合同列表主查询：并行读 rental_contracts + customers + employees，任一失败整体安全错误 */
export async function queryContractList(rdb: MasterRdbClient): Promise<ContractListReadResult> {
  try {
    const [contracts, customers, employees] = await Promise.all([
      queryContracts(rdb),
      queryContractCustomers(rdb),
      queryContractEmployees(rdb),
    ])
    if (contracts.error || customers.error || employees.error) {
      return { ok: false, error: SAFE_CONTRACT_ERROR }
    }
    return assembleContractList(contracts.data, customers.data, employees.data)
  } catch {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }
}

/** 合同详情主查询：并行读七表，任一失败整体安全错误；成功后联立组装并做全套校验 */
export async function queryContractDetail(
  rdb: MasterRdbClient,
  contractId: number,
): Promise<ContractDetailReadResult> {
  try {
    const [contracts, lines, changes, customers, employees, items, stores] = await Promise.all([
      queryContracts(rdb),
      queryContractLines(rdb),
      queryContractChanges(rdb),
      queryContractCustomers(rdb),
      queryContractEmployees(rdb),
      queryContractItems(rdb),
      queryContractStores(rdb),
    ])
    if (
      contracts.error ||
      lines.error ||
      changes.error ||
      customers.error ||
      employees.error ||
      items.error ||
      stores.error
    ) {
      return { ok: false, error: SAFE_CONTRACT_ERROR }
    }
    return assembleContractDetail(
      contractId,
      contracts.data,
      lines.data,
      changes.data,
      customers.data,
      employees.data,
      items.data,
      stores.data,
    )
  } catch {
    return { ok: false, error: SAFE_CONTRACT_ERROR }
  }
}
