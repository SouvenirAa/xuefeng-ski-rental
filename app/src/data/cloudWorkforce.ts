/**
 * 云端「员工 / 排班 / 门店」三张表的只读查询纯逻辑层
 * （可被 Node 校验脚本直接测试，不依赖 SDK / import.meta.env）。
 *
 * 设计要点：
 * - 数值字段归一化为 number（云端 bigint/numeric/integer 可能返回 string）；
 * - 显式列名查询，绝不用 select('*')；
 * - 员工主键 / 排班主外键 / 员工引用 / 门店引用 / 日期 / 时间范围 / start<end /
 *   同员工同日唯一 逐项校验，任一真实错误即 fail-closed，返回安全错误；
 * - 三张表任一查询失败 → 整体失败（空数据 + 安全错误），绝不返回部分数据、
 *   绝不回退 localStorage。
 *
 * 复用策略：门店查询与映射直接复用 cloudMaster 的 queryStores / mapCloudStores /
 *   StoreView，不重新实现；本模块只负责员工与排班，不触碰设备 / 技能等级，
 *   避免无关设备错误拖垮员工页（不使用 useMasterData）。
 *
 * nullable 与 TypeScript 类型映射策略（只读视图模型显式保留 NULL，绝不静默转换）：
 *   employees.address / phone / email / notes 数据库可空 → 视图类型 string | null，
 *   NULL 保留为 null，页面统一以占位符「—」展示、搜索按空字符串处理（见页面层），
 *   绝不把 NULL 静默转换为空字符串 / 虚构文本，也不得在页面显示字符串 "null"。
 *   local 模式的领域类型 Employee 对 address/phone/email 恒写非空（notes 已可空），
 *   云端只读视图模型仅在结构上把它们加宽为可空，属单向收窄安全的映射。
 *
 * time 格式策略（不假设 PostgreSQL 一定返回 HH:mm）：
 *   数据库 start_time / end_time 为 time without time zone（未限定精度），postgREST
 *   可能返回 "HH:MM:SS"（如 "08:00:00"），也可能带小数秒（如 "08:00:00.5"、
 *   "21:59:59.999999"）。parseTime 接受三种格式：
 *     - "HH:mm"（如 "08:00"）；
 *     - "HH:mm:ss"（如 "08:00:00"）；
 *     - "HH:mm:ss.ffffff"（小数秒 1~6 位，如 "08:00:00.5"）。
 *   统一换算为整数微秒（micros）做范围 / 顺序比较，绝不因浮点或字符串比较丢失
 *   小数秒精度。展示串归一化：秒为 0 且无小数 → "HH:mm"；秒非 0 → "HH:mm:ss"；
 *   带非零小数秒 → "HH:mm:ss.<去尾 0 的小数>"；小数秒全为 0 时视为无小数。
 */
import {
  parsePositiveIntId,
  parseOptionalString,
  parseOptionalDate,
  parseNonBlankString,
  type Invalid,
  mapCloudStores,
  queryStores,
  type StoreView,
  type MasterRdbClient,
} from './cloudMaster'

/** 安全错误文案（不含底层错误细节 / 数据值） */
export const SAFE_WORKFORCE_ERROR = '员工排班数据加载失败'

// ---------------------------------------------------------------------------
// 只读视图模型（云端可空字段保留 null；与可写领域类型 Employee 解耦）
// ---------------------------------------------------------------------------

/** 员工只读视图（address / phone / email / notes 数据库可空 → string | null） */
export interface EmployeeView {
  employee_id: number
  full_name: string
  address: string | null
  phone: string | null
  email: string | null
  notes: string | null
}

/** 排班只读视图（start_time / end_time 为规范化展示串，见文件头 time 格式策略） */
export interface ShiftView {
  shift_id: number
  employee_id: number
  store_id: number
  work_date: string
  start_time: string
  end_time: string
}

// ---------------------------------------------------------------------------
// 云端行类型（数值字段可能为 string；可空列类型与数据库一致）
// ---------------------------------------------------------------------------
export interface CloudEmployeeRow {
  employee_id: number | string | null | undefined
  full_name: string | null | undefined
  address: string | null | undefined
  phone: string | null | undefined
  email: string | null | undefined
  notes: string | null | undefined
}

export interface CloudShiftRow {
  shift_id: number | string | null | undefined
  employee_id: number | string | null | undefined
  store_id: number | string | null | undefined
  work_date: string | null | undefined
  start_time: string | null | undefined
  end_time: string | null | undefined
}

