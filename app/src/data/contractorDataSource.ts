/**
 * 承包商 / 费率数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useContractors 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 *
 * 类型约定：统一采用 cloudContractors 中的「只读视图模型」ContractorView / ContractorRateView
 * （address/phone/email 可空字段显式建模为 null）。local reader 返回的可写领域类型
 * Contractor[] / ContractorRate[] 结构性可赋值（本地恒写非空），故此处统一用视图模型类型，
 * local 模式 CRUD 行为不受影响。
 *
 * 写操作：local/cloud 双模式分派，cloud 输入采用 cloudContractorMutations 的可空输入
 * （ContractorCloudInput / ContractorRateCloudInput），local 经 toLocalContractorInput /
 * toLocalContractorRateInput 转换为本地非空领域输入，保持 local DataService 行为不变。
 */
import type { ContractorInput, ContractorRateInput, OpResult } from './types'
import {
  SAFE_CONTRACTOR_ERROR,
  type ContractorReadResult,
  type ContractorView,
  type ContractorRateView,
} from './cloudContractors'
import {
  validateContractorFields,
  validateRateFields,
  isPositiveSafeInt,
  SAFE_CONTRACTOR_WRITE_ERROR,
  SAFE_RATE_WRITE_ERROR,
  CONTRACTOR_PERMISSION_ERROR,
  RATE_PERMISSION_ERROR,
  type ContractorCloudInput,
  type ContractorRateCloudInput,
  type ContractorRdbMutationClient,
} from './cloudContractorMutations'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'
import { LatestRequestGuard } from './contractDataSource'

export type ContractorDataMode = 'local' | 'cloud'

export interface ContractorDataSources {
  localReadContractors: () => ContractorView[]
  localReadRates: () => ContractorRateView[]
  cloudReadContractors: () => Promise<ContractorReadResult>
}

export interface ContractorData {
  contractors: ContractorView[]
  rates: ContractorRateView[]
  /** 已被维修单引用的费率 rate_id 集合（升序去重） */
  referencedRateIds: number[]
}

export type ContractorLoadDispatch =
  | { kind: 'local'; data: ContractorData }
  | { kind: 'cloud'; promise: Promise<ContractorReadResult> }

/**
 * 完整云读取边界（fail-closed，复用通用 safeCloudLoad）：
 * - cloudReadContractors 同步 throw（如 getRdb() 同步抛错）；
 * - cloudReadContractors 返回的 Promise reject（如 SDK 网络异常）；
 * 统一收口为 { ok:false, error:SAFE_CONTRACTOR_ERROR }，返回的 Promise 永不 reject。
 * 绝不调用本地 reader、绝不回退 DataService/localStorage。
 */
export function safeCloudContractorLoad(
  sources: Pick<ContractorDataSources, 'cloudReadContractors'>,
): Promise<ContractorReadResult> {
  return genericSafeCloudLoad(sources.cloudReadContractors, { ok: false, error: SAFE_CONTRACTOR_ERROR })
}

/**
 * 按模式分派读取：
 * - local：依次调用两个本地 reader 各恰好一次，同步返回本地承包商与费率；
 * - cloud：绝不调用本地 reader，经 safeCloudContractorLoad 返回永不 reject 的 Promise。
 */
export function dispatchContractorLoad(
  mode: 'local',
  sources: ContractorDataSources,
): { kind: 'local'; data: ContractorData }
export function dispatchContractorLoad(
  mode: 'cloud',
  sources: ContractorDataSources,
): { kind: 'cloud'; promise: Promise<ContractorReadResult> }
export function dispatchContractorLoad(
  mode: ContractorDataMode,
  sources: ContractorDataSources,
): ContractorLoadDispatch {
  if (mode === 'local') {
    return {
      kind: 'local',
      data: {
        contractors: sources.localReadContractors(),
        rates: sources.localReadRates(),
        referencedRateIds: [],
      },
    }
  }
  return { kind: 'cloud', promise: safeCloudContractorLoad(sources) }
}

