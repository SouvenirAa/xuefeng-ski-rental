/**
 * 云端「管理驾驶舱」KPI 聚合查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 仅 admin/staff 可访问（路由层拦截 contractor；RLS 下 rental_contracts / repair_orders
 * 对 contractor 无 SELECT 权限，直读会被 RLS 挡住）。聚合口径与 docs/01-需求分析.md §10
 * 完全一致，local 模式经 dashboardDataSource 复用同一聚合核心，保证口径统一：
 *   1. 当前设备利用率 = 借出中有效设备数 ÷ 有效设备总数（不含已报废；维修中计入总数、不计入借出）；
 *   2. 本月营收 = 本月内完成合同（按 completed_at 所在月份，非 contract_date）的 final total_amount 之和；
 *   3. 平均维修周转时长 = 已完成维修单的 repair_date − request_date（自然日）的平均值；
 *   4. 门店库存分布 = 按 current_store_id × 设备状态（在库/借出中/维修中/已报废）汇总数量。
 *
 * 安全边界（与其它 cloud* 查询层一致）：
 * - 逐张表显式列名（绝不用 select('*')）；四表并行读取；
 * - 任一表返回 error / 抛异常 / 解析失败（非数组、必需字段非法、状态非法、重复主键、
 *   引用完整性缺失）→ 整体 fail-closed，返回统一安全错误，绝不返回部分 KPI、绝不回退本地数据。
 * - "本月"由前端传入本地今天日期 todayStr（YYYY-MM-DD），云端不猜测时区。
 */
import {
  parsePositiveIntId,
  parseOptionalDate,
  type Invalid,
  type MasterRdbClient,
} from './cloudMaster'

/** 驾驶舱聚合统一安全错误 */
export const SAFE_DASHBOARD_ERROR = '驾驶舱数据加载失败'

// ---------------------------------------------------------------------------
// 状态集合（与 types.ts 联合类型一致）
// ---------------------------------------------------------------------------

const ITEM_STATUSES: readonly string[] = ['在库', '借出中', '维修中', '已报废']
const CONTRACT_STATUSES: readonly string[] = ['进行中', '已完成']
const REPAIR_STATUSES: readonly string[] = ['待维修', '维修中', '已完成']

function isItemStatus(v: string): boolean {
  return ITEM_STATUSES.includes(v)
}
function isContractStatus(v: string): boolean {
  return CONTRACT_STATUSES.includes(v)
}
function isRepairStatus(v: string): boolean {
  return REPAIR_STATUSES.includes(v)
}

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string）
// ---------------------------------------------------------------------------

interface CloudDashboardItemRow {
  item_id: number | string | null | undefined
  status: string | null | undefined
  current_store_id: number | string | null | undefined
}

interface CloudDashboardStoreRow {
  store_id: number | string | null | undefined
  store_name: string | null | undefined
}

interface CloudDashboardContractRow {
  status: string | null | undefined
  completed_at: string | null | undefined
  total_amount: number | string | null | undefined
}

interface CloudDashboardRepairRow {
  status: string | null | undefined
  request_date: string | null | undefined
  repair_date: string | null | undefined
}

// ---------------------------------------------------------------------------
// KPI 结果类型
// ---------------------------------------------------------------------------

/** 门店库存分布（按 current_store_id 分组，仅含「有设备」的门店） */
export interface StoreDistributionItem {
  store_id: number
  store_name: string
  /** 在库 */
  inStock: number
  /** 借出中 */
  rented: number
  /** 维修中 */
  repairing: number
  /** 已报废 */
  scrapped: number
}

export interface DashboardKpi {
  /** 借出中有效设备数 */
  rentedCount: number
  /** 有效设备总数（不含已报废；维修中计入） */
  validCount: number
  /** 利用率 = rentedCount / validCount（0~1）；无有效设备时为 null */
  utilizationRate: number | null
  /** 本月营收（本月完成合同的 final total_amount 之和） */
  monthlyRevenue: number
  /** 平均维修周转时长（自然日，保留 1 位小数）；无已完成维修单时为 null */
  avgRepairTurnaroundDays: number | null
  /** 已完成维修单数量（供口径提示展示） */
  completedRepairCount: number
  /** 门店库存分布（按 store_id 升序） */
  storeDistribution: StoreDistributionItem[]
}

export type DashboardReadResult =
  | { ok: true; kpi: DashboardKpi }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 解析助手
// ---------------------------------------------------------------------------

/** 非负有限数（total_amount numeric(10,2) NOT NULL）：null/空 → INVALID；非有限数或 < 0 → INVALID */
function parseNonNegativeNumber(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 'INVALID'
  return n
}

/**
 * completed_at 为 timestamp without time zone（真实云库返回 "YYYY-MM-DD HH:MM:SS" 或 ISO 带 T），
 * 本口径仅关心「完成月份」，故取日期部分（前 10 位）并复用 parseOptionalDate 严格校验真实日期。
 */
