/**
 * 基础资料服务层测试（客户/设备/门店的 DataService CRUD、角色权限、外键、快照隔离与业务约束）。
 * 由 scripts/validate-master-data.mjs 用 esbuild 打包执行；不参与 tsc 编译。
 * 用法：npm run validate:master
 */
import type { RentalItemInput, Role, StoreInput } from '../src/data/types'

// ---- mock localStorage（须在动态 import DataService 之前生效）----
const mem = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => {
    mem.set(k, String(v))
  },
  removeItem: (k: string) => {
    mem.delete(k)
  },
}
;(globalThis as unknown as { window: unknown }).window = { localStorage: mockLocalStorage }

const { dataService } = await import('../src/data/dataService')
const { loadDatabase } = await import('../src/data/db')

// ---- 断言工具 ----
let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ---- 初始化 ----
const initResult = dataService.init()
console.log('\n【基础资料测试】')
if (!initResult.ok) {
  console.error('初始化失败：', initResult.reason)
  process.exit(1)
}
console.log(`种子加载完成：客户 ${dataService.listCustomers().length}、设备 ${dataService.listItems().length}、门店 ${dataService.listStores().length}`)

// ---- 默认输入 ----
function defaultCustomer(over: Partial<Parameters<typeof dataService.createCustomer>[1]> = {}) {
  return {
    full_name: '测试客户',
    address: '云顶镇测试路 99 号',
    phone: '13800009999',
    email: null,
    birth_year: null,
    height_cm: null,
    weight_kg: null,
    shoe_size: null,
    ...over,
  }
}

function defaultItem(over: Partial<RentalItemInput> = {}): RentalItemInput {
  return {
    item_code: 'SN9001',
    name: '测试滑雪板',
    description: '',
    category: '滑雪板',
    purchase_date: '2026-08-26',
    purchase_cost: 1600,
    retail_price: 2400,
    daily_rate: 200,
    skill_level_id: 1,
    home_store_id: 1,
    current_store_id: 1,
    ...over,
  }
}

function defaultStore(over: Partial<StoreInput> = {}): StoreInput {
  return { store_name: '测试门店', address: '测试地址', phone: '0755-99999999', ...over }
}

// ================= 客户 =================
console.log('\n[客户]')
{
  const before = dataService.listCustomers().length
  const r = dataService.createCustomer('admin', defaultCustomer({ full_name: '张三', email: 'zhang@test.com' }))
  check('正常新增', r.ok && r.data?.full_name === '张三')
  check('新增后总数 +1', dataService.listCustomers().length === before + 1)

  const dup = dataService.createCustomer('admin', defaultCustomer({ full_name: '李四', email: 'ZHANG@test.com' }))
  check('重复邮箱被拒（大小写不敏感）', !dup.ok && dup.field === 'email', dup.error)

  const empty = dataService.createCustomer('admin', defaultCustomer({ full_name: '  ', email: null }))
  check('姓名必填被拒', !empty.ok && empty.field === 'full_name')

  const badYear = dataService.createCustomer('admin', defaultCustomer({ full_name: '王五', birth_year: 1800 }))
  check('出生年份越界被拒', !badYear.ok && badYear.field === 'birth_year')

  // 编辑保留自身邮箱
  const created = dataService.listCustomers().find((c) => c.full_name === '张三')!
  const editKeep = dataService.updateCustomer('admin', created.customer_id, {
    ...defaultCustomer(),
    full_name: '张三改',
    email: 'zhang@test.com',
  })
  check('编辑保留自身邮箱成功', editKeep.ok, editKeep.ok ? '' : editKeep.error)

  // 被合同引用的客户删除失败（种子 customer 1 被合同引用）
  const refDel = dataService.removeCustomer('admin', 1)
  check('被合同引用客户删除失败', !refDel.ok, refDel.ok ? '' : refDel.error)

  // 无引用客户删除成功
  const free = dataService.createCustomer('admin', defaultCustomer({ full_name: '临时客户', email: null }))
  const freeDel = dataService.removeCustomer('admin', free.data!.customer_id)
  check('无引用客户删除成功', freeDel.ok)
}