/** 云读取结果落地为统一形态：失败 → 空数据 + 错误（绝不回退本地数据）。 */
export function settleContractorRead(
  r: ContractorReadResult,
): { data: ContractorData; error: string | null } {
  if (r.ok) {
    return {
      data: {
        contractors: r.contractors,
        rates: r.rates,
        referencedRateIds: r.referencedRateIds,
      },
      error: null,
    }
  }
  return { data: { contractors: [], rates: [], referencedRateIds: [] }, error: r.error }
}

// ---------------------------------------------------------------------------
// local/cloud 输入转换边界（cloud 可空 → local 非空，不改变 local CRUD 行为）
// ---------------------------------------------------------------------------

/** cloud 可空输入 → local 非空 ContractorInput（address/phone/email null → 空串） */
export function toLocalContractorInput(input: ContractorCloudInput): ContractorInput {
  return {
    name: input.name,
    address: input.address ?? '',
    phone: input.phone ?? '',
    email: input.email ?? '',
  }
}

/** cloud 费率输入 → local 非空 ContractorRateInput（字段同名透传） */
export function toLocalContractorRateInput(input: ContractorRateCloudInput): ContractorRateInput {
  return {
    effective_date: input.effective_date,
    hourly_rate: input.hourly_rate,
  }
}

// ---------------------------------------------------------------------------
// 承包商/费率写操作分派（local / cloud 双模式，fail-closed，可独立单测）
// ---------------------------------------------------------------------------

/**
 * 按模式分派承包商/费率写操作：
 * - local：调用 localRun 恰好一次（同步 OpResult），绝不触碰 getRdbFn / cloudRun；
 * - cloud：先求值 getRdbFn（同步 throw 时 fail-closed），再执行 cloudRun；
 *   cloudRun 的 Promise reject / 内部 SDK error 一律由 cloudRun 自身收口，
 *   此处兜底 catch 仅处理 getRdbFn 同步 throw 与 cloudRun 意外 reject；
 *   失败返回 fallback，绝不调用 localRun、绝不回退 DataService/localStorage。
 * 返回 Promise 永不 reject。
 */
export async function dispatchContractorMutation<T>(
  mode: ContractorDataMode,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<T>,
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
 * 承包商 create/update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行管理员门禁（canWrite，非 admin 立即返回无权限错误），再执行目标 ID 校验
 *   （contractorId 提供时，即 update 场景，需为正安全整数），再执行 validateContractorFields(input)；
 *   任一失败立即返回安全/字段级错误（getRdbFn / cloudRun / rdb.from 均 0 次调用、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createContractor/updateContractor 仍会再校验作为纵深防护）。
 * - contractorId 传 undefined 表示 create（无目标 ID，仅字段前置校验）。
 * - local：不执行 canWrite / contractor_id / 字段前置校验（local 输入非空模型，由 dataService 内部校验，
 *   localRun 内仍按 role 收敛权限），行为与既有 local 流程完全一致、不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchContractorWriteMutation(
  mode: ContractorDataMode,
  canWrite: boolean,
  input: ContractorCloudInput,
  contractorId: number | undefined,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<OpResult<ContractorView>>,
  localRun: () => OpResult<ContractorView>,
): Promise<OpResult<ContractorView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: CONTRACTOR_PERMISSION_ERROR }
    }
    if (contractorId !== undefined && !isPositiveSafeInt(contractorId)) {
      return { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR }
    }
    const v = validateContractorFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractorMutation<OpResult<ContractorView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR },
  )
}