function parseCompletedAtDate(v: string | null | undefined): string | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return 'INVALID'
  const datePart = v.trim().slice(0, 10)
  return parseOptionalDate(datePart)
}

/** 自然日天数差（b − a，ISO YYYY-MM-DD；用本地 Date 解析避免时区偏移） */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime()
  const db = new Date(`${b}T00:00:00`).getTime()
  return Math.round((db - da) / 86400000)
}

/** 四舍五入到 1 位小数 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------------------
// 逐表解析（任一非法 → null，调用方 fail-closed）
// ---------------------------------------------------------------------------

interface ParsedItem {
  status: string
  current_store_id: number
}

/** rental_items 解析：item_id / current_store_id 正安全整数、status 合法；重复 item_id 拒绝 */
function parseItems(rows: unknown): ParsedItem[] | null {
  if (!Array.isArray(rows)) return null
  const seen = new Set<number>()
  const out: ParsedItem[] = []
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as CloudDashboardItemRow
    const item_id = parsePositiveIntId(r.item_id)
    const current_store_id = parsePositiveIntId(r.current_store_id)
    if (item_id === 'INVALID' || current_store_id === 'INVALID') return null
    if (typeof r.status !== 'string' || !isItemStatus(r.status)) return null
    if (seen.has(item_id)) return null
    seen.add(item_id)
    out.push({ status: r.status, current_store_id })
  }
  return out
}

interface ParsedStore {
  store_id: number
  store_name: string
}

/** stores 解析：store_id 正安全整数、store_name 非空；重复 store_id 拒绝 */
function parseStores(rows: unknown): ParsedStore[] | null {
  if (!Array.isArray(rows)) return null
  const seen = new Set<number>()
  const out: ParsedStore[] = []
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as CloudDashboardStoreRow
    const store_id = parsePositiveIntId(r.store_id)
    if (store_id === 'INVALID') return null
    if (typeof r.store_name !== 'string' || r.store_name.trim() === '') return null
    if (seen.has(store_id)) return null
    seen.add(store_id)
    out.push({ store_id, store_name: r.store_name })
  }
  return out
}

interface ParsedContract {
  status: string
  completed_at: string | null
  total_amount: number
}

/** rental_contracts 解析：status 合法、total_amount 非负有限数；已完成时 completed_at 须为合法日期 */
function parseContracts(rows: unknown): ParsedContract[] | null {
  if (!Array.isArray(rows)) return null
  const out: ParsedContract[] = []
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as CloudDashboardContractRow
    if (typeof r.status !== 'string' || !isContractStatus(r.status)) return null
    const total_amount = parseNonNegativeNumber(r.total_amount)
    if (total_amount === 'INVALID') return null
    let completed_at: string | null = null
    if (r.status === '已完成') {
      const d = parseCompletedAtDate(r.completed_at)
      if (d === 'INVALID' || d === null) return null
      completed_at = d
    }
    out.push({ status: r.status, completed_at, total_amount })
  }
  return out
}

interface ParsedRepair {
  status: string
  request_date: string
  repair_date: string | null
}

/** repair_orders 解析：status 合法、request_date 合法；已完成时 repair_date 合法且不早于 request_date */
function parseRepairs(rows: unknown): ParsedRepair[] | null {
  if (!Array.isArray(rows)) return null
  const out: ParsedRepair[] = []
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as CloudDashboardRepairRow
    if (typeof r.status !== 'string' || !isRepairStatus(r.status)) return null
    const request_date = parseOptionalDate(r.request_date)
    if (request_date === 'INVALID' || request_date === null) return null
    let repair_date: string | null = null
    if (r.status === '已完成') {
      const d = parseOptionalDate(r.repair_date)
      if (d === 'INVALID' || d === null) return null
      if (d < request_date) return null
      repair_date = d
    }
    out.push({ status: r.status, request_date, repair_date })
  }
  return out
}

// ---------------------------------------------------------------------------
// 聚合核心（local/cloud 共享口径）
// ---------------------------------------------------------------------------

/**
 * 聚合 KPI（口径与 docs/01 §10 一致）。
 * 任一表解析失败、门店引用完整性缺失（设备的 current_store_id 无对应门店）→ fail-closed。
 */
