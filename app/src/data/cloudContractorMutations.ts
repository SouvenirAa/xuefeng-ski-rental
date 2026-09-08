/**
 * 云端「承包商 / 承包商费率」写操作（create/update/remove）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudStoreMutations / cloudCustomerMutations 同级别的安全边界）：
 * - 复用 cloudContractors 的行映射 / 严格日期校验 / 精确列查询，保证写后返回行与列表视图
 *   使用同一套映射（mapCloudContractors / mapContractorRateRow）；
 * - payload 仅含业务字段，绝不写入 contractor_id / rate_id / role / uid / account_id /
 *   actorRole 等越权字段；contractor_id / rate_id 由数据库 identity 自动生成；
 * - update/delete 用经过正安全整数校验的 contractor_id / rate_id 精确 eq 过滤；
 * - 显式列名（CONTRACTOR_SELECT_COLUMNS / RATE_SELECT_COLUMNS），绝不用 select('*')；
 * - 影响行数恰好为 1：0 行视为失败（update/delete 语义不同）、超过 1 行 fail-closed；
 * - 统一安全错误映射：承包商被引用（23503）/ 费率日期唯一冲突（23505）/ 费率承包商不存在
 *   （23503）/ 费率已被维修单引用（触发器 P0001）/ CHECK 违例（23514）/ 无权限（42501）/ 其他，
 *   不泄露 SQL、表名、约束名、原始 details/hint、Token；
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 *
 * nullable 与 local/cloud 输入边界（关键差异，不虚假声称与 local 一致）：
 * - 数据库 contractors.name 非空（varchar(80) CHECK btrim<>''）且 **无 UNIQUE 约束**（真实核验确认），
 *   故承包商写操作**不做**客户端查重、不映射 23505「名称重复」——唯一性语义不存在，不虚构；
 * - 数据库 contractors.address / phone / email 可空（varchar，无 btrim 约束），故本模块输入采用
 *   cloud 专用可空类型 ContractorCloudInput（address/phone/email 可空），与 local 的非空
 *   ContractorInput 明确区分；local 转换边界见 contractorDataSource.toLocalContractorInput；
 * - contractor_rates 有 UNIQUE(contractor_id, effective_date)：费率 23505 映射为「费率日期冲突」；
 * - contractor_rates 的 protect_contractor_rate 触发器（BEFORE UPDATE OR DELETE）对已被
 *   repair_orders.rate_id 引用的费率 RAISE EXCEPTION（SQLSTATE P0001），映射为「不可修改或删除」。
 */
import type { OpResult } from './types'
import {
  CONTRACTOR_SELECT_COLUMNS,
  RATE_SELECT_COLUMNS,
  mapCloudContractors,
  mapContractorRateRow,
  type ContractorView,
  type ContractorRateView,
  type CloudContractorRow,
  type CloudContractorRateRow,
} from './cloudContractors'
import { parseOptionalDate } from './cloudMaster'

// ---------------------------------------------------------------------------
// 安全错误文案（不泄露底层细节）
// ---------------------------------------------------------------------------

/** 承包商写操作统一安全错误 */
export const SAFE_CONTRACTOR_WRITE_ERROR = '承包商操作失败，请稍后重试'

/** 承包商删除被引用（23503）：被账号 / 费率 / 维修单外键引用 */
export const CONTRACTOR_REFERENCED_ERROR = '该承包商已被账号、费率或维修单引用，无法删除'

/** 承包商 CHECK 违例（23514） */
export const CONTRACTOR_CHECK_VIOLATION_ERROR = '承包商信息不符合规则'

/** 承包商 update 0 行：不存在或无权限 */
export const CONTRACTOR_UPDATE_NOT_FOUND_ERROR = '承包商不存在或无权限'

/** 承包商 delete 0 行：不存在或无权限 */
export const CONTRACTOR_DELETE_NOT_FOUND_ERROR = '承包商不存在或无权限'

