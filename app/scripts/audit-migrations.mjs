/**
 * CloudBase PostgreSQL 迁移静态审计（纯只读，不连接云端、不执行 SQL）
 *
 * 覆盖两类对象：
 *  A. 已应用的三个 migration（内容不可再变，用 SHA256 基线校验）：
 *     1. 封闭业务表无直接 DML GRANT / 无写 Policy；
 *     2. 所有 SECURITY DEFINER 函数 REVOKE FROM PUBLIC；
 *     3. RPC 函数 GRANT authenticated、内部函数不 GRANT authenticated；
 *     4. 无 MAX(id)+1 并发不安全 ID；
 *     5. 无 password_placeholder / demo123 / 凭据；
 *     6. RPC 无客户端时间参数；
 *     7. 业务序列已创建并 setval；
 *     8. seed 外键插入顺序、accounts 精确 CHECK；
 *     9. start/complete_repair NULL 防护 + IS DISTINCT FROM；
 *    10. 费率冻结触发器存在且不外暴露；
 *    11. rental_items.status 列级封闭 + 三条独立写 Policy。
 *  B. 权限加固补丁（harden_cloudbase_acl，唯一锁定文件）：
 *    12. 已应用 migration 内容未变化；无未登记 migration；
 *    13. 补丁版本号晚于 20260828014156；
 *    14. 13 张表撤销 anon/authenticated 的 ALL，authenticated 按矩阵重授权；
 *    15. 四张封闭表最终仅 SELECT；
 *    16. anon/authenticated 无 TRUNCATE；
 *    17. 15 个序列按预期撤销，仅 9 个基础 identity 序列重授权；
 *    18. protect_contractor_rate 不授予 anon/authenticated/PUBLIC；
 *    19. 8 个 RPC 逐个提取函数体，验证 auth.uid() 关联 accounts + enabled + 角色；
 *    20. public schema 的 CREATE 已从 anon/authenticated 撤销；
 *    21. 未撤销 service_role 的平台管理权限；
 *    22. 默认函数权限同时撤销 PUBLIC/anon/authenticated；无 FOR ROLE 硬编码。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIG_DIR = join(__dirname, '..', '..', 'cloudbase', 'migrations')

/** 已应用 migration 的 SHA256 基线（内容未变化校验，防误改） */
const APPLIED_HASHES = {
  '20260828014154_create_schema.sql':
    '94b1c9ebe592916a16fe8ea4fe80fa3bc6691cae48a75cb2a4a2bc1de2b3e1fa',
  '20260828014155_create_rls_policies.sql':
    '3be79dd5407f815ee7f8508a6074e7188c708041d7707a78df08df9a6b1793f1',
  '20260828014156_seed_demo_data.sql':
    '99987d1fe3dc0d528b4432c515478a1f5feda8f05fa9cd76f68b526c21c54458',
}
const APPLIED_FILES = Object.keys(APPLIED_HASHES)

/** 唯一锁定补丁文件（不允许存在其它未登记 migration） */
const PATCH_FILE = '20260828062714_harden_cloudbase_acl.sql'
const KNOWN_FILES = new Set([...APPLIED_FILES, PATCH_FILE])

const CLOSED_TABLES = ['rental_contracts', 'contract_lines', 'contract_changes', 'repair_orders']
const BASIC_TABLES = [
  'accounts', 'skill_levels', 'stores', 'customers', 'employees',
  'contractors', 'contractor_rates', 'shifts',
]
const ALL_TABLES = [...BASIC_TABLES, 'rental_items', ...CLOSED_TABLES]

const ALL_SEQS = [
  'accounts_account_id_seq', 'skill_levels_skill_level_id_seq', 'stores_store_id_seq',
  'customers_customer_id_seq', 'employees_employee_id_seq', 'rental_items_item_id_seq',
  'contractors_contractor_id_seq', 'contractor_rates_rate_id_seq', 'shifts_shift_id_seq',
  'rental_contracts_contract_id_seq', 'contract_lines_contract_line_id_seq',
  'contract_changes_change_id_seq', 'repair_orders_repair_id_seq',
  'contract_no_seq', 'change_group_seq',
]
const BASIC_SEQS = [
  'accounts_account_id_seq', 'skill_levels_skill_level_id_seq', 'stores_store_id_seq',
  'customers_customer_id_seq', 'employees_employee_id_seq', 'rental_items_item_id_seq',
  'contractors_contractor_id_seq', 'contractor_rates_rate_id_seq', 'shifts_shift_id_seq',
]
const NON_GRANTED_SEQS = ALL_SEQS.filter((s) => !BASIC_SEQS.includes(s))

