/**
 * 员工 / 排班 / 门店数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useWorkforce 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 *
 * 类型约定：统一采用 cloudWorkforce 中的「只读视图模型」EmployeeView / ShiftView，
 * 门店复用 cloudMaster 的 StoreView。local reader 返回的可写领域类型 Employee[] / Shift[] /
 * Store[] 结构性可赋值（本地恒写非空），故此处统一用视图模型类型，local 模式 CRUD 行为不受影响。
 */
import {
  SAFE_WORKFORCE_ERROR,
  type WorkforceReadResult,
  type EmployeeView,
  type ShiftView,
} from './cloudWorkforce'
import {
  validateEmployeeFields,
  validateShiftFields,
  isPositiveSafeInt,
  SAFE_EMPLOYEE_WRITE_ERROR,
  SAFE_SHIFT_WRITE_ERROR,
  EMPLOYEE_PERMISSION_ERROR,
  SHIFT_PERMISSION_ERROR,
  type EmployeeCloudInput,
  type ShiftCloudInput,
  type WorkforceRdbMutationClient,
} from './cloudWorkforceMutations'
import type { StoreView } from './cloudMaster'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'
import { LatestRequestGuard } from './contractDataSource'
import type { EmployeeInput, OpResult, ShiftInput } from './types'

export type WorkforceDataMode = 'local' | 'cloud'

export interface WorkforceDataSources {
  localReadEmployees: () => EmployeeView[]
  localReadShifts: () => ShiftView[]
  localReadStores: () => StoreView[]
  cloudReadWorkforce: () => Promise<WorkforceReadResult>
}

export interface WorkforceData {
  employees: EmployeeView[]
  shifts: ShiftView[]
  stores: StoreView[]
}

export type WorkforceLoadDispatch =
  | { kind: 'local'; data: WorkforceData }
  | { kind: 'cloud'; promise: Promise<WorkforceReadResult> }

/**
 * 完整云读取边界（fail-closed，复用通用 safeCloudLoad）：
 * - cloudReadWorkforce 同步 throw（如 getRdb() 同步抛错）；
 * - cloudReadWorkforce 返回的 Promise reject（如 SDK 网络异常）；
 * 统一收口为 { ok:false, error:SAFE_WORKFORCE_ERROR }，返回的 Promise 永不 reject。
 * 绝不调用本地 reader、绝不回退 DataService/localStorage。
 */
export function safeCloudWorkforceLoad(
  sources: Pick<WorkforceDataSources, 'cloudReadWorkforce'>,
): Promise<WorkforceReadResult> {
  return genericSafeCloudLoad(sources.cloudReadWorkforce, { ok: false, error: SAFE_WORKFORCE_ERROR })
}

/**
 * 按模式分派读取：
 * - local：依次调用三个本地 reader 各恰好一次，同步返回本地员工/排班/门店；
 * - cloud：绝不调用本地 reader，经 safeCloudWorkforceLoad 返回永不 reject 的 Promise。
 */
export function dispatchWorkforceLoad(
  mode: 'local',
  sources: WorkforceDataSources,
): { kind: 'local'; data: WorkforceData }
export function dispatchWorkforceLoad(
  mode: 'cloud',
  sources: WorkforceDataSources,
): { kind: 'cloud'; promise: Promise<WorkforceReadResult> }
export function dispatchWorkforceLoad(
  mode: WorkforceDataMode,
  sources: WorkforceDataSources,
): WorkforceLoadDispatch {
  if (mode === 'local') {
    return {
      kind: 'local',
      data: {
        employees: sources.localReadEmployees(),
        shifts: sources.localReadShifts(),
        stores: sources.localReadStores(),
      },
    }
  }
  return { kind: 'cloud', promise: safeCloudWorkforceLoad(sources) }
}

/** 云读取结果落地为统一形态：失败 → 空数据 + 错误（绝不回退本地数据）。 */
export function settleWorkforceRead(
  r: WorkforceReadResult,
): { data: WorkforceData; error: string | null } {
  if (r.ok) {
    return {
      data: { employees: r.employees, shifts: r.shifts, stores: r.stores },
      error: null,
    }
  }
  return { data: { employees: [], shifts: [], stores: [] }, error: r.error }
}

// ---------------------------------------------------------------------------
// local/cloud 输入转换边界（cloud 可空 → local 非空，不改变 local CRUD 行为）
// ---------------------------------------------------------------------------

