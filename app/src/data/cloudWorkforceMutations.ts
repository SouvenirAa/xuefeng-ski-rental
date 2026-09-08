/**
 * 云端「员工 / 排班」写操作（create/update/remove）的纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点（与 cloudContractorMutations / cloudCustomerMutations 同级别的安全边界）：
 * - 复用 cloudWorkforce 的行映射 / 严格日期与时间校验 / 精确列查询，保证写后返回行与
 *   列表视图使用同一套映射与关联校验；
 * - payload 仅含业务字段，绝不写入 employee_id / shift_id / role / uid / account_id 等越权字段；
 * - 员工 nullable（address / phone / email / notes）空值归一化为 null 写库，不写虚构文本；
 * - 排班时间接受 "HH:mm" / "HH:mm:ss" / "HH:mm:ss.ffffff"，统一换算整数微秒比较，
 *   并遵守营业时间约束（08:00–22:00、start_time < end_time）；
 * - update/delete 用经过正安全整数校验的 employee_id / shift_id 精确 eq 过滤；
 * - 显式列名（EMPLOYEE_SELECT_COLUMNS / SHIFT_SELECT_COLUMNS），绝不用 select('*')；
 * - 影响行数恰好为 1：0 行视为失败、超过 1 行 fail-closed；
 * - 统一安全错误映射，不泄露 SQL、表名、约束名、原始 details/hint、Token；
 * - 每个函数内部 try/catch 收口 SDK Promise reject 与 SDK error，绝不回退 DataService/localStorage。
 */
import type { OpResult } from './types'
import {
  EMPLOYEE_SELECT_COLUMNS,
  SHIFT_SELECT_COLUMNS,
  mapCloudEmployees,
  mapCloudShifts,
  parseTime,
  SHIFT_START_MIN_MICROS,
  SHIFT_END_MAX_MICROS,
  type EmployeeView,
  type ShiftView,
  type CloudEmployeeRow,
  type CloudShiftRow,
} from './cloudWorkforce'
import { parseOptionalDate } from './cloudMaster'

// ---------------------------------------------------------------------------
// 安全错误常量（不包含底层细节）
// ---------------------------------------------------------------------------

/** 员工写操作统一安全错误 */
export const SAFE_EMPLOYEE_WRITE_ERROR = '员工操作失败，请稍后重试'
/** 排班写操作统一安全错误 */
export const SAFE_SHIFT_WRITE_ERROR = '排班操作失败，请稍后重试'
/** 员工无权限（42501 / 前端角色门禁） */
export const EMPLOYEE_PERMISSION_ERROR = '无权限执行该操作'
/** 排班无权限（42501 / 前端角色门禁） */
export const SHIFT_PERMISSION_ERROR = '无权限执行该操作'
/** 删除被引用（23503）：员工被账号 / 合同 / 排班引用 */
export const EMPLOYEE_REFERENCED_ERROR = '该员工已被账号、合同或排班引用，无法删除'
/** 排班外键引用不存在（23503，create/update）：员工或门店不存在 */
export const SHIFT_REFERENCE_MISSING_ERROR = '所选员工或门店不存在'
/** 排班唯一冲突（23505）：UNIQUE(employee_id, work_date) */
export const SHIFT_DATE_CONFLICT_ERROR = '该员工在当天已有排班'
/** 员工字段规则违例（23514） */
export const EMPLOYEE_CHECK_VIOLATION_ERROR = '输入数据不符合员工规则'
/** 排班字段规则违例（23514）：营业时间 / start<end */
export const SHIFT_CHECK_VIOLATION_ERROR = '输入数据不符合排班规则'
/** 员工更新/删除目标不存在 */
export const EMPLOYEE_NOT_FOUND_ERROR = '员工不存在，可能已被删除'
/** 排班更新/删除目标不存在 */
export const SHIFT_NOT_FOUND_ERROR = '排班不存在，可能已被删除'

// ---------------------------------------------------------------------------
// 云端输入类型（可空字段显式建模，与 local 非空领域类型区分）
// ---------------------------------------------------------------------------

/** 员工云端输入（address / phone / email / notes 数据库可空 → string | null） */
export interface EmployeeCloudInput {
  full_name: string
  address: string | null
  phone: string | null
  email: string | null
  notes: string | null
}

/** 排班云端输入（shift_id 由数据库生成） */
export interface ShiftCloudInput {
  employee_id: number
  store_id: number
  work_date: string
  start_time: string
  end_time: string
}