/** 承包商无权限（42501） */
export const CONTRACTOR_PERMISSION_ERROR = '无权限执行该操作'

/** 费率写操作统一安全错误 */
export const SAFE_RATE_WRITE_ERROR = '费率操作失败，请稍后重试'

/** 费率日期唯一冲突（23505）：同承包商同日已存在费率 */
export const RATE_DATE_CONFLICT_ERROR = '该承包商在该生效日期已存在费率'

/** 费率 create 承包商不存在（23503）：contractor_id 外键不存在 */
export const RATE_REFERENCE_MISSING_ERROR = '承包商不存在'

/** 费率已被维修单引用（protect_contractor_rate 触发器 P0001）：不可修改或删除 */
export const RATE_REFERENCED_ERROR = '该费率已被维修单引用，不可修改或删除'

/** 费率 CHECK 违例（23514）：hourly_rate 必须大于 0 */
export const RATE_CHECK_VIOLATION_ERROR = '费率信息不符合规则'

/** 费率 update 0 行：不存在或无权限 */
export const RATE_UPDATE_NOT_FOUND_ERROR = '费率不存在或无权限'

/** 费率 delete 0 行：不存在或无权限 */
export const RATE_DELETE_NOT_FOUND_ERROR = '费率不存在或无权限'

/** 费率无权限（42501） */
export const RATE_PERMISSION_ERROR = '无权限执行该操作'

// ---------------------------------------------------------------------------
// varchar 长度上限（真实数据库核验）
// ---------------------------------------------------------------------------
const NAME_MAX = 80
const ADDRESS_MAX = 200
const PHONE_MAX = 20
const EMAIL_MAX = 100

/**
 * 承包商云端输入（可空字段显式建模，与 local 非空 ContractorInput 明确区分）：
 * address / phone / email 均可为 null。
 */
export interface ContractorCloudInput {
  name: string
  address: string | null
  phone: string | null
  email: string | null
}

/**
 * 承包商费率云端输入（rate_id / contractor_id 由服务端控制）：
 * - create：contractor_id 由调用方单独传入（页面从当前承包商取），effective_date / hourly_rate 为业务字段；
 * - update：仅改 effective_date / hourly_rate（contractor_id 由已有行保持，不写入 payload）。
 */
export interface ContractorRateCloudInput {
  effective_date: string
  hourly_rate: number
}

// ---------------------------------------------------------------------------
// 可注入的最小 RDB 写客户端（Node 可用 fake client 验证 insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------

/** 写查询结果（真实 SDK 为 PostgrestSingleResponse：data + error{code,message,details,hint}） */
export interface ContractorMutationResponse {
  data: unknown
  error: unknown
}

/** 写过滤/变换构造器（thenable，可 await；支持 .eq / .select 链式） */
export interface ContractorMutationBuilder extends PromiseLike<ContractorMutationResponse> {
  eq(column: string, value: unknown): ContractorMutationBuilder
  select(columns: string): ContractorMutationBuilder
}

/** 写查询构造器（from().insert / update / delete） */
export interface ContractorMutationQueryBuilder {
  insert(values: Record<string, unknown>): ContractorMutationBuilder
  update(values: Record<string, unknown>): ContractorMutationBuilder
  delete(): ContractorMutationBuilder
}

/** 承包商/费率写操作所需的最小 RDB 客户端 */
export interface ContractorRdbMutationClient {
  from(table: string): ContractorMutationQueryBuilder
}

// ---------------------------------------------------------------------------
// 输入归一化与校验
// ---------------------------------------------------------------------------

/** 正安全整数校验（contractor_id / rate_id 精确过滤前必须通过） */
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
 * 构造承包商写 payload：仅业务字段，trim + 空值归一化为 null，
 * 绝不包含 contractor_id / role / uid / account_id / actorRole 等越权字段。
 */