/** cloud 可空员工输入 → local 非空 EmployeeInput（address/phone/email null → ''，notes 保持可空） */
export function toLocalEmployeeInput(input: EmployeeCloudInput): EmployeeInput {
  return {
    full_name: input.full_name,
    address: input.address ?? '',
    phone: input.phone ?? '',
    email: input.email ?? '',
    notes: input.notes,
  }
}

/** cloud 排班输入 → local ShiftInput（字段同名透传） */
export function toLocalShiftInput(input: ShiftCloudInput): ShiftInput {
  return {
    employee_id: input.employee_id,
    store_id: input.store_id,
    work_date: input.work_date,
    start_time: input.start_time,
    end_time: input.end_time,
  }
}

// ---------------------------------------------------------------------------
// 员工 / 排班写操作分派（local / cloud 双模式，fail-closed，可独立单测）
// ---------------------------------------------------------------------------

/**
 * 按模式分派员工 / 排班写操作：
 * - local：调用 localRun 恰好一次（同步 OpResult），绝不触碰 getRdbFn / cloudRun；
 * - cloud：先求值 getRdbFn（同步 throw 时 fail-closed），再执行 cloudRun；
 *   失败返回 fallback，绝不调用 localRun、绝不回退 DataService/localStorage。
 * 返回 Promise 永不 reject。
 */
export async function dispatchWorkforceMutation<T>(
  mode: WorkforceDataMode,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<T>,
  localRun: () => T,
  fallback: T,
): Promise<T> {
  if (mode === 'local') {
    return localRun()
  }
  try {
    const rdb = getRdbFn()
    return await cloudRun(rdb)
  } catch {
    return fallback
  }
}

/**
 * 员工 create/update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行角色门禁（canWrite，非 admin 立即返回无权限错误），再执行目标 ID 校验
 *   （employeeId 提供时，即 update 场景，需为正安全整数），再执行 validateEmployeeFields(input)；
 *   任一失败立即返回安全/字段级错误（getRdbFn / cloudRun / rdb.from 均 0 次、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createEmployee/updateEmployee 仍会再校验作为纵深防护）。
 * - employeeId 传 undefined 表示 create（无目标 ID，仅字段前置校验）。
 * - local：不执行 canWrite / employee_id / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchEmployeeWriteMutation(
  mode: WorkforceDataMode,
  canWrite: boolean,
  input: EmployeeCloudInput,
  employeeId: number | undefined,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<OpResult<EmployeeView>>,
  localRun: () => OpResult<EmployeeView>,
): Promise<OpResult<EmployeeView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: EMPLOYEE_PERMISSION_ERROR }
    }
    if (employeeId !== undefined && !isPositiveSafeInt(employeeId)) {
      return { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR }
    }
    const v = validateEmployeeFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchWorkforceMutation<OpResult<EmployeeView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR },
  )
}

/**
 * 员工 delete 的目标 ID 前置分派（在 getRdbFn / cloudRun / rdb.from 之前执行角色门禁与
 * employee_id 正安全整数校验）。
 * - cloud：非 admin（canWrite=false）立即返回无权限错误；非法 employee_id 返回 fallback 安全错误；
 * - local：不执行 canWrite / employee_id 校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchEmployeeIdMutation(
  mode: WorkforceDataMode,
  canWrite: boolean,
  employeeId: number,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<OpResult>,
  localRun: () => OpResult,
  fallback: OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) return { ok: false, error: EMPLOYEE_PERMISSION_ERROR }
    if (!isPositiveSafeInt(employeeId)) return fallback
  }
  return dispatchWorkforceMutation<OpResult>(mode, getRdbFn, cloudRun, localRun, fallback)
}

/**
 * 排班 create 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行角色门禁（canWrite），再执行 validateShiftFields(input, employeeIds, storeIds)；
 *   任一失败立即返回安全/字段级错误（getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createShift 仍会再校验作为纵深防护）。
 * - local：不执行 canWrite / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchShiftCreateMutation(
  mode: WorkforceDataMode,
  canWrite: boolean,
  input: ShiftCloudInput,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<OpResult<ShiftView>>,
  localRun: () => OpResult<ShiftView>,
): Promise<OpResult<ShiftView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: SHIFT_PERMISSION_ERROR }
    }
    const v = validateShiftFields(input, employeeIds, storeIds)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchWorkforceMutation<OpResult<ShiftView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_SHIFT_WRITE_ERROR },
  )
}

/**
 * 排班 update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行角色门禁（canWrite），再执行 shift_id 正安全整数校验，再执行
 *   validateShiftFields(input, employeeIds, storeIds)；任一失败立即返回安全/字段级错误；
 * - local：不执行 canWrite / shift_id / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchShiftUpdateMutation(
  mode: WorkforceDataMode,
  canWrite: boolean,
  shiftId: number,
  input: ShiftCloudInput,
  employeeIds: ReadonlySet<number>,
  storeIds: ReadonlySet<number>,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<OpResult<ShiftView>>,
  localRun: () => OpResult<ShiftView>,
): Promise<OpResult<ShiftView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: SHIFT_PERMISSION_ERROR }
    }
    if (!isPositiveSafeInt(shiftId)) {
      return { ok: false, error: SAFE_SHIFT_WRITE_ERROR }
    }
    const v = validateShiftFields(input, employeeIds, storeIds)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchWorkforceMutation<OpResult<ShiftView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_SHIFT_WRITE_ERROR },
  )
}

/**
 * 排班 delete 的目标 ID 前置分派（在 getRdbFn / cloudRun / rdb.from 之前执行角色门禁与
 * shift_id 正安全整数校验）。
 * - cloud：非 admin（canWrite=false）立即返回无权限错误；非法 shift_id 返回 fallback 安全错误；
 * - local：不执行 canWrite / shift_id 校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchShiftIdMutation(
  mode: WorkforceDataMode,
  canWrite: boolean,
  shiftId: number,
  getRdbFn: () => WorkforceRdbMutationClient,
  cloudRun: (rdb: WorkforceRdbMutationClient) => Promise<OpResult>,
  localRun: () => OpResult,
  fallback: OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) return { ok: false, error: SHIFT_PERMISSION_ERROR }
    if (!isPositiveSafeInt(shiftId)) return fallback
  }
  return dispatchWorkforceMutation<OpResult>(mode, getRdbFn, cloudRun, localRun, fallback)
}

// ---------------------------------------------------------------------------
// 并发锁与云端读刷新控制器
// ---------------------------------------------------------------------------

/**
 * 员工 / 排班写操作互斥锁：防止重复提交（同步 tryAcquire/release，Node 可单测）。
 * 与 masterDataSource.MutationLock 同构，作为人力模块的独立并发锁，避免反向依赖。
 */