// ---------------------------------------------------------------------------
// 可注入的最小 RDB 写客户端（Node 可用 fake client 验证 insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------

/** 写查询结果（真实 SDK 为 PostgrestSingleResponse：data + error） */
export interface WorkforceMutationResponse {
  data: unknown
  error: unknown
}

/** 写过滤/变换构造器（thenable，可 await；支持 .eq / .select 链式） */
export interface WorkforceMutationBuilder extends PromiseLike<WorkforceMutationResponse> {
  eq(column: string, value: unknown): WorkforceMutationBuilder
  select(columns: string): WorkforceMutationBuilder
}

/** 写查询构造器（from().insert / update / delete） */
export interface WorkforceMutationQueryBuilder {
  insert(values: Record<string, unknown>): WorkforceMutationBuilder
  update(values: Record<string, unknown>): WorkforceMutationBuilder
  delete(): WorkforceMutationBuilder
}

/** 员工 / 排班写操作所需的最小 RDB 客户端 */
export interface WorkforceRdbMutationClient {
  from(table: string): WorkforceMutationQueryBuilder
}

// ---------------------------------------------------------------------------
// 输入归一化与校验
// ---------------------------------------------------------------------------

/** 正安全整数校验（employee_id / shift_id / store_id 精确过滤前必须通过） */
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
 * 构造员工写 payload：仅业务字段，trim + 空值归一化为 null，
 * 绝不包含 employee_id / role / uid / account_id 等越权字段。
 */
export function buildEmployeePayload(input: EmployeeCloudInput): Record<string, unknown> {
  return {
    full_name: input.full_name.trim(),
    address: normalizeOptionalText(input.address),
    phone: normalizeOptionalText(input.phone),
    email: normalizeOptionalText(input.email),
    notes: normalizeOptionalText(input.notes),
  }
}

// 员工列真实 varchar 长度（与 create_schema.sql 一致，用于运行时校验，不依赖 TS）
const FULL_NAME_MAX = 50
const ADDRESS_MAX = 200
const PHONE_MAX = 20
const EMAIL_MAX = 100
const NOTES_MAX = 500

/**
 * 员工字段校验（运行时类型校验 + 真实 varchar 长度校验，不依赖 TypeScript）：
 * - full_name：必须为 string、trim 后非空、trim 后长度 ≤ 50；
 * - address / phone / email / notes：可空；非空必须为 string 且 trim 后长度合规。
 * 返回字段级错误，供页面精确提示。
 */
