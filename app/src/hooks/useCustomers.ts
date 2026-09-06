/**
 * 统一客户数据 Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listCustomers() + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 查询，提供 loading/data/error/retry；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）；
 * - cloud 模式绝不调用 dataService.listCustomers，也不订阅 DataService（useDbData enabled=false）。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryCustomers,
  type CustomerRdbClient,
} from '../data/cloudCustomers'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import { dispatchCustomerLoad, settleCloudRead } from '../data/customerDataSource'
import type { Customer } from '../data/types'

export interface CustomersResult {
  customers: Customer[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_CUSTOMERS: Customer[] = []

export function useCustomers(): CustomersResult {
  const isCloud = isCloudMode()

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  // 用字面量选项配合 useDbData 的类型收窄：cloud 分支 enabled:false 必须携带 disabledValue。
  const dbOptions: UseDbDataOptions<Customer[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_CUSTOMERS }
    : { enabled: true }
  const localCustomers = useDbData(() => dataService.listCustomers(), dbOptions)

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂“暂无客户”）
  const [cloudData, setCloudData] = useState<Customer[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchCustomerLoad('cloud', {
      localRead: () => dataService.listCustomers(),
      cloudRead: () => queryCustomers(getRdb() as unknown as CustomerRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleCloudRead(r)
      setCloudData(settled.customers)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  if (isCloud) {
    return { customers: cloudData, loading, error, retry }
  }
  return { customers: localCustomers, loading: false, error: null, retry }
}
