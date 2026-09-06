/**
 * 云端「门店 / 技能等级 / 设备」三张基础资料表的只读查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点：
 * - 数值字段归一化为 number（云端 bigint/numeric/integer 可能返回 string）；
 * - 显式列名查询，绝不用 select('*')；
 * - 主键 / 外键 / 枚举 / 重复主键 / 关联完整性 / 配件技能等级规则 逐项校验，
 *   任一真实错误即 fail-closed，返回安全错误；
 * - 三张表任一查询失败 → 整体失败（空数据 + 安全错误），绝不返回部分数据、
 *   绝不回退 localStorage。
 *
 * nullable 与 TypeScript 类型映射策略（只读视图模型显式保留 NULL，绝不静默转换）：
 *   数据库可空字段在云端一律映射为「可空字段」的只读视图模型（StoreView / RentalItemView），
 *   NULL 保留为 null，页面统一以占位符「—」展示、搜索按空字符串处理（见页面层），
 *   绝不把 NULL 静默转换为 0 / 空日期 / 虚构文本 / 空字符串，也不得在页面显示字符串 "null"。
 *
 *   * stores.address / stores.phone：数据库可空（无 btrim 约束）→ 视图类型 string | null，
 *     null 与空字符串是两种合法值、彼此区分；
 *   * rental_items.description：数据库可空 → string | null；
 *   * rental_items.purchase_date：数据库可空（date）→ string | null，非空值必须为
 *     严格 YYYY-MM-DD 的真实日期（parseOptionalDate 校验，2026-02-30 之类拒绝）；
 *   * rental_items.purchase_cost / retail_price：数据库可空（numeric）→ number | null；
 *   * rental_items.skill_level_id：数据库可空 → number | null（配件为 null）。
 *
 *   说明（字段保留选择）：description / purchase_date / purchase_cost / retail_price 四个
 *   可空字段当前列表页并不展示、也不参与搜索，但仍保留在只读视图模型与查询列中，
 *   而非从查询中移除——理由是：① 统一采用「可空视图模型 + 严格校验」的单一策略；
 *   ② purchase_date 需严格日期校验；③ 为后续「设备详情 / 编辑」云端迁移复用列，
 *   避免到时再回补列定义。仅读列表带来的轻微冗余（36 行教学数据）可忽略。
 *
 *   local 模式的领域类型（Store / RentalItem）与 DataService CRUD 行为完全不变：
 *   本地对这些字段恒写入非空值（空值用空字符串 / 0 表达），云端只读视图模型
 *   仅在结构上把它们加宽为可空，属单向收窄安全的映射。
 */
import type {
  SkillLevel,
  ItemCategory,
  ItemStatus,
  SkillLevelName,
} from './types'

/** 安全错误文案（不含底层错误细节 / 数据值） */
export const SAFE_MASTER_ERROR = '基础资料数据加载失败'

export type Invalid = 'INVALID'

// ---------------------------------------------------------------------------
// 只读视图模型（云端可空字段保留 null；与可写领域类型 Store/RentalItem 解耦）
// ---------------------------------------------------------------------------

/** 门店只读视图（address / phone 数据库可空 → string | null） */
export interface StoreView {
  store_id: number
  store_name: string
  address: string | null
  phone: string | null
}

/** 设备只读视图（可空字段显式建模为可空） */
export interface RentalItemView {
  item_id: number
  item_code: string
  name: string
  description: string | null
  category: ItemCategory
  purchase_date: string | null
  purchase_cost: number | null
  retail_price: number | null
  daily_rate: number
  skill_level_id: number | null
  home_store_id: number
  current_store_id: number
  status: ItemStatus
}

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string；可空列类型与数据库一致）
// ---------------------------------------------------------------------------
export interface CloudStoreRow {
  store_id: number | string | null | undefined
  store_name: string | null | undefined
  address: string | null | undefined
  phone: string | null | undefined
}

export interface CloudSkillLevelRow {
  skill_level_id: number | string | null | undefined
  level_name: string | null | undefined
  sort_order: number | string | null | undefined
}

export interface CloudRentalItemRow {
  item_id: number | string | null | undefined
  item_code: string | null | undefined
  name: string | null | undefined
  description: string | null | undefined
  category: string | null | undefined
  purchase_date: string | null | undefined
  purchase_cost: number | string | null | undefined
  retail_price: number | string | null | undefined
  daily_rate: number | string | null | undefined
  skill_level_id: number | string | null | undefined
  home_store_id: number | string | null | undefined
  current_store_id: number | string | null | undefined
  status: string | null | undefined
}

