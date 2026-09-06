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
  dispatchCustomerMutation,
  settleCloudRead,
  safeCloudLoad,
  MutationLock,
  CloudCustomerRefresh,
} = await import('../src/data/customerDataSource')
type CustomerDataSources = import('../src/data/customerDataSource').CustomerDataSources
type CustomerLoadDispatch = import('../src/data/customerDataSource').CustomerLoadDispatch
const {
  buildCustomerPayload,
  validateCustomerFields,
  createCustomer,
  updateCustomer,
  removeCustomer,
  isPositiveSafeInt,
  SAFE_CUSTOMER_WRITE_ERROR,
  CUSTOMER_REFERENCED_ERROR,
  CUSTOMER_EMAIL_CONFLICT_ERROR,
  CUSTOMER_NOT_FOUND_ERROR,
} = await import('../src/data/cloudCustomerMutations')
type CustomerRdbMutationClient = import('../src/data/cloudCustomerMutations').CustomerRdbMutationClient
type CustomerMutationBuilder = import('../src/data/cloudCustomerMutations').CustomerMutationBuilder
type CustomerInput = import('../src/data/types').CustomerInput
const { LatestRequestGuard } = await import('../src/data/contractDataSource')
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

// ===========================================================================
// 16. 客户写操作：payload 归一化与字段校验（纯逻辑）
// ===========================================================================
const testInput: CustomerInput = {
  full_name: ' 测试客户 ',
  address: ' 测试地址 ',
  phone: ' 10086 ',
  email: ' test@example.com ',
  birth_year: 1990,
  height_cm: 170,
  weight_kg: 65,
  shoe_size: 40,
}
const payload = buildCustomerPayload(testInput)
check('payload 不含 customer_id', !('customer_id' in payload))
check('payload 不含 role', !('role' in payload))
check('payload 不含 uid', !('uid' in payload))
check('payload 不含 account_id', !('account_id' in payload))
check('payload 不含 actorRole', !('actorRole' in payload))
check('payload full_name trim', payload.full_name === '测试客户')
check('payload address trim', payload.address === '测试地址')
check('payload phone trim', payload.phone === '10086')
check('payload email trim', payload.email === 'test@example.com')
check('payload 数值字段保留', payload.birth_year === 1990 && payload.height_cm === 170)
const payloadNullEmail = buildCustomerPayload({ ...testInput, email: '   ' })
check('payload 空邮箱归一化为 null', payloadNullEmail.email === null)
const payloadNullNum = buildCustomerPayload({
  ...testInput,
  birth_year: null,
  height_cm: null,
  weight_kg: null,
  shoe_size: null,
})
check(
  'payload 可空数值 null 保持',
  payloadNullNum.birth_year === null &&
    payloadNullNum.height_cm === null &&
    payloadNullNum.weight_kg === null &&
    payloadNullNum.shoe_size === null,
)

const vName = validateCustomerFields({ ...testInput, full_name: '  ' })
check('空姓名 → field full_name', vName.ok === false && vName.field === 'full_name')
const vAddr = validateCustomerFields({ ...testInput, address: '' })
check('空地址 → field address', vAddr.ok === false && vAddr.field === 'address')
const vPhone = validateCustomerFields({ ...testInput, phone: '' })
check('空电话 → field phone', vPhone.ok === false && vPhone.field === 'phone')
const vBirth = validateCustomerFields({ ...testInput, birth_year: 1800 })
check('出生年份超界 → field birth_year', vBirth.ok === false && vBirth.field === 'birth_year')
const vHeight = validateCustomerFields({ ...testInput, height_cm: 500 })
check('身高超界 → field height_cm', vHeight.ok === false && vHeight.field === 'height_cm')
const vWeight = validateCustomerFields({ ...testInput, weight_kg: -1 })
check('体重超界 → field weight_kg', vWeight.ok === false && vWeight.field === 'weight_kg')
const vShoe = validateCustomerFields({ ...testInput, shoe_size: 100 })
check('鞋码超界 → field shoe_size', vShoe.ok === false && vShoe.field === 'shoe_size')
check('合法输入校验通过', validateCustomerFields(testInput).ok === true)

