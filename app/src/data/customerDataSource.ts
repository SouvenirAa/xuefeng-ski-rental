/**
 * 客户列表数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useCustomers 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 */
import type { Customer, CustomerInput, OpResult } from './types'
import { SAFE_CLOUD_ERROR, type CloudReadResult } from './cloudCustomers'
import {
  validateCustomerFields,
  isPositiveSafeInt,
  SAFE_CUSTOMER_WRITE_ERROR,
  CUSTOMER_PERMISSION_ERROR,
  type CustomerRdbMutationClient,
} from './cloudCustomerMutations'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'
import { LatestRequestGuard } from './contractDataSource'

export type CustomerDataMode = 'local' | 'cloud'

export interface CustomerDataSources {
  localRead: () => Customer[]
  cloudRead: () => Promise<CloudReadResult>
}

export type CustomerLoadDispatch =
  | { kind: 'local'; customers: Customer[] }
  | { kind: 'cloud'; promise: Promise<CloudReadResult> }

/**
 * 完整云读取边界（fail-closed，可独立单测）：
 * - cloudRead 同步 throw（如 getRdb() 在参数求值阶段同步抛错）；
 * - cloudRead 返回的 Promise reject（如 SDK 网络异常）；
 * 统一收口为 { ok:false, error:SAFE_CLOUD_ERROR }。
 * 返回的 Promise 永不 reject，始终 resolve 为 CloudReadResult；
 * 绝不调用 localRead、绝不回退 DataService/localStorage。
 */
export function safeCloudLoad(
  sources: Pick<CustomerDataSources, 'cloudRead'>,
): Promise<CloudReadResult> {
  return genericSafeCloudLoad(sources.cloudRead, { ok: false, error: SAFE_CLOUD_ERROR })
}

/**
 * 按模式分派读取：
 * - local：调用 localRead 恰好一次，同步返回本地客户；
 * - cloud：绝不调用 localRead，经 safeCloudLoad 返回永不 reject 的 Promise。
 * 提供字面量重载，使调用方按传入的模式字面量直接收窄返回类型。
 */
export function dispatchCustomerLoad(
  mode: 'local',
  sources: CustomerDataSources,
): { kind: 'local'; customers: Customer[] }
export function dispatchCustomerLoad(
  mode: 'cloud',
  sources: CustomerDataSources,
): { kind: 'cloud'; promise: Promise<CloudReadResult> }
export function dispatchCustomerLoad(
  mode: CustomerDataMode,
  sources: CustomerDataSources,
): CustomerLoadDispatch {
  if (mode === 'local') {
    return { kind: 'local', customers: sources.localRead() }
  }
  return { kind: 'cloud', promise: safeCloudLoad(sources) }
}

/** 云读取结果落地为统一形态：失败 → 空数组 + 错误（绝不回退本地客户）。 */
export function settleCloudRead(
  r: CloudReadResult,
): { customers: Customer[]; error: string | null } {
  if (r.ok) return { customers: r.customers, error: null }
  return { customers: [], error: r.error }
}

// ---------------------------------------------------------------------------
// 客户写操作分派（local / cloud 双模式，fail-closed，可独立单测）
// ---------------------------------------------------------------------------

/**
 * 按模式分派客户写操作：
 * - local：调用 localRun 恰好一次（同步 OpResult），绝不触碰 getRdbFn / cloudRun；
 * - cloud：先求值 getRdbFn（同步 throw 时 fail-closed），再执行 cloudRun；
 *   cloudRun 的 Promise reject / 内部 SDK error 一律由 cloudRun 自身收口，
 *   此处兜底 catch 仅处理 getRdbFn 同步 throw 与 cloudRun 意外 reject；
 *   失败返回 fallback，绝不调用 localRun、绝不回退 DataService/localStorage。
 * 返回 Promise 永不 reject。
 */