export type WorkforceReadResult =
  | { ok: true; employees: EmployeeView[]; shifts: ShiftView[]; stores: StoreView[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 解析助手（本模块专属）
// ---------------------------------------------------------------------------

/** 必填日期（work_date，date NOT NULL）：null/空 → INVALID；非空须严格 YYYY-MM-DD 真实日期 */
function parseRequiredDate(v: string | null | undefined): string | Invalid {
  const r = parseOptionalDate(v)
  if (r === null) return 'INVALID'
  return r
}

const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/
/** 营业时间下限 08:00:00.000000（整数微秒） */
export const SHIFT_START_MIN_MICROS = 8 * 3600 * 1_000_000
/** 营业时间上限 22:00:00.000000（整数微秒） */
export const SHIFT_END_MAX_MICROS = 22 * 3600 * 1_000_000

export interface ParsedTime {
  /** 规范化展示串：无小数且秒为 0 → "HH:mm"；秒非 0 → "HH:mm:ss"；非零小数 → "HH:mm:ss.f" */
  canonical: string
  /** 总微秒数（含小数秒），用于范围 / 顺序比较，避免丢失小数秒精度 */
  micros: number
}

/**
 * 必填时间（start_time / end_time，time NOT NULL）：
 * - 接受 "HH:mm"、"HH:mm:ss"、"HH:mm:ss.ffffff"（小数秒 1~6 位）；
 * - 校验 HH∈[0,23]、MM∈[0,59]、SS∈[0,59]；
 * - 统一换算为整数微秒用于比较，不丢小数秒精度；
 * - 归一化展示串：无小数且秒为 0 → "HH:mm"；秒非 0 → "HH:mm:ss"；非零小数秒保留。
 */
export function parseTime(v: string | null | undefined): ParsedTime | Invalid {
  if (typeof v !== 'string') return 'INVALID'
  const m = TIME_RE.exec(v.trim())
  if (!m) return 'INVALID'
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = m[3] === undefined ? 0 : Number(m[3])
  const frac = m[4] ?? ''
  if (hh > 23 || mm > 59 || ss > 59) return 'INVALID'
  // 小数秒补齐到 6 位微秒（1~6 位皆合法，整数运算不丢精度）
  const micros =
    hh * 3600 * 1_000_000 + mm * 60 * 1_000_000 + ss * 1_000_000 + Number(frac.padEnd(6, '0'))
  // 展示串：去掉尾部 0；小数全为 0 时视为无小数
  const trimmed = frac.replace(/0+$/, '')
  let canonical: string
  if (trimmed === '') {
    canonical = ss === 0 ? `${m[1]}:${m[2]}` : `${m[1]}:${m[2]}:${m[3]}`
  } else {
    canonical = `${m[1]}:${m[2]}:${m[3]}.${trimmed}`
  }
  return { canonical, micros }
}

// ---------------------------------------------------------------------------
// 单行映射（字段异常即 fail-closed；可空字段的 NULL 为合法值，保留为 null）
// ---------------------------------------------------------------------------
function mapEmployeeRow(
  raw: CloudEmployeeRow,
): { ok: true; employee: EmployeeView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const employee_id = parsePositiveIntId(raw.employee_id)
  if (employee_id === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const full_name = parseNonBlankString(raw.full_name)
  if (full_name === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  // address / phone / email / notes：数据库可空 → 保留 null（空串仍是合法值，二者区分）
  const address = parseOptionalString(raw.address)
  if (address === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const phone = parseOptionalString(raw.phone)
  if (phone === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const email = parseOptionalString(raw.email)
  if (email === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const notes = parseOptionalString(raw.notes)
  if (notes === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  return { ok: true, employee: { employee_id, full_name, address, phone, email, notes } }
}

/**
 * 排班单行映射 + 关联完整性 + 业务约束校验：
 * - employee_id / store_id 必须存在于已读取集合；
 * - work_date 严格日期；start_time / end_time 合法时间；
 * - start_time ∈ [08:00, 22:00]、end_time ∈ [08:00, 22:00]、start_time < end_time。
 */
function mapShiftRow(
  raw: CloudShiftRow,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true; shift: ShiftView } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const shift_id = parsePositiveIntId(raw.shift_id)
  if (shift_id === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const employee_id = parsePositiveIntId(raw.employee_id)
  if (employee_id === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const store_id = parsePositiveIntId(raw.store_id)
  if (store_id === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const work_date = parseRequiredDate(raw.work_date)
  if (work_date === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const start = parseTime(raw.start_time)
  if (start === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const end = parseTime(raw.end_time)
  if (end === 'INVALID') return { ok: false, error: SAFE_WORKFORCE_ERROR }

  // 关联完整性：员工 / 门店外键
  if (!employeeIds.has(employee_id)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  if (!storeIds.has(store_id)) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  // 时间范围（08:00–22:00）与顺序（start < end），统一用整数微秒比较，不丢小数秒精度
  if (start.micros < SHIFT_START_MIN_MICROS) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  if (end.micros > SHIFT_END_MAX_MICROS) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  if (start.micros >= end.micros) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  return {
    ok: true,
    shift: {
      shift_id,
      employee_id,
      store_id,
      work_date,
      start_time: start.canonical,
      end_time: end.canonical,
    },
  }
}

// ---------------------------------------------------------------------------
// 批量映射：逐行校验 + 重复主键 / 复合唯一约束拒绝 + 稳定排序
// ---------------------------------------------------------------------------
export function mapCloudEmployees(
  rows: unknown,
): { ok: true; employees: EmployeeView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const employees: EmployeeView[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    const r = mapEmployeeRow(raw as CloudEmployeeRow)
    if (!r.ok) return { ok: false, error: SAFE_WORKFORCE_ERROR }
    if (seen.has(r.employee.employee_id)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
    seen.add(r.employee.employee_id)
    employees.push(r.employee)
  }
  employees.sort((a, b) => a.employee_id - b.employee_id)
  return { ok: true, employees }
}

export function mapCloudShifts(
  rows: unknown,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
): { ok: true; shifts: ShiftView[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const shifts: ShiftView[] = []
  const seenShift = new Set<number>()
  const seenComposite = new Set<string>() // `${employee_id}:${work_date}`
  for (const raw of rows) {
    const r = mapShiftRow(raw as CloudShiftRow, employeeIds, storeIds)
    if (!r.ok) return { ok: false, error: SAFE_WORKFORCE_ERROR }
    if (seenShift.has(r.shift.shift_id)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
    // 复合唯一：同员工同日仅一个班次（UNIQUE(employee_id, work_date)）
    const compositeKey = `${r.shift.employee_id}:${r.shift.work_date}`
    if (seenComposite.has(compositeKey)) return { ok: false, error: SAFE_WORKFORCE_ERROR }
    seenShift.add(r.shift.shift_id)
    seenComposite.add(compositeKey)
    shifts.push(r.shift)
  }
  shifts.sort((a, b) => a.shift_id - b.shift_id)
  return { ok: true, shifts }
}

/**
 * 三表联立组装：先映射门店与员工构建外键集合，再映射排班并做关联 / 业务约束校验。
 * 任一环节失败即返回安全错误，绝不返回部分数据。
 */
export function assembleCloudWorkforce(
  employeesRows: unknown,
  shiftsRows: unknown,
  storesRows: unknown,
): WorkforceReadResult {
  const s = mapCloudStores(storesRows)
  if (!s.ok) return { ok: false, error: SAFE_WORKFORCE_ERROR }
  const e = mapCloudEmployees(employeesRows)
  if (!e.ok) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  const employeeIds = new Set(e.employees.map((x) => x.employee_id))
  const storeIds = new Set(s.stores.map((x) => x.store_id))
  const sh = mapCloudShifts(shiftsRows, employeeIds, storeIds)
  if (!sh.ok) return { ok: false, error: SAFE_WORKFORCE_ERROR }

  return { ok: true, employees: e.employees, shifts: sh.shifts, stores: s.stores }
}

// ---------------------------------------------------------------------------
// 查询构造器（复用 cloudMaster 的 MasterRdbClient，注入 fake client 供 Node 单测）
// ---------------------------------------------------------------------------

/** 员工精确列（6 列） */
export const EMPLOYEE_SELECT_COLUMNS = 'employee_id, full_name, address, phone, email, notes'
/** 排班精确列（6 列） */
export const SHIFT_SELECT_COLUMNS =
  'shift_id, employee_id, store_id, work_date, start_time, end_time'

/** 员工查询：from('employees') + 精确列 + employee_id 升序 */
export async function queryEmployees(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('employees').select(EMPLOYEE_SELECT_COLUMNS).order('employee_id', { ascending: true })
}

/** 排班查询：from('shifts') + 精确列 + shift_id 升序 */
export async function queryShifts(
  rdb: MasterRdbClient,
): Promise<{ data: unknown; error: unknown }> {
  return rdb.from('shifts').select(SHIFT_SELECT_COLUMNS).order('shift_id', { ascending: true })
}

/**
 * 员工 + 排班 + 门店主查询：并行读取三表，任一返回 error 或抛异常 → 整体安全错误
 * （不返回部分数据）。门店复用 cloudMaster.queryStores。成功后联立组装并做校验。
 */
export async function queryWorkforce(rdb: MasterRdbClient): Promise<WorkforceReadResult> {
  try {
    const [employees, shifts, stores] = await Promise.all([
      queryEmployees(rdb),
      queryShifts(rdb),
      queryStores(rdb),
    ])
    if (employees.error || shifts.error || stores.error) {
      return { ok: false, error: SAFE_WORKFORCE_ERROR }
    }
    return assembleCloudWorkforce(employees.data, shifts.data, stores.data)
  } catch {
    return { ok: false, error: SAFE_WORKFORCE_ERROR }
  }
}
