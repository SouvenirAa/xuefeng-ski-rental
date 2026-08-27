/**
 * 维修单 DataService 服务层测试（创建/开始/完成 + 权限 + 费率冻结 + 原子性）。
 * 由 scripts/validate-repairs.mjs 用 esbuild 打包执行；不参与 tsc 编译。
 * 用法：npm run validate:repairs
 */
import type { CreateRepairInput, RentalItem } from '../src/data/types'

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
console.log('\n【维修单测试】')
if (!initResult.ok) { console.error('初始化失败：', initResult.reason); process.exit(1) }

function availableItem(): RentalItem {
  return dataService.listItems().find((i) => i.status === '在库')!
}

const snap = () => ({
  repairs: dataService.getSnapshot().repair_orders.length,
  version: dataService.getVersion(),
})

const itemStatus = (id: number) => dataService.listItems().find((i) => i.item_id === id)?.status

// ================= 创建维修单 =================
console.log('\n[创建维修单]')
{
  dataService.reset()
  const a = availableItem()

  // 每次调用动态取一件在库设备（避免复用已转「维修中」的设备）
  const defInput = (over: Partial<CreateRepairInput> = {}): CreateRepairInput => ({
    item_id: availableItem().item_id,
    contractor_id: 1,
    request_date: '2026-08-26',
    fault_description: '板刃卷边',
    ...over,
  })

  const s0 = snap()
  const r = dataService.createRepairOrder('admin', { ...defInput(), item_id: a.item_id })
  check('admin 创建成功', r.ok && r.data.status === '待维修')
  check('创建后设备变维修中', r.ok && itemStatus(a.item_id) === '维修中')
  check('创建后 rate_id 冻结为 07-01 费率(2)', r.ok && r.data.rate_id === 2)
  check('创建后 repair_date/hours/cost/notes 为 null', r.ok && r.data.repair_date === null && r.data.repair_hours === null && r.data.calculated_cost === null && r.data.notes === null)
  check('创建后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  const repairId = r.data.repair_id

  // staff 也可创建（换一件在库设备）
  const b = availableItem()
  const staffCreate = dataService.createRepairOrder('staff', { ...defInput(), item_id: b.item_id })
  check('staff 创建成功', staffCreate.ok)

  // contractor 创建被拒
  const cCreate = dataService.createRepairOrder('contractor', defInput())
  check('contractor 创建被拒', !cCreate.ok)

  // 借出中设备被拒（种子合同进行中的借出中设备）
  const rentedItem = dataService.listItems().find((i) => i.status === '借出中')!
  const rentedCreate = dataService.createRepairOrder('admin', { ...defInput(), item_id: rentedItem.item_id })
  check('借出中设备被拒', !rentedCreate.ok && rentedCreate.field === 'item_id')

  // 维修中设备被拒
  const repairingItem = dataService.listItems().find((i) => i.status === '维修中' && i.item_id !== a.item_id && i.item_id !== b.item_id)!
  const repairingCreate = dataService.createRepairOrder('admin', { ...defInput(), item_id: repairingItem.item_id })
  check('维修中设备被拒', !repairingCreate.ok && repairingCreate.field === 'item_id')

  // 已报废设备被拒
  const scrappedItem = dataService.listItems().find((i) => i.status === '已报废')!
  const scrappedCreate = dataService.createRepairOrder('admin', { ...defInput(), item_id: scrappedItem.item_id })
  check('已报废设备被拒', !scrappedCreate.ok && scrappedCreate.field === 'item_id')

  // 不存在设备/承包商被拒
  const noItem = dataService.createRepairOrder('admin', { ...defInput(), item_id: 999 })
  check('不存在设备被拒', !noItem.ok && noItem.field === 'item_id')
  const noContractor = dataService.createRepairOrder('admin', { ...defInput(), contractor_id: 999 })
  check('不存在承包商被拒', !noContractor.ok && noContractor.field === 'contractor_id')

  // 缺失故障描述
  const noDesc = dataService.createRepairOrder('admin', { ...defInput(), fault_description: '  ' })
  check('缺失故障描述被拒', !noDesc.ok && noDesc.field === 'fault_description')

  // 未来申请日期
  const futureDate = dataService.createRepairOrder('admin', { ...defInput(), request_date: '2099-01-01' })
  check('未来申请日期被拒', !futureDate.ok && futureDate.field === 'request_date')

  // 无有效费率（request_date 早于所有费率）
  const noRate = dataService.createRepairOrder('admin', { ...defInput(), request_date: '2025-12-31' })
  check('无有效费率被拒', !noRate.ok && noRate.field === 'contractor_id')

  // request_date 正确选择历史费率：06-15 应选 01-01(rate 1, 180)，未来费率不提前
  const c = availableItem()
  const earlyRate = dataService.createRepairOrder('admin', { ...defInput(), item_id: c.item_id, request_date: '2026-06-15' })
  check('request_date=06-15 冻结 01-01 费率(rate 1)', earlyRate.ok && earlyRate.data.rate_id === 1)

  // 失败零残留（上述失败后，成功创建了 admin + staff + earlyRate 共 3 张）
  const s1 = snap()
  check('失败创建不残留（维修单数稳定）', s1.repairs === s0.repairs + 3 && s1.version === s0.version + 3)
}

// ================= 状态机：开始 / 完成 =================
console.log('\n[开始/完成维修]')
{
  dataService.reset()
  const a = availableItem()
  const r = dataService.createRepairOrder('admin', {
    item_id: a.item_id, contractor_id: 1, request_date: '2026-08-26', fault_description: '测试故障',
  })
  const repairId = r.data.repair_id

  // contractor 1 开始
  const start = dataService.startRepair('contractor', 1, repairId)
  check('contractor 1 开始维修成功', start.ok && start.data.status === '维修中')
  check('开始后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  // 重复开始被拒
  const restart = dataService.startRepair('contractor', 1, repairId)
  check('重复开始被拒', !restart.ok)

  // 其他 contractor（contractor 2）不能开始
  const otherStart = dataService.startRepair('contractor', 2, repairId)
  check('其他 contractor 不能开始', !otherStart.ok)

  // admin/staff 不能代替开始
  const adminStart = dataService.startRepair('admin', 1, repairId)
  check('admin 不能代替开始', !adminStart.ok)
  const staffStart = dataService.startRepair('staff', 1, repairId)
  check('staff 不能代替开始', !staffStart.ok)

  // 待维修不能直接完成（用一张新的待维修单测）
  const b = availableItem()
  const r2 = dataService.createRepairOrder('admin', {
    item_id: b.item_id, contractor_id: 1, request_date: '2026-08-26', fault_description: '测试',
  })
  const directComplete = dataService.completeRepair('contractor', 1, r2.data.repair_id, {
    repair_date: '2026-08-27', repair_hours: 1, notes: '测试',
  })
  check('待维修不能直接完成', !directComplete.ok)

  // 完成日期校验：早于申请日期被拒
  const earlyDate = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-25', repair_hours: 1, notes: '测试',
  })
  check('完成日期早于申请日期被拒', !earlyDate.ok && earlyDate.field === 'repair_date')

  // 未来完成日期被拒
  const futureRepairDate = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2099-01-01', repair_hours: 1, notes: '测试',
  })
  check('未来完成日期被拒', !futureRepairDate.ok && futureRepairDate.field === 'repair_date')

  // 工时 <= 0 被拒
  const zeroHours = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 0, notes: '测试',
  })
  check('工时=0 被拒', !zeroHours.ok && zeroHours.field === 'repair_hours')

  // 工时非 0.25 步进被拒
  const badStep = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 0.3, notes: '测试',
  })
  check('工时非 0.25 步进被拒', !badStep.ok && badStep.field === 'repair_hours')

  // 说明必填
  const noNotes = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 1.5, notes: '  ',
  })
  check('说明必填被拒', !noNotes.ok && noNotes.field === 'notes')

  // 其他 contractor/admin/staff 不能完成
  const otherComplete = dataService.completeRepair('contractor', 2, repairId, {
    repair_date: '2026-08-27', repair_hours: 1, notes: '测试',
  })
  check('其他 contractor 不能完成', !otherComplete.ok)
  const adminComplete = dataService.completeRepair('admin', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 1, notes: '测试',
  })
  check('admin 不能代替完成', !adminComplete.ok)

  // 完成成功：成本按冻结费率 200 × 1.5 = 300
  const complete = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 1.5, notes: '更换卡扣完成',
  })
  check('完成维修成功', complete.ok && complete.data.status === '已完成')
  check('成本按冻结费率计算(200×1.5=300)', complete.ok && Math.abs(complete.data.calculated_cost! - 300) < 0.005)
  check('完成后设备恢复在库', itemStatus(a.item_id) === '在库')
  check('完成后 validateDatabase 通过', validateDatabase(dataService.getSnapshot()).ok)

  // 已完成不可再操作
  const reComplete = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 1, notes: '再次',
  })
  check('已完成不可再次完成', !reComplete.ok)
  const reStart = dataService.startRepair('contractor', 1, repairId)
  check('已完成不可回退开始', !reStart.ok)
}

