/**
 * 租赁合同列表 Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listContracts/listCustomers/listEmployees + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 三表查询（合同 + 客户/员工，一并做关联完整性校验），
 *   提供 loading/data/error/retry；查询失败只返回错误与重试，绝不回退本地数据；
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）。
 *
 * 返回 contracts 为 ContractListRowView[]（合同 + 客户名/员工名已联立），
 * local 与 cloud 结构一致，页面无需再自行反查姓名。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import type { ContractListRowView } from '../data/cloudContracts'
import { queryContractList } from '../data/cloudContracts'
import type { MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  buildContractListRows,
  dispatchContractListLoad,
  settleContractListRead,
} from '../data/contractDataSource'

export interface ContractsResult {
  contracts: ContractListRowView[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_ROWS: ContractListRowView[] = []

export function useContracts(): ContractsResult {
  const isCloud = isCloudMode()

  const listOptions: UseDbDataOptions<ContractListRowView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_ROWS }
    : { enabled: true }
  const localContracts = useDbData(
    () => buildContractListRows(
      dataService.listContracts(),
      dataService.listCustomers(),
      dataService.listEmployees(),
    ),
    listOptions,
  )

  const [cloudContracts, setCloudContracts] = useState<ContractListRowView[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchContractListLoad('cloud', {
      localReadContracts: () => dataService.listContracts(),
      localReadCustomers: () => dataService.listCustomers(),
      localReadEmployees: () => dataService.listEmployees(),
      cloudReadContractList: () => queryContractList(getRdb() as unknown as MasterRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleContractListRead(r)
      setCloudContracts(settled.rows)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  if (isCloud) {
    return { contracts: cloudContracts, loading, error, retry }
  }
  return { contracts: localContracts, loading: false, error: null, retry }
}
