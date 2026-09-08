/**
 * 云端「员工 / 排班」写操作校验脚本
 * （由 validate-cloud-workforce-write.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-workforce-write
 *
 * 覆盖：
 * 1. payload 白名单 / 归一化（full_name trim、nullable → null、无越权字段）；
 * 2. 字段校验（full_name 必填、shift 外键/严格日期/时间/营业时间/start<end）；
 * 3. create/update/delete 精确调用链（from/insert/update/delete/eq/select、显式列非 '*'）；
 * 4. 非法 employee_id/shift_id（0/负数/小数/NaN/超安全整数）在 getRdb 前拒绝（RDB 0 次）；
 * 5. 0 行 / 多行 fail-closed 语义；
 * 6. 错误映射：员工 23503/23514/42501/未知；排班 23505 日期冲突 / 23503 引用缺失 / 23514 / 42501 / 未知；
 * 7. 时间解析：HH:mm/HH:mm:ss/HH:mm:ss.ffffff → 整数微秒比较（不丢小数秒精度）；
 * 8. SDK Promise reject / SDK error 收口为安全错误；
 * 9. 分派（dispatch）：cloud 无效输入 getRdb/cloudRun/from/localRun 全 0 次、有效输入各 1 次、local 只走 localRun；
 * 10. 非 admin 拒绝（cloud 模式绕过页面直接调用 Hook 也必须在 getRdb 前拒绝）；
 * 11. local 转换（toLocalEmployeeInput / toLocalShiftInput）+ local DataService CRUD 不回归；
 * 12. MutationLock 互斥 + CloudWorkforceRefresh 成功刷新 / 失败不刷新；
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
  buildEmployeePayload,
  buildShiftPayload,
  validateEmployeeFields,
  validateShiftFields,
  createEmployee,
  updateEmployee,
  removeEmployee,
  createShift,
  updateShift,
  removeShift,
  isPositiveSafeInt,
  SAFE_EMPLOYEE_WRITE_ERROR,
  SAFE_SHIFT_WRITE_ERROR,
  EMPLOYEE_PERMISSION_ERROR,
  SHIFT_PERMISSION_ERROR,
  EMPLOYEE_REFERENCED_ERROR,
  SHIFT_REFERENCE_MISSING_ERROR,
  SHIFT_DATE_CONFLICT_ERROR,
  EMPLOYEE_CHECK_VIOLATION_ERROR,
  SHIFT_CHECK_VIOLATION_ERROR,
  EMPLOYEE_NOT_FOUND_ERROR,
  SHIFT_NOT_FOUND_ERROR,
} = await import('../src/data/cloudWorkforceMutations')
type EmployeeCloudInput = import('../src/data/cloudWorkforceMutations').EmployeeCloudInput
type ShiftCloudInput = import('../src/data/cloudWorkforceMutations').ShiftCloudInput
type WorkforceRdbMutationClient = import('../src/data/cloudWorkforceMutations').WorkforceRdbMutationClient
type WorkforceMutationBuilder = import('../src/data/cloudWorkforceMutations').WorkforceMutationBuilder

const {
  EMPLOYEE_SELECT_COLUMNS,
  SHIFT_SELECT_COLUMNS,
  parseTime,
  SHIFT_START_MIN_MICROS,
  SHIFT_END_MAX_MICROS,
} = await import('../src/data/cloudWorkforce')
type EmployeeView = import('../src/data/cloudWorkforce').EmployeeView
type ShiftView = import('../src/data/cloudWorkforce').ShiftView
type CloudEmployeeRow = import('../src/data/cloudWorkforce').CloudEmployeeRow
type CloudShiftRow = import('../src/data/cloudWorkforce').CloudShiftRow

const {
  dispatchEmployeeWriteMutation,
  dispatchEmployeeIdMutation,
  dispatchShiftCreateMutation,
  dispatchShiftUpdateMutation,
  dispatchShiftIdMutation,
  toLocalEmployeeInput,
  toLocalShiftInput,
  MutationLock,
  CloudWorkforceRefresh,
} = await import('../src/data/workforceDataSource')
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
const employeeIds = new Set([1, 2, 3])
const storeIds = new Set([1, 2])

const fakeEmployeeRow: CloudEmployeeRow = { employee_id: 1, full_name: '林远山', address: '云顶镇雪松路 8 号', phone: '13800000001', email: 'lin@xuefeng.example', notes: '总经理' }
const fakeShiftRow: CloudShiftRow = { shift_id: 1, employee_id: 1, store_id: 1, work_date: '2026-08-19', start_time: '08:00:00', end_time: '16:00:00' }

const fakeEmployee: EmployeeView = { employee_id: 1, full_name: '林远山', address: '云顶镇雪松路 8 号', phone: '13800000001', email: 'lin@xuefeng.example', notes: '总经理' }
const fakeShift: ShiftView = { shift_id: 1, employee_id: 1, store_id: 1, work_date: '2026-08-19', start_time: '08:00', end_time: '16:00' }

const validEmployeeCloudInput: EmployeeCloudInput = {
  full_name: '林远山',
  address: '云顶镇雪松路 8 号',
  phone: '13800000001',
  email: 'lin@xuefeng.example',
  notes: '总经理',
}
const validShiftCloudInput: ShiftCloudInput = {
  employee_id: 1,
  store_id: 1,
  work_date: '2026-08-19',
  start_time: '08:00',
  end_time: '16:00',
}

// ---------------------------------------------------------------------------
// fake RDB 写客户端（记录 from/insert/update/delete/eq/select 调用链）
// ---------------------------------------------------------------------------
type WorkforceMutationOutcome =
  | { kind: 'resolve'; value: { data: unknown; error: unknown } }
  | { kind: 'reject' }
interface WorkforceMutationRecord {
  table: string | null
  insertPayload: Record<string, unknown> | null
  updatePayload: Record<string, unknown> | null
  deleted: boolean
  eqColumn: string | null
  eqValue: unknown
  selectColumns: string | null
}
function emptyRecord(): WorkforceMutationRecord {
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
function makeFakeWorkforceRdb(
  outcome: WorkforceMutationOutcome,
  record: WorkforceMutationRecord,
): WorkforceRdbMutationClient {
  function makeBuilder(): WorkforceMutationBuilder {
    const builder = {} as WorkforceMutationBuilder
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

const employeeOkOutcome: WorkforceMutationOutcome = {
  kind: 'resolve',
  value: { data: [fakeEmployeeRow], error: null },
}
const shiftOkOutcome: WorkforceMutationOutcome = {
  kind: 'resolve',
  value: { data: [fakeShiftRow], error: null },
}

// ===========================================================================
// 1. 员工 payload 白名单 / 归一化
// ===========================================================================
{
  const p = buildEmployeePayload({ full_name: ' 林远山 ', address: '', phone: '   ', email: ' x@y.example ', notes: null })
  check('employee payload 仅 5 字段', Object.keys(p).length === 5)
  check('employee payload 无 employee_id/shift_id/role/uid/account_id/actorRole', !('employee_id' in p) && !('shift_id' in p) && !('role' in p) && !('uid' in p) && !('account_id' in p) && !('actorRole' in p))
  check('employee payload full_name trim', p.full_name === '林远山')
  check('employee payload address 空串 → null', p.address === null)
  check('employee payload phone 空白 → null', p.phone === null)
  check('employee payload email trim', p.email === 'x@y.example')
  check('employee payload notes null 保留 null', p.notes === null)
}

// ===========================================================================
// 2. 员工字段校验
// ===========================================================================
check('full_name 空白拒绝', validateEmployeeFields({ full_name: '   ', address: null, phone: null, email: null, notes: null }).field === 'full_name')
check('full_name 非 string 拒绝', validateEmployeeFields({ full_name: 123 as unknown as string, address: null, phone: null, email: null, notes: null }).field === 'full_name')
check('full_name=50 边界通过', validateEmployeeFields({ full_name: 'x'.repeat(50), address: null, phone: null, email: null, notes: null }).ok === true)
check('full_name=51 超长拒绝', validateEmployeeFields({ full_name: 'x'.repeat(51), address: null, phone: null, email: null, notes: null }).field === 'full_name')
check('address 非 string 拒绝', validateEmployeeFields({ full_name: 'a', address: 1 as unknown as string, phone: null, email: null, notes: null }).field === 'address')
check('address=201 超长拒绝', validateEmployeeFields({ full_name: 'a', address: 'x'.repeat(201), phone: null, email: null, notes: null }).field === 'address')
check('phone=21 超长拒绝', validateEmployeeFields({ full_name: 'a', address: null, phone: 'x'.repeat(21), email: null, notes: null }).field === 'phone')
check('email=101 超长拒绝', validateEmployeeFields({ full_name: 'a', address: null, phone: null, email: 'x'.repeat(101), notes: null }).field === 'email')
check('notes=501 超长拒绝', validateEmployeeFields({ full_name: 'a', address: null, phone: null, email: null, notes: 'x'.repeat(501) }).field === 'notes')
check('nullable 均 null 通过', validateEmployeeFields({ full_name: 'a', address: null, phone: null, email: null, notes: null }).ok === true)

// ===========================================================================
// 3. 排班 payload / 字段校验
// ===========================================================================
{
  const p = buildShiftPayload(validShiftCloudInput)
  check('shift payload 仅 5 字段', Object.keys(p).length === 5)
  check('shift payload 无 shift_id/role/uid/account_id', !('shift_id' in p) && !('role' in p) && !('uid' in p) && !('account_id' in p))
  check('shift payload employee_id/store_id 透传', p.employee_id === 1 && p.store_id === 1)
  check('shift payload work_date 透传', p.work_date === '2026-08-19')
  check('shift payload start_time 归一化 "08:00"', p.start_time === '08:00')
  check('shift payload end_time 归一化 "16:00"', p.end_time === '16:00')
}
{
  // 时间带秒 / 小数秒的归一化
  const p = buildShiftPayload({ ...validShiftCloudInput, start_time: '08:30:45', end_time: '09:30:45' })
  check('shift payload 秒非 0 保留 "HH:mm:ss"', p.start_time === '08:30:45')
  const pf = buildShiftPayload({ ...validShiftCloudInput, start_time: '08:00:00.5', end_time: '09:00:00' })
  check('shift payload 小数秒保留 "08:00:00.5"', pf.start_time === '08:00:00.5')
}

// shift 字段校验：employee_id/store_id 外键
check('shift employee_id=0 拒绝', validateShiftFields({ ...validShiftCloudInput, employee_id: 0 }, employeeIds, storeIds).field === 'employee_id')
check('shift employee_id 不存在拒绝', validateShiftFields({ ...validShiftCloudInput, employee_id: 99 }, employeeIds, storeIds).field === 'employee_id')
check('shift store_id=0 拒绝', validateShiftFields({ ...validShiftCloudInput, store_id: 0 }, employeeIds, storeIds).field === 'store_id')
check('shift store_id 不存在拒绝', validateShiftFields({ ...validShiftCloudInput, store_id: 99 }, employeeIds, storeIds).field === 'store_id')
// shift 字段校验：日期
check('shift work_date 空串拒绝', validateShiftFields({ ...validShiftCloudInput, work_date: '' }, employeeIds, storeIds).field === 'work_date')
check('shift work_date 非法日期拒绝', validateShiftFields({ ...validShiftCloudInput, work_date: '2026-02-30' }, employeeIds, storeIds).field === 'work_date')
// shift 字段校验：时间
check('shift start_time 非法拒绝', validateShiftFields({ ...validShiftCloudInput, start_time: 'abc' }, employeeIds, storeIds).field === 'start_time')
check('shift end_time 非法拒绝', validateShiftFields({ ...validShiftCloudInput, end_time: '25:00' }, employeeIds, storeIds).field === 'end_time')
check('shift start 早于 08:00 拒绝', validateShiftFields({ ...validShiftCloudInput, start_time: '07:59' }, employeeIds, storeIds).field === 'start_time')
check('shift end 晚于 22:00 拒绝', validateShiftFields({ ...validShiftCloudInput, end_time: '22:01' }, employeeIds, storeIds).field === 'end_time')
check('shift start >= end 拒绝', validateShiftFields({ ...validShiftCloudInput, start_time: '16:00', end_time: '08:00' }, employeeIds, storeIds).field === 'end_time')
check('shift start == end 拒绝', validateShiftFields({ ...validShiftCloudInput, start_time: '08:00', end_time: '08:00' }, employeeIds, storeIds).field === 'end_time')
check('shift 合法输入通过', validateShiftFields(validShiftCloudInput, employeeIds, storeIds).ok === true)

// ===========================================================================
// 4. 时间解析：HH:mm / HH:mm:ss / HH:mm:ss.ffffff → 整数微秒（不丢精度）
// ===========================================================================
{
  const a = parseTime('08:00')
  const b = parseTime('08:00:00')
  check('parseTime "08:00" = "08:00:00" 微秒相等', a !== 'INVALID' && b !== 'INVALID' && a.micros === b.micros)
  check('parseTime "08:00" canonical = "08:00"', a !== 'INVALID' && a.canonical === '08:00')
  const c = parseTime('08:00:00.5')
  check('parseTime "08:00:00.5" 微秒 = 08:00 + 500000us', c !== 'INVALID' && c.micros === 8 * 3600 * 1_000_000 + 500_000)
  check('parseTime "08:00:00.5" canonical 保留小数', c !== 'INVALID' && c.canonical === '08:00:00.5')
  const d = parseTime('21:59:59.999999')
  check('parseTime "21:59:59.999999" 合法并保留 6 位小数', d !== 'INVALID' && d.canonical === '21:59:59.999999')
  const e = parseTime('08:00:00.000000')
  check('parseTime 全零小数归一化为 "08:00"', e !== 'INVALID' && e.canonical === '08:00')
  check('parseTime 小数 7 位拒绝', parseTime('08:00:00.1234567') === 'INVALID')
  check('parseTime 缺秒带小数拒绝', parseTime('08:00.5') === 'INVALID')
  check('parseTime "8:00" 拒绝', parseTime('8:00') === 'INVALID')
  check('parseTime 非法字符拒绝', parseTime('08:00:0a') === 'INVALID')
  check('SHIFT_START_MIN_MICROS = 08:00', SHIFT_START_MIN_MICROS === 8 * 3600 * 1_000_000)
  check('SHIFT_END_MAX_MICROS = 22:00', SHIFT_END_MAX_MICROS === 22 * 3600 * 1_000_000)
}

// ===========================================================================
// 5. 员工 create/update/delete 精确调用链
// ===========================================================================
{
  const rec = emptyRecord()
  const res = await createEmployee(makeFakeWorkforceRdb(employeeOkOutcome, rec), validEmployeeCloudInput)
  check('createEmployee 成功', res.ok === true)
  check('createEmployee from=employees', rec.table === 'employees')
  check('createEmployee 走 insert', rec.insertPayload !== null && rec.updatePayload === null && rec.deleted === false)
  check('createEmployee 不设 eq', rec.eqColumn === null)
  check('createEmployee select 精确列（非 *）', rec.selectColumns === EMPLOYEE_SELECT_COLUMNS && !rec.selectColumns!.includes('*'))
}
{
  const rec = emptyRecord()
  const res = await updateEmployee(makeFakeWorkforceRdb(employeeOkOutcome, rec), 1, validEmployeeCloudInput)
  check('updateEmployee 成功', res.ok === true)
  check('updateEmployee from=employees', rec.table === 'employees')
  check('updateEmployee 走 update', rec.updatePayload !== null && rec.insertPayload === null && rec.deleted === false)
  check('updateEmployee eq employee_id=1', rec.eqColumn === 'employee_id' && rec.eqValue === 1)
  check('updateEmployee select 精确列', rec.selectColumns === EMPLOYEE_SELECT_COLUMNS)
}
{
  const rec = emptyRecord()
  const res = await removeEmployee(makeFakeWorkforceRdb(employeeOkOutcome, rec), 1)
  check('removeEmployee 成功', res.ok === true)
  check('removeEmployee from=employees', rec.table === 'employees')
  check('removeEmployee 走 delete', rec.deleted === true && rec.insertPayload === null && rec.updatePayload === null)
  check('removeEmployee eq employee_id=1', rec.eqColumn === 'employee_id' && rec.eqValue === 1)
}

// ===========================================================================
// 6. 排班 create/update/delete 精确调用链
// ===========================================================================
{
  const rec = emptyRecord()
  const res = await createShift(makeFakeWorkforceRdb(shiftOkOutcome, rec), validShiftCloudInput, employeeIds, storeIds)
  check('createShift 成功', res.ok === true)
  check('createShift from=shifts', rec.table === 'shifts')
  check('createShift 走 insert', rec.insertPayload !== null && rec.updatePayload === null && rec.deleted === false)
  check('createShift 不设 eq', rec.eqColumn === null)
  check('createShift payload 无 shift_id', rec.insertPayload !== null && !('shift_id' in rec.insertPayload))
  check('createShift select 精确列（非 *）', rec.selectColumns === SHIFT_SELECT_COLUMNS && !rec.selectColumns!.includes('*'))
}
{
  const rec = emptyRecord()
  const res = await updateShift(makeFakeWorkforceRdb(shiftOkOutcome, rec), 1, validShiftCloudInput, employeeIds, storeIds)
  check('updateShift 成功', res.ok === true)
  check('updateShift from=shifts', rec.table === 'shifts')
  check('updateShift 走 update', rec.updatePayload !== null && rec.insertPayload === null && rec.deleted === false)
  check('updateShift eq shift_id=1', rec.eqColumn === 'shift_id' && rec.eqValue === 1)
  check('updateShift select 精确列', rec.selectColumns === SHIFT_SELECT_COLUMNS)
}
{
  const rec = emptyRecord()
  const res = await removeShift(makeFakeWorkforceRdb(shiftOkOutcome, rec), 1)
  check('removeShift 成功', res.ok === true)
  check('removeShift from=shifts', rec.table === 'shifts')
  check('removeShift 走 delete', rec.deleted === true && rec.insertPayload === null && rec.updatePayload === null)
  check('removeShift eq shift_id=1', rec.eqColumn === 'shift_id' && rec.eqValue === 1)
}

// ===========================================================================
// 7. 非法 ID 拒绝（正安全整数校验，RDB 不触碰）
// ===========================================================================
const badIds: Array<[string, number]> = [
  ['0', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['NaN', Number.NaN],
  ['超安全整数', Number.MAX_SAFE_INTEGER + 1],
]
for (const [label, badId] of badIds) {
  const recE = emptyRecord()
  const updE = await updateEmployee(makeFakeWorkforceRdb(employeeOkOutcome, recE), badId, validEmployeeCloudInput)
  check(`updateEmployee id=${label} 拒绝且不调 RDB`, updE.ok === false && recE.table === null)
  const recE2 = emptyRecord()
  const rmE = await removeEmployee(makeFakeWorkforceRdb(employeeOkOutcome, recE2), badId)
  check(`removeEmployee id=${label} 拒绝且不调 RDB`, rmE.ok === false && recE2.table === null)
  const recS = emptyRecord()
  const updS = await updateShift(makeFakeWorkforceRdb(shiftOkOutcome, recS), badId, validShiftCloudInput, employeeIds, storeIds)
  check(`updateShift id=${label} 拒绝且不调 RDB`, updS.ok === false && recS.table === null)
  const recS2 = emptyRecord()
  const rmS = await removeShift(makeFakeWorkforceRdb(shiftOkOutcome, recS2), badId)
  check(`removeShift id=${label} 拒绝且不调 RDB`, rmS.ok === false && recS2.table === null)
}

// ===========================================================================
// 8. 0 行 / 多行语义（fail-closed）
// ===========================================================================
const zeroOutcome: WorkforceMutationOutcome = { kind: 'resolve', value: { data: [], error: null } }
check('updateEmployee 0 行 → 不存在', (await updateEmployee(makeFakeWorkforceRdb(zeroOutcome, emptyRecord()), 1, validEmployeeCloudInput)).error === EMPLOYEE_NOT_FOUND_ERROR)
check('removeEmployee 0 行 → 不存在', (await removeEmployee(makeFakeWorkforceRdb(zeroOutcome, emptyRecord()), 1)).error === EMPLOYEE_NOT_FOUND_ERROR)
check('updateShift 0 行 → 不存在', (await updateShift(makeFakeWorkforceRdb(zeroOutcome, emptyRecord()), 1, validShiftCloudInput, employeeIds, storeIds)).error === SHIFT_NOT_FOUND_ERROR)
check('removeShift 0 行 → 不存在', (await removeShift(makeFakeWorkforceRdb(zeroOutcome, emptyRecord()), 1)).error === SHIFT_NOT_FOUND_ERROR)
const multiEmployeeOutcome: WorkforceMutationOutcome = { kind: 'resolve', value: { data: [fakeEmployeeRow, fakeEmployeeRow], error: null } }
check('updateEmployee 多行 → fail-closed', (await updateEmployee(makeFakeWorkforceRdb(multiEmployeeOutcome, emptyRecord()), 1, validEmployeeCloudInput)).error === SAFE_EMPLOYEE_WRITE_ERROR)
const multiShiftOutcome: WorkforceMutationOutcome = { kind: 'resolve', value: { data: [fakeShiftRow, fakeShiftRow], error: null } }
check('updateShift 多行 → fail-closed', (await updateShift(makeFakeWorkforceRdb(multiShiftOutcome, emptyRecord()), 1, validShiftCloudInput, employeeIds, storeIds)).error === SAFE_SHIFT_WRITE_ERROR)

// ===========================================================================
// 9. 错误映射
// ===========================================================================
function errOutcome(code: string): WorkforceMutationOutcome {
  return { kind: 'resolve', value: { data: null, error: { code, message: 'internal-secret', details: 'internal-secret', hint: 'internal-secret' } } }
}
// 员工：23503（被引用删除）/ 23514 / 42501 / 未知
check('removeEmployee 23503 → 被引用无法删除', (await removeEmployee(makeFakeWorkforceRdb(errOutcome('23503'), emptyRecord()), 1)).error === EMPLOYEE_REFERENCED_ERROR)
check('createEmployee 23514 → 信息不合规', (await createEmployee(makeFakeWorkforceRdb(errOutcome('23514'), emptyRecord()), validEmployeeCloudInput)).error === EMPLOYEE_CHECK_VIOLATION_ERROR)
check('createEmployee 42501 → 无权限', (await createEmployee(makeFakeWorkforceRdb(errOutcome('42501'), emptyRecord()), validEmployeeCloudInput)).error === EMPLOYEE_PERMISSION_ERROR)
check('employee 未知错误 → 通用错误', (await createEmployee(makeFakeWorkforceRdb(errOutcome('99999'), emptyRecord()), validEmployeeCloudInput)).error === SAFE_EMPLOYEE_WRITE_ERROR)
// 排班：23505 日期冲突 / 23503 引用缺失 / 23514 / 42501 / 未知
check('createShift 23505 → 日期冲突', (await createShift(makeFakeWorkforceRdb(errOutcome('23505'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SHIFT_DATE_CONFLICT_ERROR)
check('createShift 23505 → field work_date', (await createShift(makeFakeWorkforceRdb(errOutcome('23505'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).field === 'work_date')
check('createShift 23503 → 引用缺失', (await createShift(makeFakeWorkforceRdb(errOutcome('23503'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SHIFT_REFERENCE_MISSING_ERROR)
check('createShift 23514 → 排班不合规', (await createShift(makeFakeWorkforceRdb(errOutcome('23514'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SHIFT_CHECK_VIOLATION_ERROR)
check('createShift 42501 → 无权限', (await createShift(makeFakeWorkforceRdb(errOutcome('42501'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SHIFT_PERMISSION_ERROR)
check('shift 未知错误 → 通用错误', (await createShift(makeFakeWorkforceRdb(errOutcome('99999'), emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SAFE_SHIFT_WRITE_ERROR)

// ===========================================================================
// 10. SDK reject 收口
// ===========================================================================
check('createEmployee SDK reject → 通用错误', (await createEmployee(makeFakeWorkforceRdb({ kind: 'reject' }, emptyRecord()), validEmployeeCloudInput)).error === SAFE_EMPLOYEE_WRITE_ERROR)
check('createShift SDK reject → 通用错误', (await createShift(makeFakeWorkforceRdb({ kind: 'reject' }, emptyRecord()), validShiftCloudInput, employeeIds, storeIds)).error === SAFE_SHIFT_WRITE_ERROR)

// ===========================================================================
// 11. isPositiveSafeInt
// ===========================================================================
check('isPositiveSafeInt(1)=true', isPositiveSafeInt(1) === true)
check('isPositiveSafeInt(0)=false', isPositiveSafeInt(0) === false)
check('isPositiveSafeInt(-1)=false', isPositiveSafeInt(-1) === false)
check('isPositiveSafeInt(1.5)=false', isPositiveSafeInt(1.5) === false)
check('isPositiveSafeInt(MAX_SAFE+1)=false', isPositiveSafeInt(Number.MAX_SAFE_INTEGER + 1) === false)
check('isPositiveSafeInt(NaN)=false', isPositiveSafeInt(Number.NaN) === false)

// ===========================================================================
// 12. 分派：cloud 无效输入全 0 次 / 有效输入各 1 次 / local 只走 localRun
// ===========================================================================
function makeCountingDispatch(outcome: WorkforceMutationOutcome) {
  const calls = { getRdb: 0, cloudRun: 0, localRun: 0, from: 0 }
  const getRdbFn = (): WorkforceRdbMutationClient => {
    calls.getRdb++
    const inner = makeFakeWorkforceRdb(outcome, emptyRecord())
    return {
      from(table: string) {
        calls.from++
        return inner.from(table)
      },
    }
  }
  return { calls, getRdbFn }
}

// 12a. cloud createEmployee 有效输入
{
  const env = makeCountingDispatch(employeeOkOutcome)
  const res = await dispatchEmployeeWriteMutation(
    'cloud', true, validEmployeeCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createEmployee(rdb, validEmployeeCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeEmployee } },
  )
  check('cloud createEmployee 有效 → ok', res.ok === true)
  check('cloud createEmployee 有效 → getRdb/cloudRun/from 各 1 次、localRun 0 次', env.calls.getRdb === 1 && env.calls.cloudRun === 1 && env.calls.from === 1 && env.calls.localRun === 0)
}
// 12b. cloud createEmployee 空 name → 字段错误且全 0 次
{
  const env = makeCountingDispatch(employeeOkOutcome)
  const bad: EmployeeCloudInput = { full_name: '', address: null, phone: null, email: null, notes: null }
  const res = await dispatchEmployeeWriteMutation(
    'cloud', true, bad, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createEmployee(rdb, bad) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeEmployee } },
  )
  check('cloud createEmployee 空 name → field full_name', res.ok === false && res.field === 'full_name')
  check('cloud createEmployee 空 name → getRdb/cloudRun/localRun/from 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
// 12c. local createEmployee → 只走 localRun
{
  const env = makeCountingDispatch(employeeOkOutcome)
  const res = await dispatchEmployeeWriteMutation(
    'local', true, validEmployeeCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createEmployee(rdb, validEmployeeCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeEmployee } },
  )
  check('local createEmployee → localRun 1 次', env.calls.localRun === 1)
  check('local createEmployee → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
  check('local createEmployee → 透传', res.ok === true)
}
// 12d. cloud createShift 无效 store_id → 全 0 次
{
  const env = makeCountingDispatch(shiftOkOutcome)
  const bad: ShiftCloudInput = { ...validShiftCloudInput, store_id: 99 }
  const res = await dispatchShiftCreateMutation(
    'cloud', true, bad, employeeIds, storeIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createShift(rdb, bad, employeeIds, storeIds) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeShift } },
  )
  check('cloud createShift store_id 不存在 → 拒绝且全 0 次', res.ok === false && res.field === 'store_id' && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
// 12e. cloud createShift 有效输入 → 各 1 次
{
  const env = makeCountingDispatch(shiftOkOutcome)
  const res = await dispatchShiftCreateMutation(
    'cloud', true, validShiftCloudInput, employeeIds, storeIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createShift(rdb, validShiftCloudInput, employeeIds, storeIds) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeShift } },
  )
  check('cloud createShift 有效 → ok', res.ok === true)
  check('cloud createShift 有效 → getRdb/cloudRun/from 各 1 次、localRun 0 次', env.calls.getRdb === 1 && env.calls.cloudRun === 1 && env.calls.from === 1 && env.calls.localRun === 0)
}

// ===========================================================================
// 13. 分派：ID 前置校验（非法 ID 在 getRdb 前拒绝）
// ===========================================================================
for (const [label, badId] of badIds) {
  {
    const env = makeCountingDispatch(employeeOkOutcome)
    const res = await dispatchEmployeeWriteMutation(
      'cloud', true, validEmployeeCloudInput, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return updateEmployee(rdb, badId, validEmployeeCloudInput) },
      () => { env.calls.localRun++; return { ok: true as const, data: fakeEmployee } },
    )
    check(`cloud updateEmployee id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(employeeOkOutcome)
    const res = await dispatchEmployeeIdMutation(
      'cloud', true, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return removeEmployee(rdb, badId) },
      () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
      { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR },
    )
    check(`cloud removeEmployee id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(shiftOkOutcome)
    const res = await dispatchShiftUpdateMutation(
      'cloud', true, badId, validShiftCloudInput, employeeIds, storeIds,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return updateShift(rdb, badId, validShiftCloudInput, employeeIds, storeIds) },
      () => { env.calls.localRun++; return { ok: true as const, data: fakeShift } },
    )
    check(`cloud updateShift id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
  {
    const env = makeCountingDispatch(shiftOkOutcome)
    const res = await dispatchShiftIdMutation(
      'cloud', true, badId,
      env.getRdbFn,
      async (rdb) => { env.calls.cloudRun++; return removeShift(rdb, badId) },
      () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
      { ok: false, error: SAFE_SHIFT_WRITE_ERROR },
    )
    check(`cloud removeShift id=${label} → 拒绝且全 0 次`, res.ok === false && env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
  }
}

// ===========================================================================
// 14. 非 admin 拒绝（cloud 模式：staff/contractor 绕过页面直接调用 Hook 也必须在 getRdb 前拒绝）
// ===========================================================================
{
  const env = makeCountingDispatch(employeeOkOutcome)
  const res = await dispatchEmployeeWriteMutation(
    'cloud', false, validEmployeeCloudInput, undefined,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createEmployee(rdb, validEmployeeCloudInput) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeEmployee } },
  )
  check('cloud 非 admin createEmployee → 无权限', res.ok === false && res.error === EMPLOYEE_PERMISSION_ERROR)
  check('cloud 非 admin createEmployee → getRdb/cloudRun/localRun/from 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(employeeOkOutcome)
  const res = await dispatchEmployeeIdMutation(
    'cloud', false, 1,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return removeEmployee(rdb, 1) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false, error: SAFE_EMPLOYEE_WRITE_ERROR },
  )
  check('cloud 非 admin removeEmployee → 无权限', res.ok === false && res.error === EMPLOYEE_PERMISSION_ERROR)
  check('cloud 非 admin removeEmployee → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(shiftOkOutcome)
  const res = await dispatchShiftCreateMutation(
    'cloud', false, validShiftCloudInput, employeeIds, storeIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createShift(rdb, validShiftCloudInput, employeeIds, storeIds) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeShift } },
  )
  check('cloud 非 admin createShift → 无权限', res.ok === false && res.error === SHIFT_PERMISSION_ERROR)
  check('cloud 非 admin createShift → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(shiftOkOutcome)
  const res = await dispatchShiftUpdateMutation(
    'cloud', false, 1, validShiftCloudInput, employeeIds, storeIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return updateShift(rdb, 1, validShiftCloudInput, employeeIds, storeIds) },
    () => { env.calls.localRun++; return { ok: true as const, data: fakeShift } },
  )
  check('cloud 非 admin updateShift → 无权限', res.ok === false && res.error === SHIFT_PERMISSION_ERROR)
  check('cloud 非 admin updateShift → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}
{
  const env = makeCountingDispatch(shiftOkOutcome)
  const res = await dispatchShiftIdMutation(
    'cloud', false, 1,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return removeShift(rdb, 1) },
    () => { env.calls.localRun++; return { ok: true as const, data: undefined } },
    { ok: false, error: SAFE_SHIFT_WRITE_ERROR },
  )
  check('cloud 非 admin removeShift → 无权限', res.ok === false && res.error === SHIFT_PERMISSION_ERROR)
  check('cloud 非 admin removeShift → 全 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}

// ===========================================================================
// 15. local 转换 + local DataService CRUD 不回归
// ===========================================================================
{
  const local = toLocalEmployeeInput({ full_name: 'x', address: null, phone: null, email: null, notes: null })
  check('toLocalEmployeeInput address null → ""', local.address === '')
  check('toLocalEmployeeInput phone null → ""', local.phone === '')
  check('toLocalEmployeeInput email null → ""', local.email === '')
  check('toLocalEmployeeInput notes null 保留 null', local.notes === null)
  const localShift = toLocalShiftInput(validShiftCloudInput)
  check('toLocalShiftInput 透传', localShift.employee_id === 1 && localShift.store_id === 1 && localShift.work_date === '2026-08-19' && localShift.start_time === '08:00' && localShift.end_time === '16:00')
}

const initResult = dataService.init()
if (initResult.ok) {
  const employeeCountBefore = dataService.listEmployees().length
  const shiftCountBefore = dataService.listShifts().length
  const firstEmployee = dataService.listEmployees()[0]
  const firstStore = dataService.listStores()[0]

  const created = dataService.createEmployee('admin', { full_name: '回归员工', address: '', phone: '', email: '', notes: null })
  check('local createEmployee 成功', created.ok === true)
  if (created.ok) {
    const eid = created.data.employee_id
    check('local createEmployee 行数 +1', dataService.listEmployees().length === employeeCountBefore + 1)
    const upd = dataService.updateEmployee('admin', eid, { full_name: '回归员工2', address: 'a', phone: 'b', email: 'c', notes: 'd' })
    check('local updateEmployee 成功', upd.ok === true)

    if (firstEmployee && firstStore) {
      const shiftCreated = dataService.createShift('admin', {
        employee_id: firstEmployee.employee_id,
        store_id: firstStore.store_id,
        work_date: '2027-06-15',
        start_time: '08:00',
        end_time: '16:00',
      })
      check('local createShift 成功', shiftCreated.ok === true)
      if (shiftCreated.ok) {
        const sid = shiftCreated.data.shift_id
        check('local createShift 行数 +1', dataService.listShifts().length === shiftCountBefore + 1)
        const updShift = dataService.updateShift('admin', sid, {
          employee_id: firstEmployee.employee_id,
          store_id: firstStore.store_id,
          work_date: '2027-06-15',
          start_time: '09:00',
          end_time: '17:00',
        })
        check('local updateShift 成功', updShift.ok === true)
        const rmShift = dataService.removeShift('admin', sid)
        check('local removeShift 成功', rmShift.ok === true)
        check('local removeShift 行数恢复', dataService.listShifts().length === shiftCountBefore)
      }
    }

    const rm = dataService.removeEmployee('admin', eid)
    check('local removeEmployee 成功', rm.ok === true)
    check('local removeEmployee 行数恢复', dataService.listEmployees().length === employeeCountBefore)
  }
  check('local staff createEmployee 被拒绝', dataService.createEmployee('staff', { full_name: '越权', address: '', phone: '', email: '', notes: null }).ok === false)
  check('local staff createShift 被拒绝', dataService.createShift('staff', { employee_id: 1, store_id: 1, work_date: '2027-01-01', start_time: '08:00', end_time: '16:00' }).ok === false)
}

// ===========================================================================
// 16. MutationLock + CloudWorkforceRefresh
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
  const refresher = new CloudWorkforceRefresh(guard, () => { refetchCalls++ }, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeEmployee }, true)
  check('写成功后触发重读（refetch 1 次）', refetchCalls === 1)
  refetchCalls = 0
  refresher.refreshIfNeeded({ ok: false as const, error: SAFE_EMPLOYEE_WRITE_ERROR }, true)
  check('写失败不触发重读', refetchCalls === 0)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeEmployee }, false)
  check('local 模式不触发重读', refetchCalls === 0)
  const guard2 = new LatestRequestGuard()
  let refetchCalls2 = 0
  const refresher2 = new CloudWorkforceRefresh(guard2, () => { refetchCalls2++ }, () => false)
  refresher2.refreshIfNeeded({ ok: true as const, data: fakeEmployee }, true)
  check('组件已卸载不触发重读', refetchCalls2 === 0)
}
{
  const guard = new LatestRequestGuard()
  const t0 = guard.begin()
  const refresher = new CloudWorkforceRefresh(guard, () => {}, () => true)
  refresher.refreshIfNeeded({ ok: true as const, data: fakeEmployee }, true)
  check('写成功后旧 token 已失效', guard.isLatest(t0) === false)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