/**
 * 承包商 delete 的目标 ID 前置分派（在 getRdbFn / cloudRun / rdb.from 之前执行管理员门禁与
 * contractor_id 正安全整数校验）。
 * - cloud：非 admin（canWrite=false）立即返回无权限错误；非法 contractor_id 返回 fallback 安全错误
 *   （两种情形 getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 * - local：不执行 canWrite / contractor_id 校验（local 由 dataService 内部校验），行为与既有 local 流程一致、不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchContractorIdMutation(
  mode: ContractorDataMode,
  canWrite: boolean,
  contractorId: number,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<OpResult>,
  localRun: () => OpResult,
  fallback: OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) return { ok: false, error: CONTRACTOR_PERMISSION_ERROR }
    if (!isPositiveSafeInt(contractorId)) return fallback
  }
  return dispatchContractorMutation<OpResult>(mode, getRdbFn, cloudRun, localRun, fallback)
}

/**
 * 费率 create 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行管理员门禁（canWrite），再执行 contractor_id 正安全整数校验，再执行
 *   validateRateFields(input)；任一失败立即返回安全/字段级错误
 *   （getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createContractorRate 仍会再校验作为纵深防护）。
 * - local：不执行 canWrite / contractor_id / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchRateCreateMutation(
  mode: ContractorDataMode,
  canWrite: boolean,
  contractorId: number,
  input: ContractorRateCloudInput,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<OpResult<ContractorRateView>>,
  localRun: () => OpResult<ContractorRateView>,
): Promise<OpResult<ContractorRateView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: RATE_PERMISSION_ERROR }
    }
    if (!isPositiveSafeInt(contractorId)) {
      return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    }
    const v = validateRateFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractorMutation<OpResult<ContractorRateView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_RATE_WRITE_ERROR },
  )
}

/**
 * 费率 update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整前置校验）。
 * - cloud：先执行管理员门禁（canWrite），再执行 rate_id 正安全整数校验，再执行
 *   validateRateFields(input)；任一失败立即返回安全/字段级错误
 *   （getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 updateContractorRate 仍会再校验作为纵深防护）。
 * - local：不执行 canWrite / rate_id / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchRateUpdateMutation(
  mode: ContractorDataMode,
  canWrite: boolean,
  rateId: number,
  input: ContractorRateCloudInput,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<OpResult<ContractorRateView>>,
  localRun: () => OpResult<ContractorRateView>,
): Promise<OpResult<ContractorRateView>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: RATE_PERMISSION_ERROR }
    }
    if (!isPositiveSafeInt(rateId)) {
      return { ok: false, error: SAFE_RATE_WRITE_ERROR }
    }
    const v = validateRateFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractorMutation<OpResult<ContractorRateView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_RATE_WRITE_ERROR },
  )
}

/**
 * 费率 delete 的目标 ID 前置分派（在 getRdbFn / cloudRun / rdb.from 之前执行管理员门禁与
 * rate_id 正安全整数校验）。
 * - cloud：非 admin（canWrite=false）立即返回无权限错误；非法 rate_id 返回 fallback 安全错误
 *   （两种情形 getRdbFn / cloudRun / rdb.from 全 0 次、不回退本地）；
 * - local：不执行 canWrite / rate_id 校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchRateIdMutation(
  mode: ContractorDataMode,
  canWrite: boolean,
  rateId: number,
  getRdbFn: () => ContractorRdbMutationClient,
  cloudRun: (rdb: ContractorRdbMutationClient) => Promise<OpResult>,
  localRun: () => OpResult,
  fallback: OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) return { ok: false, error: RATE_PERMISSION_ERROR }
    if (!isPositiveSafeInt(rateId)) return fallback
  }
  return dispatchContractorMutation<OpResult>(mode, getRdbFn, cloudRun, localRun, fallback)
}

// ---------------------------------------------------------------------------
// 并发锁与云端读刷新控制器
// ---------------------------------------------------------------------------

/**
 * 承包商/费率写操作互斥锁：防止重复提交（同步 tryAcquire/release，Node 可单测）。
 * 与 masterDataSource.MutationLock 同构，作为承包商模块的独立并发锁，避免反向依赖。
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
 *   （旧查询无论何时 resolve 都不能覆盖新结果），第二步调用 refetch
 *   （Hook 里在其内部先置 loading/error，再 setTick 触发新一轮查询）。
 * - isActive 由调用方注入（useContractors 传入 `() => mountedRef.current`）：
 *   组件已卸载（active=false）时，不失效 token、不推进代次、不 refetch、不写任何状态。
 * - useContractors 以 ref 持有唯一实例，测试直接驱动同一实例验证失效顺序与「失败不刷新」。
 */
export class CloudContractorRefresh {
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
