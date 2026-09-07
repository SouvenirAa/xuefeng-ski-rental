/**
 * 云端设备（rental_items）写操作（create/update/remove）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudCustomerMutations 同级别的安全边界）：
 * - 复用 cloudMaster 的行映射 / 严格日期校验 / 精确列查询，保证写后返回行与列表视图
 *   使用同一套映射与关联校验；
 * - payload 仅含业务字段，绝不写入 item_id / status / role / uid / account_id 等越权字段；
 *   新建设备 status 由数据库 DEFAULT '在库' 生成（列级 ACL 不含 status，前端也无法写），
 *   并校验返回行确实为「在库」；update 不写 status、返回行 status 为数据库真实状态，绝不客户端伪造；
 * - update/delete 用经过正安全整数校验的 item_id 精确 eq 过滤；
 * - 显式列名（RENTAL_ITEM_SELECT_COLUMNS），绝不用 select('*')；
 * - 影响行数恰好为 1：0 行视为失败（update/delete 语义不同）、超过 1 行 fail-closed；
 * - 统一安全错误映射：库存编号唯一冲突 / 门店或技能等级引用不存在（写）/ 设备被引用（删）/
 *   CHECK 违例 / 无权限 / 其他，不泄露 SQL、表名、约束名、原始 details/hint、Token；
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 *
 * nullable 与 local/cloud 输入边界（关键差异，不虚假声称与 local 一致）：
 * - 数据库 item_code 唯一约束为普通 B-tree（rental_items_item_code_key），**区分大小写**，
 *   与 customers.email 的 lower(btrim(email)) 表达式唯一索引（不区分大小写）不同；
 *   local 的查重是大小写不敏感（toLowerCase），故 cloud 不做客户端查重，唯一性交由
 *   数据库 23505 兜底 —— 二者语义不完全一致，如实记录、不伪装一致。
 * - 本模块输入采用 cloud 专用可空类型 RentalItemCloudInput（description/purchase_date/
 *   purchase_cost/retail_price 可空），与 local 的非空 RentalItemInput 明确区分；
 *   local 模式的转换边界见 masterDataSource.toLocalItemInput。
 */
import type { ItemCategory, ItemStatus, OpResult } from './types'
import {
  RENTAL_ITEM_SELECT_COLUMNS,
  mapCloudRentalItems,
  parseOptionalDate,
  type RentalItemView,
  type CloudRentalItemRow,
} from './cloudMaster'

/** 设备写操作统一安全错误（不包含底层细节） */
export const SAFE_ITEM_WRITE_ERROR = '设备操作失败，请稍后重试'

/** 库存编号唯一冲突（23505；item_code 数据库 UNIQUE 区分大小写） */
export const ITEM_CODE_CONFLICT_ERROR = '该库存编号已被其他设备使用'

/** create/update 外键引用不存在（23503）：门店或技能等级不存在 */
export const ITEM_REFERENCE_MISSING_ERROR = '所选门店或技能等级不存在'

/** delete 被引用（23503）：设备已被合同/换货/维修引用 */
export const ITEM_REFERENCED_ERROR = '设备已有合同、换货或维修记录，无法删除'

/** CHECK 违例（23514）：字段或配件技能等级规则不合法 */
export const ITEM_CHECK_VIOLATION_ERROR = '输入数据不符合设备规则'

/** update 0 行：设备不存在或无权限 */
export const ITEM_UPDATE_NOT_FOUND_ERROR = '设备不存在或无权限'

/** delete 0 行：设备不存在、状态已变化或无权限 */
export const ITEM_DELETE_NOT_FOUND_ERROR = '设备不存在、状态已变化或无权限'

/** 配件类别（护目镜/头盔不设技能等级） */
const ACCESSORY_CATEGORIES: readonly ItemCategory[] = ['护目镜', '头盔']

/** 六种合法设备类别（运行时枚举校验，不依赖 TS 类型 / 页面 Select / 数据库 CHECK） */
export const ITEM_CATEGORIES: readonly ItemCategory[] = ['滑雪板', '雪靴', '雪杖', '单板', '护目镜', '头盔']

/**
 * 设备云端输入（可空字段显式建模，与 local 非空 RentalItemInput 明确区分）：
 * description / purchase_date / purchase_cost / retail_price / skill_level_id 均可为 null。
 */
export interface RentalItemCloudInput {
  item_code: string
  name: string
  description: string | null
  category: ItemCategory
  purchase_date: string | null
  purchase_cost: number | null
  retail_price: number | null
  /** 日租金：必填，但输入边界显式允许「未填写」（null）；由 validateItemBasics 在写入前拒绝 null/undefined/NaN/Infinity/负数 */
  daily_rate: number | null
  skill_level_id: number | null
  home_store_id: number
  current_store_id: number
}

// ---------------------------------------------------------------------------
// 可注入的最小 RDB 写客户端（Node 可用 fake client 验证 insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------

/** 写查询结果（真实 SDK 为 PostgrestSingleResponse：data + error{code,message,details,hint}） */
export interface ItemMutationResponse {
  data: unknown
  error: unknown
}

