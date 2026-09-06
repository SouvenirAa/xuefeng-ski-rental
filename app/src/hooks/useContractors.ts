/**
 * 承包商 / 费率数据 Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listContractors/listContractorRates + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 两表查询（一并做关联校验），提供 loading/data/error/retry；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）；
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）。
 *
 * 返回类型统一为只读视图模型（ContractorView / ContractorRateView）：云端可空字段
 * （address/phone/email）显式建模为 null。local reader 返回的可写领域类型结构性可赋值，
 * 不改变 local CRUD 行为。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryContractorsWithRates,
  type ContractorView,
  type ContractorRateView,
} from '../data/cloudContractors'
import type { MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import { dispatchContractorLoad, settleContractorRead } from '../data/contractorDataSource'

export interface ContractorsResult {
  contractors: ContractorView[]
  rates: ContractorRateView[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_CONTRACTORS: ContractorView[] = []
const EMPTY_RATES: ContractorRateView[] = []

export function useContractors(): ContractorsResult {
  const isCloud = isCloudMode()

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  const contractorOptions: UseDbDataOptions<ContractorView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_CONTRACTORS }
    : { enabled: true }
  const rateOptions: UseDbDataOptions<ContractorRateView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_RATES }
    : { enabled: true }
  const localContractors = useDbData(() => dataService.listContractors(), contractorOptions)
  const localRates = useDbData(() => dataService.listContractorRates(), rateOptions)

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂「暂无数据」）
  const [cloudContractors, setCloudContractors] = useState<ContractorView[]>([])
  const [cloudRates, setCloudRates] = useState<ContractorRateView[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchContractorLoad('cloud', {
      localReadContractors: () => dataService.listContractors(),
      localReadRates: () => dataService.listContractorRates(),
      cloudReadContractors: () => queryContractorsWithRates(getRdb() as unknown as MasterRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleContractorRead(r)
      setCloudContractors(settled.data.contractors)
      setCloudRates(settled.data.rates)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  if (isCloud) {
    return { contractors: cloudContractors, rates: cloudRates, loading, error, retry }
  }
  return { contractors: localContractors, rates: localRates, loading: false, error: null, retry }
}
