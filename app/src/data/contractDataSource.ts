/**
 * 租赁合同数据源分派（纯逻辑，可注入 fake reader 做 Node 单测）。
 * 与 useContracts / useContractDetail 中 useDbData(enabled:false) 双重隔离，
 * 保证「cloud 模式绝不调用本地 reader、绝不回退 DataService / localStorage」。
 *
 * 类型约定：统一采用 cloudContracts 中的「只读视图模型」。local reader 返回的
 * 可写领域类型 RentalContract[] / ContractDetail 等结构性可赋值（本地恒写非空），
 * 故 local 模式经 buildContractListRows / mapLocalContractDetail 归一到视图模型，
 * local 的 CRUD 行为完全不受影响。
 */
import {
  SAFE_CONTRACT_ERROR,
  type ContractListReadResult,
  type ContractDetailReadResult,
  type ContractListRowView,
  type ContractDetailView,
  type CustomerRefView,
  type EmployeeRefView,
  type ItemRefView,
  type StoreRefView,
} from './cloudContracts'
import type {
  RentalContract,
  Customer,
  Employee,
  Store,
  RentalItem,
  ContractDetail,
} from './types'
import { safeCloudLoad } from './safeCloudLoad'

export type ContractDataMode = 'local' | 'cloud'

// ---------------------------------------------------------------------------
// 路由参数 contract_id 严格解析边界（纯函数，可测试）
// ---------------------------------------------------------------------------

/** 仅纯十进制数字（无符号/小数点/指数/空白/其它字符） */
const CONTRACT_ID_PARAM_RE = /^[0-9]+$/

/**
 * 路由参数 contract_id 严格解析：仅接受十进制正安全整数。
 * 以下一律判为非法并返回 null（页面据此显示「合同编号无效」，绝不继续查询）：
 * - 缺失 / 空字符串 / 非字符串
 * - 非纯数字：abc、指数形式（1e3）、小数（1.5）、Infinity、NaN、正负号、前后多余字符
 * - 0 / 负数
 * - 超出 Number.MAX_SAFE_INTEGER
 */