// ---- 16b. 出生年份整数校验（cloud 写校验，拒绝小数/NaN/Infinity/字符串）----
check(
  'cloud 写校验拒绝 1995.5',
  validateCustomerFields({ ...testInput, birth_year: 1995.5 }).ok === false,
)
check('cloud 写校验拒绝 NaN', validateCustomerFields({ ...testInput, birth_year: NaN }).ok === false)
check(
  'cloud 写校验拒绝 Infinity',
  validateCustomerFields({ ...testInput, birth_year: Infinity }).ok === false,
)
check(
  'cloud 写校验拒绝 -Infinity',
  validateCustomerFields({ ...testInput, birth_year: -Infinity }).ok === false,
)
check(
  'cloud 写校验拒绝字符串 "1995"',
  validateCustomerFields({ ...testInput, birth_year: '1995' as unknown as number }).ok === false,
)
const vBirthDot = validateCustomerFields({ ...testInput, birth_year: 1995.5 })
check('1995.5 → field birth_year', vBirthDot.ok === false && vBirthDot.field === 'birth_year')
check('cloud 写校验接受 1900', validateCustomerFields({ ...testInput, birth_year: 1900 }).ok === true)
check('cloud 写校验接受 2100', validateCustomerFields({ ...testInput, birth_year: 2100 }).ok === true)
check('cloud 写校验拒绝 1899', validateCustomerFields({ ...testInput, birth_year: 1899 }).ok === false)
check('cloud 写校验拒绝 2101', validateCustomerFields({ ...testInput, birth_year: 2101 }).ok === false)
check('cloud 写校验接受 null', validateCustomerFields({ ...testInput, birth_year: null }).ok === true)

check('isPositiveSafeInt(1)=true', isPositiveSafeInt(1) === true)
check('isPositiveSafeInt(0)=false', isPositiveSafeInt(0) === false)
check('isPositiveSafeInt(-1)=false', isPositiveSafeInt(-1) === false)
check('isPositiveSafeInt(1.5)=false', isPositiveSafeInt(1.5) === false)
check('isPositiveSafeInt(NaN)=false', isPositiveSafeInt(NaN) === false)
check(
  'isPositiveSafeInt(MAX_SAFE_INTEGER)=true',
  isPositiveSafeInt(Number.MAX_SAFE_INTEGER) === true,
)
check(
  'isPositiveSafeInt(MAX_SAFE_INTEGER+1)=false',
  isPositiveSafeInt(Number.MAX_SAFE_INTEGER + 1) === false,
)

// ===========================================================================
// 17. 客户写操作：真实调用链（fake RDB 记录 from/insert/update/delete/eq/select）
// ===========================================================================
type MutationOutcome = { data: unknown; error: unknown }
type FakeMutationOutcome = { kind: 'resolve'; value: MutationOutcome } | { kind: 'reject' }

interface MutationRecord {
  table: string | null
  insertPayload: Record<string, unknown> | null
  updatePayload: Record<string, unknown> | null
  deleted: boolean
  eqColumn: string | null
  eqValue: unknown
  selectColumns: string | null
}
function emptyMutationRecord(): MutationRecord {
  return {
    table: null,
    insertPayload: null,
    updatePayload: null,
    deleted: false,
    eqColumn: null,
    eqValue: null,
    selectColumns: null,
  }
}
function makeFakeMutationRdb(
  outcome: FakeMutationOutcome,
  record: MutationRecord,
): CustomerRdbMutationClient {
  function makeBuilder(): CustomerMutationBuilder {
    const builder = {} as CustomerMutationBuilder
    builder.eq = (column: string, value: unknown) => {
      record.eqColumn = column
      record.eqValue = value
      return builder
    }
    builder.select = (columns: string) => {
      record.selectColumns = columns
      return builder
    }
    builder.then = (onFulfilled?: (v: MutationOutcome) => unknown, onRejected?: (r: unknown) => unknown) => {
      if (outcome.kind === 'reject') {
        return Promise.reject(new Error('sdk-network-internal')).then(onFulfilled, onRejected)
      }
      return Promise.resolve(outcome.value).then(onFulfilled, onRejected)
    }
    return builder
  }
  return {
    from(table: string) {
      record.table = table
      return {
        insert(values: Record<string, unknown>) {
          record.insertPayload = values
          record.updatePayload = null
          record.deleted = false
          return makeBuilder()
        },
        update(values: Record<string, unknown>) {
          record.updatePayload = values
          record.insertPayload = null
          record.deleted = false
          return makeBuilder()
        },
        delete() {
          record.deleted = true
          record.insertPayload = null
          record.updatePayload = null
          return makeBuilder()
        },
      }
    },
  }
}