/** 写过滤/变换构造器（thenable，可 await；支持 .eq / .select 链式） */
export interface ItemMutationBuilder extends PromiseLike<ItemMutationResponse> {
  eq(column: string, value: unknown): ItemMutationBuilder
  select(columns: string): ItemMutationBuilder
}

/** 写查询构造器（from().insert / update / delete） */
export interface ItemMutationQueryBuilder {
  insert(values: Record<string, unknown>): ItemMutationBuilder
  update(values: Record<string, unknown>): ItemMutationBuilder
  delete(): ItemMutationBuilder
}

/** 设备写操作所需的最小 RDB 客户端 */
export interface ItemRdbMutationClient {
  from(table: string): ItemMutationQueryBuilder
}

// ---------------------------------------------------------------------------
// 输入归一化与校验
// ---------------------------------------------------------------------------

/** 正安全整数校验（home/current store、skill_level、item_id 精确过滤前必须通过） */
export function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/** 可空文本归一化：null → null；trim 后空串 → null；否则 trim 保留（空值写 null，不写虚构文本） */
function normalizeOptionalText(v: string | null): string | null {
  if (v === null) return null
  const t = v.trim()
  return t === '' ? null : t
}

/** 金额：有限且非负（null/undefined/NaN/Infinity/负数一律拒绝，显式 0 合法） */
function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/**
 * 构造设备写 payload：仅业务字段，trim + 空值归一化为 null，
 * 绝不包含 item_id / status / role / uid / account_id / actorRole 等越权字段。
 */
export function buildItemPayload(input: RentalItemCloudInput): Record<string, unknown> {
  return {
    item_code: input.item_code.trim(),
    name: input.name.trim(),
    description: normalizeOptionalText(input.description),
    category: input.category,
    purchase_date: normalizeOptionalText(input.purchase_date),
    purchase_cost: input.purchase_cost,
    retail_price: input.retail_price,
    daily_rate: input.daily_rate,
    skill_level_id: input.skill_level_id,
    home_store_id: input.home_store_id,
    current_store_id: input.current_store_id,
  }
}

/**
 * 设备写操作「必填 / 枚举」基础校验（local / cloud 两路在写入前共用）：
 * - 日租金必填：null/undefined 视为「未填写」→ 必填错误；NaN/Infinity/负数 → 非法数值错误；显式 0 合法；
 * - 类别必须是六种合法枚举之一（运行时校验，不依赖 TS 类型 / 页面 Select / 数据库 CHECK）。
 * 供 validateItemFields（cloud）与 useMasterData localRun（local）复用，保证两路同口径必填语义。
 */
export function validateItemBasics(
  input: RentalItemCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (input.daily_rate == null) {
    return { ok: false, error: '日租金不能为空', field: 'daily_rate' }
  }
  if (!isFiniteNonNegative(input.daily_rate)) {
    return { ok: false, error: '日租金需为非负数值', field: 'daily_rate' }
  }
  if (!ITEM_CATEGORIES.includes(input.category)) {
    return { ok: false, error: '类别不合法', field: 'category' }
  }
  return { ok: true }
}

/**
 * 设备字段校验（与 DataService.validateItemInput 同口径的静态校验，但不做 item_code 查重 ——
 * 唯一性交由数据库 23505 兜底；含外键存在性预校验 storeIds/levelIds）。
 * 返回字段级错误，供页面精确提示。
 */