export function buildContractorPayload(input: ContractorCloudInput): Record<string, unknown> {
  return {
    name: input.name.trim(),
    address: normalizeOptionalText(input.address),
    phone: normalizeOptionalText(input.phone),
    email: normalizeOptionalText(input.email),
  }
}

/**
 * 构造费率 create payload：contractor_id（调用方传入的精确值）+ effective_date + hourly_rate，
 * 绝不包含 rate_id / role / uid / account_id 等越权字段（rate_id 由数据库 identity 生成）。
 */
export function buildRateCreatePayload(
  input: ContractorRateCloudInput,
  contractorId: number,
): Record<string, unknown> {
  return {
    contractor_id: contractorId,
    effective_date: input.effective_date,
    hourly_rate: input.hourly_rate,
  }
}

/**
 * 构造费率 update payload：仅 effective_date + hourly_rate，
 * 绝不包含 rate_id / contractor_id / role / uid / account_id 等越权字段
 * （contractor_id 由已有行保持，不可经 update 篡改费率归属）。
 */
export function buildRateUpdatePayload(input: ContractorRateCloudInput): Record<string, unknown> {
  return {
    effective_date: input.effective_date,
    hourly_rate: input.hourly_rate,
  }
}

/**
 * 承包商字段校验（运行时类型校验 + 真实 varchar 长度校验，不依赖 TypeScript）：
 * - name：必须为 string、trim 后非空、trim 后长度 ≤ 80；
 * - address：可空；非空必须为 string 且 trim 后长度 ≤ 200；
 * - phone：可空；非空必须为 string 且 trim 后长度 ≤ 20；
 * - email：可空；非空必须为 string 且 trim 后长度 ≤ 100。
 * 返回字段级错误，供页面精确提示。
 */
export function validateContractorFields(
  input: ContractorCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    return { ok: false, error: '承包商名称不能为空', field: 'name' }
  }
  if (input.name.trim().length > NAME_MAX) {
    return { ok: false, error: `承包商名称不能超过 ${NAME_MAX} 个字符`, field: 'name' }
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
  if (input.email !== null) {
    if (typeof input.email !== 'string') {
      return { ok: false, error: '邮箱格式不正确', field: 'email' }
    }
    if (input.email.trim().length > EMAIL_MAX) {
      return { ok: false, error: `邮箱不能超过 ${EMAIL_MAX} 个字符`, field: 'email' }
    }
  }
  return { ok: true }
}

/**
 * 费率字段校验：
 * - effective_date：必须为 string、严格 YYYY-MM-DD 且为真实存在的日期（2026-02-30 拒绝）；
 * - hourly_rate：必须为有限正数（> 0；NaN / ±Infinity / 0 / 负数 / 非 number 一律拒绝）。
 * 返回字段级错误，供页面精确提示。
 */