// ================= 费率冻结：后续新增费率不影响历史单 =================
console.log('\n[费率冻结]')
{
  dataService.reset()
  const a = availableItem()
  const r = dataService.createRepairOrder('admin', {
    item_id: a.item_id, contractor_id: 1, request_date: '2026-08-26', fault_description: '测试',
  })
  const repairId = r.data.repair_id

  // 开始维修
  dataService.startRepair('contractor', 1, repairId)

  // 后续给承包商 1 新增一条未来费率（不影响已冻结的 rate_id）
  dataService.createContractorRate('admin', 1, { effective_date: '2026-09-01', hourly_rate: 999 })

  // 完成：成本仍按冻结费率 200（rate_id 2）计算
  const complete = dataService.completeRepair('contractor', 1, repairId, {
    repair_date: '2026-08-27', repair_hours: 2, notes: '测试',
  })
  check('后续新增费率不影响历史单成本(200×2=400)', complete.ok && Math.abs(complete.data.calculated_cost! - 400) < 0.005)
}

// ================= 权限与查询过滤 =================
console.log('\n[权限与查询]')
{
  dataService.reset()

  // admin/staff 可见全部；contractor 仅见自己的单
  const adminAll = dataService.listRepairs('admin').length
  const staffAll = dataService.listRepairs('staff').length
  check('admin/staff 可见全部维修单', adminAll === 10 && staffAll === 10)

  const c1 = dataService.listRepairs('contractor', 1)
  check('contractor 1 仅见自己的单', c1.length > 0 && c1.every((r) => r.contractor_id === 1))
  const c2 = dataService.listRepairs('contractor', 2)
  check('contractor 2 仅见自己的单', c2.every((r) => r.contractor_id === 2))
  const cNoId = dataService.listRepairs('contractor')
  check('contractor 未传 id 返回空', cNoId.length === 0)

  // contractor 1 只能操作自己的单：尝试操作 contractor 2 的单被拒
  const c2Repair = c2.find((r) => r.status === '待维修')!
  const otherOp = dataService.startRepair('contractor', 1, c2Repair.repair_id)
  check('contractor 操作他人单被拒', !otherOp.ok)
}

