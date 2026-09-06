/**
 * 基础资料（门店 / 技能等级 / 设备）数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useMasterData 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 *
 * 类型约定：门店/设备统一采用 cloudMaster 中的「只读视图模型」StoreView / RentalItemView
 * （可空字段显式建模为 null）。local reader 返回的可写领域类型 Store[] / RentalItem[] 结构性
 * 可赋值给 StoreView[] / RentalItemView[]（本地恒写非空，仅字段被加宽为可空），故此处统一用
 * 视图模型类型，local 模式 CRUD 行为不受影响。
 */
import type { SkillLevel } from './types'
import {
  SAFE_MASTER_ERROR,
  type MasterReadResult,
  type StoreView,
  type RentalItemView,
} from './cloudMaster'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'

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