export function validateRateFields(
  input: ContractorRateCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (typeof input.effective_date !== 'string' || input.effective_date === '') {
    return { ok: false, error: '生效日期不能为空', field: 'effective_date' }
  }
  // parseOptionalDate 返回原字符串即代表「严格 YYYY-MM-DD 真实日期」；null 为空串；'INVALID' 为非法
  if (parseOptionalDate(input.effective_date) !== input.effective_date) {
    return { ok: false, error: '生效日期需为 YYYY-MM-DD 的真实日期', field: 'effective_date' }
  }
  if (typeof input.hourly_rate !== 'number' || !Number.isFinite(input.hourly_rate) || input.hourly_rate <= 0) {
    return { ok: false, error: '小时费率必须大于 0', field: 'hourly_rate' }
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
 * 承包商错误映射，绝不泄露底层细节。
 * - 23503 foreign_key_violation → 承包商被账号/费率/维修单引用（仅 delete 会触发）；
 * - 23514 check_violation → 承包商信息不符合规则；
 * - 42501 insufficient_privilege / RLS 拒绝 → 无权限；
 * - 其余 → 统一安全文案。
 * 注意：真实数据库 contractors.name 无 UNIQUE 约束，故不映射 23505（不虚构「名称重复」）。
 */
function mapContractorError(
  error: unknown,
): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23503') {
    return { ok: false, error: CONTRACTOR_REFERENCED_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: CONTRACTOR_CHECK_VIOLATION_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: CONTRACTOR_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
}

/**
 * 费率写操作类别（用于把 P0001 映射限制在 update/delete）。
 */
type RateOperation = 'create' | 'update' | 'delete'

/**
 * 费率错误映射，绝不泄露底层细节。
 * - 23505 unique_violation → 同承包商同日费率唯一冲突（UNIQUE(contractor_id, effective_date)）；
 * - 23503 foreign_key_violation → create 时 contractor_id 外键不存在；
 * - P0001（protect_contractor_rate 触发器 raise_exception）→ 费率已被维修单引用不可修改/删除；
 *   该触发器仅 BEFORE UPDATE OR DELETE，create 不触发，故 create 的 P0001 不得误报为「被冻结」，
 *   一律落入通用安全文案；
 * - 23514 check_violation → hourly_rate 必须大于 0；
 * - 42501 insufficient_privilege / RLS 拒绝 → 无权限；
 * - 其余 → 统一安全文案。
 */
function mapRateError(
  error: unknown,
  operation: RateOperation,
): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23505') {
    return { ok: false, error: RATE_DATE_CONFLICT_ERROR, field: 'effective_date' }
  }
  if (code === '23503') {
    return { ok: false, error: RATE_REFERENCE_MISSING_ERROR, field: 'contractor_id' }
  }
  if (code === 'P0001' && operation !== 'create') {
    return { ok: false, error: RATE_REFERENCED_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: RATE_CHECK_VIOLATION_ERROR, field: 'hourly_rate' }
  }
  if (code === '42501') {
    return { ok: false, error: RATE_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_RATE_WRITE_ERROR }
}

// ---------------------------------------------------------------------------
// 影响行数落地：写操作返回的 data 应为恰好 1 行的数组
// ---------------------------------------------------------------------------

/** 从写操作返回的 data 解析出唯一受影响承包商；失败 / 非法一律 fail-closed */
function settleReturnedContractor(
  data: unknown,
): { ok: true; contractor: ContractorView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudContractors(data as CloudContractorRow[])
  if (!mapped.ok || mapped.contractors.length !== 1) return { ok: false }
  return { ok: true, contractor: mapped.contractors[0] }
}

/** 从写操作返回的 data 解析出唯一受影响费率；失败 / 非法一律 fail-closed */
function settleReturnedRate(
  data: unknown,
): { ok: true; rate: ContractorRateView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapContractorRateRow(data[0] as CloudContractorRateRow)
  if (!mapped.ok) return { ok: false }
  return { ok: true, rate: mapped.rate }
}

// ---------------------------------------------------------------------------
// 云端承包商写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/**
 * 云端新增承包商：insert + select 精确列；影响行数恰好 1 才成功。
 * contractor_id 由数据库 identity 自动生成（payload 不含 contractor_id）。
 */
export async function createContractor(
  rdb: ContractorRdbMutationClient,
  input: ContractorCloudInput,
): Promise<OpResult<ContractorView>> {
  const v = validateContractorFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildContractorPayload(input)
  try {
    const { data, error } = await rdb
      .from('contractors')
      .insert(payload)
      .select(CONTRACTOR_SELECT_COLUMNS)
    if (error) return mapContractorError(error)
    const settled = settleReturnedContractor(data)
    if (!settled.ok) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    return { ok: true, data: settled.contractor }
  } catch {
    return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
  }
}

/**
 * 云端编辑承包商：update + eq(contractor_id) + select；contractor_id 需正安全整数，影响行数恰好 1。
 */
export async function updateContractor(
  rdb: ContractorRdbMutationClient,
  contractorId: number,
  input: ContractorCloudInput,
): Promise<OpResult<ContractorView>> {
  if (!isPositiveSafeInt(contractorId)) {
    return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
  }
  const v = validateContractorFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildContractorPayload(input)
  try {
    const { data, error } = await rdb
      .from('contractors')
      .update(payload)
      .eq('contractor_id', contractorId)
      .select(CONTRACTOR_SELECT_COLUMNS)
    if (error) return mapContractorError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: CONTRACTOR_UPDATE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    const settled = settleReturnedContractor(data)
    if (!settled.ok) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    return { ok: true, data: settled.contractor }
  } catch {
    return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
  }
}

/**
 * 云端删除承包商：delete + eq(contractor_id) + select；contractor_id 需正安全整数，影响行数恰好 1。
 * 0 行语义（承包商不存在 / 无权限，均被 RLS USING 收敛为 0 行）统一安全提示。
 * 被引用（23503：账号/费率/维修单外键）→ 无法删除提示。
 */
export async function removeContractor(
  rdb: ContractorRdbMutationClient,
  contractorId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(contractorId)) {
    return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('contractors')
      .delete()
      .eq('contractor_id', contractorId)
      .select(CONTRACTOR_SELECT_COLUMNS)
    if (error) return mapContractorError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: CONTRACTOR_DELETE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
  }
}

