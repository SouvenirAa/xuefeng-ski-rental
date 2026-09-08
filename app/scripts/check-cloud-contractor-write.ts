/**
 * 云端「承包商 / 费率」写操作校验脚本
 * （由 validate-cloud-contractor-write.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-contractor-write
 *
 * 覆盖：
 * 1. payload 白名单 / 归一化（name trim、nullable → null、无越权字段）；
 * 2. 字段校验（name 必填 trim、可空字段运行时类型与长度、effective_date 严格日期、hourly_rate 有限正数）；
 * 3. create/update/delete 精确调用链（from/insert/update/delete/eq/select、显式列非 '*'）；
 * 4. 非法 contractor_id/rate_id（0/负数/小数/NaN/超安全整数）在 getRdb 前拒绝（RDB 0 次）；
 * 5. 0 行 / 多行 fail-closed 语义；
 * 6. 错误映射：承包商 23503/23514/42501/未知（不虚构 23505 名称重复）；费率 23505 日期冲突 / 23503 承包商不存在 /
 *    P0001 触发器被引用 / 23514 / 42501 / 未知；
 * 7. SDK Promise reject / SDK error 收口为安全错误；
 * 8. 分派（dispatch）：cloud 无效输入 getRdb/cloudRun/from/localRun 全 0 次、有效输入各 1 次；local 只走 localRun；
 * 9. local 转换（toLocalContractorInput / toLocalContractorRateInput）+ local DataService CRUD 不回归；
 * 10. MutationLock 互斥 + CloudContractorRefresh 成功刷新 / 失败不刷新；
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
  buildContractorPayload,
  buildRateCreatePayload,
  buildRateUpdatePayload,
  validateContractorFields,
  validateRateFields,
  createContractor,
  updateContractor,
  removeContractor,
  createContractorRate,
  updateContractorRate,
  removeContractorRate,
  isPositiveSafeInt,
  SAFE_CONTRACTOR_WRITE_ERROR,
  SAFE_RATE_WRITE_ERROR,
  CONTRACTOR_REFERENCED_ERROR,
  CONTRACTOR_CHECK_VIOLATION_ERROR,
  CONTRACTOR_UPDATE_NOT_FOUND_ERROR,
  CONTRACTOR_DELETE_NOT_FOUND_ERROR,
  CONTRACTOR_PERMISSION_ERROR,
  RATE_DATE_CONFLICT_ERROR,
  RATE_REFERENCE_MISSING_ERROR,
  RATE_REFERENCED_ERROR,
  RATE_CHECK_VIOLATION_ERROR,
  RATE_UPDATE_NOT_FOUND_ERROR,
  RATE_DELETE_NOT_FOUND_ERROR,
  RATE_PERMISSION_ERROR,
} = await import('../src/data/cloudContractorMutations')
type ContractorCloudInput = import('../src/data/cloudContractorMutations').ContractorCloudInput
type ContractorRateCloudInput = import('../src/data/cloudContractorMutations').ContractorRateCloudInput
type ContractorRdbMutationClient = import('../src/data/cloudContractorMutations').ContractorRdbMutationClient
type ContractorMutationBuilder = import('../src/data/cloudContractorMutations').ContractorMutationBuilder

const {
  CONTRACTOR_SELECT_COLUMNS,
  RATE_SELECT_COLUMNS,
  SAFE_CONTRACTOR_ERROR,
} = await import('../src/data/cloudContractors')
type ContractorView = import('../src/data/cloudContractors').ContractorView
type ContractorRateView = import('../src/data/cloudContractors').ContractorRateView

const {
  dispatchContractorWriteMutation,
  dispatchContractorIdMutation,
  dispatchRateCreateMutation,
  dispatchRateUpdateMutation,
  dispatchRateIdMutation,
  toLocalContractorInput,
  toLocalContractorRateInput,
  MutationLock,
  CloudContractorRefresh,
} = await import('../src/data/contractorDataSource')
const { LatestRequestGuard } = await import('../src/data/contractDataSource')
const { dataService } = await import('../src/data/dataService')

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
const fakeContractor: ContractorView = {
  contractor_id: 1,
  name: '峰顶装备维修',
  address: '云顶工业园 A 栋',
  phone: '13900000001',
  email: 'service@fengding.example',
}
const fakeRate: ContractorRateView = {
  rate_id: 1,
  contractor_id: 1,
  effective_date: '2026-01-01',
  hourly_rate: 180,
}
const validContractorCloudInput: ContractorCloudInput = {
  name: '峰顶装备维修',
  address: '云顶工业园 A 栋',
  phone: '13900000001',
  email: 'service@fengding.example',
}
const validRateCloudInput: ContractorRateCloudInput = {
  effective_date: '2026-01-01',
  hourly_rate: 180,
}

// ---------------------------------------------------------------------------
// fake RDB 写客户端（记录 from/insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------
type ContractorMutationOutcome =
  | { kind: 'resolve'; value: { data: unknown; error: unknown } }
  | { kind: 'reject' }
interface ContractorMutationRecord {
  table: string | null
  insertPayload: Record<string, unknown> | null
  updatePayload: Record<string, unknown> | null
  deleted: boolean
  eqColumn: string | null
  eqValue: unknown
  selectColumns: string | null
}
function emptyRecord(): ContractorMutationRecord {
  return {
    table: null,
    insertPayload: null,
    updatePayload: null,
    deleted: false,
    eqColumn: null,
    eqValue: null,
    selectColumns: null,
  }
}
function makeFakeContractorRdb(
  outcome: ContractorMutationOutcome,
  record: ContractorMutationRecord,
): ContractorRdbMutationClient {
  function makeBuilder(): ContractorMutationBuilder {
    const builder = {} as ContractorMutationBuilder
    builder.eq = (column: string, value: unknown) => {
      record.eqColumn = column
      record.eqValue = value
      return builder
    }
    builder.select = (columns: string) => {
      record.selectColumns = columns
      return builder
    }
    builder.then = (
      onFulfilled?: (v: { data: unknown; error: unknown }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => {
      if (outcome.kind === 'reject') {
        return Promise.reject(new Error('sdk-network-internal')).then(onFulfilled, onRejected)
      }
      return Promise.resolve(outcome.value).then(onFulfilled, onRejected)
    }
    return builder
  }
  return {
    from(table: string) {
      record.table = table
      return {
        insert(values: Record<string, unknown>) {
          record.insertPayload = values
          record.updatePayload = null
          record.deleted = false
          return makeBuilder()
        },
        update(values: Record<string, unknown>) {
          record.updatePayload = values
          record.insertPayload = null
          record.deleted = false
          return makeBuilder()
        },
        delete() {
          record.deleted = true
          record.insertPayload = null
          record.updatePayload = null
          return makeBuilder()
        },
      }
    },
  }
}

const contractorOkOutcome: ContractorMutationOutcome = {
  kind: 'resolve',
  value: { data: [fakeContractor], error: null },
}
const rateOkOutcome: ContractorMutationOutcome = {
  kind: 'resolve',
  value: { data: [fakeRate], error: null },
}

// ===========================================================================
// 1. 承包商 payload 白名单 / 归一化
// ===========================================================================
{
  const p = buildContractorPayload({ name: ' 峰顶装备维修 ', address: '', phone: '   ', email: ' x@y.example ' })
  check('contractor payload 仅 4 字段', Object.keys(p).length === 4)
  check('contractor payload 无 contractor_id/rate_id/role/uid/account_id/actorRole', !('contractor_id' in p) && !('rate_id' in p) && !('role' in p) && !('uid' in p) && !('account_id' in p) && !('actorRole' in p))
  check('contractor payload name trim', p.name === '峰顶装备维修')
  check('contractor payload address 空串 → null', p.address === null)
  check('contractor payload phone 空白 → null', p.phone === null)
  check('contractor payload email trim', p.email === 'x@y.example')
}

// ===========================================================================
// 2. 承包商字段校验
// ===========================================================================
check('name 空白拒绝', validateContractorFields({ name: '   ', address: null, phone: null, email: null }).field === 'name')
check('name 非 string 拒绝', validateContractorFields({ name: 123 as unknown as string, address: null, phone: null, email: null }).field === 'name')
check('name=80 边界通过', validateContractorFields({ name: 'x'.repeat(80), address: null, phone: null, email: null }).ok === true)
check('name=81 超长拒绝', validateContractorFields({ name: 'x'.repeat(81), address: null, phone: null, email: null }).field === 'name')
check('address 非 string 拒绝', validateContractorFields({ name: 'a', address: 1 as unknown as string, phone: null, email: null }).field === 'address')
check('address=201 超长拒绝', validateContractorFields({ name: 'a', address: 'x'.repeat(201), phone: null, email: null }).field === 'address')
check('phone=21 超长拒绝', validateContractorFields({ name: 'a', address: null, phone: 'x'.repeat(21), email: null }).field === 'phone')
check('email=101 超长拒绝', validateContractorFields({ name: 'a', address: null, phone: null, email: 'x'.repeat(101) }).field === 'email')
check('nullable 均 null 通过', validateContractorFields({ name: 'a', address: null, phone: null, email: null }).ok === true)

// ===========================================================================
// 3. 费率 payload / 字段校验
// ===========================================================================
{
  const pc = buildRateCreatePayload(validRateCloudInput, 7)
  check('rate create payload 仅 3 字段', Object.keys(pc).length === 3)
  check('rate create payload 无 rate_id/role/uid/account_id', !('rate_id' in pc) && !('role' in pc) && !('uid' in pc) && !('account_id' in pc))
  check('rate create payload contractor_id=7', pc.contractor_id === 7)
  const pu = buildRateUpdatePayload(validRateCloudInput)
  check('rate update payload 仅 2 字段（无 contractor_id/rate_id）', Object.keys(pu).length === 2 && !('contractor_id' in pu) && !('rate_id' in pu))
}
check('effective_date 空串拒绝', validateRateFields({ effective_date: '', hourly_rate: 180 }).field === 'effective_date')
check('effective_date 非 string 拒绝', validateRateFields({ effective_date: 20260101 as unknown as string, hourly_rate: 180 }).field === 'effective_date')
check('effective_date 非法日期 2026-02-30 拒绝', validateRateFields({ effective_date: '2026-02-30', hourly_rate: 180 }).field === 'effective_date')
check('effective_date 格式错 abc 拒绝', validateRateFields({ effective_date: 'abc', hourly_rate: 180 }).field === 'effective_date')
check('effective_date 合法通过', validateRateFields({ effective_date: '2026-01-01', hourly_rate: 180 }).ok === true)
check('hourly_rate=0 拒绝', validateRateFields({ effective_date: '2026-01-01', hourly_rate: 0 }).field === 'hourly_rate')
check('hourly_rate=-1 拒绝', validateRateFields({ effective_date: '2026-01-01', hourly_rate: -1 }).field === 'hourly_rate')
check('hourly_rate=NaN 拒绝', validateRateFields({ effective_date: '2026-01-01', hourly_rate: Number.NaN }).field === 'hourly_rate')
check('hourly_rate=Infinity 拒绝', validateRateFields({ effective_date: '2026-01-01', hourly_rate: Number.POSITIVE_INFINITY }).field === 'hourly_rate')
check('hourly_rate 非 number 拒绝', validateRateFields({ effective_date: '2026-01-01', hourly_rate: '180' as unknown as number }).field === 'hourly_rate')

// ===========================================================================
// 4. 承包商 create/update/delete 精确调用链
// ===========================================================================
{
  const rec = emptyRecord()
  const res = await createContractor(makeFakeContractorRdb(contractorOkOutcome, rec), validContractorCloudInput)
  check('createContractor 成功', res.ok === true)
  check('createContractor from=contractors', rec.table === 'contractors')
  check('createContractor 走 insert', rec.insertPayload !== null && rec.updatePayload === null && rec.deleted === false)
  check('createContractor 不设 eq', rec.eqColumn === null)
  check('createContractor select 精确列（非 *）', rec.selectColumns === CONTRACTOR_SELECT_COLUMNS && !rec.selectColumns!.includes('*'))
}
{
  const rec = emptyRecord()
  const res = await updateContractor(makeFakeContractorRdb(contractorOkOutcome, rec), 1, validContractorCloudInput)
  check('updateContractor 成功', res.ok === true)
  check('updateContractor from=contractors', rec.table === 'contractors')
  check('updateContractor 走 update', rec.updatePayload !== null && rec.insertPayload === null && rec.deleted === false)
  check('updateContractor eq contractor_id=1', rec.eqColumn === 'contractor_id' && rec.eqValue === 1)
  check('updateContractor select 精确列', rec.selectColumns === CONTRACTOR_SELECT_COLUMNS)
}
{
  const rec = emptyRecord()
  const res = await removeContractor(makeFakeContractorRdb(contractorOkOutcome, rec), 1)
  check('removeContractor 成功', res.ok === true)
  check('removeContractor from=contractors', rec.table === 'contractors')
  check('removeContractor 走 delete', rec.deleted === true && rec.insertPayload === null && rec.updatePayload === null)
  check('removeContractor eq contractor_id=1', rec.eqColumn === 'contractor_id' && rec.eqValue === 1)
}

// ===========================================================================
// 5. 费率 create/update/delete 精确调用链
// ===========================================================================
{
  const rec = emptyRecord()
  const res = await createContractorRate(makeFakeContractorRdb(rateOkOutcome, rec), 7, validRateCloudInput)
  check('createContractorRate 成功', res.ok === true)
  check('createContractorRate from=contractor_rates', rec.table === 'contractor_rates')
  check('createContractorRate 走 insert', rec.insertPayload !== null && rec.updatePayload === null && rec.deleted === false)
  check('createContractorRate 不设 eq', rec.eqColumn === null)
  check('createContractorRate payload 含 contractor_id=7', rec.insertPayload !== null && rec.insertPayload.contractor_id === 7)
  check('createContractorRate select 精确列（非 *）', rec.selectColumns === RATE_SELECT_COLUMNS && !rec.selectColumns!.includes('*'))
}
{
  const rec = emptyRecord()
  const res = await updateContractorRate(makeFakeContractorRdb(rateOkOutcome, rec), 1, validRateCloudInput)
  check('updateContractorRate 成功', res.ok === true)
  check('updateContractorRate from=contractor_rates', rec.table === 'contractor_rates')
  check('updateContractorRate 走 update', rec.updatePayload !== null && rec.insertPayload === null && rec.deleted === false)
  check('updateContractorRate payload 无 contractor_id', rec.updatePayload !== null && !('contractor_id' in rec.updatePayload))
  check('updateContractorRate eq rate_id=1', rec.eqColumn === 'rate_id' && rec.eqValue === 1)
}
{
  const rec = emptyRecord()
  const res = await removeContractorRate(makeFakeContractorRdb(rateOkOutcome, rec), 1)
  check('removeContractorRate 成功', res.ok === true)
  check('removeContractorRate from=contractor_rates', rec.table === 'contractor_rates')
  check('removeContractorRate 走 delete', rec.deleted === true && rec.insertPayload === null && rec.updatePayload === null)
  check('removeContractorRate eq rate_id=1', rec.eqColumn === 'rate_id' && rec.eqValue === 1)
}

// ===========================================================================
// 6. 非法 ID 拒绝（正安全整数校验，RDB 不触碰）
// ===========================================================================
const badIds: Array<[string, number]> = [
  ['0', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['NaN', Number.NaN],
  ['超安全整数', Number.MAX_SAFE_INTEGER + 1],
]
for (const [label, badId] of badIds) {
  const recC = emptyRecord()
  const upd = await updateContractor(makeFakeContractorRdb(contractorOkOutcome, recC), badId, validContractorCloudInput)
  check(`updateContractor id=${label} 拒绝且不调 RDB`, upd.ok === false && recC.table === null)
  const recC2 = emptyRecord()
  const rm = await removeContractor(makeFakeContractorRdb(contractorOkOutcome, recC2), badId)
  check(`removeContractor id=${label} 拒绝且不调 RDB`, rm.ok === false && recC2.table === null)
  const recR = emptyRecord()
  const updR = await updateContractorRate(makeFakeContractorRdb(rateOkOutcome, recR), badId, validRateCloudInput)
  check(`updateContractorRate id=${label} 拒绝且不调 RDB`, updR.ok === false && recR.table === null)
  const recR2 = emptyRecord()
  const rmR = await removeContractorRate(makeFakeContractorRdb(rateOkOutcome, recR2), badId)
  check(`removeContractorRate id=${label} 拒绝且不调 RDB`, rmR.ok === false && recR2.table === null)
  const recR3 = emptyRecord()
  const crR = await createContractorRate(makeFakeContractorRdb(rateOkOutcome, recR3), badId, validRateCloudInput)
  check(`createContractorRate contractor_id=${label} 拒绝且不调 RDB`, crR.ok === false && recR3.table === null)
}

// ===========================================================================
// 7. 0 行 / 多行语义（fail-closed）
// ===========================================================================
const zeroOutcome: ContractorMutationOutcome = { kind: 'resolve', value: { data: [], error: null } }
check('updateContractor 0 行 → 不存在或无权限', (await updateContractor(makeFakeContractorRdb(zeroOutcome, emptyRecord()), 1, validContractorCloudInput)).error === CONTRACTOR_UPDATE_NOT_FOUND_ERROR)
check('removeContractor 0 行 → 不存在或无权限', (await removeContractor(makeFakeContractorRdb(zeroOutcome, emptyRecord()), 1)).error === CONTRACTOR_DELETE_NOT_FOUND_ERROR)
check('updateContractorRate 0 行 → 不存在或无权限', (await updateContractorRate(makeFakeContractorRdb(zeroOutcome, emptyRecord()), 1, validRateCloudInput)).error === RATE_UPDATE_NOT_FOUND_ERROR)
check('removeContractorRate 0 行 → 不存在或无权限', (await removeContractorRate(makeFakeContractorRdb(zeroOutcome, emptyRecord()), 1)).error === RATE_DELETE_NOT_FOUND_ERROR)
const multiOutcome: ContractorMutationOutcome = { kind: 'resolve', value: { data: [fakeContractor, fakeContractor], error: null } }
check('updateContractor 多行 → fail-closed', (await updateContractor(makeFakeContractorRdb(multiOutcome, emptyRecord()), 1, validContractorCloudInput)).error === SAFE_CONTRACTOR_WRITE_ERROR)
const multiRateOutcome: ContractorMutationOutcome = { kind: 'resolve', value: { data: [fakeRate, fakeRate], error: null } }
check('updateContractorRate 多行 → fail-closed', (await updateContractorRate(makeFakeContractorRdb(multiRateOutcome, emptyRecord()), 1, validRateCloudInput)).error === SAFE_RATE_WRITE_ERROR)

// ===========================================================================
// 8. 错误映射
// ===========================================================================
function errOutcome(code: string): ContractorMutationOutcome {
  return { kind: 'resolve', value: { data: null, error: { code, message: 'internal-secret', details: 'internal-secret', hint: 'internal-secret' } } }
}
// 承包商：23503（被引用删除）/ 23514 / 42501 / 未知；23505 不虚构名称重复
check('removeContractor 23503 → 被引用无法删除', (await removeContractor(makeFakeContractorRdb(errOutcome('23503'), emptyRecord()), 1)).error === CONTRACTOR_REFERENCED_ERROR)
check('createContractor 23514 → 信息不合规', (await createContractor(makeFakeContractorRdb(errOutcome('23514'), emptyRecord()), validContractorCloudInput)).error === CONTRACTOR_CHECK_VIOLATION_ERROR)
check('createContractor 42501 → 无权限', (await createContractor(makeFakeContractorRdb(errOutcome('42501'), emptyRecord()), validContractorCloudInput)).error === CONTRACTOR_PERMISSION_ERROR)
check('contractor 无 UNIQUE：23505 → 通用错误', (await createContractor(makeFakeContractorRdb(errOutcome('23505'), emptyRecord()), validContractorCloudInput)).error === SAFE_CONTRACTOR_WRITE_ERROR)
check('contractor 未知错误 → 通用错误', (await createContractor(makeFakeContractorRdb(errOutcome('99999'), emptyRecord()), validContractorCloudInput)).error === SAFE_CONTRACTOR_WRITE_ERROR)
// 费率：23505 日期冲突 / 23503 承包商不存在 / P0001 触发器被引用 / 23514 / 42501 / 未知
check('createContractorRate 23505 → 日期冲突', (await createContractorRate(makeFakeContractorRdb(errOutcome('23505'), emptyRecord()), 7, validRateCloudInput)).error === RATE_DATE_CONFLICT_ERROR)
check('createContractorRate 23505 → field effective_date', (await createContractorRate(makeFakeContractorRdb(errOutcome('23505'), emptyRecord()), 7, validRateCloudInput)).field === 'effective_date')
check('createContractorRate 23503 → 承包商不存在', (await createContractorRate(makeFakeContractorRdb(errOutcome('23503'), emptyRecord()), 7, validRateCloudInput)).error === RATE_REFERENCE_MISSING_ERROR)
check('updateContractorRate P0001 → 已被维修单引用', (await updateContractorRate(makeFakeContractorRdb(errOutcome('P0001'), emptyRecord()), 1, validRateCloudInput)).error === RATE_REFERENCED_ERROR)
check('removeContractorRate P0001 → 已被维修单引用', (await removeContractorRate(makeFakeContractorRdb(errOutcome('P0001'), emptyRecord()), 1)).error === RATE_REFERENCED_ERROR)
check('createContractorRate P0001 → 通用错误（create 不触发冻结触发器，不误报为被引用）', (await createContractorRate(makeFakeContractorRdb(errOutcome('P0001'), emptyRecord()), 7, validRateCloudInput)).error === SAFE_RATE_WRITE_ERROR)
check('createContractorRate 23514 → 费率不合规', (await createContractorRate(makeFakeContractorRdb(errOutcome('23514'), emptyRecord()), 7, validRateCloudInput)).error === RATE_CHECK_VIOLATION_ERROR)
check('createContractorRate 42501 → 无权限', (await createContractorRate(makeFakeContractorRdb(errOutcome('42501'), emptyRecord()), 7, validRateCloudInput)).error === RATE_PERMISSION_ERROR)
check('rate 未知错误 → 通用错误', (await createContractorRate(makeFakeContractorRdb(errOutcome('99999'), emptyRecord()), 7, validRateCloudInput)).error === SAFE_RATE_WRITE_ERROR)

// ===========================================================================
// 9. SDK reject / SDK error 收口
// ===========================================================================
check('createContractor SDK reject → 通用错误', (await createContractor(makeFakeContractorRdb({ kind: 'reject' }, emptyRecord()), validContractorCloudInput)).error === SAFE_CONTRACTOR_WRITE_ERROR)
check('createContractorRate SDK reject → 通用错误', (await createContractorRate(makeFakeContractorRdb({ kind: 'reject' }, emptyRecord()), 7, validRateCloudInput)).error === SAFE_RATE_WRITE_ERROR)

// ===========================================================================
// 10. isPositiveSafeInt
// ===========================================================================
check('isPositiveSafeInt(1)=true', isPositiveSafeInt(1) === true)
check('isPositiveSafeInt(0)=false', isPositiveSafeInt(0) === false)
check('isPositiveSafeInt(-1)=false', isPositiveSafeInt(-1) === false)
check('isPositiveSafeInt(1.5)=false', isPositiveSafeInt(1.5) === false)
check('isPositiveSafeInt(MAX_SAFE+1)=false', isPositiveSafeInt(Number.MAX_SAFE_INTEGER + 1) === false)
check('isPositiveSafeInt(NaN)=false', isPositiveSafeInt(Number.NaN) === false)

// ===========================================================================
// 11. 分派：cloud 无效输入全 0 次 / 有效输入各 1 次 / local 只走 localRun
// ===========================================================================
function makeCountingDispatch(outcome: ContractorMutationOutcome) {
  const calls = { getRdb: 0, cloudRun: 0, localRun: 0, from: 0 }
  const getRdbFn = (): ContractorRdbMutationClient => {
    calls.getRdb++
    const inner = makeFakeContractorRdb(outcome, emptyRecord())
    return {
      from(table: string) {
        calls.from++
        return inner.from(table)
      },
    }
  }
  return { calls, getRdbFn }
}

// 11a. cloud createContractor 有效输入
{
  const env = makeCountingDispatch(contractorOkOutcome)
  const res = await dispatchContractorWriteMutation(
    'cloud', true, validContractorCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractor(rdb, validContractorCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeContractor } },
  )
  check('cloud createContractor 有效 → ok', res.ok === true)
  check('cloud createContractor 有效 → getRdb/cloudRun/from 各 1 次、localRun 0 次', env.calls.getRdb === 1 && env.calls.cloudRun === 1 && env.calls.from === 1 && env.calls.localRun === 0)
}
// 11b. cloud createContractor 空 name → 字段错误且全 0 次
{
  const env = makeCountingDispatch(contractorOkOutcome)
  const bad: ContractorCloudInput = { name: '', address: null, phone: null, email: null }
  const res = await dispatchContractorWriteMutation(
    'cloud', true, bad, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractor(rdb, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeContractor } },
  )
  check('cloud createContractor 空 name → field name', res.ok === false && res.field === 'name')
  check('cloud createContractor 空 name → getRdb/cloudRun/localRun/from 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
// 11c. local createContractor → 只走 localRun
{
  const env = makeCountingDispatch(contractorOkOutcome)
  const res = await dispatchContractorWriteMutation(
    'local', true, validContractorCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractor(rdb, validContractorCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeContractor } },
  )
  check('local createContractor → localRun 1 次', env.calls.localRun === 1)
  check('local createContractor → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
  check('local createContractor → 透传', res.ok === true)
}
// 11d. cloud rate create 无效 contractor_id → 全 0 次
{
  const env = makeCountingDispatch(rateOkOutcome)
  const res = await dispatchRateCreateMutation(
    'cloud', true, 0, validRateCloudInput,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractorRate(rdb, 0, validRateCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
  )
  check('cloud rate create contractor_id=0 → 拒绝且全 0 次', res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
// 11e. cloud rate create 空日期 → 字段错误且全 0 次
{
  const env = makeCountingDispatch(rateOkOutcome)
  const bad: ContractorRateCloudInput = { effective_date: '', hourly_rate: 180 }
  const res = await dispatchRateCreateMutation(
    'cloud', true, 7, bad,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractorRate(rdb, 7, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
  )
  check('cloud rate create 空日期 → field effective_date', res.ok === false && res.field === 'effective_date')
  check('cloud rate create 空日期 → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
// 11f. cloud rate create 有效输入 → 各 1 次
{
  const env = makeCountingDispatch(rateOkOutcome)
  const res = await dispatchRateCreateMutation(
    'cloud', true, 7, validRateCloudInput,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractorRate(rdb, 7, validRateCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
  )
  check('cloud rate create 有效 → ok', res.ok === true)
  check('cloud rate create 有效 → getRdb/cloudRun/from 各 1 次、localRun 0 次', env.calls.getRdb === 1 && env.calls.cloudRun === 1 && env.calls.from === 1 && env.calls.localRun === 0)
}

// ===========================================================================
// 12. 分派：ID 前置校验（非法 ID 在 getRdb 前拒绝）
// ===========================================================================
for (const [label, badId] of badIds) {
  {
    const env = makeCountingDispatch(contractorOkOutcome)
    const res = await dispatchContractorWriteMutation(
      'cloud', true, validContractorCloudInput, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return updateContractor(rdb, badId, validContractorCloudInput) },
      () => { env.calls.localRun++; return { ok: true as const, data: fakeContractor } },
    )
    check(`cloud updateContractor id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(contractorOkOutcome)
    const res = await dispatchContractorIdMutation(
      'cloud', true, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return removeContractor(rdb, badId) },
      () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
      { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR },
    )
    check(`cloud removeContractor id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(rateOkOutcome)
    const res = await dispatchRateUpdateMutation(
      'cloud', true, badId, validRateCloudInput,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return updateContractorRate(rdb, badId, validRateCloudInput) },
      () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
    )
    check(`cloud updateRate id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(rateOkOutcome)
    const res = await dispatchRateIdMutation(
      'cloud', true, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return removeContractorRate(rdb, badId) },
      () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
      { ok: false, error: SAFE_RATE_WRITE_ERROR },
    )
    check(`cloud removeRate id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
}

// ===========================================================================
// 12b. 非 admin 拒绝（cloud 模式：staff/contractor 绕过页面直接调用 Hook 也必须在 getRdb 前拒绝）
// ===========================================================================
{
  const env = makeCountingDispatch(contractorOkOutcome)
  const res = await dispatchContractorWriteMutation(
    'cloud', false, validContractorCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractor(rdb, validContractorCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeContractor } },
  )
  check('cloud 非 admin createContractor → 无权限', res.ok === false && res.error === CONTRACTOR_PERMISSION_ERROR)
  check('cloud 非 admin createContractor → getRdb/cloudRun/localRun/from 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(contractorOkOutcome)
  const res = await dispatchContractorIdMutation(
    'cloud', false, 1,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return removeContractor(rdb, 1) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false, error: SAFE_CONTRACTOR_WRITE_ERROR },
  )
  check('cloud 非 admin removeContractor → 无权限', res.ok === false && res.error === CONTRACTOR_PERMISSION_ERROR)
  check('cloud 非 admin removeContractor → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(rateOkOutcome)
  const res = await dispatchRateCreateMutation(
    'cloud', false, 7, validRateCloudInput,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createContractorRate(rdb, 7, validRateCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
  )
  check('cloud 非 admin createRate → 无权限', res.ok === false && res.error === RATE_PERMISSION_ERROR)
  check('cloud 非 admin createRate → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(rateOkOutcome)
  const res = await dispatchRateUpdateMutation(
    'cloud', false, 1, validRateCloudInput,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return updateContractorRate(rdb, 1, validRateCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeRate } },
  )
  check('cloud 非 admin updateRate → 无权限', res.ok === false && res.error === RATE_PERMISSION_ERROR)
  check('cloud 非 admin updateRate → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(rateOkOutcome)
  const res = await dispatchRateIdMutation(
    'cloud', false, 1,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return removeContractorRate(rdb, 1) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false, error: SAFE_RATE_WRITE_ERROR },
  )
  check('cloud 非 admin removeRate → 无权限', res.ok === false && res.error === RATE_PERMISSION_ERROR)
  check('cloud 非 admin removeRate → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}

// ===========================================================================
// 13. local 转换 + local DataService CRUD 不回归
// ===========================================================================
{
  const local = toLocalContractorInput({ name: 'x', address: null, phone: null, email: null })
  check('toLocalContractorInput address null → ""', local.address === '')
  check('toLocalContractorInput phone null → ""', local.phone === '')
  check('toLocalContractorInput email null → ""', local.email === '')
  const localRate = toLocalContractorRateInput(validRateCloudInput)
  check('toLocalContractorRateInput 透传', localRate.effective_date === '2026-01-01' && localRate.hourly_rate === 180)
}

const initResult = dataService.init()
if (initResult.ok) {
  const contractorCountBefore = dataService.listContractors().length
  const rateCountBefore = dataService.listContractorRates().length

  const created = dataService.createContractor('admin', { name: '回归承包商', address: '', phone: '', email: '' })
  check('local createContractor 成功', created.ok === true)
  if (created.ok) {
    const cid = created.data.contractor_id
    check('local createContractor 行数 +1', dataService.listContractors().length === contractorCountBefore + 1)
    const upd = dataService.updateContractor('admin', cid, { name: '回归承包商2', address: 'a', phone: 'b', email: 'c' })
    check('local updateContractor 成功', upd.ok === true)

    const rateCreated = dataService.createContractorRate('admin', cid, { effective_date: '2026-01-01', hourly_rate: 150 })
    check('local createContractorRate 成功', rateCreated.ok === true)
    if (rateCreated.ok) {
      const rid = rateCreated.data.rate_id
      check('local createContractorRate 行数 +1', dataService.listContractorRates().length === rateCountBefore + 1)
      const updRate = dataService.updateContractorRate('admin', rid, { effective_date: '2026-02-01', hourly_rate: 160 })
      check('local updateContractorRate 成功', updRate.ok === true)
      const rmRate = dataService.removeContractorRate('admin', rid)
      check('local removeContractorRate 成功', rmRate.ok === true)
    }

    const rm = dataService.removeContractor('admin', cid)
    check('local removeContractor 成功', rm.ok === true)
    check('local removeContractor 行数恢复', dataService.listContractors().length === contractorCountBefore)
  }
  check('local staff createContractor 被拒绝', dataService.createContractor('staff', { name: '越权', address: '', phone: '', email: '' }).ok === false)
}

// ===========================================================================
// 14. MutationLock + CloudContractorRefresh
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
  const refresher = new CloudContractorRefresh(guard, () => { refetchCalls++ }, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeContractor }, true)
  check('写成功后触发重读（refetch 1 次）', refetchCalls === 1)
  refetchCalls = 0
  refresher.refreshIfNeeded({ ok: false as const, error: SAFE_CONTRACTOR_WRITE_ERROR }, true)
  check('写失败不触发重读', refetchCalls === 0)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeContractor }, false)
  check('local 模式不触发重读', refetchCalls === 0)
  // 已卸载（isActive=false）不刷新
  const guard2 = new LatestRequestGuard()
  let refetchCalls2 = 0
  const refresher2 = new CloudContractorRefresh(guard2, () => { refetchCalls2++ }, () => false)
  refresher2.refreshIfNeeded({ ok: true as const, data: fakeContractor }, true)
  check('组件已卸载不触发重读', refetchCalls2 === 0)
}
// 刷新会失效旧 token
{
  const guard = new LatestRequestGuard()
  const t0 = guard.begin()
  const refresher = new CloudContractorRefresh(guard, () => {}, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeContractor }, true)
  check('写成功后旧 token 已失效', guard.isLatest(t0) === false)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
