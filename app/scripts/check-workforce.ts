/**
 * 承包商/费率 + 员工/排班 DataService 服务层测试。
 * 由 scripts/validate-workforce.mjs 用 esbuild 打包执行；不参与 tsc 编译。
 * 用法：npm run validate:workforce
 */
import type { ContractorInput, ContractorRateInput, EmployeeInput, ShiftInput } from '../src/data/types'

// ---- mock localStorage（须在动态 import DataService 之前生效）----
const mem = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
}
;(globalThis as unknown as { window: unknown }).window = { localStorage: mockLocalStorage }

const { dataService } = await import('../src/data/dataService')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

const initResult = dataService.init()
console.log('\n【人力管理测试】')
if (!initResult.ok) { console.error('初始化失败：', initResult.reason); process.exit(1) }

function defContractor(over: Partial<ContractorInput> = {}): ContractorInput {
  return { name: '测试承包商', address: '测试地址', phone: '13900000099', email: 'test@example.com', ...over }
}
function defRate(over: Partial<ContractorRateInput> = {}): ContractorRateInput {
  return { effective_date: '2026-09-01', hourly_rate: 200, ...over }
}
function defEmployee(over: Partial<EmployeeInput> = {}): EmployeeInput {
  return { full_name: '测试员工', address: '测试地址', phone: '13800009999', email: 'emp@example.com', notes: null, ...over }
}
function defShift(over: Partial<ShiftInput> = {}): ShiftInput {
  return { employee_id: 7, store_id: 1, work_date: '2026-08-26', start_time: '09:00', end_time: '17:00', ...over }
}

const snap = () => ({
  contractors: dataService.listContractors().length,
  rates: dataService.listContractorRates().length,
  employees: dataService.listEmployees().length,
  shifts: dataService.listShifts().length,
  version: dataService.getVersion(),
})

// ================= 承包商 + 首条费率原子性 =================
console.log('\n[承包商与费率]')
{
  const s0 = snap()
  const r = dataService.createContractorWithInitialRate('admin', { contractor: defContractor({ name: '原子承包商' }), initialRate: defRate() })
  check('原子创建承包商+首条费率成功', r.ok && r.data?.contractor.name === '原子承包商')
  const s1 = snap()
  check('承包商数 +1', s1.contractors === s0.contractors + 1)
  check('费率数 +1', s1.rates === s0.rates + 1)

  // 首条费率失败 → 承包商不残留
  const bad = dataService.createContractorWithInitialRate('admin', {
    contractor: defContractor({ name: '坏承包商' }),
    initialRate: defRate({ effective_date: '2026-13-99' }),
  })
  check('首条费率非法日期被拒', !bad.ok)
  const s2 = snap()
  check('失败后承包商/费率/版本均不变', s2.contractors === s1.contractors && s2.rates === s1.rates && s2.version === s1.version)

  // 同承包商同日费率被拒
  const dup = dataService.createContractorRate('admin', 1, defRate({ effective_date: '2026-01-01' }))
  check('同承包商同日费率被拒', !dup.ok && dup.field === 'effective_date')

  // hourly_rate <= 0 被拒
  const zero = dataService.createContractorRate('admin', 1, defRate({ hourly_rate: 0 }))
  check('hourly_rate=0 被拒', !zero.ok && zero.field === 'hourly_rate')
  const neg = dataService.createContractorRate('admin', 1, defRate({ hourly_rate: -10 }))
  check('hourly_rate<0 被拒', !neg.ok && neg.field === 'hourly_rate')

  // contractor_id 不存在被拒
  const noContractor = dataService.createContractorRate('admin', 999, defRate())
  check('不存在承包商被拒', !noContractor.ok && noContractor.field === 'contractor_id')
}

// ================= 费率生效日期查询 =================
console.log('\n[费率生效日期]')
{
  // 承包商 1：01-01(180)、07-01(200)
  const before0715 = dataService.getEffectiveContractorRate(1, '2026-07-15')
  check('asOfDate=07-15 取 07-01 费率(200)', before0715?.hourly_rate === 200 && before0715?.effective_date === '2026-07-01')

  const before0701 = dataService.getEffectiveContractorRate(1, '2026-06-15')
  check('asOfDate=06-15 取 01-01 费率(180)', before0701?.hourly_rate === 180 && before0701?.effective_date === '2026-01-01')

  const exact = dataService.getEffectiveContractorRate(1, '2026-07-01')
  check('asOfDate=07-01 边界取 07-01 费率', exact?.hourly_rate === 200)

  const none = dataService.getEffectiveContractorRate(1, '2025-12-31')
  check('asOfDate 早于所有费率返回 null', none === null)
}

