/**
 * 云端「租赁合同 / 明细 / 变更」只读查询校验脚本
 * （由 validate-cloud-contract-read.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-contract-read
 *
 * 覆盖：
 * 1. 合同映射：nullable completed_at、严格日期、正整数天数、非负金额、
 *    主键/contract_no 唯一、客户/员工外键、枚举、状态与 completed_at 一致性（纯逻辑）；
 * 2. 明细映射：nullable return_time/return_store_id、quantity 恒 1、时间戳解析
 *    （空格/T 分隔、1~6 位小数秒）、状态与归还字段一致、return>checkout、
 *    主键/复合唯一/同一设备借出唯一、外键；
 * 3. 变更映射：nullable change_group_id/item_id/amount_delta/note、枚举、外键；
 * 4. 列表组装（assembleContractList）：三表联立 + 姓名反查 + fail-closed；
 * 5. 详情组装（assembleContractDetail）：七表联立 + 换货组结构与差价复算 +
 *    total_amount 复算 + 时间顺序 + 完成态 + notFound 区分；
 * 6. 精确 from/select/order、禁 select('*')（fake client）；
 * 7. queryContractList / queryContractDetail 任一失败 → 整体 fail-closed，不泄露底层；
 * 8. 数据源分派（计数型 fake reader：local/cloud 调用次数、cloud 本地 reader 0 次）；
 * 9. settle + safeCloudContractListLoad/DetailLoad 边界（同步 throw / Promise reject）；
 * 10. local DataService 不回归（15/12/36/8/2）+ buildContractListRows/mapLocalContractDetail；
 * 11. 模式语义 + 真断言 import.meta.env === undefined（非 check(true)）。
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
  mapCloudContracts,
  mapCloudContractLines,
  mapCloudContractChanges,
  assembleContractList,
  assembleContractDetail,
  queryContracts,
  queryContractLines,
  queryContractChanges,
  queryContractCustomers,
  queryContractEmployees,
  queryContractItems,
  queryContractStores,
  queryContractList,
  queryContractDetail,
  CONTRACT_SELECT_COLUMNS,
  CONTRACT_LINE_SELECT_COLUMNS,
  CONTRACT_CHANGE_SELECT_COLUMNS,
  CUSTOMER_REF_SELECT_COLUMNS,
  EMPLOYEE_REF_SELECT_COLUMNS,
  ITEM_REF_SELECT_COLUMNS,
  STORE_REF_SELECT_COLUMNS,
  SAFE_CONTRACT_ERROR,
} = await import('../src/data/cloudContracts')
type CloudContractRow = import('../src/data/cloudContracts').CloudContractRow
type CloudContractLineRow = import('../src/data/cloudContracts').CloudContractLineRow
type CloudContractChangeRow = import('../src/data/cloudContracts').CloudContractChangeRow
type CloudCustomerRefRow = import('../src/data/cloudContracts').CloudCustomerRefRow
type CloudEmployeeRefRow = import('../src/data/cloudContracts').CloudEmployeeRefRow
type CloudItemRefRow = import('../src/data/cloudContracts').CloudItemRefRow
type CloudStoreRefRow = import('../src/data/cloudContracts').CloudStoreRefRow
type MasterRdbClient = import('../src/data/cloudMaster').MasterRdbClient

const {
  buildContractListRows,
  mapLocalContractDetail,
  dispatchContractListLoad,
  dispatchContractDetailLoad,
  settleContractListRead,
  settleContractDetailRead,
  safeCloudContractListLoad,
  safeCloudContractDetailLoad,
  parseContractIdParam,
  INITIAL_CONTRACT_DETAIL_CLOUD_STATE,
  beginContractDetailCloudLoad,
  settleContractDetailCloudState,
  selectContractDetailView,
  LatestRequestGuard,
} = await import('../src/data/contractDataSource')
type ContractListSources = import('../src/data/contractDataSource').ContractListSources
type ContractDetailSources = import('../src/data/contractDataSource').ContractDetailSources

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
// 固定夹具（云端行类型，数值/日期均以字符串返回，模拟真实 SDK 返回格式）
// ---------------------------------------------------------------------------
const customerIds = new Set([1, 2])
const employeeIds = new Set([1, 2])
const contractIds = new Set([1, 2, 3])
const itemIds = new Set([1, 2, 3, 4])
const storeIds = new Set([1, 2])

const validCustomer1: CloudCustomerRefRow = { customer_id: '1', full_name: '张三' }
const validCustomer2: CloudCustomerRefRow = { customer_id: '2', full_name: '李四' }
const validEmployee1: CloudEmployeeRefRow = { employee_id: '1', full_name: '王五' }
const validEmployee2: CloudEmployeeRefRow = { employee_id: '2', full_name: '赵六' }
const validItem1: CloudItemRefRow = { item_id: '1', item_code: 'SKI-001', name: '双板' }
const validItem2: CloudItemRefRow = { item_id: '2', item_code: 'BOOT-001', name: '雪靴' }
const validItem3: CloudItemRefRow = { item_id: '3', item_code: 'SKI-002', name: '双板二号' }
const validItem4: CloudItemRefRow = { item_id: '4', item_code: 'SKI-003', name: '双板三号' }
const validStore1: CloudStoreRefRow = { store_id: '1', store_name: '东门店' }
const validStore2: CloudStoreRefRow = { store_id: '2', store_name: '西门店' }

const validContract1: CloudContractRow = {
  contract_id: '1', contract_no: 'HT-001', customer_id: '1', employee_id: '1',
  contract_date: '2026-08-01', duration_days: '3', total_amount: '300.00',
  completed_at: null, status: '进行中',
}
const validContract2: CloudContractRow = {
  contract_id: '2', contract_no: 'HT-002', customer_id: '2', employee_id: '1',
  contract_date: '2026-08-10', duration_days: '2', total_amount: '200.00',
  completed_at: '2026-08-12 18:00:00', status: '已完成',
}
const validContract3: CloudContractRow = {
  contract_id: '3', contract_no: 'HT-003', customer_id: '1', employee_id: '2',
  contract_date: '2026-08-01', duration_days: '10', total_amount: '700.00',
  completed_at: null, status: '进行中',
}

const validLine1: CloudContractLineRow = {
  contract_line_id: '1', contract_id: '1', item_id: '1', quantity: '1', daily_rate: '100.00',
  checkout_time: '2026-08-01 09:00:00', checkout_store_id: '1', return_time: null, return_store_id: null, status: '借出中',
}
const validLine2: CloudContractLineRow = {
  contract_line_id: '2', contract_id: '2', item_id: '2', quantity: '1', daily_rate: '100.00',
  checkout_time: '2026-08-10 10:00:00', checkout_store_id: '1', return_time: '2026-08-12 15:00:00', return_store_id: '1', status: '已归还',
}
const validLine3: CloudContractLineRow = {
  contract_line_id: '3', contract_id: '3', item_id: '3', quantity: '1', daily_rate: '60.00',
  checkout_time: '2026-08-01 09:00:00', checkout_store_id: '1', return_time: '2026-08-06 14:00:00', return_store_id: '2', status: '已更换',
}
const validLine4: CloudContractLineRow = {
  contract_line_id: '4', contract_id: '3', item_id: '4', quantity: '1', daily_rate: '80.00',
  checkout_time: '2026-08-06 14:00:00', checkout_store_id: '1', return_time: null, return_store_id: null, status: '借出中',
}

const validChange1: CloudContractChangeRow = {
  change_id: '1', contract_id: '3', change_group_id: '10', change_date: '2026-08-06 14:00:00',
  change_type: '归还', item_id: '3', quantity: '1', amount_delta: null, note: null,
}
const validChange2: CloudContractChangeRow = {
  change_id: '2', contract_id: '3', change_group_id: '10', change_date: '2026-08-06 14:00:00',
  change_type: '增加', item_id: '4', quantity: '1', amount_delta: '100.00', note: null,
}

const allCustomers = [validCustomer1, validCustomer2]
const allEmployees = [validEmployee1, validEmployee2]
const allItems = [validItem1, validItem2, validItem3, validItem4]
const allStores = [validStore1, validStore2]
const allContracts = [validContract1, validContract2, validContract3]
const allLines = [validLine1, validLine2, validLine3, validLine4]
const allChanges = [validChange1, validChange2]

const OVER_SAFE = Number.MAX_SAFE_INTEGER + 1

// ===========================================================================
// 1. 合同映射与归一化
// ===========================================================================
const c1 = mapCloudContracts(allContracts, customerIds, employeeIds)
check('合同映射成功', c1.ok === true)
if (c1.ok) {
  check('合同条数 3', c1.contracts.length === 3)
  check('合同 contract_id=1 归一化', c1.contracts[0].contract_id === 1)
  check('合同 total_amount 字符串归一化为 300', c1.contracts[0].total_amount === 300)
  check('合同 duration_days 字符串归一化为 3', c1.contracts[0].duration_days === 3)
  check('合同 completed_at null 保留', c1.contracts[0].completed_at === null)
  check('合同 completed_at 时间戳归一化为 T 分隔', c1.contracts[1].completed_at === '2026-08-12T18:00:00')
}

// 主键 / contract_no / 外键 / 枚举 / 金额 / 天数
check('contract_id=0 拒绝', mapCloudContracts([{ ...validContract1, contract_id: '0' }], customerIds, employeeIds).ok === false)
check('contract_id 数字超安全整数拒绝', mapCloudContracts([{ ...validContract1, contract_id: OVER_SAFE }], customerIds, employeeIds).ok === false)
check('contract_id 字符串超安全整数拒绝', mapCloudContracts([{ ...validContract1, contract_id: '9007199254740993' }], customerIds, employeeIds).ok === false)
check('contract_id=Number.MAX_SAFE_INTEGER 通过', mapCloudContracts([{ ...validContract1, contract_id: Number.MAX_SAFE_INTEGER }], customerIds, employeeIds).ok === true)
check('contract_no="" 拒绝', mapCloudContracts([{ ...validContract1, contract_no: '' }], customerIds, employeeIds).ok === false)
check('customer_id 不存在拒绝', mapCloudContracts([{ ...validContract1, customer_id: '99' }], customerIds, employeeIds).ok === false)
check('employee_id 不存在拒绝', mapCloudContracts([{ ...validContract1, employee_id: '99' }], customerIds, employeeIds).ok === false)
check('status 非法枚举拒绝', mapCloudContracts([{ ...validContract1, status: '未知' }], customerIds, employeeIds).ok === false)
check('total_amount 负数拒绝', mapCloudContracts([{ ...validContract1, total_amount: '-1' }], customerIds, employeeIds).ok === false)
check('total_amount NaN 拒绝', mapCloudContracts([{ ...validContract1, total_amount: 'abc' }], customerIds, employeeIds).ok === false)
check('duration_days=0 拒绝', mapCloudContracts([{ ...validContract1, duration_days: '0' }], customerIds, employeeIds).ok === false)
check('duration_days=1.5 拒绝', mapCloudContracts([{ ...validContract1, duration_days: '1.5' }], customerIds, employeeIds).ok === false)
check('contract_date 非法日期拒绝', mapCloudContracts([{ ...validContract1, contract_date: '2026-02-30' }], customerIds, employeeIds).ok === false)

// 状态与 completed_at 一致性
check('进行中 + completed_at 非空 → 拒绝', mapCloudContracts([{ ...validContract1, completed_at: '2026-08-03 18:00:00' }], customerIds, employeeIds).ok === false)
check('已完成 + completed_at null → 拒绝', mapCloudContracts([{ ...validContract2, completed_at: null }], customerIds, employeeIds).ok === false)

// 时间戳格式：空格/T 分隔、小数秒
check('completed_at "T" 分隔解析', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12T18:00:00' }], customerIds, employeeIds).contracts[0].completed_at === '2026-08-12T18:00:00')
check('completed_at 1 位小数秒', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12 18:00:00.5' }], customerIds, employeeIds).contracts[0].completed_at === '2026-08-12T18:00:00.5')
check('completed_at 6 位小数秒', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12 18:00:00.123456' }], customerIds, employeeIds).contracts[0].completed_at === '2026-08-12T18:00:00.123456')
check('completed_at 全零小数省略', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12 18:00:00.000' }], customerIds, employeeIds).contracts[0].completed_at === '2026-08-12T18:00:00')
check('completed_at 7 位小数秒拒绝', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12 18:00:00.1234567' }], customerIds, employeeIds).ok === false)
check('completed_at 非法日期拒绝', mapCloudContracts([{ ...validContract2, completed_at: '2026-02-30 18:00:00' }], customerIds, employeeIds).ok === false)
check('completed_at 非法小时拒绝', mapCloudContracts([{ ...validContract2, completed_at: '2026-08-12 25:00:00' }], customerIds, employeeIds).ok === false)
check('completed_at 非字符串拒绝', mapCloudContracts([{ ...validContract2, completed_at: 123 as unknown as string }], customerIds, employeeIds).ok === false)

// 重复主键 / 重复合同号 / 非数组
check('重复 contract_id 拒绝', mapCloudContracts([validContract1, { ...validContract1, contract_no: 'HT-999' }], customerIds, employeeIds).ok === false)
check('重复 contract_no 拒绝', mapCloudContracts([validContract1, { ...validContract1, contract_id: '99' }], customerIds, employeeIds).ok === false)
check('合同非数组拒绝', mapCloudContracts(null, customerIds, employeeIds).ok === false)

// ===========================================================================
// 2. 明细映射与归一化
// ===========================================================================
const l1 = mapCloudContractLines(allLines, contractIds, itemIds, storeIds)
check('明细映射成功', l1.ok === true)
if (l1.ok) {
  check('明细条数 4', l1.lines.length === 4)
  check('明细 return_time 归一化为 T 分隔', l1.lines[1].return_time === '2026-08-12T15:00:00')
  check('明细 checkout_time 归一化为 T 分隔', l1.lines[0].checkout_time === '2026-08-01T09:00:00')
  check('明细 return_store_id null 保留', l1.lines[0].return_store_id === null)
}

// quantity 恒 1 / 金额 / 状态与归还字段一致
check('quantity=2 拒绝', mapCloudContractLines([{ ...validLine1, quantity: '2' }], contractIds, itemIds, storeIds).ok === false)
check('daily_rate 负数拒绝', mapCloudContractLines([{ ...validLine1, daily_rate: '-1' }], contractIds, itemIds, storeIds).ok === false)
check('借出中 + return_time 非空 → 拒绝', mapCloudContractLines([{ ...validLine1, return_time: '2026-08-03 10:00:00', return_store_id: '1' }], contractIds, itemIds, storeIds).ok === false)
check('已归还 + return_time null → 拒绝', mapCloudContractLines([{ ...validLine2, return_time: null }], contractIds, itemIds, storeIds).ok === false)
check('已归还 + return_store_id null → 拒绝', mapCloudContractLines([{ ...validLine2, return_store_id: null }], contractIds, itemIds, storeIds).ok === false)
check('return_time <= checkout_time → 拒绝', mapCloudContractLines([{ ...validLine2, return_time: '2026-08-10 10:00:00' }], contractIds, itemIds, storeIds).ok === false)
check('return_time > checkout_time → 通过', mapCloudContractLines([{ ...validLine2, return_time: '2026-08-10 10:00:01' }], contractIds, itemIds, storeIds).ok === true)

// 外键
check('contract_id 不存在拒绝', mapCloudContractLines([{ ...validLine1, contract_id: '99' }], contractIds, itemIds, storeIds).ok === false)
check('item_id 不存在拒绝', mapCloudContractLines([{ ...validLine1, item_id: '99' }], contractIds, itemIds, storeIds).ok === false)
check('checkout_store_id 不存在拒绝', mapCloudContractLines([{ ...validLine1, checkout_store_id: '99' }], contractIds, itemIds, storeIds).ok === false)
check('return_store_id 不存在拒绝', mapCloudContractLines([{ ...validLine2, return_store_id: '99' }], contractIds, itemIds, storeIds).ok === false)

// 唯一约束
check('重复 contract_line_id 拒绝', mapCloudContractLines([validLine1, { ...validLine1, item_id: '2' }], contractIds, itemIds, storeIds).ok === false)
check('同合同同设备重复拒绝', mapCloudContractLines([validLine1, { ...validLine1, contract_line_id: '99', item_id: '1' }], contractIds, itemIds, storeIds).ok === false)
check('同一设备两条借出中（跨合同）拒绝', mapCloudContractLines([validLine1, { ...validLine1, contract_line_id: '99', contract_id: '2', item_id: '1' }], contractIds, itemIds, storeIds).ok === false)
check('明细非数组拒绝', mapCloudContractLines(null, contractIds, itemIds, storeIds).ok === false)

// ===========================================================================
// 3. 变更映射与归一化
// ===========================================================================
const ch1 = mapCloudContractChanges(allChanges, contractIds, itemIds)
check('变更映射成功', ch1.ok === true)
if (ch1.ok) {
  check('变更条数 2', ch1.changes.length === 2)
  check('变更 change_date 归一化为 T 分隔', ch1.changes[0].change_date === '2026-08-06T14:00:00')
  check('变更 amount_delta 字符串归一化', ch1.changes[1].amount_delta === 100)
  check('变更 amount_delta null 保留', ch1.changes[0].amount_delta === null)
  check('变更 note null 保留', ch1.changes[0].note === null)
  check('变更 change_group_id 归一化', ch1.changes[0].change_group_id === 10)
}

// nullable / 枚举 / 外键
check('change_type 非法枚举拒绝', mapCloudContractChanges([{ ...validChange1, change_type: '换货' }], contractIds, itemIds).ok === false)
check('change_group_id null 通过', mapCloudContractChanges([{ ...validChange1, change_group_id: null }], contractIds, itemIds).ok === true)
check('item_id null 通过', mapCloudContractChanges([{ ...validChange1, item_id: null }], contractIds, itemIds).ok === true)
check('amount_delta 负数通过（退款）', mapCloudContractChanges([{ ...validChange2, amount_delta: '-140.00' }], contractIds, itemIds).ok === true)
check('amount_delta 非有限数拒绝', mapCloudContractChanges([{ ...validChange2, amount_delta: 'abc' }], contractIds, itemIds).ok === false)
check('note="" 保留为空串', mapCloudContractChanges([{ ...validChange1, note: '' }], contractIds, itemIds).changes[0].note === '')
check('contract_id 不存在拒绝', mapCloudContractChanges([{ ...validChange1, contract_id: '99' }], contractIds, itemIds).ok === false)
check('item_id 不存在拒绝', mapCloudContractChanges([{ ...validChange1, item_id: '99' }], contractIds, itemIds).ok === false)
check('重复 change_id 拒绝', mapCloudContractChanges([validChange1, { ...validChange1, change_type: '增加' }], contractIds, itemIds).ok === false)
check('变更非数组拒绝', mapCloudContractChanges(null, contractIds, itemIds).ok === false)

// ===========================================================================
// 4. 列表组装（三表 + 姓名反查 + fail-closed）
// ===========================================================================
const asl = assembleContractList(allContracts, allCustomers, allEmployees)
check('列表组装成功', asl.ok === true && asl.ok && asl.rows.length === 3)
if (asl.ok) {
  check('列表行含客户姓名', asl.rows[0].customer_name === '张三')
  check('列表行含员工姓名', asl.rows[2].employee_name === '赵六')
}
const aslFail = assembleContractList(null, allCustomers, allEmployees)
check('列表 customers 失败 → 整体失败', aslFail.ok === false && aslFail.error === SAFE_CONTRACT_ERROR)
const aslFail2 = assembleContractList([{ ...validContract1, customer_id: '99' }], allCustomers, allEmployees)
check('列表合同引用缺失客户 → 整体失败', aslFail2.ok === false && !('rows' in aslFail2))

// ===========================================================================
// 5. 详情组装（七表 + 换货组/差价复算 + total_amount 复算 + notFound 区分）
// ===========================================================================
const asd = assembleContractDetail(3, allContracts, allLines, allChanges, allCustomers, allEmployees, allItems, allStores)
check('详情组装成功（合同 3，含换货）', asd.ok === true && asd.ok && asd.detail !== null)
if (asd.ok && asd.detail) {
  check('详情合同 contract_no', asd.detail.contract.contract_no === 'HT-003')
  check('详情明细 2 条', asd.detail.lines.length === 2)
  check('详情变更 2 条', asd.detail.changes.length === 2)
  check('详情门店 2 家随详情返回', asd.detail.stores.length === 2)
  check('详情客户 ref', asd.detail.customer?.full_name === '张三')
  check('详情员工 ref', asd.detail.employee?.full_name === '赵六')
  check('详情明细 item ref 存在', asd.detail.lines.every((l) => l.item !== null))
}

// notFound：查询成功但 contract_id 不存在 → ok + detail null（区别于 error）
const asdNotFound = assembleContractDetail(99, allContracts, allLines, allChanges, allCustomers, allEmployees, allItems, allStores)
check('详情 notFound → ok 且 detail null', asdNotFound.ok === true && asdNotFound.ok && asdNotFound.detail === null)

// 换货组差价复算破坏 → 整体失败
const badDelta = assembleContractDetail(3, allContracts, allLines,
  [validChange1, { ...validChange2, amount_delta: '999.00' }], allCustomers, allEmployees, allItems, allStores)
check('amount_delta 与复算不符 → 失败', badDelta.ok === false && badDelta.error === SAFE_CONTRACT_ERROR)

// 换货组结构破坏（缺增加记录）→ 失败
const badGroup = assembleContractDetail(3, allContracts, allLines, [validChange1], allCustomers, allEmployees, allItems, allStores)
check('换货组结构不完整 → 失败', badGroup.ok === false)

// total_amount 复算破坏 → 失败
const badTotal = assembleContractDetail(3, [{ ...validContract3, total_amount: '699.00' }], allLines, allChanges, allCustomers, allEmployees, allItems, allStores)
check('total_amount 与复算不符 → 失败', badTotal.ok === false)

// 时间顺序破坏（checkout 早于 contract_date）→ 失败
const badOrder = assembleContractDetail(1, allContracts,
  [{ ...validLine1, checkout_time: '2026-07-31 09:00:00' }, validLine2, validLine3, validLine4],
  allChanges, allCustomers, allEmployees, allItems, allStores)
check('checkout 早于 contract_date → 失败', badOrder.ok === false)

// 已完成合同存在借出中明细 → 失败
const badCompleted = assembleContractDetail(2, allContracts,
  [validLine1, { ...validLine2, status: '借出中', return_time: null, return_store_id: null }, validLine3, validLine4],
  allChanges, allCustomers, allEmployees, allItems, allStores)
check('已完成合同有借出中明细 → 失败', badCompleted.ok === false)

// 七表任一失败 → 整体失败
const asdFail = assembleContractDetail(3, allContracts, allLines, allChanges, allCustomers, allEmployees, allItems, null)
check('详情 stores 失败 → 整体失败', asdFail.ok === false && asdFail.error === SAFE_CONTRACT_ERROR)

// ===========================================================================
// 6. 真实 RDB 查询构造（from/select/order、禁 select(*)）
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

const recContract: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContracts(makeFake({ data: allContracts, error: null }, recContract))
check('queryContracts from=rental_contracts', recContract.table === 'rental_contracts')
check('queryContracts select 精确 9 列', recContract.columns === CONTRACT_SELECT_COLUMNS)
check('queryContracts 禁 select(*)', recContract.columns !== null && !recContract.columns!.includes('*'))
check('queryContracts order contract_id 升序', recContract.orderColumn === 'contract_id' && recContract.orderAscending === true)

const recLine: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractLines(makeFake({ data: allLines, error: null }, recLine))
check('queryContractLines from=contract_lines', recLine.table === 'contract_lines')
check('queryContractLines select 精确 10 列', recLine.columns === CONTRACT_LINE_SELECT_COLUMNS)
check('queryContractLines 禁 select(*)', recLine.columns !== null && !recLine.columns!.includes('*'))
check('queryContractLines order contract_line_id 升序', recLine.orderColumn === 'contract_line_id' && recLine.orderAscending === true)

const recChange: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractChanges(makeFake({ data: allChanges, error: null }, recChange))
check('queryContractChanges from=contract_changes', recChange.table === 'contract_changes')
check('queryContractChanges select 精确 9 列', recChange.columns === CONTRACT_CHANGE_SELECT_COLUMNS)
check('queryContractChanges 禁 select(*)', recChange.columns !== null && !recChange.columns!.includes('*'))
check('queryContractChanges order change_id 升序', recChange.orderColumn === 'change_id' && recChange.orderAscending === true)

const recCus: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractCustomers(makeFake({ data: allCustomers, error: null }, recCus))
check('queryContractCustomers from=customers', recCus.table === 'customers')
check('queryContractCustomers select 精确 2 列', recCus.columns === CUSTOMER_REF_SELECT_COLUMNS)
check('queryContractCustomers 禁 select(*)', recCus.columns !== null && !recCus.columns!.includes('*'))

const recEmp: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractEmployees(makeFake({ data: allEmployees, error: null }, recEmp))
check('queryContractEmployees from=employees', recEmp.table === 'employees')
check('queryContractEmployees select 精确 2 列', recEmp.columns === EMPLOYEE_REF_SELECT_COLUMNS)
check('queryContractEmployees 禁 select(*)', recEmp.columns !== null && !recEmp.columns!.includes('*'))

const recItem: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractItems(makeFake({ data: allItems, error: null }, recItem))
check('queryContractItems from=rental_items', recItem.table === 'rental_items')
check('queryContractItems select 精确 3 列', recItem.columns === ITEM_REF_SELECT_COLUMNS)
check('queryContractItems 禁 select(*)', recItem.columns !== null && !recItem.columns!.includes('*'))

const recStore: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryContractStores(makeFake({ data: allStores, error: null }, recStore))
check('queryContractStores from=stores', recStore.table === 'stores')
check('queryContractStores select 精确 2 列', recStore.columns === STORE_REF_SELECT_COLUMNS)
check('queryContractStores 禁 select(*)', recStore.columns !== null && !recStore.columns!.includes('*'))

// ===========================================================================
// 7. 主查询：多表联立 + fail-closed
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

// 列表三表主查询
const recsL: Rec3[] = []
const ql = await queryContractList(makeFakeMulti(
  {
    rental_contracts: { data: allContracts, error: null },
    customers: { data: allCustomers, error: null },
    employees: { data: allEmployees, error: null },
  },
  recsL,
))
check('queryContractList 成功返回 3 行', ql.ok === true && ql.ok && ql.rows.length === 3)
check('queryContractList 依次 from 三表',
  recsL.length === 3 && recsL[0].table === 'rental_contracts' && recsL[1].table === 'customers' && recsL[2].table === 'employees')

const recsLErr: Rec3[] = []
const qlErr = await queryContractList(makeFakeMulti(
  {
    rental_contracts: { data: allContracts, error: null },
    customers: { data: null, error: new Error('secret-customer-detail') },
    employees: { data: allEmployees, error: null },
  },
  recsLErr,
))
check('列表关联查询失败 → 整体失败', qlErr.ok === false && qlErr.error === SAFE_CONTRACT_ERROR)
check('列表关联失败 → 不泄露底层细节', qlErr.ok === false && !qlErr.error.includes('secret'))

// 详情七表主查询
const recsD: Rec3[] = []
const qd = await queryContractDetail(makeFakeMulti(
  {
    rental_contracts: { data: allContracts, error: null },
    contract_lines: { data: allLines, error: null },
    contract_changes: { data: allChanges, error: null },
    customers: { data: allCustomers, error: null },
    employees: { data: allEmployees, error: null },
    rental_items: { data: allItems, error: null },
    stores: { data: allStores, error: null },
  },
  recsD,
), 3)
check('queryContractDetail 成功返回合同 3', qd.ok === true && qd.ok && qd.detail?.contract.contract_no === 'HT-003')
check('queryContractDetail 依次 from 七表',
  recsD.length === 7 && recsD[0].table === 'rental_contracts' && recsD[6].table === 'stores')

const recsDErr: Rec3[] = []
const qdErr = await queryContractDetail(makeFakeMulti(
  {
    rental_contracts: { data: allContracts, error: null },
    contract_lines: { data: null, error: new Error('secret-line-detail') },
    contract_changes: { data: allChanges, error: null },
    customers: { data: allCustomers, error: null },
    employees: { data: allEmployees, error: null },
    rental_items: { data: allItems, error: null },
    stores: { data: allStores, error: null },
  },
  recsDErr,
), 3)
check('详情关联查询失败 → 整体失败', qdErr.ok === false && qdErr.error === SAFE_CONTRACT_ERROR)
check('详情关联失败 → 不泄露底层细节', qdErr.ok === false && !qdErr.error.includes('secret'))

const recsDThrow: Rec3[] = []
const qdThrow = await queryContractDetail(makeFakeMulti(
  {
    rental_contracts: { data: allContracts, error: null },
    contract_lines: { data: allLines, error: null },
    contract_changes: 'throw',
    customers: { data: allCustomers, error: null },
    employees: { data: allEmployees, error: null },
    rental_items: { data: allItems, error: null },
    stores: { data: allStores, error: null },
  },
  recsDThrow,
), 3)
check('详情 SDK 抛异常 → 整体失败安全错误', qdThrow.ok === false && qdThrow.error === SAFE_CONTRACT_ERROR)
check('详情 SDK 抛异常 → 不泄露底层细节', qdThrow.ok === false && !qdThrow.error.includes('boom'))

// ===========================================================================
// 8. 数据源分派：计数型 fake reader
// ===========================================================================
let localContractCalls = 0
let localCustomerCalls = 0
let localEmployeeCalls = 0
let cloudListCalls = 0
const listSources: ContractListSources = {
  localReadContracts: () => {
    localContractCalls++
    return []
  },
  localReadCustomers: () => {
    localCustomerCalls++
    return []
  },
  localReadEmployees: () => {
    localEmployeeCalls++
    return []
  },
  cloudReadContractList: () => {
    cloudListCalls++
    return Promise.resolve({ ok: true, rows: [] })
  },
}
const dispL = dispatchContractListLoad('local', listSources)
check('列表 local 模式 kind=local', dispL.kind === 'local' && dispL.rows.length === 0)
check('列表 local 模式本地 reader 各一次', localContractCalls === 1 && localCustomerCalls === 1 && localEmployeeCalls === 1)
check('列表 local 模式不调用云 reader', cloudListCalls === 0)

localContractCalls = 0
localCustomerCalls = 0
localEmployeeCalls = 0
cloudListCalls = 0
const dispC = dispatchContractListLoad('cloud', listSources)
check('列表 cloud 模式 kind=cloud', dispC.kind === 'cloud')
check('列表 cloud 模式本地 reader 0 次', localContractCalls === 0 && localCustomerCalls === 0 && localEmployeeCalls === 0)
check('列表 cloud 模式云 reader 一次', cloudListCalls === 1)

let localDetailCalls = 0
let localStoreCalls = 0
let cloudDetailCalls = 0
const detailSources: ContractDetailSources = {
  localReadDetail: () => {
    localDetailCalls++
    return null
  },
  localReadStores: () => {
    localStoreCalls++
    return []
  },
  cloudReadContractDetail: () => {
    cloudDetailCalls++
    return Promise.resolve({ ok: true, detail: null })
  },
}
const dispD = dispatchContractDetailLoad('local', 1, detailSources)
check('详情 local 模式 kind=local 且 detail null', dispD.kind === 'local' && dispD.detail === null)
check('详情 local 模式 detail 为 null 时不读门店', localDetailCalls === 1 && localStoreCalls === 0)
check('详情 local 模式不调用云 reader', cloudDetailCalls === 0)

localDetailCalls = 0
localStoreCalls = 0
cloudDetailCalls = 0
const dispC2 = dispatchContractDetailLoad('cloud', 1, detailSources)
check('详情 cloud 模式 kind=cloud', dispC2.kind === 'cloud')
check('详情 cloud 模式本地 reader 0 次', localDetailCalls === 0 && localStoreCalls === 0)
check('详情 cloud 模式云 reader 一次', cloudDetailCalls === 1)

// cloud 同步 throw 时 dispatch 不抛出，且本地 reader 0 次
let syncLocalDetail = 0
let syncDispatchThrew = false
let syncDispatch: ReturnType<typeof dispatchContractDetailLoad> | null = null
try {
  syncDispatch = dispatchContractDetailLoad('cloud', 1, {
    localReadDetail: () => {
      syncLocalDetail++
      return null
    },
    localReadStores: () => [],
    cloudReadContractDetail: () => {
      throw new Error('sync-boom-detail')
    },
  })
} catch {
  syncDispatchThrew = true
}
check('详情云同步 throw：dispatch 不抛出', !syncDispatchThrew && syncDispatch?.kind === 'cloud')
check('详情云同步 throw：本地 reader 0 次', syncLocalDetail === 0)

// ===========================================================================
// 9. settle 落地 + safeCloudLoad 边界
// ===========================================================================
const sListOk = settleContractListRead({ ok: true, rows: [{ contract_id: 1, contract_no: 'HT-001', customer_id: 1, employee_id: 1, contract_date: '2026-08-01', duration_days: 3, total_amount: 300, completed_at: null, status: '进行中', customer_name: '张三', employee_name: '王五' }] })
check('列表成功落地', sListOk.rows.length === 1 && sListOk.error === null)
const sListFail = settleContractListRead({ ok: false, error: SAFE_CONTRACT_ERROR })
check('列表失败落地为空行 + 错误', sListFail.rows.length === 0 && sListFail.error === SAFE_CONTRACT_ERROR)

const detailView = asd.ok && asd.detail ? asd.detail : null
const sFound = settleContractDetailRead({ ok: true, detail: detailView as never })
check('详情成功落地 found', sFound.detail !== null && sFound.notFound === false && sFound.error === null)
const sNotFound = settleContractDetailRead({ ok: true, detail: null })
check('详情落地 notFound', sNotFound.detail === null && sNotFound.notFound === true && sNotFound.error === null)
const sError = settleContractDetailRead({ ok: false, error: SAFE_CONTRACT_ERROR })
check('详情落地 error（不误判 notFound）', sError.detail === null && sError.notFound === false && sError.error === SAFE_CONTRACT_ERROR)

const lSync = await safeCloudContractListLoad({ cloudReadContractList: () => { throw new Error('getRdb-sync-boom') } })
check('safeCloudContractListLoad 同步 throw → 安全错误', lSync.ok === false && lSync.error === SAFE_CONTRACT_ERROR)
const lRej = await safeCloudContractListLoad({ cloudReadContractList: () => Promise.reject(new Error('network-reject-detail')) })
check('safeCloudContractListLoad Promise reject → 安全错误', lRej.ok === false && lRej.error === SAFE_CONTRACT_ERROR)
const dSync = await safeCloudContractDetailLoad(1, { cloudReadContractDetail: () => { throw new Error('getRdb-sync-boom') } })
check('safeCloudContractDetailLoad 同步 throw → 安全错误', dSync.ok === false && dSync.error === SAFE_CONTRACT_ERROR)
const dRej = await safeCloudContractDetailLoad(1, { cloudReadContractDetail: () => Promise.reject(new Error('network-reject-detail')) })
check('safeCloudContractDetailLoad Promise reject → 安全错误', dRej.ok === false && dRej.error === SAFE_CONTRACT_ERROR)

// ===========================================================================
// 10. local DataService 不回归 + 本地归一化
// ===========================================================================
const initResult = dataService.init()
const localContracts = initResult.ok ? dataService.listContracts() : []
const localCustomers = initResult.ok ? dataService.listCustomers() : []
const localItems = initResult.ok ? dataService.listItems() : []
const localEmployees = initResult.ok ? dataService.listEmployees() : []
const localStores = initResult.ok ? dataService.listStores() : []
check('local DataService 返回 15 份合同', localContracts.length === 15)
check('local DataService 返回 12 个客户', localCustomers.length === 12)
check('local DataService 返回 36 件设备', localItems.length === 36)
check('local DataService 返回 8 个员工', localEmployees.length === 8)
check('local DataService 返回 2 家门店', localStores.length === 2)

const localRows = initResult.ok
  ? buildContractListRows(localContracts, localCustomers, localEmployees)
  : []
check('buildContractListRows 15 行', localRows.length === 15)
check('buildContractListRows 含姓名反查', localRows.length > 0 && localRows[0].customer_name !== '' && localRows[0].employee_name !== '')

const localDetail = initResult.ok
  ? mapLocalContractDetail(dataService.getContractDetail(1), localStores)
  : null
check('mapLocalContractDetail 成功', localDetail !== null && localDetail.contract.contract_id === 1)
check('mapLocalContractDetail 含 stores', localDetail !== null && localDetail.stores.length === 2)
check('mapLocalContractDetail lines 含 item ref', localDetail !== null && localDetail.lines.length > 0 && localDetail.lines[0].item !== null)
check('mapLocalContractDetail 不存在返回 null', mapLocalContractDetail(dataService.getContractDetail(999999), localStores) === null)

// ===========================================================================
// 11. 模式语义（仅配置 mode，不涉及 UI 写入口）
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
// 12. 证明未读取 .env.local（真断言，非 check(true)）
// ===========================================================================
const meta = import.meta as unknown as { env?: unknown }
check('Node 测试上下文无 import.meta.env（不加载 .env.local）', meta.env === undefined)

// ===========================================================================
// 13. 第4批补漏：路由 ID 严格解析 + 详情云读取状态机 + 请求代次守卫
// ===========================================================================

// 13.1 严格解析边界：所有非法路由 ID 一律 null，绝不继续查询
check('parse 缺失(undefined) → null', parseContractIdParam(undefined) === null)
check('parse null → null', parseContractIdParam(null) === null)
check('parse 空字符串 → null', parseContractIdParam('') === null)
check('parse abc → null', parseContractIdParam('abc') === null)
check('parse 0 → null', parseContractIdParam('0') === null)
check('parse 负数 -1 → null', parseContractIdParam('-1') === null)
check('parse 小数 1.5 → null', parseContractIdParam('1.5') === null)
check('parse Infinity → null', parseContractIdParam('Infinity') === null)
check('parse NaN → null', parseContractIdParam('NaN') === null)
check('parse 指数形式 1e3 → null', parseContractIdParam('1e3') === null)
check('parse 前导空格 → null', parseContractIdParam(' 1') === null)
check('parse 尾随空格 → null', parseContractIdParam('1 ') === null)
check('parse 前导多余字符 x1 → null', parseContractIdParam('x1') === null)
check('parse 尾随多余字符 1x → null', parseContractIdParam('1x') === null)
check('parse 超 MAX_SAFE_INTEGER → null', parseContractIdParam('9007199254740992') === null)
check('parse 超大整数 → null', parseContractIdParam('99999999999999999999999999') === null)

// 13.2 合法 ID 解析
check('parse 1 → 1', parseContractIdParam('1') === 1)
check('parse 2 → 2', parseContractIdParam('2') === 2)
check('parse 15 → 15', parseContractIdParam('15') === 15)
check('parse MAX_SAFE_INTEGER 通过', parseContractIdParam('9007199254740991') === Number.MAX_SAFE_INTEGER)

// 13.3 非法 ID 下 local/cloud reader 调用均为 0（真实函数组合：parse → dispatch 计数）
{
  const invalidRawIds = ['abc', '0', '-1', '1.5', 'Infinity', 'NaN', '1e3', ' 1', '1x', '9007199254740992']
  let localRead = 0
  let cloudRead = 0
  let dispatched = 0
  for (const raw of invalidRawIds) {
    const parsed = parseContractIdParam(raw)
    if (parsed === null) continue // 非法 → 页面走 invalid 分支，绝不 dispatch
    dispatched++
    dispatchContractDetailLoad('cloud', parsed, {
      localReadDetail: () => {
        localRead++
        return null
      },
      localReadStores: () => {
        localRead++
        return []
      },
      cloudReadContractDetail: () => {
        cloudRead++
        return Promise.resolve({ ok: true, detail: null })
      },
    })
  }
  check('非法 ID 全部判 null（0 次 dispatch）', dispatched === 0)
  check('非法 ID 下 local reader 调用 0 次', localRead === 0)
  check('非法 ID 下 cloud reader 调用 0 次', cloudRead === 0)
}

// 13.4 非法 ID 与合法 notFound 严格区分
{
  const invalidIsNull = parseContractIdParam('abc') === null
  const notFoundSettle = settleContractDetailRead({ ok: true, detail: null })
  check(
    '非法 ID（parse=null）与合法 notFound 严格区分',
    invalidIsNull && notFoundSettle.notFound === true && notFoundSettle.error === null,
  )
}

// 13.5 状态机：ID 1 → 2 切换时旧详情不得作为新 ID 的 found 返回
{
  const asd1 = assembleContractDetail(1, allContracts, allLines, allChanges, allCustomers, allEmployees, allItems, allStores)
  const asd2 = assembleContractDetail(2, allContracts, allLines, allChanges, allCustomers, allEmployees, allItems, allStores)
  check('夹具：合同 1 可组装', asd1.ok === true && asd1.detail !== null && asd1.detail.contract.contract_id === 1)
  check('夹具：合同 2 可组装', asd2.ok === true && asd2.detail !== null && asd2.detail.contract.contract_id === 2)

  const detail1 = asd1.ok && asd1.detail ? asd1.detail : null
  const detail2 = asd2.ok && asd2.detail ? asd2.detail : null

  let st = INITIAL_CONTRACT_DETAIL_CLOUD_STATE
  // 首载合同 1
  st = beginContractDetailCloudLoad()
  check('首载进入 loading（resolvedId 未绑定）', selectContractDetailView(st, 1).loading === true)
  st = settleContractDetailCloudState({ ok: true, detail: detail1 }, 1)
  const v1 = selectContractDetailView(st, 1)
  check('合同 1 落地后 found', v1.loading === false && v1.notFound === false && v1.detail?.contract.contract_id === 1)

  // 切换到合同 2（尚未落地）→ 不得闪现合同 1
  const stale = selectContractDetailView(st, 2)
  check('ID 1→2 切换：旧详情不得作为新 ID found 返回', stale.detail === null && stale.loading === true && stale.notFound === false && stale.error === null)

  // 合同 2 落地
  st = beginContractDetailCloudLoad()
  st = settleContractDetailCloudState({ ok: true, detail: detail2 }, 2)
  const v2 = selectContractDetailView(st, 2)
  check('合同 2 落地后 found（当前 ID 正常进入 found）', v2.loading === false && v2.notFound === false && v2.detail?.contract.contract_id === 2)
}

// 13.6 请求代次守卫：旧请求晚到不得覆盖新请求
{
  const guard = new LatestRequestGuard()
  const tk1 = guard.begin() // 发起合同 1
  const tk2 = guard.begin() // 切换后发起合同 2
  check('旧请求（合同1）代次已过期', guard.isLatest(tk1) === false)
  check('新请求（合同2）代次最新可落地', guard.isLatest(tk2) === true)

  // 模拟晚到：合同 1 的响应在合同 2 之后返回 → 丢弃
  const guard2 = new LatestRequestGuard()
  const a = guard2.begin()
  const b = guard2.begin()
  check('旧响应晚到被丢弃（不覆盖新请求）', guard2.isLatest(a) === false)
  check('新响应可落地', guard2.isLatest(b) === true)
}

// 13.7 状态机：error / notFound 落地语义
{
  let st = INITIAL_CONTRACT_DETAIL_CLOUD_STATE
  st = beginContractDetailCloudLoad()
  st = settleContractDetailCloudState({ ok: false, error: SAFE_CONTRACT_ERROR }, 3)
  const vErr = selectContractDetailView(st, 3)
  check('error 落地：展示安全错误且非 notFound', vErr.error === SAFE_CONTRACT_ERROR && vErr.notFound === false && vErr.loading === false && vErr.detail === null)

  st = beginContractDetailCloudLoad()
  st = settleContractDetailCloudState({ ok: true, detail: null }, 99)
  const vNf = selectContractDetailView(st, 99)
  check('合法 notFound 落地（ok + detail null）', vNf.notFound === true && vNf.error === null && vNf.loading === false && vNf.detail === null)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
