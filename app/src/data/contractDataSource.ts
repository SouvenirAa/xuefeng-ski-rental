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
  OpResult,
} from './types'
import {
  validateCreateContractFields,
  validateExchangeFields,
  validateReturnFields,
  SAFE_CONTRACT_WRITE_ERROR,
  CONTRACT_PERMISSION_ERROR,
  type ContractCreateCloudInput,
  type ContractExchangeCloudInput,
  type ContractReturnCloudInput,
  type ContractRpcClient,
} from './cloudContractMutations'
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

// ---------------------------------------------------------------------------
// 合同写操作分派（local / cloud 双模式，cloud 仅 RPC，fail-closed，可独立单测）
// ---------------------------------------------------------------------------

/**
 * 按模式分派合同写操作（低层）：
 * - local：调用 localRun 恰好一次（同步 OpResult），绝不触碰 getRpcFn / cloudRun；
 * - cloud：先求值 getRpcFn（同步 throw 时 fail-closed），再执行 cloudRun（内部仅 rdb.rpc）；
 *   失败返回 fallback，绝不调用 localRun、绝不回退 DataService/localStorage。
 * 返回 Promise 永不 reject。
 */
export async function dispatchContractMutation<T>(
  mode: ContractDataMode,
  getRpcFn: () => ContractRpcClient,
  cloudRun: (rpc: ContractRpcClient) => Promise<T>,
  localRun: () => T,
  fallback: T,
): Promise<T> {
  if (mode === 'local') {
    return localRun()
  }
  try {
    const rpc = getRpcFn()
    return await cloudRun(rpc)
  } catch {
    return fallback
  }
}

/**
 * 创建合同写操作分派（在 getRpcFn / cloudRun / rpc 之前执行完整前置校验）。
 * - cloud：先角色门禁（canWrite，非 admin/staff 立即返回无权限错误），再
 *   validateCreateContractFields(input)；任一失败立即返回安全/字段级错误
 *   （getRpcFn / cloudRun / rpc 均 0 次、不回退本地）；
 *   通过后才 getRpc → cloudRun（cloudRun 内 createContract 仍会再校验作为纵深防护）。
 * - local：不执行 canWrite / 字段前置校验（local 由 dataService 内部校验），不回归。
 * 返回 Promise 永不 reject。
 */
export async function dispatchContractCreateMutation(
  mode: ContractDataMode,
  canWrite: boolean,
  input: ContractCreateCloudInput,
  getRpcFn: () => ContractRpcClient,
  cloudRun: (rpc: ContractRpcClient) => Promise<OpResult<{ contract_id: number }>>,
  localRun: () => OpResult<{ contract_id: number }>,
): Promise<OpResult<{ contract_id: number }>> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: CONTRACT_PERMISSION_ERROR }
    }
    const v = validateCreateContractFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractMutation<OpResult<{ contract_id: number }>>(
    mode,
    getRpcFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_CONTRACT_WRITE_ERROR },
  )
}

/** 换货写操作分派（cloud：角色门禁 + validateExchangeFields，在 rpc 之前） */
export async function dispatchContractExchangeMutation(
  mode: ContractDataMode,
  canWrite: boolean,
  input: ContractExchangeCloudInput,
  getRpcFn: () => ContractRpcClient,
  cloudRun: (rpc: ContractRpcClient) => Promise<OpResult>,
  localRun: () => OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: CONTRACT_PERMISSION_ERROR }
    }
    const v = validateExchangeFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractMutation<OpResult>(
    mode,
    getRpcFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_CONTRACT_WRITE_ERROR },
  )
}

/** 归还写操作分派（cloud：角色门禁 + validateReturnFields，在 rpc 之前） */
export async function dispatchContractReturnMutation(
  mode: ContractDataMode,
  canWrite: boolean,
  input: ContractReturnCloudInput,
  getRpcFn: () => ContractRpcClient,
  cloudRun: (rpc: ContractRpcClient) => Promise<OpResult>,
  localRun: () => OpResult,
): Promise<OpResult> {
  if (mode === 'cloud') {
    if (!canWrite) {
      return { ok: false, error: CONTRACT_PERMISSION_ERROR }
    }
    const v = validateReturnFields(input)
    if (!v.ok) return { ok: false, error: v.error, field: v.field }
  }
  return dispatchContractMutation<OpResult>(
    mode,
    getRpcFn,
    cloudRun,
    localRun,
    { ok: false, error: SAFE_CONTRACT_WRITE_ERROR },
  )
}

// ---------------------------------------------------------------------------
// 并发锁与云端读刷新控制器
// ---------------------------------------------------------------------------

/**
 * 合同写操作互斥锁：防止重复提交（同步 tryAcquire/release，Node 可单测）。
 * 与 masterDataSource.MutationLock 同构，作为合同模块的独立并发锁，避免反向依赖。
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
 *   （旧查询无论何时 resolve 都不能覆盖新结果），第二步调用 refetch。
 * - isActive 由调用方注入（useContractDetail 传入 `() => mountedRef.current`）：
 *   组件已卸载（active=false）时，不失效 token、不推进代次、不 refetch、不写任何状态。
 */
export class CloudContractRefresh {
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