export function parseContractIdParam(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (!CONTRACT_ID_PARAM_RE.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

// ---------------------------------------------------------------------------
// 本地 reader 归一到视图模型（纯函数，供 local 模式复用）
// ---------------------------------------------------------------------------

/** 客户 → 精简引用视图 */
function toCustomerRef(c: Customer): CustomerRefView {
  return { customer_id: c.customer_id, full_name: c.full_name }
}

/** 员工 → 精简引用视图 */
function toEmployeeRef(e: Employee): EmployeeRefView {
  return { employee_id: e.employee_id, full_name: e.full_name }
}

/** 设备 → 精简引用视图（详情仅需编号/名称，金额一律用明细快照） */
function toItemRef(item: RentalItem): ItemRefView {
  return { item_id: item.item_id, item_code: item.item_code, name: item.name }
}

/** 门店 → 精简引用视图 */
function toStoreRef(s: Store): StoreRefView {
  return { store_id: s.store_id, store_name: s.store_name }
}

/**
 * 本地列表：合同 + 客户/员工姓名联立成列表行视图。
 * customer_name / employee_name 由 customer_id / employee_id 反查，查无回退空串
 * （与 cloud 端 assembleContractList 行为一致，外键完整性已由 DataService 保证）。
 */
export function buildContractListRows(
  contracts: RentalContract[],
  customers: Customer[],
  employees: Employee[],
): ContractListRowView[] {
  const customerName = new Map(customers.map((c) => [c.customer_id, c.full_name]))
  const employeeName = new Map(employees.map((e) => [e.employee_id, e.full_name]))
  return contracts.map((c) => ({
    ...c,
    customer_name: customerName.get(c.customer_id) ?? '',
    employee_name: employeeName.get(c.employee_id) ?? '',
  }))
}

/**
 * 本地详情：ContractDetail + 门店列表 归一到详情视图。
 * - customer / employee 收窄为精简引用视图；
 * - lines 仅保留 { line, item }（丢弃 checkout_store / return_store，门店名由
 *   页面经 stores 反查，与 cloud 端一致）；
 * - stores 随详情一并返回，供页面解析借出/归还门店名。
 */
export function mapLocalContractDetail(
  detail: ContractDetail | null,
  stores: Store[],
): ContractDetailView | null {
  if (detail === null) return null
  return {
    contract: detail.contract,
    customer: detail.customer ? toCustomerRef(detail.customer) : null,
    employee: detail.employee ? toEmployeeRef(detail.employee) : null,
    lines: detail.lines.map((l) => ({ line: l.line, item: l.item ? toItemRef(l.item) : null })),
    changes: detail.changes,
    stores: stores.map(toStoreRef),
  }
}

// ---------------------------------------------------------------------------
// 分派源（local 只读 reader + cloud 只读查询，二者互斥调用）
// ---------------------------------------------------------------------------

export interface ContractListSources {
  localReadContracts: () => RentalContract[]
  localReadCustomers: () => Customer[]
  localReadEmployees: () => Employee[]
  cloudReadContractList: () => Promise<ContractListReadResult>
}

export interface ContractDetailSources {
  localReadDetail: (contractId: number) => ContractDetail | null
  localReadStores: () => Store[]
  cloudReadContractDetail: (contractId: number) => Promise<ContractDetailReadResult>
}

// ---------------------------------------------------------------------------
// 安全云读取边界（fail-closed，复用通用 safeCloudLoad）
// ---------------------------------------------------------------------------

/** 列表：cloudReadContractList 同步 throw / Promise reject 统一收口为安全错误 */
export function safeCloudContractListLoad(
  sources: Pick<ContractListSources, 'cloudReadContractList'>,
): Promise<ContractListReadResult> {
  return safeCloudLoad(sources.cloudReadContractList, { ok: false, error: SAFE_CONTRACT_ERROR })
}

/** 详情：cloudReadContractDetail 同步 throw / Promise reject 统一收口为安全错误 */
export function safeCloudContractDetailLoad(
  contractId: number,
  sources: Pick<ContractDetailSources, 'cloudReadContractDetail'>,
): Promise<ContractDetailReadResult> {
  return safeCloudLoad(() => sources.cloudReadContractDetail(contractId), {
    ok: false,
    error: SAFE_CONTRACT_ERROR,
  })
}

// ---------------------------------------------------------------------------
// 分派（可辨识联合）：local 同步返回、cloud 返回永不 reject 的 Promise
// ---------------------------------------------------------------------------

export type ContractListDispatch =
  | { kind: 'local'; rows: ContractListRowView[] }
  | { kind: 'cloud'; promise: Promise<ContractListReadResult> }

export function dispatchContractListLoad(
  mode: 'local',
  sources: ContractListSources,
): { kind: 'local'; rows: ContractListRowView[] }
export function dispatchContractListLoad(
  mode: 'cloud',
  sources: ContractListSources,
): { kind: 'cloud'; promise: Promise<ContractListReadResult> }
export function dispatchContractListLoad(
  mode: ContractDataMode,
  sources: ContractListSources,
): ContractListDispatch {
  if (mode === 'local') {
    return {
      kind: 'local',
      rows: buildContractListRows(
        sources.localReadContracts(),
        sources.localReadCustomers(),
        sources.localReadEmployees(),
      ),
    }
  }
  return { kind: 'cloud', promise: safeCloudContractListLoad(sources) }
}

export type ContractDetailDispatch =
  | { kind: 'local'; detail: ContractDetailView | null }
  | { kind: 'cloud'; promise: Promise<ContractDetailReadResult> }

export function dispatchContractDetailLoad(
  mode: 'local',
  contractId: number,
  sources: ContractDetailSources,
): { kind: 'local'; detail: ContractDetailView | null }
export function dispatchContractDetailLoad(
  mode: 'cloud',
  contractId: number,
  sources: ContractDetailSources,
): { kind: 'cloud'; promise: Promise<ContractDetailReadResult> }
export function dispatchContractDetailLoad(
  mode: ContractDataMode,
  contractId: number,
  sources: ContractDetailSources,
): ContractDetailDispatch {
  if (mode === 'local') {
    const detail = sources.localReadDetail(contractId)
    if (detail === null) return { kind: 'local', detail: null }
    return { kind: 'local', detail: mapLocalContractDetail(detail, sources.localReadStores()) }
  }
  return { kind: 'cloud', promise: safeCloudContractDetailLoad(contractId, sources) }
}

// ---------------------------------------------------------------------------
// 云读取结果落地（绝不回退本地数据）
// ---------------------------------------------------------------------------

/** 列表落地：失败 → 空行 + 错误 */
export function settleContractListRead(
  r: ContractListReadResult,
): { rows: ContractListRowView[]; error: string | null } {
  if (r.ok) return { rows: r.rows, error: null }
  return { rows: [], error: r.error }
}

/**
 * 详情落地：
 * - ok 且 detail 非空 → found；
 * - ok 且 detail 为 null → notFound（查询成功但 contract_id 不存在）；
 * - 失败 → error（绝不把 notFound 与 error 混为一谈，绝不回退本地数据）。
 */
export function settleContractDetailRead(
  r: ContractDetailReadResult,
): { detail: ContractDetailView | null; error: string | null; notFound: boolean } {
  if (r.ok) {
    if (r.detail === null) return { detail: null, error: null, notFound: true }
    return { detail: r.detail, error: null, notFound: false }
  }
  return { detail: null, error: r.error, notFound: false }
}

// ---------------------------------------------------------------------------
// 详情云读取状态机 + 请求代次守卫（纯逻辑，供 useContractDetail 使用，Node 可单测）
// ---------------------------------------------------------------------------

/** 云端详情读取的「已解析」状态，与 contract_id 强绑定 */
export interface ContractDetailCloudState {
  resolvedId: number | null
  detail: ContractDetailView | null
  error: string | null
  notFound: boolean
}

export const INITIAL_CONTRACT_DETAIL_CLOUD_STATE: ContractDetailCloudState = {
  resolvedId: null,
  detail: null,
  error: null,
  notFound: false,
}

/** 渲染期视图（loading 由 resolvedId 与路由 ID 是否一致推导） */
export interface ContractDetailViewState {
  detail: ContractDetailView | null
  loading: boolean
  error: string | null
  notFound: boolean
}

/** 开始一次请求：清空已解析绑定（resolvedId=null），进入 loading 态，屏蔽旧详情 */
export function beginContractDetailCloudLoad(): ContractDetailCloudState {
  return { resolvedId: null, detail: null, error: null, notFound: false }
}

/** 一次请求落地：把解析结果绑定到本次请求的 contract_id */
export function settleContractDetailCloudState(
  result: ContractDetailReadResult,
  forContractId: number,
): ContractDetailCloudState {
  const s = settleContractDetailRead(result)
  return {
    resolvedId: forContractId,
    detail: s.detail,
    error: s.error,
    notFound: s.notFound,
  }
}

/**
 * 渲染期选择：state 所属 contract_id 与当前路由 ID 不一致时，一律视为 loading，
 * 屏蔽旧 detail / error / notFound，杜绝「切换 ID 闪现上一份合同」。
 */
export function selectContractDetailView(
  state: ContractDetailCloudState,
  forContractId: number,
): ContractDetailViewState {
  if (state.resolvedId !== forContractId) {
    return { detail: null, loading: true, error: null, notFound: false }
  }
  return {
    detail: state.detail,
    loading: false,
    error: state.error,
    notFound: state.notFound,
  }
}

/**
 * 请求代次守卫：后发请求才允许落地，旧请求晚到不得覆盖新请求。
 * useContractDetail 以 ref 持有；Node 侧可直接单测（不依赖 React）。
 */
export class LatestRequestGuard {
  private latest = 0
  begin(): number {
    this.latest += 1
    return this.latest
  }
  isLatest(token: number): boolean {
    return token === this.latest
  }
}
