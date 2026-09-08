/**
 * 驾驶舱数据源分派（纯逻辑，可注入 fake reader 做 Node 单测）。
 * local/cloud 双模式共享同一 KPI 聚合口径（cloudDashboard.assembleDashboardKpi），
 * 保证「由系统数据按既定口径计算 KPI，非写死数字」在两种模式下一致。
 *
 * - local：把 DataService 类型化数据转成聚合所需的 raw 形状，复用 assembleDashboardKpi；
 * - cloud：经 safeCloudDashboardLoad 返回永不 reject 的 Promise，失败 fail-closed，
 *   绝不回退 local 数据。
 */
import {
  assembleDashboardKpi,
  SAFE_DASHBOARD_ERROR,
  type DashboardKpi,
  type DashboardReadResult,
} from './cloudDashboard'
import { safeCloudLoad } from './safeCloudLoad'
import type { RentalItem, Store, RentalContract, RepairOrder } from './types'

export type DashboardDataMode = 'local' | 'cloud'

export interface DashboardDataSources {
  localReadItems: () => RentalItem[]
  localReadStores: () => Store[]
  localReadContracts: () => RentalContract[]
  localReadRepairs: () => RepairOrder[]
  cloudReadDashboard: () => Promise<DashboardReadResult>
}

// ---------------------------------------------------------------------------
// local 数据 → raw 形状（复用统一聚合口径，避免 local/cloud 口径分叉）
// ---------------------------------------------------------------------------

function itemsToRaw(items: RentalItem[]): unknown {
  return items.map((i) => ({
    item_id: i.item_id,
    status: i.status,
    current_store_id: i.current_store_id,
  }))
}

function storesToRaw(stores: Store[]): unknown {
  return stores.map((s) => ({ store_id: s.store_id, store_name: s.store_name }))
}

function contractsToRaw(contracts: RentalContract[]): unknown {
  return contracts.map((c) => ({
    status: c.status,
    completed_at: c.completed_at,
    total_amount: c.total_amount,
  }))
}

function repairsToRaw(repairs: RepairOrder[]): unknown {
  return repairs.map((r) => ({
    status: r.status,
    request_date: r.request_date,
    repair_date: r.repair_date,
  }))
}

/** local 模式 KPI 聚合（复用 cloud 口径；local 数据已由 DataService 校验，理论上恒 ok）。 */
export function buildLocalDashboardKpi(
  sources: Pick<DashboardDataSources, 'localReadItems' | 'localReadStores' | 'localReadContracts' | 'localReadRepairs'>,
  todayStr: string,
): DashboardReadResult {
  return assembleDashboardKpi(
    itemsToRaw(sources.localReadItems()),
    storesToRaw(sources.localReadStores()),
    contractsToRaw(sources.localReadContracts()),
    repairsToRaw(sources.localReadRepairs()),
    todayStr,
  )
}

/** 完整云读取边界（fail-closed）：cloudReadDashboard 同步 throw / Promise reject 统一收口为安全错误。 */
export function safeCloudDashboardLoad(
  cloudRead: () => Promise<DashboardReadResult>,
): Promise<DashboardReadResult> {
  return safeCloudLoad(cloudRead, { ok: false, error: SAFE_DASHBOARD_ERROR })
}

// ---------------------------------------------------------------------------
// 分派（可辨识联合）：local 同步返回、cloud 返回永不 reject 的 Promise
// ---------------------------------------------------------------------------

export type DashboardLoadDispatch =
  | { kind: 'local'; result: DashboardReadResult }
  | { kind: 'cloud'; promise: Promise<DashboardReadResult> }

export function dispatchDashboardLoad(
  mode: DashboardDataMode,
  sources: DashboardDataSources,
  todayStr: string,
): DashboardLoadDispatch {
  if (mode === 'local') {
    return { kind: 'local', result: buildLocalDashboardKpi(sources, todayStr) }
  }
  return { kind: 'cloud', promise: safeCloudDashboardLoad(sources.cloudReadDashboard) }
}

/** 云读取结果落地为统一形态：失败 → null + 错误（绝不回退本地数据）。 */
export function settleDashboardRead(
  r: DashboardReadResult,
): { kpi: DashboardKpi | null; error: string | null } {
  if (r.ok) return { kpi: r.kpi, error: null }
  return { kpi: null, error: r.error }
}

// ---------------------------------------------------------------------------
// 展示辅助（纯函数，供 local/cloud 页面共用，可 Node 单测）
// ---------------------------------------------------------------------------

/** 利用率百分比文案：null → '—'；否则保留 1 位小数的百分数（如 37.5%） */
export function formatUtilizationRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 1000) / 10}%`
}
