/**
 * 云端门店（stores）写操作（create/update/remove）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudItemMutations 同级别的安全边界）：
 * - 复用 cloudMaster 的门店行映射 / 精确列查询，保证写后返回行与列表视图
 *   使用同一套映射（mapCloudStores → StoreView）；
 * - payload 仅含业务字段（store_name / address / phone），绝不写入 store_id /
 *   role / uid / account_id / actorRole 等越权字段；store_id 由数据库 identity 生成；
 * - update/delete 用经过正安全整数校验的 store_id 精确 eq 过滤；
 * - 显式列名（STORE_SELECT_COLUMNS），绝不用 select('*')；
 * - 影响行数恰好为 1：0 行视为失败（update/delete 语义不同）、超过 1 行 fail-closed；
 * - 统一安全错误映射：删除被引用（23503）/ CHECK 违例（23514）/ 无权限（42501）/ 其他，
 *   不泄露 SQL、表名、约束名、原始 details/hint、Token；
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 *
 * nullable 与 local/cloud 输入边界：
 * - 数据库 address / phone 可空（varchar，无 btrim 约束），store_name 非空（varchar(50)，
 *   CHECK btrim<>''）且 **无 UNIQUE 约束**（真实核验确认），故本模块**不做**客户端查重、
 *   不映射 23505「名称重复」——唯一性语义不存在，不虚构。
 * - 本模块输入采用 cloud 专用可空类型 StoreCloudInput（address/phone 可空），
 *   与 local 的非空 StoreInput 明确区分；local 转换边界见 masterDataSource.toLocalStoreInput。
 */
import type { OpResult } from './types'
import {
  STORE_SELECT_COLUMNS,
  mapCloudStores,
  type StoreView,
  type CloudStoreRow,
} from './cloudMaster'

/** 门店写操作统一安全错误（不包含底层细节） */
export const SAFE_STORE_WRITE_ERROR = '门店操作失败，请稍后重试'

/** delete 被引用（23503）：门店已被设备、排班或合同记录引用 */
export const STORE_REFERENCED_ERROR = '门店已被设备、排班或合同记录引用，无法删除'

/** CHECK 违例（23514）：门店信息不符合规则 */
export const STORE_CHECK_VIOLATION_ERROR = '门店信息不符合规则'

/** update 0 行：门店不存在或无权限 */
export const STORE_UPDATE_NOT_FOUND_ERROR = '门店不存在或无权限'

/** delete 0 行：门店不存在或无权限 */
export const STORE_DELETE_NOT_FOUND_ERROR = '门店不存在或无权限'

/** 无权限（42501） */
export const STORE_PERMISSION_ERROR = '无权限执行该操作'

/** varchar 长度上限（真实数据库核验） */
const STORE_NAME_MAX = 50
const ADDRESS_MAX = 200
const PHONE_MAX = 20

/**
 * 门店云端输入（可空字段显式建模，与 local 非空 StoreInput 明确区分）：
 * address / phone 均可为 null。
 */
export interface StoreCloudInput {
  store_name: string
  address: string | null
  phone: string | null
}

// ---------------------------------------------------------------------------
// 可注入的最小 RDB 写客户端（Node 可用 fake client 验证 insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------

/** 写查询结果（真实 SDK 为 PostgrestSingleResponse：data + error{code,message,details,hint}） */
export interface StoreMutationResponse {
  data: unknown
  error: unknown
}

/** 写过滤/变换构造器（thenable，可 await；支持 .eq / .select 链式） */
export interface StoreMutationBuilder extends PromiseLike<StoreMutationResponse> {
  eq(column: string, value: unknown): StoreMutationBuilder
  select(columns: string): StoreMutationBuilder
}

/** 写查询构造器（from().insert / update / delete） */
export interface StoreMutationQueryBuilder {
  insert(values: Record<string, unknown>): StoreMutationBuilder
  update(values: Record<string, unknown>): StoreMutationBuilder
  delete(): StoreMutationBuilder
}

/** 门店写操作所需的最小 RDB 客户端 */
export interface StoreRdbMutationClient {
  from(table: string): StoreMutationQueryBuilder
}

// ---------------------------------------------------------------------------
// 输入归一化与校验
// ---------------------------------------------------------------------------