export async function dispatchCustomerMutation<T>(
  mode: CustomerDataMode,
  getRdbFn: () => CustomerRdbMutationClient,
  cloudRun: (rdb: CustomerRdbMutationClient) => Promise<T>,
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
 * 客户 create/update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行角色门禁（canWrite，非 admin/staff 立即返回无权限错误），再执行目标 ID 校验
 *   （customerId 提供时，即 update 场景，需为正安全整数），再执行 validateCustomerFields(input)；
 *   任一失败立即返回安全/字段级错误（getRdbFn / cloudRun / rdb.from 均 0 次调用、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createCustomer/updateCustomer 仍会再校验作为纵深防护）。
 * - customerId 传 undefined 表示 create（无目标 ID，仅字段前置校验）。
 * - local：不执行 canWrite / customer_id / 字段前置校验（local 输入由 dataService 内部校验，
 *   localRun 内仍按 role 收敛权限），行为与既有 local 流程完全一致、不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchCustomerWriteMutation(
  mode: CustomerDataMode,
  canWrite: boolean,
  input: CustomerInput,
  customerId: number | undefined,
  getRdbFn: () => CustomerRdbMutationClient,
  cloudRun: (rdb: CustomerRdbMutationClient) => Promise<OpResult<Customer>>,
  localRun: () => OpResult<Customer>,
): Promise<OpResult<Customer>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: CUSTOMER_PERMISSION_ERROR }
    }
    if (customerId !== undefined && !isPositiveSafeInt(customerId)) {
      return { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR }
    }
    const v = validateCustomerFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchCustomerMutation<OpResult<Customer>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR },
  )
}

/**
 * 客户 delete 的目标 ID 前置分派（在 getRdbFn / cloudRun / rdb.from 之前执行角色门禁与
 * customer_id 正安全整数校验）。
 * - cloud：非 admin/staff（canWrite=false）立即返回无权限错误；非法 customer_id 返回 fallback 安全错误
 *   （两种情形 getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 * - local：不执行 canWrite / customer_id 校验（local 由 dataService 内部校验），行为与既有 local 流程一致、不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchCustomerIdMutation(
  mode: CustomerDataMode,
  canWrite: boolean,
  customerId: number,
  getRdbFn: () => CustomerRdbMutationClient,
  cloudRun: (rdb: CustomerRdbMutationClient) => Promise<OpResult>,
  localRun: () => OpResult,
  fallback: OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) return { ok: false, error: CUSTOMER_PERMISSION_ERROR }
    if (!isPositiveSafeInt(customerId)) return fallback
  }
  return dispatchCustomerMutation<OpResult>(mode, getRdbFn, cloudRun, localRun, fallback)
}

/**
 * 云端读刷新控制器（可测试纯逻辑，无 React 依赖）。
 * 封装「mutation 成功后立即失效当前读 token → 触发重读」的顺序语义：
 * - refreshIfNeeded：仅 cloud 且 result.ok 且 isActive() 为真时才刷新；
 *   刷新第一步同步 `guard.begin()` 使旧读请求的 token 立即失效
 *   （旧查询无论何时 resolve 都不能覆盖新结果），第二步调用 refetch
 *   （Hook 里在其内部先置 loading/error，再 setTick 触发新一轮查询）。
 * - isActive 由调用方注入（useCustomers 传入 `() => mountedRef.current`）：
 *   组件已卸载（active=false）时，不失效 token、不推进代次、不 refetch、不写任何状态，
 *   避免卸载后仍调用 setState / 触发新云查询。
 * - useCustomers 以 ref 持有唯一实例，测试直接驱动同一实例验证失效顺序与「失败不刷新」。
 */
export class CloudCustomerRefresh {
  private guard: LatestRequestGuard
  private refetch: () => void
  private isActive: () => boolean
  private refreshCount = 0

  constructor(guard: LatestRequestGuard, refetch: () => void, isActive: () => boolean) {
    this.guard = guard
    this.refetch = refetch
    this.isActive = isActive
  }

  /**
   * mutation 落地后调用：仅 cloud 且成功且组件仍活跃（isActive()）才刷新；
   * 失败 / local / 已卸载均不刷新。
   * 返回原结果，便于调用方透传。
   */
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

/**
 * 客户写操作互斥锁：防止重复提交（同步 tryAcquire/release，Node 可单测）。
 * 页面/ Hook 在提交前 tryAcquire，成功后（含失败）release；
 * 已持锁时再次 tryAcquire 返回 false，调用方据此拒绝重复提交。
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
