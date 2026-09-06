/**
 * 云端客户写操作（create/update/remove）的纯逻辑层（可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点：
 * - 复用既有客户字段语义与校验规则（与 DataService.validateCustomerInput 同口径：
 *   姓名/地址/电话非空、出生年份 1900–2100、身高 30–260、体重 5–300、鞋码 15–55）；
 *   邮箱唯一性不由客户端预检，交由数据库 uq_customers_email_ci 兜底（23505 → 业务提示）。
 * - payload 仅含业务字段，绝不写入 customer_id / role / uid / account_id 等越权字段；
 *   权限最终由 CloudBase Auth session + PostgreSQL RLS 决定，前端 role 仅用于隐藏按钮。
 * - update/delete 用经过正安全整数校验的 customer_id 精确 eq 过滤；
 * - 显式列名（CUSTOMER_SELECT_COLUMNS），绝不用 select('*')；
 * - 影响行数恰好为 1：0 行视为失败、超过 1 行 fail-closed；
 * - 统一安全错误映射：邮箱唯一冲突 / 客户被合同引用 / 无权限 / 其他，不泄露 SQL、表结构、
 *   原始异常、Token 或请求细节；
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 */
import type { Customer, CustomerInput, OpResult } from './types'
import { CUSTOMER_SELECT_COLUMNS, mapCloudCustomers, type CloudCustomerRow } from './cloudCustomers'

/** 客户写操作统一安全错误（不包含底层细节） */
export const SAFE_CUSTOMER_WRITE_ERROR = '客户操作失败，请稍后重试'

/** 删除被合同引用时的明确业务提示（与 DataService.removeCustomer 文案对齐） */
export const CUSTOMER_REFERENCED_ERROR = '客户已有租赁合同，无法删除'

/** 邮箱唯一冲突业务提示（与 DataService 查重文案对齐） */
export const CUSTOMER_EMAIL_CONFLICT_ERROR = '该邮箱已被其他客户使用'

/** 更新/删除目标不存在的业务提示（与 DataService 文案对齐） */
export const CUSTOMER_NOT_FOUND_ERROR = '客户不存在，可能已被删除'

// ---------------------------------------------------------------------------
// 可注入的最小 RDB 写客户端（Node 可用 fake client 验证 insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------

/** 写查询结果（真实 SDK 为 PostgrestSingleResponse：data + error{code,message,details,hint}） */
export interface CustomerMutationResponse {
  data: unknown
  error: unknown
}

/** 写过滤/变换构造器（thenable，可 await；支持 .eq / .select 链式） */
export interface CustomerMutationBuilder extends PromiseLike<CustomerMutationResponse> {
  eq(column: string, value: unknown): CustomerMutationBuilder
  select(columns: string): CustomerMutationBuilder
}

/** 写查询构造器（from().insert / update / delete） */
export interface CustomerMutationQueryBuilder {
  insert(values: Record<string, unknown>): CustomerMutationBuilder
  update(values: Record<string, unknown>): CustomerMutationBuilder
  delete(): CustomerMutationBuilder
}

/** 客户写操作所需的最小 RDB 客户端 */
export interface CustomerRdbMutationClient {
  from(table: string): CustomerMutationQueryBuilder
}

// ---------------------------------------------------------------------------
// 输入归一化（与 DataService 同口径）
// ---------------------------------------------------------------------------

/** 邮箱规范化：trim 后空串视为 null */
function normalizeEmail(email: string | null): string | null {
  if (email === null) return null
  const v = email.trim()
  return v === '' ? null : v
}

/** 可空数值：null/NaN → null，否则保留 number（与 DataService.toNullableNumber 一致） */
function toNullableNumber(value: number | null): number | null {
  if (value === null) return null
  if (Number.isNaN(value)) return null
  return value
}

/** 数值范围校验：null 视为通过；NaN/超界返回 false（与 DataService.inRange 一致） */
function inRange(value: number | null, min: number, max: number): boolean {
  if (value === null) return true
  if (Number.isNaN(value)) return false
  return value >= min && value <= max
}

/** 正安全整数校验（update/delete 的 customer_id 精确过滤前必须通过） */
export function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/**
 * 构造客户写 payload：仅业务字段，trim + null 归一化，
 * 绝不包含 customer_id / role / uid / account_id / actorRole 等越权字段。
 */
export function buildCustomerPayload(input: CustomerInput): Record<string, unknown> {
  return {
    full_name: input.full_name.trim(),
    address: input.address.trim(),
    phone: input.phone.trim(),
    email: normalizeEmail(input.email),
    birth_year: toNullableNumber(input.birth_year),
    height_cm: toNullableNumber(input.height_cm),
    weight_kg: toNullableNumber(input.weight_kg),
    shoe_size: toNullableNumber(input.shoe_size),
  }
}