/** 前端 RPC 函数（需要 GRANT EXECUTE TO authenticated） */
const RPC_FUNCTIONS = [
  'current_app_role',
  'create_contract',
  'exchange_item',
  'return_items',
  'create_repair_order',
  'start_repair',
  'complete_repair',
  'list_my_repairs',
]
/** 内部函数（触发器函数，仅 REVOKE FROM PUBLIC，不得 GRANT authenticated） */
const INTERNAL_FUNCTIONS = ['protect_contractor_rate']

/** 7 个 plpgsql RPC 允许的业务角色（用于函数体验证） */
const RPC_ROLES = {
  create_contract: ['admin', 'staff'],
  exchange_item: ['admin', 'staff'],
  return_items: ['admin', 'staff'],
  create_repair_order: ['admin', 'staff'],
  start_repair: ['contractor'],
  complete_repair: ['contractor'],
  list_my_repairs: ['contractor'],
}

/** 种子外键依赖：子表 → 必须先插入的父表 */
const FK_DEPS = {
  accounts: ['employees', 'contractors'],
  contractor_rates: ['contractors'],
  rental_items: ['skill_levels', 'stores'],
  rental_contracts: ['customers', 'employees'],
  contract_lines: ['rental_contracts', 'rental_items', 'stores'],
  contract_changes: ['rental_contracts', 'rental_items'],
  repair_orders: ['rental_items', 'contractors', 'contractor_rates'],
  shifts: ['employees', 'stores'],
}