// ---------------------------------------------------------------------------
// 云端费率写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/**
 * 云端新增费率：insert + select 精确列；contractor_id 需正安全整数，影响行数恰好 1。
 * rate_id 由数据库 identity 自动生成（payload 不含 rate_id）。
 * 同承包商同日重复费率由数据库 UNIQUE(contractor_id, effective_date) 23505 兜底 → 日期冲突。
 */
export async function createContractorRate(
  rdb: ContractorRdbMutationClient,
  contractorId: number,
  input: ContractorRateCloudInput,
): Promise<OpResult<ContractorRateView>> {
  if (!isPositiveSafeInt(contractorId)) {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
  const v = validateRateFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildRateCreatePayload(input, contractorId)
  try {
    const { data, error } = await rdb
      .from('contractor_rates')
      .insert(payload)
      .select(RATE_SELECT_COLUMNS)
    if (error) return mapRateError(error, 'create')
    const settled = settleReturnedRate(data)
    if (!settled.ok) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    return { ok: true, data: settled.rate }
  } catch {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
}

/**
 * 云端编辑费率：update + eq(rate_id) + select；rate_id 需正安全整数，影响行数恰好 1。
 * payload 不含 contractor_id（不篡改费率归属）；已被维修单引用的费率由触发器 P0001 拒绝。
 */
export async function updateContractorRate(
  rdb: ContractorRdbMutationClient,
  rateId: number,
  input: ContractorRateCloudInput,
): Promise<OpResult<ContractorRateView>> {
  if (!isPositiveSafeInt(rateId)) {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
  const v = validateRateFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildRateUpdatePayload(input)
  try {
    const { data, error } = await rdb
      .from('contractor_rates')
      .update(payload)
      .eq('rate_id', rateId)
      .select(RATE_SELECT_COLUMNS)
    if (error) return mapRateError(error, 'update')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: RATE_UPDATE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    const settled = settleReturnedRate(data)
    if (!settled.ok) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    return { ok: true, data: settled.rate }
  } catch {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
}

/**
 * 云端删除费率：delete + eq(rate_id) + select；rate_id 需正安全整数，影响行数恰好 1。
 * 0 行语义（费率不存在 / 无权限）统一安全提示。
 * 已被维修单引用 → 触发器 P0001 → 不可删除提示。
 */
export async function removeContractorRate(
  rdb: ContractorRdbMutationClient,
  rateId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(rateId)) {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('contractor_rates')
      .delete()
      .eq('rate_id', rateId)
      .select(RATE_SELECT_COLUMNS)
    if (error) return mapRateError(error, 'delete')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: RATE_DELETE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_RATE_WRITE_ERROR }
  }
}
