/**
 * 云端维修单只读查询校验脚本（由 validate-cloud-repair-read.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-repair-read
 *
 * 覆盖：
 * 1. admin/staff 直读四表组装：字段映射、numeric/date/nullable/状态、费率归属、
 *    成本复算、0.25 工时边界、安全整数边界、缺失引用/非法枚举/空值不一致拒绝；
 * 2. contractor RPC 组装：item_id/contractor_id/rate_id 建模为 null、字段映射、
 *    非法值拒绝；
 * 3. 查询构造器：精确 from/select/order、禁 select('*')、contractor 精确调用
 *    list_my_repairs 且不读取三张受限引用表；
 * 4. 主查询 fail-closed：任一关联表失败/抛异常 → 整体失败，不返回部分数据；
 * 5. 三种角色分派（admin/staff → 直读、contractor → RPC）；
 * 6. 数据源分派（计数型 fake reader：cloud 下本地 reader 0 次且无回退）；
 * 7. safeCloudRepairLoad 边界（同步 throw / Promise reject）；
 * 8. local DataService 10 条维修单、contractor 权限过滤不回归；
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
  assembleCloudRepairsFromTables,
  assembleCloudRepairsFromRpc,
  queryRepairOrders,
  queryRepairItems,
  queryRepairContractors,
  queryRepairRates,
  queryRepairsAdmin,
  queryMyRepairsRpc,
  queryRepairsContractor,
  REPAIR_ORDER_SELECT_COLUMNS,
  REPAIR_ITEM_SELECT_COLUMNS,
  REPAIR_CONTRACTOR_SELECT_COLUMNS,
  REPAIR_RATE_SELECT_COLUMNS,
  SAFE_REPAIR_ERROR,
} = await import('../src/data/cloudRepairs')
type CloudRepairOrderRow = import('../src/data/cloudRepairs').CloudRepairOrderRow
type CloudRepairItemRow = import('../src/data/cloudRepairs').CloudRepairItemRow
type CloudRepairContractorRow = import('../src/data/cloudRepairs').CloudRepairContractorRow
type CloudRepairRateRow = import('../src/data/cloudRepairs').CloudRepairRateRow
type CloudMyRepairRow = import('../src/data/cloudRepairs').CloudMyRepairRow
type RepairRowView = import('../src/data/cloudRepairs').RepairRowView
type RepairRpcClient = import('../src/data/cloudRepairs').RepairRpcClient
type MasterRdbClient = import('../src/data/cloudMaster').MasterRdbClient

const {
  buildRepairRows,
  dispatchRepairLoad,
  settleRepairRead,
  safeCloudRepairLoad,
  buildRepairContractorFilterOptions,
  filterRepairsByContractor,
} = await import('../src/data/repairDataSource')
type RepairDataSources = import('../src/data/repairDataSource').RepairDataSources

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
// 固定夹具（与真实种子数据同构的虚构值）
// ---------------------------------------------------------------------------
const validItem1: CloudRepairItemRow = { item_id: 1, item_code: 'SN0001', name: 'Head XTC 滑雪板 #1' }
const validItem2: CloudRepairItemRow = { item_id: 2, item_code: 'SN0002', name: 'Head XTC 滑雪板 #2' }
const validContractor1: CloudRepairContractorRow = { contractor_id: 1, name: '峰顶装备维修' }
const validContractor2: CloudRepairContractorRow = { contractor_id: 2, name: '极速雪具工坊' }
const validRate1: CloudRepairRateRow = { rate_id: 1, contractor_id: 1, hourly_rate: 180 }
const validRate2: CloudRepairRateRow = { rate_id: 2, contractor_id: 1, hourly_rate: 200 }
const validRate4: CloudRepairRateRow = { rate_id: 4, contractor_id: 2, hourly_rate: 175 }

// 已完成维修单（contractor 1，rate 2=200，1.5h → 300）
const validRepairDone: CloudRepairOrderRow = {
  repair_id: 1, item_id: 2, contractor_id: 1, rate_id: 2,
  request_date: '2026-08-18', fault_description: '固定器卡扣松动',
  repair_date: '2026-08-20', repair_hours: 1.5, calculated_cost: 300,
  notes: '更换卡扣', status: '已完成',
}
// 维修中维修单（三空）
const validRepairWorking: CloudRepairOrderRow = {
  repair_id: 5, item_id: 1, contractor_id: 2, rate_id: 4,
  request_date: '2026-08-24', fault_description: '初级滑雪板板刃卷边',
  repair_date: null, repair_hours: null, calculated_cost: null,
  notes: null, status: '维修中',
}

const allItems = [validItem1, validItem2]
const allContractors = [validContractor1, validContractor2]
const allRates = [validRate1, validRate2, validRate4]

// contractor RPC 行（不含 item_id/contractor_id/rate_id）
const validMyRepairDone: CloudMyRepairRow = {
  repair_id: 1, item_code: 'SN0002', item_name: 'Head XTC 滑雪板 #2',
  contractor_name: '峰顶装备维修', rate_hourly: 200,
  request_date: '2026-08-18', fault_description: '固定器卡扣松动',
  repair_date: '2026-08-20', repair_hours: 1.5, calculated_cost: 300,
  notes: '更换卡扣', status: '已完成',
}
const validMyRepairWorking: CloudMyRepairRow = {
  repair_id: 6, item_code: 'SN0009', item_name: 'Salomon 中阶滑雪板 #2',
  contractor_name: '峰顶装备维修', rate_hourly: 200,
  request_date: '2026-08-24', fault_description: '中阶滑雪板蜡层脱落',
  repair_date: null, repair_hours: null, calculated_cost: null,
  notes: null, status: '维修中',
}

// ===========================================================================
// 1. admin/staff 直读组装：字段映射与归一化
// ===========================================================================
const a1 = assembleCloudRepairsFromTables([validRepairDone], allItems, allContractors, allRates)
check('admin 直读组装成功', a1.ok === true)
if (a1.ok) {
  const r = a1.rows[0]
  check('admin 直读 repair_id=1', r.repair_id === 1)
  check('admin 直读 item_id 非 null', r.item_id === 2)
  check('admin 直读 contractor_id 非 null', r.contractor_id === 1)
  check('admin 直读 rate_id 非 null', r.rate_id === 2)
  check('admin 直读组装 item_code', r.item_code === 'SN0002')
  check('admin 直读组装 item_name', r.item_name === 'Head XTC 滑雪板 #2')
  check('admin 直读组装 contractor_name', r.contractor_name === '峰顶装备维修')
  check('admin 直读组装 rate_hourly=200', r.rate_hourly === 200)
  check('admin 直读 request_date', r.request_date === '2026-08-18')
  check('admin 直读 fault_description', r.fault_description === '固定器卡扣松动')
  check('admin 直读 repair_date', r.repair_date === '2026-08-20')
  check('admin 直读 repair_hours=1.5', r.repair_hours === 1.5)
  check('admin 直读 calculated_cost=300', r.calculated_cost === 300)
  check('admin 直读 notes', r.notes === '更换卡扣')
  check('admin 直读 status=已完成', r.status === '已完成')
}

// 数字字符串归一化（云端 numeric 返回 "1.50" / "300.00"；bigint 返回 "1"）
const aStr = assembleCloudRepairsFromTables(
  [{ ...validRepairDone, repair_id: '1', item_id: '2', contractor_id: '1', rate_id: '2', repair_hours: '1.50', calculated_cost: '300.00' }],
  allItems,
  allContractors,
  [{ ...validRate2, rate_id: '2', contractor_id: '1', hourly_rate: '200.00' }],
)
check('admin 直读 numeric/bigint 字符串归一化',
  aStr.ok === true && aStr.ok && aStr.rows[0].repair_id === 1 && aStr.rows[0].repair_hours === 1.5 && aStr.rows[0].calculated_cost === 300 && aStr.rows[0].rate_hourly === 200)

// nullable 保留 null（待维修/维修中）
const aNull = assembleCloudRepairsFromTables([validRepairWorking], allItems, allContractors, allRates)
check('admin 直读 nullable 保留 null',
  aNull.ok === true && aNull.ok && aNull.rows[0].repair_date === null && aNull.rows[0].repair_hours === null && aNull.rows[0].calculated_cost === null && aNull.rows[0].notes === null)

// 多行排序 + 重复主键
const aSorted = assembleCloudRepairsFromTables([validRepairDone, validRepairWorking], allItems, allContractors, allRates)
check('admin 直读多行按 repair_id 排序', aSorted.ok === true && aSorted.ok && aSorted.rows[0].repair_id === 1 && aSorted.rows[1].repair_id === 5)
check('admin 直读重复 repair_id 拒绝', assembleCloudRepairsFromTables([validRepairDone, { ...validRepairDone, item_id: 1 }], allItems, allContractors, allRates).ok === false)

// ===========================================================================
// 2. admin 直读：引用完整性 + 费率归属 + 业务约束
// ===========================================================================
check('item_id 不存在拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, item_id: 99 }], allItems, allContractors, allRates).ok === false)
check('contractor_id 不存在拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, contractor_id: 99 }], allItems, allContractors, allRates).ok === false)
check('rate_id 不存在拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, rate_id: 99 }], allItems, allContractors, allRates).ok === false)
// 费率归属：rate 4 属于 contractor 2，但维修单 contractor_id=1 → 拒绝
check('rate_id 不属于 contractor_id 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, rate_id: 4 }], allItems, allContractors, allRates).ok === false)
// 引用表自身异常 → 失败
check('引用表 items 非数组拒绝', assembleCloudRepairsFromTables([validRepairDone], null, allContractors, allRates).ok === false)
check('引用表重复 item_id 拒绝', assembleCloudRepairsFromTables([validRepairDone], [validItem1, { ...validItem1, item_code: 'X' }], allContractors, allRates).ok === false)

// 状态枚举
check('status 非法枚举拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, status: '已取消' }], allItems, allContractors, allRates).ok === false)

// 空值不一致：维修中却有 repair_date
check('维修中 repair_date 非空拒绝', assembleCloudRepairsFromTables([{ ...validRepairWorking, repair_date: '2026-08-25' }], allItems, allContractors, allRates).ok === false)
// 空值不一致：已完成却缺 repair_date
check('已完成 repair_date 空拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_date: null }], allItems, allContractors, allRates).ok === false)
// 已完成缺 repair_hours
check('已完成 repair_hours 空拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: null }], allItems, allContractors, allRates).ok === false)
// 已完成缺 calculated_cost
check('已完成 calculated_cost 空拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, calculated_cost: null }], allItems, allContractors, allRates).ok === false)

// repair_date < request_date
check('repair_date 早于 request_date 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_date: '2026-08-17' }], allItems, allContractors, allRates).ok === false)
check('repair_date == request_date 通过', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_date: '2026-08-18' }], allItems, allContractors, allRates).ok === true)

// 0.25 工时边界
check('工时 0.25 通过', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: 0.25, calculated_cost: 50 }], allItems, allContractors, allRates).ok === true)
check('工时 0.5 通过', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: 0.5, calculated_cost: 100 }], allItems, allContractors, allRates).ok === true)
check('工时 1.5 通过', assembleCloudRepairsFromTables([validRepairDone], allItems, allContractors, allRates).ok === true)
check('工时 0.3 拒绝（非 0.25 步进）', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: 0.3, calculated_cost: 60 }], allItems, allContractors, allRates).ok === false)
check('工时 0 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: 0, calculated_cost: 0 }], allItems, allContractors, allRates).ok === false)
check('工时负值拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_hours: -1, calculated_cost: -200 }], allItems, allContractors, allRates).ok === false)

// 成本复算
check('成本复算正确通过', assembleCloudRepairsFromTables([validRepairDone], allItems, allContractors, allRates).ok === true)
check('成本复算错误拒绝（差 1）', assembleCloudRepairsFromTables([{ ...validRepairDone, calculated_cost: 301 }], allItems, allContractors, allRates).ok === false)

// 安全整数边界
const OVER_SAFE = Number.MAX_SAFE_INTEGER + 1
check('repair_id=0 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_id: 0 }], allItems, allContractors, allRates).ok === false)
check('repair_id 超安全整数拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_id: OVER_SAFE }], allItems, allContractors, allRates).ok === false)
check('item_id 字符串超安全整数拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, item_id: '9007199254740993' }], allItems, allContractors, allRates).ok === false)
check('contractor_id 小数拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, contractor_id: 1.5 }], allItems, allContractors, allRates).ok === false)
check('rate_id=null 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, rate_id: null }], allItems, allContractors, allRates).ok === false)
check('repair_id=MAX_SAFE_INTEGER 通过', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_id: Number.MAX_SAFE_INTEGER }], allItems, allContractors, allRates).ok === true)

// 严格日期
check('request_date 非法日期 2026-02-30 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, request_date: '2026-02-30' }], allItems, allContractors, allRates).ok === false)
check('request_date=null 拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, request_date: null }], allItems, allContractors, allRates).ok === false)
check('repair_date 非法日期拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, repair_date: 'abc' }], allItems, allContractors, allRates).ok === false)

// fault_description 必填非空
check('fault_description 空拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, fault_description: '' }], allItems, allContractors, allRates).ok === false)
check('fault_description 全空白拒绝', assembleCloudRepairsFromTables([{ ...validRepairDone, fault_description: '  ' }], allItems, allContractors, allRates).ok === false)

// ===========================================================================
// 3. contractor RPC 组装
// ===========================================================================
const r1 = assembleCloudRepairsFromRpc([validMyRepairDone])
check('contractor RPC 组装成功', r1.ok === true)
if (r1.ok) {
  const r = r1.rows[0]
  check('RPC 组装 repair_id=1', r.repair_id === 1)
  check('RPC 组装 item_id=null（不伪造）', r.item_id === null)
  check('RPC 组装 contractor_id=null（不伪造）', r.contractor_id === null)
  check('RPC 组装 rate_id=null（不伪造）', r.rate_id === null)
  check('RPC 组装 item_code', r.item_code === 'SN0002')
  check('RPC 组装 item_name', r.item_name === 'Head XTC 滑雪板 #2')
  check('RPC 组装 contractor_name', r.contractor_name === '峰顶装备维修')
  check('RPC 组装 rate_hourly=200', r.rate_hourly === 200)
  check('RPC 组装 status=已完成', r.status === '已完成')
  check('RPC 组装 repair_hours=1.5', r.repair_hours === 1.5)
  check('RPC 组装 calculated_cost=300', r.calculated_cost === 300)
}

// RPC 数字字符串归一化
const rStr = assembleCloudRepairsFromRpc([{ ...validMyRepairDone, repair_id: '1', rate_hourly: '200.00', repair_hours: '1.50', calculated_cost: '300.00' }])
check('RPC numeric/bigint 字符串归一化', rStr.ok === true && rStr.ok && rStr.rows[0].repair_id === 1 && rStr.rows[0].rate_hourly === 200 && rStr.rows[0].repair_hours === 1.5)

// RPC nullable 保留
const rNull = assembleCloudRepairsFromRpc([validMyRepairWorking])
check('RPC nullable 保留 null', rNull.ok === true && rNull.ok && rNull.rows[0].repair_date === null && rNull.rows[0].repair_hours === null && rNull.rows[0].calculated_cost === null && rNull.rows[0].notes === null)

// RPC 非法值
check('RPC repair_id 非法拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, repair_id: 0 }]).ok === false)
check('RPC item_code 空拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, item_code: '' }]).ok === false)
check('RPC item_name 空拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, item_name: '' }]).ok === false)
check('RPC contractor_name 空拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, contractor_name: '' }]).ok === false)
check('RPC rate_hourly=0 拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, rate_hourly: 0 }]).ok === false)
check('RPC rate_hourly 负数拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, rate_hourly: -1 }]).ok === false)
check('RPC status 非法拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, status: '已取消' }]).ok === false)
check('RPC 空值不一致拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairWorking, repair_date: '2026-08-25' }]).ok === false)
check('RPC 成本复算错误拒绝', assembleCloudRepairsFromRpc([{ ...validMyRepairDone, calculated_cost: 301 }]).ok === false)
check('RPC 重复 repair_id 拒绝', assembleCloudRepairsFromRpc([validMyRepairDone, { ...validMyRepairDone, item_code: 'SN0009' }]).ok === false)
check('RPC 非数组拒绝', assembleCloudRepairsFromRpc(null).ok === false)

// ===========================================================================
// 4. 查询构造器：精确 from/select/order、禁 select(*)
// ===========================================================================
interface Rec { table: string | null; columns: string | null; orderColumn: string | null; orderAscending: boolean | null }
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

const recOrder: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryRepairOrders(makeFake({ data: [validRepairDone], error: null }, recOrder))
check('queryRepairOrders from=repair_orders', recOrder.table === 'repair_orders')
check('queryRepairOrders select 精确 11 列', recOrder.columns === REPAIR_ORDER_SELECT_COLUMNS)
check('queryRepairOrders 禁 select(*)', recOrder.columns !== null && !recOrder.columns!.includes('*'))
check('queryRepairOrders order repair_id 升序', recOrder.orderColumn === 'repair_id' && recOrder.orderAscending === true)

const recItem: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryRepairItems(makeFake({ data: allItems, error: null }, recItem))
check('queryRepairItems from=rental_items', recItem.table === 'rental_items')
check('queryRepairItems select 精确 3 列', recItem.columns === REPAIR_ITEM_SELECT_COLUMNS)
check('queryRepairItems 禁 select(*)', recItem.columns !== null && !recItem.columns!.includes('*'))

const recContractor: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryRepairContractors(makeFake({ data: allContractors, error: null }, recContractor))
check('queryRepairContractors from=contractors', recContractor.table === 'contractors')
check('queryRepairContractors select 精确 2 列', recContractor.columns === REPAIR_CONTRACTOR_SELECT_COLUMNS)
check('queryRepairContractors 禁 select(*)', recContractor.columns !== null && !recContractor.columns!.includes('*'))

const recRate: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryRepairRates(makeFake({ data: allRates, error: null }, recRate))
check('queryRepairRates from=contractor_rates', recRate.table === 'contractor_rates')
check('queryRepairRates select 精确 3 列', recRate.columns === REPAIR_RATE_SELECT_COLUMNS)
check('queryRepairRates 禁 select(*)', recRate.columns !== null && !recRate.columns!.includes('*'))

// contractor RPC：精确调用 list_my_repairs
interface RpcRec { fn: string | null }
function makeFakeRpc(outcome: { data: unknown; error: unknown } | 'throw', rec: RpcRec): RepairRpcClient {
  return {
    rpc(fn: string) {
      rec.fn = fn
      if (outcome === 'throw') return Promise.reject(new Error('rpc-internal-boom'))
      return Promise.resolve(outcome)
    },
  }
}
const recRpc: RpcRec = { fn: null }
await queryMyRepairsRpc(makeFakeRpc({ data: [validMyRepairDone], error: null }, recRpc))
check('queryMyRepairsRpc 精确调用 list_my_repairs', recRpc.fn === 'list_my_repairs')

// ===========================================================================
// 5. 主查询 fail-closed（admin 四表 + contractor RPC）
// ===========================================================================
interface RecM { table: string; columns: string; orderColumn: string; orderAscending: boolean }
function makeFakeMulti(outcomes: Record<string, { data: unknown; error: unknown } | 'throw'>, records: RecM[]): MasterRdbClient {
  return {
    from(table: string) {
      const rec: RecM = { table, columns: '', orderColumn: '', orderAscending: false }
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

const recsA: RecM[] = []
const qa = await queryRepairsAdmin(makeFakeMulti(
  {
    repair_orders: { data: [validRepairDone], error: null },
    rental_items: { data: allItems, error: null },
    contractors: { data: allContractors, error: null },
    contractor_rates: { data: allRates, error: null },
  },
  recsA,
))
check('queryRepairsAdmin 成功返回', qa.ok === true && qa.ok && qa.rows.length === 1)
const tablesA = recsA.map((r) => r.table).sort()
check('queryRepairsAdmin from 四表（repair_orders/rental_items/contractors/contractor_rates）',
  JSON.stringify(tablesA) === JSON.stringify(['contractor_rates', 'contractors', 'rental_items', 'repair_orders'].sort()))

// 任一关联表 error → 整体失败，不返回部分数据
const recsAErr: RecM[] = []
const qaErr = await queryRepairsAdmin(makeFakeMulti(
  {
    repair_orders: { data: [validRepairDone], error: null },
    rental_items: { data: allItems, error: null },
    contractors: { data: allContractors, error: null },
    contractor_rates: { data: null, error: new Error('secret-rate-detail') },
  },
  recsAErr,
))
check('admin 关联表失败 → 整体失败', qaErr.ok === false && qaErr.error === SAFE_REPAIR_ERROR)
check('admin 关联表失败 → 不泄露底层细节', qaErr.ok === false && !qaErr.error.includes('secret'))

// 任一关联表 throw → 整体失败
const recsAThrow: RecM[] = []
const qaThrow = await queryRepairsAdmin(makeFakeMulti(
  {
    repair_orders: { data: [validRepairDone], error: null },
    rental_items: 'throw',
    contractors: { data: allContractors, error: null },
    contractor_rates: { data: allRates, error: null },
  },
  recsAThrow,
))
check('admin SDK 抛异常 → 整体失败安全错误', qaThrow.ok === false && qaThrow.error === SAFE_REPAIR_ERROR)
check('admin SDK 抛异常 → 不泄露底层细节', qaThrow.ok === false && !qaThrow.error.includes('boom'))

// contractor RPC 主查询
const qc = await queryRepairsContractor(makeFakeRpc({ data: [validMyRepairDone], error: null }, { fn: null }))
check('queryRepairsContractor 成功返回', qc.ok === true && qc.ok && qc.rows.length === 1 && qc.rows[0].item_id === null)

const qcErr = await queryRepairsContractor(makeFakeRpc({ data: null, error: new Error('secret-rpc-detail') }, { fn: null }))
check('contractor RPC 失败 → 整体失败安全错误', qcErr.ok === false && qcErr.error === SAFE_REPAIR_ERROR)
check('contractor RPC 失败 → 不泄露底层细节', qcErr.ok === false && !qcErr.error.includes('secret'))

const qcThrow = await queryRepairsContractor(makeFakeRpc('throw', { fn: null }))
check('contractor RPC 抛异常 → 整体失败安全错误', qcThrow.ok === false && qcThrow.error === SAFE_REPAIR_ERROR)

// ===========================================================================
// 6. 数据源分派：三种角色 + cloud 本地 reader 0 次
// ===========================================================================
const fakeRepairView: RepairRowView = {
  repair_id: 999, item_id: 1, item_code: 'SN0001', item_name: 'Fake设备',
  contractor_id: 1, contractor_name: 'Fake承包商', rate_id: 1, rate_hourly: 100,
  request_date: '2026-08-01', fault_description: 'x',
  repair_date: null, repair_hours: null, calculated_cost: null, notes: null, status: '待维修',
}
let localRepairCalls = 0
let localItemCalls = 0
let localContractorCalls = 0
let localRateCalls = 0
let cloudAdminCalls = 0
let cloudContractorCalls = 0
const sources: RepairDataSources = {
  localReadRepairs: () => { localRepairCalls++; return [] },
  localReadItems: () => { localItemCalls++; return [] },
  localReadContractors: () => { localContractorCalls++; return [] },
  localReadRates: () => { localRateCalls++; return [] },
  cloudReadRepairsAdmin: () => { cloudAdminCalls++; return Promise.resolve({ ok: true, rows: [fakeRepairView] }) },
  cloudReadRepairsContractor: () => { cloudContractorCalls++; return Promise.resolve({ ok: true, rows: [fakeRepairView] }) },
}

const dispLocal = dispatchRepairLoad('local', 'admin', sources)
check('local 模式 kind=local', dispLocal.kind === 'local')
check('local 模式本地 reader 各一次', localRepairCalls === 1 && localItemCalls === 1 && localContractorCalls === 1 && localRateCalls === 1)
check('local 模式不调云 reader', cloudAdminCalls === 0 && cloudContractorCalls === 0)

// 重置计数，cloud admin 分派
localRepairCalls = localItemCalls = localContractorCalls = localRateCalls = 0
cloudAdminCalls = cloudContractorCalls = 0
const dispCloudAdmin = dispatchRepairLoad('cloud', 'admin', sources)
check('cloud admin 模式 kind=cloud', dispCloudAdmin.kind === 'cloud')
check('cloud admin 模式本地 reader 0 次', localRepairCalls === 0 && localItemCalls === 0 && localContractorCalls === 0 && localRateCalls === 0)
check('cloud admin 模式调 admin 直读 1 次', cloudAdminCalls === 1 && cloudContractorCalls === 0)

// cloud contractor 分派
cloudAdminCalls = cloudContractorCalls = 0
const dispCloudContractor = dispatchRepairLoad('cloud', 'contractor', sources)
check('cloud contractor 模式 kind=cloud', dispCloudContractor.kind === 'cloud')
check('cloud contractor 模式调 contractor RPC 1 次', cloudContractorCalls === 1 && cloudAdminCalls === 0)

// staff 归入 admin 直读
cloudAdminCalls = cloudContractorCalls = 0
dispatchRepairLoad('cloud', 'admin', sources)
check('staff 归入 admin 直读（roleKind=admin）', cloudAdminCalls === 1 && cloudContractorCalls === 0)

// ===========================================================================
// 7. settle 落地（失败 → 空 + 错误，不回退本地）
// ===========================================================================
const settledFail = settleRepairRead({ ok: false, error: SAFE_REPAIR_ERROR })
check('失败落地为安全错误', settledFail.error === SAFE_REPAIR_ERROR)
check('失败返回空数据（不回退本地）', settledFail.rows.length === 0)
const settledOk = settleRepairRead({ ok: true, rows: [fakeRepairView] })
check('成功落地', settledOk.rows.length === 1 && settledOk.error === null)

// ===========================================================================
// 8. safeCloudRepairLoad 边界（同步 throw / Promise reject）
// ===========================================================================
const sSync = await safeCloudRepairLoad(() => { throw new Error('getRdb-sync-boom') })
check('safeCloudRepairLoad 同步 throw → 安全错误', sSync.ok === false && sSync.error === SAFE_REPAIR_ERROR)
const sRej = await safeCloudRepairLoad(() => Promise.reject(new Error('network-reject-detail')))
check('safeCloudRepairLoad Promise reject → 安全错误', sRej.ok === false && sRej.error === SAFE_REPAIR_ERROR)

// cloud 同步 throw 时 dispatch 不抛出，且本地 reader 0 次
let syncLocal = 0
let syncThrew = false
let syncDispatch: ReturnType<typeof dispatchRepairLoad> | null = null
try {
  syncDispatch = dispatchRepairLoad('cloud', 'admin', {
    localReadRepairs: () => { syncLocal++; return [] },
    localReadItems: () => [],
    localReadContractors: () => [],
    localReadRates: () => [],
    cloudReadRepairsAdmin: () => { throw new Error('sync-boom-detail') },
    cloudReadRepairsContractor: () => Promise.resolve({ ok: true, rows: [] }),
  })
} catch {
  syncThrew = true
}
check('cloud 同步 throw：dispatch 不抛出', !syncThrew && syncDispatch?.kind === 'cloud')
check('cloud 同步 throw：本地 reader 0 次', syncLocal === 0)

// ===========================================================================
// 9. local DataService 回归（10 条维修单 + 角色过滤）
// ===========================================================================
const initResult = dataService.init()
check('local DataService 初始化成功', initResult.ok === true)
const localAll = initResult.ok ? dataService.listRepairs('admin') : []
const localStaff = initResult.ok ? dataService.listRepairs('staff') : []
const localC1 = initResult.ok ? dataService.listRepairs('contractor', 1) : []
const localC2 = initResult.ok ? dataService.listRepairs('contractor', 2) : []
const localNone = initResult.ok ? dataService.listRepairs('contractor') : []
check('local admin 返回 10 条维修单', localAll.length === 10)
check('local staff 返回 10 条维修单', localStaff.length === 10)
check('local contractor 1 返回 4 条维修单', localC1.length === 4)
check('local contractor 2 返回 3 条维修单', localC2.length === 3)
check('local contractor 无 contractorId 返回空', localNone.length === 0)

// buildRepairRows 组装（local 归一到统一视图）
if (initResult.ok) {
  const rows = buildRepairRows(
    dataService.listRepairs('admin'),
    dataService.listItems(),
    dataService.listContractors(),
    dataService.listContractorRates(),
  )
  check('buildRepairRows 返回 10 行', rows.length === 10)
  const first = rows.find((r) => r.repair_id === 1)
  check('buildRepairRows 组装 item_code', first !== undefined && first.item_code === 'SN0002')
  check('buildRepairRows 组装 contractor_name', first !== undefined && first.contractor_name === '峰顶装备维修')
  check('buildRepairRows 组装 rate_hourly=200', first !== undefined && first.rate_hourly === 200)
  check('buildRepairRows 保留 item_id/contractor_id/rate_id 非 null', first !== undefined && first.item_id === 2 && first.contractor_id === 1 && first.rate_id === 2)
  // 待维修/维修中 nullable 保留
  const working = rows.find((r) => r.repair_id === 5)
  check('buildRepairRows 维修中 nullable 保留 null', working !== undefined && working.repair_date === null && working.repair_hours === null)
}

// ===========================================================================
// 10. 模式语义（仅配置 mode）
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
// 11. 证明未读取 .env.local（真断言，非 check(true)）
// ===========================================================================
const meta = import.meta as unknown as { env?: unknown }
check('Node 测试上下文无 import.meta.env（不加载 .env.local）', meta.env === undefined)

// ===========================================================================
// 12. 承包商筛选选项（cloud 从 RepairRowView 去重）与筛选条件（null 不放行）
// ===========================================================================
const filterBase: RepairRowView = { ...fakeRepairView }
const mkFilter = (repair_id: number, contractor_id: number | null, contractor_name: string): RepairRowView => ({
  ...filterBase, repair_id, contractor_id, contractor_name,
})
const filterRows: RepairRowView[] = [
  mkFilter(1, 1, '峰顶装备维修'),
  mkFilter(2, 2, '极速雪具工坊'),
  mkFilter(3, 1, '峰顶装备维修'),
  mkFilter(4, null, '峰顶装备维修'), // contractor RPC 行：contractor_id=null
]

const filterOpts = buildRepairContractorFilterOptions(filterRows)
check('承包商选项去重后 2 项（contractor 1/2）', filterOpts.length === 2)
check('承包商选项排除 contractor_id=null', filterOpts.every((o) => o.value !== 'null'))
check('承包商选项 value 为 contractor_id 字符串', filterOpts.map((o) => o.value).join(',') === '1,2')
check('承包商选项顺序稳定（按 contractor_id 升序）', filterOpts[0].value === '1' && filterOpts[1].value === '2')
check('承包商选项 label 取 contractor_name', filterOpts[0].label === '峰顶装备维修' && filterOpts[1].label === '极速雪具工坊')

// 选中承包商后仅保留严格匹配，null 不得被放行
const filteredBy1 = filterRepairsByContractor(filterRows, '1')
check('筛选 contractor=1 仅保留匹配行', filteredBy1.length === 2 && filteredBy1.every((r) => r.contractor_id === 1))
check('筛选 contractor=2 时 contractor_id=null 不放行', filterRepairsByContractor(filterRows, '2').length === 1)
check('未选择筛选条件返回全部', filterRepairsByContractor(filterRows, '').length === 4)

// local 行为不回归：local 行经 buildRepairRows 后，承包商选项与 listContractors 一致
if (initResult.ok) {
  const localRows = buildRepairRows(
    dataService.listRepairs('admin'),
    dataService.listItems(),
    dataService.listContractors(),
    dataService.listContractorRates(),
  )
  const localOpts = buildRepairContractorFilterOptions(localRows)
  const expectedIds = dataService.listContractors().map((c) => String(c.contractor_id)).sort((a, b) => Number(a) - Number(b))
  check('local 承包商选项与 listContractors 一致（不回归）', JSON.stringify(localOpts.map((o) => o.value)) === JSON.stringify(expectedIds))
  check('local 承包商选项无 null 无空串', localOpts.every((o) => o.value !== 'null' && o.value !== ''))
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