export type MasterReadResult =
  | { ok: true; stores: StoreView[]; skillLevels: SkillLevel[]; items: RentalItemView[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 解析助手
// ---------------------------------------------------------------------------

/**
 * bigint 主键/外键：必须为正的「安全整数」，否则 INVALID。
 * 用 Number.isSafeInteger 而非 Number.isInteger，避免超过 Number.MAX_SAFE_INTEGER
 * 的 bigint（数字或数字字符串）在 Number() 转换时丢精度却仍被误判为整数。
 */
export function parsePositiveIntId(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n) || n <= 0) return 'INVALID'
  return n
}

/** 领域类型要求非空的数值：null/空 → INVALID；非有限数 → INVALID */
function parseRequiredNumber(v: number | string | null | undefined): number | Invalid {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 'INVALID'
  return n
}

/** 可空数值（numeric）：null/空 → null（未填写保留）；非有限数 → INVALID */
function parseOptionalNumber(v: number | string | null | undefined): number | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 'INVALID'
  return n
}

/** 可空字符串（varchar，无 btrim 约束）：null/undefined → null；非 string → INVALID；空串保留为空串 */
export function parseOptionalString(v: string | null | undefined): string | null | Invalid {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return 'INVALID'
  return v
}

/** 非空字符串（数据库 NOT NULL + btrim<>'' 约束）：trim 后非空才合法 */
export function parseNonBlankString(v: string | null | undefined): string | Invalid {
  if (typeof v !== 'string' || v.trim() === '') return 'INVALID'
  return v
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 可空日期（date）：null/undefined/空串 → null（未填写保留）；
 * 非空值必须为严格 YYYY-MM-DD 且是真实存在的日期（如 2026-02-30 拒绝），否则 INVALID。
 * 用 Date.UTC 往返校验，杜绝「2026-02-30」这类非法日期被当作合法字符串放行。
 */
export function parseOptionalDate(v: string | null | undefined): string | null | Invalid {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return 'INVALID'
  if (!DATE_ONLY_RE.test(v)) return 'INVALID'
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return 'INVALID'
  }
  return v
}

// ---------------------------------------------------------------------------
// 枚举校验
// ---------------------------------------------------------------------------
const ITEM_CATEGORIES: readonly ItemCategory[] = ['滑雪板', '雪靴', '雪杖', '单板', '护目镜', '头盔']
const ITEM_STATUSES: readonly ItemStatus[] = ['在库', '借出中', '维修中', '已报废']
const SKILL_LEVEL_NAMES: readonly SkillLevelName[] = ['初级', '中级', '高级', '专家+']
const ACCESSORY_CATEGORIES: readonly ItemCategory[] = ['护目镜', '头盔']

function isItemCategory(v: string): v is ItemCategory {
  return (ITEM_CATEGORIES as readonly string[]).includes(v)
}
function isItemStatus(v: string): v is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(v)
}
function isSkillLevelName(v: string): v is SkillLevelName {
  return (SKILL_LEVEL_NAMES as readonly string[]).includes(v)
}

