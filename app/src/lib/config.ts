/**
 * 集中配置读取（纯逻辑，不读取 import.meta.env，便于单测）。
 * 前端由 cloudbase 单例把 import.meta.env 传入；测试脚本传入假对象。
 *
 * 模式语义（fail-closed）：
 * - VITE_DATA_MODE 缺失 / 空字符串 → local（保留本地开发体验）；
 * - 精确 local → local；
 * - 精确 cloud → 始终保持 cloud 意图，即使其它云变量缺失也绝不降级 local；
 * - 其它非空值 → 配置错误，禁止进入 local 或 cloud 任何业务流程。
 *
 * 安全约束：错误信息只列缺失变量名，绝不包含任何值（尤其 Access Key / Token / Session）。
 */

export type DataMode = 'local' | 'cloud'

export interface CloudConfig {
  dataMode: DataMode
  envId: string
  region: string
  accessKey: string
  /** cloud 模式下是否已具备完整配置 */
  cloudConfigured: boolean
}

/** 模式解析结果：有效模式，或非法值错误 */
export type ModeResolution =
  | { ok: true; mode: DataMode }
  | { ok: false; error: string }

/**
 * 完整配置解析结果：
 * - ok=true  → local 正常 / cloud 完整；
 * - ok=false → 配置错误。mode 保留“用户请求的意图”（cloud 或 null=非法），
 *   调用方据此绝不把 cloud 降级为 local。
 */
export type ConfigResult =
  | { ok: true; mode: DataMode; config: CloudConfig }
  | { ok: false; mode: DataMode | null; error: string }

/** 解析用户请求的模式（不因配置不完整而改变） */
export function resolveDataMode(raw: string | undefined | null): ModeResolution {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, mode: 'local' }
  }
  if (raw === 'local') return { ok: true, mode: 'local' }
  if (raw === 'cloud') return { ok: true, mode: 'cloud' }
  // 其它非空值一律视为配置错误，不静默回退 local
  return { ok: false, error: 'VITE_DATA_MODE 取值非法' }
}

/** cloud 模式必填配置项（缺一即 fail closed） */
const CLOUD_REQUIRED_KEYS = [
  'VITE_CLOUDBASE_ENV_ID',
  'VITE_CLOUDBASE_REGION',
  'VITE_CLOUDBASE_ACCESS_KEY',
] as const

type EnvLike = Record<string, string | undefined>

export function resolveConfig(env: EnvLike): ConfigResult {
  const modeRes = resolveDataMode(env.VITE_DATA_MODE)
  if (!modeRes.ok) {
    return { ok: false, mode: null, error: modeRes.error }
  }
  const mode = modeRes.mode

  if (mode === 'local') {
    return {
      ok: true,
      mode: 'local',
      config: {
        dataMode: 'local',
        envId: env.VITE_CLOUDBASE_ENV_ID ?? '',
        region: env.VITE_CLOUDBASE_REGION ?? '',
        accessKey: env.VITE_CLOUDBASE_ACCESS_KEY ?? '',
        cloudConfigured: false,
      },
    }
  }

  // cloud：缺失必填项即 fail closed，保持 cloud 意图，错误信息仅含变量名
  const missing = CLOUD_REQUIRED_KEYS.filter((k) => !env[k])
  if (missing.length > 0) {
    return { ok: false, mode: 'cloud', error: `CloudBase 配置缺失：${missing.join(', ')}` }
  }

  return {
    ok: true,
    mode: 'cloud',
    config: {
      dataMode: 'cloud',
      envId: env.VITE_CLOUDBASE_ENV_ID as string,
      region: env.VITE_CLOUDBASE_REGION as string,
      accessKey: env.VITE_CLOUDBASE_ACCESS_KEY as string,
      cloudConfigured: true,
    },
  }
}