const okOutcome: FakeMutationOutcome = { kind: 'resolve', value: { data: [validRow], error: null } }

// create：from + insert + select，无 eq
const recCreate: MutationRecord = emptyMutationRecord()
const createRes = await createCustomer(makeFakeMutationRdb(okOutcome, recCreate), testInput)
check('create 成功返回 ok', createRes.ok === true)
if (createRes.ok) {
  check('create 返回映射客户 customer_id=1', createRes.data.customer_id === 1)
}
check('create 使用 customers 表', recCreate.table === 'customers')
check('create 走 insert（非 update/delete）', recCreate.insertPayload !== null && recCreate.updatePayload === null && recCreate.deleted === false)
check('create payload 不含越权字段', recCreate.insertPayload !== null && !('customer_id' in recCreate.insertPayload) && !('role' in recCreate.insertPayload) && !('uid' in recCreate.insertPayload))
check('create 不设置 eq', recCreate.eqColumn === null)
check(
  'create select 精确列（非 *）',
  recCreate.selectColumns === CUSTOMER_SELECT_COLUMNS && !recCreate.selectColumns.includes('*'),
)

// update：from + update + eq(customer_id) + select
const recUpdate: MutationRecord = emptyMutationRecord()
const updateRes = await updateCustomer(makeFakeMutationRdb(okOutcome, recUpdate), 5, testInput)
check('update 成功返回 ok', updateRes.ok === true)
check('update 使用 customers 表', recUpdate.table === 'customers')
check('update 走 update（非 insert/delete）', recUpdate.updatePayload !== null && recUpdate.insertPayload === null && recUpdate.deleted === false)
check('update eq 精确 customer_id=5', recUpdate.eqColumn === 'customer_id' && recUpdate.eqValue === 5)
check(
  'update select 精确列（非 *）',
  recUpdate.selectColumns === CUSTOMER_SELECT_COLUMNS && !recUpdate.selectColumns.includes('*'),
)

// remove：from + delete + eq(customer_id) + select
const recRemove: MutationRecord = emptyMutationRecord()
const removeRes = await removeCustomer(makeFakeMutationRdb(okOutcome, recRemove), 7)
check('remove 成功返回 ok', removeRes.ok === true)
check('remove 使用 customers 表', recRemove.table === 'customers')
check('remove 走 delete（非 insert/update）', recRemove.deleted === true && recRemove.insertPayload === null && recRemove.updatePayload === null)
check('remove eq 精确 customer_id=7', recRemove.eqColumn === 'customer_id' && recRemove.eqValue === 7)
check(
  'remove select 精确列（非 *）',
  recRemove.selectColumns === CUSTOMER_SELECT_COLUMNS && !recRemove.selectColumns.includes('*'),
)

// ---- 17b. 非法出生年份不得调用 RDB（校验层在发起任何查询前 fail-closed）----
const recBadBirth: MutationRecord = emptyMutationRecord()
const createBadBirth = await createCustomer(makeFakeMutationRdb(okOutcome, recBadBirth), {
  ...testInput,
  birth_year: 1995.5,
})
check(
  'create 1995.5 → 拒绝且不调用 RDB',
  createBadBirth.ok === false && createBadBirth.field === 'birth_year' && recBadBirth.table === null,
)
const recBadBirthUpd: MutationRecord = emptyMutationRecord()
const updateBadBirth = await updateCustomer(makeFakeMutationRdb(okOutcome, recBadBirthUpd), 5, {
  ...testInput,
  birth_year: Infinity,
})
check(
  'update Infinity → 拒绝且不调用 RDB',
  updateBadBirth.ok === false && recBadBirthUpd.table === null,
)

// ===========================================================================
// 18. 影响行数恰好为 1：0 行失败、超过 1 行 fail-closed
// ===========================================================================
const zeroRows: FakeMutationOutcome = { kind: 'resolve', value: { data: [], error: null } }
const twoRows: FakeMutationOutcome = { kind: 'resolve', value: { data: [validRow, { ...validRow, customer_id: 2 }], error: null } }