// ================= 费率引用约束 =================
console.log('\n[费率引用约束]')
{
  // rate_id 2、4、6 被维修单引用；rate_id 1、3、5 未被引用
  check('rate 2 被维修单引用', dataService.isContractorRateReferenced(2) === true)
  check('rate 1 未被引用', dataService.isContractorRateReferenced(1) === false)

  const updRef = dataService.updateContractorRate('admin', 2, defRate({ effective_date: '2026-06-01' }))
  check('被引用费率不可修改', !updRef.ok)
  const delRef = dataService.removeContractorRate('admin', 2)
  check('被引用费率不可删除', !delRef.ok)

  // 未引用费率 rate 5（承包商 3，01-01,150）可修改
  const updFree = dataService.updateContractorRate('admin', 5, defRate({ effective_date: '2026-05-15', hourly_rate: 155 }))
  check('未引用费率可修改', updFree.ok && updFree.data?.hourly_rate === 155)

  // 编辑唯一性：改成与 rate 6（07-01）冲突的日期被拒
  const conflict = dataService.updateContractorRate('admin', 5, defRate({ effective_date: '2026-07-01' }))
  check('编辑费率与同日冲突被拒', !conflict.ok && conflict.field === 'effective_date')

  // 未引用费率可删除（rate 3 承包商 2 的 01-01，未被维修单引用）
  const delFree = dataService.removeContractorRate('admin', 3)
  check('未引用费率可删除', delFree.ok)
}

// ================= 承包商删除约束 =================
console.log('\n[承包商删除约束]')
{
  // 承包商 1 被账号引用（contractor 账号）
  const delAcct = dataService.removeContractor('admin', 1)
  check('被账号引用承包商不可删除', !delAcct.ok)

  // 承包商 2 被费率+维修单引用
  const delRate = dataService.removeContractor('admin', 2)
  check('被费率引用承包商不可删除', !delRate.ok)

  // 无引用承包商可删除
  const free = dataService.createContractor('admin', defContractor({ name: '临时承包商' }))
  const delFree = dataService.removeContractor('admin', free.data!.contractor_id)
  check('无引用承包商可删除', delFree.ok)

  // 承包商名称必填
  const emptyName = dataService.createContractor('admin', defContractor({ name: '  ' }))
  check('承包商名称必填被拒', !emptyName.ok && emptyName.field === 'name')
}

// ================= 员工 =================
console.log('\n[员工]')
{
  const s0 = snap()
  const r = dataService.createEmployee('admin', defEmployee({ full_name: '新员工甲' }))
  check('员工正常新增', r.ok && r.data?.full_name === '新员工甲')
  check('员工数 +1', snap().employees === s0.employees + 1)

  const edit = dataService.updateEmployee('admin', r.data!.employee_id, defEmployee({ full_name: '新员工甲改' }))
  check('员工正常编辑', edit.ok && edit.data?.full_name === '新员工甲改')

  const del = dataService.removeEmployee('admin', r.data!.employee_id)
  check('无引用员工可删除', del.ok)

  // 引用约束
  const delAcct = dataService.removeEmployee('admin', 1)
  check('被账号引用员工不可删除', !delAcct.ok)
  const delContract = dataService.removeEmployee('admin', 3)
  check('被合同引用员工不可删除', !delContract.ok)
  const delShift = dataService.removeEmployee('admin', 6)
  check('被排班引用员工不可删除', !delShift.ok)

  // 姓名必填
  const emptyName = dataService.createEmployee('admin', defEmployee({ full_name: '  ' }))
  check('员工姓名必填被拒', !emptyName.ok && emptyName.field === 'full_name')
}

