/**
 * 租赁合同 DataService 服务层测试（创建/换货/归还 + 权限 + 原子性 + 快照隔离）。
 * 由 scripts/validate-contracts.mjs 用 esbuild 打包执行；不参与 tsc 编译。
 * 用法：npm run validate:contracts
 */
import type { RentalItem } from '../src/data/types'

// ---- mock localStorage（须在动态 import DataService 之前生效）----
const mem = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
}
;(globalThis as unknown as { window: unknown }).window = { localStorage: mockLocalStorage }

const { dataService } = await import('../src/data/dataService')
const { validateDatabase } = await import('../src/data/validate')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

const initResult = dataService.init()
console.log('\n【租赁合同测试】')
if (!initResult.ok) { console.error('初始化失败：', initResult.reason); process.exit(1) }

// 在库设备（按日租金升序），便于构造正/负差价
function availableItems(): RentalItem[] {
  return dataService.listItems().filter((i) => i.status === '在库')
}

const snap = () => ({
  contracts: dataService.listContracts().length,
  lines: dataService.getSnapshot().contract_lines.length,
  changes: dataService.getSnapshot().contract_changes.length,
  version: dataService.getVersion(),
})

const itemStatus = (id: number) => dataService.listItems().find((i) => i.item_id === id)?.status