const createZero = await createCustomer(makeFakeMutationRdb(zeroRows, emptyMutationRecord()), testInput)
check('create 0 行 → 失败', createZero.ok === false && createZero.error === SAFE_CUSTOMER_WRITE_ERROR)
const createTwo = await createCustomer(makeFakeMutationRdb(twoRows, emptyMutationRecord()), testInput)
check('create >1 行 → fail-closed', createTwo.ok === false && createTwo.error === SAFE_CUSTOMER_WRITE_ERROR)

const updateZero = await updateCustomer(makeFakeMutationRdb(zeroRows, emptyMutationRecord()), 5, testInput)
check('update 0 行 → 客户不存在', updateZero.ok === false && updateZero.error === CUSTOMER_NOT_FOUND_ERROR)
const updateTwo = await updateCustomer(makeFakeMutationRdb(twoRows, emptyMutationRecord()), 5, testInput)
check('update >1 行 → fail-closed', updateTwo.ok === false && updateTwo.error === SAFE_CUSTOMER_WRITE_ERROR)

const removeZero = await removeCustomer(makeFakeMutationRdb(zeroRows, emptyMutationRecord()), 7)
check('remove 0 行 → 客户不存在', removeZero.ok === false && removeZero.error === CUSTOMER_NOT_FOUND_ERROR)
const removeTwo = await removeCustomer(makeFakeMutationRdb(twoRows, emptyMutationRecord()), 7)
check('remove >1 行 → fail-closed', removeTwo.ok === false && removeTwo.error === SAFE_CUSTOMER_WRITE_ERROR)

// ===========================================================================
// 19. 安全错误映射：唯一冲突 / 外键引用 / RLS 拒绝 / 其他
// ===========================================================================
const emailDupOutcome: FakeMutationOutcome = {
  kind: 'resolve',
  value: {
    data: null,
    error: { code: '23505', message: 'duplicate key value violates unique constraint', details: 'Key (lower(btrim(email)))=(test@example.com) already exists.', hint: '' },
  },
}
const createDup = await createCustomer(makeFakeMutationRdb(emailDupOutcome, emptyMutationRecord()), testInput)
check('23505 → 邮箱冲突', createDup.ok === false && createDup.error === CUSTOMER_EMAIL_CONFLICT_ERROR && createDup.field === 'email')
check('邮箱冲突不泄露底层 details', createDup.ok === false && !createDup.error.includes('duplicate') && !createDup.error.includes('lower'))

const fkViolationOutcome: FakeMutationOutcome = {
  kind: 'resolve',
  value: {
    data: null,
    error: { code: '23503', message: 'update or delete on table customers violates foreign key constraint on table rental_contracts', details: 'Key (customer_id)=(1) is still referenced.', hint: '' },
  },
}
const removeFk = await removeCustomer(makeFakeMutationRdb(fkViolationOutcome, emptyMutationRecord()), 1)
check('23503 → 客户被合同引用', removeFk.ok === false && removeFk.error === CUSTOMER_REFERENCED_ERROR)
check('外键错误不泄露表结构', removeFk.ok === false && !removeFk.error.includes('rental_contracts') && !removeFk.error.includes('foreign key'))

const rlsDeniedOutcome: FakeMutationOutcome = {
  kind: 'resolve',
  value: {
    data: null,
    error: { code: '42501', message: 'new row violates row-level security policy', details: '', hint: '' },
  },
}
const createRls = await createCustomer(makeFakeMutationRdb(rlsDeniedOutcome, emptyMutationRecord()), testInput)
check('42501 → 无权限', createRls.ok === false && createRls.error === '无权限执行该操作')

const otherErrOutcome: FakeMutationOutcome = {
  kind: 'resolve',
  value: {
    data: null,
    error: { code: 'XX000', message: 'internal-secret-detail-here', details: 'hint-secret', hint: 'secret-hint' },
  },
}
const createOther = await createCustomer(makeFakeMutationRdb(otherErrOutcome, emptyMutationRecord()), testInput)
check('其他错误 → 统一安全文案', createOther.ok === false && createOther.error === SAFE_CUSTOMER_WRITE_ERROR)
check('其他错误不泄露底层细节', createOther.ok === false && !createOther.error.includes('secret') && !createOther.error.includes('hint'))

// SDK Promise reject（网络异常）：createCustomer 内部 catch 收口
const createReject = await createCustomer(makeFakeMutationRdb({ kind: 'reject' }, emptyMutationRecord()), testInput)
check('SDK Promise reject → 安全错误', createReject.ok === false && createReject.error === SAFE_CUSTOMER_WRITE_ERROR)

