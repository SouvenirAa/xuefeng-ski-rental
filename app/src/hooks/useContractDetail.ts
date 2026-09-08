/**
 * 租赁合同详情 Hook（local/cloud 双模式），区分 loading / error / notFound / found / invalid 五态，
 * 并含换货 / 归还写操作（cloud 仅受控 RPC）。
 * - local：继续使用 dataService.getContractDetail + listStores + exchangeItem/returnItems
 *   + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 七表查询（合同/明细/变更/客户/员工/设备/门店，
 *   一并做换货组结构与差价复算、total_amount 复算、时间顺序、完成态等全套校验），
 *   查询失败只返回错误与重试，绝不回退本地数据；
 * - cloud 换货/归还写操作仅经受控 SECURITY DEFINER RPC（exchange_item / return_items），
 *   绝不直接对封闭业务表做 DML；写成功后立即失效旧读 token 并重新查询详情，
 *   不做内存假成功；写失败绝不回退 DataService/localStorage；
 * - cloud 写权限门禁：换货/归还仅 admin/staff（与 RLS 封闭表 + RPC 角色校验一致），
 *   无权角色在 getRdb/rpc 前拒绝；local 模式由 dataService 内部按角色收敛。
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护卸载 + LatestRequestGuard 防护请求竞争）；
 * - loading 期间 notFound 必为 false，绝不在加载中误显示「合同不存在」。
 *
 * 本批补漏增强：
 * - 入参改为 number | null（非法路由 ID 已由 parseContractIdParam 在页面层解析为 null）；
 * - contractId 为 null（非法）时：绝不调用 getRdb、本地 reader、不注册 DataService 订阅，
 *   直接返回 invalid 空状态（与 loading / error / notFound 严格区分）；
 * - 异步状态与 contract_id 强绑定：resolvedId 与路由 ID 不一致时立即返回 loading，
 *   屏蔽旧 detail / error / notFound（切换 ID 不闪现上一份合同）；
 * - 请求代次守卫（LatestRequestGuard）：旧请求晚到不得覆盖新请求；
 * - retry 只重试当前 ID；所有 Hook 固定顺序，无任何条件调用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import type { ContractDetailView } from '../data/cloudContracts'
import { queryContractDetail } from '../data/cloudContracts'
import type { MasterRdbClient } from '../data/cloudMaster'
import {
  exchangeItem as cloudExchangeItem,
  returnItems as cloudReturnItems,
  type ContractExchangeCloudInput,
  type ContractReturnCloudInput,
  type ContractRpcClient,
} from '../data/cloudContractMutations'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useAuth } from '../auth/AuthContext'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  mapLocalContractDetail,
  dispatchContractDetailLoad,
  dispatchContractExchangeMutation,
  dispatchContractReturnMutation,
  INITIAL_CONTRACT_DETAIL_CLOUD_STATE,
  beginContractDetailCloudLoad,
  settleContractDetailCloudState,
  selectContractDetailView,
  LatestRequestGuard,
  MutationLock,
  CloudContractRefresh,
  type ContractDetailCloudState,
} from '../data/contractDataSource'
import type { OpResult } from '../data/types'

export interface ContractDetailResult {
  detail: ContractDetailView | null
  loading: boolean
  error: string | null
  notFound: boolean
  invalid: boolean
  retry: () => void
  /** 换货（local/cloud 统一 OpResult） */
  exchangeItem: (input: ContractExchangeCloudInput) => Promise<OpResult>
  /** 归还（local/cloud 统一 OpResult） */
  returnItems: (input: ContractReturnCloudInput) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

