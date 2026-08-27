import { storage, DB_KEY_STORAGE } from './storage'
import { createSeedDatabase } from './seed'
import { validateDatabase } from './validate'
import type { Database } from './types'

/** 数据库版本号：结构变更时递增，旧版本将触发重置 */
export const DB_VERSION = 1

const VERSION_KEY = 'snowpeak.db.version'

export type LoadResult =
  | { ok: true; db: Database }
  | { ok: false; reason: 'empty' | 'corrupted' | 'version-mismatch' }

/** 类型守卫：校验 localStorage 读出的未知值是否为合法 Database 结构 */
function isDatabase(value: unknown): value is Database {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const tables = [
    'accounts',
    'skill_levels',
    'stores',
    'customers',
    'employees',
    'rental_items',
    'contractors',
    'contractor_rates',
    'rental_contracts',
    'contract_lines',
    'contract_changes',
    'repair_orders',
    'shifts',
  ]
  return tables.every((t) => Array.isArray(v[t]))
}

/** 读取数据库：首次为空则初始化种子；损坏或版本不符则标记，交由界面提示重置 */
export function loadDatabase(): LoadResult {
  const version = storage.readJSON(VERSION_KEY)
  if (version === null) {
    const db = createSeedDatabase()
    saveDatabase(db)
    return { ok: true, db }
  }
  if (typeof version !== 'number' || version !== DB_VERSION) {
    return { ok: false, reason: 'version-mismatch' }
  }
  const raw = storage.readJSON(DB_KEY_STORAGE)
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'corrupted' }
  }
  if (!isDatabase(raw)) {
    return { ok: false, reason: 'corrupted' }
  }
  const validation = validateDatabase(raw)
  if (!validation.ok) {
    return { ok: false, reason: 'corrupted' }
  }
  return { ok: true, db: raw }
}

/** 保存数据库到 localStorage */
export function saveDatabase(db: Database): void {
  storage.writeJSON(VERSION_KEY, DB_VERSION)
  storage.writeJSON(DB_KEY_STORAGE, db)
}

/** 重置演示数据：清除并重新写入种子 */
export function resetDatabase(): Database {
  const db = createSeedDatabase()
  saveDatabase(db)
  return db
}