export class MutationLock {
  private locked = false

  tryAcquire(): boolean {
    if (this.locked) return false
    this.locked = true
    return true
  }

  release(): void {
    this.locked = false
  }

  get isLocked(): boolean {
    return this.locked
  }
}

/**
 * 云端读刷新控制器（可测试纯逻辑，无 React 依赖）。
 * 封装「mutation 成功后立即失效当前读 token → 触发重读」的顺序语义：
 * - refreshIfNeeded：仅 cloud 且 result.ok 且 isActive() 为真时才刷新；
 *   刷新第一步同步 `guard.begin()` 使旧读请求的 token 立即失效
 *   （旧查询无论何时 resolve 都不能覆盖新结果），第二步调用 refetch。
 * - isActive 由调用方注入（useWorkforce 传入 `() => mountedRef.current`）：
 *   组件已卸载（active=false）时，不失效 token、不推进代次、不 refetch、不写任何状态。
 */
export class CloudWorkforceRefresh {
  private guard: LatestRequestGuard
  private refetch: () => void
  private isActive: () => boolean
  private refreshCount = 0

  constructor(guard: LatestRequestGuard, refetch: () => void, isActive: () => boolean) {
    this.guard = guard
    this.refetch = refetch
    this.isActive = isActive
  }

  /** mutation 落地后调用：仅 cloud 且成功且组件仍活跃（isActive()）才刷新；失败 / local / 已卸载均不刷新。 */
  refreshIfNeeded<T>(result: OpResult<T>, isCloud: boolean): OpResult<T> {
    if (isCloud && result.ok && this.isActive()) {
      this.guard.begin() // 同步失效当前读 token（旧查询晚到不得覆盖）
      this.refreshCount += 1
      this.refetch() // 触发新一轮查询
    }
    return result
  }

  /** 是否为新代次 token（供测试验证旧 token 已失效、新查询可落地）。 */
  isLatest(token: number): boolean {
    return this.guard.isLatest(token)
  }

  /** 触发刷新的次数（供测试断言「成功刷新、失败不刷新」）。 */
  get refreshes(): number {
    return this.refreshCount
  }
}
