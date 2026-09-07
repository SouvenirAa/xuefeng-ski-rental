/**
 * 基础资料（门店 / 技能等级 / 设备）数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useMasterData 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 *
 * 类型约定：门店/设备统一采用 cloudMaster 中的「只读视图模型」StoreView / RentalItemView
 * （可空字段显式建模为 null）。local reader 返回的可写领域类型 Store[] / RentalItem[] 结构性
 * 可赋值给 StoreView[] / RentalItemView[]（本地恒写非空，仅字段被加宽为可空），故此处统一用
 * 视图模型类型，local 模式 CRUD 行为不受影响。
 */
import type { OpResult, RentalItemInput, SkillLevel } from './types'
import {
  SAFE_MASTER_ERROR,
  type MasterReadResult,
  type StoreView,
  type RentalItemView,
} from './cloudMaster'
import {
  validateItemFields,
  SAFE_ITEM_WRITE_ERROR,
  type ItemRdbMutationClient,
  type RentalItemCloudInput,
} from './cloudItemMutations'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'
import { LatestRequestGuard } from './contractDataSource'

export type MasterDataMode = 'local' | 'cloud'

export interface MasterDataSources {
  localReadStores: () => StoreView[]
  localReadSkillLevels: () => SkillLevel[]
  localReadItems: () => RentalItemView[]
  cloudReadMaster: () => Promise<MasterReadResult>
}

export interface MasterData {
  stores: StoreView[]
  skillLevels: SkillLevel[]
  items: RentalItemView[]
}

export type MasterLoadDispatch =
  | { kind: 'local'; data: MasterData }
  | { kind: 'cloud'; promise: Promise<MasterReadResult> }

/**
 * 完整云读取边界（fail-closed，复用通用 safeCloudLoad）：
 * - cloudReadMaster 同步 throw（如 getRdb() 在参数求值阶段同步抛错）；
 * - cloudReadMaster 返回的 Promise reject（如 SDK 网络异常）；
 * 统一收口为 { ok:false, error:SAFE_MASTER_ERROR }，返回的 Promise 永不 reject。
 * 绝不调用本地 reader、绝不回退 DataService/localStorage。
 */
export function safeCloudMasterLoad(
  sources: Pick<MasterDataSources, 'cloudReadMaster'>,
): Promise<MasterReadResult> {
  return genericSafeCloudLoad(sources.cloudReadMaster, { ok: false, error: SAFE_MASTER_ERROR })
}

/**
 * 按模式分派读取：
 * - local：依次调用三个本地 reader 各恰好一次，同步返回本地基础资料；
 * - cloud：绝不调用本地 reader，经 safeCloudMasterLoad 返回永不 reject 的 Promise。
 */
export function dispatchMasterLoad(
  mode: 'local',
  sources: MasterDataSources,
): { kind: 'local'; data: MasterData }
export function dispatchMasterLoad(
  mode: 'cloud',
  sources: MasterDataSources,
): { kind: 'cloud'; promise: Promise<MasterReadResult> }
export function dispatchMasterLoad(
  mode: MasterDataMode,
  sources: MasterDataSources,
): MasterLoadDispatch {
  if (mode === 'local') {
    return {
      kind: 'local',
      data: {
        stores: sources.localReadStores(),
        skillLevels: sources.localReadSkillLevels(),
        items: sources.localReadItems(),
      },
    }
  }
  return { kind: 'cloud', promise: safeCloudMasterLoad(sources) }
}

/** 云读取结果落地为统一形态：失败 → 空基础资料 + 错误（绝不回退本地数据）。 */
export function settleMasterRead(
  r: MasterReadResult,
): { data: MasterData; error: string | null } {
  if (r.ok) {
    return {
      data: { stores: r.stores, skillLevels: r.skillLevels, items: r.items },
      error: null,
    }
  }
  return { data: { stores: [], skillLevels: [], items: [] }, error: r.error }
}

// ---------------------------------------------------------------------------
// 设备写操作分派（local / cloud 双模式，fail-closed，可独立单测）
// ---------------------------------------------------------------------------

