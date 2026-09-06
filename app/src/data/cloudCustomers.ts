/**
 * 云端客户只读查询的纯逻辑层（可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 * - 数值字段归一化为 number（云端 numeric/integer 可能返回 string）；
 * - customer_id 非法 / 重复主键 / 字段类型异常 → fail-closed，返回安全错误；
 * - 查询失败绝不回退 localStorage，不返回本地数据。
 */
import type { Customer } from './types'

/** 云端 customers 行（数值字段可能为 string） */
export interface CloudCustomerRow {
  customer_id: number | string | null | undefined
  full_name: string
  address: string
  phone: string
  email: string | null
  birth_year: number | string | null | undefined
  height_cm: number | string | null | undefined
  weight_kg: number | string | null | undefined
  shoe_size: number | string | null | undefined
}

export type CloudReadResult =
  | { ok: true; customers: Customer[] }
  | { ok: false; error: string }

/** 安全错误文案（不包含底层错误细节 / 数据值） */
export const SAFE_CLOUD_ERROR = '客户数据加载失败'

/** 解析 nullable 数值：null/空 → null；非法（NaN/Infinity/非数值）→ INVALID */
function parseNullableNumber(
  v: number | string | null | undefined,
): number | null | 'INVALID' {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 'INVALID'
  return n
}

/** 解析 customer_id：必须是正整数，否则 INVALID */
function parseCustomerId(v: number | string | null | undefined): number | 'INVALID' {
  if (v === null || v === undefined || v === '') return 'INVALID'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n <= 0) return 'INVALID'
  return n
}

/** 单行映射：字段异常时 fail-closed（返回错误） */
function mapRow(
  row: CloudCustomerRow,
): { ok: true; customer: Customer } | { ok: false; error: string } {
  if (typeof row !== 'object' || row === null) return { ok: false, error: SAFE_CLOUD_ERROR }

  const customer_id = parseCustomerId(row.customer_id)
  if (customer_id === 'INVALID') return { ok: false, error: SAFE_CLOUD_ERROR }

  if (
    typeof row.full_name !== 'string' ||
    typeof row.address !== 'string' ||
    typeof row.phone !== 'string'
  ) {
    return { ok: false, error: SAFE_CLOUD_ERROR }
  }

  if (row.email !== null && row.email !== undefined && typeof row.email !== 'string') {
    return { ok: false, error: SAFE_CLOUD_ERROR }
  }
  const email = row.email == null ? null : row.email

  const birth_year = parseNullableNumber(row.birth_year)
  if (birth_year === 'INVALID') return { ok: false, error: SAFE_CLOUD_ERROR }
  if (birth_year !== null && !Number.isInteger(birth_year)) {
    return { ok: false, error: SAFE_CLOUD_ERROR }
  }

  const height_cm = parseNullableNumber(row.height_cm)
  if (height_cm === 'INVALID') return { ok: false, error: SAFE_CLOUD_ERROR }
  const weight_kg = parseNullableNumber(row.weight_kg)
  if (weight_kg === 'INVALID') return { ok: false, error: SAFE_CLOUD_ERROR }
  const shoe_size = parseNullableNumber(row.shoe_size)
  if (shoe_size === 'INVALID') return { ok: false, error: SAFE_CLOUD_ERROR }

  return {
    ok: true,
    customer: {
      customer_id,
      full_name: row.full_name,
      address: row.address,
      phone: row.phone,
      email,
      birth_year,
      height_cm,
      weight_kg,
      shoe_size,
    },
  }
}

/**
 * 批量映射：逐行校验 + 重复主键拒绝 + 按 customer_id 升序稳定排序。
 */
export function mapCloudCustomers(rows: CloudCustomerRow[]): CloudReadResult {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_CLOUD_ERROR }
  const customers: Customer[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    const r = mapRow(row)
    if (!r.ok) return { ok: false, error: r.error }
    if (seen.has(r.customer.customer_id)) {
      return { ok: false, error: SAFE_CLOUD_ERROR }
    }
    seen.add(r.customer.customer_id)
    customers.push(r.customer)
  }
  customers.sort((a, b) => a.customer_id - b.customer_id)
  return { ok: true, customers }
}

/**
 * 将 SDK 返回（data, error）转成安全的 CloudReadResult：
 * - 有 error → 安全错误（不泄露底层细节）；
 * - 无 error → 走 mapCloudCustomers 归一化。
 */
export function toCloudReadResult(
  data: unknown,
  error: unknown,
): CloudReadResult {
  if (error) return { ok: false, error: SAFE_CLOUD_ERROR }
  return mapCloudCustomers((data ?? []) as CloudCustomerRow[])
}

/** 客户查询所需的最小 RDB 查询构造器（可注入 fake client 供 Node 单测） */
export interface CustomerQueryBuilder {
  select(columns: string): CustomerQueryBuilder
  order(
    column: string,
    opts: { ascending: boolean },
  ): Promise<{ data: unknown; error: unknown }>
}

/** 客户查询所需的最小 RDB 客户端 */
export interface CustomerRdbClient {
  from(table: string): CustomerQueryBuilder
}

/** 客户查询精确列（9 列，绝不用 select('*')） */
export const CUSTOMER_SELECT_COLUMNS =
  'customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size'

/**
 * 云端客户查询执行器（可注入 RDB 客户端，便于 Node 用 fake client 验证查询构造与错误处理）：
 * - from('customers')；
 * - select 精确 9 列（非 '*'）；
 * - order('customer_id', { ascending: true })；
 * - SDK 返回 error / 抛异常 → 统一安全错误，绝不回退本地。
 */
export async function queryCustomers(rdb: CustomerRdbClient): Promise<CloudReadResult> {
  try {
    const { data, error } = await rdb
      .from('customers')
      .select(CUSTOMER_SELECT_COLUMNS)
      .order('customer_id', { ascending: true })
    return toCloudReadResult(data, error)
  } catch {
    return { ok: false, error: SAFE_CLOUD_ERROR }
  }
}