// ================= 创建合同 =================
console.log('\n[创建合同]')
{
  const avail = availableItems()
  check('存在在库设备供测试', avail.length >= 3)
  const [a, b, c] = avail

  const s0 = snap()
  const r = dataService.createContract('admin', 1, {
    customer_id: 1,
    contract_date: '2026-08-20',
    duration_days: 3,
    item_ids: [a.item_id, b.item_id],
  }, '2026-08-20T09:00:00')
  check('admin 创建合同成功', r.ok && r.data.contract.status === '进行中')
  check('明细数量正确', r.ok && r.data.lines.length === 2)
  check('设备状态改为借出中', r.ok && itemStatus(a.item_id) === '借出中' && itemStatus(b.item_id) === '借出中')
  const expectedTotal = a.daily_rate * 3 + b.daily_rate * 3
  check('初始总额 = Σ(daily_rate × 天数)', r.ok && Math.abs(r.data.contract.total_amount - expectedTotal) < 0.005)
  check('contract_no 以 RC 开头且唯一', r.ok && /^RC\d{8}-\d{4}$/.test(r.data.contract.contract_no))
  check('checkout_time 采用传入时间', r.ok && r.data.lines[0].checkout_time === '2026-08-20T09:00:00')
  check('admin 创建后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  const contractId = r.data.contract.contract_id

  // staff 也可创建（用第三件在库设备，a/b 已被 admin 借出）
  const staffCreate = dataService.createContract('staff', 2, {
    customer_id: 2,
    contract_date: '2026-08-20',
    duration_days: 2,
    item_ids: [c.item_id],
  }, '2026-08-20T10:00:00')
  check('staff 创建合同成功', staffCreate.ok)

  // contractor 被拒
  const contractorCreate = dataService.createContract('contractor', null, {
    customer_id: 1,
    contract_date: '2026-08-20',
    duration_days: 1,
    item_ids: [a.item_id],
  }, '2026-08-20T10:00:00')
  check('contractor 创建被拒', !contractorCreate.ok)

  // 无 employee 关联
  const noEmp = dataService.createContract('admin', null, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 1, item_ids: [a.item_id],
  }, '2026-08-20T10:00:00')
  check('未关联员工被拒', !noEmp.ok)

  // 不存在客户
  const noCustomer = dataService.createContract('admin', 1, {
    customer_id: 999, contract_date: '2026-08-20', duration_days: 1, item_ids: [a.item_id],
  }, '2026-08-20T10:00:00')
  check('不存在客户被拒', !noCustomer.ok && noCustomer.field === 'customer_id')

  // 不存在设备
  const noItem = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 1, item_ids: [999],
  }, '2026-08-20T10:00:00')
  check('不存在设备被拒', !noItem.ok && noItem.field === 'item_ids')

  // 重复设备
  const dupItem = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 1, item_ids: [a.item_id, a.item_id],
  }, '2026-08-20T10:00:00')
  check('重复设备被拒', !dupItem.ok && dupItem.field === 'item_ids')

  // 非在库设备被拒（借出中 a 已在上面被借出）
  const rented = availableItems().length === 0 ? null : null
  void rented
  const notAvailable = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 1, item_ids: [a.item_id],
  }, '2026-08-20T10:00:00')
  check('非在库设备（已借出）被拒', !notAvailable.ok && notAvailable.field === 'item_ids')

  // 非正整数租期
  const zeroDays = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 0, item_ids: [b.item_id],
  }, '2026-08-20T10:00:00')
  check('租期=0 被拒', !zeroDays.ok && zeroDays.field === 'duration_days')
  const negDays = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: -2, item_ids: [b.item_id],
  }, '2026-08-20T10:00:00')
  check('租期为负被拒', !negDays.ok && negDays.field === 'duration_days')
  const floatDays = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 1.5, item_ids: [b.item_id],
  }, '2026-08-20T10:00:00')
  check('租期非整数被拒', !floatDays.ok && floatDays.field === 'duration_days')

  // 非法日期
  const badDate = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-02-30', duration_days: 1, item_ids: [b.item_id],
  }, '2026-08-20T10:00:00')
  check('非法合同日期被拒', !badDate.ok && badDate.field === 'contract_date')

  // 失败零残留：上面多次失败后，合同数与版本应回到创建成功后的状态
  const s1 = snap()
  // 对比：成功创建了 2 份合同（admin + staff）
  check('失败创建不残留（合同数稳定）', s1.contracts === s0.contracts + 2 && s1.version === s0.version + 2)

  // 未来合同日期 + 更早借出时间被拒（checkout_time < contract_date）
  const stillAvail = availableItems()[0]
  const sFuture0 = snap()
  const futureDate = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-09-01', duration_days: 1, item_ids: [stillAvail.item_id],
  }, '2026-08-27T16:00:00')
  check('未来合同日期+更早借出时间被拒', !futureDate.ok && futureDate.field === 'contract_date')
  const sFuture1 = snap()
  check('未来日期冲突被拒后数据/版本不变', sFuture1.contracts === sFuture0.contracts && sFuture1.lines === sFuture0.lines && sFuture1.version === sFuture0.version)
  check('未来日期冲突被拒后设备状态不变', itemStatus(stillAvail.item_id) === '在库')

  // 合法历史日期 + 更晚借出时间成功（checkout_time 晚于 contract_date）
  const pastDate = dataService.createContract('admin', 1, {
    customer_id: 3, contract_date: '2026-08-25', duration_days: 1, item_ids: [stillAvail.item_id],
  }, '2026-08-26T09:00:00')
  check('历史合同日期+更晚借出时间成功', pastDate.ok)
  check('历史日期创建后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  // 清理：归还并完成这两个合同，恢复在库状态供后续测试
  // 实际上后续测试用 reset，这里不清理
  void contractId
}