// ================= 快照隔离 + 持久化 =================
console.log('\n[快照隔离与持久化]')
{
  dataService.reset()

  const list = dataService.listRepairs('admin')
  const before = list.length
  list.pop()
  list[0] && (list[0].fault_description = '篡改')
  check('listRepairs 返回值不影响内部', dataService.listRepairs('admin').length === before && dataService.listRepairs('admin')[0].fault_description !== '篡改')

  const detail = dataService.getRepairDetail(1)!
  detail.repair.calculated_cost = 9999
  check('getRepairDetail 返回值不影响内部', dataService.getRepairDetail(1)!.repair.calculated_cost !== 9999)

  // localStorage 持久化
  const a = availableItem()
  const r = dataService.createRepairOrder('admin', {
    item_id: a.item_id, contractor_id: 1, request_date: '2026-08-26', fault_description: '持久化测试',
  })
  const raw = mem.get('snowpeak.db.v1')
  check('localStorage 已写入', typeof raw === 'string')
  const persisted = JSON.parse(raw!)
  check('新维修单已持久化', persisted.repair_orders.some((x: { repair_id: number }) => x.repair_id === r.data.repair_id))
}

// ================= 重置 =================
console.log('\n[重置]')
{
  dataService.reset()
  check('reset 恢复种子（维修单 10）', dataService.listRepairs('admin').length === 10)
}

console.log(`\n维修单测试结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
