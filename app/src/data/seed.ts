import type {
  Account,
  ContractChange,
  ContractLine,
  Contractor,
  ContractorRate,
  Customer,
  Database,
  Employee,
  RentalContract,
  RentalItem,
  RepairOrder,
  Shift,
  SkillLevel,
  Store,
} from './types'

/**
 * 种子数据 —— 全部虚构，用于教学演示。
 *
 * 设备状态**不手工硬编码**，而是由业务数据（维修单 + 进行中合同明细）推导：
 *  - 已报废：显式指定
 *  - 维修中：存在"待维修 / 维修中"维修单
 *  - 借出中：存在于"进行中"合同的"借出中"明细
 *  - 在库：其余
 *
 * 合同金额由明细公式计算（Σ daily_rate × quantity × duration_days + 换货差价），
 * 时间确定性生成（不依赖运行时当前时间）。
 */

/** 已报废设备 */
const SCRAPPED_ITEM_IDS = [35, 36]

export function createSeedDatabase(): Database {
  const skill_levels: SkillLevel[] = [
    { skill_level_id: 1, level_name: '初级', sort_order: 1 },
    { skill_level_id: 2, level_name: '中级', sort_order: 2 },
    { skill_level_id: 3, level_name: '高级', sort_order: 3 },
    { skill_level_id: 4, level_name: '专家+', sort_order: 4 },
  ]

  const stores: Store[] = [
    { store_id: 1, store_name: '云顶东门店', address: '云顶滑雪度假区东入口 1 号', phone: '0755-81000001' },
    { store_id: 2, store_name: '云顶西门店', address: '云顶滑雪度假区西索道下站 2 号', phone: '0755-81000002' },
  ]

  const employees: Employee[] = [
    { employee_id: 1, full_name: '林远山', address: '云顶镇雪松路 8 号', phone: '13800000001', email: 'lin@xuefeng.example', notes: '总经理' },
    { employee_id: 2, full_name: '苏晓芸', address: '云顶镇云杉路 12 号', phone: '13800000002', email: 'su@xuefeng.example', notes: '运营主管' },
    { employee_id: 3, full_name: '周子豪', address: '云顶镇松涛路 3 号', phone: '13800000003', email: 'zhou@xuefeng.example', notes: '轮岗店员' },
    { employee_id: 4, full_name: '陈雨桐', address: '云顶镇雪松路 21 号', phone: '13800000004', email: 'chen@xuefeng.example', notes: '轮岗店员' },
    { employee_id: 5, full_name: '王浩然', address: '云顶镇白桦路 6 号', phone: '13800000005', email: 'wang@xuefeng.example', notes: '竞技单板选手' },
    { employee_id: 6, full_name: '李思远', address: '云顶镇云杉路 30 号', phone: '13800000006', email: 'li@xuefeng.example', notes: null },
    { employee_id: 7, full_name: '张敏', address: '云顶镇松涛路 17 号', phone: '13800000007', email: 'zhang@xuefeng.example', notes: null },
    { employee_id: 8, full_name: '赵天成', address: '云顶镇雪松路 5 号', phone: '13800000008', email: 'zhao@xuefeng.example', notes: null },
  ]

  const contractors: Contractor[] = [
    { contractor_id: 1, name: '峰顶装备维修', address: '云顶工业园 A 栋', phone: '13900000001', email: 'service@fengding.example' },
    { contractor_id: 2, name: '极速雪具工坊', address: '云顶工业园 B 栋', phone: '13900000002', email: 'speed@jisu.example' },
    { contractor_id: 3, name: '雪山维护中心', address: '云顶镇南街 9 号', phone: '13900000003', email: 'maint@xueshan.example' },
  ]

  const contractor_rates: ContractorRate[] = [
    { rate_id: 1, contractor_id: 1, effective_date: '2026-01-01', hourly_rate: 180 },
    { rate_id: 2, contractor_id: 1, effective_date: '2026-07-01', hourly_rate: 200 },
    { rate_id: 3, contractor_id: 2, effective_date: '2026-01-01', hourly_rate: 160 },
    { rate_id: 4, contractor_id: 2, effective_date: '2026-07-01', hourly_rate: 175 },
    { rate_id: 5, contractor_id: 3, effective_date: '2026-01-01', hourly_rate: 150 },
    { rate_id: 6, contractor_id: 3, effective_date: '2026-07-01', hourly_rate: 165 },
  ]

  const accounts: Account[] = [
    { account_id: 1, username: 'admin', password_placeholder: 'demo1234', role: 'admin', employee_id: 1, contractor_id: null, enabled: true },
    { account_id: 2, username: 'staff', password_placeholder: 'demo1234', role: 'staff', employee_id: 2, contractor_id: null, enabled: true },
    { account_id: 3, username: 'contractor', password_placeholder: 'demo1234', role: 'contractor', employee_id: null, contractor_id: 1, enabled: true },
  ]

  const customers: Customer[] = buildCustomers()

  const rental_items: RentalItem[] = buildItems()

  const repair_orders: RepairOrder[] = buildRepairOrders()

  const rental_contracts: RentalContract[] = buildContracts()

  const contract_lines: ContractLine[] = buildContractLines()

  const contract_changes: ContractChange[] = buildContractChanges()

  const shifts: Shift[] = buildShifts()

  // 根据业务数据推导设备状态（不做手工状态猜测）
  applyItemStatus(rental_items, repair_orders, contract_lines, rental_contracts)

  return {
    accounts,
    skill_levels,
    stores,
    customers,
    employees,
    rental_items,
    contractors,
    contractor_rates,
    rental_contracts,
    contract_lines,
    contract_changes,
    repair_orders,
    shifts,
  }
}

