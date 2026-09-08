/**
 * 云端「管理驾驶舱」KPI 聚合校验脚本（由 validate-cloud-dashboard.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-dashboard
 *
 * 覆盖：
 * 1. 聚合口径（与 docs/01 §10 一致）：设备利用率 / 本月营收 / 平均维修周转 / 门店库存分布；
 * 2. 边界：无有效设备 → 利用率 null；无已完成维修 → 平均周转 null；空数据全 0/null；
 * 3. fail-closed：非数组 / 非法 status / 非法 total_amount / 门店引用缺失 /
 *    已完成合同缺 completed_at / 已完成维修 repair_date 早于 request_date → 统一安全错误；
 * 4. 显式列名（逐表精确列，绝不用 select('*')）；
 * 5. queryDashboardKpi 四表任一 error / 抛异常 → 整体安全错误（不返回部分 KPI）；
 * 6. formatUtilizationRate 展示辅助；
 * 7. local 聚合复用同一口径（buildLocalDashboardKpi 用 raw 转换）。
 *
 * 本脚本不读取真实 .env.local、不连接真实账号、不输出凭据、不 import cloudbase 运行时。
 */

const {
  assembleDashboardKpi,
  queryDashboardKpi,
  SAFE_DASHBOARD_ERROR,
  DASHBOARD_ITEM_COLUMNS,
  DASHBOARD_STORE_COLUMNS,
  DASHBOARD_CONTRACT_COLUMNS,
  DASHBOARD_REPAIR_COLUMNS,
} = await import('../src/data/cloudDashboard')
type MasterRdbClient = import('../src/data/cloudMaster').MasterRdbClient

const { buildLocalDashboardKpi, formatUtilizationRate } = await import('../src/data/dashboardDataSource')

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
// 固定夹具（todayStr = 2026-08-20，本月 = 2026-08）
// ---------------------------------------------------------------------------
const TODAY = '2026-08-20'

const items = [
  { item_id: 1, status: '借出中', current_store_id: 1 },
  { item_id: 2, status: '在库', current_store_id: 1 },
  { item_id: 3, status: '维修中', current_store_id: 2 },
  { item_id: 4, status: '已报废', current_store_id: 1 },
  { item_id: 5, status: '借出中', current_store_id: 2 },
]
// validCount = 4（不含已报废）；rentedCount = 2；利用率 = 0.5

const stores = [
  { store_id: 1, store_name: '雪峰旗舰店' },
  { store_id: 2, store_name: '北坡分店' },
]

const contracts = [
  { status: '已完成', completed_at: '2026-08-05', total_amount: 1000 },
  { status: '已完成', completed_at: '2026-08-10', total_amount: 500.5 },
  { status: '已完成', completed_at: '2026-07-28', total_amount: 300 },
  { status: '进行中', completed_at: null, total_amount: 800 },
]
// 本月营收 = 1000 + 500.5 = 1500.5

const repairs = [
  { status: '已完成', request_date: '2026-08-01', repair_date: '2026-08-04' },
  { status: '已完成', request_date: '2026-08-10', repair_date: '2026-08-12' },
  { status: '维修中', request_date: '2026-08-15', repair_date: null },
  { status: '待维修', request_date: '2026-08-18', repair_date: null },
]
// 平均周转 = (3 + 2) / 2 = 2.5 天；completedRepairCount = 2

// ===========================================================================
// 1. 聚合口径
// ===========================================================================
{
  const r = assembleDashboardKpi(items, stores, contracts, repairs, TODAY)
  check('聚合成功', r.ok === true)
  if (r.ok) {
    const k = r.kpi
    check('利用率 = 2/4 = 0.5', k.utilizationRate === 0.5)
    check('rentedCount = 2', k.rentedCount === 2)
    check('validCount = 4（不含已报废）', k.validCount === 4)
    check('本月营收 = 1500.5', k.monthlyRevenue === 1500.5)
    check('平均周转 = 2.5 天', k.avgRepairTurnaroundDays === 2.5)
    check('completedRepairCount = 2', k.completedRepairCount === 2)
    check('门店分布 2 家', k.storeDistribution.length === 2)
    check('门店分布按 store_id 升序', k.storeDistribution[0].store_id === 1 && k.storeDistribution[1].store_id === 2)
    const s1 = k.storeDistribution[0]
    check('store1 名称正确', s1.store_name === '雪峰旗舰店')
    check('store1 在库1 借出1 维修0 报废1', s1.inStock === 1 && s1.rented === 1 && s1.repairing === 0 && s1.scrapped === 1)
    const s2 = k.storeDistribution[1]
    check('store2 在库0 借出1 维修1 报废0', s2.inStock === 0 && s2.rented === 1 && s2.repairing === 1 && s2.scrapped === 0)
  }
}