/** 去掉 SQL 行注释（--） */
function stripComments(sql) {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

/** 提取指定函数的函数体（AS $$ ... $$; 之间） */
function functionBody(sql, name) {
  const start = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`))
  if (start === -1) return ''
  const m = sql.slice(start).match(/AS\s+\$\$([\s\S]*?)\$\$;/)
  return m ? m[1] : ''
}

const raw = {}
for (const f of APPLIED_FILES) {
  raw[f] = readFileSync(join(MIG_DIR, f), 'utf8')
}
const code = {}
for (const f of APPLIED_FILES) {
  code[f] = stripComments(raw[f])
}
const allCode = Object.values(code).join('\n')
const rls = code['20260828014155_create_rls_policies.sql']
const schema = code['20260828014154_create_schema.sql']
const seed = code['20260828014156_seed_demo_data.sql']

// 补丁文件（唯一锁定）
const patch = readFileSync(join(MIG_DIR, PATCH_FILE), 'utf8')
const patchCode = stripComments(patch)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
}

// ===========================================================================
// A. 已应用 migration 检查
// ===========================================================================

// A0. 已应用 migration 内容未变化（SHA256）
for (const f of APPLIED_FILES) {
  const actual = createHash('sha256').update(raw[f]).digest('hex')
  check(`已应用 migration ${f} 内容未变化`, actual === APPLIED_HASHES[f])
}

// 1. 封闭表无直接 DML GRANT
for (const t of CLOSED_TABLES) {
  const re = new RegExp(`GRANT\\s+[^;\\n]*?(INSERT|UPDATE|DELETE)[^;\\n]*?ON\\s+${t}\\b`, 'i')
  const hit = rls.match(re)
  check(`封闭表 ${t} 无直接 DML GRANT`, !hit, hit ? hit[0].trim() : '')
}

// 2. 封闭表无 INSERT/UPDATE/DELETE Policy
for (const t of CLOSED_TABLES) {
  const re = new RegExp(`CREATE\\s+POLICY\\s+\\w*${t}\\w*\\s+ON\\s+${t}\\s+FOR\\s+(INSERT|UPDATE|DELETE)`, 'i')
  check(`封闭表 ${t} 无 INSERT/UPDATE/DELETE Policy`, !re.test(rls))
}

// 3. 所有 SECURITY DEFINER 函数均 REVOKE FROM PUBLIC
const funcNames = [...rls.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(public\.\w+)\s*\(/g)].map((m) => m[1])
for (const fn of funcNames) {
  const esc = fn.replace('.', '\\.')
  const revoke = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${esc}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, 'i')
  check(`函数 ${fn} REVOKE FROM PUBLIC`, revoke.test(rls))
}

// 4. RPC 仅 GRANT authenticated，内部函数不得 GRANT authenticated
const grantToPublic = [...rls.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+[^;\n]*?\bTO\s+PUBLIC\b/gi)].map((m) => m[0].trim())
check('无 GRANT EXECUTE TO PUBLIC', grantToPublic.length === 0, grantToPublic.join(' | '))
for (const fn of RPC_FUNCTIONS) {
  const esc = fn.replace('.', '\\.')
  const grant = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${esc}\\s*\\([^)]*\\)\\s+TO\\s+authenticated`, 'i')
  check(`RPC ${fn} GRANT authenticated`, grant.test(rls))
}
for (const fn of INTERNAL_FUNCTIONS) {
  const esc = fn.replace('.', '\\.')
  const grant = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${esc}\\s*\\([^)]*\\)\\s+TO\\s+authenticated`, 'i')
  check(`内部函数 ${fn} 不 GRANT authenticated`, !grant.test(rls))
}

// 5. 无 MAX(id)+1
const maxPlusOne = [...allCode.matchAll(/MAX\s*\([^)]*\)\s*\+\s*1/g)].map((m) => m[0])
check('无 MAX(id)+1 并发不安全 ID 生成', maxPlusOne.length === 0, maxPlusOne.join(' | '))

// 6. 无 password_placeholder / demo123
check('无 password_placeholder', !/password_placeholder/i.test(allCode))
check('无 demo123', !/demo123/i.test(allCode))

// 7. 无凭据
const secretHits = [...allCode.matchAll(/[^\n]*(secretid|secretkey|secretaccesskey|AKID[A-Za-z0-9]{10,}|api[_-]?key|appsecret)[^\n]*/gi)].map((m) => m[0].trim())
check('无 API Key / SecretId / SecretKey', secretHits.length === 0, secretHits.join(' | '))

// 8. RPC 无客户端时间参数
check('RPC 无客户端时间参数', !/p_now\b/i.test(rls))

// 9. 业务序列已创建并 setval
check('contract_no_seq 已创建', /CREATE\s+SEQUENCE\s+contract_no_seq/i.test(schema))
check('change_group_seq 已创建', /CREATE\s+SEQUENCE\s+change_group_seq/i.test(schema))
check('contract_no_seq 已 setval', /setval\('contract_no_seq'/i.test(seed))
check('change_group_seq 已 setval', /setval\('change_group_seq'/i.test(seed))

// 10. 封闭表仍保留 SELECT
for (const t of CLOSED_TABLES) {
  const re = new RegExp(`GRANT\\s+SELECT\\s+ON\\s+${t}\\s+TO\\s+authenticated`, 'i')
  check(`封闭表 ${t} 保留 SELECT`, re.test(rls))
}

// 11. seed 外键插入顺序
function firstInsertPos(table) {
  return seed.indexOf(`INSERT INTO ${table}`)
}
for (const [child, parents] of Object.entries(FK_DEPS)) {
  const childPos = firstInsertPos(child)
  const bad = parents.filter((p) => {
    const pPos = firstInsertPos(p)
    return pPos === -1 || childPos === -1 || pPos > childPos
  })
  check(`seed 顺序：${child} 晚于 [${parents.join(', ')}]`, bad.length === 0, bad.length ? `未满足的父表 [${bad.join(', ')}]` : '')
}

// 12. accounts 精确 CHECK
check('accounts CHECK：admin/staff 关联员工且 contractor 空', /role\s+IN\s*\('admin','staff'\)\s+AND\s+employee_id\s+IS\s+NOT\s+NULL\s+AND\s+contractor_id\s+IS\s+NULL/i.test(schema))
check('accounts CHECK：contractor 关联承包商且 employee 空', /role\s*=\s*'contractor'\s+AND\s+employee_id\s+IS\s+NULL\s+AND\s+contractor_id\s+IS\s+NOT\s+NULL/i.test(schema))

// 13. start/complete_repair NULL 防护 + IS DISTINCT FROM
const nullGuardCount = (rls.match(/v_contractor_id\s+IS\s+NULL/g) || []).length
check('start/complete 显式拒绝 v_contractor_id IS NULL（2 处）', nullGuardCount >= 2, `${nullGuardCount} 处`)
const distinctCount = (rls.match(/IS\s+DISTINCT\s+FROM\s+v_contractor_id/g) || []).length
check('start/complete 本人校验用 IS DISTINCT FROM（2 处）', distinctCount >= 2, `${distinctCount} 处`)

// 14. 费率冻结保护触发器
check('存在 protect_contractor_rate 触发器函数', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.protect_contractor_rate\s*\(/.test(rls))
check('触发器函数 REVOKE FROM PUBLIC', /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.protect_contractor_rate\s*\([^)]*\)\s+FROM\s+PUBLIC/i.test(rls))
check('存在 CREATE TRIGGER', /CREATE\s+TRIGGER\s+trg_contractor_rates_protect/i.test(rls))

// 15. rental_items.status 列级封闭 + 三条独立写 Policy
check('rental_items.status DEFAULT 在库', /status\s+varchar\(20\)\s+NOT\s+NULL\s+DEFAULT\s+'在库'/i.test(schema))
const fullDmlGrant = /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+rental_items/i.test(rls)
check('rental_items 无表级全量 DML GRANT', !fullDmlGrant)
const revokePos = rls.search(/REVOKE\s+INSERT,\s*UPDATE\s+ON\s+public\.rental_items\s+FROM\s+authenticated/i)
const insertGrantPos = rls.search(/GRANT\s+INSERT\s*\([^)]*\)\s+ON\s+rental_items/i)
check('rental_items 显式 REVOKE INSERT/UPDATE', revokePos !== -1)
check('rental_items REVOKE 位于列级 GRANT 之前', revokePos !== -1 && insertGrantPos !== -1 && revokePos < insertGrantPos)
const insertCols = rls.match(/GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+rental_items/i)
const updateCols = rls.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+rental_items/i)
check('rental_items 列级 INSERT 权限存在', !!insertCols)
check('rental_items 列级 INSERT 不含 status', !!insertCols && !/status/.test(insertCols[1]))
check('rental_items 列级 INSERT 不含 item_id', !!insertCols && !/\bitem_id\b/.test(insertCols[1]))
check('rental_items 列级 UPDATE 权限存在', !!updateCols)
check('rental_items 列级 UPDATE 不含 status', !!updateCols && !/status/.test(updateCols[1]))
check('rental_items 列级 UPDATE 不含 item_id', !!updateCols && !/\bitem_id\b/.test(updateCols[1]))
check('rental_items 无 FOR ALL Policy', !/CREATE\s+POLICY\s+rental_items\w*\s+ON\s+rental_items\s+FOR\s+ALL/i.test(rls))
check('rental_items 独立 INSERT Policy', /CREATE\s+POLICY\s+rental_items_insert\s+ON\s+rental_items\s+FOR\s+INSERT/i.test(rls))
check('rental_items 独立 UPDATE Policy', /CREATE\s+POLICY\s+rental_items_update\s+ON\s+rental_items\s+FOR\s+UPDATE/i.test(rls))
check('rental_items 独立 DELETE Policy', /CREATE\s+POLICY\s+rental_items_delete\s+ON\s+rental_items\s+FOR\s+DELETE/i.test(rls))
const insertPolicyMatch = rls.match(/CREATE\s+POLICY\s+rental_items_insert\s+ON\s+rental_items\s+FOR\s+INSERT[^;]*/i)
check('rental_items INSERT Policy 要求 status=在库', !!insertPolicyMatch && /status\s*=\s*'在库'/.test(insertPolicyMatch[0]))
const deletePolicyMatch = rls.match(/CREATE\s+POLICY\s+rental_items_delete\s+ON\s+rental_items\s+FOR\s+DELETE[^;]*/i)
check('rental_items DELETE Policy 要求 status=在库', !!deletePolicyMatch && /status\s*=\s*'在库'/.test(deletePolicyMatch[0]))

// ===========================================================================
// B. 权限加固补丁检查
// ===========================================================================

// B0. 补丁文件锁定 + 未登记 migration 检测
const allFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
const unknownFiles = allFiles.filter((f) => !KNOWN_FILES.has(f))
check('无未登记 migration 文件', unknownFiles.length === 0, unknownFiles.join(' | '))
check(`存在唯一补丁 migration ${PATCH_FILE}`, allFiles.includes(PATCH_FILE))

// B1. 补丁版本号晚于 20260828014156
const patchVer = PATCH_FILE.slice(0, 14)
check(`补丁版本号晚于 20260828014156`, /^\d{14}$/.test(patchVer) && patchVer > '20260828014156', patchVer)

// B2. 13 张表撤销 anon/authenticated 的 ALL
const revokeTableBlock = patchCode.match(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s*([\s\S]*?)\s*FROM\s+anon,\s*authenticated\s*;/i)
check('补丁存在 REVOKE ALL ON TABLE FROM anon,authenticated', !!revokeTableBlock)
const revokeTables = revokeTableBlock ? revokeTableBlock[1] : ''
for (const t of ALL_TABLES) {
  check(`补丁撤销 ${t} 的 ALL（anon/authenticated）`, new RegExp(`\\b${t}\\b`).test(revokeTables))
}

// B3. authenticated 按矩阵重授权
const basicGrantBlock = patchCode.match(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s*([\s\S]*?)\s*TO\s+authenticated\s*;/i)
check('补丁基础资料表 GRANT SELECT,INSERT,UPDATE,DELETE', !!basicGrantBlock)
const basicGrantTables = basicGrantBlock ? basicGrantBlock[1] : ''
for (const t of BASIC_TABLES) {
  check(`补丁基础资料表 ${t} 授权 CRUD`, new RegExp(`\\b${t}\\b`).test(basicGrantTables))
}
check('补丁 rental_items 表级 SELECT,DELETE', /GRANT\s+SELECT,\s*DELETE\s+ON\s+rental_items\s+TO\s+authenticated/i.test(patchCode))
const patchInsertCols = patchCode.match(/GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+rental_items\s+TO\s+authenticated/i)
const patchUpdateCols = patchCode.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+rental_items\s+TO\s+authenticated/i)
check('补丁 rental_items 列级 INSERT 存在', !!patchInsertCols)
check('补丁 rental_items 列级 INSERT 不含 status/item_id', !!patchInsertCols && !/status/.test(patchInsertCols[1]) && !/\bitem_id\b/.test(patchInsertCols[1]))
check('补丁 rental_items 列级 UPDATE 存在', !!patchUpdateCols)
check('补丁 rental_items 列级 UPDATE 不含 status/item_id', !!patchUpdateCols && !/status/.test(patchUpdateCols[1]) && !/\bitem_id\b/.test(patchUpdateCols[1]))
const closedGrantBlock = patchCode.match(/GRANT\s+SELECT\s+ON\s*([\s\S]*?)\s*TO\s+authenticated\s*;/i)
const closedGrantTables = closedGrantBlock ? closedGrantBlock[1] : ''
for (const t of CLOSED_TABLES) {
  check(`补丁封闭表 ${t} 仅 SELECT`, new RegExp(`\\b${t}\\b`).test(closedGrantTables))
}
for (const t of CLOSED_TABLES) {
  const re = new RegExp(`GRANT\\s+[^;\\n]*?(INSERT|UPDATE|DELETE)[^;\\n]*?ON\\s+${t}\\b`, 'i')
  const hit = patchCode.match(re)
  check(`补丁封闭表 ${t} 无 DML GRANT`, !hit, hit ? hit[0].trim() : '')
}

// B4. anon/authenticated 无 TRUNCATE / TRIGGER / MAINTAIN / REFERENCES 授权
check('补丁无 TRUNCATE 授权', !/GRANT[^;\n]*\bTRUNCATE\b/i.test(patchCode))
check('补丁无 TRIGGER 授权', !/GRANT[^;\n]*\bTRIGGER\b/i.test(patchCode))
check('补丁无 MAINTAIN 授权', !/GRANT[^;\n]*\bMAINTAIN\b/i.test(patchCode))
check('补丁无 REFERENCES 授权', !/GRANT[^;\n]*\bREFERENCES\b/i.test(patchCode))

// B5. 序列撤销 + 重授权
const revokeSeqBlock = patchCode.match(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+SEQUENCE\s*([\s\S]*?)\s*FROM\s+anon,\s*authenticated\s*;/i)
check('补丁存在 REVOKE ALL ON SEQUENCE FROM anon,authenticated', !!revokeSeqBlock)
const revokeSeqs = revokeSeqBlock ? revokeSeqBlock[1] : ''
for (const s of ALL_SEQS) {
  check(`补丁撤销序列 ${s} 的 ALL`, new RegExp(`\\b${s}\\b`).test(revokeSeqs))
}
const grantSeqBlock = patchCode.match(/GRANT\s+USAGE,\s*SELECT\s+ON\s+SEQUENCE\s*([\s\S]*?)\s*TO\s+authenticated\s*;/i)
check('补丁存在序列 GRANT USAGE,SELECT TO authenticated', !!grantSeqBlock)
const grantSeqs = grantSeqBlock ? grantSeqBlock[1] : ''
for (const s of BASIC_SEQS) {
  check(`补丁授权基础序列 ${s} USAGE/SELECT`, new RegExp(`\\b${s}\\b`).test(grantSeqs))
}
for (const s of NON_GRANTED_SEQS) {
  check(`封闭/业务序列 ${s} 不授权 authenticated`, !new RegExp(`\\b${s}\\b`).test(grantSeqs))
}

// B6. 函数权限
check('补丁 protect_contractor_rate REVOKE FROM PUBLIC/anon/authenticated', /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.protect_contractor_rate\s*\([^)]*\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i.test(patchCode))
check('补丁 protect_contractor_rate 不 GRANT authenticated', !/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.protect_contractor_rate/i.test(patchCode))
for (const fn of RPC_FUNCTIONS) {
  const esc = fn.replace('.', '\\.')
  const revoke = new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${esc}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC,\\s*anon`, 'i')
  const grant = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${esc}\\s*\\([^)]*\\)\\s+TO\\s+authenticated`, 'i')
  check(`补丁 RPC ${fn} REVOKE FROM PUBLIC/anon`, revoke.test(patchCode))
  check(`补丁 RPC ${fn} GRANT authenticated`, grant.test(patchCode))
}

// B7. 逐个提取并验证 8 个 RPC 函数体（角色校验，而非全文件 auth.uid() 计数）
check('补丁未重新定义函数（保留内部校验）', !/CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(patchCode))
// 7 个 plpgsql RPC
for (const [fn, roles] of Object.entries(RPC_ROLES)) {
  const body = functionBody(rls, fn)
  check(`RPC ${fn} 函数体可提取`, body !== '')
  check(`RPC ${fn} 用 auth.uid() 关联 accounts`, /auth\.uid\(\)/.test(body) && /accounts/.test(body))
  check(`RPC ${fn} 校验 enabled`, /(enabled\s*=\s*true|v_enabled\s+IS\s+NOT\s+TRUE)/.test(body))
  const roleOk = /v_role\b/.test(body) && /RAISE\s+EXCEPTION/.test(body) && roles.every((r) => body.includes(`'${r}'`))
  check(`RPC ${fn} 校验业务角色（${roles.join('/')}）`, roleOk)
}
// current_app_role（SQL 函数，返回角色职责）
const carBody = functionBody(rls, 'current_app_role')
check('current_app_role 函数体可提取', carBody !== '')
check('current_app_role 用 auth.uid() 关联 accounts', /auth\.uid\(\)/.test(carBody) && /accounts/.test(carBody))
check('current_app_role 校验 enabled=true', /enabled\s*=\s*true/.test(carBody))
check('current_app_role 返回 role', /SELECT\s+role\s+FROM\s+public\.accounts/i.test(carBody))

// B8. public schema CREATE 已从 anon/authenticated 撤销
check('补丁 public schema 撤销 anon/authenticated 的 CREATE', /REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+anon,\s*authenticated/i.test(patchCode))

// B9. 未撤销 service_role 的平台管理权限
check('未撤销 service_role 平台权限', !/REVOKE[\s\S]*?\bservice_role\b/i.test(patchCode))

// B10. 默认权限：函数同时撤销 PUBLIC/anon/authenticated；无 FOR ROLE 硬编码
check('补丁默认函数权限撤销 PUBLIC/anon/authenticated', /ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+REVOKE\s+EXECUTE\s+ON\s+FUNCTIONS\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i.test(patchCode))
check('补丁无 FOR ROLE 硬编码（作用于当前迁移用户）', !/ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE/i.test(patchCode))
check('补丁默认表权限撤销 anon/authenticated', /ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLES\s+FROM\s+anon,\s*authenticated/i.test(patchCode))
check('补丁默认序列权限撤销 anon/authenticated', /ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+SEQUENCES\s+FROM\s+anon,\s*authenticated/i.test(patchCode))

// 种子行数统计
const seedRows = {}
for (const m of seed.matchAll(/INSERT\s+INTO\s+(\w+)/g)) {
  seedRows[m[1]] = (seedRows[m[1]] || 0) + 1
}

const failed = results.filter((r) => !r.ok)
console.log('=== 静态审计结果 ===')
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  → ${r.detail}` : ''}`)
}
console.log('\n=== 种子各表行数 ===')
for (const [t, n] of Object.entries(seedRows)) {
  console.log(`  ${t}: ${n}`)
}
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
if (failed.length > 0) {
  console.log(`失败 ${failed.length} 项`)
  process.exit(1)
}
console.log('全部通过')
