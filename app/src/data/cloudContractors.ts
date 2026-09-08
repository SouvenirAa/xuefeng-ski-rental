/**
 * 云端「承包商 / 费率」两张表的只读查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点：
 * - 数值字段归一化为 number（云端 bigint/numeric 可能返回 string）；
 * - 显式列名查询，绝不用 select('*')；
 * - 主键 / 外键 / 重复主键 / 同承包商同日重复费率 / 费率外键完整性 逐项校验，
 *   任一真实错误即 fail-closed，返回安全错误；
 * - 两张表任一查询失败 → 整体失败（空数据 + 安全错误），绝不返回部分数据、
 *   绝不回退 localStorage。
 *
 * nullable 与 TypeScript 类型映射策略（只读视图模型显式保留 NULL，绝不静默转换）：
 *   contractors.address / phone / email 数据库可空 → 视图类型 string | null，
 *   NULL 保留为 null，页面统一以占位符「—」展示、搜索按空字符串处理（见页面层），
 *   绝不把 NULL 静默转换为空字符串 / 虚构文本，也不得在页面显示字符串 "null"。
 *   local 模式的领域类型 Contractor 对这些字段恒写非空（空值用空字符串表达），
 *   云端只读视图模型仅在结构上把它们加宽为可空，属单向收窄安全的映射。
 *
 * 当前费率：cloud 模式必须从云端费率自行计算（只取 effective_date <= today 的最新一条，
 * 未来费率不得提前生效），见 computeCurrentRateView；绝不调用 dataService.getEffectiveContractorRate。
 * 「是否被维修单引用」：cloud 模式查询 repair_orders.rate_id 集合（仅 rate_id 一列），
 * 得出 referencedRateIds 供页面禁用「被引用费率」的编辑/删除，绝不调用
 * dataService.isContractorRateReferenced。
 */
import {
  parsePositiveIntId,
  parseOptionalString,
  parseOptionalDate,
  parseNonBlankString,
  type Invalid,
} from './cloudMaster'
import type { MasterRdbClient } from './cloudMaster'

/** 安全错误文案（不含底层错误细节 / 数据值） */
export const SAFE_CONTRACTOR_ERROR = '承包商数据加载失败'

// ---------------------------------------------------------------------------
// 只读视图模型（云端可空字段保留 null；与可写领域类型 Contractor 解耦）
// ---------------------------------------------------------------------------

/** 承包商只读视图（address / phone / email 数据库可空 → string | null） */
export interface ContractorView {
  contractor_id: number
  name: string
  address: string | null
  phone: string | null
  email: string | null
}

/** 费率只读视图（effective_date 与 hourly_rate 均 NOT NULL） */
export interface ContractorRateView {
  rate_id: number
  contractor_id: number
  effective_date: string
  hourly_rate: number
}

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string；可空列类型与数据库一致）
// ---------------------------------------------------------------------------
export interface CloudContractorRow {
  contractor_id: number | string | null | undefined
  name: string | null | undefined
  address: string | null | undefined
  phone: string | null | undefined
  email: string | null | undefined
}

export interface CloudContractorRateRow {
  rate_id: number | string | null | undefined
  contractor_id: number | string | null | undefined
  effective_date: string | null | undefined
  hourly_rate: number | string | null | undefined
}

export type ContractorReadResult =
  | {
      ok: true
      contractors: ContractorView[]
      rates: ContractorRateView[]
      /** 已被维修单引用的费率 rate_id 集合（升序去重），供页面禁用「被引用费率」的编辑/删除 */
      referencedRateIds: number[]
    }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 解析助手（本模块专属）
// ---------------------------------------------------------------------------

/** 有限正数（hourly_rate，numeric(10,2) CHECK > 0）：null/空 → INVALID；非有限数或 <= 0 → INVALID */
function parsePositiveNumber(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 'INVALID'
  return n
}

/** 必填日期（effective_date，date NOT NULL）：null/空 → INVALID；非空须严格 YYYY-MM-DD 真实日期 */
function parseRequiredDate(v: string | null | undefined): string | Invalid {
  const r = parseOptionalDate(v)
  if (r === null) return 'INVALID'
  return r
}

