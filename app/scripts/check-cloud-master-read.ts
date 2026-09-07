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
type RentalItemView = import('../src/data/cloudMaster').RentalItemView
const {
  dispatchMasterLoad,
  settleMasterRead,
  safeCloudMasterLoad,
  dispatchMasterMutation,
  dispatchMasterItemMutation,
  toLocalItemInput,
  MutationLock,
  CloudMasterRefresh,
} = await import('../src/data/masterDataSource')
type MasterDataSources = import('../src/data/masterDataSource').MasterDataSources
const {
  buildItemPayload,
  validateItemFields,
  validateItemBasics,
  ITEM_CATEGORIES,
  createItem,
  updateItem,
  removeItem,
  isPositiveSafeInt,
  SAFE_ITEM_WRITE_ERROR,
  ITEM_CODE_CONFLICT_ERROR,
  ITEM_REFERENCE_MISSING_ERROR,
  ITEM_REFERENCED_ERROR,
  ITEM_CHECK_VIOLATION_ERROR,
  ITEM_UPDATE_NOT_FOUND_ERROR,
  ITEM_DELETE_NOT_FOUND_ERROR,
} = await import('../src/data/cloudItemMutations')
type RentalItemCloudInput = import('../src/data/cloudItemMutations').RentalItemCloudInput
type ItemRdbMutationClient = import('../src/data/cloudItemMutations').ItemRdbMutationClient
type ItemMutationBuilder = import('../src/data/cloudItemMutations').ItemMutationBuilder
type ItemCategory = import('../src/data/types').ItemCategory
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

// ===========================================================================
// 13. 设备写操作：payload 归一化与字段校验（纯逻辑）
// ===========================================================================
const itemStoreIds = new Set([1, 2])
const itemLevelIds = new Set([1, 2, 3, 4])
const testItemInput: RentalItemCloudInput = {
  item_code: ' SN0037 ',
  name: ' 测试滑雪板 ',
  description: ' 测试描述 ',
  category: '滑雪板',
  purchase_date: '2025-12-01',
  purchase_cost: 1000,
  retail_price: 1500,
  daily_rate: 120,
  skill_level_id: 3,
  home_store_id: 1,
  current_store_id: 1,
}

const payload = buildItemPayload(testItemInput)
check('payload 不含 item_id', !('item_id' in payload))
check('payload 不含 status', !('status' in payload))
check('payload 不含 role', !('role' in payload))
check('payload 不含 uid', !('uid' in payload))
check('payload 不含 account_id', !('account_id' in payload))
check('payload 不含 actorRole', !('actorRole' in payload))
check('payload item_code trim', payload.item_code === 'SN0037')
check('payload name trim', payload.name === '测试滑雪板')
check('payload description trim', payload.description === '测试描述')
check('payload 数值保留', payload.daily_rate === 120 && payload.purchase_cost === 1000)

const nullPayload = buildItemPayload({
  ...testItemInput,
  description: null,
  purchase_date: null,
  purchase_cost: null,
  retail_price: null,
  skill_level_id: null,
})
check('payload description=null 保留', nullPayload.description === null)
check('payload purchase_date=null 保留', nullPayload.purchase_date === null)
check('payload purchase_cost=null 保留', nullPayload.purchase_cost === null)
check('payload retail_price=null 保留', nullPayload.retail_price === null)
check('payload skill_level_id=null 保留', nullPayload.skill_level_id === null)
const blankPayload = buildItemPayload({ ...testItemInput, description: '   ', purchase_date: '  ' })
check('payload description 空串 → null', blankPayload.description === null)
check('payload purchase_date 空串 → null', blankPayload.purchase_date === null)

