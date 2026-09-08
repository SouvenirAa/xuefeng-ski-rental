/**
 * 统一客户数据 Hook（local/cloud 双模式），含只读列表 + 客户写操作（create/update/remove）。
 * - local：继续使用 dataService.listCustomers + createCustomer/updateCustomer/removeCustomer
 *   + 原订阅刷新机制（写成功后 DataService notify → useDbData 订阅刷新）；
 * - cloud：异步调用真实 PostgreSQL 查询 + 写操作，提供 loading/data/error/retry + mutating；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - cloud 写失败绝不回退 DataService/localStorage，只返回安全错误；
 * - cloud 写成功后必须重新查询 PostgreSQL（setTick 触发重读），不做内存假成功；
 * - 防止重复提交（MutationLock 同步互斥）；组件卸载或请求过期后不写入 React state
 *   （cancelled 防护卸载 + LatestRequestGuard 防护请求竞争：旧查询不得覆盖 mutation 后新结果）；
 * - cloud 模式绝不调用任何 DataService 客户写方法、不订阅 DataService（useDbData enabled=false）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryCustomers,
  type CustomerRdbClient,
} from '../data/cloudCustomers'
import {
  createCustomer,
  updateCustomer,
  removeCustomer,
  SAFE_CUSTOMER_WRITE_ERROR,
  type CustomerRdbMutationClient,
} from '../data/cloudCustomerMutations'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useAuth } from '../auth/AuthContext'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  dispatchCustomerLoad,
  dispatchCustomerWriteMutation,
  dispatchCustomerIdMutation,
  settleCloudRead,
  MutationLock,
  CloudCustomerRefresh,
} from '../data/customerDataSource'
import { LatestRequestGuard } from '../data/contractDataSource'
import type { Customer, CustomerInput, OpResult } from '../data/types'

export interface CustomersResult {
  customers: Customer[]
  loading: boolean
  error: string | null
  retry: () => void
  /** 新增客户（local/cloud 统一 OpResult） */
  create: (input: CustomerInput) => Promise<OpResult<Customer>>
  /** 编辑客户（customer_id 由页面从已校验的列表行传入） */
  update: (customerId: number, input: CustomerInput) => Promise<OpResult<Customer>>
  /** 删除客户 */
  remove: (customerId: number) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_CUSTOMERS: Customer[] = []

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useCustomers(): CustomersResult {
  const isCloud = isCloudMode()
  const { role } = useAuth()

  // cloud 写权限门禁：客户写操作允许 admin / staff（与 RLS customers_write、DataService 权限矩阵一致）。
  // local 模式不使用该门禁（由 dataService.checkWritePermission 内部按角色收敛）。
  const canWrite = role === 'admin' || role === 'staff'

  // local 订阅（仅 local 模式启用；cloud 模式 enabled=false：不订阅、不执行 read）。
  const dbOptions: UseDbDataOptions<Customer[]> = isCloud
    ? { enabled: false, disabledValue: EMPTY_CUSTOMERS }
    : { enabled: true }
  const localCustomers = useDbData(() => dataService.listCustomers(), dbOptions)

  // cloud 异步状态（cloud 首次渲染即 loading=true，避免 effect 前短暂“暂无客户”）
  const [cloudData, setCloudData] = useState<Customer[]>([])
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
  const refreshRef = useRef<CloudCustomerRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudCustomerRefresh(
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

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    const token = guardRef.current!.begin()
    setLoading(true)
    setError(null)
    const { promise } = dispatchCustomerLoad('cloud', {
      localRead: () => dataService.listCustomers(),
      cloudRead: () => queryCustomers(getRdb() as unknown as CustomerRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      if (!guardRef.current!.isLatest(token)) return
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
    async (input: CustomerInput): Promise<OpResult<Customer>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchCustomerWriteMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          undefined,
          () => getRdb() as unknown as CustomerRdbMutationClient,
          (rdb) => createCustomer(rdb, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<Customer>
            return dataService.createCustomer(role, input)
          },
        )
        // 成功（仅 cloud）→ 立即失效旧读 token 并触发重读；失败不刷新、不回退本地
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const update = useCallback(
    async (customerId: number, input: CustomerInput): Promise<OpResult<Customer>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchCustomerWriteMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          customerId,
          () => getRdb() as unknown as CustomerRdbMutationClient,
          (rdb) => updateCustomer(rdb, customerId, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<Customer>
            return dataService.updateCustomer(role, customerId, input)
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const remove = useCallback(
    async (customerId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchCustomerIdMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          customerId,
          () => getRdb() as unknown as CustomerRdbMutationClient,
          (rdb) => removeCustomer(rdb, customerId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeCustomer(role, customerId)
          },
          { ok: false, error: SAFE_CUSTOMER_WRITE_ERROR },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  if (isCloud) {
    return {
      customers: cloudData,
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
    customers: localCustomers,
    loading: false,
    error: null,
    retry,
    create,
    update,
    remove,
    mutating,
  }
}