// ---------------------------------------------------------------------------
// 单行映射（字段异常即 fail-closed；可空字段的 NULL 为合法值，保留为 null）
// ---------------------------------------------------------------------------
function mapContractorRow(
  raw: CloudContractorRow,
): { ok: true; contractor: ContractorView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const contractor_id = parsePositiveIntId(raw.contractor_id)
  if (contractor_id === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const name = parseNonBlankString(raw.name)
  if (name === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  // address / phone / email：数据库可空 → 保留 null（空串仍是合法值，二者区分）
  const address = parseOptionalString(raw.address)
  if (address === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const phone = parseOptionalString(raw.phone)
  if (phone === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const email = parseOptionalString(raw.email)
  if (email === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  return { ok: true, contractor: { contractor_id, name, address, phone, email } }
}

/**
 * 费率单行映射（不含关联完整性校验）：effective_date 严格日期；hourly_rate 有限正数。
 * 关联完整性（contractor_id 必须存在）由 mapCloudContractorRates 在批量映射时统一校验，
 * 写操作返回行落地（settleReturnedRate）也复用本函数——写后返回的 contractor_id 已由数据库
 * 外键保证真实存在，无需在此二次校验。
 */
export function mapContractorRateRow(
  raw: CloudContractorRateRow,
): { ok: true; rate: ContractorRateView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const rate_id = parsePositiveIntId(raw.rate_id)
  if (rate_id === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const contractor_id = parsePositiveIntId(raw.contractor_id)
  if (contractor_id === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const effective_date = parseRequiredDate(raw.effective_date)
  if (effective_date === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  const hourly_rate = parsePositiveNumber(raw.hourly_rate)
  if (hourly_rate === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }

  return { ok: true, rate: { rate_id, contractor_id, effective_date, hourly_rate } }
}

// ---------------------------------------------------------------------------
// 批量映射：逐行校验 + 重复主键 / 复合唯一约束拒绝 + 稳定排序
// ---------------------------------------------------------------------------
export function mapCloudContractors(
  rows: unknown,
): { ok: true; contractors: ContractorView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const contractors: ContractorView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapContractorRow(raw as CloudContractorRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    if (seen.has(r.contractor.contractor_id)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    seen.add(r.contractor.contractor_id)
    contractors.push(r.contractor)
  }
  contractors.sort((a, b) => a.contractor_id - b.contractor_id)
  return { ok: true, contractors }
}

export function mapCloudContractorRates(
  rows: unknown,
  contractorIds: ReadonlySet<number>,
): { ok: true; rates: ContractorRateView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const rates: ContractorRateView[] = []
  const seenRate = new Set<number>()
  const seenComposite = new Set<string>() // `${contractor_id}:${effective_date}`
  for (const raw of rows) {
    const r = mapContractorRateRow(raw as CloudContractorRateRow)
    if (!r.ok) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    // 关联完整性：费率必须归属一个真实存在的承包商
    if (!contractorIds.has(r.rate.contractor_id)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    if (seenRate.has(r.rate.rate_id)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    // 复合唯一：同承包商同日仅一条费率（UNIQUE(contractor_id, effective_date)）
    const compositeKey = `${r.rate.contractor_id}:${r.rate.effective_date}`
    if (seenComposite.has(compositeKey)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    seenRate.add(r.rate.rate_id)
    seenComposite.add(compositeKey)
    rates.push(r.rate)
  }
  rates.sort((a, b) => a.rate_id - b.rate_id)
  return { ok: true, rates }
}

/** 维修单 rate_id 行（仅需 rate_id 一列） */
export interface CloudRepairOrderRateIdRow {
  rate_id: number | string | null | undefined
}

/**
 * 解析「已被维修单引用的费率 rate_id」集合（升序去重）：
 * 逐行解析 rate_id 为正安全整数，任一非法即 fail-closed；重复 rate_id 去重。
 * 空数组（无任何维修单）为合法结果，返回空集合。
 */
export function mapCloudRepairOrderRateIds(
  rows: unknown,
): { ok: true; referencedRateIds: number[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const seen = new Set<number>()
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    const rate_id = parsePositiveIntId((raw as CloudRepairOrderRateIdRow).rate_id)
    if (rate_id === 'INVALID') return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    seen.add(rate_id)
  }
  const referencedRateIds = Array.from(seen).sort((a, b) => a - b)
  return { ok: true, referencedRateIds }
}

/**
 * 三表联立组装：先映射承包商构建外键集合，再映射费率并做关联校验，最后解析被维修单引用的费率集合。
 * 任一环节失败即返回安全错误，绝不返回部分数据。
 */
export function assembleCloudContractors(
  contractorsRows: unknown,
  ratesRows: unknown,
  referencedRateIdsRows: unknown,
): ContractorReadResult {
  const c = mapCloudContractors(contractorsRows)
  if (!c.ok) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const contractorIds = new Set(c.contractors.map((x) => x.contractor_id))
  const r = mapCloudContractorRates(ratesRows, contractorIds)
  if (!r.ok) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  const ref = mapCloudRepairOrderRateIds(referencedRateIdsRows)
  if (!ref.ok) return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  return {
    ok: true,
    contractors: c.contractors,
    rates: r.rates,
    referencedRateIds: ref.referencedRateIds,
  }
}

/**
 * 当前费率（从云端费率计算，只取 effective_date <= asOfDate 的最新一条，未来费率不生效）。
 * 无匹配返回 null。与 dataService.getEffectiveContractorRate 语义一致，但只读纯函数，
 * cloud 模式用它取代 dataService.getEffectiveContractorRate。
 */
export function computeCurrentRateView(
  rates: ContractorRateView[],
  contractorId: number,
  asOfDate: string,
): ContractorRateView | null {
  const candidates = rates
    .filter((r) => r.contractor_id === contractorId && r.effective_date <= asOfDate)
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))
  return candidates.length > 0 ? candidates[0] : null
}

// ---------------------------------------------------------------------------
// 查询构造器（复用 cloudMaster 的 MasterRdbClient，注入 fake client 供 Node 单测）
// ---------------------------------------------------------------------------

/** 承包商精确列（5 列） */
export const CONTRACTOR_SELECT_COLUMNS = 'contractor_id, name, address, phone, email'
/** 费率精确列（4 列） */
export const RATE_SELECT_COLUMNS = 'rate_id, contractor_id, effective_date, hourly_rate'
/** 维修单被引用费率查询精确列（仅 rate_id 1 列） */
export const REPAIR_ORDER_RATE_ID_SELECT_COLUMNS = 'rate_id'

/** 承包商查询：from('contractors') + 精确列 + contractor_id 升序 */
export async function queryContractors(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('contractors').select(CONTRACTOR_SELECT_COLUMNS).order('contractor_id', { ascending: true })
}

/** 费率查询：from('contractor_rates') + 精确列 + rate_id 升序 */
export async function queryContractorRates(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('contractor_rates').select(RATE_SELECT_COLUMNS).order('rate_id', { ascending: true })
}

/** 被引用费率查询：from('repair_orders') + 精确列 rate_id（升序，供去重集合解析） */
export async function queryRepairOrderRateIds(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('repair_orders')
    .select(REPAIR_ORDER_RATE_ID_SELECT_COLUMNS)
    .order('rate_id', { ascending: true })
}

/**
 * 承包商 + 费率 + 被引用费率主查询：并行读取三表，任一返回 error 或抛异常 → 整体安全错误
 * （不返回部分数据）。成功后联立组装并做关联校验。
 */
export async function queryContractorsWithRates(rdb: MasterRdbClient): Promise<ContractorReadResult> {
  try {
    const [contractors, rates, referencedRateIds] = await Promise.all([
      queryContractors(rdb),
      queryContractorRates(rdb),
      queryRepairOrderRateIds(rdb),
    ])
    if (contractors.error || rates.error || referencedRateIds.error) {
      return { ok: false, error: SAFE_CONTRACTOR_ERROR }
    }
    return assembleCloudContractors(contractors.data, rates.data, referencedRateIds.data)
  } catch {
    return { ok: false, error: SAFE_CONTRACTOR_ERROR }
  }
}