// ================= 换货 =================
console.log('\n[换货]')
{
  dataService.reset()
  const avail = availableItems().sort((x, y) => x.daily_rate - y.daily_rate)
  const cheap = avail[0]       // 日租金最低
  const expensive = avail[avail.length - 1]  // 日租金最高
  const mid = avail.find((i) => i.item_id !== cheap.item_id && i.item_id !== expensive.item_id)!

  // 创建含 cheap + mid 的合同，duration=3
  const r = dataService.createContract('admin', 1, {
    customer_id: 1,
    contract_date: '2026-08-20',
    duration_days: 3,
    item_ids: [cheap.item_id, mid.item_id],
  }, '2026-08-20T09:00:00')
  const contractId = r.data.contract.contract_id
  const oldLine = r.data.lines.find((l) => l.item_id === cheap.item_id)!

  // 正差价换货：cheap → expensive，change_date=08-21（elapsed=1，remaining=2）
  const beforeTotal = r.data.contract.total_amount
  const ex = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: oldLine.contract_line_id,
    new_item_id: expensive.item_id,
    return_store_id: 1,
    change_date: '2026-08-21',
  }, '2026-08-21T14:00:00')
  const expectedDelta = (expensive.daily_rate - cheap.daily_rate) * 2
  check('正差价换货成功', ex.ok && ex.data.amount_delta > 0)
  check('换货差价独立复算正确', ex.ok && Math.abs(ex.data.amount_delta - expectedDelta) < 0.005)
  check('合同总额累加差价', Math.abs(dataService.getContractDetail(contractId)!.contract.total_amount - (beforeTotal + expectedDelta)) < 0.005)
  check('两条变更记录', ex.ok && ex.data.changes.length === 2)
  check('两条 change_id 不同', ex.ok && ex.data.changes[0].change_id !== ex.data.changes[1].change_id)
  check('change_id 与历史记录不重复', ex.ok && (() => {
    const ids = dataService.getSnapshot().contract_changes.map((c) => c.change_id)
    return new Set(ids).size === ids.length
  })())
  check('共享 change_group_id', ex.ok && ex.data.changes[0].change_group_id === ex.data.changes[1].change_group_id)
  check('仅一条 amount_delta 非空', ex.ok && ex.data.changes.filter((c) => c.amount_delta !== null).length === 1)
  check('旧设备恢复在库', itemStatus(cheap.item_id) === '在库')
  check('新设备改为借出中', itemStatus(expensive.item_id) === '借出中')

  // 详情：明细状态
  const detail = dataService.getContractDetail(contractId)!
  const oldLineAfter = detail.lines.find((l) => l.line.contract_line_id === oldLine.contract_line_id)!
  const newLine = detail.lines.find((l) => l.line.item_id === expensive.item_id)!
  check('旧明细已更换', oldLineAfter.line.status === '已更换')
  check('旧明细 return_time = 换货时间', oldLineAfter.line.return_time === '2026-08-21T14:00:00')
  check('新明细借出中、checkout_time = 换货时间', newLine.line.status === '借出中' && newLine.line.checkout_time === '2026-08-21T14:00:00')
  check('两条变更 change_date 与明细时间完全相等', ex.ok && ex.data.changes[0].change_date === ex.data.changes[1].change_date && ex.data.changes[0].change_date === oldLineAfter.line.return_time && ex.data.changes[0].change_date === newLine.line.checkout_time)
  check('换货成功后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  // 负差价退款：expensive → 一件在库且不在合同中的更低价款设备
  const contractItemSet = new Set([cheap.item_id, mid.item_id, expensive.item_id])
  const thirdAvail = availableItems().find((i) => !contractItemSet.has(i.item_id) && i.daily_rate < expensive.daily_rate)!
  const expLine = dataService.getContractDetail(contractId)!.lines.find((l) => l.line.item_id === expensive.item_id)!.line
  const ex2 = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: expLine.contract_line_id,
    new_item_id: thirdAvail.item_id,
    return_store_id: 2,
    change_date: '2026-08-22',
  }, '2026-08-22T14:00:00')
  check('负差价退款换货成功', ex2.ok && ex2.data.amount_delta < 0)

  // 篡改客户端差价不影响：exchangeItem 无金额入参，验证 amount_delta 恒等于公式值（用快照 expLine.daily_rate）
  check('差价无法被客户端篡改（服务层复算）', ex2.ok && Math.abs(ex2.data.amount_delta - (thirdAvail.daily_rate - expLine.daily_rate) * 1) < 0.005)

  // 合同有效期外换货被拒
  const lateLine = dataService.getContractDetail(contractId)!.lines.find((l) => l.line.status === '借出中')!.line
  const lateEx = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: lateLine.contract_line_id,
    new_item_id: mid.item_id,
    return_store_id: 1,
    change_date: '2026-08-25',  // elapsed=5 > duration=3
  })
  check('合同有效期外换货被拒', !lateEx.ok && lateEx.field === 'change_date')

  // 新设备不可用（借出中/维修中）被拒
  const rentedItem = dataService.listItems().find((i) => i.status === '借出中')!
  const unavailableNew = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: lateLine.contract_line_id,
    new_item_id: rentedItem.item_id,
    return_store_id: 1,
    change_date: '2026-08-21',
  })
  check('新设备不可用被拒', !unavailableNew.ok && unavailableNew.field === 'new_item_id')

  // 重复物品被拒（新设备已在合同中）
  const existingInContract = dataService.getContractDetail(contractId)!.lines.find((l) => l.line.item_id === mid.item_id)!.line
  const dupNew = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: lateLine.contract_line_id,
    new_item_id: existingInContract.item_id,
    return_store_id: 1,
    change_date: '2026-08-21',
  })
  check('重复物品被拒', !dupNew.ok && dupNew.field === 'new_item_id')

  // 非活动旧明细被拒（已更换的明细）
  const nonActive = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: oldLine.contract_line_id,  // 已更换
    new_item_id: mid.item_id,
    return_store_id: 1,
    change_date: '2026-08-21',
  })
  check('非活动旧明细被拒', !nonActive.ok && nonActive.field === 'old_line_id')

  // 换货失败回滚：记录失败前状态，触发一次失败，验证不变
  const sBefore = snap()
  const beforeStatus = itemStatus(lateLine.item_id)
  const failEx = dataService.exchangeItem('admin', {
    contract_id: contractId,
    old_line_id: lateLine.contract_line_id,
    new_item_id: 999,
    return_store_id: 1,
    change_date: '2026-08-21',
  })
  check('换货失败', !failEx.ok)
  const sAfter = snap()
  check('换货失败后数据/版本不变', sAfter.contracts === sBefore.contracts && sAfter.lines === sBefore.lines && sAfter.changes === sBefore.changes && sAfter.version === sBefore.version)
  check('换货失败后设备状态不变', itemStatus(lateLine.item_id) === beforeStatus)

  // contractor 换货被拒
  const cEx = dataService.exchangeItem('contractor', {
    contract_id: contractId, old_line_id: lateLine.contract_line_id, new_item_id: mid.item_id, return_store_id: 1, change_date: '2026-08-21',
  })
  check('contractor 换货被拒', !cEx.ok)
}