/** 客户字段校验（与 DataService.validateCustomerInput 静态校验同口径，不含邮箱查重）。 */
export function validateCustomerFields(
  input: CustomerInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!input.full_name.trim()) {
    return { ok: false, error: '姓名不能为空', field: 'full_name' }
  }
  if (!input.address.trim()) {
    return { ok: false, error: '地址不能为空', field: 'address' }
  }
  if (!input.phone.trim()) {
    return { ok: false, error: '电话不能为空', field: 'phone' }
  }
  const birth = input.birth_year
  // 出生年份：null 或 1900–2100 之间的有限整数（Number.isInteger 同时拒绝小数、NaN、±Infinity 与字符串，
  // 不依赖 PostgreSQL 隐式类型转换来处理小数）。
  if (birth !== null && (!Number.isInteger(birth) || birth < 1900 || birth > 2100)) {
    return { ok: false, error: '出生年份需为 1900–2100 之间的整数', field: 'birth_year' }
  }
  if (!inRange(input.height_cm, 30, 260)) {
    return { ok: false, error: '身高需为 30–260 之间的数值', field: 'height_cm' }
  }
  if (!inRange(input.weight_kg, 5, 300)) {
    return { ok: false, error: '体重需为 5–300 之间的数值', field: 'weight_kg' }
  }
  if (!inRange(input.shoe_size, 15, 55)) {
    return { ok: false, error: '鞋码需为 15–55 之间的数值', field: 'shoe_size' }
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
 * - 23505 unique_violation → 邮箱唯一冲突（customers 唯一业务键只有 email）；
 * - 23503 foreign_key_violation → 客户被合同引用（customers 仅被 rental_contracts.customer_id 引用）；
 * - 42501 insufficient_privilege / RLS 拒绝 → 无权限；
 * - 其余 → 统一安全文案。
 */
function mapMutationError(error: unknown): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23505') {
    return { ok: false, error: CUSTOMER_EMAIL_CONFLICT_ERROR, field: 'email' }
  }
  if (code === '23503') {
    return { ok: false, error: CUSTOMER_REFERENCED_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: '无权限执行该操作' }
  }
  return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
}

// ---------------------------------------------------------------------------
// 影响行数落地：写操作返回的 data 应为恰好 1 行的数组
// ---------------------------------------------------------------------------

/** 从写操作返回的 data 解析出唯一受影响客户；失败 / 非法一律 fail-closed */
function settleReturnedRows(data: unknown): { ok: true; customer: Customer } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudCustomers(data as CloudCustomerRow[])
  if (!mapped.ok || mapped.customers.length !== 1) return { ok: false }
  return { ok: true, customer: mapped.customers[0] }
}

// ---------------------------------------------------------------------------
// 云端客户写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/** 云端新增客户：insert + select 精确列；影响行数恰好 1 才成功 */
export async function createCustomer(
  rdb: CustomerRdbMutationClient,
  input: CustomerInput,
): Promise<OpResult<Customer>> {
  const v = validateCustomerFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildCustomerPayload(input)
  try {
    const { data, error } = await rdb
      .from('customers')
      .insert(payload)
      .select(CUSTOMER_SELECT_COLUMNS)
    if (error) return mapMutationError(error)
    const settled = settleReturnedRows(data)
    if (!settled.ok) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    return { ok: true, data: settled.customer }
  } catch {
    return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
  }
}

/** 云端编辑客户：update + eq(customer_id) + select；customer_id 需正安全整数，影响行数恰好 1 */
export async function updateCustomer(
  rdb: CustomerRdbMutationClient,
  customerId: number,
  input: CustomerInput,
): Promise<OpResult<Customer>> {
  if (!isPositiveSafeInt(customerId)) {
    return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
  }
  const v = validateCustomerFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildCustomerPayload(input)
  try {
    const { data, error } = await rdb
      .from('customers')
      .update(payload)
      .eq('customer_id', customerId)
      .select(CUSTOMER_SELECT_COLUMNS)
    if (error) return mapMutationError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: CUSTOMER_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    const settled = settleReturnedRows(data)
    if (!settled.ok) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    return { ok: true, data: settled.customer }
  } catch {
    return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
  }
}

/** 云端删除客户：delete + eq(customer_id) + select；customer_id 需正安全整数，影响行数恰好 1 */
export async function removeCustomer(
  rdb: CustomerRdbMutationClient,
  customerId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(customerId)) {
    return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('customers')
      .delete()
      .eq('customer_id', customerId)
      .select(CUSTOMER_SELECT_COLUMNS)
    if (error) return mapMutationError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: CUSTOMER_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
  }
}