/** 正安全整数校验（store_id 精确过滤前必须通过） */
export function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/** 可空文本归一化：null → null；trim 后空串 → null；否则 trim 保留（空值写 null，不写虚构文本） */
function normalizeOptionalText(v: string | null): string | null {
  if (v === null) return null
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * 构造门店写 payload：仅业务字段，trim + 空值归一化为 null，
 * 绝不包含 store_id / role / uid / account_id / actorRole 等越权字段。
 */
export function buildStorePayload(input: StoreCloudInput): Record<string, unknown> {
  return {
    store_name: input.store_name.trim(),
    address: normalizeOptionalText(input.address),
    phone: normalizeOptionalText(input.phone),
  }
}

/**
 * 门店字段校验（运行时类型校验 + 真实 varchar 长度校验，不依赖 TypeScript）：
 * - store_name：必须为 string、trim 后非空、trim 后长度 ≤ 50；
 * - address：可空；非空必须为 string 且 trim 后长度 ≤ 200；
 * - phone：可空；非空必须为 string 且 trim 后长度 ≤ 20。
 * 返回字段级错误，供页面精确提示。
 */
export function validateStoreFields(
  input: StoreCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (typeof input.store_name !== 'string' || input.store_name.trim() === '') {
    return { ok: false, error: '门店名称不能为空', field: 'store_name' }
  }
  if (input.store_name.trim().length > STORE_NAME_MAX) {
    return { ok: false, error: `门店名称不能超过 ${STORE_NAME_MAX} 个字符`, field: 'store_name' }
  }
  if (input.address !== null) {
    if (typeof input.address !== 'string') {
      return { ok: false, error: '地址格式不正确', field: 'address' }
    }
    if (input.address.trim().length > ADDRESS_MAX) {
      return { ok: false, error: `地址不能超过 ${ADDRESS_MAX} 个字符`, field: 'address' }
    }
  }
  if (input.phone !== null) {
    if (typeof input.phone !== 'string') {
      return { ok: false, error: '电话格式不正确', field: 'phone' }
    }
    if (input.phone.trim().length > PHONE_MAX) {
      return { ok: false, error: `电话不能超过 ${PHONE_MAX} 个字符`, field: 'phone' }
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
 * - 23503 foreign_key_violation → 门店被设备、排班或合同记录引用（仅 delete 会触发）；
 * - 23514 check_violation → 门店信息不符合规则；
 * - 42501 insufficient_privilege / RLS 拒绝 → 无权限；
 * - 其余 → 统一安全文案。
 * 注意：真实数据库 stores.store_name 无 UNIQUE 约束，故不映射 23505（不虚构「名称重复」）。
 */
function mapStoreError(
  error: unknown,
): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23503') {
    return { ok: false, error: STORE_REFERENCED_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: STORE_CHECK_VIOLATION_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: STORE_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_STORE_WRITE_ERROR }
}

// ---------------------------------------------------------------------------
// 影响行数落地：写操作返回的 data 应为恰好 1 行的数组
// ---------------------------------------------------------------------------

/** 从写操作返回的 data 解析出唯一受影响门店；失败 / 非法一律 fail-closed */
function settleReturnedStore(
  data: unknown,
): { ok: true; store: StoreView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudStores(data as CloudStoreRow[])
  if (!mapped.ok || mapped.stores.length !== 1) return { ok: false }
  return { ok: true, store: mapped.stores[0] }
}

// ---------------------------------------------------------------------------
// 云端门店写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/**
 * 云端新增门店：insert + select 精确列；影响行数恰好 1 才成功。
 * store_id 由数据库 identity 自动生成（payload 不含 store_id）。
 */
export async function createStore(
  rdb: StoreRdbMutationClient,
  input: StoreCloudInput,
): Promise<OpResult<StoreView>> {
  const v = validateStoreFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildStorePayload(input)
  try {
    const { data, error } = await rdb
      .from('stores')
      .insert(payload)
      .select(STORE_SELECT_COLUMNS)
    if (error) return mapStoreError(error)
    const settled = settleReturnedStore(data)
    if (!settled.ok) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    return { ok: true, data: settled.store }
  } catch {
    return { ok: false, error: SAFE_STORE_WRITE_ERROR }
  }
}

/**
 * 云端编辑门店：update + eq(store_id) + select；store_id 需正安全整数，影响行数恰好 1。
 */
export async function updateStore(
  rdb: StoreRdbMutationClient,
  storeId: number,
  input: StoreCloudInput,
): Promise<OpResult<StoreView>> {
  if (!isPositiveSafeInt(storeId)) {
    return { ok: false, error: SAFE_STORE_WRITE_ERROR }
  }
  const v = validateStoreFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildStorePayload(input)
  try {
    const { data, error } = await rdb
      .from('stores')
      .update(payload)
      .eq('store_id', storeId)
      .select(STORE_SELECT_COLUMNS)
    if (error) return mapStoreError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: STORE_UPDATE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    const settled = settleReturnedStore(data)
    if (!settled.ok) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    return { ok: true, data: settled.store }
  } catch {
    return { ok: false, error: SAFE_STORE_WRITE_ERROR }
  }
}

/**
 * 云端删除门店：delete + eq(store_id) + select；store_id 需正安全整数，影响行数恰好 1。
 * 0 行语义（门店不存在 / 无权限，均被 RLS USING 收敛为 0 行）统一安全提示。
 * 被引用（23503：设备/排班/合同外键）→ 无法删除提示。
 */
export async function removeStore(
  rdb: StoreRdbMutationClient,
  storeId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(storeId)) {
    return { ok: false, error: SAFE_STORE_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('stores')
      .delete()
      .eq('store_id', storeId)
      .select(STORE_SELECT_COLUMNS)
    if (error) return mapStoreError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: STORE_DELETE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_STORE_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_STORE_WRITE_ERROR }
  }
}
