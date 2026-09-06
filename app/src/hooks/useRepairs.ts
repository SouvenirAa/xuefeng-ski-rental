/**
 * 维修单数据 Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listRepairs/listItems/listContractors/listContractorRates
 *   组装 RepairRowView + 原订阅刷新机制（useDbData enabled:true，写操作后版本递增触发重渲染）；
 * - cloud：按 SessionAccount.role 分派（admin/staff 直读四表、contractor 走 list_my_repairs RPC），
 *   提供 loading/data/error/retry；查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）；
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）。
 *
 * 返回 repairs 为 RepairRowView[]（设备编号/名称、承包商名称、冻结费率已联立），
 * local 与 cloud 结构一致，页面无需再自行反查。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import { useAuth } from '../auth/AuthContext'
import {
  queryRepairsAdmin,
  queryRepairsContractor,
  type RepairRowView,
} from '../data/cloudRepairs'
import type { MasterRdbClient } from '../data/cloudMaster'
import type { RepairRpcClient } from '../data/cloudRepairs'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  buildRepairRows,
  dispatchRepairLoad,
  settleRepairRead,
  type RepairRoleKind,
} from '../data/repairDataSource'

export interface RepairsResult {
  repairs: RepairRowView[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_ROWS: RepairRowView[] = []

export function useRepairs(): RepairsResult {
  const { role, account } = useAuth()
  const isCloud = isCloudMode()
  const myContractorId = account?.contractor_id ?? undefined
  // staff 与 admin 同走直读；contractor 走 RPC
  const roleKind: RepairRoleKind = role === 'contractor' ? 'contractor' : 'admin'

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  const listOptions: UseDbDataOptions<RepairRowView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_ROWS }
    : { enabled: true }
  const localRepairs = useDbData(
    () =>
      buildRepairRows(
        dataService.listRepairs(role ?? 'contractor', myContractorId),
        dataService.listItems(),
        dataService.listContractors(),
        dataService.listContractorRates(),
      ),
    listOptions,
  )

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂「暂无数据」）
  const [cloudRepairs, setCloudRepairs] = useState<RepairRowView[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchRepairLoad('cloud', roleKind, {
      localReadRepairs: () => dataService.listRepairs(role ?? 'contractor', myContractorId),
      localReadItems: () => dataService.listItems(),
      localReadContractors: () => dataService.listContractors(),
      localReadRates: () => dataService.listContractorRates(),
      cloudReadRepairsAdmin: () => queryRepairsAdmin(getRdb() as unknown as MasterRdbClient),
      cloudReadRepairsContractor: () =>
        queryRepairsContractor(getRdb() as unknown as RepairRpcClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleRepairRead(r)
      setCloudRepairs(settled.rows)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, roleKind, myContractorId, role, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  if (isCloud) {
    return { repairs: cloudRepairs, loading, error, retry }
  }
  return { repairs: localRepairs, loading: false, error: null, retry }
}
