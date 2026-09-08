/**
 * 员工 / 排班 / 门店数据 Hook（local/cloud 双模式），含只读列表 + 员工/排班写操作。
 * - local：继续使用 dataService.listEmployees/listShifts/listStores + 写方法 + 原订阅刷新机制；
 * - cloud：异步调用真实 PostgreSQL 三表查询（一并做关联 / 业务约束校验），写操作走云端 mutation，
 *   提供 loading/data/error/retry + mutating；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；写失败绝不回退 DataService/localStorage；
 * - cloud 写成功后必须重新查询 PostgreSQL（setTick 触发重读），不做内存假成功；
 * - 防止重复提交（MutationLock 同步互斥）；组件卸载或请求过期后不写入 React state
 *   （cancelled 防护卸载 + LatestRequestGuard 防护请求竞争：旧查询不得覆盖 mutation 后新结果）；
 * - cloud 写权限门禁：员工 / 排班写仅 admin（与 RLS employees_write / shifts_write、DataService 权限矩阵一致），
 *   无权角色在 getRdb 前拒绝；local 模式由 dataService 内部按角色收敛。
 *
 * 复用策略：员工页只查询 employees / shifts / stores，不触碰设备 / 技能等级。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import {
  queryWorkforce,
  type EmployeeView,
  type ShiftView,
} from '../data/cloudWorkforce'
import {
  createEmployee as cloudCreateEmployee,
  updateEmployee as cloudUpdateEmployee,
  removeEmployee as cloudRemoveEmployee,
  createShift as cloudCreateShift,
  updateShift as cloudUpdateShift,
  removeShift as cloudRemoveShift,
  SAFE_EMPLOYEE_WRITE_ERROR,
  SAFE_SHIFT_WRITE_ERROR,
  type EmployeeCloudInput,
  type ShiftCloudInput,
  type WorkforceRdbMutationClient,
} from '../data/cloudWorkforceMutations'
import type { StoreView, MasterRdbClient } from '../data/cloudMaster'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useAuth } from '../auth/AuthContext'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  dispatchWorkforceLoad,
  dispatchEmployeeWriteMutation,
  dispatchEmployeeIdMutation,
  dispatchShiftCreateMutation,
  dispatchShiftUpdateMutation,
  dispatchShiftIdMutation,
  settleWorkforceRead,
  toLocalEmployeeInput,
  toLocalShiftInput,
  MutationLock,
  CloudWorkforceRefresh,
} from '../data/workforceDataSource'
import { LatestRequestGuard } from '../data/contractDataSource'
import type { OpResult } from '../data/types'

export interface WorkforceResult {
  employees: EmployeeView[]
  shifts: ShiftView[]
  stores: StoreView[]
  loading: boolean
  error: string | null
  retry: () => void
  /** 新增员工（local/cloud 统一 OpResult，输入为 cloud 可空类型） */
  createEmployee: (input: EmployeeCloudInput) => Promise<OpResult<EmployeeView>>
  /** 编辑员工（employee_id 由页面从已校验的列表行传入） */
  updateEmployee: (employeeId: number, input: EmployeeCloudInput) => Promise<OpResult<EmployeeView>>
  /** 删除员工 */
  removeEmployee: (employeeId: number) => Promise<OpResult>
  /** 新增排班 */
  createShift: (input: ShiftCloudInput) => Promise<OpResult<ShiftView>>
  /** 编辑排班 */
  updateShift: (shiftId: number, input: ShiftCloudInput) => Promise<OpResult<ShiftView>>
  /** 删除排班 */
  removeShift: (shiftId: number) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_EMPLOYEES: EmployeeView[] = []
