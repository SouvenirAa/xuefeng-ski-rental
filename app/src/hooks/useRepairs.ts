/**
 * 维修单数据 Hook（local/cloud 双模式），含只读列表 + 创建/开始/完成写操作。
 * - local：继续使用 dataService.listRepairs/listItems/listContractors/listContractorRates
 *   组装 RepairRowView + 写方法（createRepairOrder/startRepair/completeRepair）+ 原订阅刷新机制；
 * - cloud：按 SessionAccount.role 分派（admin/staff 直读四表、contractor 走 list_my_repairs RPC），
 *   写操作走云端 mutation（仅受控 RPC：create_repair_order/start_repair/complete_repair），
 *   提供 loading/data/error/retry + mutating；
 * - cloud 查询失败只返回错误与重试，绝不回退本地数据；写失败绝不回退 DataService/localStorage；
 * - cloud 写成功后必须重新查询 PostgreSQL（setTick 触发重读），不做内存假成功；
 * - 防止重复提交（MutationLock 同步互斥）；组件卸载或请求过期后不写入 React state
 *   （cancelled 防护卸载 + LatestRequestGuard 防护请求竞争：旧查询不得覆盖 mutation 后新结果）；
 * - cloud 写权限门禁（与 RPC 内部角色校验、DataService 权限矩阵一致）：
 *   创建维修单仅 admin/staff；开始/完成维修仅 contractor（RPC 内部按 auth.uid() 校验本人承接）。
 *
 * 返回 repairs 为 RepairRowView[]（设备编号/名称、承包商名称、冻结费率已联立），
 * local 与 cloud 结构一致，页面无需再自行反查。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { dataService } from '../data/dataService'
import { useAuth } from '../auth/AuthContext'
import {
  queryRepairsAdmin,
  queryRepairsContractor,
  type RepairRowView,
} from '../data/cloudRepairs'
import type { MasterRdbClient } from '../data/cloudMaster'
import type { RepairRpcClient } from '../data/cloudRepairs'
import {
  createRepairOrder as cloudCreateRepairOrder,
  startRepair as cloudStartRepair,
  completeRepair as cloudCompleteRepair,
  SAFE_REPAIR_WRITE_ERROR,
  type RepairCreateCloudInput,
  type RepairCompleteCloudInput,
  type RepairMutationRpcClient,
} from '../data/cloudRepairMutations'
import { isCloudMode, getRdb } from '../lib/cloudbase'
import { useDbData, type UseDbDataOptions } from './useDbData'
import {
  buildRepairRows,
  dispatchRepairLoad,
  dispatchRepairCreateMutation,
  dispatchRepairStartMutation,
  dispatchRepairCompleteMutation,
  settleRepairRead,
  MutationLock,
  CloudRepairRefresh,
  type RepairRoleKind,
} from '../data/repairDataSource'
import { LatestRequestGuard } from '../data/contractDataSource'
import type { OpResult } from '../data/types'

export interface RepairsResult {
  repairs: RepairRowView[]
  loading: boolean
  error: string | null
  retry: () => void
  /** 创建维修单（admin/staff；local/cloud 统一 OpResult） */
  createRepair: (input: RepairCreateCloudInput) => Promise<OpResult<{ repair_id: number }>>
  /** 开始维修（contractor，仅本人承接；仅传 repair_id，归属由服务端校验） */
  startRepair: (repairId: number) => Promise<OpResult>
  /** 完成维修（contractor，仅本人承接；金额由服务端按冻结费率复算） */
  completeRepair: (input: RepairCompleteCloudInput) => Promise<OpResult>
  /** 是否有写操作进行中（防重复提交 + 按钮 loading） */
  mutating: boolean
}

/** 稳定空数组：cloud 模式下 useDbData 的 disabledValue，避免每渲染新建数组 */
const EMPTY_ROWS: RepairRowView[] = []

/** 重复提交被拦截时的安全提示 */
const MUTATION_IN_PROGRESS = '操作进行中，请勿重复提交'