// 非法 customer_id：update/remove 在发起任何查询前 fail-closed
const recBadId: MutationRecord = emptyMutationRecord()
const updateBadId = await updateCustomer(makeFakeMutationRdb(okOutcome, recBadId), 0, testInput)
check('update 非法 id(0) → fail-closed 且不查询', updateBadId.ok === false && recBadId.table === null)
const removeBadId = await removeCustomer(makeFakeMutationRdb(okOutcome, recBadId), -1)
check('remove 非法 id(-1) → fail-closed 且不查询', removeBadId.ok === false && recBadId.table === null)

// ===========================================================================
// 20. 写操作分派：模式隔离 + getRdb 同步 throw / reject / 失败不回退本地
// ===========================================================================
let localCreateCalls = 0
let cloudCreateCalls = 0
let getRdbCalls = 0

const dispCloudCreate = await dispatchCustomerMutation(
  'cloud',
  () => {
    getRdbCalls++
    return makeFakeMutationRdb(okOutcome, emptyMutationRecord())
  },
  async (rdb) => {
    cloudCreateCalls++
    return createCustomer(rdb, testInput)
  },
  () => {
    localCreateCalls++
    return { ok: true as const, data: fakeLocalCustomer }
  },
  { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR },
)
check('cloud 写不调用 localRun', localCreateCalls === 0)
check('cloud 写调用 cloudRun 一次', cloudCreateCalls === 1)
check('cloud 写调用 getRdb 一次', getRdbCalls === 1)
check('cloud 写成功返回 ok', dispCloudCreate.ok === true)

localCreateCalls = 0
cloudCreateCalls = 0
const dispCloudFailCreate = await dispatchCustomerMutation(
  'cloud',
  () => {
    getRdbCalls++
    return makeFakeMutationRdb({ kind: 'resolve', value: { data: [], error: { code: 'XX000', message: 'boom' } } }, emptyMutationRecord())
  },
  async (rdb) => {
    cloudCreateCalls++
    return createCustomer(rdb, testInput)
  },
  () => {
    localCreateCalls++
    return { ok: true as const, data: fakeLocalCustomer }
  },
  { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR },
)
check('cloud 写失败不调用 localRun 回退', localCreateCalls === 0)
check('cloud 写失败返回 ok:false', dispCloudFailCreate.ok === false)

localCreateCalls = 0
const dispSyncThrowCreate = await dispatchCustomerMutation(
  'cloud',
  () => {
    throw new Error('getRdb-sync-internal')
  },
  async (rdb) => {
    cloudCreateCalls++
    return createCustomer(rdb, testInput)
  },
  () => {
    localCreateCalls++
    return { ok: true as const, data: fakeLocalCustomer }
  },
  { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR },
)
check('getRdb 同步 throw → 安全错误', dispSyncThrowCreate.ok === false && dispSyncThrowCreate.error === SAFE_CUSTOMER_WRITE_ERROR)
check('getRdb 同步 throw → 不调用 localRun', localCreateCalls === 0)

localCreateCalls = 0
const dispRejectCreate = await dispatchCustomerMutation(
  'cloud',
  () => ({} as CustomerRdbMutationClient),
  async () => {
    throw new Error('cloud-reject-internal')
  },
  () => {
    localCreateCalls++
    return { ok: true as const, data: fakeLocalCustomer }
  },
  { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR },
)
check('cloudRun reject → 安全错误', dispRejectCreate.ok === false && dispRejectCreate.error === SAFE_CUSTOMER_WRITE_ERROR)
check('cloudRun reject → 不调用 localRun', localCreateCalls === 0)

localCreateCalls = 0
cloudCreateCalls = 0
getRdbCalls = 0
const dispLocalCreate = await dispatchCustomerMutation(
  'local',
  () => {
    getRdbCalls++
    return {} as CustomerRdbMutationClient
  },
  async (rdb) => {
    cloudCreateCalls++
    return createCustomer(rdb, testInput)
  },
  () => {
    localCreateCalls++
    return { ok: true as const, data: fakeLocalCustomer }
  },
  { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR },
)
check('local 写调用 localRun 一次', localCreateCalls === 1)
check('local 写不调用 getRdb / cloudRun', getRdbCalls === 0 && cloudCreateCalls === 0)
check('local 写返回 localRun 结果', dispLocalCreate.ok === true)

