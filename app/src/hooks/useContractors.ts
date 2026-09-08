/**
 * 承包商 / 费率数据 Hook（local/cloud 双模式），含只读列表 + 承包商/费率写操作。
 * - local：继续使用 dataService.listContractors/listContractorRates + createContractor/updateContractor/
 *   removeContractor/createContractorRate/updateContractorRate/removeContractorRate + 原订阅刷新机制
 *   （写成功后 DataService notify → useDbData 订阅刷新）；
 * - cloud：异步调用真实 PostgreSQL 三表查询（承包商 + 费率 + 被维修单引用的 rate_id 集合），
 *   提供 loading/data/error/retry + mutating；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；
 * - cloud 写失败绝不回退 DataService/localStorage，只返回安全错误；
 * - cloud 写成功后必须重新查询 PostgreSQL（setTick 触发重读），不做内存假成功；
 * - 防止重复提交（MutationLock 同步互斥）；组件卸载或请求过期后不写入 React state
 *   （cancelled 防护卸载 + LatestRequestGuard 防护请求竞争：旧查询不得覆盖 mutation 后新结果）；
 * - cloud 模式绝不调用任何 DataService 承包商/费率写方法、不订阅 DataService（useDbData enabled=false）。
 *
 * 返回类型统一为只读视图模型（ContractorView / ContractorRateView）：云端可空字段
 * （address/phone/email）显式建模为 null。local reader 返回的可写领域类型结构性可赋值，
 * 不改变 local CRUD 行为。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryContractorsWithRates,
  type ContractorView,
  type ContractorRateView,
} from '../data/cloudContractors'
import {
  createContractor as cloudCreateContractor,
  updateContractor as cloudUpdateContractor,
  removeContractor as cloudRemoveContractor,
  createContractorRate as cloudCreateRate,
  updateContractorRate as cloudUpdateRate,
  removeContractorRate as cloudRemoveRate,
  SAFE_CONTRACTOR_WRITE_ERROR,
  SAFE_RATE_WRITE_ERROR,
  type ContractorCloudInput,
  type ContractorRateCloudInput,
  type ContractorRdbMutationClient,
} from '../data/cloudContractorMutations'
import type { MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useAuth } from '../auth/AuthContext'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  dispatchContractorLoad,
  dispatchContractorWriteMutation,
  dispatchContractorIdMutation,
  dispatchRateCreateMutation,
  dispatchRateUpdateMutation,
  dispatchRateIdMutation,
  settleContractorRead,
  toLocalContractorInput,
  toLocalContractorRateInput,
  MutationLock,
  CloudContractorRefresh,
} from '../data/contractorDataSource'
import { LatestRequestGuard } from '../data/contractDataSource'
import type { OpResult } from '../data/types'

export interface ContractorsResult {
  contractors: ContractorView[]
  rates: ContractorRateView[]
  /** 已被维修单引用的费率 rate_id 集合（升序去重），cloud 模式供页面禁用被引用费率 */
  referencedRateIds: number[]
  loading: boolean
  error: string | null
  retry: () => void
  /** 新增承包商（local/cloud 统一 OpResult，输入为 cloud 可空类型） */
  createContractor: (input: ContractorCloudInput) => Promise<OpResult<ContractorView>>
  /** 编辑承包商（contractor_id 由页面从已校验的列表行传入） */
  updateContractor: (
    contractorId: number,
    input: ContractorCloudInput,
  ) => Promise<OpResult<ContractorView>>
  /** 删除承包商 */
  removeContractor: (contractorId: number) => Promise<OpResult>
  /** 新增费率（contractor_id 由页面传入） */
  createRate: (
    contractorId: number,
    input: ContractorRateCloudInput,
  ) => Promise<OpResult<ContractorRateView>>
  /** 编辑费率（rate_id 由页面从已校验的费率行传入） */
  updateRate: (
    rateId: number,
    input: ContractorRateCloudInput,
  ) => Promise<OpResult<ContractorRateView>>
  /** 删除费率 */
  removeRate: (rateId: number) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_CONTRACTORS: ContractorView[] = []
const EMPTY_RATES: ContractorRateView[] = []
const EMPTY_REFERENCED: number[] = []

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useContractors(): ContractorsResult {
  const isCloud = isCloudMode()
  const { role } = useAuth()

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
  const [cloudReferencedRateIds, setCloudReferencedRateIds] = useState<number[]>([])
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
  const refreshRef = useRef<CloudContractorRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudContractorRefresh(
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
    const { promise } = dispatchContractorLoad('cloud', {
      localReadContractors: () => dataService.listContractors(),
      localReadRates: () => dataService.listContractorRates(),
      cloudReadContractors: () => queryContractorsWithRates(getRdb() as unknown as MasterRdbClient),
    })
    promise.then((r) => {
      if (cancelled) return
      if (!guardRef.current!.isLatest(token)) return
      const settled = settleContractorRead(r)
      setCloudContractors(settled.data.contractors)
      setCloudRates(settled.data.rates)
      setCloudReferencedRateIds(settled.data.referencedRateIds)
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

  const createContractor = useCallback(
    async (input: ContractorCloudInput): Promise<OpResult<ContractorView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchContractorWriteMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          input,
          undefined,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudCreateContractor(rdb, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ContractorView>
            const r = dataService.createContractor(role, toLocalContractorInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  const updateContractor = useCallback(
    async (contractorId: number, input: ContractorCloudInput): Promise<OpResult<ContractorView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchContractorWriteMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          input,
          contractorId,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudUpdateContractor(rdb, contractorId, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ContractorView>
            const r = dataService.updateContractor(role, contractorId, toLocalContractorInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  const removeContractor = useCallback(
    async (contractorId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchContractorIdMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          contractorId,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudRemoveContractor(rdb, contractorId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeContractor(role, contractorId)
          },
          { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  const createRate = useCallback(
    async (contractorId: number, input: ContractorRateCloudInput): Promise<OpResult<ContractorRateView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRateCreateMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          contractorId,
          input,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudCreateRate(rdb, contractorId, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ContractorRateView>
            const r = dataService.createContractorRate(role, contractorId, toLocalContractorRateInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  const updateRate = useCallback(
    async (rateId: number, input: ContractorRateCloudInput): Promise<OpResult<ContractorRateView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRateUpdateMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          rateId,
          input,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudUpdateRate(rdb, rateId, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ContractorRateView>
            const r = dataService.updateContractorRate(role, rateId, toLocalContractorRateInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, beginMutation, endMutation],
  )

  const removeRate = useCallback(
    async (rateId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRateIdMutation(
          isCloud ? 'cloud' : 'local',
          role === 'admin',
          rateId,
          () => getRdb() as unknown as ContractorRdbMutationClient,
          (rdb) => cloudRemoveRate(rdb, rateId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeContractorRate(role, rateId)
          },
          { ok: false, error: SAFE_RATE_WRITE_ERROR },
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
      contractors: cloudContractors,
      rates: cloudRates,
      referencedRateIds: cloudReferencedRateIds,
      loading,
      error,
      retry,
      createContractor,
      updateContractor,
      removeContractor,
      createRate,
      updateRate,
      removeRate,
      mutating,
    }
  }
  return {
    contractors: localContractors,
    rates: localRates,
    referencedRateIds: EMPTY_REFERENCED,
    loading: false,
    error: null,
    retry,
    createContractor,
    updateContractor,
    removeContractor,
    createRate,
    updateRate,
    removeRate,
    mutating,
  }
}
