/**
 * 统一基础资料（门店 / 技能等级 / 设备）Hook（local/cloud 双模式）。
 * - local：继续使用 dataService.listStores/listSkillLevels/listItems + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 三表查询（一并做关联校验），提供 loading/data/error/retry；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - 组件卸载或请求过期后不写入 React state（cancelled 防护）；
 * - cloud 模式绝不调用本地 reader，也不订阅 DataService（useDbData enabled=false）。
 *
 * 返回类型统一为只读视图模型（StoreView / RentalItemView）：云端可空字段（门店 address/phone、
 * 设备 description/purchase_date/purchase_cost/retail_price）显式建模为 null。local reader 返回的
 * 可写领域类型 Store[] / RentalItem[] 结构性可赋值（本地恒写非空），不改变 local CRUD 行为。
 */
import { useCallback, useEffect, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryMaster,
  type MasterRdbClient,
  type StoreView,
  type RentalItemView,
} from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import { dispatchMasterLoad, settleMasterRead } from '../data/masterDataSource'
import type { SkillLevel } from '../data/types'

export interface MasterDataResult {
  stores: StoreView[]
  skillLevels: SkillLevel[]
  items: RentalItemView[]
  loading: boolean
  error: string | null
  retry: () => void
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_STORES: StoreView[] = []
const EMPTY_SKILL_LEVELS: SkillLevel[] = []
const EMPTY_ITEMS: RentalItemView[] = []

export function useMasterData(): MasterDataResult {
  const isCloud = isCloudMode()

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  const storeOptions: UseDbDataOptions<StoreView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_STORES }
    : { enabled: true }
  const levelOptions: UseDbDataOptions<SkillLevel[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_SKILL_LEVELS }
    : { enabled: true }
  const itemOptions: UseDbDataOptions<RentalItemView[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_ITEMS }
    : { enabled: true }
  const localStores = useDbData(() => dataService.listStores(), storeOptions)
  const localLevels = useDbData(() => dataService.listSkillLevels(), levelOptions)
  const localItems = useDbData(() => dataService.listItems(), itemOptions)

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂「暂无数据」）
  const [cloudStores, setCloudStores] = useState<StoreView[]>([])
  const [cloudLevels, setCloudLevels] = useState<SkillLevel[]>([])
  const [cloudItems, setCloudItems] = useState<RentalItemView[]>([])
  const [loading, setLoading] = useState(isCloud)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const { promise } = dispatchMasterLoad('cloud', {
      localReadStores: () => dataService.listStores(),
      localReadSkillLevels: () => dataService.listSkillLevels(),
      localReadItems: () => dataService.listItems(),
      cloudReadMaster: () => queryMaster(getRdb() as unknown as MasterRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      const settled = settleMasterRead(r)
      setCloudStores(settled.data.stores)
      setCloudLevels(settled.data.skillLevels)
      setCloudItems(settled.data.items)
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
      stores: cloudStores,
      skillLevels: cloudLevels,
      items: cloudItems,
      loading,
      error,
      retry,
    }
  }
  return {
    stores: localStores,
    skillLevels: localLevels,
    items: localItems,
    loading: false,
    error: null,
    retry,
  }
}