// ================= 排班 =================
console.log('\n[排班]')
{
  const s0 = snap()
  const r = dataService.createShift('admin', defShift())
  check('排班正常新增', r.ok && r.data?.work_date === '2026-08-26')
  check('排班数 +1', snap().shifts === s0.shifts + 1)

  const edit = dataService.updateShift('admin', r.data!.shift_id, defShift({ store_id: 2 }))
  check('排班正常编辑（跨店）', edit.ok && edit.data?.store_id === 2)

  const del = dataService.removeShift('admin', r.data!.shift_id)
  check('排班正常删除', del.ok)

  // 时间边界
  const early = dataService.createShift('admin', defShift({ start_time: '07:00' }))
  check('start<08:00 被拒', !early.ok && early.field === 'start_time')
  const late = dataService.createShift('admin', defShift({ end_time: '23:00' }))
  check('end>22:00 被拒', !late.ok && late.field === 'end_time')
  const badOrder = dataService.createShift('admin', defShift({ start_time: '17:00', end_time: '09:00' }))
  check('start>=end 被拒', !badOrder.ok && badOrder.field === 'end_time')

  // 同员工同日重复被拒（员工 7 已无排班，改用员工 1 在 08-19 已有）
  const dup = dataService.createShift('admin', defShift({ employee_id: 1, work_date: '2026-08-19' }))
  check('同员工同日重复被拒', !dup.ok && dup.field === 'work_date')

  // 跨店排班成功：员工 1 在 08-19 在店 1，08-27 排店 2 成功
  const crossStore = dataService.createShift('admin', defShift({ employee_id: 1, work_date: '2026-08-27', store_id: 2 }))
  check('跨店排班成功', crossStore.ok)

  // 外键
  const noEmp = dataService.createShift('admin', defShift({ employee_id: 999 }))
  check('不存在员工外键被拒', !noEmp.ok && noEmp.field === 'employee_id')
  const noStore = dataService.createShift('admin', defShift({ store_id: 999 }))
  check('不存在门店外键被拒', !noStore.ok && noStore.field === 'store_id')
  const badDate = dataService.createShift('admin', defShift({ work_date: '2026-02-30' }))
  check('非法日期被拒', !badDate.ok && badDate.field === 'work_date')
}

// ================= 权限 =================
console.log('\n[权限]')
{
  const s0 = snap()
  const writeMethods = [
    () => dataService.createContractor('staff', defContractor()),
    () => dataService.updateContractor('staff', 1, defContractor()),
    () => dataService.removeContractor('staff', 3),
    () => dataService.createContractorWithInitialRate('staff', { contractor: defContractor(), initialRate: defRate() }),
    () => dataService.createContractorRate('staff', 1, defRate()),
    () => dataService.updateContractorRate('staff', 1, defRate()),
    () => dataService.removeContractorRate('staff', 1),
    () => dataService.createEmployee('staff', defEmployee()),
    () => dataService.updateEmployee('staff', 1, defEmployee()),
    () => dataService.removeEmployee('staff', 7),
    () => dataService.createShift('staff', defShift()),
    () => dataService.updateShift('staff', 1, defShift()),
    () => dataService.removeShift('staff', 1),
  ]
  const staffDenied = writeMethods.every((fn) => fn().ok === false)
  check('staff 全部写操作被拒', staffDenied)

  const contractorMethods = [
    () => dataService.createContractor('contractor', defContractor()),
    () => dataService.createContractorRate('contractor', 1, defRate()),
    () => dataService.createEmployee('contractor', defEmployee()),
    () => dataService.createShift('contractor', defShift()),
    () => dataService.removeContractor('contractor', 3),
    () => dataService.removeEmployee('contractor', 7),
  ]
  const contractorDenied = contractorMethods.every((fn) => fn().ok === false)
  check('contractor 全部写操作被拒', contractorDenied)

  const s1 = snap()
  check('权限失败后数据与版本均不变',
    s1.contractors === s0.contractors && s1.rates === s0.rates && s1.employees === s0.employees && s1.shifts === s0.shifts && s1.version === s0.version)
}

// ================= 快照隔离 =================
console.log('\n[快照隔离]')
{
  const list = dataService.listContractors()
  const before = dataService.listContractors().length
  list.pop()
  list[0].name = '被篡改'
  check('listContractors 返回值不影响内部', dataService.listContractors().length === before && dataService.listContractors()[0].name !== '被篡改')

  const rate = dataService.getEffectiveContractorRate(1, '2026-07-15')
  if (rate) rate.hourly_rate = 9999
  check('getEffectiveContractorRate 返回值不影响内部', dataService.getEffectiveContractorRate(1, '2026-07-15')?.hourly_rate === 200)

  const emps = dataService.listEmployees()
  emps[0].full_name = '被篡改'
  check('listEmployees 返回值不影响内部', dataService.listEmployees()[0].full_name !== '被篡改')

  const sh = dataService.listShifts()
  sh[0].start_time = '00:00'
  check('listShifts 返回值不影响内部', dataService.listShifts()[0].start_time !== '00:00')
}

// ================= 重置 =================
console.log('\n[重置]')
{
  dataService.reset()
  check('reset 恢复种子（承包商 3、费率 6、员工 8、排班 42）',
    dataService.listContractors().length === 3 &&
      dataService.listContractorRates().length === 6 &&
      dataService.listEmployees().length === 8 &&
      dataService.listShifts().length === 42)
}

console.log(`\n人力管理测试结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
