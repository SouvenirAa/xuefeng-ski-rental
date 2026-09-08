/**
 * 云端「维修单」写操作校验脚本（仅受控 SECURITY DEFINER RPC）
 * （由 validate-cloud-repair-write.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-repair-write
 *
 * 覆盖：
 * 1. 字段校验（create：item_id/contractor_id/request_date/fault_description；complete：repair_id/repair_date/repair_hours 0.25 步进/notes）；
 * 2. RPC 精确调用链（fn 名 + 参数名与 migration 签名严格一致，绝不直接 DML）；
 * 3. 非法 ID / 空文本 / 非 0.25 步进工时在 rpc 前拒绝（rpc 0 次）；
 * 4. create_repair_order 返回值解析（标量 / 数字字符串 / 单元素数组 → repair_id；null/0/多元素 → 安全错误）；
 * 5. 错误映射：42501 → 无权限；P0001（RAISE EXCEPTION）/未知 → 通用安全错误，绝不泄露底层细节；
 * 6. SDK Promise reject 收口为安全错误；
 * 7. 分派（dispatch）：cloud 无效输入 getRpc/cloudRun/rpc/localRun 全 0 次、有效输入各 1 次、local 只走 localRun；
 * 8. 角色门禁：create 非 admin/staff 拒绝；start/complete 非 contractor 拒绝（绕过页面直接调用 Hook 也必须在 rpc 前拒绝）；
 * 9. MutationLock 互斥 + CloudRepairRefresh 成功刷新 / 失败不刷新 / local 不刷新 / 卸载不刷新；
 *
 * 本脚本不读取真实 .env.local、不连接真实账号、不输出凭据、不 import cloudbase 运行时。
 */

// ---- mock localStorage（须在动态 import DataService 之前生效）----
const mem = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
  },
}

const {
  validateCreateRepairFields,
  validateCompleteRepairFields,
  createRepairOrder,
  startRepair,
  completeRepair,
  isPositiveSafeInt,
  SAFE_REPAIR_WRITE_ERROR,
  REPAIR_PERMISSION_ERROR,
} = await import('../src/data/cloudRepairMutations')
type RepairCreateCloudInput = import('../src/data/cloudRepairMutations').RepairCreateCloudInput
type RepairCompleteCloudInput = import('../src/data/cloudRepairMutations').RepairCompleteCloudInput
type RepairMutationRpcClient = import('../src/data/cloudRepairMutations').RepairMutationRpcClient

const {
  dispatchRepairCreateMutation,
  dispatchRepairStartMutation,
  dispatchRepairCompleteMutation,
  MutationLock,
  CloudRepairRefresh,
} = await import('../src/data/repairDataSource')
const { LatestRequestGuard } = await import('../src/data/contractDataSource')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 固定夹具
// ---------------------------------------------------------------------------
const validCreate: RepairCreateCloudInput = {
  item_id: 11,
  contractor_id: 2,
  request_date: '2026-08-19',
  fault_description: '滑雪板边缘开裂',
}
const validComplete: RepairCompleteCloudInput = {
  repair_id: 5,
  repair_date: '2026-08-20',
  repair_hours: 1.5,
  notes: '已更换边刃',
}

// ---------------------------------------------------------------------------
// fake RPC 客户端（记录 fn/args 调用链）
// ---------------------------------------------------------------------------
type RpcOutcome = { data: unknown; error: unknown } | 'reject'
interface RpcRecord {
  fn: string | null
  args: unknown
}
function makeFakeRpc(outcome: RpcOutcome, rec: RpcRecord): RepairMutationRpcClient {
  return {
    rpc(fn: string, args?: unknown) {
      rec.fn = fn
      rec.args = args
      if (outcome === 'reject') return Promise.reject(new Error('sdk-network-internal'))
      return Promise.resolve(outcome)
    },
  }
}
const voidOk: RpcOutcome = { data: null, error: null }

// ===========================================================================
// 1. 字段校验
// ===========================================================================
check('create item_id=0 拒绝', validateCreateRepairFields({ ...validCreate, item_id: 0 }).field === 'item_id')
check('create contractor_id=0 拒绝', validateCreateRepairFields({ ...validCreate, contractor_id: 0 }).field === 'contractor_id')
check('create request_date 非法拒绝', validateCreateRepairFields({ ...validCreate, request_date: '2026-02-30' }).field === 'request_date')
check('create request_date 空串拒绝', validateCreateRepairFields({ ...validCreate, request_date: '' }).field === 'request_date')
check('create fault_description 空白拒绝', validateCreateRepairFields({ ...validCreate, fault_description: '   ' }).field === 'fault_description')
check('create 合法通过', validateCreateRepairFields(validCreate).ok === true)

