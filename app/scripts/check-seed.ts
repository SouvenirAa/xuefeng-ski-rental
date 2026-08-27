/**
 * 种子数据校验脚本（不参与 tsc 编译，由 scripts/validate-seed.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:seed
 *
 * 正向：正确种子必须通过；反向：构造破坏副本，校验器必须拒绝。
 */
import { createSeedDatabase } from '../src/data/seed'
import { validateDatabase } from '../src/data/validate'
import type { Database, RepairOrder } from '../src/data/types'

function clone(db: Database): Database {
  return JSON.parse(JSON.stringify(db)) as Database
}

const db = createSeedDatabase()

// ---------------- 正向 ----------------
const result = validateDatabase(db)
if (!result.ok) {
  console.error('【正向】种子数据校验失败：')
  for (const e of result.errors) console.error('  - ' + e)
  process.exit(1)
}

const activeCount = db.rental_contracts.filter((c) => c.status === '进行中').length
const doneCount = db.rental_contracts.filter((c) => c.status === '已完成').length
const scrapped = db.rental_items.filter((i) => i.status === '已报废').length
console.log('【正向】种子数据校验通过：')
console.log(`  客户 ${db.customers.length} 名、设备 ${db.rental_items.length} 件（已报废 ${scrapped} 件）`)
console.log(`  合同 ${db.rental_contracts.length} 份（进行中 ${activeCount}、已完成 ${doneCount}）`)
console.log(`  维修单 ${db.repair_orders.length} 张、明细 ${db.contract_lines.length} 条、变更 ${db.contract_changes.length} 条`)
console.log('\n15 份合同金额复算：')
for (const c of db.rental_contracts) {
  console.log(`  ${c.contract_no}  ${c.status}  ${c.duration_days}天  ¥${c.total_amount}`)
}

// ---------------- 反向 ----------------
interface BrokenCase {
  name: string
  mutate: (d: Database) => void
}

const cases: BrokenCase[] = [
  {
    name: '错误合同金额',
    mutate: (d) => {
      d.rental_contracts[0].total_amount += 1
    },
  },
  {
    name: '借出早于合同日期',
    mutate: (d) => {
      const c = d.rental_contracts[0]
      const line = d.contract_lines.find((l) => l.contract_id === c.contract_id)
      if (line) line.checkout_time = '2020-01-01T09:00:00'
    },
  },
  {
    name: '归还早于借出',
    mutate: (d) => {
      const line = d.contract_lines.find((l) => l.return_time !== null)
      if (line) line.return_time = '2020-01-01T00:00:00'
    },
  },
  {
    name: 'quantity 不等于 1',
    mutate: (d) => {
      d.contract_lines[0].quantity = 2
    },
  },
  {
    name: '设备同时借出和维修',
    mutate: (d) => {
      const rented = d.rental_items.find((i) => i.status === '借出中')
      if (rented) {
        const extra: RepairOrder = {
          repair_id: 9999,
          item_id: rented.item_id,
          contractor_id: 1,
          rate_id: 1,
          request_date: '2026-08-25',
          fault_description: '破坏用例：借出设备又报修',
          repair_date: null,
          repair_hours: null,
          calculated_cost: null,
          notes: null,
          status: '待维修',
        }
        d.repair_orders.push(extra)
      }
    },
  },
  {
    name: '维修费率不属于所选承包商',
    mutate: (d) => {
      // repair_orders[0] 属于 contractor 1（rate 1/2），改成 contractor 2 的 rate 3
      d.repair_orders[0].rate_id = 3
    },
  },
  {
    name: '换货 amount_delta 与 total_amount 同时增加 1',
    mutate: (d) => {
      const ch = d.contract_changes.find((c) => c.change_group_id !== null && c.amount_delta !== null)
      if (ch) {
        ch.amount_delta = (ch.amount_delta as number) + 1
        const contract = d.rental_contracts.find((c) => c.contract_id === ch.contract_id)
        if (contract) contract.total_amount += 1
      }
    },
  },
  {
    name: '换货 change_date 位于合同有效期外',
    mutate: (d) => {
      const ch = d.contract_changes.find((c) => c.change_group_id !== null)
      if (ch) {
        const gid = ch.change_group_id
        for (const rec of d.contract_changes) {
          if (rec.change_group_id === gid) rec.change_date = '2027-01-01T14:00:00'
        }
      }
    },
  },
  {
    name: '换货组两条记录 change_date 不一致',
    mutate: (d) => {
      const ch = d.contract_changes.find((c) => c.change_group_id !== null)
      if (ch) ch.change_date = '2026-08-15T14:00:00'
    },
  },
  {
    name: '换货组缺少增加记录',
    mutate: (d) => {
      const idx = d.contract_changes.findIndex((c) => c.change_group_id !== null && c.change_type === '增加')
      if (idx >= 0) d.contract_changes.splice(idx, 1)
    },
  },
  {
    name: '换货组包含重复类型',
    mutate: (d) => {
      const add = d.contract_changes.find((c) => c.change_group_id !== null && c.change_type === '增加')
      if (add) add.change_type = '归还'
    },
  },
  {
    name: '换出明细 return_time 与 change_date 不一致',
    mutate: (d) => {
      const ch = d.contract_changes.find((c) => c.change_group_id !== null && c.change_type === '归还')
      if (ch) {
        const line = d.contract_lines.find((l) => l.contract_id === ch.contract_id && l.item_id === ch.item_id)
        if (line) line.return_time = '2026-08-16T15:00:00'
      }
    },
  },
]

let failed = 0
for (const c of cases) {
  const broken = clone(db)
  c.mutate(broken)
  const r = validateDatabase(broken)
  if (r.ok) {
    console.error(`【反向】✗ 用例「${c.name}」未被拒绝（校验器漏检）`)
    failed++
  } else {
    console.log(`【反向】✓ 用例「${c.name}」被正确拒绝（${r.errors.length} 条错误）`)
  }
}

if (failed > 0) {
  console.error(`\n反向校验失败：${failed} 个用例漏检`)
  process.exit(1)
}
console.log(`\n全部校验通过（正向 1 + 反向 ${cases.length}）`)
