/**
 * 客户列表数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useCustomers 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地 reader」。
 */
import type { Customer } from './types'
import { SAFE_CLOUD_ERROR, type CloudReadResult } from './cloudCustomers'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'

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