export function useRepairs(): RepairsResult {
  const { role, account } = useAuth()
  const isCloud = isCloudMode()
  const myContractorId = account?.contractor_id ?? undefined
  // staff 与 admin 同走直读；contractor 走 RPC
  const roleKind: RepairRoleKind = role === 'contractor' ? 'contractor' : 'admin'

  // cloud 写权限门禁（与 RPC 内部一致）：创建仅 admin/staff；开始/完成仅 contractor。
  const canCreate = role === 'admin' || role === 'staff'
  const canOperate = role === 'contractor'

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

  // 写操作并发状态（互斥锁 + UI loading）
  const lockRef = useRef<MutationLock | null>(null)
  if (lockRef.current === null) lockRef.current = new MutationLock()
  const [mutating, setMutating] = useState(false)

  // 读请求代次守卫（旧查询不得覆盖 mutation 后新结果）+ 卸载防护
  const guardRef = useRef<LatestRequestGuard | null>(null)
  if (guardRef.current === null) guardRef.current = new LatestRequestGuard()
  const mountedRef = useRef(true)

  // 刷新控制器：mutation 成功后立即失效旧读 token 再触发重读（可测试纯逻辑，ref 持有唯一实例）。
  const refreshRef = useRef<CloudRepairRefresh | null>(null)
  if (refreshRef.current === null) {
    refreshRef.current = new CloudRepairRefresh(
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
      if (!guardRef.current!.isLatest(token)) return
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

  const createRepair = useCallback(
    async (input: RepairCreateCloudInput): Promise<OpResult<{ repair_id: number }>> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRepairCreateMutation(
          isCloud ? 'cloud' : 'local',
          canCreate,
          input,
          () => getRdb() as unknown as RepairMutationRpcClient,
          (rpc) => cloudCreateRepairOrder(rpc, input),
          () => {
            if (!role) {
              return { ok: false, error: '无权限执行该操作' } as OpResult<{ repair_id: number }>
            }
            const r = dataService.createRepairOrder(role, {
              item_id: input.item_id,
              contractor_id: input.contractor_id,
              request_date: input.request_date,
              fault_description: input.fault_description,
            })
            if (!r.ok) return { ok: false, error: r.error, field: r.field }
            return { ok: true, data: { repair_id: r.data.repair_id } }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, canCreate, beginMutation, endMutation],
  )

  const startRepair = useCallback(
    async (repairId: number): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRepairStartMutation(
          isCloud ? 'cloud' : 'local',
          canOperate,
          repairId,
          () => getRdb() as unknown as RepairMutationRpcClient,
          (rpc) => cloudStartRepair(rpc, repairId),
          () => {
            if (!role || myContractorId === undefined) {
              return { ok: false, error: '无权限执行该操作' } as OpResult
            }
            const r = dataService.startRepair(role, myContractorId, repairId)
            return r.ok
              ? { ok: true, data: undefined }
              : { ok: false, error: r.error, field: r.field }
          },
          { ok: false, error: SAFE_REPAIR_WRITE_ERROR },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, myContractorId, canOperate, beginMutation, endMutation],
  )

  const completeRepair = useCallback(
    async (input: RepairCompleteCloudInput): Promise<OpResult> => {
      if (!beginMutation()) return { ok: false, error: MUTATION_IN_PROGRESS }
      try {
        const result = await dispatchRepairCompleteMutation(
          isCloud ? 'cloud' : 'local',
          canOperate,
          input,
          () => getRdb() as unknown as RepairMutationRpcClient,
          (rpc) => cloudCompleteRepair(rpc, input),
          () => {
            if (!role || myContractorId === undefined) {
              return { ok: false, error: '无权限执行该操作' } as OpResult
            }
            const r = dataService.completeRepair(role, myContractorId, input.repair_id, {
              repair_date: input.repair_date,
              repair_hours: input.repair_hours,
              notes: input.notes,
            })
            return r.ok
              ? { ok: true, data: undefined }
              : { ok: false, error: r.error, field: r.field }
          },
        )
        return refreshRef.current!.refreshIfNeeded(result, isCloud)
      } finally {
        endMutation()
      }
    },
    [isCloud, role, myContractorId, canOperate, beginMutation, endMutation],
  )

  if (isCloud) {
    return {
      repairs: cloudRepairs,
      loading,
      error,
      retry,
      createRepair,
      startRepair,
      completeRepair,
      mutating,
    }
  }
  return {
    repairs: localRepairs,
    loading: false,
    error: null,
    retry,
    createRepair,
    startRepair,
    completeRepair,
    mutating,
  }
}