export function validateEmployeeFields(
  input: EmployeeCloudInput,
): { ok: true } | { ok: false; error: string; field: string } {
  if (typeof input.full_name !== 'string' || input.full_name.trim() === '') {
    return { ok: false, error: '员工姓名不能为空', field: 'full_name' }
  }
  if (input.full_name.trim().length > FULL_NAME_MAX) {
    return { ok: false, error: `员工姓名不能超过 ${FULL_NAME_MAX} 个字符`, field: 'full_name' }
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
  if (input.notes !== null) {
    if (typeof input.notes !== 'string') {
      return { ok: false, error: '备注格式不正确', field: 'notes' }
    }
    if (input.notes.trim().length > NOTES_MAX) {
      return { ok: false, error: `备注不能超过 ${NOTES_MAX} 个字符`, field: 'notes' }
    }
  }
  return { ok: true }
}

/** 排班严格日期校验：非空且为真实 YYYY-MM-DD（复用 cloudMaster.parseOptionalDate） */
function isValidShiftDate(v: string): boolean {
  return parseOptionalDate(v) !== 'INVALID' && parseOptionalDate(v) !== null
}

/**
 * 排班字段校验（与 DataService.validateShiftInput 同口径，但外键存在性用已加载集合预校验）：
 * - employee_id / store_id 必须为正安全整数且存在于已加载集合；
 * - work_date 必须为真实日期；
 * - start_time / end_time 接受 HH:mm / HH:mm:ss / HH:mm:ss.ffffff，统一整数微秒比较；
 * - 营业时间约束：start >= 08:00、end <= 22:00、start < end。
 */
export function validateShiftFields(
  input: ShiftCloudInput,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true } | { ok: false; error: string; field: string } {
  if (!isPositiveSafeInt(input.employee_id)) {
    return { ok: false, error: '员工不能为空', field: 'employee_id' }
  }
  if (!employeeIds.has(input.employee_id)) {
    return { ok: false, error: '员工不存在', field: 'employee_id' }
  }
  if (!isPositiveSafeInt(input.store_id)) {
    return { ok: false, error: '门店不能为空', field: 'store_id' }
  }
  if (!storeIds.has(input.store_id)) {
    return { ok: false, error: '门店不存在', field: 'store_id' }
  }
  if (!isValidShiftDate(input.work_date)) {
    return { ok: false, error: '排班日期不能为空且须为合法日期', field: 'work_date' }
  }
  const start = parseTime(input.start_time)
  if (start === 'INVALID') {
    return { ok: false, error: '开始时间须为合法时间', field: 'start_time' }
  }
  const end = parseTime(input.end_time)
  if (end === 'INVALID') {
    return { ok: false, error: '结束时间须为合法时间', field: 'end_time' }
  }
  if (start.micros < SHIFT_START_MIN_MICROS) {
    return { ok: false, error: '开始时间不得早于 08:00', field: 'start_time' }
  }
  if (end.micros > SHIFT_END_MAX_MICROS) {
    return { ok: false, error: '结束时间不得晚于 22:00', field: 'end_time' }
  }
  if (start.micros >= end.micros) {
    return { ok: false, error: '开始时间必须早于结束时间', field: 'end_time' }
  }
  return { ok: true }
}

/**
 * 构造排班写 payload：仅业务字段，时间归一化为规范展示串。
 * 绝不包含 shift_id / role / uid / account_id 等越权字段。
 */
export function buildShiftPayload(input: ShiftCloudInput): Record<string, unknown> {
  const start = parseTime(input.start_time)
  const end = parseTime(input.end_time)
  return {
    employee_id: input.employee_id,
    store_id: input.store_id,
    work_date: input.work_date,
    start_time: start === 'INVALID' ? input.start_time : start.canonical,
    end_time: end === 'INVALID' ? input.end_time : end.canonical,
  }
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

/** 员工错误映射，绝不泄露底层细节 */
function mapEmployeeError(error: unknown, mode: 'write' | 'delete'): { ok: false; error: string } {
  const code = toSqlState(error)
  if (code === '23503') {
    // 员工仅被 accounts / rental_contracts / shifts 引用（删除时外键违例）
    return { ok: false, error: mode === 'delete' ? EMPLOYEE_REFERENCED_ERROR : SAFE_EMPLOYEE_WRITE_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: EMPLOYEE_CHECK_VIOLATION_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: EMPLOYEE_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
}

/** 排班错误映射，绝不泄露底层细节 */
function mapShiftError(error: unknown): { ok: false; error: string; field?: string } {
  const code = toSqlState(error)
  if (code === '23505') {
    return { ok: false, error: SHIFT_DATE_CONFLICT_ERROR, field: 'work_date' }
  }
  if (code === '23503') {
    return { ok: false, error: SHIFT_REFERENCE_MISSING_ERROR }
  }
  if (code === '23514') {
    return { ok: false, error: SHIFT_CHECK_VIOLATION_ERROR }
  }
  if (code === '42501') {
    return { ok: false, error: SHIFT_PERMISSION_ERROR }
  }
  return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
}

// ---------------------------------------------------------------------------
// 影响行数落地：写操作返回的 data 应为恰好 1 行的数组
// ---------------------------------------------------------------------------

/** 从写操作返回的 data 解析出唯一受影响员工；失败 / 非法一律 fail-closed */
function settleReturnedEmployee(data: unknown): { ok: true; employee: EmployeeView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudEmployees(data as CloudEmployeeRow[])
  if (!mapped.ok || mapped.employees.length !== 1) return { ok: false }
  return { ok: true, employee: mapped.employees[0] }
}

/** 从写操作返回的 data 解析出唯一受影响排班；失败 / 非法 / 关联不符一律 fail-closed */
function settleReturnedShift(
  data: unknown,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true; shift: ShiftView } | { ok: false } {
  if (!Array.isArray(data)) return { ok: false }
  if (data.length !== 1) return { ok: false }
  const mapped = mapCloudShifts(data as CloudShiftRow[], employeeIds, storeIds)
  if (!mapped.ok || mapped.shifts.length !== 1) return { ok: false }
  return { ok: true, shift: mapped.shifts[0] }
}

// ---------------------------------------------------------------------------
// 云端员工写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/** 云端新增员工：insert + select 精确列；影响行数恰好 1 才成功 */
export async function createEmployee(
  rdb: WorkforceRdbMutationClient,
  input: EmployeeCloudInput,
): Promise<OpResult<EmployeeView>> {
  const v = validateEmployeeFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildEmployeePayload(input)
  try {
    const { data, error } = await rdb
      .from('employees')
      .insert(payload)
      .select(EMPLOYEE_SELECT_COLUMNS)
    if (error) return mapEmployeeError(error, 'write')
    const settled = settleReturnedEmployee(data)
    if (!settled.ok) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    return { ok: true, data: settled.employee }
  } catch {
    return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
  }
}

/** 云端编辑员工：update + eq(employee_id) + select；employee_id 需正安全整数，影响行数恰好 1 */
export async function updateEmployee(
  rdb: WorkforceRdbMutationClient,
  employeeId: number,
  input: EmployeeCloudInput,
): Promise<OpResult<EmployeeView>> {
  if (!isPositiveSafeInt(employeeId)) {
    return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
  }
  const v = validateEmployeeFields(input)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildEmployeePayload(input)
  try {
    const { data, error } = await rdb
      .from('employees')
      .update(payload)
      .eq('employee_id', employeeId)
      .select(EMPLOYEE_SELECT_COLUMNS)
    if (error) return mapEmployeeError(error, 'write')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: EMPLOYEE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    const settled = settleReturnedEmployee(data)
    if (!settled.ok) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    return { ok: true, data: settled.employee }
  } catch {
    return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
  }
}

/** 云端删除员工：delete + eq(employee_id) + select；employee_id 需正安全整数，影响行数恰好 1 */
export async function removeEmployee(
  rdb: WorkforceRdbMutationClient,
  employeeId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(employeeId)) {
    return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('employees')
      .delete()
      .eq('employee_id', employeeId)
      .select(EMPLOYEE_SELECT_COLUMNS)
    if (error) return mapEmployeeError(error, 'delete')
    if (!Array.isArray(data)) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: EMPLOYEE_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
  }
}

// ---------------------------------------------------------------------------
// 云端排班写操作（可注入 RDB 客户端）
// ---------------------------------------------------------------------------

/** 云端新增排班：insert + select 精确列；影响行数恰好 1 才成功 */
export async function createShift(
  rdb: WorkforceRdbMutationClient,
  input: ShiftCloudInput,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): Promise<OpResult<ShiftView>> {
  const v = validateShiftFields(input, employeeIds, storeIds)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildShiftPayload(input)
  try {
    const { data, error } = await rdb
      .from('shifts')
      .insert(payload)
      .select(SHIFT_SELECT_COLUMNS)
    if (error) return mapShiftError(error)
    const settled = settleReturnedShift(data, employeeIds, storeIds)
    if (!settled.ok) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    return { ok: true, data: settled.shift }
  } catch {
    return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
  }
}

/** 云端编辑排班：update + eq(shift_id) + select；shift_id 需正安全整数，影响行数恰好 1 */
export async function updateShift(
  rdb: WorkforceRdbMutationClient,
  shiftId: number,
  input: ShiftCloudInput,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): Promise<OpResult<ShiftView>> {
  if (!isPositiveSafeInt(shiftId)) {
    return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
  }
  const v = validateShiftFields(input, employeeIds, storeIds)
  if (!v.ok) return { ok: false, error: v.error, field: v.field }

  const payload = buildShiftPayload(input)
  try {
    const { data, error } = await rdb
      .from('shifts')
      .update(payload)
      .eq('shift_id', shiftId)
      .select(SHIFT_SELECT_COLUMNS)
    if (error) return mapShiftError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: SHIFT_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    const settled = settleReturnedShift(data, employeeIds, storeIds)
    if (!settled.ok) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    return { ok: true, data: settled.shift }
  } catch {
    return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
  }
}

/** 云端删除排班：delete + eq(shift_id) + select；shift_id 需正安全整数，影响行数恰好 1 */
export async function removeShift(
  rdb: WorkforceRdbMutationClient,
  shiftId: number,
): Promise<OpResult> {
  if (!isPositiveSafeInt(shiftId)) {
    return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
  }
  try {
    const { data, error } = await rdb
      .from('shifts')
      .delete()
      .eq('shift_id', shiftId)
      .select(SHIFT_SELECT_COLUMNS)
    if (error) return mapShiftError(error)
    if (!Array.isArray(data)) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    if (data.length === 0) return { ok: false, error: SHIFT_NOT_FOUND_ERROR }
    if (data.length > 1) return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    return { ok: true, data: undefined }
  } catch {
    return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
  }
}
