/**
 * 承包商 / 费率数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useContractors 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 *
 * 类型约定：统一采用 cloudContractors 中的「只读视图模型」ContractorView / ContractorRateView
 * （address/phone/email 可空字段显式建模为 null）。local reader 返回的可写领域类型
 * Contractor[] / ContractorRate[] 结构性可赋值（本地恒写非空），故此处统一用视图模型类型，
 * local 模式 CRUD 行为不受影响。
 */
import {
  SAFE_CONTRACTOR_ERROR,
  type ContractorReadResult,
  type ContractorView,
  type ContractorRateView,
} from './cloudContractors'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'

export type ContractorDataMode = 'local' | 'cloud'

export interface ContractorDataSources {
  localReadContractors: () => ContractorView[]
  localReadRates: () => ContractorRateView[]
  cloudReadContractors: () => Promise<ContractorReadResult>
}

export interface ContractorData {
  contractors: ContractorView[]
  rates: ContractorRateView[]
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
    return { data: { contractors: r.contractors, rates: r.rates }, error: null }
  }
  return { data: { contractors: [], rates: [] }, error: r.error }
}
