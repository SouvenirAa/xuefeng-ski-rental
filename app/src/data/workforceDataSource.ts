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
import type { StoreView } from './cloudMaster'
import { safeCloudLoad as genericSafeCloudLoad } from './safeCloudLoad'

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
