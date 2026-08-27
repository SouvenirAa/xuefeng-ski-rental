import type {
  ContractChange,
  ContractLine,
  ContractorRate,
  Database,
  RentalContract,
} from './types'

/** 数据库校验结果 */
export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * 校验数据库完整性：
 * 表结构、主键唯一、外键存在、唯一约束、quantity=1、
 * 合同金额可复算、时间顺序、明细状态与归还字段一致、
 * 维修费率归属、维修成本、维修状态空值规则、排班时间。
 * 种子数据必须通过；localStorage 读取的数据校验失败时进入恢复界面。
 */
export function validateDatabase(db: Database): ValidationResult {
  const errors: string[] = []

  // 1. 主键唯一
  checkUniqueIds(db.accounts, 'account_id', 'account', errors)
  checkUniqueIds(db.skill_levels, 'skill_level_id', 'skill_level', errors)
  checkUniqueIds(db.stores, 'store_id', 'store', errors)
  checkUniqueIds(db.customers, 'customer_id', 'customer', errors)
  checkUniqueIds(db.employees, 'employee_id', 'employee', errors)
  checkUniqueIds(db.rental_items, 'item_id', 'rental_item', errors)
  checkUniqueIds(db.contractors, 'contractor_id', 'contractor', errors)
  checkUniqueIds(db.contractor_rates, 'rate_id', 'contractor_rate', errors)
  checkUniqueIds(db.rental_contracts, 'contract_id', 'rental_contract', errors)
  checkUniqueIds(db.contract_lines, 'contract_line_id', 'contract_line', errors)
  checkUniqueIds(db.contract_changes, 'change_id', 'contract_change', errors)
  checkUniqueIds(db.repair_orders, 'repair_id', 'repair_order', errors)
  checkUniqueIds(db.shifts, 'shift_id', 'shift', errors)

  // 2. 唯一业务键
  checkUniqueValue(db.accounts, (a) => a.username, 'account.username', errors)
  checkUniqueValue(db.rental_items, (i) => i.item_code, 'rental_item.item_code', errors)
  checkUniqueValue(db.rental_contracts, (c) => c.contract_no, 'rental_contract.contract_no', errors)
  checkUniqueValue(
    db.customers.filter((c) => c.email !== null),
    (c) => c.email as string,
    'customer.email',
    errors,
  )
  checkUniqueComposite(
    db.contract_lines,
    (l) => `${l.contract_id}-${l.item_id}`,
    'contract_line (contract_id,item_id)',
    errors,
  )
  checkUniqueComposite(
    db.contractor_rates,
    (r) => `${r.contractor_id}-${r.effective_date}`,
    'contractor_rate (contractor_id,effective_date)',
    errors,
  )
  checkUniqueComposite(
    db.shifts,
    (s) => `${s.employee_id}-${s.work_date}`,
    'shift (employee_id,work_date)',
    errors,
  )

  // 3. 外键存在
  const storeIds = new Set(db.stores.map((s) => s.store_id))
  const employeeIds = new Set(db.employees.map((e) => e.employee_id))
  const contractorIds = new Set(db.contractors.map((c) => c.contractor_id))
  const customerIds = new Set(db.customers.map((c) => c.customer_id))
  const itemIds = new Set(db.rental_items.map((i) => i.item_id))
  const skillIds = new Set(db.skill_levels.map((s) => s.skill_level_id))
  const rateIds = new Set(db.contractor_rates.map((r) => r.rate_id))
  const contractIds = new Set(db.rental_contracts.map((c) => c.contract_id))

  for (const a of db.accounts) {
    if (a.employee_id !== null && !employeeIds.has(a.employee_id)) {
      errors.push(`account ${a.username} 的 employee_id=${a.employee_id} 不存在`)
    }
    if (a.contractor_id !== null && !contractorIds.has(a.contractor_id)) {
      errors.push(`account ${a.username} 的 contractor_id=${a.contractor_id} 不存在`)
    }
  }
  for (const i of db.rental_items) {
    if (i.skill_level_id !== null && !skillIds.has(i.skill_level_id)) {
      errors.push(`rental_item ${i.item_code} 的 skill_level_id 不存在`)
    }
    if (!storeIds.has(i.home_store_id)) errors.push(`rental_item ${i.item_code} 的 home_store_id 不存在`)
    if (!storeIds.has(i.current_store_id)) errors.push(`rental_item ${i.item_code} 的 current_store_id 不存在`)
  }
  for (const r of db.contractor_rates) {
    if (!contractorIds.has(r.contractor_id)) errors.push(`contractor_rate ${r.rate_id} 的 contractor_id 不存在`)
  }
  for (const c of db.rental_contracts) {
    if (!customerIds.has(c.customer_id)) errors.push(`contract ${c.contract_no} 的 customer_id 不存在`)
    if (!employeeIds.has(c.employee_id)) errors.push(`contract ${c.contract_no} 的 employee_id 不存在`)
  }
  for (const l of db.contract_lines) {
    if (!contractIds.has(l.contract_id)) errors.push(`contract_line ${l.contract_line_id} 的 contract_id 不存在`)
    if (!itemIds.has(l.item_id)) errors.push(`contract_line ${l.contract_line_id} 的 item_id 不存在`)
    if (!storeIds.has(l.checkout_store_id)) errors.push(`contract_line ${l.contract_line_id} 的 checkout_store_id 不存在`)
    if (l.return_store_id !== null && !storeIds.has(l.return_store_id)) {
      errors.push(`contract_line ${l.contract_line_id} 的 return_store_id 不存在`)
    }
  }
  for (const ch of db.contract_changes) {
    if (!contractIds.has(ch.contract_id)) errors.push(`contract_change ${ch.change_id} 的 contract_id 不存在`)
    if (ch.item_id !== null && !itemIds.has(ch.item_id)) errors.push(`contract_change ${ch.change_id} 的 item_id 不存在`)
  }
  for (const ro of db.repair_orders) {
    if (!itemIds.has(ro.item_id)) errors.push(`repair_order ${ro.repair_id} 的 item_id 不存在`)
    if (!contractorIds.has(ro.contractor_id)) errors.push(`repair_order ${ro.repair_id} 的 contractor_id 不存在`)
    if (!rateIds.has(ro.rate_id)) errors.push(`repair_order ${ro.repair_id} 的 rate_id 不存在`)
  }
  for (const s of db.shifts) {
    if (!employeeIds.has(s.employee_id)) errors.push(`shift ${s.shift_id} 的 employee_id 不存在`)
    if (!storeIds.has(s.store_id)) errors.push(`shift ${s.shift_id} 的 store_id 不存在`)
  }

  // 4. quantity 恒为 1
  for (const l of db.contract_lines) {
    if (l.quantity !== 1) errors.push(`contract_line ${l.contract_line_id} quantity=${l.quantity} 必须为 1`)
  }
  for (const ch of db.contract_changes) {
    if (ch.quantity !== 1) errors.push(`contract_change ${ch.change_id} quantity=${ch.quantity} 必须为 1`)
  }

  // 5. 合同完成状态一致性
  for (const c of db.rental_contracts) {
    if (c.status === '已完成' && c.completed_at === null) {
      errors.push(`contract ${c.contract_no} 已完成但 completed_at 为空`)
    }
    if (c.status === '进行中' && c.completed_at !== null) {
      errors.push(`contract ${c.contract_no} 进行中但 completed_at 非空`)
    }
  }

  // 6. 合同金额可复算、时间顺序、明细状态一致性
  validateContracts(db, errors)

  // 7. 维修单费率归属、成本、空值规则
  validateRepairs(db, errors)

  // 8. 排班时间
  for (const s of db.shifts) {
    if (s.start_time >= s.end_time) {
      errors.push(`shift ${s.shift_id} start_time(${s.start_time}) 不小于 end_time(${s.end_time})`)
    }
  }

  // 9. 设备租赁/维修状态一致性
  validateItemStatusConsistency(db, errors)

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// 合同金额、时间、明细状态
// ---------------------------------------------------------------------------
function validateContracts(db: Database, errors: string[]): void {
  const contractById = new Map<number, RentalContract>(
    db.rental_contracts.map((c) => [c.contract_id, c]),
  )
  const linesByContract = new Map<number, ContractLine[]>()
  for (const l of db.contract_lines) {
    const arr = linesByContract.get(l.contract_id) ?? []
    arr.push(l)
    linesByContract.set(l.contract_id, arr)
  }
  const changesByContract = new Map<number, ContractChange[]>()
  for (const ch of db.contract_changes) {
    const arr = changesByContract.get(ch.contract_id) ?? []
    arr.push(ch)
    changesByContract.set(ch.contract_id, arr)
  }

  // 换货变更按 change_group_id 分组（仅非空分组）
  const groupById = new Map<number, ContractChange[]>()
  for (const ch of db.contract_changes) {
    if (ch.change_group_id === null) continue
    const arr = groupById.get(ch.change_group_id) ?? []
    arr.push(ch)
    groupById.set(ch.change_group_id, arr)
  }

  // 校验每个换货组并独立复算差价（不使用 total_amount 反推 amount_delta）
  const deltaByContract = new Map<number, number>()
  for (const [gid, group] of groupById) {
    const delta = validateExchangeGroup(gid, group, contractById, linesByContract, errors)
    if (delta !== null) {
      const cid = group[0].contract_id
      deltaByContract.set(cid, (deltaByContract.get(cid) ?? 0) + delta)
    }
  }

  for (const c of db.rental_contracts) {
    const lines = linesByContract.get(c.contract_id) ?? []
    const changes = changesByContract.get(c.contract_id) ?? []

    // 换入的 item（change_type='增加'）
    const exchangedIn = new Set(
      changes.filter((ch) => ch.change_type === '增加' && ch.item_id !== null).map((ch) => ch.item_id as number),
    )
    // 初始金额 = 排除换入明细后的 Σ(rate × quantity × days)
    const initial = lines
      .filter((l) => !exchangedIn.has(l.item_id))
      .reduce((sum, l) => sum + l.daily_rate * l.quantity * c.duration_days, 0)

    const expected = initial + (deltaByContract.get(c.contract_id) ?? 0)
    if (Math.abs(c.total_amount - expected) > 0.005) {
      errors.push(`contract ${c.contract_no} total_amount=${c.total_amount} 应为 ${expected}`)
    }

    // 时间顺序与明细状态
    for (const l of lines) {
      if (l.checkout_time < c.contract_date) {
        errors.push(`contract_line ${l.contract_line_id} checkout_time 早于 contract_date`)
      }
      if (l.return_time !== null && l.return_time <= l.checkout_time) {
        errors.push(`contract_line ${l.contract_line_id} return_time 不晚于 checkout_time`)
      }
      if (c.completed_at !== null && l.return_time !== null && l.return_time > c.completed_at) {
        errors.push(`contract_line ${l.contract_line_id} return_time 晚于 completed_at`)
      }

      // 明细状态与归还字段一致
      if (l.status === '借出中') {
        if (l.return_time !== null || l.return_store_id !== null) {
          errors.push(`contract_line ${l.contract_line_id} 借出中但 return 字段非空`)
        }
      } else {
        if (l.return_time === null || l.return_store_id === null) {
          errors.push(`contract_line ${l.contract_line_id} ${l.status} 但 return 字段为空`)
        }
      }
    }

    // 已完成合同不得有借出中明细
    if (c.status === '已完成') {
      for (const l of lines) {
        if (l.status === '借出中') {
          errors.push(`contract ${c.contract_no} 已完成但存在借出中明细`)
        }
      }
    }
  }
}

/**
 * 校验单个换货变更组并独立复算差价（BR-08）。
 * 返回该组复算的 amount_delta；结构/时间/金额非法时返回 null（错误已记录）。
 */
function validateExchangeGroup(
  gid: number,
  group: ContractChange[],
  contractById: Map<number, RentalContract>,
  linesByContract: Map<number, ContractLine[]>,
  errors: string[],
): number | null {
  // 1. 结构：恰好两条，且一条归还 + 一条增加
  if (group.length !== 2) {
    errors.push(`换货组 ${gid} 应恰好包含 2 条记录，实际 ${group.length} 条`)
    return null
  }
  const returnRec = group.find((ch) => ch.change_type === '归还')
  const addRec = group.find((ch) => ch.change_type === '增加')
  if (!returnRec || !addRec) {
    errors.push(`换货组 ${gid} 应恰好包含一条归还、一条增加记录`)
    return null
  }
  if (returnRec.contract_id !== addRec.contract_id) {
    errors.push(`换货组 ${gid} 两条记录 contract_id 不一致`)
    return null
  }
  if (returnRec.change_date !== addRec.change_date) {
    errors.push(`换货组 ${gid} 两条记录 change_date 不一致`)
    return null
  }
  if (returnRec.item_id === null || addRec.item_id === null) {
    errors.push(`换货组 ${gid} 的 item_id 不得为空`)
    return null
  }
  if (returnRec.quantity !== 1 || addRec.quantity !== 1) {
    errors.push(`换货组 ${gid} 的 quantity 必须为 1`)
    return null
  }
  const nonNullDelta = group.filter((ch) => ch.amount_delta !== null)
  if (nonNullDelta.length !== 1) {
    errors.push(`换货组 ${gid} 应恰好有一条 amount_delta 非空，实际 ${nonNullDelta.length} 条`)
    return null
  }

  // 2. 时间：change_date 位于合同有效期内（duration_days 含合同当天）
  const contract = contractById.get(returnRec.contract_id)
  if (!contract) return null
  const elapsedDays = dateDiffDays(contract.contract_date, returnRec.change_date)
  if (elapsedDays < 0) {
    errors.push(`换货组 ${gid} change_date 早于 contract_date`)
    return null
  }
  const remainingDays = contract.duration_days - elapsedDays
  if (remainingDays <= 0) {
    errors.push(`换货组 ${gid} change_date 超出合同有效期（remainingDays=${remainingDays}）`)
    return null
  }

  // 换出/换入物品须对应到同一合同的明细
  const lines = linesByContract.get(returnRec.contract_id) ?? []
  const outLine = lines.find((l) => l.item_id === returnRec.item_id)
  const inLine = lines.find((l) => l.item_id === addRec.item_id)
  if (!outLine) {
    errors.push(`换货组 ${gid} 换出 item ${returnRec.item_id} 未在合同明细中`)
    return null
  }
  if (!inLine) {
    errors.push(`换货组 ${gid} 换入 item ${addRec.item_id} 未在合同明细中`)
    return null
  }
  if (outLine.return_time !== returnRec.change_date) {
    errors.push(`换货组 ${gid} 换出明细 return_time 应等于 change_date`)
    return null
  }
  if (inLine.checkout_time !== addRec.change_date) {
    errors.push(`换货组 ${gid} 换入明细 checkout_time 应等于 change_date`)
    return null
  }

  // 3. 独立复算 BR-08：amount_delta = (换入日租金 − 换出日租金) × 剩余天数
  const expectedDelta = (inLine.daily_rate - outLine.daily_rate) * remainingDays
  const actualDelta = nonNullDelta[0].amount_delta as number
  if (Math.abs(actualDelta - expectedDelta) > 0.005) {
    errors.push(`换货组 ${gid} amount_delta=${actualDelta} 应为 ${expectedDelta}`)
    return null
  }

  return expectedDelta
}

/** 自然日差：to − from（取日期部分，UTC 基准，避免本地时区影响） */
function dateDiffDays(from: string, to: string): number {
  const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`)
  return Math.round((parse(to) - parse(from)) / 86400000)
}

// ---------------------------------------------------------------------------
// 维修单：费率归属、成本、状态空值规则
// ---------------------------------------------------------------------------
function validateRepairs(db: Database, errors: string[]): void {
  const rateById = new Map<number, ContractorRate>(db.contractor_rates.map((r) => [r.rate_id, r]))
  const rateIdsByContractor = new Map<number, Set<number>>()
  for (const r of db.contractor_rates) {
    const s = rateIdsByContractor.get(r.contractor_id) ?? new Set<number>()
    s.add(r.rate_id)
    rateIdsByContractor.set(r.contractor_id, s)
  }

  for (const ro of db.repair_orders) {
    // rate_id 属于 contractor_id
    const rates = rateIdsByContractor.get(ro.contractor_id)
    if (!rates || !rates.has(ro.rate_id)) {
      errors.push(`repair_order ${ro.repair_id} rate_id=${ro.rate_id} 不属于 contractor_id=${ro.contractor_id}`)
    }

    // 状态空值规则
    if (ro.status === '已完成') {
      if (ro.repair_date === null || ro.repair_hours === null || ro.calculated_cost === null) {
        errors.push(`repair_order ${ro.repair_id} 已完成但 repair_date/hours/cost 有空值`)
      }
      // 成本 = repair_hours × hourly_rate
      const rate = rateById.get(ro.rate_id)
      if (rate && ro.repair_hours !== null && ro.calculated_cost !== null) {
        const expected = ro.repair_hours * rate.hourly_rate
        if (Math.abs(ro.calculated_cost - expected) > 0.005) {
          errors.push(`repair_order ${ro.repair_id} calculated_cost=${ro.calculated_cost} 应为 ${expected}`)
        }
      }
      if (ro.repair_date !== null && ro.repair_date < ro.request_date) {
        errors.push(`repair_order ${ro.repair_id} repair_date 早于 request_date`)
      }
    } else {
      if (ro.repair_date !== null || ro.repair_hours !== null || ro.calculated_cost !== null) {
        errors.push(`repair_order ${ro.repair_id} ${ro.status} 但 repair_date/hours/cost 非空`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 设备租赁/维修状态一致性
// ---------------------------------------------------------------------------
function validateItemStatusConsistency(db: Database, errors: string[]): void {
  const activeContractIds = new Set(
    db.rental_contracts.filter((c) => c.status === '进行中').map((c) => c.contract_id),
  )
  const activeRentedLines = db.contract_lines.filter(
    (l) => activeContractIds.has(l.contract_id) && l.status === '借出中',
  )
  const rentedItemIds = new Set(activeRentedLines.map((l) => l.item_id))

  // 同一设备不能出现在多份进行中合同的借出明细
  const rentedCount = new Map<number, number>()
  for (const l of activeRentedLines) {
    rentedCount.set(l.item_id, (rentedCount.get(l.item_id) ?? 0) + 1)
  }
  for (const [itemId, count] of rentedCount) {
    if (count > 1) {
      errors.push(`设备 ${itemId} 出现在 ${count} 份进行中合同的借出明细`)
    }
  }

  const inRepairItemIds = new Set(
    db.repair_orders
      .filter((r) => r.status === '待维修' || r.status === '维修中')
      .map((r) => r.item_id),
  )
  const repairedItemIds = new Set(
    db.repair_orders.filter((r) => r.status === '已完成').map((r) => r.item_id),
  )

  for (const item of db.rental_items) {
    const isRented = rentedItemIds.has(item.item_id)
    const isInRepair = inRepairItemIds.has(item.item_id)

    if (isRented && isInRepair) {
      errors.push(`设备 ${item.item_code} 同时处于借出中与维修中`)
    }
    if (item.status === '已报废' && (isRented || isInRepair)) {
      errors.push(`设备 ${item.item_code} 已报废却仍处于借出/维修`)
    }
    if (item.status === '借出中' && !isRented) {
      errors.push(`设备 ${item.item_code} 状态为借出中，但没有进行中合同的借出明细`)
    }
    if (item.status === '维修中' && !isInRepair) {
      errors.push(`设备 ${item.item_code} 状态为维修中，但没有待维修/维修中的维修单`)
    }
    if (isRented && item.status !== '借出中') {
      errors.push(`设备 ${item.item_code} 有进行中借出明细，但状态不是借出中`)
    }
    if (isInRepair && item.status !== '维修中') {
      errors.push(`设备 ${item.item_code} 有待维修/维修中的维修单，但状态不是维修中`)
    }
    if (repairedItemIds.has(item.item_id) && !isInRepair && item.status === '维修中') {
      errors.push(`设备 ${item.item_code} 的维修单已完成，但仍保持维修中`)
    }
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function checkUniqueIds<T extends { [K in KId]: number }, KId extends string>(
  rows: T[],
  key: KId,
  table: string,
  errors: string[],
): void {
  const seen = new Set<number>()
  for (const row of rows) {
    if (seen.has(row[key])) {
      errors.push(`${table} 主键 ${key}=${row[key]} 重复`)
    }
    seen.add(row[key])
  }
}

function checkUniqueValue<T>(rows: T[], key: (row: T) => string, label: string, errors: string[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    const v = key(row)
    if (seen.has(v)) {
      errors.push(`${label}=${v} 重复`)
    }
    seen.add(v)
  }
}

function checkUniqueComposite<T>(rows: T[], key: (row: T) => string, label: string, errors: string[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    const v = key(row)
    if (seen.has(v)) {
      errors.push(`${label}=${v} 重复`)
    }
    seen.add(v)
  }
}
