/**
 * localStorage 存储适配器。
 * 页面与业务代码不得直接操作 localStorage，统一经由此模块（以及 db.ts / dataService）。
 */

const DB_KEY = 'snowpeak.db.v1'
const SESSION_KEY = 'snowpeak.session.v1'

export interface StorageAdapter {
  readJSON(key: string): unknown
  writeJSON(key: string, value: unknown): void
  remove(key: string): void
}

export const storage: StorageAdapter = {
  readJSON(key) {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as unknown
    } catch {
      // JSON 损坏：交由上层 db.ts 判定并提示/重置
      return undefined
    }
  },
  writeJSON(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value))
  },
  remove(key) {
    window.localStorage.removeItem(key)
  },
}

export const DB_KEY_STORAGE = DB_KEY
export const SESSION_KEY_STORAGE = SESSION_KEY