// 字段校验
const vCode = validateItemFields({ ...testItemInput, item_code: '  ' }, itemStoreIds, itemLevelIds)
check('空 item_code → field item_code', vCode.ok === false && vCode.field === 'item_code')
const vName = validateItemFields({ ...testItemInput, name: '' }, itemStoreIds, itemLevelIds)
check('空 name → field name', vName.ok === false && vName.field === 'name')
const vRate = validateItemFields({ ...testItemInput, daily_rate: -1 }, itemStoreIds, itemLevelIds)
check('daily_rate 负 → field daily_rate', vRate.ok === false && vRate.field === 'daily_rate')
check('daily_rate NaN → field daily_rate', validateItemFields({ ...testItemInput, daily_rate: NaN }, itemStoreIds, itemLevelIds).ok === false)
const vCost = validateItemFields({ ...testItemInput, purchase_cost: -5 }, itemStoreIds, itemLevelIds)
check('purchase_cost 负 → field purchase_cost', vCost.ok === false && vCost.field === 'purchase_cost')
const vRetail = validateItemFields({ ...testItemInput, retail_price: Infinity }, itemStoreIds, itemLevelIds)
check('retail_price Infinity → field retail_price', vRetail.ok === false && vRetail.field === 'retail_price')
const vDate = validateItemFields({ ...testItemInput, purchase_date: '2026-02-30' }, itemStoreIds, itemLevelIds)
check('purchase_date 非法日期 → field purchase_date', vDate.ok === false && vDate.field === 'purchase_date')
const vDate2 = validateItemFields({ ...testItemInput, purchase_date: '2025-1-1' }, itemStoreIds, itemLevelIds)
check('purchase_date 非严格格式 → field purchase_date', vDate2.ok === false && vDate2.field === 'purchase_date')
const vHome = validateItemFields({ ...testItemInput, home_store_id: 0 }, itemStoreIds, itemLevelIds)
check('home_store_id=0 → field home_store_id', vHome.ok === false && vHome.field === 'home_store_id')
const vHomeNot = validateItemFields({ ...testItemInput, home_store_id: 99 }, itemStoreIds, itemLevelIds)
check('home_store_id 不存在 → field home_store_id', vHomeNot.ok === false && vHomeNot.field === 'home_store_id')
const vCur = validateItemFields({ ...testItemInput, current_store_id: 99 }, itemStoreIds, itemLevelIds)
check('current_store_id 不存在 → field current_store_id', vCur.ok === false && vCur.field === 'current_store_id')
const vAcc = validateItemFields({ ...testItemInput, category: '护目镜', skill_level_id: 3 }, itemStoreIds, itemLevelIds)
check('配件 skill_level_id 非 null → field skill_level_id', vAcc.ok === false && vAcc.field === 'skill_level_id')
const vLvl = validateItemFields({ ...testItemInput, skill_level_id: 99 }, itemStoreIds, itemLevelIds)
check('非配件 skill_level_id 不存在 → field skill_level_id', vLvl.ok === false && vLvl.field === 'skill_level_id')
check('合法输入校验通过', validateItemFields(testItemInput, itemStoreIds, itemLevelIds).ok === true)
check('非配件 skill_level_id=null 通过', validateItemFields({ ...testItemInput, skill_level_id: null }, itemStoreIds, itemLevelIds).ok === true)
check('配件 skill_level_id=null 通过', validateItemFields({ ...testItemInput, category: '头盔', skill_level_id: null }, itemStoreIds, itemLevelIds).ok === true)
check('purchase_date=null 通过', validateItemFields({ ...testItemInput, purchase_date: null }, itemStoreIds, itemLevelIds).ok === true)

check('isPositiveSafeInt(1)=true', isPositiveSafeInt(1) === true)
check('isPositiveSafeInt(0)=false', isPositiveSafeInt(0) === false)
check('isPositiveSafeInt(-1)=false', isPositiveSafeInt(-1) === false)
check('isPositiveSafeInt(1.5)=false', isPositiveSafeInt(1.5) === false)
check('isPositiveSafeInt(NaN)=false', isPositiveSafeInt(NaN) === false)
check('isPositiveSafeInt(MAX_SAFE_INTEGER)=true', isPositiveSafeInt(Number.MAX_SAFE_INTEGER) === true)
check('isPositiveSafeInt(MAX_SAFE_INTEGER+1)=false', isPositiveSafeInt(Number.MAX_SAFE_INTEGER + 1) === false)

// ===========================================================================
// 14. 设备写操作：真实调用链（fake RDB 记录 from/insert/update/delete/eq/select）
// ===========================================================================
type ItemMutationOutcome =
  | { kind: 'resolve'; value: { data: unknown; error: unknown } }
  | { kind: 'reject' }
