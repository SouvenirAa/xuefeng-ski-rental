/**
 * Auth 纯逻辑校验脚本（不参与 tsc 编译，由 scripts/validate-auth.mjs 用 esbuild 打包执行）
 * 用法：npm run validate:auth
 *
 * 覆盖：模式状态机（fail-closed）、cloud 配置校验、SessionAccount 映射、buildCloudSession 边界。
 * 不读取真实 .env.local，不涉及任何凭据。
 */
import { resolveDataMode, resolveConfig, type ConfigResult } from '../src/lib/config'
import { toSessionAccount, buildCloudSession, type AccountRow } from '../src/auth/session'
import type { Account } from '../src/data/types'

let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

type EnvLike = Record<string, string | undefined>

/** 从 resolveConfig 结果推导“local/cloud 是否可用”，模拟 isLocalMode/isCloudMode 的门禁 */
function usable(env: EnvLike) {
  const r: ConfigResult = resolveConfig(env)
  return {
    local: r.ok && r.mode === 'local',
    cloud: r.ok && r.mode === 'cloud',
    error: r.ok ? null : r.error,
    mode: r.ok ? r.mode : (r.mode ?? null),
  }
}

// ---------------- 一、模式状态机 ----------------
check('缺 VITE_DATA_MODE → local', usable({}).local === true)
check('缺 VITE_DATA_MODE 时 cloud=false', usable({}).cloud === false)
check('VITE_DATA_MODE="" → local', usable({ VITE_DATA_MODE: '' }).local === true)
check('VITE_DATA_MODE=local → local', usable({ VITE_DATA_MODE: 'local' }).local === true)

// cloud 缺全部配置：保持 cloud 意图，不降级 local
const cloudMissingAll = usable({ VITE_DATA_MODE: 'cloud' })
check('cloud 缺全部配置 → 不降级 local（local=false）', cloudMissingAll.local === false)
check('cloud 缺全部配置 → 不可用（cloud=false）', cloudMissingAll.cloud === false)
check('cloud 缺全部配置 → 有配置错误', cloudMissingAll.error !== null)
check('cloud 缺全部配置 → 保留 cloud 意图（mode=cloud）', cloudMissingAll.mode === 'cloud')

// cloud 缺任一必填变量均失败
const reqKeys = ['VITE_CLOUDBASE_ENV_ID', 'VITE_CLOUDBASE_REGION', 'VITE_CLOUDBASE_ACCESS_KEY']
for (const key of reqKeys) {
  const env: EnvLike = {
    VITE_DATA_MODE: 'cloud',
    VITE_CLOUDBASE_ENV_ID: 'env',
    VITE_CLOUDBASE_REGION: 'ap-shanghai',
    VITE_CLOUDBASE_ACCESS_KEY: 'key',
  }
  env[key] = undefined
  const r = usable(env)
  check(`cloud 缺 ${key} → fail closed`, r.cloud === false && r.error !== null && r.error.includes(key))
}

// 非法非空值 → 配置错误，不是 local
for (const bad of ['CLOUD', 'invalid', 'cluod', 'Cloud', 'local2']) {
  const r = usable({ VITE_DATA_MODE: bad })
  check(`VITE_DATA_MODE=${bad} → 配置错误（非 local）`, r.local === false && r.cloud === false && r.error !== null)
}

// ---------------- 二、错误文本安全（只含变量名，不含值） ----------------
const leakEnv: EnvLike = {
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-secret-value-123',
  VITE_CLOUDBASE_REGION: '', // 缺失
  VITE_CLOUDBASE_ACCESS_KEY: '', // 缺失
}
const leakRes = resolveConfig(leakEnv)
check('cloud 缺失错误列出变量名 REGION', leakRes.ok === false && leakRes.error.includes('VITE_CLOUDBASE_REGION'))
check('cloud 缺失错误列出变量名 ACCESS_KEY', leakRes.ok === false && leakRes.error.includes('VITE_CLOUDBASE_ACCESS_KEY'))
check(
  '错误文本不含已提供的值（ENV_ID 值不泄漏）',
  leakRes.ok === false && !leakRes.error.includes('env-secret-value-123'),
)

