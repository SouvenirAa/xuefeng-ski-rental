/**
 * 会话账号类型与映射（纯逻辑，可被校验脚本直接测试）。
 *
 * 关键设计：
 * - 本地 Account 含 password_placeholder，属本地专用，不得暴露给页面；
 * - 云端 accounts 表无密码字段（7 列：account_id/uid/username/role/
 *   employee_id/contractor_id/enabled）；
 * - SessionAccount 是 AuthContext 对外唯一的会话类型，不含任何密码相关字段。
 */
import type { Account, Role } from '../data/types'

/** AuthContext 对外暴露的会话账号（不含 password_placeholder、不含 uid） */
export interface SessionAccount {
  account_id: number
  username: string
  role: Role
  employee_id: number | null
  contractor_id: number | null
  enabled: boolean
}

/** 本地 Account → SessionAccount：剥离 password_placeholder */
export function toSessionAccount(account: Account): SessionAccount {
  return {
    account_id: account.account_id,
    username: account.username,
    role: account.role,
    employee_id: account.employee_id,
    contractor_id: account.contractor_id,
    enabled: account.enabled,
  }
}

/** 云端 accounts 行（数值可能为 string/bigint，需归一化） */
export interface AccountRow {
  account_id: number | string
  username: string
  role: string
  employee_id: number | string | null
  contractor_id: number | string | null
  enabled: boolean
}

export type CloudSessionResult =
  | { ok: true; account: SessionAccount }
  | { ok: false; error: string }

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const VALID_ROLES: Role[] = ['admin', 'staff', 'contractor']

/**
 * 由云端 accounts 行构建会话：
 * - 0 条 → 拒绝（账号未绑定）；
 * - 超过 1 条 → 拒绝（异常）；
 * - enabled=false → 拒绝；
 * - 唯一且 enabled、role 合法 → 生成正确 SessionAccount。
 */
export function buildCloudSession(rows: AccountRow[]): CloudSessionResult {
  if (rows.length === 0) {
    return { ok: false, error: '账号未绑定或已禁用' }
  }
  if (rows.length > 1) {
    return { ok: false, error: '账号绑定异常：存在多条匹配记录' }
  }
  const row = rows[0]
  if (!row.enabled) {
    return { ok: false, error: '账号未绑定或已禁用' }
  }
  if (!VALID_ROLES.includes(row.role as Role)) {
    return { ok: false, error: '账号角色非法' }
  }
  return {
    ok: true,
    account: {
      account_id: Number(row.account_id),
      username: row.username,
      role: row.role as Role,
      employee_id: toNum(row.employee_id),
      contractor_id: toNum(row.contractor_id),
      enabled: row.enabled,
    },
  }
}