// ===========================================================================
// 2. 边界
// ===========================================================================
{
  const r = assembleDashboardKpi([], stores, [], [], TODAY)
  check('空设备/合同/维修 → ok', r.ok === true)
  if (r.ok) {
    check('空设备 → 利用率 null', r.kpi.utilizationRate === null)
    check('空设备 → validCount 0', r.kpi.validCount === 0)
    check('空合同 → 营收 0', r.kpi.monthlyRevenue === 0)
    check('空维修 → 平均周转 null', r.kpi.avgRepairTurnaroundDays === null)
    check('空设备 → 门店分布空', r.kpi.storeDistribution.length === 0)
  }
}
{
  // 全部已报废：validCount=0 → 利用率 null
  const r = assembleDashboardKpi(
    [{ item_id: 1, status: '已报废', current_store_id: 1 }],
    stores,
    [],
    [],
    TODAY,
  )
  check('全报废 → ok 且利用率 null', r.ok === true && r.kpi.utilizationRate === null)
}
{
  // 上月完成合同不计入本月营收
  const r = assembleDashboardKpi([], stores, contracts, [], TODAY)
  check('本月营收只计本月完成合同', r.ok === true && r.kpi.monthlyRevenue === 1500.5)
}

// ===========================================================================
// 3. fail-closed
// ===========================================================================
check('items 非数组 → 安全错误', assembleDashboardKpi('not-array', stores, contracts, repairs, TODAY).ok === false)
check('stores 非数组 → 安全错误', assembleDashboardKpi(items, null, contracts, repairs, TODAY).ok === false)
check('contracts 非数组 → 安全错误', assembleDashboardKpi(items, stores, 'x', repairs, TODAY).ok === false)
check('repairs 非数组 → 安全错误', assembleDashboardKpi(items, stores, contracts, 42, TODAY).ok === false)
check('item status 非法 → 安全错误', assembleDashboardKpi([{ item_id: 1, status: '未知', current_store_id: 1 }], stores, [], [], TODAY).ok === false)
check('contract status 非法 → 安全错误', assembleDashboardKpi([], stores, [{ status: '进行中x', completed_at: null, total_amount: 1 }], [], TODAY).ok === false)
check('total_amount 负数 → 安全错误', assembleDashboardKpi([], stores, [{ status: '进行中', completed_at: null, total_amount: -1 }], [], TODAY).ok === false)
check('total_amount 非数字 → 安全错误', assembleDashboardKpi([], stores, [{ status: '进行中', completed_at: null, total_amount: 'abc' }], [], TODAY).ok === false)
check('已完成合同缺 completed_at → 安全错误', assembleDashboardKpi([], stores, [{ status: '已完成', completed_at: null, total_amount: 1 }], [], TODAY).ok === false)
check('门店引用缺失 → 安全错误', assembleDashboardKpi([{ item_id: 1, status: '在库', current_store_id: 999 }], stores, [], [], TODAY).ok === false)
check('已完成维修 repair_date 早于 request_date → 安全错误', assembleDashboardKpi([], stores, [], [{ status: '已完成', request_date: '2026-08-10', repair_date: '2026-08-01' }], TODAY).ok === false)
check('重复 item_id → 安全错误', assembleDashboardKpi([{ item_id: 1, status: '在库', current_store_id: 1 }, { item_id: 1, status: '在库', current_store_id: 1 }], stores, [], [], TODAY).ok === false)
check('错误文案为统一安全错误', assembleDashboardKpi('x', stores, contracts, repairs, TODAY).error === SAFE_DASHBOARD_ERROR)

// completed_at 为 timestamp without time zone（真实云库返回 "YYYY-MM-DD HH:MM:SS" 或 ISO 带 T）→ 取日期部分计月份
{
  const tsContracts = [
    { status: '已完成', completed_at: '2026-08-05 18:00:00', total_amount: 1000 },
    { status: '已完成', completed_at: '2026-08-10T18:00:00', total_amount: 500.5 },
    { status: '已完成', completed_at: '2026-07-28 23:59:59', total_amount: 300 },
    { status: '进行中', completed_at: null, total_amount: 800 },
  ]
  const r = assembleDashboardKpi([], stores, tsContracts, [], TODAY)
  check('时间戳 completed_at → 聚合成功', r.ok === true)
  if (r.ok) check('时间戳 completed_at 本月营收 = 1500.5', r.kpi.monthlyRevenue === 1500.5)
}
check('时间戳 completed_at 非法日期部分 → 安全错误', assembleDashboardKpi([], stores, [{ status: '已完成', completed_at: '2026-02-30 10:00:00', total_amount: 1 }], [], TODAY).ok === false)
check('时间戳 completed_at 非字符串 → 安全错误', assembleDashboardKpi([], stores, [{ status: '已完成', completed_at: 20260805, total_amount: 1 }], [], TODAY).ok === false)