// ================= 设备 =================
console.log('\n[设备]')
{
  const before = dataService.listItems().length
  const r = dataService.createItem('admin', defaultItem({ item_code: 'SN9100', name: '新滑雪板' }))
  check('正常新增', r.ok && r.data?.status === '在库')
  check('新建设备状态为在库', r.ok && r.data?.status === '在库')
  check('新增后总数 +1', dataService.listItems().length === before + 1)

  const dup = dataService.createItem('admin', defaultItem({ item_code: 'SN9100', name: '重复编号' }))
  check('重复 item_code 被拒', !dup.ok && dup.field === 'item_code')

  const accessoryLevel = dataService.createItem(
    'admin',
    defaultItem({ item_code: 'SN9101', category: '护目镜', skill_level_id: 1 }),
  )
  check('配件设置技能等级被拒', !accessoryLevel.ok && accessoryLevel.field === 'skill_level_id')

  const negAmount = dataService.createItem('admin', defaultItem({ item_code: 'SN9102', daily_rate: -5 }))
  check('负金额被拒', !negAmount.ok && negAmount.field === 'daily_rate')

  const noStore = dataService.createItem('admin', defaultItem({ item_code: 'SN9103', home_store_id: undefined as unknown as number }))
  check('归属门店必填被拒', !noStore.ok && noStore.field === 'home_store_id')

  // 非在库设备删除失败：种子中借出中设备
  const rented = dataService.listItems().find((i) => i.status !== '在库')
  const rentedDel = dataService.removeItem('admin', rented!.item_id)
  check('非在库设备删除失败', !rentedDel.ok)

  // 被引用的在库设备删除失败（item 2 被维修单引用）
  const refDel = dataService.removeItem('admin', 2)
  check('被维修单引用设备删除失败', !refDel.ok)

  // 无引用在库设备删除成功
  const free = dataService.createItem('admin', defaultItem({ item_code: 'SN9200', name: '临时设备' }))
  const freeDel = dataService.removeItem('admin', free.data!.item_id)
  check('无引用在库设备删除成功', freeDel.ok)
}

// ================= 门店 =================
console.log('\n[门店]')
{
  const before = dataService.listStores().length
  const r = dataService.createStore('admin', defaultStore({ store_name: '新门店' }))
  check('正常新增', r.ok && r.data?.store_name === '新门店')
  check('新增后总数 +1', dataService.listStores().length === before + 1)

  const created = r.data!
  const edit = dataService.updateStore('admin', created.store_id, defaultStore({ store_name: '新门店改' }))
  check('正常编辑', edit.ok && edit.data?.store_name === '新门店改')

  const emptyName = dataService.createStore('admin', defaultStore({ store_name: '  ' }))
  check('门店名必填被拒', !emptyName.ok && emptyName.field === 'store_name')

  // 被设备引用门店删除失败（种子门店 1 被设备引用）
  const refDel = dataService.removeStore('admin', 1)
  check('被设备引用门店删除失败', !refDel.ok)

  // 无引用门店删除成功
  const freeDel = dataService.removeStore('admin', created.store_id)
  check('无引用门店删除成功', freeDel.ok)
}

// ================= 权限 =================
console.log('\n[权限]')
{
  const ver0 = dataService.getVersion()
  const custCount0 = dataService.listCustomers().length
  const itemCount0 = dataService.listItems().length
  const storeCount0 = dataService.listStores().length

  // contractor：客户写入被拒
  check('contractor 新增客户被拒', !dataService.createCustomer('contractor', defaultCustomer({ full_name: 'C新增' })).ok)
  const tmpCust = dataService.listCustomers()[0]
  check('contractor 编辑客户被拒', !dataService.updateCustomer('contractor', tmpCust.customer_id, {
    ...defaultCustomer(), full_name: 'C编辑',
  }).ok)
  check('contractor 删除客户被拒', !dataService.removeCustomer('contractor', tmpCust.customer_id).ok)

  // staff：设备写入被拒
  check('staff 新增设备被拒', !dataService.createItem('staff', defaultItem({ item_code: 'SNP001' })).ok)
  check('staff 编辑设备被拒', !dataService.updateItem('staff', 1, defaultItem({ item_code: 'SN0001' })).ok)
  check('staff 删除设备被拒', !dataService.removeItem('staff', 2).ok)

  // contractor：设备写入被拒
  check('contractor 新增设备被拒', !dataService.createItem('contractor', defaultItem({ item_code: 'SNP002' })).ok)

  // staff/contractor：门店写入被拒
  check('staff 新增门店被拒', !dataService.createStore('staff', defaultStore()).ok)
  check('staff 编辑门店被拒', !dataService.updateStore('staff', 1, defaultStore()).ok)
  check('staff 删除门店被拒', !dataService.removeStore('staff', 2).ok)
  check('contractor 新增门店被拒', !dataService.createStore('contractor', defaultStore()).ok)

  // 权限失败后数据与版本均不变化（在 admin 成功写操作之前断言）
  check(
    '权限失败后客户/设备/门店数与版本均不变',
    dataService.listCustomers().length === custCount0 &&
      dataService.listItems().length === itemCount0 &&
      dataService.listStores().length === storeCount0 &&
      dataService.getVersion() === ver0,
  )

  // admin：设备、门店写入成功
  const adminItem = dataService.createItem('admin', defaultItem({ item_code: 'SNA001' }))
  check('admin 新增设备成功', adminItem.ok)
  dataService.removeItem('admin', adminItem.data!.item_id)
  const adminStore = dataService.createStore('admin', defaultStore({ store_name: 'admin门店' }))
  check('admin 新增门店成功', adminStore.ok)
  dataService.removeStore('admin', adminStore.data!.store_id)
}