const NULL_DETAIL: ContractDetailView | null = null

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useContractDetail(contractId: number | null): ContractDetailResult {
  const isCloud = isCloudMode()
  const { role } = useAuth()

  // cloud 写权限门禁：换货/归还仅 admin/staff（local 模式不使用该门禁）。
  const canWrite = role === 'admin' || role === 'staff'

  // 本地 reader：仅 local 且 contractId 合法时才启用；非法 ID 或 cloud 模式一律零订阅零 read。
  const detailOptions: UseDbDataOptions<ContractDetailView | null> =
    isCloud || contractId === null
      ? { enabled: false, disabledValue: NULL_DETAIL }
      : { enabled: true }
  const localDetail = useDbData(
    () =>
      contractId === null
        ? NULL_DETAIL
        : mapLocalContractDetail(
            dataService.getContractDetail(contractId),
            dataService.listStores(),
          ),
    detailOptions,
  )

  const [cloudState, setCloudState] = useState<ContractDetailCloudState>(
    INITIAL_CONTRACT_DETAIL_CLOUD_STATE,
  )
  const guardRef = useRef<LatestRequestGuard | null>(null)
  if (guardRef.current === null) guardRef.current = new LatestRequestGuard()
  const [tick, setTick] = useState(0)

  // 写操作并发状态（互斥锁 + UI loading）+ 卸载防护
  const lockRef = useRef<MutationLock | null>(null)
  if (lockRef.current === null) lockRef.current = new MutationLock()
  const [mutating, setMutating] = useState(false)
  const mountedRef = useRef(true)

  // 刷新控制器：mutation 成功后立即失效旧读 token 再触发重读（可测试纯逻辑，ref 持有唯一实例）。
  const refreshRef = useRef<CloudContractRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudContractRefresh(
      guardRef.current,
      () => {
        if (!mountedRef.current) return
        setTick((t) => t + 1)
      },
      () => mountedRef.current,
    )
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isCloud || contractId === null) return
    let cancelled = false // 组件卸载 / 依赖切换后置位，防止卸载后写 state
    const token = guardRef.current!.begin()
    setCloudState(() => beginContractDetailCloudLoad())
    const { promise } = dispatchContractDetailLoad('cloud', contractId, {
      localReadDetail: (id) => dataService.getContractDetail(id),
      localReadStores: () => dataService.listStores(),
      cloudReadContractDetail: (id) => queryContractDetail(getRdb() as unknown as MasterRdbClient, id),
    })
    promise.then((r) => {
      if (cancelled) return
      // 旧请求晚到（已发起更新代次的请求）→ 丢弃，绝不覆盖新请求结果。
      if (!guardRef.current!.isLatest(token)) return
      setCloudState(() => settleContractDetailCloudState(r, contractId))
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, contractId, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  /** 写操作前同步互斥：已在提交中则拒绝 */
  const beginMutation = useCallback((): boolean => {
    if (!lockRef.current!.tryAcquire()) return false
    if (mountedRef.current) setMutating(true)
    return true
  }, [])

  const endMutation = useCallback(() => {
    lockRef.current!.release()
    if (mountedRef.current) setMutating(false)
  }, [])

  const exchangeItem = useCallback(
    async (input: ContractExchangeCloudInput): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchContractExchangeMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          () => getRdb() as unknown as ContractRpcClient,
          (rpc) => cloudExchangeItem(rpc, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            const r = dataService.exchangeItem(role, input)
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: undefined }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const returnItems = useCallback(
    async (input: ContractReturnCloudInput): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchContractReturnMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          () => getRdb() as unknown as ContractRpcClient,
          (rpc) => cloudReturnItems(rpc, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            const r = dataService.returnItems(role, input)
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: undefined }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  // 非法 ID：绝不调用任何 reader，返回 invalid 空状态（与 loading/error/notFound 严格区分）。
  if (contractId === null) {
    return {
      detail: null,
      loading: false,
      error: null,
      notFound: false,
      invalid: true,
      retry,
      exchangeItem,
      returnItems,
      mutating,
    }
  }

  if (isCloud) {
    const view = selectContractDetailView(cloudState, contractId)
    return { ...view, invalid: false, retry, exchangeItem, returnItems, mutating }
  }

  return {
    detail: localDetail,
    loading: false,
    error: null,
    notFound: localDetail === null,
    invalid: false,
    retry,
    exchangeItem,
    returnItems,
    mutating,
  }
}