export function assembleDashboardKpi(
  itemsRows: unknown,
  storesRows: unknown,
  contractsRows: unknown,
  repairsRows: unknown,
  todayStr: string,
): DashboardReadResult {
  const items = parseItems(itemsRows)
  if (items === null) return { ok: false, error: SAFE_DASHBOARD_ERROR }
  const stores = parseStores(storesRows)
  if (stores === null) return { ok: false, error: SAFE_DASHBOARD_ERROR }
  const contracts = parseContracts(contractsRows)
  if (contracts === null) return { ok: false, error: SAFE_DASHBOARD_ERROR }
  const repairs = parseRepairs(repairsRows)
  if (repairs === null) return { ok: false, error: SAFE_DASHBOARD_ERROR }

  const storeNameById = new Map<number, string>()
  for (const s of stores) storeNameById.set(s.store_id, s.store_name)

  // 1. 设备利用率 + 4. 门店库存分布
  let validCount = 0
  let rentedCount = 0
  const dist = new Map<number, StoreDistributionItem>()
  for (const it of items) {
    if (it.status !== '已报废') validCount += 1
    if (it.status === '借出中') rentedCount += 1

    let entry = dist.get(it.current_store_id)
    if (entry === undefined) {
      const name = storeNameById.get(it.current_store_id)
      if (name === undefined) return { ok: false, error: SAFE_DASHBOARD_ERROR }
      entry = { store_id: it.current_store_id, store_name: name, inStock: 0, rented: 0, repairing: 0, scrapped: 0 }
      dist.set(it.current_store_id, entry)
    }
    if (it.status === '在库') entry.inStock += 1
    else if (it.status === '借出中') entry.rented += 1
    else if (it.status === '维修中') entry.repairing += 1
    else entry.scrapped += 1
  }
  const utilizationRate = validCount > 0 ? rentedCount / validCount : null

  // 2. 本月营收（按 completed_at 所在月份）
  const monthPrefix = todayStr.slice(0, 7)
  let monthlyRevenue = 0
  for (const c of contracts) {
    if (c.status === '已完成' && c.completed_at !== null && c.completed_at.startsWith(monthPrefix)) {
      monthlyRevenue += c.total_amount
    }
  }

  // 3. 平均维修周转时长
  let repairDaysSum = 0
  let completedRepairCount = 0
  for (const r of repairs) {
    if (r.status === '已完成' && r.repair_date !== null) {
      repairDaysSum += daysBetween(r.request_date, r.repair_date)
      completedRepairCount += 1
    }
  }
  const avgRepairTurnaroundDays =
    completedRepairCount > 0 ? round1(repairDaysSum / completedRepairCount) : null

  return {
    ok: true,
    kpi: {
      rentedCount,
      validCount,
      utilizationRate,
      monthlyRevenue: round1(monthlyRevenue),
      avgRepairTurnaroundDays,
      completedRepairCount,
      storeDistribution: [...dist.values()].sort((a, b) => a.store_id - b.store_id),
    },
  }
}

// ---------------------------------------------------------------------------
// 查询构造器（复用 cloudMaster 的 MasterRdbClient 注入 fake client）
// ---------------------------------------------------------------------------

/** rental_items 聚合列（3 列） */
export const DASHBOARD_ITEM_COLUMNS = 'item_id, status, current_store_id'
/** stores 聚合列（2 列） */
export const DASHBOARD_STORE_COLUMNS = 'store_id, store_name'
/** rental_contracts 聚合列（3 列） */
export const DASHBOARD_CONTRACT_COLUMNS = 'status, completed_at, total_amount'
/** repair_orders 聚合列（3 列） */
export const DASHBOARD_REPAIR_COLUMNS = 'status, request_date, repair_date'

export async function queryDashboardItems(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('rental_items').select(DASHBOARD_ITEM_COLUMNS).order('item_id', { ascending: true })
}

export async function queryDashboardStores(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('stores').select(DASHBOARD_STORE_COLUMNS).order('store_id', { ascending: true })
}

export async function queryDashboardContracts(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('rental_contracts')
    .select(DASHBOARD_CONTRACT_COLUMNS)
    .order('contract_id', { ascending: true })
}

export async function queryDashboardRepairs(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('repair_orders').select(DASHBOARD_REPAIR_COLUMNS).order('repair_id', { ascending: true })
}

/**
 * 驾驶舱主查询：并行读取四表，任一 error 或抛异常 → 整体安全错误（不返回部分 KPI）。
 * 成功后聚合，todayStr 由调用方（页面）传入本地今天日期。
 */
export async function queryDashboardKpi(
  rdb: MasterRdbClient,
  todayStr: string,
): Promise<DashboardReadResult> {
  try {
    const [items, stores, contracts, repairs] = await Promise.all([
      queryDashboardItems(rdb),
      queryDashboardStores(rdb),
      queryDashboardContracts(rdb),
      queryDashboardRepairs(rdb),
    ])
    if (items.error || stores.error || contracts.error || repairs.error) {
      return { ok: false, error: SAFE_DASHBOARD_ERROR }
    }
    return assembleDashboardKpi(items.data, stores.data, contracts.data, repairs.data, todayStr)
  } catch {
    return { ok: false, error: SAFE_DASHBOARD_ERROR }
  }
}