const EMPTY_SHIFTS: ShiftView[] = []
const EMPTY_STORES: StoreView[] = []

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useWorkforce(): WorkforceResult {
  const isCloud = isCloudMode()
  const { role } = useAuth()

  // cloud 写权限门禁：员工 / 排班写仅 admin（local 模式不使用该门禁）。
  const canWrite = role === 'admin'

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

  // 写操作并发状态（互斥锁 + UI loading）
  const lockRef = useRef<MutationLock | null>(null)
  if (lockRef.current === null) lockRef.current = new MutationLock()
  const [mutating, setMutating] = useState(false)

  // 读请求代次守卫（旧查询不得覆盖 mutation 后新结果）+ 卸载防护
  const guardRef = useRef<LatestRequestGuard | null>(null)
  if (guardRef.current === null) guardRef.current = new LatestRequestGuard()
  const mountedRef = useRef(true)

  // 刷新控制器：mutation 成功后立即失效旧读 token 再触发重读（可测试纯逻辑，ref 持有唯一实例）。
  const refreshRef = useRef<CloudWorkforceRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudWorkforceRefresh(
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

  // cloud 外键预校验集合（由已加载的云端员工 / 门店派生）
  const cloudEmployeeIds = useMemo(
    () => new Set(cloudEmployees.map((e) => e.employee_id)),
    [cloudEmployees],
  )
  const cloudStoreIds = useMemo(
    () => new Set(cloudStores.map((s) => s.store_id)),
    [cloudStores],
  )

  useEffect(() => {
    if (!isCloud) return
    let cancelled = false
    const token = guardRef.current!.begin()
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
      if (!guardRef.current!.isLatest(token)) return
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

  const createEmployee = useCallback(
    async (input: EmployeeCloudInput): Promise<OpResult<EmployeeView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchEmployeeWriteMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          undefined,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudCreateEmployee(rdb, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<EmployeeView>
            const r = dataService.createEmployee(role, toLocalEmployeeInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const updateEmployee = useCallback(
    async (employeeId: number, input: EmployeeCloudInput): Promise<OpResult<EmployeeView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchEmployeeWriteMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          employeeId,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudUpdateEmployee(rdb, employeeId, input),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<EmployeeView>
            const r = dataService.updateEmployee(role, employeeId, toLocalEmployeeInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const removeEmployee = useCallback(
    async (employeeId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchEmployeeIdMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          employeeId,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudRemoveEmployee(rdb, employeeId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeEmployee(role, employeeId)
          },
          { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, beginMutation, endMutation],
  )

  const createShift = useCallback(
    async (input: ShiftCloudInput): Promise<OpResult<ShiftView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchShiftCreateMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          input,
          cloudEmployeeIds,
          cloudStoreIds,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudCreateShift(rdb, input, cloudEmployeeIds, cloudStoreIds),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ShiftView>
            const r = dataService.createShift(role, toLocalShiftInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, cloudEmployeeIds, cloudStoreIds, beginMutation, endMutation],
  )

  const updateShift = useCallback(
    async (shiftId: number, input: ShiftCloudInput): Promise<OpResult<ShiftView>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchShiftUpdateMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          shiftId,
          input,
          cloudEmployeeIds,
          cloudStoreIds,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudUpdateShift(rdb, shiftId, input, cloudEmployeeIds, cloudStoreIds),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult<ShiftView>
            const r = dataService.updateShift(role, shiftId, toLocalShiftInput(input))
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: r.data }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canWrite, cloudEmployeeIds, cloudStoreIds, beginMutation, endMutation],
  )

  const removeShift = useCallback(
    async (shiftId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchShiftIdMutation(
          isCloud ? 'cloud' : 'local',
          canWrite,
          shiftId,
          () => getRdb() as unknown as WorkforceRdbMutationClient,
          (rdb) => cloudRemoveShift(rdb, shiftId),
          () => {
            if (!role) return { ok: false, error: '无权限执行该操作' } as OpResult
            return dataService.removeShift(role, shiftId)
          },
          { ok: false, error: SAFE_SHIFT_WRITE_ERROR },
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
      employees: cloudEmployees,
      shifts: cloudShifts,
      stores: cloudStores,
      loading,
      error,
      retry,
      createEmployee,
      updateEmployee,
      removeEmployee,
      createShift,
      updateShift,
      removeShift,
      mutating,
    }
  }
  return {
    employees: localEmployees,
    shifts: localShifts,
    stores: localStores,
    loading: false,
    error: null,
    retry,
    createEmployee,
    updateEmployee,
    removeEmployee,
    createShift,
    updateShift,
    removeShift,
    mutating,
  }
}