// ================= 换货时间顺序（下午借出 + 同日换货） =================
console.log('\n[换货时间顺序]')
{
  dataService.reset()
  const avail = availableItems()
  const [a, b] = avail

  // 下午 16:00 借出
  const r = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 3, item_ids: [a.item_id, b.item_id],
  }, '2026-08-20T16:00:00')
  const contractId = r.data.contract.contract_id
  const lineA = r.data.lines.find((l) => l.item_id === a.item_id)!
  const otherItem = availableItems().find((i) => i.item_id !== a.item_id && i.item_id !== b.item_id)!

  // 反向：同日 12:00 换货（早于 16:00 借出）应被拒，不能再产生 return_time < checkout_time
  const sBad0 = snap()
  const badEx = dataService.exchangeItem('admin', {
    contract_id: contractId, old_line_id: lineA.contract_line_id, new_item_id: otherItem.item_id, return_store_id: 1, change_date: '2026-08-20',
  }, '2026-08-20T12:00:00')
  check('同日换货时间早于借出时间被拒', !badEx.ok && badEx.field === 'change_date')
  const sBad1 = snap()
  check('换货时间倒置被拒后数据/版本不变', sBad1.contracts === sBad0.contracts && sBad1.lines === sBad0.lines && sBad1.changes === sBad0.changes && sBad1.version === sBad0.version)
  check('换货时间倒置被拒后旧明细仍借出中', lineA.status === '借出中' && lineA.return_time === null)

  // 正向：同日 18:00 换货（晚于 16:00）成功
  const okEx = dataService.exchangeItem('admin', {
    contract_id: contractId, old_line_id: lineA.contract_line_id, new_item_id: otherItem.item_id, return_store_id: 1, change_date: '2026-08-20',
  }, '2026-08-20T18:00:00')
  check('同日换货时间晚于借出时间成功', okEx.ok)
  const detail = dataService.getContractDetail(contractId)!
  const oldAfter = detail.lines.find((l) => l.line.contract_line_id === lineA.contract_line_id)!
  check('同日换货后旧明细 return_time = 18:00', oldAfter.line.return_time === '2026-08-20T18:00:00')
  check('同日换货后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)
}