// ===========================================================================
// 4. 显式列名（绝不用 select('*')）
// ===========================================================================
check('items 列名显式', DASHBOARD_ITEM_COLUMNS === 'item_id, status, current_store_id')
check('stores 列名显式', DASHBOARD_STORE_COLUMNS === 'store_id, store_name')
check('contracts 列名显式', DASHBOARD_CONTRACT_COLUMNS === 'status, completed_at, total_amount')
check('repairs 列名显式', DASHBOARD_REPAIR_COLUMNS === 'status, request_date, repair_date')
for (const col of [DASHBOARD_ITEM_COLUMNS, DASHBOARD_STORE_COLUMNS, DASHBOARD_CONTRACT_COLUMNS, DASHBOARD_REPAIR_COLUMNS]) {
  check(`列名不含 select('*')（${col}）`, !col.includes('*'))
}

// ===========================================================================
// 5. queryDashboardKpi：四表任一 error / 抛异常 → 整体安全错误
// ===========================================================================
function makeFakeRdb(
  tables: Record<string, { data: unknown; error: unknown } | 'throw'>,
): MasterRdbClient {
  return {
    from(table: string) {
      return {
        select() {
          return {
            async order() {
              const t = tables[table]
              if (t === 'throw') throw new Error('sdk-network-internal')
              if (t === undefined) return { data: null, error: { code: '42P01', message: 'no table' } }
              return t
            },
          }
        },
      }
    },
  }
}
const okTables = {
  rental_items: { data: items, error: null },
  stores: { data: stores, error: null },
  rental_contracts: { data: contracts, error: null },
  repair_orders: { data: repairs, error: null },
}
{
  const r = await queryDashboardKpi(makeFakeRdb(okTables), TODAY)
  check('queryDashboardKpi 成功', r.ok === true)
  if (r.ok) check('queryDashboardKpi 利用率 0.5', r.kpi.utilizationRate === 0.5)
}
{
  const r = await queryDashboardKpi(makeFakeRdb({ ...okTables, rental_contracts: { data: null, error: { code: '42501', message: 'denied' } } }), TODAY)
  check('contracts error → 整体安全错误', r.ok === false && r.error === SAFE_DASHBOARD_ERROR)
}
{
  const r = await queryDashboardKpi(makeFakeRdb({ ...okTables, repair_orders: 'throw' }), TODAY)
  check('repairs 抛异常 → 整体安全错误', r.ok === false && r.error === SAFE_DASHBOARD_ERROR)
}

// ===========================================================================
// 6. formatUtilizationRate
// ===========================================================================
check('formatUtilizationRate(0.5)=50%', formatUtilizationRate(0.5) === '50%')
check('formatUtilizationRate(0.375)=37.5%', formatUtilizationRate(0.375) === '37.5%')
check('formatUtilizationRate(0.3333)=33.3%', formatUtilizationRate(0.3333) === '33.3%')
check('formatUtilizationRate(null)=—', formatUtilizationRate(null) === '—')

// ===========================================================================
// 7. local 聚合复用同一口径（raw 转换）
// ===========================================================================
{
  const r = buildLocalDashboardKpi(
    {
      localReadItems: () => items.map((i) => ({ item_id: i.item_id, status: i.status as '在库' | '借出中' | '维修中' | '已报废', current_store_id: i.current_store_id })),
      localReadStores: () => stores.map((s) => ({ store_id: s.store_id, store_name: s.store_name })),
      localReadContracts: () => contracts.map((c) => ({ status: c.status as '进行中' | '已完成', completed_at: c.completed_at, total_amount: c.total_amount })),
      localReadRepairs: () => repairs.map((rp) => ({ status: rp.status as '待维修' | '维修中' | '已完成', request_date: rp.request_date, repair_date: rp.repair_date })),
    },
    TODAY,
  )
  check('local 聚合与 cloud 口径一致（利用率 0.5）', r.ok === true && r.kpi.utilizationRate === 0.5)
  if (r.ok) {
    check('local 聚合营收 1500.5', r.kpi.monthlyRevenue === 1500.5)
    check('local 聚合平均周转 2.5', r.kpi.avgRepairTurnaroundDays === 2.5)
  }
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