/**
 * local/cloud 输入转换边界：把 cloud 可空输入转换为 local 非空 RentalItemInput。
 * local 领域类型对 description / purchase_date / purchase_cost / retail_price 恒写非空
 * （空值用空串 / 0 表达），与 cloud 的 null 语义明确区分，不改变 local CRUD 行为。
 */
export function toLocalItemInput(input: RentalItemCloudInput): RentalItemInput {
  // 日租金必填：本地领域类型恒为 number。调用方须先经 validateItemBasics 校验
  // （null/undefined/NaN/Infinity/负数 已被拒绝），此处 fail-closed 防御，绝不把空值静默转 0。
  const dailyRate = input.daily_rate
  if (dailyRate == null || !Number.isFinite(dailyRate) || dailyRate < 0) {
    throw new Error('设备日租金必填，且需为非负数值')
  }
  return {
    item_code: input.item_code,
    name: input.name,
    description: input.description ?? '',
    category: input.category,
    purchase_date: input.purchase_date ?? '',
    purchase_cost: input.purchase_cost ?? 0,
    retail_price: input.retail_price ?? 0,
    daily_rate: dailyRate,
    skill_level_id: input.skill_level_id,
    home_store_id: input.home_store_id,
    current_store_id: input.current_store_id,
  }
}

/**
 * 按模式分派设备写操作：
 * - local：调用 localRun 恰好一次（同步 OpResult），绝不触碰 getRdbFn / cloudRun；
 * - cloud：先求值 getRdbFn（同步 throw 时 fail-closed），再执行 cloudRun；
 *   cloudRun 的 Promise reject / 内部 SDK error 一律由 cloudRun 自身收口，
 *   此处兜底 catch 仅处理 getRdbFn 同步 throw 与 cloudRun 意外 reject；
 *   失败返回 fallback，绝不调用 localRun、绝不回退 DataService/localStorage。
 * 返回 Promise 永不 reject。
 */
export async function dispatchMasterMutation<T>(
  mode: MasterDataMode,
  getRdbFn: () => ItemRdbMutationClient,
  cloudRun: (rdb: ItemRdbMutationClient) => Promise<T>,
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
 * 设备 create/update 写操作分派（在 getRdbFn / cloudRun / rdb.from 之前执行完整字段校验）。
 * - cloud：先同步执行 validateItemFields(input, storeIds, levelIds)，校验失败立即返回
 *   字段级错误（getRdbFn / cloudRun 均 0 次调用、rdb.from 0 次、不触碰 RDB、不回退本地）；
 *   通过后才 getRdb → cloudRun（cloudRun 内 createItem/updateItem 仍会再做一次校验作为纵深防护）。
 * - local：不执行 validateItemFields（local 输入非空模型，由 localRun 内部经 validateItemBasics
 *   后转 DataService 校验），行为与既有 local 流程完全一致、不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchMasterItemMutation(
  mode: MasterDataMode,
  input: RentalItemCloudInput,
  storeIds: ReadonlySet<number>,
  levelIds: ReadonlySet<number>,
  getRdbFn: () => ItemRdbMutationClient,
  cloudRun: (rdb: ItemRdbMutationClient) => Promise<OpResult<RentalItemView>>,
  localRun: () => OpResult<RentalItemView>,
): Promise<OpResult<RentalItemView>> {
  if (mode === 'cloud') {
    const v = validateItemFields(input, storeIds, levelIds)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchMasterMutation<OpResult<RentalItemView>>(
    mode,
    getRdbFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_ITEM_WRITE_ERROR },
  )
}

/**
 * 设备写操作互斥锁：防止重复提交（同步 tryAcquire/release，Node 可单测）。
 * 与 customerDataSource.MutationLock 同构，作为基础资料模块的独立并发锁，
 * 避免 master 模块反向依赖客户模块。
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
 * - isActive 由调用方注入（useMasterData 传入 `() => mountedRef.current`）：
 *   组件已卸载（active=false）时，不失效 token、不推进代次、不 refetch、不写任何状态。
 * - useMasterData 以 ref 持有唯一实例，测试直接驱动同一实例验证失效顺序与「失败不刷新」。
 */
export class CloudMasterRefresh {
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
