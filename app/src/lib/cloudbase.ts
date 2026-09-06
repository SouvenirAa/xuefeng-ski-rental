/**
 * CloudBase 共享客户端（单例）。
 * - 只在 cloud 模式下惰性初始化一次，避免重复创建实例；
 * - env/region/accessKey 均来自环境变量，通过 resolveConfig 集中校验；
 * - cloud 模式缺少任一必填配置 / dataMode 非法时 fail closed；
 * - 绝不打印 accessKey / token / session 到 console 或日志。
 */
import cloudbase from '@cloudbase/js-sdk'
import { resolveConfig, type ConfigResult, type DataMode } from './config'

let app: ReturnType<typeof cloudbase.init> | null = null
let initFail: string | null = null
let resolved: ConfigResult | null = null

/** 惰性解析并缓存（纯函数结果，可重复调用） */
function getResolved(): ConfigResult {
  if (!resolved) resolved = resolveConfig(import.meta.env)
  return resolved
}

/**
 * 当前有效数据模式；配置错误时返回 null（表示应阻塞，而非降级）。
 * 调用方必须以“配置错误 → 阻塞”处理，绝不能当作 local。
 */
export function getDataMode(): DataMode | null {
  const r = getResolved()
  return r.ok ? r.mode : null
}

/** 配置错误信息（安全，仅含变量名）；正常时返回 null */
export function getConfigError(): string | null {
  const r = getResolved()
  return r.ok ? null : r.error
}

/** 是否为可用的 cloud 模式（配置完整才为 true） */
export function isCloudMode(): boolean {
  const r = getResolved()
  return r.ok && r.mode === 'cloud'
}

/** 是否为可用的 local 模式 */
export function isLocalMode(): boolean {
  const r = getResolved()
  return r.ok && r.mode === 'local'
}

/** cloud 模式下获取（并惰性初始化）SDK 单例；配置缺失/非法时抛出明确错误 */
function getApp(): ReturnType<typeof cloudbase.init> {
  if (initFail) throw new Error(initFail)
  if (app) return app

  const result = getResolved()
  if (!result.ok) {
    initFail = result.error
    throw new Error(result.error)
  }
  if (result.mode !== 'cloud') {
    // local 模式下误调用：明确拒绝，绝不用空配置初始化 CloudBase
    initFail = '当前为本地模式，不应初始化 CloudBase 客户端'
    throw new Error(initFail)
  }
  const cfg = result.config

  app = cloudbase.init({
    env: cfg.envId,
    region: cfg.region,
    accessKey: cfg.accessKey,
    auth: { detectSessionInUrl: true },
  })
  return app
}

/** Auth 客户端（仅 cloud 模式调用） */
export function getAuth(): cloudbase.auth.App {
  return getApp().auth
}

/** PostgreSQL 客户端 app.rdb()（仅 cloud 模式调用；rdb 为工厂函数，需调用后使用 .from()） */
export function getRdb() {
  return getApp().rdb()
}