// ===========================================================================
// 21. 并发：MutationLock 防重复提交 + LatestRequestGuard 旧查询不覆盖新结果
// ===========================================================================
const lock = new MutationLock()
check('MutationLock 首次 tryAcquire=true', lock.tryAcquire() === true)
check('MutationLock 已持锁 isLocked=true', lock.isLocked === true)
check('MutationLock 重复 tryAcquire=false（防重复提交）', lock.tryAcquire() === false)
lock.release()
check('MutationLock release 后 isLocked=false', lock.isLocked === false)
check('MutationLock release 后再次 tryAcquire=true', lock.tryAcquire() === true)
lock.release()

const guard = new LatestRequestGuard()
const t1 = guard.begin()
const t2 = guard.begin()
check('LatestRequestGuard 旧代次 isLatest=false（旧查询不覆盖）', guard.isLatest(t1) === false)
check('LatestRequestGuard 新代次 isLatest=true（mutation 后新查询可落地）', guard.isLatest(t2) === true)

// ===========================================================================
// 22. local 客户 CRUD 行为不回归
// ===========================================================================
const localBefore = dataService.listCustomers().length
const created = dataService.createCustomer('admin', {
  full_name: '测试临时客户',
  address: '测试地址',
  phone: '10086',
  email: null,
  birth_year: null,
  height_cm: null,
  weight_kg: null,
  shoe_size: null,
})
check('local createCustomer 成功', created.ok === true)
if (created.ok) {
  const tmpId = created.data.customer_id
  check('local create 后行数 +1', dataService.listCustomers().length === localBefore + 1)
  const upd = dataService.updateCustomer('admin', tmpId, {
    full_name: '测试临时客户2',
    address: '测试地址',
    phone: '10086',
    email: 'tmp-regression@example.com',
    birth_year: 2000,
    height_cm: null,
    weight_kg: null,
    shoe_size: null,
  })
  check('local updateCustomer 成功', upd.ok === true)
  const rm = dataService.removeCustomer('admin', tmpId)
  check('local removeCustomer 成功', rm.ok === true)
  check('local remove 后行数恢复', dataService.listCustomers().length === localBefore)
}
check(
  'local contractor createCustomer 被权限拒绝',
  dataService.createCustomer('contractor', {
    full_name: '越权',
    address: 'x',
    phone: 'x',
    email: null,
    birth_year: null,
    height_cm: null,
    weight_kg: null,
    shoe_size: null,
  }).ok === false,
)

// ===========================================================================
// 23. local 出生年份整数校验（与 cloud 同口径）
// ===========================================================================
const localBeforeBirth = dataService.listCustomers().length
const localBadBirthCreate = dataService.createCustomer('admin', {
  full_name: '出生年份非法',
  address: '测试地址',
  phone: '10086',
  email: null,
  birth_year: 1995.5,
  height_cm: null,
  weight_kg: null,
  shoe_size: null,
})
check('local create 拒绝 1995.5', localBadBirthCreate.ok === false)
check('local create 拒绝后行数不变', dataService.listCustomers().length === localBeforeBirth)

const anyCustomerId = dataService.listCustomers()[0]?.customer_id
if (anyCustomerId) {
  const localBadBirthUpdate = dataService.updateCustomer('admin', anyCustomerId, {
    full_name: '出生年份非法',
    address: '测试地址',
    phone: '10086',
    email: null,
    birth_year: 1995.5,
    height_cm: null,
    weight_kg: null,
    shoe_size: null,
  })
  check('local update 拒绝 1995.5', localBadBirthUpdate.ok === false)
}

