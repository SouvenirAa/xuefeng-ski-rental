/**
 * 云端「租赁合同」写操作校验脚本（仅受控 SECURITY DEFINER RPC）
 * （由 validate-cloud-contract-write.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-contract-write
 *
 * 覆盖：
 * 1. 字段校验（create：customer_id/contract_date/duration_days/item_ids；exchange/return：各 ID + date/line_ids）；
 * 2. RPC 精确调用链（fn 名 + 参数名与 migration 签名严格一致，绝不直接 DML）；
 * 3. 非法 ID / 空数组 / 重复数组在 rpc 前拒绝（rpc 0 次）；
 * 4. create_contract 返回值解析（标量 / 数字字符串 / 单元素数组 → contract_id；null/0/多元素 → 安全错误）；
 * 5. 错误映射：42501 → 无权限；P0001（RAISE EXCEPTION）/未知 → 通用安全错误，绝不泄露底层细节；
 * 6. SDK Promise reject 收口为安全错误；
 * 7. 分派（dispatch）：cloud 无效输入 getRpc/cloudRun/rpc/localRun 全 0 次、有效输入各 1 次、local 只走 localRun；
 * 8. 非 admin/staff 拒绝（contractor 绕过页面直接调用 Hook 也必须在 rpc 前拒绝）；
 * 9. MutationLock 互斥 + CloudContractRefresh 成功刷新 / 失败不刷新 / local 不刷新 / 卸载不刷新；
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
  validateCreateContractFields,
  validateExchangeFields,
  validateReturnFields,
  createContract,
  exchangeItem,
  returnItems,
  isPositiveSafeInt,
  SAFE_CONTRACT_WRITE_ERROR,
  CONTRACT_PERMISSION_ERROR,
} = await import('../src/data/cloudContractMutations')
type ContractCreateCloudInput = import('../src/data/cloudContractMutations').ContractCreateCloudInput
type ContractExchangeCloudInput = import('../src/data/cloudContractMutations').ContractExchangeCloudInput
type ContractReturnCloudInput = import('../src/data/cloudContractMutations').ContractReturnCloudInput
type ContractRpcClient = import('../src/data/cloudContractMutations').ContractRpcClient

const {
  dispatchContractCreateMutation,
  dispatchContractExchangeMutation,
  dispatchContractReturnMutation,
  MutationLock,
  CloudContractRefresh,
} = await import('../src/data/contractDataSource')
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
const validCreate: ContractCreateCloudInput = {
  customer_id: 1,
  contract_date: '2026-08-19',
  duration_days: 3,
  item_ids: [11, 12],
}
const validExchange: ContractExchangeCloudInput = {
  contract_id: 1,
  old_line_id: 2,
  new_item_id: 13,
  return_store_id: 1,
  change_date: '2026-08-19',
}
const validReturn: ContractReturnCloudInput = {
  contract_id: 1,
  line_ids: [2, 3],
  return_store_id: 1,
}

// ---------------------------------------------------------------------------
// fake RPC 客户端（记录 fn/args 调用链）
// ---------------------------------------------------------------------------
type RpcOutcome = { data: unknown; error: unknown } | 'reject'
interface RpcRecord {
  fn: string | null
  args: unknown
}
function makeFakeRpc(outcome: RpcOutcome, rec: RpcRecord): ContractRpcClient {
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
check('create customer_id=0 拒绝', validateCreateContractFields({ ...validCreate, customer_id: 0 }).field === 'customer_id')
check('create contract_date 非法拒绝', validateCreateContractFields({ ...validCreate, contract_date: '2026-02-30' }).field === 'contract_date')
check('create contract_date 空串拒绝', validateCreateContractFields({ ...validCreate, contract_date: '' }).field === 'contract_date')
check('create duration_days=0 拒绝', validateCreateContractFields({ ...validCreate, duration_days: 0 }).field === 'duration_days')
check('create duration_days=1.5 拒绝', validateCreateContractFields({ ...validCreate, duration_days: 1.5 }).field === 'duration_days')
check('create item_ids 空拒绝', validateCreateContractFields({ ...validCreate, item_ids: [] }).field === 'item_ids')
check('create item_ids 重复拒绝', validateCreateContractFields({ ...validCreate, item_ids: [11, 11] }).field === 'item_ids')
check('create item_ids 含 0 拒绝', validateCreateContractFields({ ...validCreate, item_ids: [11, 0] }).field === 'item_ids')
check('create 合法通过', validateCreateContractFields(validCreate).ok === true)

check('exchange contract_id=0 拒绝', validateExchangeFields({ ...validExchange, contract_id: 0 }).field === 'contract_id')
check('exchange new_item_id=0 拒绝', validateExchangeFields({ ...validExchange, new_item_id: 0 }).field === 'new_item_id')
check('exchange return_store_id=0 拒绝', validateExchangeFields({ ...validExchange, return_store_id: 0 }).field === 'return_store_id')
check('exchange change_date 非法拒绝', validateExchangeFields({ ...validExchange, change_date: 'abc' }).field === 'change_date')
check('exchange 合法通过', validateExchangeFields(validExchange).ok === true)

check('return contract_id=0 拒绝', validateReturnFields({ ...validReturn, contract_id: 0 }).field === 'contract_id')
check('return return_store_id=0 拒绝', validateReturnFields({ ...validReturn, return_store_id: 0 }).field === 'return_store_id')
check('return line_ids 空拒绝', validateReturnFields({ ...validReturn, line_ids: [] }).field === 'line_ids')
check('return line_ids 重复拒绝', validateReturnFields({ ...validReturn, line_ids: [2, 2] }).field === 'line_ids')
check('return 合法通过', validateReturnFields(validReturn).ok === true)

// ===========================================================================
// 2. RPC 精确调用链（fn 名 + 参数名）
// ===========================================================================
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await createContract(makeFakeRpc({ data: 42, error: null }, rec), validCreate)
  check('createContract 成功返回 contract_id', res.ok === true && res.data.contract_id === 42)
  check('createContract rpc fn=create_contract', rec.fn === 'create_contract')
  const args = rec.args as Record<string, unknown>
  check('createContract 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_contract_date,p_customer_id,p_duration_days,p_item_ids')
  check('createContract 参数值正确', args.p_customer_id === 1 && args.p_contract_date === '2026-08-19' && args.p_duration_days === 3 && JSON.stringify(args.p_item_ids) === JSON.stringify([11, 12]))
}
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await exchangeItem(makeFakeRpc(voidOk, rec), validExchange)
  check('exchangeItem 成功', res.ok === true)
  check('exchangeItem rpc fn=exchange_item', rec.fn === 'exchange_item')
  const args = rec.args as Record<string, unknown>
  check('exchangeItem 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_change_date,p_contract_id,p_new_item_id,p_old_line_id,p_return_store_id')
}
{
  const rec: RpcRecord = { fn: null, args: null }
  const res = await returnItems(makeFakeRpc(voidOk, rec), validReturn)
  check('returnItems 成功', res.ok === true)
  check('returnItems rpc fn=return_items', rec.fn === 'return_items')
  const args = rec.args as Record<string, unknown>
  check('returnItems 参数名与签名一致', args !== null && typeof args === 'object' &&
    Object.keys(args).sort().join(',') === 'p_contract_id,p_line_ids,p_return_store_id')
  check('returnItems 参数值正确', args.p_contract_id === 1 && args.p_return_store_id === 1 && JSON.stringify(args.p_line_ids) === JSON.stringify([2, 3]))
}

// ===========================================================================
// 3. 非法 ID 在 rpc 前拒绝（rpc 0 次）
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
    const res = await createContract(makeFakeRpc({ data: badId, error: null }, rec), { ...validCreate, customer_id: badId })
    check(`createContract customer_id=${label} 拒绝且不调 rpc`, res.ok === false && rec.fn === null)
  }
  {
    const rec: RpcRecord = { fn: null, args: null }
    const res = await exchangeItem(makeFakeRpc(voidOk, rec), { ...validExchange, contract_id: badId })
    check(`exchangeItem contract_id=${label} 拒绝且不调 rpc`, res.ok === false && rec.fn === null)
  }
  {
    const rec: RpcRecord = { fn: null, args: null }
    const res = await returnItems(makeFakeRpc(voidOk, rec), { ...validReturn, contract_id: badId })
    check(`returnItems contract_id=${label} 拒绝且不调 rpc`, res.ok === false && rec.fn === null)
  }
}

// ===========================================================================
// 4. create_contract 返回值解析
// ===========================================================================
check('create 返回值 number → contract_id', (await createContract(makeFakeRpc({ data: 7, error: null }, { fn: null, args: null }), validCreate)).ok === true && (await createContract(makeFakeRpc({ data: 7, error: null }, { fn: null, args: null }), validCreate)).data.contract_id === 7)
check('create 返回值 string "7" → contract_id 7', (await createContract(makeFakeRpc({ data: '7', error: null }, { fn: null, args: null }), validCreate)).data.contract_id === 7)
check('create 返回值 [7] → contract_id 7', (await createContract(makeFakeRpc({ data: [7], error: null }, { fn: null, args: null }), validCreate)).data.contract_id === 7)
check('create 返回值 null → 安全错误', (await createContract(makeFakeRpc({ data: null, error: null }, { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)
check('create 返回值 0 → 安全错误', (await createContract(makeFakeRpc({ data: 0, error: null }, { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)
check('create 返回值 [7,8] → 安全错误', (await createContract(makeFakeRpc({ data: [7, 8], error: null }, { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)

// ===========================================================================
// 5. 错误映射（42501 → 无权限；P0001/未知 → 通用，不泄露细节）
// ===========================================================================
function errOutcome(code: string): RpcOutcome {
  return { data: null, error: { code, message: 'internal-secret-detail', details: 'internal-secret', hint: 'internal-secret' } }
}
check('createContract 42501 → 无权限', (await createContract(makeFakeRpc(errOutcome('42501'), { fn: null, args: null }), validCreate)).error === CONTRACT_PERMISSION_ERROR)
check('createContract P0001 → 通用错误', (await createContract(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)
check('createContract P0001 → 不泄露细节', !(await createContract(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validCreate)).error.includes('secret'))
check('createContract 未知错误 → 通用错误', (await createContract(makeFakeRpc(errOutcome('99999'), { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)
check('exchangeItem 42501 → 无权限', (await exchangeItem(makeFakeRpc(errOutcome('42501'), { fn: null, args: null }), validExchange)).error === CONTRACT_PERMISSION_ERROR)
check('returnItems P0001 → 通用错误', (await returnItems(makeFakeRpc(errOutcome('P0001'), { fn: null, args: null }), validReturn)).error === SAFE_CONTRACT_WRITE_ERROR)

// ===========================================================================
// 6. SDK reject 收口
// ===========================================================================
check('createContract SDK reject → 通用错误', (await createContract(makeFakeRpc('reject', { fn: null, args: null }), validCreate)).error === SAFE_CONTRACT_WRITE_ERROR)
check('exchangeItem SDK reject → 通用错误', (await exchangeItem(makeFakeRpc('reject', { fn: null, args: null }), validExchange)).error === SAFE_CONTRACT_WRITE_ERROR)
check('returnItems SDK reject → 通用错误', (await returnItems(makeFakeRpc('reject', { fn: null, args: null }), validReturn)).error === SAFE_CONTRACT_WRITE_ERROR)

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
  const getRpcFn = (): ContractRpcClient => {
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
  const res = await dispatchContractCreateMutation(
    'cloud', true, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createContract(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { contract_id: 999 } } },
  )
  check('cloud create 有效 → ok + contract_id', res.ok === true && res.data.contract_id === 42)
  check('cloud create 有效 → getRpc/cloudRun/rpc 各 1 次、localRun 0 次', env.calls.getRpc === 1 && env.calls.cloudRun === 1 && env.calls.rpc === 1 && env.calls.localRun === 0)
}
// 8b. cloud create 空 item_ids → 字段错误且全 0 次
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const bad: ContractCreateCloudInput = { ...validCreate, item_ids: [] }
  const res = await dispatchContractCreateMutation(
    'cloud', true, bad,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createContract(rpc, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: { contract_id: 999 } } },
  )
  check('cloud create 空 item_ids → field item_ids', res.ok === false && res.field === 'item_ids')
  check('cloud create 空 item_ids → getRpc/cloudRun/rpc/localRun 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
// 8c. local create → 只走 localRun
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const res = await dispatchContractCreateMutation(
    'local', true, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createContract(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { contract_id: 123 } } },
  )
  check('local create → localRun 1 次', env.calls.localRun === 1)
  check('local create → getRpc/cloudRun/rpc 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0)
  check('local create → 透传', res.ok === true && res.data.contract_id === 123)
}
// 8d. cloud exchange 有效 → 各 1 次
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchContractExchangeMutation(
    'cloud', true, validExchange,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return exchangeItem(rpc, validExchange) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud exchange 有效 → ok', res.ok === true)
  check('cloud exchange 有效 → getRpc/cloudRun/rpc 各 1 次、localRun 0 次', env.calls.getRpc === 1 && env.calls.cloudRun === 1 && env.calls.rpc === 1 && env.calls.localRun === 0)
}
// 8e. cloud return 非法 line_ids → 全 0 次
{
  const env = makeCountingDispatch(voidOk)
  const bad: ContractReturnCloudInput = { ...validReturn, line_ids: [] }
  const res = await dispatchContractReturnMutation(
    'cloud', true, bad,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return returnItems(rpc, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud return 空 line_ids → field line_ids', res.ok === false && res.field === 'line_ids')
  check('cloud return 空 line_ids → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}

// ===========================================================================
// 9. 非 admin/staff 拒绝（contractor 绕过页面直接调用 Hook 也必须在 rpc 前拒绝）
// ===========================================================================
{
  const env = makeCountingDispatch({ data: 42, error: null })
  const res = await dispatchContractCreateMutation(
    'cloud', false, validCreate,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return createContract(rpc, validCreate) },
    () => { env.calls.localRun++; return { ok: true as const, data: { contract_id: 999 } } },
  )
  check('cloud 非 admin/staff create → 无权限', res.ok === false && res.error === CONTRACT_PERMISSION_ERROR)
  check('cloud 非 admin/staff create → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchContractExchangeMutation(
    'cloud', false, validExchange,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return exchangeItem(rpc, validExchange) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud 非 admin/staff exchange → 无权限', res.ok === false && res.error === CONTRACT_PERMISSION_ERROR)
  check('cloud 非 admin/staff exchange → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}
{
  const env = makeCountingDispatch(voidOk)
  const res = await dispatchContractReturnMutation(
    'cloud', false, validReturn,
    env.getRpcFn,
    async (rpc) => { env.calls.cloudRun++; return returnItems(rpc, validReturn) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
  )
  check('cloud 非 admin/staff return → 无权限', res.ok === false && res.error === CONTRACT_PERMISSION_ERROR)
  check('cloud 非 admin/staff return → 全 0 次', env.calls.getRpc === 0 && env.calls.cloudRun === 0 && env.calls.rpc === 0 && env.calls.localRun === 0)
}

// ===========================================================================
// 10. MutationLock + CloudContractRefresh
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
  const refresher = new CloudContractRefresh(guard, () => { refetchCalls++ }, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: { contract_id: 1 } }, true)
  check('写成功后触发重读（refetch 1 次）', refetchCalls === 1)
  refetchCalls = 0
  refresher.refreshIfNeeded({ ok: false as const, error: SAFE_CONTRACT_WRITE_ERROR }, true)
  check('写失败不触发重读', refetchCalls === 0)
  refresher.refreshIfNeeded({ ok: true as const, data: { contract_id: 1 } }, false)
  check('local 模式不触发重读', refetchCalls === 0)
  const guard2 = new LatestRequestGuard()
  let refetchCalls2 = 0
  const refresher2 = new CloudContractRefresh(guard2, () => { refetchCalls2++ }, () => false)
  refresher2.refreshIfNeeded({ ok: true as const, data: { contract_id: 1 } }, true)
  check('组件已卸载不触发重读', refetchCalls2 === 0)
}
{
  const guard = new LatestRequestGuard()
  const t0 = guard.begin()
  const refresher = new CloudContractRefresh(guard, () => {}, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: { contract_id: 1 } }, true)
  check('写成功后旧 token 已失效', guard.isLatest(t0) === false)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