export function validateItemFields(
  input: RentalItemCloudInput,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
): { ok: true } | { ok: false; error: string; field: string } {
  const basics = validateItemBasics(input)
  if (!basics.ok) return basics
  if (!input.item_code.trim()) {
    return { ok: false, error: '库存编号不能为空', field: 'item_code' }
  }
  if (!input.name.trim()) {
    return { ok: false, error: '名称不能为空', field: 'name' }
  }
  // purchase_cost / retail_price 可空，非空时须非负
  if (input.purchase_cost !== null && !isFiniteNonNegative(input.purchase_cost)) {
    return { ok: false, error: '购入成本需为非负数值', field: 'purchase_cost' }
  }
  if (input.retail_price !== null && !isFiniteNonNegative(input.retail_price)) {
    return { ok: false, error: '零售价需为非负数值', field: 'retail_price' }
  }
  // purchase_date 可空，非空必须严格 YYYY-MM-DD 真实日期
  if (parseOptionalDate(input.purchase_date) === 'INVALID') {
    return { ok: false, error: '购入日期需为 YYYY-MM-DD 的真实日期', field: 'purchase_date' }
  }
  // home/current store 必填 + 外键存在性
  if (!isPositiveSafeInt(input.home_store_id)) {
    return { ok: false, error: '归属门店不能为空', field: 'home_store_id' }
  }
  if (!isPositiveSafeInt(input.current_store_id)) {
    return { ok: false, error: '当前门店不能为空', field: 'current_store_id' }
  }
  if (!storeIds.has(input.home_store_id)) {
    return { ok: false, error: '归属门店不存在', field: 'home_store_id' }
  }
  if (!storeIds.has(input.current_store_id)) {
    return { ok: false, error: '当前门店不存在', field: 'current_store_id' }
  }
  // 技能等级：配件强制 null；非配件非空时必须为有效外键
  const isAccessory = (ACCESSORY_CATEGORIES as readonly ItemCategory[]).includes(input.category)
  if (isAccessory && input.skill_level_id !== null) {
    return { ok: false, error: '护目镜、头盔等配件不设技能等级', field: 'skill_level_id' }
  }
  if (!isAccessory && input.skill_level_id !== null) {
    if (!isPositiveSafeInt(input.skill_level_id) || !levelIds.has(input.skill_level_id)) {
      return { ok: false, error: '技能等级不存在', field: 'skill_level_id' }
    }
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
 * 把 SDK / PostgreSQL 错误映射为安全业务提示，绝不泄露底层细节。
 * - 23505 unique_violation → 库存编号唯一冲突（item_code 数据库 UNIQUE，区分大小写）；
 * - 23503 foreign_key_violation → 写（create/update）为门店或技能等级不存在；删为设备被引用；
 * - 23514 check_violation → 字段或配件技能等级规则不合法；
 * - 42501 insufficient_privilege / RLS 拒绝 → 无权限；
 * - 其余 → 统一安全文案。
 */
function mapMutationError(
  error: unknown,
  mode: 'write' | 'delete',
): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23505') {
    return { ok: false, error: ITEM_CODE_CONFLICT_ERROR, field: 'item_code' }
  }
  if (code === '23503') {
    return { ok: false, error: mode === 'delete' ? ITEM_REFERENCED_ERROR : ITEM_REFERENCE_MISSING_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: ITEM_CHECK_VIOLATION_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: '无权限执行该操作' }
  }
  return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
}

// ---------------------------------------------------------------------------
// 影响行数落地：写操作返回的 data 应为恰好 1 行的数组
// ---------------------------------------------------------------------------

/** 从写操作返回的 data 解析出唯一受影响设备；失败 / 非法 / 状态不符一律 fail-closed */
function settleReturnedItem(
  data: unknown,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
  requireStatus?: ItemStatus,
): { ok: true; item: RentalItemView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudRentalItems(data as CloudRentalItemRow[], storeIds, levelIds)
  if (!mapped.ok || mapped.items.length !== 1) return { ok: false }
  if (requireStatus !== undefined && mapped.items[0].status !== requireStatus) return { ok: false }
  return { ok: true, item: mapped.items[0] }
}

// ---------------------------------------------------------------------------
// 云端设备写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/**
 * 云端新增设备：insert + select 精确列；影响行数恰好 1 且返回状态为「在库」才成功。
 * status 由数据库 DEFAULT '在库' 生成（列级 ACL 不含 status），此处校验而非客户端伪造。
 */
export async function createItem(
  rdb: ItemRdbMutationClient,
  input: RentalItemCloudInput,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
): Promise<OpResult<RentalItemView>> {
  const v = validateItemFields(input, storeIds, levelIds)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildItemPayload(input)
  try {
    const { data, error } = await rdb
      .from('rental_items')
      .insert(payload)
      .select(RENTAL_ITEM_SELECT_COLUMNS)
    if (error) return mapMutationError(error, 'write')
    const settled = settleReturnedItem(data, storeIds, levelIds, '在库')
    if (!settled.ok) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    return { ok: true, data: settled.item }
  } catch {
    return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
  }
}

/**
 * 云端编辑设备：update + eq(item_id) + select；item_id 需正安全整数，影响行数恰好 1。
 * payload 不含 status，返回行 status 为数据库真实状态，绝不客户端伪造。
 */
export async function updateItem(
  rdb: ItemRdbMutationClient,
  itemId: number,
  input: RentalItemCloudInput,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
): Promise<OpResult<RentalItemView>> {
  if (!isPositiveSafeInt(itemId)) {
    return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
  }
  const v = validateItemFields(input, storeIds, levelIds)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildItemPayload(input)
  try {
    const { data, error } = await rdb
      .from('rental_items')
      .update(payload)
      .eq('item_id', itemId)
      .select(RENTAL_ITEM_SELECT_COLUMNS)
    if (error) return mapMutationError(error, 'write')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: ITEM_UPDATE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    const settled = settleReturnedItem(data, storeIds, levelIds)
    if (!settled.ok) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    return { ok: true, data: settled.item }
  } catch {
    return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
  }
}

/**
 * 云端删除设备：delete + eq(item_id) + select；item_id 需正安全整数，影响行数恰好 1。
 * 0 行语义（设备不存在 / 状态已变化 / 无权限，均被 RLS USING 收敛为 0 行）统一安全提示。
 */
export async function removeItem(
  rdb: ItemRdbMutationClient,
  itemId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(itemId)) {
    return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('rental_items')
      .delete()
      .eq('item_id', itemId)
      .select(RENTAL_ITEM_SELECT_COLUMNS)
    if (error) return mapMutationError(error, 'delete')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: ITEM_DELETE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_ITEM_WRITE_ERROR }
  }
}