// ---------------------------------------------------------------------------
// 客户：12 名
// ---------------------------------------------------------------------------
function buildCustomers(): Customer[] {
  const seed: Array<[string, string, string | null, string]> = [
    ['刘雪峰', '13810000001', 'liuxf@example.com', '1990'],
    ['孙悦', '13810000002', 'sunyue@example.com', '1995'],
    ['马骏', '13810000003', null, '1988'],
    ['何静怡', '13810000004', 'hejy@example.com', '1993'],
    ['罗天成', '13810000005', 'luotc@example.com', '1991'],
    ['高翔', '13810000006', 'gaox@example.com', '1987'],
    ['唐雪', '13810000007', 'tangxue@example.com', '1996'],
    ['冯子墨', '13810000008', null, '1992'],
    ['曾琳', '13810000009', 'zenglin@example.com', '1994'],
    ['许一鸣', '13810000010', 'xuym@example.com', '1989'],
    ['邓晴', '13810000011', 'dengqing@example.com', '1997'],
    ['蒋睿', '13810000012', null, '1993'],
  ]
  return seed.map((row, i) => ({
    customer_id: i + 1,
    full_name: row[0],
    phone: row[1],
    email: row[2],
    address: `云顶镇示例路 ${i + 1} 号`,
    birth_year: Number(row[3]),
    height_cm: 165 + (i % 5) * 4,
    weight_kg: 58 + (i % 6) * 3,
    shoe_size: 38 + (i % 6),
  }))
}