check('complete repair_id=0 拒绝', validateCompleteRepairFields({ ...validComplete, repair_id: 0 }).field === 'repair_id')
check('complete repair_date 非法拒绝', validateCompleteRepairFields({ ...validComplete, repair_date: 'abc' }).field === 'repair_date')
check('complete repair_hours=0 拒绝', validateCompleteRepairFields({ ...validComplete, repair_hours: 0 }).field === 'repair_hours')
check('complete repair_hours=-1 拒绝', validateCompleteRepairFields({ ...validComplete, repair_hours: -1 }).field === 'repair_hours')
check('complete repair_hours=0.3 拒绝（非 0.25 步进）', validateCompleteRepairFields({ ...validComplete, repair_hours: 0.3 }).field === 'repair_hours')
check('complete repair_hours=0.25 通过', validateCompleteRepairFields({ ...validComplete, repair_hours: 0.25 }).ok === true)
check('complete repair_hours=1.5 通过', validateCompleteRepairFields(validComplete).ok === true)
check('complete notes 空白拒绝', validateCompleteRepairFields({ ...validComplete, notes: '  ' }).field === 'notes')
check('complete 合法通过', validateCompleteRepairFields(validComplete).ok === true)

// ===========================================================================
// 2. RPC 精确调用链（fn 名 + 参数名）
// ===========================================================================
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await createRepairOrder(makeFakeRpc({ data: 42, error: null }, rec), validCreate)
  check('createRepairOrder 成功返回 repair_id', res.ok === true && res.data.repair_id === 42)
  check('createRepairOrder rpc fn=create_repair_order', rec.fn === 'create_repair_order')
  const args = rec.args as Record<string, unknown>
  check('createRepairOrder 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_contractor_id,p_fault_description,p_item_id,p_request_date')
  check('createRepairOrder 参数值正确', args.p_item_id === 11 && args.p_contractor_id === 2 && args.p_request_date === '2026-08-19' && args.p_fault_description === '滑雪板边缘开裂')
}
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await startRepair(makeFakeRpc(voidOk, rec), 5)
  check('startRepair 成功', res.ok === true)
  check('startRepair rpc fn=start_repair', rec.fn === 'start_repair')
  const args = rec.args as Record<string, unknown>
  check('startRepair 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_repair_id')
  check('startRepair 参数值正确', args.p_repair_id === 5)
}
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await completeRepair(makeFakeRpc(voidOk, rec), validComplete)
  check('completeRepair 成功', res.ok === true)
  check('completeRepair rpc fn=complete_repair', rec.fn === 'complete_repair')
  const args = rec.args as Record<string, unknown>
  check('completeRepair 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_notes,p_repair_date,p_repair_hours,p_repair_id')
  check('completeRepair 参数值正确', args.p_repair_id === 5 && args.p_repair_date === '2026-08-20' && args.p_repair_hours === 1.5 && args.p_notes === '已更换边刃')
}