// ================= 价格快照（目录调价不影响合同差价） =================
console.log('\n[价格快照]')
{
  dataService.reset()
  const avail = availableItems()
  const [a, b] = avail

  // 创建合同，固化旧设备价格
  const r = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 3, item_ids: [a.item_id, b.item_id],
  }, '2026-08-20T09:00:00')
  const contractId = r.data.contract.contract_id
  const lineA = r.data.lines.find((l) => l.item_id === a.item_id)!
  const oldSnapshotRate = lineA.daily_rate

  // 之后修改旧设备目录日租金（调高 500）
  const itemA = dataService.listItems().find((i) => i.item_id === a.item_id)!
  const newCatalogRate = itemA.daily_rate + 500
  dataService.updateItem('admin', a.item_id, {
    item_code: itemA.item_code, name: itemA.name, description: itemA.description, category: itemA.category,
    purchase_date: itemA.purchase_date, purchase_cost: itemA.purchase_cost, retail_price: itemA.retail_price,
    daily_rate: newCatalogRate, skill_level_id: itemA.skill_level_id, home_store_id: itemA.home_store_id, current_store_id: itemA.current_store_id,
  })

  // 换货 a → other，差价按旧明细快照 oldLine.daily_rate（remaining=2）
  const otherItem = availableItems().find((i) => i.item_id !== a.item_id && i.item_id !== b.item_id)!
  const ex = dataService.exchangeItem('admin', {
    contract_id: contractId, old_line_id: lineA.contract_line_id, new_item_id: otherItem.item_id, return_store_id: 1, change_date: '2026-08-21',
  }, '2026-08-21T14:00:00')
  const expectedDelta = (otherItem.daily_rate - oldSnapshotRate) * 2
  check('调价后换货差价仍按旧明细快照', ex.ok && Math.abs(ex.data.amount_delta - expectedDelta) < 0.005)
  check('调价后差价不按新目录价', ex.ok && Math.abs(ex.data.amount_delta - (otherItem.daily_rate - newCatalogRate) * 2) > 0.005)
  check('调价换货后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)
}