// ---------------------------------------------------------------------------
// 单行映射（字段异常即 fail-closed；可空字段的 NULL 为合法值，保留为 null）
// ---------------------------------------------------------------------------
function mapStoreRow(
  raw: CloudStoreRow,
): { ok: true; store: StoreView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_MASTER_ERROR }

  const store_id = parsePositiveIntId(raw.store_id)
  if (store_id === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  const store_name = parseNonBlankString(raw.store_name)
  if (store_name === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  // address / phone：数据库可空 → 保留 null（空串仍是合法值，二者区分）
  const address = parseOptionalString(raw.address)
  if (address === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
  const phone = parseOptionalString(raw.phone)
  if (phone === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  return { ok: true, store: { store_id, store_name, address, phone } }
}

function mapSkillLevelRow(
  raw: CloudSkillLevelRow,
): { ok: true; level: SkillLevel } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_MASTER_ERROR }

  const skill_level_id = parsePositiveIntId(raw.skill_level_id)
  if (skill_level_id === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  if (typeof raw.level_name !== 'string' || !isSkillLevelName(raw.level_name)) {
    return { ok: false, error: SAFE_MASTER_ERROR }
  }

  const sort_order = parseRequiredNumber(raw.sort_order)
  if (sort_order === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
  if (!Number.isInteger(sort_order)) return { ok: false, error: SAFE_MASTER_ERROR }

  return {
    ok: true,
    level: { skill_level_id, level_name: raw.level_name, sort_order },
  }
}

/**
 * 设备单行映射 + 关联完整性校验：
 * - home_store_id / current_store_id 必须存在于已读取门店集合；
 * - skill_level_id 非空时必须存在于已读取技能等级集合；
 * - 配件（护目镜/头盔）的 skill_level_id 必须为 NULL。
 * - 可空字段 description / purchase_date / purchase_cost / retail_price 的 NULL 为合法值。
 */
function mapRentalItemRow(
  raw: CloudRentalItemRow,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
): { ok: true; item: RentalItemView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_MASTER_ERROR }

  const item_id = parsePositiveIntId(raw.item_id)
  if (item_id === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  const item_code = parseNonBlankString(raw.item_code)
  if (item_code === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
  const name = parseNonBlankString(raw.name)
  if (name === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  // description：数据库可空 → 保留 null
  const description = parseOptionalString(raw.description)
  if (description === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  if (typeof raw.category !== 'string' || !isItemCategory(raw.category)) {
    return { ok: false, error: SAFE_MASTER_ERROR }
  }
  const category = raw.category

  // purchase_date：数据库可空（date）→ 保留 null；非空需严格 YYYY-MM-DD 真实日期
  const purchase_date = parseOptionalDate(raw.purchase_date)
  if (purchase_date === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  // purchase_cost / retail_price：数据库可空（numeric）→ 保留 null
  const purchase_cost = parseOptionalNumber(raw.purchase_cost)
  if (purchase_cost === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
  const retail_price = parseOptionalNumber(raw.retail_price)
  if (retail_price === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  // daily_rate：数据库 NOT NULL（numeric）→ 必须为有限数
  const daily_rate = parseRequiredNumber(raw.daily_rate)
  if (daily_rate === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  // skill_level_id：可空（配件为 NULL），非空时必须为有效外键
  let skill_level_id: number | null
  if (raw.skill_level_id === null || raw.skill_level_id === undefined || raw.skill_level_id === '') {
    skill_level_id = null
  } else {
    const parsed = parsePositiveIntId(raw.skill_level_id)
    if (parsed === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
    skill_level_id = parsed
  }

  const home_store_id = parsePositiveIntId(raw.home_store_id)
  if (home_store_id === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }
  const current_store_id = parsePositiveIntId(raw.current_store_id)
  if (current_store_id === 'INVALID') return { ok: false, error: SAFE_MASTER_ERROR }

  if (typeof raw.status !== 'string' || !isItemStatus(raw.status)) {
    return { ok: false, error: SAFE_MASTER_ERROR }
  }
  const status = raw.status

  // 关联完整性：门店外键
  if (!storeIds.has(home_store_id) || !storeIds.has(current_store_id)) {
    return { ok: false, error: SAFE_MASTER_ERROR }
  }

  const isAccessory = (ACCESSORY_CATEGORIES as readonly string[]).includes(category)
  if (skill_level_id !== null) {
    // 外键：技能等级必须存在
    if (!levelIds.has(skill_level_id)) return { ok: false, error: SAFE_MASTER_ERROR }
    // 配件规则：护目镜/头盔不得设技能等级
    if (isAccessory) return { ok: false, error: SAFE_MASTER_ERROR }
  }

  return {
    ok: true,
    item: {
      item_id,
      item_code,
      name,
      description,
      category,
      purchase_date,
      purchase_cost,
      retail_price,
      daily_rate,
      skill_level_id,
      home_store_id,
      current_store_id,
      status,
    },
  }
}

// ---------------------------------------------------------------------------
// 批量映射：逐行校验 + 重复主键拒绝 + 稳定排序
// ---------------------------------------------------------------------------
export function mapCloudStores(
  rows: unknown,
): { ok: true; stores: StoreView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_MASTER_ERROR }
  const stores: StoreView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapStoreRow(raw as CloudStoreRow)
    if (!r.ok) return { ok: false, error: SAFE_MASTER_ERROR }
    if (seen.has(r.store.store_id)) return { ok: false, error: SAFE_MASTER_ERROR }
    seen.add(r.store.store_id)
    stores.push(r.store)
  }
  stores.sort((a, b) => a.store_id - b.store_id)
  return { ok: true, stores }
}

export function mapCloudSkillLevels(
  rows: unknown,
): { ok: true; levels: SkillLevel[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_MASTER_ERROR }
  const levels: SkillLevel[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapSkillLevelRow(raw as CloudSkillLevelRow)
    if (!r.ok) return { ok: false, error: SAFE_MASTER_ERROR }
    if (seen.has(r.level.skill_level_id)) return { ok: false, error: SAFE_MASTER_ERROR }
    seen.add(r.level.skill_level_id)
    levels.push(r.level)
  }
  // 按 sort_order 升序（display 顺序），sort_order 相同时按主键稳定
  levels.sort((a, b) => (a.sort_order - b.sort_order) || (a.skill_level_id - b.skill_level_id))
  return { ok: true, levels }
}

export function mapCloudRentalItems(
  rows: unknown,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
): { ok: true; items: RentalItemView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_MASTER_ERROR }
  const items: RentalItemView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapRentalItemRow(raw as CloudRentalItemRow, storeIds, levelIds)
    if (!r.ok) return { ok: false, error: SAFE_MASTER_ERROR }
    if (seen.has(r.item.item_id)) return { ok: false, error: SAFE_MASTER_ERROR }
    seen.add(r.item.item_id)
    items.push(r.item)
  }
  items.sort((a, b) => a.item_id - b.item_id)
  return { ok: true, items }
}

/**
 * 三表联立组装：先映射门店与技能等级，构建外键集合，再映射设备并做关联校验。
 * 任一环节失败即返回安全错误，绝不返回部分数据。
 */
export function assembleCloudMaster(
  storesRows: unknown,
  levelsRows: unknown,
  itemsRows: unknown,
): MasterReadResult {
  const s = mapCloudStores(storesRows)
  if (!s.ok) return { ok: false, error: SAFE_MASTER_ERROR }
  const l = mapCloudSkillLevels(levelsRows)
  if (!l.ok) return { ok: false, error: SAFE_MASTER_ERROR }

  const storeIds = new Set(s.stores.map((x) => x.store_id))
  const levelIds = new Set(l.levels.map((x) => x.skill_level_id))
  const i = mapCloudRentalItems(itemsRows, storeIds, levelIds)
  if (!i.ok) return { ok: false, error: SAFE_MASTER_ERROR }

  return { ok: true, stores: s.stores, skillLevels: l.levels, items: i.items }
}

// ---------------------------------------------------------------------------
// 查询构造器（可注入 fake client 供 Node 单测）
// ---------------------------------------------------------------------------
export interface MasterQueryBuilder {
  select(columns: string): MasterQueryBuilder
  order(
    column: string,
    opts: { ascending: boolean },
  ): Promise<{ data: unknown; error: unknown }>
}

export interface MasterRdbClient {
  from(table: string): MasterQueryBuilder
}

/** 门店精确列（4 列） */
export const STORE_SELECT_COLUMNS = 'store_id, store_name, address, phone'
/** 技能等级精确列（3 列） */
export const SKILL_LEVEL_SELECT_COLUMNS = 'skill_level_id, level_name, sort_order'
/** 设备精确列（13 列） */
export const RENTAL_ITEM_SELECT_COLUMNS =
  'item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status'

/** 门店查询：from('stores') + 精确列 + store_id 升序 */
export async function queryStores(rdb: MasterRdbClient): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('stores').select(STORE_SELECT_COLUMNS).order('store_id', { ascending: true })
}

/** 技能等级查询：from('skill_levels') + 精确列 + sort_order 升序 */
export async function querySkillLevels(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('skill_levels')
    .select(SKILL_LEVEL_SELECT_COLUMNS)
    .order('sort_order', { ascending: true })
}

/** 设备查询：from('rental_items') + 精确列 + item_id 升序 */
export async function queryRentalItems(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb
    .from('rental_items')
    .select(RENTAL_ITEM_SELECT_COLUMNS)
    .order('item_id', { ascending: true })
}

/**
 * 主查询：并行读取三表，任一返回 error 或抛异常 → 整体安全错误（不返回部分数据）。
 * 成功后联立组装并做关联校验。
 */
export async function queryMaster(rdb: MasterRdbClient): Promise<MasterReadResult> {
  try {
    const [stores, levels, items] = await Promise.all([
      queryStores(rdb),
      querySkillLevels(rdb),
      queryRentalItems(rdb),
    ])
    if (stores.error || levels.error || items.error) {
      return { ok: false, error: SAFE_MASTER_ERROR }
    }
    return assembleCloudMaster(stores.data, levels.data, items.data)
  } catch {
    return { ok: false, error: SAFE_MASTER_ERROR }
  }
}
