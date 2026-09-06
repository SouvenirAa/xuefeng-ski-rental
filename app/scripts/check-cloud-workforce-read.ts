/**
 * 云端承包商/费率 + 员工/排班/门店 只读查询校验脚本
 * （由 validate-cloud-workforce-read.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-workforce-read
 *
 * 覆盖：
 * 1. 承包商/费率映射：nullable 保留 null、hourly_rate 有限正数、严格日期、
 *    主键安全整数、重复主键、同承包商同日重复费率、费率外键完整性（纯逻辑）；
 * 2. 员工/排班映射：nullable 保留 null、shift 主外键、员工/门店引用、日期、
 *    time 格式（不假设 HH:mm，兼容 HH:mm:ss）、时间范围、start<end、同员工同日唯一；
 * 3. 当前费率历史边界与未来费率（computeCurrentRateView）；
 * 4. 精确 from/select/order、禁 select('*')、错误处理（fake client）；
 * 5. 任一相关查询失败 → 整体 fail-closed，不返回部分数据、不回退本地；
 * 6. 数据源分派（计数型 fake reader：local/cloud 调用次数、cloud 本地 reader 0 次）；
 * 7. safeCloudContractorLoad / safeCloudWorkforceLoad 边界（同步 throw / Promise reject）；
 * 8. local DataService 行为不回归（3/6/8/42/2）；
 * 9. 模式语义 + 真断言 import.meta.env === undefined（非 check(true)）。
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
  mapCloudContractors,
  mapCloudContractorRates,
  assembleCloudContractors,
  computeCurrentRateView,
  queryContractors,
  queryContractorRates,
  queryContractorsWithRates,
  CONTRACTOR_SELECT_COLUMNS,
  RATE_SELECT_COLUMNS,
  SAFE_CONTRACTOR_ERROR,
} = await import('../src/data/cloudContractors')
type CloudContractorRow = import('../src/data/cloudContractors').CloudContractorRow
type CloudContractorRateRow = import('../src/data/cloudContractors').CloudContractorRateRow
type ContractorView = import('../src/data/cloudContractors').ContractorView
type ContractorRateView = import('../src/data/cloudContractors').ContractorRateView

const {
  mapCloudEmployees,
  mapCloudShifts,
  assembleCloudWorkforce,
  queryEmployees,
  queryShifts,
  queryWorkforce,
  EMPLOYEE_SELECT_COLUMNS,
  SHIFT_SELECT_COLUMNS,
  SAFE_WORKFORCE_ERROR,
} = await import('../src/data/cloudWorkforce')
type CloudEmployeeRow = import('../src/data/cloudWorkforce').CloudEmployeeRow
type CloudShiftRow = import('../src/data/cloudWorkforce').CloudShiftRow
type EmployeeView = import('../src/data/cloudWorkforce').EmployeeView

const {
  mapCloudStores,
  queryStores,
  STORE_SELECT_COLUMNS,
} = await import('../src/data/cloudMaster')
type CloudStoreRow = import('../src/data/cloudMaster').CloudStoreRow
type MasterRdbClient = import('../src/data/cloudMaster').MasterRdbClient

const {
  dispatchContractorLoad,
  settleContractorRead,
  safeCloudContractorLoad,
} = await import('../src/data/contractorDataSource')
type ContractorDataSources = import('../src/data/contractorDataSource').ContractorDataSources

const {
  dispatchWorkforceLoad,
  settleWorkforceRead,
  safeCloudWorkforceLoad,
} = await import('../src/data/workforceDataSource')
type WorkforceDataSources = import('../src/data/workforceDataSource').WorkforceDataSources

const { dataService } = await import('../src/data/dataService')
const { resolveConfig } = await import('../src/lib/config')

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
const contractorIds = new Set([1, 2, 3])
const employeeIds = new Set([1, 2, 3])
const storeIds = new Set([1, 2])

const validStore1: CloudStoreRow = { store_id: 1, store_name: '云顶东门店', address: '云顶滑雪度假区东入口 1 号', phone: '0755-81000001' }
const validStore2: CloudStoreRow = { store_id: 2, store_name: '云顶西门店', address: '云顶滑雪度假区西索道下站 2 号', phone: '0755-81000002' }

const validContractor1: CloudContractorRow = { contractor_id: 1, name: '峰顶装备维修', address: '云顶工业园 A 栋', phone: '13900000001', email: 'service@fengding.example' }
const validContractor2: CloudContractorRow = { contractor_id: 2, name: '极速雪具工坊', address: '云顶工业园 B 栋', phone: '13900000002', email: 'speed@jisu.example' }
const validContractor3: CloudContractorRow = { contractor_id: 3, name: '雪山维护中心', address: '云顶镇南街 9 号', phone: '13900000003', email: 'maint@xueshan.example' }

const validRate1: CloudContractorRateRow = { rate_id: 1, contractor_id: 1, effective_date: '2026-01-01', hourly_rate: 180 }
const validRate2: CloudContractorRateRow = { rate_id: 2, contractor_id: 1, effective_date: '2026-07-01', hourly_rate: 200 }
const validRate3: CloudContractorRateRow = { rate_id: 3, contractor_id: 2, effective_date: '2026-01-01', hourly_rate: 160 }

const validEmployee1: CloudEmployeeRow = { employee_id: 1, full_name: '林远山', address: '云顶镇雪松路 8 号', phone: '13800000001', email: 'lin@xuefeng.example', notes: '总经理' }
const validEmployee2: CloudEmployeeRow = { employee_id: 2, full_name: '苏晓芸', address: '云顶镇云杉路 12 号', phone: '13800000002', email: 'su@xuefeng.example', notes: '运营主管' }
const validEmployee6: CloudEmployeeRow = { employee_id: 6, full_name: '李思远', address: '云顶镇云杉路 30 号', phone: '13800000006', email: 'li@xuefeng.example', notes: null }

const validShift1: CloudShiftRow = { shift_id: 1, employee_id: 1, store_id: 1, work_date: '2026-08-19', start_time: '08:00:00', end_time: '16:00:00' }
const validShift2: CloudShiftRow = { shift_id: 2, employee_id: 2, store_id: 2, work_date: '2026-08-19', start_time: '12:00:00', end_time: '20:00:00' }

const allContractors = [validContractor1, validContractor2, validContractor3]
const allRates = [validRate1, validRate2, validRate3]
const allStores = [validStore1, validStore2]
const allEmployees = [validEmployee1, validEmployee2, validEmployee6]
const allShifts = [validShift1, validShift2]

// ===========================================================================
// 1. 承包商映射与归一化
// ===========================================================================
const c1 = mapCloudContractors(allContractors)
check('承包商映射成功', c1.ok === true)
if (c1.ok) {
  check('承包商条数 3', c1.contractors.length === 3)
  check('承包商 contractor_id=1', c1.contractors[0].contractor_id === 1)
  check('承包商 name', c1.contractors[0].name === '峰顶装备维修')
  check('承包商 address', c1.contractors[0].address === '云顶工业园 A 栋')
}

const c1str = mapCloudContractors([{ ...validContractor1, contractor_id: '1' }])
check('contractor_id 字符串归一化为 number', c1str.ok === true && c1str.contractors[0].contractor_id === 1)

// nullable：address/phone/email 云端可空，NULL 保留为 null
const cNullAddr = mapCloudContractors([{ ...validContractor1, address: null }])
check('承包商 address=null 保留为 null', cNullAddr.ok === true && cNullAddr.contractors[0].address === null)
const cNullPhone = mapCloudContractors([{ ...validContractor1, phone: null }])
check('承包商 phone=null 保留为 null', cNullPhone.ok === true && cNullPhone.contractors[0].phone === null)
const cNullEmail = mapCloudContractors([{ ...validContractor1, email: null }])
check('承包商 email=null 保留为 null', cNullEmail.ok === true && cNullEmail.contractors[0].email === null)
const cEmptyEmail = mapCloudContractors([{ ...validContractor1, email: '' }])
check('承包商 email="" 保留为空串（与 null 区分）', cEmptyEmail.ok === true && cEmptyEmail.contractors[0].email === '')

// 主键非法 / 超安全整数
const OVER_SAFE = Number.MAX_SAFE_INTEGER + 1
check('contractor_id=0 拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: 0 }]).ok === false)
check('contractor_id=-1 拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: -1 }]).ok === false)
check('contractor_id=1.5 拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: 1.5 }]).ok === false)
check('contractor_id=null 拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: null }]).ok === false)
check('contractor_id 数字超安全整数拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: OVER_SAFE }]).ok === false)
check('contractor_id 字符串超安全整数拒绝', mapCloudContractors([{ ...validContractor1, contractor_id: '9007199254740993' }]).ok === false)
check('contractor_id=Number.MAX_SAFE_INTEGER 通过', mapCloudContractors([{ ...validContractor1, contractor_id: Number.MAX_SAFE_INTEGER }]).ok === true)

// 名称非空
check('name="" 拒绝', mapCloudContractors([{ ...validContractor1, name: '' }]).ok === false)
check('name="  " 拒绝', mapCloudContractors([{ ...validContractor1, name: '  ' }]).ok === false)

// 重复主键 / 非数组
check('重复 contractor_id 拒绝', mapCloudContractors([validContractor1, { ...validContractor1, name: '重复' }]).ok === false)
check('承包商非数组拒绝', mapCloudContractors(null).ok === false)

// ===========================================================================
// 2. 费率映射与归一化
// ===========================================================================
const r1 = mapCloudContractorRates(allRates, contractorIds)
check('费率映射成功', r1.ok === true)
if (r1.ok) {
  check('费率条数 3', r1.rates.length === 3)
  check('费率 rate_id=1', r1.rates[0].rate_id === 1)
  check('费率 contractor_id=1', r1.rates[0].contractor_id === 1)
  check('费率 effective_date', r1.rates[0].effective_date === '2026-01-01')
  check('费率 hourly_rate=180', r1.rates[0].hourly_rate === 180)
}

// 数字字符串归一化（云端 numeric 返回 "180.00"）
const r1str = mapCloudContractorRates(
  [{ rate_id: '1', contractor_id: '1', effective_date: '2026-01-01', hourly_rate: '180.00' }],
  contractorIds,
)
check(
  'rate_id/contractor_id/hourly_rate 字符串归一化',
  r1str.ok === true && r1str.rates[0].rate_id === 1 && r1str.rates[0].hourly_rate === 180,
)

// hourly_rate：有限正数
check('hourly_rate=0 拒绝', mapCloudContractorRates([{ ...validRate1, hourly_rate: 0 }], contractorIds).ok === false)
check('hourly_rate=-1 拒绝', mapCloudContractorRates([{ ...validRate1, hourly_rate: -1 }], contractorIds).ok === false)
check('hourly_rate=null 拒绝', mapCloudContractorRates([{ ...validRate1, hourly_rate: null }], contractorIds).ok === false)
check('hourly_rate=NaN 拒绝', mapCloudContractorRates([{ ...validRate1, hourly_rate: 'abc' }], contractorIds).ok === false)
check('hourly_rate=Infinity 拒绝', mapCloudContractorRates([{ ...validRate1, hourly_rate: Infinity }], contractorIds).ok === false)

// effective_date：严格日期
check('合法日期 2026-01-01 通过', mapCloudContractorRates([validRate1], contractorIds).ok === true)
check('非法日期 2026-02-30 拒绝', mapCloudContractorRates([{ ...validRate1, effective_date: '2026-02-30' }], contractorIds).ok === false)
check('非法日期 abc 拒绝', mapCloudContractorRates([{ ...validRate1, effective_date: 'abc' }], contractorIds).ok === false)
check('effective_date=null 拒绝', mapCloudContractorRates([{ ...validRate1, effective_date: null }], contractorIds).ok === false)
check('effective_date="" 拒绝', mapCloudContractorRates([{ ...validRate1, effective_date: '' }], contractorIds).ok === false)

// 主键 / 外键超安全整数
check('rate_id 数字超安全整数拒绝', mapCloudContractorRates([{ ...validRate1, rate_id: OVER_SAFE }], contractorIds).ok === false)
check('contractor_id 字符串超安全整数拒绝', mapCloudContractorRates([{ ...validRate1, contractor_id: '9007199254740993' }], contractorIds).ok === false)

// 外键完整性：费率归属不存在承包商
check('费率引用不存在承包商拒绝', mapCloudContractorRates([{ ...validRate1, contractor_id: 99 }], contractorIds).ok === false)

// 重复主键 + 复合唯一（同承包商同日重复费率）
check('重复 rate_id 拒绝', mapCloudContractorRates([validRate1, { ...validRate1, hourly_rate: 999 }], contractorIds).ok === false)
check('同承包商同日重复费率拒绝', mapCloudContractorRates([validRate1, { ...validRate1, rate_id: 99 }], contractorIds).ok === false)
// 同承包商不同日合法
check('同承包商不同日合法', mapCloudContractorRates([validRate1, validRate2], contractorIds).ok === true)
// 不同承包商同日合法
check('不同承包商同日合法', mapCloudContractorRates([validRate1, validRate3], contractorIds).ok === true)

// ===========================================================================
// 3. 两表联立组装（承包商 + 费率）
// ===========================================================================
const asmC = assembleCloudContractors(allContractors, allRates)
check('承包商两表组装成功', asmC.ok === true && asmC.ok && asmC.contractors.length === 3 && asmC.rates.length === 3)

const asmCFail = assembleCloudContractors(null, allRates)
check('contractors 失败 → 整体失败', asmCFail.ok === false && !('contractors' in asmCFail) && !('rates' in asmCFail))
check('失败错误为安全错误', asmCFail.ok === false && asmCFail.error === SAFE_CONTRACTOR_ERROR)
const asmCFail2 = assembleCloudContractors(allContractors, [{ ...validRate1, contractor_id: 99 }])
check('费率引用不存在承包商 → 整体失败', asmCFail2.ok === false && !('rates' in asmCFail2))

// ===========================================================================
// 4. 当前费率：历史边界与未来费率
// ===========================================================================
const currentRates: ContractorRateView[] = [
  { rate_id: 1, contractor_id: 1, effective_date: '2026-01-01', hourly_rate: 180 },
  { rate_id: 2, contractor_id: 1, effective_date: '2026-07-01', hourly_rate: 200 },
  { rate_id: 3, contractor_id: 2, effective_date: '2026-01-01', hourly_rate: 160 },
]
const curLate = computeCurrentRateView(currentRates, 1, '2026-08-01')
check('当前费率取 effective_date<=today 最新一条', curLate !== null && curLate.rate_id === 2 && curLate.hourly_rate === 200)
const curEarly = computeCurrentRateView(currentRates, 1, '2026-01-15')
check('早于第二条生效日 → 返回首条', curEarly !== null && curEarly.rate_id === 1 && curEarly.hourly_rate === 180)
const curFuture = computeCurrentRateView(currentRates, 1, '2026-06-30')
check('未来费率不得提前生效', curFuture !== null && curFuture.rate_id === 1 && curFuture.hourly_rate === 180)
const curBoundary = computeCurrentRateView(currentRates, 1, '2026-07-01')
check('生效日当天即生效', curBoundary !== null && curBoundary.rate_id === 2)
const curNone = computeCurrentRateView(currentRates, 1, '2025-12-31')
check('无匹配返回 null', curNone === null)

// ===========================================================================
// 5. 员工映射与归一化
// ===========================================================================
const e1 = mapCloudEmployees(allEmployees)
check('员工映射成功', e1.ok === true)
if (e1.ok) {
  check('员工条数 3', e1.employees.length === 3)
  check('员工 employee_id=1', e1.employees[0].employee_id === 1)
  check('员工 full_name', e1.employees[0].full_name === '林远山')
  check('员工 notes 保留', e1.employees[0].notes === '总经理')
  check('员工 notes=null 保留为 null', e1.employees.find((x) => x.employee_id === 6)?.notes === null)
}

// nullable：address/phone/email/notes 云端可空，NULL 保留为 null
const eNull = mapCloudEmployees([{ ...validEmployee1, address: null, phone: null, email: null, notes: null }])
check(
  '员工 address/phone/email/notes=null 保留为 null',
  eNull.ok === true &&
    eNull.employees[0].address === null &&
    eNull.employees[0].phone === null &&
    eNull.employees[0].email === null &&
    eNull.employees[0].notes === null,
)
const eEmpty = mapCloudEmployees([{ ...validEmployee1, phone: '' }])
check('员工 phone="" 保留为空串（与 null 区分）', eEmpty.ok === true && eEmpty.employees[0].phone === '')

// 主键非法 / 超安全整数
check('employee_id=0 拒绝', mapCloudEmployees([{ ...validEmployee1, employee_id: 0 }]).ok === false)
check('employee_id 数字超安全整数拒绝', mapCloudEmployees([{ ...validEmployee1, employee_id: OVER_SAFE }]).ok === false)
check('employee_id 字符串超安全整数拒绝', mapCloudEmployees([{ ...validEmployee1, employee_id: '9007199254740993' }]).ok === false)
check('full_name="" 拒绝', mapCloudEmployees([{ ...validEmployee1, full_name: '' }]).ok === false)
check('重复 employee_id 拒绝', mapCloudEmployees([validEmployee1, { ...validEmployee1, full_name: '重复' }]).ok === false)

// ===========================================================================
// 6. 排班映射：time 格式、时间范围、start<end、唯一约束
// ===========================================================================
const sh1 = mapCloudShifts(allShifts, employeeIds, storeIds)
check('排班映射成功', sh1.ok === true)
if (sh1.ok) {
  const s = sh1.shifts[0]
  check('排班 shift_id=1', s.shift_id === 1)
  check('排班 work_date', s.work_date === '2026-08-19')
  // time 归一化：postgREST 返回 "08:00:00" → 归一化为 "08:00"（不丢信息，秒为 0）
  check('start_time "08:00:00" 归一化为 "08:00"', s.start_time === '08:00')
  check('end_time "16:00:00" 归一化为 "16:00"', s.end_time === '16:00')
}

// time 格式：兼容 HH:mm、HH:mm:ss、HH:mm:ss.ffffff（小数秒 1~6 位），不假设一定是 HH:mm
const shHM = mapCloudShifts([{ ...validShift1, start_time: '08:00', end_time: '16:00' }], employeeIds, storeIds)
check('time "HH:mm" 直接接受', shHM.ok === true && shHM.shifts[0].start_time === '08:00')
const shSec = mapCloudShifts([{ ...validShift1, start_time: '08:30:45', end_time: '09:30:45' }], employeeIds, storeIds)
check('time "HH:mm:ss" 非零秒保留', shSec.ok === true && shSec.shifts[0].start_time === '08:30:45')

// 小数秒：PostgreSQL 未限定精度 time 的合法返回，应正确映射而非拒绝
const shFrac = mapCloudShifts([{ ...validShift1, start_time: '08:00:00.5' }], employeeIds, storeIds)
check('time "08:00:00.5" 合法并保留小数秒', shFrac.ok === true && shFrac.shifts[0].start_time === '08:00:00.5')
const shFracMax = mapCloudShifts(
  [{ ...validShift1, start_time: '21:59:59.999999', end_time: '22:00:00' }],
  employeeIds,
  storeIds,
)
check('time "21:59:59.999999" 合法并保留', shFracMax.ok === true && shFracMax.shifts[0].start_time === '21:59:59.999999')
const shFracAllZero = mapCloudShifts(
  [{ ...validShift1, start_time: '08:00:00.000000', end_time: '16:00:00' }],
  employeeIds,
  storeIds,
)
check('time "08:00:00.000000" 全零小数归一化为 "08:00"', shFracAllZero.ok === true && shFracAllZero.shifts[0].start_time === '08:00')

// 小数秒越界 / 非法格式
const shFracOver = mapCloudShifts([{ ...validShift1, end_time: '22:00:00.000001' }], employeeIds, storeIds)
check('time "22:00:00.000001" 超出 22:00 范围拒绝', shFracOver.ok === false)
const shFrac7 = mapCloudShifts([{ ...validShift1, start_time: '08:00:00.1234567' }], employeeIds, storeIds)
check('time 小数秒超过 6 位拒绝', shFrac7.ok === false)
const shFracNoSec = mapCloudShifts([{ ...validShift1, start_time: '08:00.5' }], employeeIds, storeIds)
check('time 缺少秒却带小数拒绝', shFracNoSec.ok === false)
const shFracChar = mapCloudShifts([{ ...validShift1, start_time: '08:00:0a' }], employeeIds, storeIds)
check('time 非法字符拒绝', shFracChar.ok === false)

const shT = mapCloudShifts([{ ...validShift1, start_time: '8:00' }], employeeIds, storeIds)
check('time "8:00" 拒绝', shT.ok === false)
const shT3 = mapCloudShifts([{ ...validShift1, start_time: '25:00' }], employeeIds, storeIds)
check('time "25:00" 拒绝', shT3.ok === false)
const shT4 = mapCloudShifts([{ ...validShift1, start_time: '08:60' }], employeeIds, storeIds)
check('time "08:60" 拒绝', shT4.ok === false)

// 时间范围（08:00–22:00）与顺序（start<end）
check('start_time 早于 08:00 拒绝', mapCloudShifts([{ ...validShift1, start_time: '07:59' }], employeeIds, storeIds).ok === false)
check('start_time=08:00 边界通过', mapCloudShifts([{ ...validShift1, start_time: '08:00' }], employeeIds, storeIds).ok === true)
check('end_time 晚于 22:00 拒绝', mapCloudShifts([{ ...validShift1, end_time: '22:01' }], employeeIds, storeIds).ok === false)
check('end_time=22:00 边界通过', mapCloudShifts([{ ...validShift1, end_time: '22:00' }], employeeIds, storeIds).ok === true)
check('start_time >= end_time 拒绝', mapCloudShifts([{ ...validShift1, start_time: '16:00', end_time: '08:00' }], employeeIds, storeIds).ok === false)
check('start_time == end_time 拒绝', mapCloudShifts([{ ...validShift1, start_time: '08:00', end_time: '08:00' }], employeeIds, storeIds).ok === false)

// 日期 / 主外键 / 引用
check('work_date 非法日期拒绝', mapCloudShifts([{ ...validShift1, work_date: '2026-02-30' }], employeeIds, storeIds).ok === false)
check('work_date=null 拒绝', mapCloudShifts([{ ...validShift1, work_date: null }], employeeIds, storeIds).ok === false)
check('shift_id 数字超安全整数拒绝', mapCloudShifts([{ ...validShift1, shift_id: OVER_SAFE }], employeeIds, storeIds).ok === false)
check('employee_id 不存在拒绝', mapCloudShifts([{ ...validShift1, employee_id: 99 }], employeeIds, storeIds).ok === false)
check('store_id 不存在拒绝', mapCloudShifts([{ ...validShift1, store_id: 99 }], employeeIds, storeIds).ok === false)

// 重复主键 + 复合唯一（同员工同日唯一）
check('重复 shift_id 拒绝', mapCloudShifts([validShift1, { ...validShift1, store_id: 2 }], employeeIds, storeIds).ok === false)
check('同员工同日重复排班拒绝', mapCloudShifts([validShift1, { ...validShift1, shift_id: 99, store_id: 2 }], employeeIds, storeIds).ok === false)
check('同员工不同日合法', mapCloudShifts([validShift1, { ...validShift1, shift_id: 99, work_date: '2026-08-20' }], employeeIds, storeIds).ok === true)
check('不同员工同日合法', mapCloudShifts([validShift1, validShift2], employeeIds, storeIds).ok === true)

// ===========================================================================
// 7. 三表联立组装（员工 + 排班 + 门店）
// ===========================================================================
const asmW = assembleCloudWorkforce(allEmployees, allShifts, allStores)
check('员工三表组装成功', asmW.ok === true && asmW.ok && asmW.employees.length === 3 && asmW.shifts.length === 2 && asmW.stores.length === 2)

const asmWFail = assembleCloudWorkforce(allEmployees, allShifts, null)
check('stores 失败 → 整体失败', asmWFail.ok === false && !('employees' in asmWFail) && !('shifts' in asmWFail))
check('失败错误为安全错误', asmWFail.ok === false && asmWFail.error === SAFE_WORKFORCE_ERROR)
const asmWFail2 = assembleCloudWorkforce(allEmployees, [{ ...validShift1, store_id: 99 }], allStores)
check('shift 引用不存在门店 → 整体失败', asmWFail2.ok === false && !('shifts' in asmWFail2))

// ===========================================================================
// 8. 真实 RDB 查询构造（from/select/order、禁 select(*)）
// ===========================================================================
interface Rec {
  table: string | null
  columns: string | null
  orderColumn: string | null
  orderAscending: boolean | null
}
function makeFake(outcome: { data: unknown; error: unknown } | 'throw', rec: Rec): MasterRdbClient {
  return {
    from(table: string) {
      rec.table = table
      return {
        select(columns: string) {
          rec.columns = columns
          return {
            order(column: string, opts: { ascending: boolean }) {
              rec.orderColumn = column
              rec.orderAscending = opts.ascending
              if (outcome === 'throw') return Promise.reject(new Error('network-internal-detail'))
              return Promise.resolve(outcome)
            },
          }
        },
      }
    },
  }
}

const recContractor: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractors(makeFake({ data: allContractors, error: null }, recContractor))
check('queryContractors from=contractors', recContractor.table === 'contractors')
check('queryContractors select 精确 5 列', recContractor.columns === CONTRACTOR_SELECT_COLUMNS)
check('queryContractors 禁 select(*)', recContractor.columns !== null && !recContractor.columns!.includes('*'))
check('queryContractors order contractor_id 升序', recContractor.orderColumn === 'contractor_id' && recContractor.orderAscending === true)

const recRate: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractorRates(makeFake({ data: allRates, error: null }, recRate))
check('queryContractorRates from=contractor_rates', recRate.table === 'contractor_rates')
check('queryContractorRates select 精确 4 列', recRate.columns === RATE_SELECT_COLUMNS)
check('queryContractorRates 禁 select(*)', recRate.columns !== null && !recRate.columns!.includes('*'))
check('queryContractorRates order rate_id 升序', recRate.orderColumn === 'rate_id' && recRate.orderAscending === true)

const recEmployee: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryEmployees(makeFake({ data: allEmployees, error: null }, recEmployee))
check('queryEmployees from=employees', recEmployee.table === 'employees')
check('queryEmployees select 精确 6 列', recEmployee.columns === EMPLOYEE_SELECT_COLUMNS)
check('queryEmployees 禁 select(*)', recEmployee.columns !== null && !recEmployee.columns!.includes('*'))
check('queryEmployees order employee_id 升序', recEmployee.orderColumn === 'employee_id' && recEmployee.orderAscending === true)

const recShift: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryShifts(makeFake({ data: allShifts, error: null }, recShift))
check('queryShifts from=shifts', recShift.table === 'shifts')
check('queryShifts select 精确 6 列', recShift.columns === SHIFT_SELECT_COLUMNS)
check('queryShifts 禁 select(*)', recShift.columns !== null && !recShift.columns!.includes('*'))
check('queryShifts order shift_id 升序', recShift.orderColumn === 'shift_id' && recShift.orderAscending === true)

const recStore: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryStores(makeFake({ data: allStores, error: null }, recStore))
check('queryStores from=stores（复用）', recStore.table === 'stores')
check('queryStores select 精确 4 列（复用）', recStore.columns === STORE_SELECT_COLUMNS)
check('queryStores 禁 select(*)', recStore.columns !== null && !recStore.columns!.includes('*'))

// ===========================================================================
// 9. 主查询：多表联立 + fail-closed
// ===========================================================================
interface Rec3 { table: string; columns: string; orderColumn: string; orderAscending: boolean }
function makeFakeMulti(outcomes: Record<string, { data: unknown; error: unknown } | 'throw'>, records: Rec3[]): MasterRdbClient {
  return {
    from(table: string) {
      const rec: Rec3 = { table, columns: '', orderColumn: '', orderAscending: false }
      records.push(rec)
      return {
        select(columns: string) {
          rec.columns = columns
          return {
            order(column: string, opts: { ascending: boolean }) {
              rec.orderColumn = column
              rec.orderAscending = opts.ascending
              const outcome = outcomes[table]
              if (outcome === 'throw') return Promise.reject(new Error(`${table}-internal-boom`))
              return Promise.resolve(outcome)
            },
          }
        },
      }
    },
  }
}

// 承包商两表主查询
const recsC: Rec3[] = []
const qc = await queryContractorsWithRates(makeFakeMulti(
  {
    contractors: { data: allContractors, error: null },
    contractor_rates: { data: allRates, error: null },
  },
  recsC,
))
check('queryContractorsWithRates 成功返回两表', qc.ok === true && qc.ok && qc.contractors.length === 3 && qc.rates.length === 3)
check('queryContractorsWithRates 依次 from contractors/contractor_rates',
  recsC.length === 2 && recsC[0].table === 'contractors' && recsC[1].table === 'contractor_rates')

const recsCErr: Rec3[] = []
const qcErr = await queryContractorsWithRates(makeFakeMulti(
  {
    contractors: { data: allContractors, error: null },
    contractor_rates: { data: null, error: new Error('secret-internal-detail') },
  },
  recsCErr,
))
check('承包商关联查询失败 → 整体失败', qcErr.ok === false && qcErr.error === SAFE_CONTRACTOR_ERROR)
check('承包商关联失败 → 不泄露底层细节', qcErr.ok === false && !qcErr.error.includes('secret'))

const recsCThrow: Rec3[] = []
const qcThrow = await queryContractorsWithRates(makeFakeMulti(
  {
    contractors: { data: allContractors, error: null },
    contractor_rates: 'throw',
  },
  recsCThrow,
))
check('承包商 SDK 抛异常 → 整体失败安全错误', qcThrow.ok === false && qcThrow.error === SAFE_CONTRACTOR_ERROR)
check('承包商 SDK 抛异常 → 不泄露底层细节', qcThrow.ok === false && !qcThrow.error.includes('boom'))

// 员工三表主查询
const recsW: Rec3[] = []
const qw = await queryWorkforce(makeFakeMulti(
  {
    employees: { data: allEmployees, error: null },
    shifts: { data: allShifts, error: null },
    stores: { data: allStores, error: null },
  },
  recsW,
))
check('queryWorkforce 成功返回三表', qw.ok === true && qw.ok && qw.employees.length === 3 && qw.shifts.length === 2 && qw.stores.length === 2)
check('queryWorkforce 依次 from employees/shifts/stores',
  recsW.length === 3 && recsW[0].table === 'employees' && recsW[1].table === 'shifts' && recsW[2].table === 'stores')

const recsWErr: Rec3[] = []
const qwErr = await queryWorkforce(makeFakeMulti(
  {
    employees: { data: allEmployees, error: null },
    shifts: { data: null, error: new Error('secret-shift-detail') },
    stores: { data: allStores, error: null },
  },
  recsWErr,
))
check('员工关联查询失败 → 整体失败', qwErr.ok === false && qwErr.error === SAFE_WORKFORCE_ERROR)
check('员工关联失败 → 不返回部分数据', qwErr.ok === false && !('employees' in qwErr) && !('stores' in qwErr))

const recsWThrow: Rec3[] = []
const qwThrow = await queryWorkforce(makeFakeMulti(
  {
    employees: 'throw',
    shifts: { data: allShifts, error: null },
    stores: { data: allStores, error: null },
  },
  recsWThrow,
))
check('员工 SDK 抛异常 → 整体失败安全错误', qwThrow.ok === false && qwThrow.error === SAFE_WORKFORCE_ERROR)

// ===========================================================================
// 10. 数据源分派：计数型 fake reader
// ===========================================================================
const fakeContractor: ContractorView = { contractor_id: 999, name: 'Fake承包商', address: 'x', phone: 'x', email: 'x' }
const fakeRate: ContractorRateView = { rate_id: 999, contractor_id: 999, effective_date: '2026-01-01', hourly_rate: 1 }
let localContractorCalls = 0
let localRateCalls = 0
let cloudContractorCalls = 0
const contractorSources: ContractorDataSources = {
  localReadContractors: () => {
    localContractorCalls++
    return [fakeContractor]
  },
  localReadRates: () => {
    localRateCalls++
    return [fakeRate]
  },
  cloudReadContractors: () => {
    cloudContractorCalls++
    return Promise.resolve({ ok: true, contractors: [], rates: [] })
  },
}
const dispCLocal = dispatchContractorLoad('local', contractorSources)
check('承包商 local 模式 kind=local', dispCLocal.kind === 'local')
check('承包商 local 模式本地 reader 各一次', localContractorCalls === 1 && localRateCalls === 1)
check('承包商 local 模式不调用云 reader', cloudContractorCalls === 0)

localContractorCalls = 0
localRateCalls = 0
cloudContractorCalls = 0
const dispCCloud = dispatchContractorLoad('cloud', contractorSources)
check('承包商 cloud 模式 kind=cloud', dispCCloud.kind === 'cloud')
check('承包商 cloud 模式本地 reader 0 次', localContractorCalls === 0 && localRateCalls === 0)
check('承包商 cloud 模式云 reader 一次', cloudContractorCalls === 1)

const fakeEmployee: EmployeeView = { employee_id: 999, full_name: 'Fake员工', address: 'x', phone: 'x', email: 'x', notes: null }
const fakeShift = { shift_id: 999, employee_id: 999, store_id: 1, work_date: '2026-08-19', start_time: '08:00', end_time: '16:00' }
const fakeStore = { store_id: 999, store_name: 'Fake门店', address: 'x', phone: 'x' }
let localEmployeeCalls = 0
let localShiftCalls = 0
let localStoreCalls = 0
let cloudWorkforceCalls = 0
const workforceSources: WorkforceDataSources = {
  localReadEmployees: () => {
    localEmployeeCalls++
    return [fakeEmployee]
  },
  localReadShifts: () => {
    localShiftCalls++
    return [fakeShift]
  },
  localReadStores: () => {
    localStoreCalls++
    return [fakeStore]
  },
  cloudReadWorkforce: () => {
    cloudWorkforceCalls++
    return Promise.resolve({ ok: true, employees: [], shifts: [], stores: [] })
  },
}
const dispWLocal = dispatchWorkforceLoad('local', workforceSources)
check('员工 local 模式 kind=local', dispWLocal.kind === 'local')
check('员工 local 模式本地 reader 各一次', localEmployeeCalls === 1 && localShiftCalls === 1 && localStoreCalls === 1)
check('员工 local 模式不调用云 reader', cloudWorkforceCalls === 0)

localEmployeeCalls = 0
localShiftCalls = 0
localStoreCalls = 0
cloudWorkforceCalls = 0
const dispWCloud = dispatchWorkforceLoad('cloud', workforceSources)
check('员工 cloud 模式 kind=cloud', dispWCloud.kind === 'cloud')
check('员工 cloud 模式本地 reader 0 次', localEmployeeCalls === 0 && localShiftCalls === 0 && localStoreCalls === 0)
check('员工 cloud 模式云 reader 一次', cloudWorkforceCalls === 1)

// ===========================================================================
// 11. settle 落地（失败 → 空数据 + 错误，绝不回退本地）
// ===========================================================================
const settledCFail = settleContractorRead({ ok: false, error: SAFE_CONTRACTOR_ERROR })
check('承包商失败落地为安全错误', settledCFail.error === SAFE_CONTRACTOR_ERROR)
check('承包商失败返回空数据（不回退本地）', settledCFail.data.contractors.length === 0 && settledCFail.data.rates.length === 0)
const settledCOk = settleContractorRead({ ok: true, contractors: [fakeContractor], rates: [fakeRate] })
check('承包商成功落地', settledCOk.data.contractors.length === 1 && settledCOk.error === null)

const settledWFail = settleWorkforceRead({ ok: false, error: SAFE_WORKFORCE_ERROR })
check('员工失败落地为安全错误', settledWFail.error === SAFE_WORKFORCE_ERROR)
check('员工失败返回空数据（不回退本地）', settledWFail.data.employees.length === 0 && settledWFail.data.shifts.length === 0 && settledWFail.data.stores.length === 0)
const settledWOk = settleWorkforceRead({ ok: true, employees: [fakeEmployee], shifts: [fakeShift], stores: [fakeStore] })
check('员工成功落地', settledWOk.data.employees.length === 1 && settledWOk.error === null)

// ===========================================================================
// 12. safeCloudLoad 边界（同步 throw / Promise reject）
// ===========================================================================
const cSync = await safeCloudContractorLoad({ cloudReadContractors: () => { throw new Error('getRdb-sync-boom') } })
check('safeCloudContractorLoad 同步 throw → 安全错误', cSync.ok === false && cSync.error === SAFE_CONTRACTOR_ERROR)
const cRej = await safeCloudContractorLoad({ cloudReadContractors: () => Promise.reject(new Error('network-reject-detail')) })
check('safeCloudContractorLoad Promise reject → 安全错误', cRej.ok === false && cRej.error === SAFE_CONTRACTOR_ERROR)

const wSync = await safeCloudWorkforceLoad({ cloudReadWorkforce: () => { throw new Error('getRdb-sync-boom') } })
check('safeCloudWorkforceLoad 同步 throw → 安全错误', wSync.ok === false && wSync.error === SAFE_WORKFORCE_ERROR)
const wRej = await safeCloudWorkforceLoad({ cloudReadWorkforce: () => Promise.reject(new Error('network-reject-detail')) })
check('safeCloudWorkforceLoad Promise reject → 安全错误', wRej.ok === false && wRej.error === SAFE_WORKFORCE_ERROR)

// cloud 同步 throw 时 dispatch 不抛出，且本地 reader 0 次
let syncLocalContractor = 0
let syncDispatchThrew = false
let syncDispatch: ReturnType<typeof dispatchContractorLoad> | null = null
try {
  syncDispatch = dispatchContractorLoad('cloud', {
    localReadContractors: () => {
      syncLocalContractor++
      return [fakeContractor]
    },
    localReadRates: () => [fakeRate],
    cloudReadContractors: () => {
      throw new Error('sync-boom-detail')
    },
  })
} catch {
  syncDispatchThrew = true
}
check('承包商云同步 throw：dispatch 不抛出', !syncDispatchThrew && syncDispatch?.kind === 'cloud')
check('承包商云同步 throw：本地 reader 0 次', syncLocalContractor === 0)

// ===========================================================================
// 13. local 模式仍读取 DataService（不回归）
// ===========================================================================
const initResult = dataService.init()
const localContractors = initResult.ok ? dataService.listContractors() : []
const localRates = initResult.ok ? dataService.listContractorRates() : []
const localEmployees = initResult.ok ? dataService.listEmployees() : []
const localShifts = initResult.ok ? dataService.listShifts() : []
const localStores = initResult.ok ? dataService.listStores() : []
check('local DataService 返回 3 个承包商', localContractors.length === 3)
check('local DataService 返回 6 条费率', localRates.length === 6)
check('local DataService 返回 8 个员工', localEmployees.length === 8)
check('local DataService 返回 42 条排班', localShifts.length === 42)
check('local DataService 返回 2 家门店', localStores.length === 2)

// ===========================================================================
// 14. 模式语义（仅配置 mode，不涉及 UI 写入口）
// ===========================================================================
const cloudCfg = resolveConfig({
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-id',
  VITE_CLOUDBASE_REGION: 'ap-shanghai',
  VITE_CLOUDBASE_ACCESS_KEY: 'publishable-key',
})
check('cloud 配置 → mode=cloud', cloudCfg.ok === true && cloudCfg.mode === 'cloud')
const localCfg = resolveConfig({})
check('local 配置 → mode=local', localCfg.ok === true && localCfg.mode === 'local')

// ===========================================================================
// 15. 证明未读取 .env.local（真断言，非 check(true)）
// ===========================================================================
const meta = import.meta as unknown as { env?: unknown }
check('Node 测试上下文无 import.meta.env（不加载 .env.local）', meta.env === undefined)

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
