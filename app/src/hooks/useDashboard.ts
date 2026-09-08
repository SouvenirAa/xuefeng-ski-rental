/**
 * 驾驶舱 KPI 数据 Hook（local/cloud 双模式）。
 * - local：从 DataService 四表聚合（复用 cloudDashboard 的同一聚合口径）；
 * - cloud：异步查询 PostgreSQL 四表并聚合（显式列名、fail-closed），提供 loading/kpi/error/retry；
 * - 查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载后不写入 React state（cancelled 防护）。
 *
 * 仅 admin/staff 访问（路由层拦截 contractor）。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import { queryDashboardKpi, type DashboardKpi } from '../data/cloudDashboard'
import type { MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { dispatchDashboardLoad, settleDashboardRead } from '../data/dashboardDataSource'
import { today } from '../utils/format'

export interface DashboardResult {
  kpi: DashboardKpi | null
  loading: boolean
  error: string | null
  retry: () => void
}

export function useDashboard(): DashboardResult {
  const isCloud = isCloudMode()
  const [kpi, setKpi] = useState<DashboardKpi | null>(null)
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const todayStr = today()
    const dispatch = dispatchDashboardLoad(
      isCloud ? 'cloud' : 'local',
      {
        localReadItems: () => dataService.listItems(),
        localReadStores: () => dataService.listStores(),
        localReadContracts: () => dataService.listContracts(),
        localReadRepairs: () => dataService.listRepairs('admin'),
        cloudReadDashboard: () =>
          queryDashboardKpi(getRdb() as unknown as MasterRdbClient, todayStr),
      },
      todayStr,
    )

    if (dispatch.kind === 'local') {
      const settled = settleDashboardRead(dispatch.result)
      setKpi(settled.kpi)
      setError(settled.error)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    dispatch.promise.then((r) => {
      if (cancelled) return
      const settled = settleDashboardRead(r)
      setKpi(settled.kpi)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  return { kpi, loading, error, retry }
}