interface ItemMutationRecord {
  table: string | null
  insertPayload: Record<string, unknown> | null
  updatePayload: Record<string, unknown> | null
  deleted: boolean
  eqColumn: string | null
  eqValue: unknown
  selectColumns: string | null
}
function emptyItemRecord(): ItemMutationRecord {
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
function makeFakeItemRdb(
  outcome: ItemMutationOutcome,
  record: ItemMutationRecord,
): ItemRdbMutationClient {
  function makeBuilder(): ItemMutationBuilder {
    const builder = {} as ItemMutationBuilder
    builder.eq = (column: string, value: unknown) => {
      record.eqColumn = column
      record.eqValue = value
      return builder
    }
    builder.select = (columns: string) => {
      record.selectColumns = columns
      return builder
    }
    builder.then = (onFulfilled?: (v: { data: unknown; error: unknown }) => unknown, onRejected?: (r: unknown) => unknown) => {
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

const itemOkOutcome: ItemMutationOutcome = {
  kind: 'resolve',
  value: { data: [{ ...validItem, status: '在库' }], error: null },
}

// create：from + insert + select，无 eq；返回 status='在库'
const recCreate: ItemMutationRecord = emptyItemRecord()
const createRes = await createItem(makeFakeItemRdb(itemOkOutcome, recCreate), testItemInput, itemStoreIds, itemLevelIds)
check('create 成功返回 ok', createRes.ok === true)
check('create 返回 status=在库', createRes.ok === true && createRes.data.status === '在库')
check('create 使用 rental_items 表', recCreate.table === 'rental_items')
check('create 走 insert（非 update/delete）', recCreate.insertPayload !== null && recCreate.updatePayload === null && recCreate.deleted === false)
check('create payload 无越权字段', recCreate.insertPayload !== null && !('item_id' in recCreate.insertPayload) && !('status' in recCreate.insertPayload) && !('role' in recCreate.insertPayload) && !('uid' in recCreate.insertPayload))
check('create 不设置 eq', recCreate.eqColumn === null)
check('create select 精确列（非 *）', recCreate.selectColumns === RENTAL_ITEM_SELECT_COLUMNS && !recCreate.selectColumns!.includes('*'))

// create 返回非在库 → fail-closed（不得伪造状态）
const recCreateBadStatus: ItemMutationRecord = emptyItemRecord()
const createBadStatus = await createItem(
  makeFakeItemRdb({ kind: 'resolve', value: { data: [{ ...validItem, status: '借出中' }], error: null } }, recCreateBadStatus),
  testItemInput,
  itemStoreIds,
  itemLevelIds,
)
check('create 返回非在库 → fail-closed', createBadStatus.ok === false && createBadStatus.error === SAFE_ITEM_WRITE_ERROR)

// update：from + update + eq(item_id) + select；payload 无 status，返回行 status 为数据库真实状态
const recUpdate: ItemMutationRecord = emptyItemRecord()
const updateRes = await updateItem(
  makeFakeItemRdb({ kind: 'resolve', value: { data: [{ ...validItem, status: '借出中' }], error: null } }, recUpdate),
  5,
  testItemInput,
  itemStoreIds,
  itemLevelIds,
)
check('update 成功返回 ok', updateRes.ok === true)
check('update 返回数据库真实 status（借出中，不伪造）', updateRes.ok === true && updateRes.data.status === '借出中')
check('update 使用 rental_items 表', recUpdate.table === 'rental_items')
check('update 走 update（非 insert/delete）', recUpdate.updatePayload !== null && recUpdate.insertPayload === null && recUpdate.deleted === false)
check('update payload 无 item_id/status', recUpdate.updatePayload !== null && !('item_id' in recUpdate.updatePayload) && !('status' in recUpdate.updatePayload))
check('update eq 精确 item_id=5', recUpdate.eqColumn === 'item_id' && recUpdate.eqValue === 5)
check('update select 精确列（非 *）', recUpdate.selectColumns === RENTAL_ITEM_SELECT_COLUMNS && !recUpdate.selectColumns!.includes('*'))

// remove：from + delete + eq(item_id) + select
const recRemove: ItemMutationRecord = emptyItemRecord()
const removeRes = await removeItem(makeFakeItemRdb({ kind: 'resolve', value: { data: [{ ...validItem }], error: null } }, recRemove), 7)
check('remove 成功返回 ok', removeRes.ok === true)
check('remove 使用 rental_items 表', recRemove.table === 'rental_items')
check('remove 走 delete（非 insert/update）', recRemove.deleted === true && recRemove.insertPayload === null && recRemove.updatePayload === null)
check('remove eq 精确 item_id=7', recRemove.eqColumn === 'item_id' && recRemove.eqValue === 7)
check('remove select 精确列（非 *）', recRemove.selectColumns === RENTAL_ITEM_SELECT_COLUMNS && !recRemove.selectColumns!.includes('*'))

// 非法 item_id：update/remove 在发起任何查询前 fail-closed
const recBadId: ItemMutationRecord = emptyItemRecord()
const updateBadId = await updateItem(makeFakeItemRdb(itemOkOutcome, recBadId), 0, testItemInput, itemStoreIds, itemLevelIds)
check('update 非法 id(0) → fail-closed 且不查询', updateBadId.ok === false && recBadId.table === null)
const recBadId2: ItemMutationRecord = emptyItemRecord()
const removeBadId = await removeItem(makeFakeItemRdb(itemOkOutcome, recBadId2), -1)
check('remove 非法 id(-1) → fail-closed 且不查询', removeBadId.ok === false && recBadId2.table === null)

// ===========================================================================
// 15. 影响行数恰好为 1：0 行失败（update/delete 语义不同）、超过 1 行 fail-closed
// ===========================================================================
const zeroRows: ItemMutationOutcome = { kind: 'resolve', value: { data: [], error: null } }
const twoRows: ItemMutationOutcome = {
  kind: 'resolve',
  value: { data: [{ ...validItem }, { ...validItem, item_id: 2 }], error: null },
}
const createZero = await createItem(makeFakeItemRdb(zeroRows, emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('create 0 行 → 失败', createZero.ok === false && createZero.error === SAFE_ITEM_WRITE_ERROR)
const createTwo = await createItem(makeFakeItemRdb(twoRows, emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('create >1 行 → fail-closed', createTwo.ok === false && createTwo.error === SAFE_ITEM_WRITE_ERROR)

const updateZero = await updateItem(makeFakeItemRdb(zeroRows, emptyItemRecord()), 5, testItemInput, itemStoreIds, itemLevelIds)
check('update 0 行 → 不存在或无权限', updateZero.ok === false && updateZero.error === ITEM_UPDATE_NOT_FOUND_ERROR)
const updateTwo = await updateItem(makeFakeItemRdb(twoRows, emptyItemRecord()), 5, testItemInput, itemStoreIds, itemLevelIds)
check('update >1 行 → fail-closed', updateTwo.ok === false && updateTwo.error === SAFE_ITEM_WRITE_ERROR)

const removeZero = await removeItem(makeFakeItemRdb(zeroRows, emptyItemRecord()), 7)
check('remove 0 行 → 不存在/状态变化/无权限', removeZero.ok === false && removeZero.error === ITEM_DELETE_NOT_FOUND_ERROR)
const removeTwo = await removeItem(makeFakeItemRdb(twoRows, emptyItemRecord()), 7)
check('remove >1 行 → fail-closed', removeTwo.ok === false && removeTwo.error === SAFE_ITEM_WRITE_ERROR)

// ===========================================================================
// 16. 安全错误映射：23505 / 23503（写 vs 删）/ 23514 / 42501 / 其他
// ===========================================================================
function errOutcome(code: string, message: string): ItemMutationOutcome {
  return {
    kind: 'resolve',
    value: { data: null, error: { code, message, details: 'secret-details', hint: 'secret-hint' } },
  }
}
const createDup = await createItem(makeFakeItemRdb(errOutcome('23505', 'dup'), emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('23505 → 库存编号冲突', createDup.ok === false && createDup.error === ITEM_CODE_CONFLICT_ERROR && createDup.field === 'item_code')
check('23505 不泄露底层 details', createDup.ok === false && !createDup.error.includes('dup') && !createDup.error.includes('secret'))

const createFk = await createItem(makeFakeItemRdb(errOutcome('23503', 'fk'), emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('23503 写 → 门店/技能等级不存在', createFk.ok === false && createFk.error === ITEM_REFERENCE_MISSING_ERROR)
const updateFk = await updateItem(makeFakeItemRdb(errOutcome('23503', 'fk'), emptyItemRecord()), 5, testItemInput, itemStoreIds, itemLevelIds)
check('23503 update → 门店/技能等级不存在', updateFk.ok === false && updateFk.error === ITEM_REFERENCE_MISSING_ERROR)
const removeFk = await removeItem(makeFakeItemRdb(errOutcome('23503', 'fk'), emptyItemRecord()), 1)
check('23503 删 → 设备被引用', removeFk.ok === false && removeFk.error === ITEM_REFERENCED_ERROR)
check('23503 不泄露表结构', removeFk.ok === false && !removeFk.error.includes('fk') && !removeFk.error.includes('secret'))

const createCheck = await createItem(makeFakeItemRdb(errOutcome('23514', 'check'), emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('23514 → CHECK 违例', createCheck.ok === false && createCheck.error === ITEM_CHECK_VIOLATION_ERROR)
const createRls = await createItem(makeFakeItemRdb(errOutcome('42501', 'rls'), emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('42501 → 无权限', createRls.ok === false && createRls.error === '无权限执行该操作')
const createOther = await createItem(makeFakeItemRdb(errOutcome('XX000', 'internal-secret'), emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('其他错误 → 统一安全文案', createOther.ok === false && createOther.error === SAFE_ITEM_WRITE_ERROR)
check('其他错误不泄露底层细节', createOther.ok === false && !createOther.error.includes('secret') && !createOther.error.includes('internal'))
const createReject = await createItem(makeFakeItemRdb({ kind: 'reject' }, emptyItemRecord()), testItemInput, itemStoreIds, itemLevelIds)
check('SDK Promise reject → 安全错误', createReject.ok === false && createReject.error === SAFE_ITEM_WRITE_ERROR)

// 非法字段不得调用 RDB（校验层在发起任何查询前 fail-closed）
const recBadField: ItemMutationRecord = emptyItemRecord()
const createBadField = await createItem(
  makeFakeItemRdb(itemOkOutcome, recBadField),
  { ...testItemInput, purchase_date: '2026-02-30' },
  itemStoreIds,
  itemLevelIds,
)
check('create 非法日期 → 拒绝且不调用 RDB', createBadField.ok === false && createBadField.field === 'purchase_date' && recBadField.table === null)

// ===========================================================================
// 17. 写操作分派：模式隔离 + getRdb 同步 throw / reject / 失败不回退本地
// ===========================================================================
let localItemCreateCalls = 0
let cloudItemCreateCalls = 0
let getRdbCalls = 0
const fakeCreatedView = { ...fakeItem, item_id: 1 } as unknown as RentalItemView

const dispCloudCreate = await dispatchMasterMutation(
  'cloud',
  () => {
    getRdbCalls++
    return makeFakeItemRdb(itemOkOutcome, emptyItemRecord())
  },
  async (rdb) => {
    cloudItemCreateCalls++
    return createItem(rdb, testItemInput, itemStoreIds, itemLevelIds)
  },
  () => {
    localItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  { ok: false as const, error: SAFE_ITEM_WRITE_ERROR },
)
check('cloud 写不调用 localRun', localItemCreateCalls === 0)
check('cloud 写调用 cloudRun 一次', cloudItemCreateCalls === 1)
check('cloud 写调用 getRdb 一次', getRdbCalls === 1)
check('cloud 写成功返回 ok', dispCloudCreate.ok === true)

localItemCreateCalls = 0
const dispSyncThrowCreate = await dispatchMasterMutation(
  'cloud',
  () => {
    throw new Error('getRdb-sync-internal')
  },
  async () => {
    cloudItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  () => {
    localItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  { ok: false as const, error: SAFE_ITEM_WRITE_ERROR },
)
check('getRdb 同步 throw → 安全错误', dispSyncThrowCreate.ok === false && dispSyncThrowCreate.error === SAFE_ITEM_WRITE_ERROR)
check('getRdb 同步 throw → 不调用 localRun', localItemCreateCalls === 0)

localItemCreateCalls = 0
const dispRejectCreate = await dispatchMasterMutation(
  'cloud',
  () => ({} as ItemRdbMutationClient),
  async () => {
    throw new Error('cloud-reject-internal')
  },
  () => {
    localItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  { ok: false as const, error: SAFE_ITEM_WRITE_ERROR },
)
check('cloudRun reject → 安全错误', dispRejectCreate.ok === false && dispRejectCreate.error === SAFE_ITEM_WRITE_ERROR)
check('cloudRun reject → 不调用 localRun', localItemCreateCalls === 0)

localItemCreateCalls = 0
cloudItemCreateCalls = 0
getRdbCalls = 0
const dispLocalCreate = await dispatchMasterMutation(
  'local',
  () => {
    getRdbCalls++
    return {} as ItemRdbMutationClient
  },
  async () => {
    cloudItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  () => {
    localItemCreateCalls++
    return { ok: true as const, data: fakeCreatedView }
  },
  { ok: false as const, error: SAFE_ITEM_WRITE_ERROR },
)
check('local 写调用 localRun 一次', localItemCreateCalls === 1)
check('local 写不调用 getRdb / cloudRun', getRdbCalls === 0 && cloudItemCreateCalls === 0)
check('local 写返回 localRun 结果', dispLocalCreate.ok === true)

// ===========================================================================
// 18. local/cloud 输入转换边界：cloud 可空 → local 非空
// ===========================================================================
const localConverted = toLocalItemInput({
  ...testItemInput,
  description: null,
  purchase_date: null,
  purchase_cost: null,
  retail_price: null,
})
check('toLocalItemInput description null → ""', localConverted.description === '')
check('toLocalItemInput purchase_date null → ""', localConverted.purchase_date === '')
check('toLocalItemInput purchase_cost null → 0', localConverted.purchase_cost === 0)
check('toLocalItemInput retail_price null → 0', localConverted.retail_price === 0)
check('toLocalItemInput 非空字段原样透传', localConverted.item_code === testItemInput.item_code && localConverted.daily_rate === 120 && localConverted.skill_level_id === 3)

// ===========================================================================
// 19. 并发：MutationLock 防重复提交 + CloudMasterRefresh 旧 token 失效 / 卸载不刷新
// ===========================================================================
const itemLock = new MutationLock()
check('MutationLock 首次 tryAcquire=true', itemLock.tryAcquire() === true)
check('MutationLock 已持锁 isLocked=true', itemLock.isLocked === true)
check('MutationLock 重复 tryAcquire=false（防重复提交）', itemLock.tryAcquire() === false)
itemLock.release()
check('MutationLock release 后 isLocked=false', itemLock.isLocked === false)
check('MutationLock release 后可重入', itemLock.tryAcquire() === true)
itemLock.release()

{
  const refreshGuard = new LatestRequestGuard()
  let refetchCalls = 0
  let active = false
  const refresher = new CloudMasterRefresh(
    refreshGuard,
    () => {
      refetchCalls++
    },
    () => active,
  )
  const okResult = { ok: true as const, data: fakeCreatedView }
  const inFlightToken = refreshGuard.begin()

  // active=false + cloud success → refetch 0 次、token 不推进
  const returned = refresher.refreshIfNeeded(okResult, true)
  check('active=false + cloud 成功：透传原结果', returned === okResult)
  check('active=false + cloud 成功：refetch 0 次', refetchCalls === 0)
  check('active=false：在途 token 仍最新（代次未推进）', refreshGuard.isLatest(inFlightToken) === true)
  check('active=false：刷新计数 = 0', refresher.refreshes === 0)

  // active=true + cloud success → 旧 token 立即失效、refetch 1 次
  active = true
  const beforeRefreshToken = refreshGuard.begin()
  refresher.refreshIfNeeded(okResult, true)
  check('active=true + cloud 成功：旧 token 立即失效', refreshGuard.isLatest(beforeRefreshToken) === false)
  check('active=true + cloud 成功：refetch 1 次', refetchCalls === 1)
  check('active=true + cloud 成功：刷新计数 = 1', refresher.refreshes === 1)

  // 失败 / local 仍不刷新
  refetchCalls = 0
  refresher.refreshIfNeeded({ ok: false as const, error: SAFE_ITEM_WRITE_ERROR }, true)
  check('active=true + 失败：不触发 refetch', refetchCalls === 0)
  refresher.refreshIfNeeded(okResult, false)
  check('active=true + local：不触发 refetch', refetchCalls === 0)
  check('active=true + 失败/local：刷新计数不变 = 1', refresher.refreshes === 1)
}

// ===========================================================================
// 20. local 设备 CRUD 行为不回归
// ===========================================================================
const localItemBefore = dataService.listItems().length
const localCreated = dataService.createItem('admin', {
  item_code: 'SN9999',
  name: '回归测试设备',
  description: '',
  category: '滑雪板',
  purchase_date: '',
  purchase_cost: 0,
  retail_price: 0,
  daily_rate: 10,
  skill_level_id: null,
  home_store_id: 1,
  current_store_id: 1,
})
check('local createItem 成功', localCreated.ok === true)
if (localCreated.ok) {
  const tmpItemId = localCreated.data.item_id
  check('local create 后行数 +1', dataService.listItems().length === localItemBefore + 1)
  const localUpd = dataService.updateItem('admin', tmpItemId, {
    item_code: 'SN9999',
    name: '回归测试设备2',
    description: '',
    category: '滑雪板',
    purchase_date: '',
    purchase_cost: 0,
    retail_price: 0,
    daily_rate: 10,
    skill_level_id: null,
    home_store_id: 1,
    current_store_id: 1,
  })
  check('local updateItem 成功', localUpd.ok === true)
  const localRm = dataService.removeItem('admin', tmpItemId)
  check('local removeItem 成功', localRm.ok === true)
  check('local remove 后行数恢复', dataService.listItems().length === localItemBefore)
}
check(
  'local staff createItem 被权限拒绝',
  dataService.createItem('staff', {
    item_code: 'SN9998',
    name: '越权设备',
    description: '',
    category: '滑雪板',
    purchase_date: '',
    purchase_cost: 0,
    retail_price: 0,
    daily_rate: 10,
    skill_level_id: null,
    home_store_id: 1,
    current_store_id: 1,
  }).ok === false,
)

// ===========================================================================
// 21. 日租金必填语义 + category 运行时枚举校验（补漏二）
// ===========================================================================

// 21a. 日租金必填（validateItemBasics / validateItemFields 同口径）
const basicsRateNull = validateItemBasics({ ...testItemInput, daily_rate: null })
check('validateItemBasics daily_rate null → field daily_rate', basicsRateNull.ok === false && basicsRateNull.field === 'daily_rate' && basicsRateNull.error === '日租金不能为空')
const basicsRateUndef = validateItemBasics({ ...testItemInput, daily_rate: undefined as unknown as number | null })
check('validateItemBasics daily_rate undefined → field daily_rate', basicsRateUndef.ok === false && basicsRateUndef.field === 'daily_rate')
check('validateItemBasics daily_rate=0 → 合法', validateItemBasics({ ...testItemInput, daily_rate: 0 }).ok === true)
const fieldsRateNull = validateItemFields({ ...testItemInput, daily_rate: null }, itemStoreIds, itemLevelIds)
check('validateItemFields daily_rate null → field daily_rate', fieldsRateNull.ok === false && fieldsRateNull.field === 'daily_rate')

// 21b. create/update 的 daily_rate 为 null/undefined → 失败且 RDB 调用 0 次
const recRateNullCreate: ItemMutationRecord = emptyItemRecord()
const createRateNull = await createItem(makeFakeItemRdb(itemOkOutcome, recRateNullCreate), { ...testItemInput, daily_rate: null }, itemStoreIds, itemLevelIds)
check('create daily_rate=null → 失败', createRateNull.ok === false && createRateNull.field === 'daily_rate')
check('create daily_rate=null → RDB 调用 0 次', recRateNullCreate.table === null)
const recRateUndefCreate: ItemMutationRecord = emptyItemRecord()
const createRateUndef = await createItem(makeFakeItemRdb(itemOkOutcome, recRateUndefCreate), { ...testItemInput, daily_rate: undefined as unknown as number | null }, itemStoreIds, itemLevelIds)
check('create daily_rate=undefined → 失败', createRateUndef.ok === false && createRateUndef.field === 'daily_rate')
check('create daily_rate=undefined → RDB 调用 0 次', recRateUndefCreate.table === null)
const recRateNullUpdate: ItemMutationRecord = emptyItemRecord()
const updateRateNull = await updateItem(makeFakeItemRdb(itemOkOutcome, recRateNullUpdate), 5, { ...testItemInput, daily_rate: null }, itemStoreIds, itemLevelIds)
check('update daily_rate=null → 失败', updateRateNull.ok === false && updateRateNull.field === 'daily_rate')
check('update daily_rate=null → RDB 调用 0 次', recRateNullUpdate.table === null)
const recRateUndefUpdate: ItemMutationRecord = emptyItemRecord()
const updateRateUndef = await updateItem(makeFakeItemRdb(itemOkOutcome, recRateUndefUpdate), 5, { ...testItemInput, daily_rate: undefined as unknown as number | null }, itemStoreIds, itemLevelIds)
check('update daily_rate=undefined → 失败', updateRateUndef.ok === false && updateRateUndef.field === 'daily_rate')
check('update daily_rate=undefined → RDB 调用 0 次', recRateUndefUpdate.table === null)

// 显式 0 合法：走真实调用链，RDB 被调用且返回在库
const recRateZero: ItemMutationRecord = emptyItemRecord()
const createRateZero = await createItem(makeFakeItemRdb(itemOkOutcome, recRateZero), { ...testItemInput, daily_rate: 0 }, itemStoreIds, itemLevelIds)
check('create daily_rate=0 → 成功（RDB 被调用）', createRateZero.ok === true && recRateZero.table === 'rental_items')

// 21c. local 空日租金：不调用 DataService 写入，设备数量及内容不变
const localCountBefore = dataService.listItems().length
const localIdsBefore = dataService.listItems().map((i) => i.item_id).join(',')

let toLocalThrew = false
try {
  toLocalItemInput({ ...testItemInput, daily_rate: null })
} catch {
  toLocalThrew = true
}
check('toLocalItemInput 空日租金 fail-closed（抛错，不静默转 0）', toLocalThrew === true)

// 复现 useMasterData localRun 的写入边界：basics 未通过 → 返回字段错误，绝不调用 dataService
let localWriteCalls = 0
const runLocalCreate = (input: RentalItemCloudInput): { ok: boolean; error?: string; field?: string } => {
  const basics = validateItemBasics(input)
  if (!basics.ok) return { ok: false, error: basics.error, field: basics.field }
  localWriteCalls++
  const r = dataService.createItem('admin', toLocalItemInput(input))
  return r.ok ? { ok: true } : { ok: false, error: r.error, field: r.field }
}
const localEmpty = runLocalCreate({ ...testItemInput, daily_rate: null })
check('local 空日租金：basics 返回字段错误', localEmpty.ok === false && localEmpty.field === 'daily_rate')
check('local 空日租金：不调用 DataService 写入', localWriteCalls === 0)
check('local 空日租金：设备数量不变', dataService.listItems().length === localCountBefore)
check('local 空日租金：设备内容不变', dataService.listItems().map((i) => i.item_id).join(',') === localIdsBefore)

// 21d. category 运行时枚举校验（不依赖 TS 类型 / 页面 Select / 数据库 CHECK）
const fieldsCatBad = validateItemFields({ ...testItemInput, category: '滑板车' as ItemCategory }, itemStoreIds, itemLevelIds)
check('validateItemFields category 非法 → field category', fieldsCatBad.ok === false && fieldsCatBad.field === 'category' && fieldsCatBad.error === '类别不合法')
const recCatCreate: ItemMutationRecord = emptyItemRecord()
const createCatBad = await createItem(makeFakeItemRdb(itemOkOutcome, recCatCreate), { ...testItemInput, category: '滑板车' as ItemCategory }, itemStoreIds, itemLevelIds)
check('create category 非法 → 失败', createCatBad.ok === false && createCatBad.field === 'category')
check('create category 非法 → RDB 调用 0 次', recCatCreate.table === null)
const recCatUpdate: ItemMutationRecord = emptyItemRecord()
const updateCatBad = await updateItem(makeFakeItemRdb(itemOkOutcome, recCatUpdate), 5, { ...testItemInput, category: '雪圈' as ItemCategory }, itemStoreIds, itemLevelIds)
check('update category 非法 → 失败', updateCatBad.ok === false && updateCatBad.field === 'category')
check('update category 非法 → RDB 调用 0 次', recCatUpdate.table === null)

// 六种合法类别全部通过完整校验
for (const c of ITEM_CATEGORIES) {
  const isAcc = c === '护目镜' || c === '头盔'
  const input = { ...testItemInput, category: c, skill_level_id: isAcc ? null : 3 }
  check(`合法类别 ${c} 通过 validateItemFields`, validateItemFields(input, itemStoreIds, itemLevelIds).ok === true)
}

// ===========================================================================
// 22. cloud create/update 前置校验：validateItemFields 在 getRdb/cloudRun 之前
//     （计数型 getRdbFn/cloudRun/localRun/from 验证调用次数，非仅检查 rec.table）
// ===========================================================================
function makeCountingItemDispatch() {
  const calls = { getRdb: 0, cloudRun: 0, localRun: 0, from: 0 }
  const getRdbFn = (): ItemRdbMutationClient => {
    calls.getRdb++
    const inner = makeFakeItemRdb(itemOkOutcome, emptyItemRecord())
    return {
      from(table: string) {
        calls.from++
        return inner.from(table)
      },
    }
  }
  const localRun = () => {
    calls.localRun++
    return { ok: true as const, data: fakeCreatedView }
  }
  return { calls, getRdbFn, localRun }
}

// 22a. 有效 create：getRdb / cloudRun 各 1 次，localRun 0 次，from 1 次
{
  const env = makeCountingItemDispatch()
  const res = await dispatchMasterItemMutation(
    'cloud', testItemInput, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createItem(rdb, testItemInput, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud create 有效输入 → ok', res.ok === true)
  check('cloud create 有效输入 → getRdb 1 次', env.calls.getRdb === 1)
  check('cloud create 有效输入 → cloudRun 1 次', env.calls.cloudRun === 1)
  check('cloud create 有效输入 → localRun 0 次', env.calls.localRun === 0)
  check('cloud create 有效输入 → rdb.from 1 次', env.calls.from === 1)
}

// 22b. 有效 update：getRdb / cloudRun 各 1 次，localRun 0 次，from 1 次
{
  const env = makeCountingItemDispatch()
  const res = await dispatchMasterItemMutation(
    'cloud', testItemInput, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return updateItem(rdb, 5, testItemInput, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud update 有效输入 → ok', res.ok === true)
  check('cloud update 有效输入 → getRdb 1 次', env.calls.getRdb === 1)
  check('cloud update 有效输入 → cloudRun 1 次', env.calls.cloudRun === 1)
  check('cloud update 有效输入 → localRun 0 次', env.calls.localRun === 0)
  check('cloud update 有效输入 → rdb.from 1 次', env.calls.from === 1)
}

// 22c. create 空日租金(null) → 字段错误，getRdb/cloudRun/localRun/from 全 0 次
{
  const env = makeCountingItemDispatch()
  const bad = { ...testItemInput, daily_rate: null }
  const res = await dispatchMasterItemMutation(
    'cloud', bad, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createItem(rdb, bad, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud create 空日租金(null) → field daily_rate', res.ok === false && res.field === 'daily_rate')
  check('cloud create 空日租金(null) → getRdb 0 次', env.calls.getRdb === 0)
  check('cloud create 空日租金(null) → cloudRun 0 次', env.calls.cloudRun === 0)
  check('cloud create 空日租金(null) → localRun 0 次', env.calls.localRun === 0)
  check('cloud create 空日租金(null) → rdb.from 0 次', env.calls.from === 0)
}

// 22d. create 空日租金(undefined) → 字段错误，全 0 次
{
  const env = makeCountingItemDispatch()
  const bad = { ...testItemInput, daily_rate: undefined as unknown as number | null }
  const res = await dispatchMasterItemMutation(
    'cloud', bad, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createItem(rdb, bad, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud create 空日租金(undefined) → field daily_rate', res.ok === false && res.field === 'daily_rate')
  check('cloud create 空日租金(undefined) → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
}

// 22e. update 空日租金(null) → 字段错误，全 0 次
{
  const env = makeCountingItemDispatch()
  const bad = { ...testItemInput, daily_rate: null }
  const res = await dispatchMasterItemMutation(
    'cloud', bad, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return updateItem(rdb, 5, bad, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud update 空日租金(null) → field daily_rate', res.ok === false && res.field === 'daily_rate')
  check('cloud update 空日租金(null) → getRdb/cloudRun/localRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.localRun === 0 && env.calls.from === 0)
}

// 22f. create 非法 category → 字段错误，全 0 次
{
  const env = makeCountingItemDispatch()
  const bad = { ...testItemInput, category: '滑板车' as ItemCategory }
  const res = await dispatchMasterItemMutation(
    'cloud', bad, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createItem(rdb, bad, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud create 非法 category → field category', res.ok === false && res.field === 'category')
  check('cloud create 非法 category → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
}

// 22g. update 非法 category → 字段错误，全 0 次
{
  const env = makeCountingItemDispatch()
  const bad = { ...testItemInput, category: '雪圈' as ItemCategory }
  const res = await dispatchMasterItemMutation(
    'cloud', bad, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return updateItem(rdb, 5, bad, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('cloud update 非法 category → field category', res.ok === false && res.field === 'category')
  check('cloud update 非法 category → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
}

// 22h. local 模式：不经 cloud 校验、不触碰 getRdb/cloudRun/from，直接走 localRun（行为不回归）
{
  const env = makeCountingItemDispatch()
  const res = await dispatchMasterItemMutation(
    'local', testItemInput, itemStoreIds, itemLevelIds,
    env.getRdbFn,
    async (rdb) => { env.calls.cloudRun++; return createItem(rdb, testItemInput, itemStoreIds, itemLevelIds) },
    env.localRun,
  )
  check('local 模式 → localRun 1 次', env.calls.localRun === 1)
  check('local 模式 → getRdb/cloudRun/from 0 次', env.calls.getRdb === 0 && env.calls.cloudRun === 0 && env.calls.from === 0)
  check('local 模式 → 透传 localRun 结果', res.ok === true)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