// ================= 外键 =================
console.log('\n[外键]')
{
  const itemCount0 = dataService.listItems().length
  const ver0 = dataService.getVersion()

  check('不存在的 home_store_id 被拒',
    !dataService.createItem('admin', defaultItem({ item_code: 'SNFK01', home_store_id: 9999 })).ok)
  check('不存在的 current_store_id 被拒',
    !dataService.createItem('admin', defaultItem({ item_code: 'SNFK02', current_store_id: 9999 })).ok)
  check('不存在的 skill_level_id 被拒',
    !dataService.createItem('admin', defaultItem({ item_code: 'SNFK03', skill_level_id: 9999 })).ok)

  // 编辑时传入不存在的外键被拒（用种子 item 1，但保留其唯一 item_code）
  const editBadHome = dataService.updateItem('admin', 1, defaultItem({ item_code: 'SN0001', home_store_id: 9999 }))
  check('编辑时不存在 home_store_id 被拒', !editBadHome.ok && editBadHome.field === 'home_store_id')

  // 失败后数据库内容不变（数量与版本均不变）
  check(
    '外键失败后设备数与版本均不变',
    dataService.listItems().length === itemCount0 && dataService.getVersion() === ver0,
  )
}

// ================= 快照隔离 =================
console.log('\n[快照隔离]')
{
  // getSnapshot 返回深拷贝：修改快照不影响内部数据
  const snap = dataService.getSnapshot()
  const before = dataService.listCustomers().length
  snap.customers.push({ customer_id: 999999, full_name: '快照注入', address: 'x', phone: 'x', email: null, birth_year: null, height_cm: null, weight_kg: null, shoe_size: null })
  snap.customers[0].full_name = '被篡改'
  check('修改 getSnapshot 不影响内部客户数', dataService.listCustomers().length === before)
  check('修改 getSnapshot 不影响内部客户数据', dataService.listCustomers()[0].full_name !== '被篡改')

  // listXxx 返回深拷贝：修改返回数组/元素不影响内部
  const items = dataService.listItems()
  const itemsBefore = dataService.listItems().length
  items.pop()
  items[0].name = '被篡改'
  check('修改 listItems 返回值不影响内部', dataService.listItems().length === itemsBefore && dataService.listItems()[0].name !== '被篡改')

  // 账号查询返回副本：修改返回值不影响内部账号
  const acc = dataService.findByUsername('admin')
  if (acc) acc.username = 'hacked'
  check('修改 findByUsername 返回值不影响内部', dataService.findByUsername('admin')?.username === 'admin')
}

// ================= 持久化与完整性 =================
console.log('\n[持久化与完整性]')
{
  // 写入后重新读取（从 localStorage 重新加载）仍存在
  dataService.createCustomer('admin', defaultCustomer({ full_name: '持久化客户', email: 'persist@test.com' }))
  const reloaded = loadDatabase()
  const persisted = reloaded.ok && reloaded.db.customers.some((c) => c.email === 'persist@test.com')
  check('写入后重新读取仍存在', persisted === true)

  // 失败操作不产生部分写入
  const beforeCount = dataService.listCustomers().length
  dataService.createCustomer('admin', defaultCustomer({ full_name: '失败客户', email: 'persist@test.com' }))
  check('失败操作无部分写入', dataService.listCustomers().length === beforeCount)

  // 重置演示数据恢复种子
  dataService.reset()
  check(
    '重置后恢复种子（客户 12、设备 36、门店 2）',
    dataService.listCustomers().length === 12 &&
      dataService.listItems().length === 36 &&
      dataService.listStores().length === 2,
  )
}

console.log(`\n基础资料测试结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