// ---------------- 三、完整 cloud 配置仍正常 ----------------
const cloudOk = usable({
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-id',
  VITE_CLOUDBASE_REGION: 'ap-shanghai',
  VITE_CLOUDBASE_ACCESS_KEY: 'publishable-key',
})
check('完整 cloud 配置 → cloud 可用', cloudOk.cloud === true)
check('完整 cloud 配置 → local 不可用', cloudOk.local === false)
const cloudOkRes = resolveConfig({
  VITE_DATA_MODE: 'cloud',
  VITE_CLOUDBASE_ENV_ID: 'env-id',
  VITE_CLOUDBASE_REGION: 'ap-shanghai',
  VITE_CLOUDBASE_ACCESS_KEY: 'publishable-key',
})
check('完整 cloud 配置 cloudConfigured=true', cloudOkRes.ok === true && cloudOkRes.config.cloudConfigured === true)

// ---------------- 四、resolveDataMode 原始语义 ----------------
check('resolveDataMode undefined → local', resolveDataMode(undefined).ok === true && (resolveDataMode(undefined) as any).mode === 'local')
check('resolveDataMode "CLOUD" → 错误', resolveDataMode('CLOUD').ok === false)

// ---------------- 五、SessionAccount 映射（local 登录回归） ----------------
const localAdmin: Account = {
  account_id: 1,
  username: 'admin',
  password_placeholder: 'demo1234',
  role: 'admin',
  employee_id: 1,
  contractor_id: null,
  enabled: true,
}
const adminSession = toSessionAccount(localAdmin)
check('local 映射保留 account_id', adminSession.account_id === 1)
check('local 映射保留 username', adminSession.username === 'admin')
check('local 映射保留 role=admin', adminSession.role === 'admin')
check('local 映射保留 employee_id', adminSession.employee_id === 1)
check('local 映射移除 password_placeholder', !('password_placeholder' in adminSession))

const localStaff: Account = {
  account_id: 2,
  username: 'staff',
  password_placeholder: 'demo1234',
  role: 'staff',
  employee_id: 2,
  contractor_id: null,
  enabled: true,
}
const staffSession = toSessionAccount(localStaff)
check('local staff 映射 role=staff + employee_id=2', staffSession.role === 'staff' && staffSession.employee_id === 2)

const localContractor: Account = {
  account_id: 3,
  username: 'contractor',
  password_placeholder: 'demo1234',
  role: 'contractor',
  employee_id: null,
  contractor_id: 1,
  enabled: true,
}
const contractorSession = toSessionAccount(localContractor)
check(
  'local contractor 映射 role=contractor + contractor_id=1',
  contractorSession.role === 'contractor' && contractorSession.contractor_id === 1 && contractorSession.employee_id === null,
)

// ---------------- 六、buildCloudSession 边界 ----------------
const row = (over: Partial<AccountRow> = {}): AccountRow => ({
  account_id: 1,
  username: 'admin',
  role: 'admin',
  employee_id: 1,
  contractor_id: null,
  enabled: true,
  ...over,
})
check('accounts 0 条 → 拒绝', buildCloudSession([]).ok === false)
check('accounts 2 条 → 拒绝', buildCloudSession([row({}), row({ account_id: 2 })]).ok === false)
check('accounts disabled → 拒绝', buildCloudSession([row({ enabled: false })]).ok === false)
check('accounts role 非法 → 拒绝', buildCloudSession([row({ role: 'root' } as AccountRow['role'])]).ok === false)

const okRes = buildCloudSession([
  row({ account_id: 3, username: 'contractor', role: 'contractor', employee_id: null, contractor_id: 7 }),
])
check('accounts 唯一 + enabled → 成功', okRes.ok === true)
if (okRes.ok) {
  check('生成 account_id=3', okRes.account.account_id === 3)
  check('生成 role=contractor', okRes.account.role === 'contractor')
  check('生成 contractor_id=7', okRes.account.contractor_id === 7)
  check('生成 employee_id=null', okRes.account.employee_id === null)
  check('SessionAccount 无 password_placeholder', !('password_placeholder' in okRes.account))
}

console.log('')
if (failed > 0) {
  console.log(`失败 ${failed} 项`)
  process.exit(1)
}
console.log('全部通过')