// ---------------------------------------------------------------------------
// 设备：36 件（item_id 1-36），初始 status 占位为"在库"，最后统一推导
// ---------------------------------------------------------------------------
function buildItems(): RentalItem[] {
  const spec: Array<[string, RentalItem['category'], number, number | null, number]> = [
    ['Head XTC 滑雪板', '滑雪板', 200, 3, 4],
    ['Rossignol 初级滑雪板', '滑雪板', 100, 1, 3],
    ['Salomon 中阶滑雪板', '滑雪板', 130, 2, 3],
    ['Nordica 专家滑雪板', '滑雪板', 200, 4, 3],
    ['雪杖', '雪杖', 30, null, 6],
    ['单板 Burton 中级', '单板', 150, 2, 3],
    ['单板 入门', '单板', 90, 1, 3],
    ['雪靴 Head 26', '雪靴', 80, null, 5],
    ['护目镜', '护目镜', 25, null, 3],
    ['头盔 M', '头盔', 25, null, 3],
  ]

  const items: RentalItem[] = []
  let id = 1
  for (const [name, category, rate, level, count] of spec) {
    for (let i = 0; i < count; i++) {
      const storeId = id % 2 === 1 ? 1 : 2
      items.push({
        item_id: id,
        item_code: `SN${String(id).padStart(4, '0')}`,
        name: count > 1 ? `${name} #${i + 1}` : name,
        description: category === '雪杖' ? '成对出租' : '常规尺码',
        category,
        purchase_date: '2025-11-15',
        purchase_cost: rate * 8,
        retail_price: rate * 12,
        daily_rate: rate,
        skill_level_id: level,
        home_store_id: storeId,
        current_store_id: storeId,
        status: '在库',
      })
      id++
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// 维修单：10 张（已完成 4、维修中 2、待维修 4）
// rate_id 均属于对应 contractor_id；已完成成本 = repair_hours × hourly_rate
// ---------------------------------------------------------------------------
function buildRepairOrders(): RepairOrder[] {
  return [
    { repair_id: 1, item_id: 2, contractor_id: 1, rate_id: 2, request_date: '2026-08-18', fault_description: '固定器卡扣松动', repair_date: '2026-08-20', repair_hours: 1.5, calculated_cost: 300, notes: '更换卡扣', status: '已完成' },
    { repair_id: 2, item_id: 8, contractor_id: 2, rate_id: 4, request_date: '2026-08-20', fault_description: '板底划痕打磨', repair_date: '2026-08-22', repair_hours: 2, calculated_cost: 350, notes: null, status: '已完成' },
    { repair_id: 3, item_id: 14, contractor_id: 3, rate_id: 6, request_date: '2026-08-21', fault_description: '雪杖杖尖磨损', repair_date: '2026-08-23', repair_hours: 1, calculated_cost: 165, notes: null, status: '已完成' },
    { repair_id: 4, item_id: 20, contractor_id: 1, rate_id: 2, request_date: '2026-08-23', fault_description: '单板固定器调节', repair_date: '2026-08-24', repair_hours: 0.5, calculated_cost: 100, notes: null, status: '已完成' },
    { repair_id: 5, item_id: 5, contractor_id: 2, rate_id: 4, request_date: '2026-08-24', fault_description: '初级滑雪板板刃卷边', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '维修中' },
    { repair_id: 6, item_id: 9, contractor_id: 1, rate_id: 2, request_date: '2026-08-24', fault_description: '中阶滑雪板蜡层脱落', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '维修中' },
    { repair_id: 7, item_id: 12, contractor_id: 3, rate_id: 6, request_date: '2026-08-25', fault_description: '专家滑雪板板刃崩口', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '待维修' },
    { repair_id: 8, item_id: 24, contractor_id: 2, rate_id: 4, request_date: '2026-08-25', fault_description: '入门单板边刃开胶', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '待维修' },
    { repair_id: 9, item_id: 28, contractor_id: 1, rate_id: 2, request_date: '2026-08-25', fault_description: '雪靴内胆开胶', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '待维修' },
    { repair_id: 10, item_id: 32, contractor_id: 3, rate_id: 6, request_date: '2026-08-25', fault_description: '护目镜镜片更换', repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '待维修' },
  ]
}

// ---------------------------------------------------------------------------
// 合同：15 份（已完成 9、进行中 6），金额与时间由 spec 计算生成
// ---------------------------------------------------------------------------
interface ExchangeSpec {
  fromItem: number
  toItem: number
  /** 换货发生日相对 contract_date 的天数偏移（0-indexed） */
  changeDay: number
}

interface ContractSpec {
  id: number
  no: string
  customerId: number
  employeeId: number
  date: string
  days: number
  items: number[]
  exchange?: ExchangeSpec
  completedAt: string | null
}

const contractSpecs: ContractSpec[] = [
  { id: 1, no: 'RC20260801-0001', customerId: 1, employeeId: 2, date: '2026-08-01', days: 3, items: [2, 8, 13], completedAt: '2026-08-03' },
  { id: 2, no: 'RC20260805-0002', customerId: 2, employeeId: 3, date: '2026-08-05', days: 2, items: [14, 20], completedAt: '2026-08-06' },
  { id: 3, no: 'RC20260808-0003', customerId: 3, employeeId: 4, date: '2026-08-08', days: 4, items: [27, 29, 30], completedAt: '2026-08-11' },
  { id: 4, no: 'RC20260812-0004', customerId: 4, employeeId: 3, date: '2026-08-12', days: 2, items: [31, 33], completedAt: '2026-08-13' },
  { id: 5, no: 'RC20260815-0005', customerId: 5, employeeId: 4, date: '2026-08-15', days: 3, items: [34, 20], exchange: { fromItem: 20, toItem: 27, changeDay: 1 }, completedAt: '2026-08-17' },
  { id: 6, no: 'RC20260818-0006', customerId: 6, employeeId: 2, date: '2026-08-18', days: 2, items: [34, 2], completedAt: '2026-08-19' },
  { id: 7, no: 'RC20260820-0007', customerId: 7, employeeId: 3, date: '2026-08-20', days: 5, items: [1, 3, 4], completedAt: null },
  { id: 8, no: 'RC20260822-0008', customerId: 8, employeeId: 4, date: '2026-08-22', days: 3, items: [6, 7, 10], exchange: { fromItem: 10, toItem: 11, changeDay: 1 }, completedAt: null },
  { id: 9, no: 'RC20260823-0009', customerId: 9, employeeId: 3, date: '2026-08-23', days: 2, items: [15, 16], completedAt: null },
  { id: 10, no: 'RC20260824-0010', customerId: 10, employeeId: 2, date: '2026-08-24', days: 4, items: [17, 18, 19], completedAt: null },
  { id: 11, no: 'RC20260824-0011', customerId: 11, employeeId: 4, date: '2026-08-24', days: 2, items: [21, 22], completedAt: null },
  { id: 12, no: 'RC20260825-0012', customerId: 12, employeeId: 3, date: '2026-08-25', days: 3, items: [23, 25, 26], completedAt: null },
  { id: 13, no: 'RC20260710-0013', customerId: 1, employeeId: 2, date: '2026-07-10', days: 3, items: [13, 14], completedAt: '2026-07-12' },
  { id: 14, no: 'RC20260715-0014', customerId: 5, employeeId: 3, date: '2026-07-15', days: 2, items: [27, 29], completedAt: '2026-07-16' },
  { id: 15, no: 'RC20260720-0015', customerId: 9, employeeId: 4, date: '2026-07-20', days: 4, items: [30, 31, 33], completedAt: '2026-07-23' },
]

/** 'YYYY-MM-DD' + 'HH:mm:ss' -> 'YYYY-MM-DDTHH:mm:ss'（ISO 字典序即时间序） */
function dt(date: string, time: string): string {
  return `${date}T${time}`
}

/** 日期加天数，返回 'YYYY-MM-DD' */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 合同总额 = Σ(rate × quantity × days) + 换货组只计算一次的 amount_delta */
function computeTotal(spec: ContractSpec): number {
  const initial = spec.items.reduce((sum, itemId) => sum + rateOf(itemId) * spec.days, 0)
  return initial + computeExchangeDelta(spec)
}

/** 换货差价（BR-08）：(新日租金 − 旧日租金) × 剩余租赁天数（变更当天计入） */
function computeExchangeDelta(spec: ContractSpec): number {
  if (!spec.exchange) return 0
  const remaining = spec.days - spec.exchange.changeDay
  return (rateOf(spec.exchange.toItem) - rateOf(spec.exchange.fromItem)) * remaining
}

function buildContracts(): RentalContract[] {
  return contractSpecs.map((spec) => ({
    contract_id: spec.id,
    contract_no: spec.no,
    customer_id: spec.customerId,
    employee_id: spec.employeeId,
    contract_date: spec.date,
    duration_days: spec.days,
    total_amount: computeTotal(spec),
    completed_at: spec.completedAt ? dt(spec.completedAt, '18:00:00') : null,
    status: spec.completedAt ? '已完成' : '进行中',
  }))
}

function buildContractLines(): ContractLine[] {
  const lines: ContractLine[] = []
  let lineId = 1

  for (const spec of contractSpecs) {
    const completed = spec.completedAt !== null
    const exchangeDate = spec.exchange ? addDays(spec.date, spec.exchange.changeDay) : null

    spec.items.forEach((itemId, idx) => {
      const exchangedOut = spec.exchange?.fromItem === itemId
      const checkoutTime = dt(spec.date, initialCheckoutTime(idx))

      if (exchangedOut) {
        // 换出：归还时间为换货时间
        lines.push({
          contract_line_id: lineId++,
          contract_id: spec.id,
          item_id: itemId,
          quantity: 1,
          daily_rate: rateOf(itemId),
          checkout_time: checkoutTime,
          checkout_store_id: storeOf(itemId),
          return_time: dt(exchangeDate as string, '14:00:00'),
          return_store_id: storeOf(itemId),
          status: '已更换',
        })
      } else if (completed) {
        lines.push({
          contract_line_id: lineId++,
          contract_id: spec.id,
          item_id: itemId,
          quantity: 1,
          daily_rate: rateOf(itemId),
          checkout_time: checkoutTime,
          checkout_store_id: storeOf(itemId),
          return_time: dt(spec.completedAt as string, '17:00:00'),
          return_store_id: storeOf(itemId),
          status: '已归还',
        })
      } else {
        lines.push({
          contract_line_id: lineId++,
          contract_id: spec.id,
          item_id: itemId,
          quantity: 1,
          daily_rate: rateOf(itemId),
          checkout_time: checkoutTime,
          checkout_store_id: storeOf(itemId),
          return_time: null,
          return_store_id: null,
          status: '借出中',
        })
      }
    })

    // 换入明细
    if (spec.exchange) {
      const toItem = spec.exchange.toItem
      const checkoutTime = dt(exchangeDate as string, '14:00:00')
      lines.push({
        contract_line_id: lineId++,
        contract_id: spec.id,
        item_id: toItem,
        quantity: 1,
        daily_rate: rateOf(toItem),
        checkout_time: checkoutTime,
        checkout_store_id: storeOf(toItem),
        return_time: completed ? dt(spec.completedAt as string, '17:00:00') : null,
        return_store_id: completed ? storeOf(toItem) : null,
        status: completed ? '已归还' : '借出中',
      })
    }
  }

  return lines
}

/** 初始明细借出时间：contract_date 当天 09:00 + 序号偏移，保证各明细时间不同 */
function initialCheckoutTime(idx: number): string {
  const minute = (idx * 7) % 50
  return `09:${String(minute).padStart(2, '0')}:00`
}

function buildContractChanges(): ContractChange[] {
  const changes: ContractChange[] = []
  let changeId = 1
  let groupId = 1

  for (const spec of contractSpecs) {
    if (!spec.exchange) continue
    const changeDate = dt(addDays(spec.date, spec.exchange.changeDay), '14:00:00')
    const delta = computeExchangeDelta(spec)
    const note = delta >= 0 ? '升级至更高价款装备' : '更换为更低价位装备（退款）'
    changes.push(
      {
        change_id: changeId++,
        contract_id: spec.id,
        change_group_id: groupId,
        change_date: changeDate,
        change_type: '归还',
        item_id: spec.exchange.fromItem,
        quantity: 1,
        amount_delta: delta,
        note,
      },
      {
        change_id: changeId++,
        contract_id: spec.id,
        change_group_id: groupId,
        change_date: changeDate,
        change_type: '增加',
        item_id: spec.exchange.toItem,
        quantity: 1,
        amount_delta: null,
        note,
      },
    )
    groupId++
  }

  return changes
}

function rateOf(itemId: number): number {
  const map: Record<number, number> = {
    1: 200, 2: 200, 3: 200, 4: 200, 5: 100, 6: 100, 7: 100, 8: 130, 9: 130, 10: 130,
    11: 200, 12: 200, 13: 200, 14: 30, 15: 30, 16: 30, 17: 30, 18: 30, 19: 30,
    20: 150, 21: 150, 22: 150, 23: 90, 24: 90, 25: 90, 26: 80, 27: 80, 28: 80, 29: 80, 30: 80,
    31: 25, 32: 25, 33: 25, 34: 25, 35: 25, 36: 25,
  }
  return map[itemId] ?? 100
}

function storeOf(itemId: number): number {
  return itemId % 2 === 1 ? 1 : 2
}

// ---------------------------------------------------------------------------
// 排班：近 7 天
// ---------------------------------------------------------------------------
function buildShifts(): Shift[] {
  const shifts: Shift[] = []
  let id = 1
  for (let day = 0; day < 7; day++) {
    const date = `2026-08-${String(19 + day).padStart(2, '0')}`
    for (let emp = 1; emp <= 6; emp++) {
      shifts.push({
        shift_id: id++,
        employee_id: emp,
        store_id: emp % 2 === 0 ? 2 : 1,
        work_date: date,
        start_time: emp % 2 === 0 ? '12:00' : '08:00',
        end_time: emp % 2 === 0 ? '20:00' : '16:00',
      })
    }
  }
  return shifts
}

// ---------------------------------------------------------------------------
// 根据业务数据推导设备状态
// ---------------------------------------------------------------------------
function applyItemStatus(
  items: RentalItem[],
  repairOrders: RepairOrder[],
  contractLines: ContractLine[],
  contracts: RentalContract[],
): void {
  const activeContractIds = new Set(
    contracts.filter((c) => c.status === '进行中').map((c) => c.contract_id),
  )
  const rentedIds = new Set(
    contractLines
      .filter((l) => activeContractIds.has(l.contract_id) && l.status === '借出中')
      .map((l) => l.item_id),
  )
  const repairIds = new Set(
    repairOrders
      .filter((r) => r.status === '待维修' || r.status === '维修中')
      .map((r) => r.item_id),
  )
  const scrappedIds = new Set(SCRAPPED_ITEM_IDS)

  for (const item of items) {
    if (scrappedIds.has(item.item_id)) {
      item.status = '已报废'
    } else if (repairIds.has(item.item_id)) {
      item.status = '维修中'
    } else if (rentedIds.has(item.item_id)) {
      item.status = '借出中'
    } else {
      item.status = '在库'
    }
  }
}
