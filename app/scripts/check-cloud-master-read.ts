/**
 * 云端基础资料（门店 / 技能等级 / 设备）只读查询校验脚本
 * （由 validate-cloud-master-read.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:cloud-master-read
 *
 * 覆盖：
 * 1. 行映射 / 数值归一化 / nullable 保留 null / 枚举 / 严格日期校验 / 主键安全整数 / 重复 / 排序（纯逻辑）；
 * 2. 关联完整性：不存在门店 / 技能等级引用、配件技能等级规则；
 * 3. 真实 RDB 查询构造（注入 fake client 验证 from/select/order、绝不用 '*'、错误处理）；
 * 4. 三表联立：任一查询失败 → 整体安全错误，不返回部分数据、不回退本地；
 * 5. 数据源分派（计数型 fake reader 验证 local/cloud 调用次数、cloud 失败不回退本地）；
 * 6. safeCloudMasterLoad 边界（同步 throw / Promise reject 收口为安全错误）；
 * 7. 模式语义（resolveConfig 仅验证 mode，不涉及 UI 写入口）。
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
  mapCloudStores,
  mapCloudSkillLevels,
  mapCloudRentalItems,
  assembleCloudMaster,
  queryStores,
  querySkillLevels,
  queryRentalItems,
  queryMaster,
  STORE_SELECT_COLUMNS,
  SKILL_LEVEL_SELECT_COLUMNS,
  RENTAL_ITEM_SELECT_COLUMNS,
  SAFE_MASTER_ERROR,
} = await import('../src/data/cloudMaster')
type CloudStoreRow = import('../src/data/cloudMaster').CloudStoreRow
type CloudSkillLevelRow = import('../src/data/cloudMaster').CloudSkillLevelRow
type CloudRentalItemRow = import('../src/data/cloudMaster').CloudRentalItemRow
type MasterRdbClient = import('../src/data/cloudMaster').MasterRdbClient
const {
  dispatchMasterLoad,
  settleMasterRead,
  safeCloudMasterLoad,
} = await import('../src/data/masterDataSource')
type MasterDataSources = import('../src/data/masterDataSource').MasterDataSources
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
// 固定夹具
// ---------------------------------------------------------------------------
const storeIds = new Set([1, 2])
const levelIds = new Set([1, 2, 3, 4])

const validStore1: CloudStoreRow = {
  store_id: 1,
  store_name: '云顶东门店',
  address: '云顶滑雪度假区东入口 1 号',
  phone: '0755-81000001',
}
const validStore2: CloudStoreRow = {
  store_id: 2,
  store_name: '云顶西门店',
  address: '云顶滑雪度假区西索道下站 2 号',
  phone: '0755-81000002',
}

const validLevel1: CloudSkillLevelRow = { skill_level_id: 1, level_name: '初级', sort_order: 1 }
const validLevel2: CloudSkillLevelRow = { skill_level_id: 2, level_name: '中级', sort_order: 2 }
const validLevel3: CloudSkillLevelRow = { skill_level_id: 3, level_name: '高级', sort_order: 3 }
const validLevel4: CloudSkillLevelRow = { skill_level_id: 4, level_name: '专家+', sort_order: 4 }

const validItem: CloudRentalItemRow = {
  item_id: 1,
  item_code: 'SN0001',
  name: 'Head XTC 滑雪板 #1',
  description: '常规尺码',
  category: '滑雪板',
  purchase_date: '2025-11-15',
  purchase_cost: 1600,
  retail_price: 2400,
  daily_rate: 200,
  skill_level_id: 3,
  home_store_id: 1,
  current_store_id: 1,
  status: '借出中',
}
const validAccessory: CloudRentalItemRow = {
  item_id: 31,
  item_code: 'SN0031',
  name: '护目镜 #1',
  description: '常规尺码',
  category: '护目镜',
  purchase_date: '2025-11-15',
  purchase_cost: 200,
  retail_price: 300,
  daily_rate: 25,
  skill_level_id: null,
  home_store_id: 1,
  current_store_id: 1,
  status: '在库',
}
const validPole: CloudRentalItemRow = {
  item_id: 14,
  item_code: 'SN0014',
  name: '雪杖 #1',
  description: '成对出租',
  category: '雪杖',
  purchase_date: '2025-11-15',
  purchase_cost: 240,
  retail_price: 360,
  daily_rate: 30,
  skill_level_id: null,
  home_store_id: 2,
  current_store_id: 2,
  status: '在库',
}

const allStores = [validStore1, validStore2]
const allLevels = [validLevel1, validLevel2, validLevel3, validLevel4]

// ---------------- 1. 门店映射与归一化 ----------------
const s1 = mapCloudStores(allStores)
check('门店映射成功', s1.ok === true)
if (s1.ok) {
  check('门店条数 2', s1.stores.length === 2)
  check('门店 store_id=1', s1.stores[0].store_id === 1)
  check('门店 store_name', s1.stores[0].store_name === '云顶东门店')
  check('门店 address', s1.stores[0].address === '云顶滑雪度假区东入口 1 号')
  check('门店 phone', s1.stores[0].phone === '0755-81000001')
}

const s1str = mapCloudStores([{ ...validStore1, store_id: '1' }])
check('store_id 字符串归一化为 number', s1str.ok === true && s1str.stores[0].store_id === 1)

// 排序（乱序输入 → store_id 升序）
const s1sorted = mapCloudStores([
  { ...validStore2 },
  { ...validStore1 },
])
check(
  '门店按 store_id 升序',
  s1sorted.ok === true && s1sorted.stores.map((x) => x.store_id).join(',') === '1,2',
)

// nullable 策略：address/phone 云端可空，NULL 保留为 null（不 fail-closed、也不静默转空串）
const sNullAddr = mapCloudStores([{ ...validStore1, address: null }])
check('门店 address=null 保留为 null', sNullAddr.ok === true && sNullAddr.stores[0].address === null)
const sNullPhone = mapCloudStores([{ ...validStore1, phone: null }])
check('门店 phone=null 保留为 null', sNullPhone.ok === true && sNullPhone.stores[0].phone === null)
const sEmptyAddr = mapCloudStores([{ ...validStore1, address: '' }])
check('门店 address="" 保留为空串（与 null 区分）', sEmptyAddr.ok === true && sEmptyAddr.stores[0].address === '')

// 主键非法
check('store_id=0 拒绝', mapCloudStores([{ ...validStore1, store_id: 0 }]).ok === false)
check('store_id=-1 拒绝', mapCloudStores([{ ...validStore1, store_id: -1 }]).ok === false)
check('store_id=1.5 拒绝', mapCloudStores([{ ...validStore1, store_id: 1.5 }]).ok === false)
check('store_id=null 拒绝', mapCloudStores([{ ...validStore1, store_id: null }]).ok === false)

// bigint 精度：超过 Number.MAX_SAFE_INTEGER 的数字/字符串主键、外键必须 fail-closed
const OVER_SAFE = Number.MAX_SAFE_INTEGER + 1 // 9007199254740992（超出安全整数范围）
check('store_id 数字超安全整数拒绝', mapCloudStores([{ ...validStore1, store_id: OVER_SAFE }]).ok === false)
check('store_id 字符串超安全整数拒绝', mapCloudStores([{ ...validStore1, store_id: '9007199254740993' }]).ok === false)
check('skill_level_id 数字超安全整数拒绝', mapCloudSkillLevels([{ ...validLevel1, skill_level_id: OVER_SAFE }]).ok === false)
check('item_id 数字超安全整数拒绝', mapCloudRentalItems([{ ...validItem, item_id: OVER_SAFE }], storeIds, levelIds).ok === false)
check('home_store_id 字符串超安全整数拒绝', mapCloudRentalItems([{ ...validItem, home_store_id: '9007199254740993' }], storeIds, levelIds).ok === false)
// 正常小 ID 映射不回归（MAX_SAFE 边界本身仍合法）
check('store_id=Number.MAX_SAFE_INTEGER 通过', mapCloudStores([{ ...validStore1, store_id: Number.MAX_SAFE_INTEGER }]).ok === true)

// 名称非空
check('store_name="" 拒绝', mapCloudStores([{ ...validStore1, store_name: '' }]).ok === false)
check('store_name="  " 拒绝', mapCloudStores([{ ...validStore1, store_name: '  ' }]).ok === false)

// 重复主键
check('重复 store_id 拒绝', mapCloudStores([validStore1, { ...validStore1, store_name: '重复' }]).ok === false)

// 非数组
check('门店非数组拒绝', mapCloudStores(null).ok === false)

// ---------------- 2. 技能等级映射 ----------------
const l1 = mapCloudSkillLevels(allLevels)
check('技能等级映射成功', l1.ok === true)
if (l1.ok) {
  check('技能等级条数 4', l1.levels.length === 4)
  check('技能等级按 sort_order 升序', l1.levels.map((x) => x.skill_level_id).join(',') === '1,2,3,4')
  check('level_name 枚举映射', l1.levels[3].level_name === '专家+')
}

// 数值字符串归一化
const l1str = mapCloudSkillLevels([{ skill_level_id: '2', level_name: '中级', sort_order: '2' }])
check(
  'skill_level_id/sort_order 字符串归一化',
  l1str.ok === true && l1str.levels[0].skill_level_id === 2 && l1str.levels[0].sort_order === 2,
)

// 枚举非法
check('level_name 非法枚举拒绝', mapCloudSkillLevels([{ ...validLevel1, level_name: '大神' }]).ok === false)
// 重复主键
check('重复 skill_level_id 拒绝', mapCloudSkillLevels([validLevel1, { ...validLevel1, level_name: '中级' }]).ok === false)
// sort_order 非法
check('sort_order 非数值拒绝', mapCloudSkillLevels([{ ...validLevel1, sort_order: 'abc' }]).ok === false)

// ---------------- 3. 设备映射与归一化 ----------------
const i1 = mapCloudRentalItems([validItem], storeIds, levelIds)
check('设备映射成功', i1.ok === true)
if (i1.ok) {
  const it = i1.items[0]
  check('设备 item_id=1', it.item_id === 1)
  check('设备 item_code', it.item_code === 'SN0001')
  check('设备 name', it.name === 'Head XTC 滑雪板 #1')
  check('设备 description', it.description === '常规尺码')
  check('设备 category 枚举', it.category === '滑雪板')
  check('设备 purchase_cost=1600', it.purchase_cost === 1600)
  check('设备 retail_price=2400', it.retail_price === 2400)
  check('设备 daily_rate=200', it.daily_rate === 200)
  check('设备 skill_level_id=3', it.skill_level_id === 3)
  check('设备 home_store_id=1', it.home_store_id === 1)
  check('设备 current_store_id=1', it.current_store_id === 1)
  check('设备 status 枚举', it.status === '借出中')
}

// 数字字符串归一化
const i1str = mapCloudRentalItems(
  [{
    ...validItem,
    item_id: '1',
    purchase_cost: '1600',
    retail_price: '2400',
    daily_rate: '200',
    skill_level_id: '3',
    home_store_id: '1',
    current_store_id: '1',
  }],
  storeIds,
  levelIds,
)
check(
  '设备数字字符串归一化',
  i1str.ok === true &&
    i1str.items[0].item_id === 1 &&
    i1str.items[0].purchase_cost === 1600 &&
    i1str.items[0].daily_rate === 200 &&
    i1str.items[0].skill_level_id === 3,
)

// 配件规则：护目镜/头盔 skill_level_id 必须 NULL
const accOk = mapCloudRentalItems([validAccessory], storeIds, levelIds)
check('配件 skill_level_id=null 正常映射', accOk.ok === true && accOk.items[0].skill_level_id === null)
check(
  '配件设置 skill_level_id 拒绝',
  mapCloudRentalItems([{ ...validAccessory, skill_level_id: 3 }], storeIds, levelIds).ok === false,
)
// 非配件（雪杖）允许 skill_level_id=null
const poleOk = mapCloudRentalItems([validPole], storeIds, levelIds)
check('雪杖 skill_level_id=null 正常映射', poleOk.ok === true && poleOk.items[0].skill_level_id === null)

// nullable 策略：description/purchase_date/purchase_cost/retail_price 云端可空，NULL 保留为 null
const descNull = mapCloudRentalItems([{ ...validItem, description: null }], storeIds, levelIds)
check('设备 description=null 保留为 null', descNull.ok === true && descNull.items[0].description === null)
const dateNull = mapCloudRentalItems([{ ...validItem, purchase_date: null }], storeIds, levelIds)
check('设备 purchase_date=null 保留为 null', dateNull.ok === true && dateNull.items[0].purchase_date === null)
const costNull = mapCloudRentalItems([{ ...validItem, purchase_cost: null }], storeIds, levelIds)
check('设备 purchase_cost=null 保留为 null', costNull.ok === true && costNull.items[0].purchase_cost === null)
const retailNull = mapCloudRentalItems([{ ...validItem, retail_price: null }], storeIds, levelIds)
check('设备 retail_price=null 保留为 null', retailNull.ok === true && retailNull.items[0].retail_price === null)

// 严格日期校验：非空日期必须是严格 YYYY-MM-DD 真实日期（null 为合法未填写值）
const dateValid = mapCloudRentalItems([{ ...validItem, purchase_date: '2025-11-15' }], storeIds, levelIds)
check('合法日期 2025-11-15 通过', dateValid.ok === true && dateValid.items[0].purchase_date === '2025-11-15')
const dateLeap = mapCloudRentalItems([{ ...validItem, purchase_date: '2024-02-29' }], storeIds, levelIds)
check('合法闰日 2024-02-29 通过', dateLeap.ok === true && dateLeap.items[0].purchase_date === '2024-02-29')
check('非法日期 2026-02-30 拒绝', mapCloudRentalItems([{ ...validItem, purchase_date: '2026-02-30' }], storeIds, levelIds).ok === false)
check('非法日期 abc 拒绝', mapCloudRentalItems([{ ...validItem, purchase_date: 'abc' }], storeIds, levelIds).ok === false)
check('非法日期 2025-13-01 拒绝', mapCloudRentalItems([{ ...validItem, purchase_date: '2025-13-01' }], storeIds, levelIds).ok === false)
check('非法日期 20251115 拒绝', mapCloudRentalItems([{ ...validItem, purchase_date: '20251115' }], storeIds, levelIds).ok === false)
check('非法日期 2025-1-1 拒绝', mapCloudRentalItems([{ ...validItem, purchase_date: '2025-1-1' }], storeIds, levelIds).ok === false)

// 枚举非法
check('设备 category 非法拒绝', mapCloudRentalItems([{ ...validItem, category: '滑板车' }], storeIds, levelIds).ok === false)
check('设备 status 非法拒绝', mapCloudRentalItems([{ ...validItem, status: '丢失' }], storeIds, levelIds).ok === false)

// 主键非法
check('item_id=0 拒绝', mapCloudRentalItems([{ ...validItem, item_id: 0 }], storeIds, levelIds).ok === false)
check('item_id="abc" 拒绝', mapCloudRentalItems([{ ...validItem, item_id: 'abc' }], storeIds, levelIds).ok === false)

// 关联完整性：不存在门店 / 技能等级引用
check('home_store_id 不存在拒绝', mapCloudRentalItems([{ ...validItem, home_store_id: 99 }], storeIds, levelIds).ok === false)
check('current_store_id 不存在拒绝', mapCloudRentalItems([{ ...validItem, current_store_id: 99 }], storeIds, levelIds).ok === false)
check('skill_level_id 不存在拒绝', mapCloudRentalItems([{ ...validItem, skill_level_id: 99 }], storeIds, levelIds).ok === false)

// 重复主键
check('重复 item_id 拒绝', mapCloudRentalItems([validItem, { ...validItem, name: '重复' }], storeIds, levelIds).ok === false)

// 排序（item_id 升序）
const iSorted = mapCloudRentalItems(
  [{ ...validItem, item_id: 3 }, { ...validItem, item_id: 1 }, { ...validItem, item_id: 2 }],
  storeIds,
  levelIds,
)
check('设备按 item_id 升序', iSorted.ok === true && iSorted.items.map((x) => x.item_id).join(',') === '1,2,3')

// ---------------- 4. 三表联立组装 ----------------
const asm = assembleCloudMaster(allStores, allLevels, [validItem, validAccessory, validPole])
check('三表组装成功', asm.ok === true)
if (asm.ok) {
  check('组装 stores=2 / levels=4 / items=3', asm.stores.length === 2 && asm.skillLevels.length === 4 && asm.items.length === 3)
}

// 任一表失败 → 整体失败，不返回部分数据
const asmFail = assembleCloudMaster(null, allLevels, [validItem])
check('stores 失败 → 整体失败', asmFail.ok === false && !('stores' in asmFail) && !('items' in asmFail))
check('失败错误为安全错误', asmFail.ok === false && asmFail.error === SAFE_MASTER_ERROR)
const asmFail2 = assembleCloudMaster(allStores, allLevels, [{ ...validItem, current_store_id: 99 }])
check('items 引用不存在门店 → 整体失败', asmFail2.ok === false && !('items' in asmFail2))

// ---------------- 5. 真实 RDB 查询构造（单表 from/select/order） ----------------
interface Rec {
  table: string | null
  columns: string | null
  orderColumn: string | null
  orderAscending: boolean | null
}
function makeFake(
  outcome: { data: unknown; error: unknown } | 'throw',
  rec: Rec,
): MasterRdbClient {
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

const recStore: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryStores(makeFake({ data: allStores, error: null }, recStore))
check('queryStores from=stores', recStore.table === 'stores')
check('queryStores select 精确 4 列', recStore.columns === STORE_SELECT_COLUMNS)
check('queryStores 禁 select(*)', recStore.columns !== null && recStore.columns !== '*' && !recStore.columns!.includes('*'))
check('queryStores order store_id 升序', recStore.orderColumn === 'store_id' && recStore.orderAscending === true)

const recLevel: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await querySkillLevels(makeFake({ data: allLevels, error: null }, recLevel))
check('querySkillLevels from=skill_levels', recLevel.table === 'skill_levels')
check('querySkillLevels select 精确 3 列', recLevel.columns === SKILL_LEVEL_SELECT_COLUMNS)
check('querySkillLevels 禁 select(*)', recLevel.columns !== null && !recLevel.columns!.includes('*'))
check('querySkillLevels order sort_order 升序', recLevel.orderColumn === 'sort_order' && recLevel.orderAscending === true)

const recItem: Rec = { table: null, columns: null, orderColumn: null, orderAscending: null }
await queryRentalItems(makeFake({ data: [validItem], error: null }, recItem))
check('queryRentalItems from=rental_items', recItem.table === 'rental_items')
check('queryRentalItems select 精确 13 列', recItem.columns === RENTAL_ITEM_SELECT_COLUMNS)
check('queryRentalItems 禁 select(*)', recItem.columns !== null && !recItem.columns!.includes('*'))
check('queryRentalItems order item_id 升序', recItem.orderColumn === 'item_id' && recItem.orderAscending === true)

// ---------------- 6. queryMaster：三表联立 + fail-closed ----------------
interface Rec3 {
  table: string
  columns: string
  orderColumn: string
  orderAscending: boolean
}
function makeFake3(
  outcomes: Record<string, { data: unknown; error: unknown } | 'throw'>,
  records: Rec3[],
): MasterRdbClient {
  return {
    from(table: string) {
      const rec: Rec3 = { table, columns: '', orderColumn: '', orderAscending: false }
      records.push(rec)
      return {
        select(columns: string) {
          rec.columns = columns
          return {
            order(column: string, opts: { ascending: boolean }) {
              rec.orderColumn = column
              rec.orderAscending = opts.ascending
              const outcome = outcomes[table]
              if (outcome === 'throw') {
                return Promise.reject(new Error(`${table}-internal-boom`))
              }
              return Promise.resolve(outcome)
            },
          }
        },
      }
    },
  }
}

const recs3: Rec3[] = []
const qm = await queryMaster(makeFake3(
  {
    stores: { data: allStores, error: null },
    skill_levels: { data: allLevels, error: null },
    rental_items: { data: [validItem, validAccessory, validPole], error: null },
  },
  recs3,
))
check('queryMaster 成功返回三表', qm.ok === true && qm.ok && qm.stores.length === 2 && qm.items.length === 3)
check('queryMaster 依次 from stores/skill_levels/rental_items',
  recs3.length === 3 && recs3[0].table === 'stores' && recs3[1].table === 'skill_levels' && recs3[2].table === 'rental_items')
check('queryMaster 三表均升序 order', recs3.every((r) => r.orderAscending === true))

// 任一表返回 error → 整体失败，不返回部分数据
const recsErr: Rec3[] = []
const qmErr = await queryMaster(makeFake3(
  {
    stores: { data: allStores, error: null },
    skill_levels: { data: allLevels, error: null },
    rental_items: { data: null, error: new Error('secret-internal-detail') },
  },
  recsErr,
))
check('关联查询失败 → 整体失败', qmErr.ok === false && qmErr.error === SAFE_MASTER_ERROR)
check('关联查询失败 → 不含部分数据', qmErr.ok === false && !('stores' in qmErr) && !('items' in qmErr))
check('关联查询失败 → 不泄露底层细节', qmErr.ok === false && !qmErr.error.includes('secret'))

// 任一表 Promise reject（SDK 抛异常）→ 整体失败
const recsThrow: Rec3[] = []
const qmThrow = await queryMaster(makeFake3(
  {
    stores: { data: allStores, error: null },
    skill_levels: { data: allLevels, error: null },
    rental_items: 'throw',
  },
  recsThrow,
))
check('SDK 抛异常 → 整体失败安全错误', qmThrow.ok === false && qmThrow.error === SAFE_MASTER_ERROR)
check('SDK 抛异常 → 不泄露底层细节', qmThrow.ok === false && !qmThrow.error.includes('boom'))

// ---------------- 7. 数据源分派：计数型 fake reader ----------------
const fakeStore = { store_id: 999, store_name: 'Fake门店', address: 'x', phone: 'x' }
const fakeLevel = { skill_level_id: 999, level_name: '初级' as const, sort_order: 999 }
const fakeItem = {
  item_id: 999,
  item_code: 'FAKE',
  name: 'Fake设备',
  description: 'x',
  category: '滑雪板' as const,
  purchase_date: '2025-11-15',
  purchase_cost: 1,
  retail_price: 2,
  daily_rate: 3,
  skill_level_id: null,
  home_store_id: 999,
  current_store_id: 999,
  status: '在库' as const,
}
let localStoreCalls = 0
let localLevelCalls = 0
let localItemCalls = 0
let cloudCalls = 0
const sources: MasterDataSources = {
  localReadStores: () => {
    localStoreCalls++
    return [fakeStore]
  },
  localReadSkillLevels: () => {
    localLevelCalls++
    return [fakeLevel]
  },
  localReadItems: () => {
    localItemCalls++
    return [fakeItem]
  },
  cloudReadMaster: () => {
    cloudCalls++
    return Promise.resolve({ ok: true, stores: [], skillLevels: [], items: [] })
  },
}

const dispLocal = dispatchMasterLoad('local', sources)
check('local 模式 kind=local', dispLocal.kind === 'local')
check('local 模式调用三个本地 reader 各一次', localStoreCalls === 1 && localLevelCalls === 1 && localItemCalls === 1)
check('local 模式不调用云 reader', cloudCalls === 0)
if (dispLocal.kind === 'local') {
  check('local 模式返回本地基础资料', dispLocal.data.stores.length === 1 && dispLocal.data.items.length === 1)
}

localStoreCalls = 0
localLevelCalls = 0
localItemCalls = 0
cloudCalls = 0
const dispCloud = dispatchMasterLoad('cloud', sources)
check('cloud 模式 kind=cloud', dispCloud.kind === 'cloud')
check('cloud 模式本地 reader 调用 0 次', localStoreCalls === 0 && localLevelCalls === 0 && localItemCalls === 0)
check('cloud 模式调用云 reader 一次', cloudCalls === 1)
if (dispCloud.kind === 'cloud') {
  const cloudResult = await dispCloud.promise
  check('cloud 模式 promise 正常 resolve 成功结果', cloudResult.ok === true && cloudResult.items.length === 0)
}

// ---------------- 8. settleMasterRead ----------------
const settledFail = settleMasterRead({ ok: false, error: SAFE_MASTER_ERROR })
check('cloud 失败落地为安全错误', settledFail.error === SAFE_MASTER_ERROR)
check('cloud 失败返回空基础资料（不回退本地）', settledFail.data.stores.length === 0 && settledFail.data.items.length === 0)
const settledOk = settleMasterRead({ ok: true, stores: [fakeStore], skillLevels: [fakeLevel], items: [fakeItem] })
check('cloud 成功落地为基础资料', settledOk.data.stores.length === 1 && settledOk.error === null)

// ---------------- 9. safeCloudMasterLoad 边界 ----------------
const syncResult = await safeCloudMasterLoad({
  cloudReadMaster: () => {
    throw new Error('getRdb-sync-boom')
  },
})
check('safeCloudMasterLoad 同步 throw → 安全错误', syncResult.ok === false && syncResult.error === SAFE_MASTER_ERROR)
const rejResult = await safeCloudMasterLoad({
  cloudReadMaster: () => Promise.reject(new Error('network-reject-detail')),
})
check('safeCloudMasterLoad Promise reject → 安全错误', rejResult.ok === false && rejResult.error === SAFE_MASTER_ERROR)

// cloudReadMaster 同步 throw 时 dispatch 不抛出，且本地 reader 0 次
let syncLocalStore = 0
let syncDispatchThrew = false
let syncDispatch: ReturnType<typeof dispatchMasterLoad> | null = null
try {
  syncDispatch = dispatchMasterLoad('cloud', {
    localReadStores: () => {
      syncLocalStore++
      return [fakeStore]
    },
    localReadSkillLevels: () => [fakeLevel],
    localReadItems: () => [fakeItem],
    cloudReadMaster: () => {
      throw new Error('sync-boom-detail')
    },
  })
} catch {
  syncDispatchThrew = true
}
check('cloudReadMaster 同步 throw：dispatch 不抛出', !syncDispatchThrew && syncDispatch?.kind === 'cloud')
check('cloudReadMaster 同步 throw：本地 reader 0 次', syncLocalStore === 0)

// ---------------- 10. local 模式仍读取 DataService ----------------
const initResult = dataService.init()
const localStores = initResult.ok ? dataService.listStores() : []
const localLevels = initResult.ok ? dataService.listSkillLevels() : []
const localItems = initResult.ok ? dataService.listItems() : []
check('local DataService 返回 2 家门店', localStores.length === 2)
check('local DataService 返回 4 个技能等级', localLevels.length === 4)
check('local DataService 返回 36 件设备', localItems.length === 36)

// ---------------- 11. 模式语义（仅配置 mode，不涉及 UI 写入口） ----------------
const cloudCfg = resolveConfig({
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-id',
  VITE_CLOUDBASE_REGION: 'ap-shanghai',
  VITE_CLOUDBASE_ACCESS_KEY: 'publishable-key',
})
check('cloud 配置 → mode=cloud', cloudCfg.ok === true && cloudCfg.mode === 'cloud')
const localCfg = resolveConfig({})
check('local 配置 → mode=local', localCfg.ok === true && localCfg.mode === 'local')

// ---------------- 12. 证明未读取 .env.local ----------------
const meta = import.meta as unknown as { env?: unknown }
check('Node 测试上下文无 import.meta.env（不加载 .env.local）', meta.env === undefined)

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
