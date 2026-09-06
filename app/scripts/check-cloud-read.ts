/**
 * 云端客户只读查询校验脚本（由 validate-cloud-read.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-read
 *
 * 覆盖：
 * 1. 行映射 / 归一化 / nullable / fail-closed / 排序 / 安全错误（纯逻辑）；
 * 2. 真实 RDB 查询构造（注入 fake client 验证 from/select/order、绝不用 '*'、错误处理）；
 * 3. 数据源分派（计数型 fake reader 验证 local/cloud 调用次数、cloud 失败不回退本地）；
 * 4. 模式语义（resolveConfig 仅验证配置 mode，不涉及 UI 写入口）。
 *
 * 本脚本不读取真实 .env.local、不连接真实账号、不输出凭据、不 import cloudbase 运行时。
 *
 * 手动验收（非本脚本自动覆盖，因未引入 React DOM 测试）：
 * - cloud 模式下「新增/编辑/删除」按钮与 Drawer 隐藏、操作列显示「云端写入待迁移」；
 * - cloud 未登录重定向；local 客户 CRUD；1280 / 1920 宽度无横向滚动。
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
  mapCloudCustomers,
  toCloudReadResult,
  SAFE_CLOUD_ERROR,
  queryCustomers,
  CUSTOMER_SELECT_COLUMNS,
} = await import('../src/data/cloudCustomers')
type CloudCustomerRow = import('../src/data/cloudCustomers').CloudCustomerRow
type CustomerRdbClient = import('../src/data/cloudCustomers').CustomerRdbClient
const {
  dispatchCustomerLoad,
  settleCloudRead,
  safeCloudLoad,
} = await import('../src/data/customerDataSource')
type CustomerDataSources = import('../src/data/customerDataSource').CustomerDataSources
type CustomerLoadDispatch = import('../src/data/customerDataSource').CustomerLoadDispatch
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

const validRow: CloudCustomerRow = {
  customer_id: 1,
  full_name: '张三',
  address: '北京市朝阳区',
  phone: '13800000000',
  email: 'zhang@example.com',
  birth_year: 1995,
  height_cm: 170.5,
  weight_kg: 65.2,
  shoe_size: 40.5,
}

// ---------------- 1. 完整客户行映射 ----------------
const r1 = mapCloudCustomers([validRow])
check('完整客户行映射成功', r1.ok === true)
if (r1.ok) {
  const c = r1.customers[0]
  check('映射 customer_id=1', c.customer_id === 1)
  check('映射 full_name', c.full_name === '张三')
  check('映射 address', c.address === '北京市朝阳区')
  check('映射 phone', c.phone === '13800000000')
  check('映射 email', c.email === 'zhang@example.com')
  check('映射 birth_year=1995', c.birth_year === 1995)
  check('映射 height_cm=170.5', c.height_cm === 170.5)
  check('映射 weight_kg=65.2', c.weight_kg === 65.2)
  check('映射 shoe_size=40.5', c.shoe_size === 40.5)
}

// ---------------- 2. 数字字符串归一化 ----------------
const strRow: CloudCustomerRow = {
  customer_id: '2',
  full_name: '李四',
  address: '上海市',
  phone: '13900000000',
  email: null,
  birth_year: '1990',
  height_cm: '180',
  weight_kg: '70.5',
  shoe_size: '42',
}
const r2 = mapCloudCustomers([strRow])
check('customer_id 字符串归一化为 number', r2.ok === true && r2.customers[0].customer_id === 2)
check('birth_year 字符串归一化', r2.ok === true && r2.customers[0].birth_year === 1990)
check('height_cm 字符串归一化', r2.ok === true && r2.customers[0].height_cm === 180)
check('weight_kg 字符串归一化', r2.ok === true && r2.customers[0].weight_kg === 70.5)
check('shoe_size 字符串归一化', r2.ok === true && r2.customers[0].shoe_size === 42)

// ---------------- 3. nullable 字段保持 null ----------------
const nullRow: CloudCustomerRow = {
  customer_id: 3,
  full_name: '王五',
  address: '广州市',
  phone: '13700000000',
  email: null,
  birth_year: null,
  height_cm: null,
  weight_kg: null,
  shoe_size: null,
}
const r3 = mapCloudCustomers([nullRow])
check('email null 保持', r3.ok === true && r3.customers[0].email === null)
check('birth_year null 保持', r3.ok === true && r3.customers[0].birth_year === null)
check('height_cm null 保持', r3.ok === true && r3.customers[0].height_cm === null)
check('weight_kg null 保持', r3.ok === true && r3.customers[0].weight_kg === null)
check('shoe_size null 保持', r3.ok === true && r3.customers[0].shoe_size === null)

// ---------------- 4. 非法 customer_id 被拒 ----------------
check('customer_id=0 拒绝', mapCloudCustomers([{ ...validRow, customer_id: 0 }]).ok === false)
check('customer_id=-1 拒绝', mapCloudCustomers([{ ...validRow, customer_id: -1 }]).ok === false)
check('customer_id=1.5 拒绝', mapCloudCustomers([{ ...validRow, customer_id: 1.5 }]).ok === false)
check('customer_id="abc" 拒绝', mapCloudCustomers([{ ...validRow, customer_id: 'abc' }]).ok === false)
check('customer_id=null 拒绝', mapCloudCustomers([{ ...validRow, customer_id: null }]).ok === false)

// ---------------- 5. 重复 customer_id 被拒 ----------------
check('重复 customer_id 拒绝', mapCloudCustomers([validRow, { ...validRow, full_name: '重复' }]).ok === false)

// ---------------- 6. 非法数值字段被拒 ----------------
check('birth_year="abc" 拒绝', mapCloudCustomers([{ ...validRow, birth_year: 'abc' }]).ok === false)
check('height_cm=NaN 拒绝', mapCloudCustomers([{ ...validRow, height_cm: NaN }]).ok === false)
check('weight_kg=Infinity 拒绝', mapCloudCustomers([{ ...validRow, weight_kg: Infinity }]).ok === false)
check('birth_year=1995.5 拒绝（非整数）', mapCloudCustomers([{ ...validRow, birth_year: 1995.5 }]).ok === false)

// ---------------- 7. 稳定按 customer_id 排序 ----------------
const r7 = mapCloudCustomers([
  { ...validRow, customer_id: 3, full_name: 'C' },
  { ...validRow, customer_id: 1, full_name: 'A' },
  { ...validRow, customer_id: 2, full_name: 'B' },
])
check(
  '按 customer_id 升序排序',
  r7.ok === true && r7.customers.map((c) => c.customer_id).join(',') === '1,2,3',
)

// ---------------- 8. SDK error 转安全错误（纯 toCloudReadResult） ----------------
const r8 = toCloudReadResult(null, new Error('internal-boom-detail'))
check('SDK error → 安全错误', r8.ok === false && r8.error === SAFE_CLOUD_ERROR)
check('安全错误不含底层细节', r8.ok === false && !r8.error.includes('boom'))

// ---------------- 9. cloud 查询失败不返回 local 数据（结果形状） ----------------
check('失败结果不含 customers 数据', r8.ok === false && !('customers' in r8))

// ---------------- 10. local 模式仍读取 DataService ----------------
const initResult = dataService.init()
const localCustomers = initResult.ok ? dataService.listCustomers() : []
check('local DataService 返回 12 条客户', localCustomers.length === 12)

// ---------------- 11. 真实 RDB 查询构造（注入 fake client） ----------------
interface RecordedRdb {
  table: string | null
  columns: string | null
  orderColumn: string | null
  orderAscending: boolean | null
}
function makeFakeRdb(
  outcome: { data: unknown; error: unknown } | 'throw',
  record: RecordedRdb,
): CustomerRdbClient {
  return {
    from(table: string) {
      record.table = table
      return {
        select(columns: string) {
          record.columns = columns
          return {
            order(column: string, opts: { ascending: boolean }) {
              record.orderColumn = column
              record.orderAscending = opts.ascending
              if (outcome === 'throw') {
                return Promise.reject(new Error('network-internal-detail'))
              }
              return Promise.resolve(outcome)
            },
          }
        },
      }
    },
  }
}

const rec1: RecordedRdb = { table: null, columns: null, orderColumn: null, orderAscending: null }
const q1 = await queryCustomers(makeFakeRdb({ data: [validRow], error: null }, rec1))
check('查询 from 使用 customers 表', rec1.table === 'customers')
check('查询 select 精确 9 列', rec1.columns === CUSTOMER_SELECT_COLUMNS)
check(
  '查询不使用 select(*)',
  rec1.columns !== null && rec1.columns !== '*' && !rec1.columns.includes('*'),
)
check(
  '查询 order customer_id 升序',
  rec1.orderColumn === 'customer_id' && rec1.orderAscending === true,
)
check('查询成功返回映射结果', q1.ok === true && q1.customers.length === 1 && q1.customers[0].customer_id === 1)

const rec2: RecordedRdb = { table: null, columns: null, orderColumn: null, orderAscending: null }
const q2 = await queryCustomers(makeFakeRdb({ data: null, error: new Error('secret-internal') }, rec2))
check('SDK 返回 error → 安全错误', q2.ok === false && q2.error === SAFE_CLOUD_ERROR)
check('安全错误不泄露底层细节', q2.ok === false && !q2.error.includes('secret'))

const rec3: RecordedRdb = { table: null, columns: null, orderColumn: null, orderAscending: null }
const q3 = await queryCustomers(makeFakeRdb('throw', rec3))
check('SDK 抛异常 → 安全错误', q3.ok === false && q3.error === SAFE_CLOUD_ERROR)

// ---------------- 12. 数据源分派：计数型 fake reader ----------------
const fakeLocalCustomer = {
  customer_id: 999,
  full_name: 'Fake本地',
  address: 'x',
  phone: 'x',
  email: null,
  birth_year: null,
  height_cm: null,
  weight_kg: null,
  shoe_size: null,
}
let localCalls = 0
let cloudCalls = 0
const sources: CustomerDataSources = {
  localRead: () => {
    localCalls++
    return [fakeLocalCustomer]
  },
  cloudRead: () => {
    cloudCalls++
    return Promise.resolve({ ok: true, customers: [] })
  },
}

const dispLocal = dispatchCustomerLoad('local', sources)
check('local 模式 kind=local', dispLocal.kind === 'local')
check('local 模式调用本地 reader 恰好一次', localCalls === 1)
check('local 模式不调用云 reader', cloudCalls === 0)
if (dispLocal.kind === 'local') {
  check('local 模式返回本地客户', dispLocal.customers.length === 1 && dispLocal.customers[0].customer_id === 999)
}

localCalls = 0
cloudCalls = 0
const dispCloud = dispatchCustomerLoad('cloud', sources)
check('cloud 模式 kind=cloud', dispCloud.kind === 'cloud')
check('cloud 模式调用本地 reader 0 次', localCalls === 0)
check('cloud 模式调用云 reader 一次', cloudCalls === 1)
if (dispCloud.kind === 'cloud') {
  const dispCloudResult = await dispCloud.promise
  check(
    'cloud 模式 promise 正常 resolve 成功结果',
    dispCloudResult.ok === true && dispCloudResult.customers.length === 0,
  )
}

// ---------------- 13. cloud 失败落地：空数组 + 错误，不回退本地 ----------------
const settledFail = settleCloudRead({ ok: false, error: SAFE_CLOUD_ERROR })
check('cloud 失败落地为安全错误', settledFail.error === SAFE_CLOUD_ERROR)
check('cloud 失败返回空数组（不回退 fake 本地客户）', settledFail.customers.length === 0)
const settledOk = settleCloudRead({ ok: true, customers: [fakeLocalCustomer] })
check('cloud 成功落地为映射客户', settledOk.customers.length === 1 && settledOk.error === null)

// ---------------- 13b. 完整云读取边界（fail-closed）：同步 throw / Promise reject ----------------
// cloudRead 同步 throw（模拟 getRdb() 在参数求值阶段同步抛错）
let syncLocalCalls = 0
let syncCloudCalls = 0
let syncDispatch: CustomerLoadDispatch | null = null
let syncDispatchThrew = false
try {
  syncDispatch = dispatchCustomerLoad('cloud', {
    localRead: () => {
      syncLocalCalls++
      return [fakeLocalCustomer]
    },
    cloudRead: () => {
      syncCloudCalls++
      throw new Error('getRdb-sync-boom-detail')
    },
  })
} catch {
  syncDispatchThrew = true
}
check('cloudRead 同步 throw：dispatch 不抛出', !syncDispatchThrew && syncDispatch?.kind === 'cloud')
check('cloudRead 同步 throw：local reader 调用 0 次', syncLocalCalls === 0)
check('cloudRead 同步 throw：cloud reader 调用 1 次', syncCloudCalls === 1)
if (syncDispatch?.kind === 'cloud') {
  const syncSettled = settleCloudRead(await syncDispatch.promise)
  check('cloudRead 同步 throw → 安全错误', syncSettled.error === SAFE_CLOUD_ERROR)
  check('cloudRead 同步 throw → 不泄露底层细节', !syncSettled.error.includes('boom'))
  check('cloudRead 同步 throw → customers=[]', syncSettled.customers.length === 0)
}

// cloudRead Promise reject（模拟 SDK 网络异常）
let rejLocalCalls = 0
let rejCloudCalls = 0
const rejDispatch = dispatchCustomerLoad('cloud', {
  localRead: () => {
    rejLocalCalls++
    return [fakeLocalCustomer]
  },
  cloudRead: () => {
    rejCloudCalls++
    return Promise.reject(new Error('network-reject-detail'))
  },
})
check('cloudRead Promise reject：dispatch 不抛出', rejDispatch.kind === 'cloud')
check('cloudRead Promise reject：local reader 调用 0 次', rejLocalCalls === 0)
check('cloudRead Promise reject：cloud reader 调用 1 次', rejCloudCalls === 1)
if (rejDispatch.kind === 'cloud') {
  const rejSettled = settleCloudRead(await rejDispatch.promise)
  check('cloudRead Promise reject → 安全错误', rejSettled.error === SAFE_CLOUD_ERROR)
  check('cloudRead Promise reject → 不泄露底层细节', !rejSettled.error.includes('reject'))
  check('cloudRead Promise reject → customers=[]', rejSettled.customers.length === 0)
}

// safeCloudLoad 直接单测：同步 throw 与 reject 均收口为安全错误，且不触碰 localRead
const directSyncResult = await safeCloudLoad({
  cloudRead: () => {
    throw new Error('direct-sync-boom')
  },
})
check('safeCloudLoad 直接：同步 throw → 安全错误', directSyncResult.ok === false && directSyncResult.error === SAFE_CLOUD_ERROR)
const directRejResult = await safeCloudLoad({
  cloudRead: () => Promise.reject(new Error('direct-reject')),
})
check('safeCloudLoad 直接：Promise reject → 安全错误', directRejResult.ok === false && directRejResult.error === SAFE_CLOUD_ERROR)

// ---------------- 14. 模式语义（仅配置 mode，不涉及 UI 写入口） ----------------
const cloudCfg = resolveConfig({
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-id',
  VITE_CLOUDBASE_REGION: 'ap-shanghai',
  VITE_CLOUDBASE_ACCESS_KEY: 'publishable-key',
})
check('cloud 配置 → mode=cloud', cloudCfg.ok === true && cloudCfg.mode === 'cloud')
const localCfg = resolveConfig({})
check('local 配置 → mode=local', localCfg.ok === true && localCfg.mode === 'local')

// ---------------- 15. 证明未读取 .env.local ----------------
// 本脚本由 esbuild(platform:node) 打包执行，不经 Vite，import.meta.env 应为 undefined，
// 因此不存在从 .env.local 注入的任何凭据。
const meta = import.meta as unknown as { env?: unknown }
check('Node 测试上下文无 import.meta.env（不加载 .env.local）', meta.env === undefined)

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