// ===========================================================================
// 3. 非法 ID / 字段在 rpc 前拒绝（rpc 0 次）
// ===========================================================================
const badIds: Array<[string, number]> = [
  ['0', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['NaN', Number.NaN],
  ['超安全整数', Number.MAX_SAFE_INTEGER + 1],
]
for (const [label, badId] of badIds) {
  {
    const rec: RpcRecord = { fn: null, args: null }
    const res = await createRepairOrder(makeFakeRpc({ data: badId, error: null }, rec), { ...validCreate, item_id: badId })
    check(`createRepairOrder item_id=${label} 拒绝且不调 rpc`, res.ok === false && rec.fn === null)
  }
  {
    const rec: RpcRecord = { fn: null, args: null }
    const res = await completeRepair(makeFakeRpc(voidOk, rec), { ...validComplete, repair_id: badId })
    check(`completeRepair repair_id=${label} 拒绝且不调 rpc`, res.ok === false && rec.fn === null)
  }
}

// ===========================================================================
// 4. create_repair_order 返回值解析
// ===========================================================================
check('create 返回值 number → repair_id 7', (await createRepairOrder(makeFakeRpc({ data: 7, error: null }, { fn: null, args: null }), validCreate)).data.repair_id === 7)
check('create 返回值 string "7" → repair_id 7', (await createRepairOrder(makeFakeRpc({ data: '7', error: null }, { fn: null, args: null }), validCreate)).data.repair_id === 7)
check('create 返回值 [7] → repair_id 7', (await createRepairOrder(makeFakeRpc({ data: [7], error: null }, { fn: null, args: null }), validCreate)).data.repair_id === 7)
check('create 返回值 null → 安全错误', (await createRepairOrder(makeFakeRpc({ data: null, error: null }, { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)
check('create 返回值 0 → 安全错误', (await createRepairOrder(makeFakeRpc({ data: 0, error: null }, { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)
check('create 返回值 [7,8] → 安全错误', (await createRepairOrder(makeFakeRpc({ data: [7, 8], error: null }, { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)

// ===========================================================================
// 5. 错误映射（42501 → 无权限；P0001/未知 → 通用，不泄露细节）
// ===========================================================================
function errOutcome(code: string): RpcOutcome {
  return { data: null, error: { code, message: 'internal-secret-detail', details: 'internal-secret', hint: 'internal-secret' } }
}
check('createRepairOrder 42501 → 无权限', (await createRepairOrder(makeFakeRpc(errOutcome('42501'), { fn: null, args: null }), validCreate)).error === REPAIR_PERMISSION_ERROR)
check('createRepairOrder P0001 → 通用错误', (await createRepairOrder(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)
check('createRepairOrder P0001 → 不泄露细节', !(await createRepairOrder(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validCreate)).error.includes('secret'))
check('createRepairOrder 未知错误 → 通用错误', (await createRepairOrder(makeFakeRpc(errOutcome('99999'), { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)
check('startRepair 42501 → 无权限', (await startRepair(makeFakeRpc(errOutcome('42501'), { fn: null, args: null }), 5)).error === REPAIR_PERMISSION_ERROR)
check('completeRepair P0001 → 通用错误', (await completeRepair(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validComplete)).error === SAFE_REPAIR_WRITE_ERROR)

// ===========================================================================
// 6. SDK reject 收口
// ===========================================================================
check('createRepairOrder SDK reject → 通用错误', (await createRepairOrder(makeFakeRpc('reject', { fn: null, args: null }), validCreate)).error === SAFE_REPAIR_WRITE_ERROR)
check('startRepair SDK reject → 通用错误', (await startRepair(makeFakeRpc('reject', { fn: null, args: null }), 5)).error === SAFE_REPAIR_WRITE_ERROR)
check('completeRepair SDK reject → 通用错误', (await completeRepair(makeFakeRpc('reject', { fn: null, args: null }), validComplete)).error === SAFE_REPAIR_WRITE_ERROR)

// ===========================================================================
// 7. isPositiveSafeInt
// ===========================================================================
check('isPositiveSafeInt(1)=true', isPositiveSafeInt(1) === true)
check('isPositiveSafeInt(0)=false', isPositiveSafeInt(0) === false)
check('isPositiveSafeInt(1.5)=false', isPositiveSafeInt(1.5) === false)
check('isPositiveSafeInt(NaN)=false', isPositiveSafeInt(Number.NaN) === false)
check('isPositiveSafeInt(MAX_SAFE+1)=false', isPositiveSafeInt(Number.MAX_SAFE_INTEGER + 1) === false)

// ===========================================================================
// 8. 分派：cloud 无效输入全 0 次 / 有效输入各 1 次 / local 只走 localRun
// ===========================================================================
function makeCountingDispatch(outcome: RpcOutcome) {
  const calls = { getRpc: 0, cloudRun: 0, localRun: 0, rpc: 0 }
  const getRpcFn = (): RepairMutationRpcClient => {
    calls.getRpc++
    const inner = makeFakeRpc(outcome, { fn: null, args: null })
    return {
      rpc(fn: string, args?: unknown) {
        calls.rpc++
        return inner.rpc(fn, args)
      },
    }
  }
  return { calls, getRpcFn }
}

// 8a. cloud create 有效 → 各 1 次、local 0 次
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const res = await dispatchRepairCreateMutation(
    'cloud', true, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createRepairOrder(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { repair_id: 999 } } },
  )
  check('cloud create 有效 → ok + repair_id', res.ok === true && res.data.repair_id === 42)
  check('cloud create 有效 → getRpc/cloudRun/rpc 各 1 次、localRun 0 次', env.calls.getRpc === 1 && env.calls.cloudRun === 1 && env.calls.rpc === 1 && env.calls.localRun === 0)
}
// 8b. cloud create 空 fault_description → 字段错误且全 0 次
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const bad: RepairCreateCloudInput = { ...validCreate, fault_description: '  ' }
  const res = await dispatchRepairCreateMutation(
    'cloud', true, bad,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createRepairOrder(rpc, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: { repair_id: 999 } } },
  )
  check('cloud create 空描述 → field fault_description', res.ok === false && res.field === 'fault_description')
  check('cloud create 空描述 → getRpc/cloudRun/rpc/localRun 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// 8c. local create → 只走 localRun
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const res = await dispatchRepairCreateMutation(
    'local', true, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createRepairOrder(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { repair_id: 123 } } },
  )
  check('local create → localRun 1 次', env.calls.localRun === 1)
  check('local create → getRpc/cloudRun/rpc 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0)
  check('local create → 透传', res.ok === true && res.data.repair_id === 123)
}
// 8d. cloud start 有效 → 各 1 次
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairStartMutation(
    'cloud', true, 5,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return startRepair(rpc, 5) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false as const, error: SAFE_REPAIR_WRITE_ERROR },
  )
  check('cloud start 有效 → ok', res.ok === true)
  check('cloud start 有效 → getRpc/cloudRun/rpc 各 1 次、localRun 0 次', env.calls.getRpc === 1 && env.calls.cloudRun === 1 && env.calls.rpc === 1 && env.calls.localRun === 0)
}
// 8e. cloud start 非法 repair_id → 全 0 次
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairStartMutation(
    'cloud', true, 0,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return startRepair(rpc, 0) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false as const, error: SAFE_REPAIR_WRITE_ERROR },
  )
  check('cloud start repair_id=0 → 安全错误', res.ok === false && res.error === SAFE_REPAIR_WRITE_ERROR)
  check('cloud start repair_id=0 → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// 8f. cloud complete 有效 → 各 1 次
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairCompleteMutation(
    'cloud', true, validComplete,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return completeRepair(rpc, validComplete) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud complete 有效 → ok', res.ok === true)
  check('cloud complete 有效 → getRpc/cloudRun/rpc 各 1 次、localRun 0 次', env.calls.getRpc === 1 && env.calls.cloudRun === 1 && env.calls.rpc === 1 && env.calls.localRun === 0)
}
// 8g. cloud complete 非 0.25 步进 → 字段错误且全 0 次
{
  const env = makeCountingDispatch(voidOk)
  const bad: RepairCompleteCloudInput = { ...validComplete, repair_hours: 0.3 }
  const res = await dispatchRepairCompleteMutation(
    'cloud', true, bad,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return completeRepair(rpc, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud complete 0.3h → field repair_hours', res.ok === false && res.field === 'repair_hours')
  check('cloud complete 0.3h → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// 8h. local complete → 只走 localRun
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairCompleteMutation(
    'local', true, validComplete,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return completeRepair(rpc, validComplete) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('local complete → localRun 1 次', env.calls.localRun === 1)
  check('local complete → getRpc/cloudRun/rpc 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0)
}

// ===========================================================================
// 9. 角色门禁（绕过页面直接调用 Hook 也必须在 rpc 前拒绝）
// ===========================================================================
// create：非 admin/staff 拒绝
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const res = await dispatchRepairCreateMutation(
    'cloud', false, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createRepairOrder(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { repair_id: 999 } } },
  )
  check('cloud 非 admin/staff create → 无权限', res.ok === false && res.error === REPAIR_PERMISSION_ERROR)
  check('cloud 非 admin/staff create → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// start：非 contractor 拒绝
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairStartMutation(
    'cloud', false, 5,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return startRepair(rpc, 5) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false as const, error: SAFE_REPAIR_WRITE_ERROR },
  )
  check('cloud 非 contractor start → 无权限', res.ok === false && res.error === REPAIR_PERMISSION_ERROR)
  check('cloud 非 contractor start → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// complete：非 contractor 拒绝
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchRepairCompleteMutation(
    'cloud', false, validComplete,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return completeRepair(rpc, validComplete) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud 非 contractor complete → 无权限', res.ok === false && res.error === REPAIR_PERMISSION_ERROR)
  check('cloud 非 contractor complete → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}

// ===========================================================================
// 10. MutationLock + CloudRepairRefresh
// ===========================================================================
{
  const lock = new MutationLock()
  check('MutationLock 首次获取成功', lock.tryAcquire() === true)
  check('MutationLock 重复获取失败', lock.tryAcquire() === false)
  lock.release()
  check('MutationLock release 后可再获取', lock.tryAcquire() === true)
  lock.release()
}
{
  const guard = new LatestRequestGuard()
  let refetchCalls = 0
  const refresher = new CloudRepairRefresh(guard, () => { refetchCalls++ }, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: { repair_id: 1 } }, true)
  check('写成功后触发重读（refetch 1 次）', refetchCalls === 1)
  refetchCalls = 0
  refresher.refreshIfNeeded({ ok: false as const, error: SAFE_REPAIR_WRITE_ERROR }, true)
  check('写失败不触发重读', refetchCalls === 0)
  refresher.refreshIfNeeded({ ok: true as const, data: { repair_id: 1 } }, false)
  check('local 模式不触发重读', refetchCalls === 0)
  const guard2 = new LatestRequestGuard()
  let refetchCalls2 = 0
  const refresher2 = new CloudRepairRefresh(guard2, () => { refetchCalls2++ }, () => false)
  refresher2.refreshIfNeeded({ ok: true as const, data: { repair_id: 1 } }, true)
  check('组件已卸载不触发重读', refetchCalls2 === 0)
}
{
  const guard = new LatestRequestGuard()
  const t0 = guard.begin()
  const refresher = new CloudRepairRefresh(guard, () => {}, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: { repair_id: 1 } }, true)
  check('写成功后旧 token 已失效', guard.isLatest(t0) === false)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