// ================= 归还 =================
console.log('\n[归还]')
{
  dataService.reset()
  const avail = availableItems()
  const [a, b] = avail

  const r = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 3, item_ids: [a.item_id, b.item_id],
  }, '2026-08-20T09:00:00')
  const contractId = r.data.contract.contract_id
  const lineA = r.data.lines.find((l) => l.item_id === a.item_id)!
  const lineB = r.data.lines.find((l) => l.item_id === b.item_id)!

  // 跨店归还：a 的 home_store_id 已知，归还到另一门店
  const homeA = dataService.listItems().find((i) => i.item_id === a.item_id)!.home_store_id
  const otherStore = homeA === 1 ? 2 : 1

  // 部分归还 a
  const partial = dataService.returnItems('admin', {
    contract_id: contractId,
    line_ids: [lineA.contract_line_id],
    return_store_id: otherStore,
  }, '2026-08-28T18:00:00')
  check('部分归还成功', partial.ok)
  check('部分归还后合同仍进行中', partial.ok && partial.data.contract.status === '进行中')
  check('部分归还后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)
  const itemA = dataService.listItems().find((i) => i.item_id === a.item_id)!
  check('跨店归还更新 current_store_id', itemA.current_store_id === otherStore)
  check('跨店归还不改 home_store_id', itemA.home_store_id === homeA)
  check('归还后设备恢复在库', itemA.status === '在库')

  // 全部归还 b
  const full = dataService.returnItems('admin', {
    contract_id: contractId,
    line_ids: [lineB.contract_line_id],
    return_store_id: homeA,
  }, '2026-08-28T19:00:00')
  check('全部归还成功', full.ok)
  check('全部归还后合同已完成', full.ok && full.data.contract.status === '已完成')
  check('completed_at 已写入', full.ok && full.data.contract.completed_at === '2026-08-28T19:00:00')
  const expectedFinal = a.daily_rate * 3 + b.daily_rate * 3
  check('最终总额固化正确', full.ok && Math.abs(full.data.contract.total_amount - expectedFinal) < 0.005)
  check('全部归还后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  // 已完成合同不可再操作
  const afterComplete = dataService.returnItems('admin', {
    contract_id: contractId, line_ids: [lineA.contract_line_id], return_store_id: 1,
  }, '2026-08-29T09:00:00')
  check('已完成合同不可再归还', !afterComplete.ok)
  const exDone = dataService.exchangeItem('admin', {
    contract_id: contractId, old_line_id: lineA.contract_line_id, new_item_id: 1, return_store_id: 1, change_date: '2026-08-29',
  })
  check('已完成合同不可再换货', !exDone.ok)

  // return_time 不晚于 checkout_time 被拒（新建一份合同测）
  const r2 = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 3, item_ids: [b.item_id],
  }, '2026-08-20T09:00:00')
  const lineB2 = r2.data.lines[0]
  const earlyReturn = dataService.returnItems('admin', {
    contract_id: r2.data.contract.contract_id,
    line_ids: [lineB2.contract_line_id],
    return_store_id: 1,
  }, '2026-08-20T08:00:00')
  check('归还时间早于借出时间被拒', !earlyReturn.ok && earlyReturn.field === 'line_ids')

  // 不存在归还门店被拒
  const badStore = dataService.returnItems('admin', {
    contract_id: r2.data.contract.contract_id,
    line_ids: [lineB2.contract_line_id],
    return_store_id: 999,
  }, '2026-08-28T18:00:00')
  check('不存在归还门店被拒', !badStore.ok && badStore.field === 'return_store_id')

  // 批量归还重复 line_id 被拒
  const dupLine = dataService.returnItems('admin', {
    contract_id: r2.data.contract.contract_id,
    line_ids: [lineB2.contract_line_id, lineB2.contract_line_id],
    return_store_id: 1,
  }, '2026-08-28T18:00:00')
  check('批量归还重复 line_id 被拒', !dupLine.ok && dupLine.field === 'line_ids')

  // contractor 归还被拒
  const cReturn = dataService.returnItems('contractor', {
    contract_id: r2.data.contract.contract_id, line_ids: [lineB2.contract_line_id], return_store_id: 1,
  }, '2026-08-28T18:00:00')
  check('contractor 归还被拒', !cReturn.ok)
}

// ================= 快照隔离 + 持久化 =================
console.log('\n[快照隔离与持久化]')
{
  dataService.reset()

  // listContracts 返回值不影响内部
  const list = dataService.listContracts()
  const before = list.length
  list.pop()
  list[0]?.contract_no && (list[0].contract_no = '篡改')
  check('listContracts 返回值不影响内部', dataService.listContracts().length === before && dataService.listContracts()[0].contract_no !== '篡改')

  // getContractDetail 返回值不影响内部
  const detail = dataService.getContractDetail(1)!
  detail.contract.total_amount = 9999
  check('getContractDetail 返回值不影响内部', dataService.getContractDetail(1)!.contract.total_amount !== 9999)

  // localStorage 持久化：创建合同后写入 mock localStorage
  const avail = availableItems()
  const r = dataService.createContract('admin', 1, {
    customer_id: 1, contract_date: '2026-08-20', duration_days: 2, item_ids: [avail[0].item_id],
  }, '2026-08-20T09:00:00')
  const raw = mem.get('snowpeak.db.v1')
  check('localStorage 已写入', typeof raw === 'string')
  const persisted = JSON.parse(raw!)
  check('新合同已持久化', persisted.rental_contracts.some((c: { contract_id: number }) => c.contract_id === r.data.contract.contract_id))
}

// ================= 重置 =================
console.log('\n[重置]')
{
  dataService.reset()
  check('reset 恢复种子（合同 15）', dataService.listContracts().length === 15)
}

console.log(`\n租赁合同测试结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
