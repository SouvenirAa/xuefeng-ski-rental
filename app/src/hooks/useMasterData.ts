/**
 * 统一基础资料（门店 / 技能等级 / 设备）Hook（local/cloud 双模式），含只读列表 + 设备写操作（create/update/remove）。
 * - local：继续使用 dataService.listStores/listSkillLevels/listItems + createItem/updateItem/removeItem
 *   + 原订阅刷新机制（写成功后 DataService notify → useDbData 订阅刷新）；
 * - cloud：异步调用真实 PostgreSQL 三表查询（一并做关联校验）+ 设备写操作，
 *   提供 loading/data/error/retry + mutating；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - cloud 写失败绝不回退 DataService/localStorage，只返回安全错误；
 * - cloud 写成功后必须重新查询 PostgreSQL（setTick 触发重读三表），不做内存假成功；
 * - 防止重复提交（MutationLock 同步互斥）；组件卸载或请求过期后不写入 React state
 *   （cancelled 防护卸载 + LatestRequestGuard 防护请求竞争：旧查询不得覆盖 mutation 后新结果）；
 * - cloud 模式绝不调用任何 DataService 设备写方法、不订阅 DataService（useDbData enabled=false）。
 *
 * local/cloud 输入边界：mutation 统一接收 cloud 可空输入 RentalItemCloudInput；
 * local 模式经 masterDataSource.toLocalItemInput 转换为本地非空 RentalItemInput，
 * 保持 local 领域类型与 CRUD 行为不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryMaster,
  type MasterRdbClient,
  type StoreView,
  type RentalItemView,
} from '../data/cloudMaster'
import {
  createItem,
  updateItem,
  removeItem,
  validateItemBasics,
  SAFE_ITEM_WRITE_ERROR,
  type RentalItemCloudInput,
  type ItemRdbMutationClient,
} from '../data/cloudItemMutations'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useAuth } from '../auth/AuthContext'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  dispatchMasterLoad,
  dispatchMasterMutation,
  dispatchMasterItemMutation,
  settleMasterRead,
  toLocalItemInput,
  MutationLock,
  CloudMasterRefresh,
} from '../data/masterDataSource'
import { LatestRequestGuard } from '../data/contractDataSource'
import type { OpResult, SkillLevel } from '../data/types'

export interface MasterDataResult {
  stores: StoreView[]
  skillLevels: SkillLevel[]
  items: RentalItemView[]
  loading: boolean
  error: string | null
  retry: () => void
  /** 新增设备（local/cloud 统一 OpResult，输入为 cloud 可空类型） */
  create: (input: RentalItemCloudInput) => Promise<OpResult<RentalItemView>>
  /** 编辑设备（item_id 由页面从已校验的列表行传入） */
  update: (itemId: number, input: RentalItemCloudInput) => Promise<OpResult<RentalItemView>>
  /** 删除设备 */
  remove: (itemId: number) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_STORES: StoreView[] = []
const EMPTY_SKILL_LEVELS: SkillLevel[] = []
const EMPTY_ITEMS: RentalItemView[] = []

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useMasterData(): MasterDataResult {
  const isCloud = isCloudMode()
  const { role } = useAuth()

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

  // 写操作并发状态（互斥锁 + UI loading）
  const lockRef = useRef<MutationLock | null>(null)
  if (lockRef.current === null) lockRef.current = new MutationLock()
  const [mutating, setMutating] = useState(false)

  // 读请求代次守卫（旧查询不得覆盖 mutation 后新结果）+ 卸载防护
  const guardRef = useRef<LatestRequestGuard | null>(null)
  if (guardRef.current === null) guardRef.current = new LatestRequestGuard()
  const mountedRef = useRef(true)

  // 刷新控制器：mutation 成功后立即失效旧读 token 再触发重读（可测试纯逻辑，ref 持有唯一实例）。
  // - isActive 注入 `() => mountedRef.current`：组件已卸载则不失效 token、不推进代次、不 refetch；
  // - refetch 回调内部整体 fail-closed：卸载后再兜底 return，避免 setLoading/setError/setTick 写卸载后状态。
  const refreshRef = useRef<CloudMasterRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudMasterRefresh(
      guardRef.current,
      () => {
        if (!mountedRef.current) return
        setLoading(true)
        setError(null)
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

  // cloud 外键预校验集合（由已加载的云端门店 / 技能等级派生）
  const cloudStoreIds = useMemo(() => new Set(cloudStores.map((s) => s.store_id)), [cloudStores])
  const cloudLevelIds = useMemo(
    () => new Set(cloudLevels.map((l) => l.skill_level_id)),
    [cloudLevels],
  )

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    const token = guardRef.current!.begin()
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
      if (!guardRef.current!.isLatest(token)) return
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

  const create = useCallback(
    async (input: RentalItemCloudInput): Promise<OpResult<RentalItemView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        // cloud：dispatchMasterItemMutation 在 getRdb/cloudRun 之前先执行完整 validateItemFields，
        // 校验失败返回字段错误（getRdb/cloudRun/rdb.from 均 0 次，不触发刷新）；local 仍由 localRun 内部校验。
        const result = await dispatchMasterItemMutation(
          isCloud ? 'cloud' : 'local',
          input,
          cloudStoreIds,
          cloudLevelIds,
          () => getRdb() as unknown as ItemRdbMutationClient,
          (rdb) => createItem(rdb, input, cloudStoreIds, cloudLevelIds),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<RentalItemView>
            const basics = validateItemBasics(input)
            if (!basics.ok) return { ok: false, error: basics.error, field: basics.field }
            const r = dataService.createItem(role, toLocalItemInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        // 成功（仅 cloud）→ 立即失效旧读 token 并触发重读；失败不刷新、不回退本地
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, cloudStoreIds, cloudLevelIds, beginMutation, endMutation],
  )

  const update = useCallback(
    async (itemId: number, input: RentalItemCloudInput): Promise<OpResult<RentalItemView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        // cloud：同 create，先完整 validateItemFields 再 getRdb/cloudRun；local 由 localRun 内部校验。
        const result = await dispatchMasterItemMutation(
          isCloud ? 'cloud' : 'local',
          input,
          cloudStoreIds,
          cloudLevelIds,
          () => getRdb() as unknown as ItemRdbMutationClient,
          (rdb) => updateItem(rdb, itemId, input, cloudStoreIds, cloudLevelIds),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<RentalItemView>
            const basics = validateItemBasics(input)
            if (!basics.ok) return { ok: false, error: basics.error, field: basics.field }
            const r = dataService.updateItem(role, itemId, toLocalItemInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, cloudStoreIds, cloudLevelIds, beginMutation, endMutation],
  )

  const remove = useCallback(
    async (itemId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchMasterMutation<OpResult>(
          isCloud ? 'cloud' : 'local',
          () => getRdb() as unknown as ItemRdbMutationClient,
          (rdb) => removeItem(rdb, itemId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeItem(role, itemId)
          },
          { ok: false, error: SAFE_ITEM_WRITE_ERROR },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  if (isCloud) {
    return {
      stores: cloudStores,
      skillLevels: cloudLevels,
      items: cloudItems,
      loading,
      error,
      retry,
      create,
      update,
      remove,
      mutating,
    }
  }
  return {
    stores: localStores,
    skillLevels: localLevels,
    items: localItems,
    loading: false,
    error: null,
    retry,
    create,
    update,
    remove,
    mutating,
  }
}