// ===========================================================================
// 24. 刷新控制器：mutation 成功后立即失效旧读 token，再触发重读（正式刷新函数）
// ===========================================================================
{
  const refreshGuard = new LatestRequestGuard()
  let refetchCalls = 0
  const refresher = new CloudCustomerRefresh(
    refreshGuard,
    () => {
      refetchCalls++
    },
    () => true,
  )

  // 模拟一条在途读请求（旧 token）
  const oldToken = refreshGuard.begin()

  // 模拟 mutation 成功并调用正式刷新函数
  const okResult = { ok: true as const, data: fakeLocalCustomer }
  const returned = refresher.refreshIfNeeded(okResult, true)
  check('刷新后透传原结果', returned === okResult)
  check('刷新后旧 token 已失效（新 effect 尚未启动新查询前）', refreshGuard.isLatest(oldToken) === false)
  check('刷新触发 refetch 一次', refetchCalls === 1)
  check('刷新计数 = 1', refresher.refreshes === 1)

  // 模拟新 effect 启动新查询：新 token 为最新，可正常落地
  const newToken = refreshGuard.begin()
  check('新查询 token 为最新（可正常落地）', refresher.isLatest(newToken) === true)

  // mutation 失败不刷新
  refetchCalls = 0
  const failResult = { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR }
  refresher.refreshIfNeeded(failResult, true)
  check('mutation 失败不触发 refetch', refetchCalls === 0)
  check('mutation 失败刷新计数不变', refresher.refreshes === 1)

  // local 模式成功也不刷新
  refresher.refreshIfNeeded(okResult, false)
  check('local 模式成功不触发 refetch', refetchCalls === 0)
  check('local 模式刷新计数不变', refresher.refreshes === 1)
}

// ===========================================================================
// 24b. 刷新控制器：组件已卸载（active=false）不失效 token、不推进代次、不 refetch
// ===========================================================================
{
  const g = new LatestRequestGuard()
  let refetchCalls = 0
  let active = false
  const refresher = new CloudCustomerRefresh(
    g,
    () => {
      refetchCalls++
    },
    () => active,
  )

  const okResult = { ok: true as const, data: fakeLocalCustomer }
  const inFlightToken = g.begin() // 一条在途读请求

  // active=false + cloud success → refetch 0 次
  const returned = refresher.refreshIfNeeded(okResult, true)
  check('active=false + cloud 成功：透传原结果', returned === okResult)
  check('active=false + cloud 成功：refetch 0 次', refetchCalls === 0)
  check('active=false + cloud 成功：刷新计数 = 0', refresher.refreshes === 0)

  // active=false → 旧 token/代次不被无意义推进
  check('active=false：在途读 token 仍为最新（代次未推进）', g.isLatest(inFlightToken) === true)
  const sameTokenAfter = g.begin()
  check('active=false 后新查询代次仅 +1（未被刷新偷偷推进）', sameTokenAfter === inFlightToken + 1)

  // 再次调用仍不刷新（模拟卸载后 mutation 完成）
  const returned2 = refresher.refreshIfNeeded(okResult, true)
  check('active=false 二次调用仍不刷新', returned2 === okResult && refetchCalls === 0 && g.isLatest(sameTokenAfter) === true)
  check('active=false 二次调用刷新计数仍 = 0', refresher.refreshes === 0)

  // 切到 active=true + cloud success → 旧 token 立即失效、refetch 1 次
  active = true
  const beforeRefreshToken = g.begin()
  refresher.refreshIfNeeded(okResult, true)
  check('active=true + cloud 成功：旧 token 立即失效', g.isLatest(beforeRefreshToken) === false)
  check('active=true + cloud 成功：refetch 1 次', refetchCalls === 1)
  check('active=true + cloud 成功：刷新计数 = 1', refresher.refreshes === 1)

  // failure / local 仍不刷新（active=true 下）
  refetchCalls = 0
  const failResult = { ok: false as const, error: SAFE_CUSTOMER_WRITE_ERROR }
  refresher.refreshIfNeeded(failResult, true)
  check('active=true + 失败：不触发 refetch', refetchCalls === 0)
  refresher.refreshIfNeeded(okResult, false)
  check('active=true + local：不触发 refetch', refetchCalls === 0)
  check('active=true + 失败/local：刷新计数不变 = 1', refresher.refreshes === 1)
}

// ===========================================================================
// 24c. MutationLock 最终释放逻辑不回归（release 与活跃/卸载无关，始终可重入）
// ===========================================================================
{
  const lock = new MutationLock()
  check('MutationLock 初始未持锁', lock.isLocked === false)
  check('MutationLock tryAcquire=true', lock.tryAcquire() === true)
  check('MutationLock 已持锁 isLocked=true', lock.isLocked === true)
  // 模拟 mutation 完成后 finally 释放（无论组件是否卸载，release 无条件执行）
  lock.release()
  check('MutationLock release 后未持锁', lock.isLocked === false)
  check('MutationLock release 后可再次 tryAcquire（可重入）', lock.tryAcquire() === true)
  lock.release()
  check('MutationLock 二次 release 后未持锁（幂等）', lock.isLocked === false)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
