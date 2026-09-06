/**
 * 员工 / 排班 / 门店数据 Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listEmployees/listShifts/listStores + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 三表查询（一并做关联 / 业务约束校验），提供 loading/data/error/retry；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）；
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）。
 *
 * 复用策略：员工页只查询 employees / shifts / stores，不触碰设备 / 技能等级
 * （不使用 useMasterData），避免无关设备错误拖垮员工页。
 *
 * 返回类型统一为只读视图模型（EmployeeView / ShiftView），门店复用 StoreView：
 * 云端可空字段（address/phone/email/notes）显式建模为 null。local reader 返回的
 * 可写领域类型结构性可赋值，不改变 local CRUD 行为。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryWorkforce,
  type EmployeeView,
  type ShiftView,
} from '../data/cloudWorkforce'
import type { StoreView, MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import { dispatchWorkforceLoad, settleWorkforceRead } from '../data/workforceDataSource'

export interface WorkforceResult {
  employees: EmployeeView[]
  shifts: ShiftView[]
  stores: StoreView[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_EMPLOYEES: EmployeeView[] = []
const EMPTY_SHIFTS: ShiftView[] = []
const EMPTY_STORES: StoreView[] = []

export function useWorkforce(): WorkforceResult {
  const isCloud = isCloudMode()

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  const employeeOptions: UseDbDataOptions<EmployeeView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_EMPLOYEES }
    : { enabled: true }
  const shiftOptions: UseDbDataOptions<ShiftView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_SHIFTS }
    : { enabled: true }
  const storeOptions: UseDbDataOptions<StoreView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_STORES }
    : { enabled: true }
  const localEmployees = useDbData(() => dataService.listEmployees(), employeeOptions)
  const localShifts = useDbData(() => dataService.listShifts(), shiftOptions)
  const localStores = useDbData(() => dataService.listStores(), storeOptions)

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂「暂无数据」）
  const [cloudEmployees, setCloudEmployees] = useState<EmployeeView[]>([])
  const [cloudShifts, setCloudShifts] = useState<ShiftView[]>([])
  const [cloudStores, setCloudStores] = useState<StoreView[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchWorkforceLoad('cloud', {
      localReadEmployees: () => dataService.listEmployees(),
      localReadShifts: () => dataService.listShifts(),
      localReadStores: () => dataService.listStores(),
      cloudReadWorkforce: () => queryWorkforce(getRdb() as unknown as MasterRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleWorkforceRead(r)
      setCloudEmployees(settled.data.employees)
      setCloudShifts(settled.data.shifts)
      setCloudStores(settled.data.stores)
      setError(settled.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isCloud, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  if (isCloud) {
    return {
      employees: cloudEmployees,
      shifts: cloudShifts,
      stores: cloudStores,
      loading,
      error,
      retry,
    }
  }
  return {
    employees: localEmployees,
    shifts: localShifts,
    stores: localStores,
    loading: false,
    error: null,
    retry,
  }
}
