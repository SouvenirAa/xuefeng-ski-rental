/**
 * 维修单数据源分派（纯逻辑，可注入计数型 fake reader 做 Node 单测）。
 * 与 useRepairs 中 useDbData(enabled:false) 双重隔离，保证「cloud 模式绝不调用本地
 * reader、绝不回退 DataService / localStorage」。
 *
 * 类型约定：统一采用 cloudRepairs 中的「只读视图模型」RepairRowView。
 * local reader 返回的可写领域类型 RepairOrder[] / RentalItem[] / Contractor[] /
 * ContractorRate[] 经 buildRepairRows 归一到视图模型（组装设备编号/名称、承包商名称、
 * 冻结费率），local 的写操作（新增/开始/完成）行为完全不受影响。
 */
import {
  SAFE_REPAIR_ERROR,
  type RepairReadResult,
  type RepairRowView,
} from './cloudRepairs'
import type { RepairOrder, RentalItem, Contractor, ContractorRate } from './types'
import { safeCloudLoad } from './safeCloudLoad'

export type RepairDataMode = 'local' | 'cloud'

/**
 * 角色分派类别：
 * - 'admin'：admin / staff 均直读四表（repair_orders + 三张引用表）；
 * - 'contractor'：必须经 list_my_repairs RPC 读取本人维修单。
 */
export type RepairRoleKind = 'admin' | 'contractor'

export interface RepairDataSources {
  localReadRepairs: () => RepairOrder[]
  localReadItems: () => RentalItem[]
  localReadContractors: () => Contractor[]
  localReadRates: () => ContractorRate[]
  cloudReadRepairsAdmin: () => Promise<RepairReadResult>
  cloudReadRepairsContractor: () => Promise<RepairReadResult>
}

// ---------------------------------------------------------------------------
// 本地 reader 归一到视图模型（纯函数，供 local 模式复用）
// ---------------------------------------------------------------------------

/**
 * 本地维修单列表：repair + 设备编号/名称 + 承包商名称 + 冻结费率 联立成统一视图。
 * item_code / item_name / contractor_name / rate_hourly 由外键反查，查无回退空串 / 0
 * （与 cloud 端结构一致；外键完整性已由 DataService + validateDatabase 保证，实际不会缺失）。
 */
export function buildRepairRows(
  repairs: RepairOrder[],
  items: RentalItem[],
  contractors: Contractor[],
  rates: ContractorRate[],
): RepairRowView[] {
  const itemById = new Map(items.map((i) => [i.item_id, i]))
  const contractorById = new Map(contractors.map((c) => [c.contractor_id, c]))
  const rateById = new Map(rates.map((r) => [r.rate_id, r]))
  return repairs
    .map((r) => {
      const item = itemById.get(r.item_id)
      const contractor = contractorById.get(r.contractor_id)
      const rate = rateById.get(r.rate_id)
      return {
        repair_id: r.repair_id,
        item_id: r.item_id,
        item_code: item?.item_code ?? '',
        item_name: item?.name ?? '',
        contractor_id: r.contractor_id,
        contractor_name: contractor?.name ?? '',
        rate_id: r.rate_id,
        rate_hourly: rate?.hourly_rate ?? 0,
        request_date: r.request_date,
        fault_description: r.fault_description,
        repair_date: r.repair_date,
        repair_hours: r.repair_hours,
        calculated_cost: r.calculated_cost,
        notes: r.notes,
        status: r.status,
      }
    })
    .sort((a, b) => a.repair_id - b.repair_id)
}

// ---------------------------------------------------------------------------
// 安全云读取边界（fail-closed，复用通用 safeCloudLoad）
// ---------------------------------------------------------------------------

/**
 * 完整云读取边界：cloudRead 同步 throw（如 getRdb() 同步抛错）/ Promise reject（SDK 网络异常）
 * 统一收口为 { ok:false, error:SAFE_REPAIR_ERROR }，返回的 Promise 永不 reject。
 * 绝不调用本地 reader、绝不回退 DataService/localStorage。
 */
export function safeCloudRepairLoad(
  cloudRead: () => Promise<RepairReadResult>,
): Promise<RepairReadResult> {
  return safeCloudLoad(cloudRead, { ok: false, error: SAFE_REPAIR_ERROR })
}

// ---------------------------------------------------------------------------
// 分派（可辨识联合）：local 同步返回、cloud 按角色返回永不 reject 的 Promise
// ---------------------------------------------------------------------------

export type RepairLoadDispatch =
  | { kind: 'local'; rows: RepairRowView[] }
  | { kind: 'cloud'; promise: Promise<RepairReadResult> }

export function dispatchRepairLoad(
  mode: 'local',
  roleKind: RepairRoleKind,
  sources: RepairDataSources,
): { kind: 'local'; rows: RepairRowView[] }
export function dispatchRepairLoad(
  mode: 'cloud',
  roleKind: RepairRoleKind,
  sources: RepairDataSources,
): { kind: 'cloud'; promise: Promise<RepairReadResult> }
export function dispatchRepairLoad(
  mode: RepairDataMode,
  roleKind: RepairRoleKind,
  sources: RepairDataSources,
): RepairLoadDispatch {
  if (mode === 'local') {
    return {
      kind: 'local',
      rows: buildRepairRows(
        sources.localReadRepairs(),
        sources.localReadItems(),
        sources.localReadContractors(),
        sources.localReadRates(),
      ),
    }
  }
  const cloudRead =
    roleKind === 'contractor' ? sources.cloudReadRepairsContractor : sources.cloudReadRepairsAdmin
  return { kind: 'cloud', promise: safeCloudRepairLoad(cloudRead) }
}

/** 云读取结果落地为统一形态：失败 → 空数据 + 错误（绝不回退本地数据）。 */
export function settleRepairRead(
  r: RepairReadResult,
): { rows: RepairRowView[]; error: string | null } {
  if (r.ok) return { rows: r.rows, error: null }
  return { rows: [], error: r.error }
}

// ---------------------------------------------------------------------------
// 承包商筛选（纯函数，供 local/cloud 页面共用，可 Node 单测）
// ---------------------------------------------------------------------------

export interface RepairContractorFilterOption {
  label: string
  value: string
}

/**
 * 从已加载的维修记录中生成「去重后的承包商筛选选项」：
 * - 排除 contractor_id === null 的行（contractor RPC 路径不返回内部 ID）；
 * - 相同 contractor_id 只保留一次；
 * - 按 contractor_id 升序保证顺序稳定；
 * - label 取 contractor_name（缺失回退为「承包商 #id」）。
 */
export function buildRepairContractorFilterOptions(
  rows: RepairRowView[],
): RepairContractorFilterOption[] {
  const byId = new Map<number, string>()
  for (const r of rows) {
    if (r.contractor_id === null) continue
    if (!byId.has(r.contractor_id)) {
      byId.set(r.contractor_id, r.contractor_name || `承包商 #${r.contractor_id}`)
    }
  }
  return [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, name]) => ({ label: name, value: String(id) }))
}

/**
 * 按承包商筛选维修单：
 * - filterContractor 为空串表示不筛选；
 * - 选中后仅保留 contractor_id 严格匹配的行；
 * - contractor_id === null 的行在已选择筛选条件时被排除（绝不因 null 被错误放行）。
 */
export function filterRepairsByContractor(
  rows: RepairRowView[],
  filterContractor: string,
): RepairRowView[] {
  if (!filterContractor) return rows
  return rows.filter(
    (r) => r.contractor_id !== null && String(r.contractor_id) === filterContractor,
  )
}
