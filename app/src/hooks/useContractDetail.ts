/**
 * 租赁合同详情 Hook（local/cloud 双模式），区分 loading / error / notFound / found / invalid 五态。
 * - local：继续使用 dataService.getContractDetail + listStores + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 七表查询（合同/明细/变更/客户/员工/设备/门店，
 *   一并做换货组结构与差价复算、total_amount 复算、时间顺序、完成态等全套校验），
 *   查询失败只返回错误与重试，绝不回退本地数据；
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
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  mapLocalContractDetail,
  dispatchContractDetailLoad,
  INITIAL_CONTRACT_DETAIL_CLOUD_STATE,
  beginContractDetailCloudLoad,
  settleContractDetailCloudState,
  selectContractDetailView,
  LatestRequestGuard,
  type ContractDetailCloudState,
} from '../data/contractDataSource'

export interface ContractDetailResult {
  detail: ContractDetailView | null
  loading: boolean
  error: string | null
  notFound: boolean
  invalid: boolean
  retry: () => void
}

const NULL_DETAIL: ContractDetailView | null = null

export function useContractDetail(contractId: number | null): ContractDetailResult {
  const isCloud = isCloudMode()

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

  // 非法 ID：绝不调用任何 reader，返回 invalid 空状态（与 loading/error/notFound 严格区分）。
  if (contractId === null) {
    return { detail: null, loading: false, error: null, notFound: false, invalid: true, retry }
  }

  if (isCloud) {
    const view = selectContractDetailView(cloudState, contractId)
    return { ...view, invalid: false, retry }
  }

  return {
    detail: localDetail,
    loading: false,
    error: null,
    notFound: localDetail === null,
    invalid: false,
    retry,
  }
}
