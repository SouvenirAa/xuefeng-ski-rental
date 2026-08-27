import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Account, Role } from '../data/types'
import { dataService } from '../data/dataService'
import { storage, SESSION_KEY_STORAGE } from '../data/storage'

/** 会话内容（仅存用户名，刷新后从 DataService 恢复完整账号） */
interface SessionPayload {
  username: string
}

export interface AuthContextValue {
  account: Account | null
  role: Role | null
  ready: boolean
  login: (
    username: string,
    password: string,
  ) => { ok: boolean; error?: string; role?: Role }
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [ready, setReady] = useState(false)

  // 初始化：从会话恢复账号（刷新后保持登录态）
  useEffect(() => {
    const raw = storage.readJSON(SESSION_KEY_STORAGE)
    if (typeof raw === 'object' && raw !== null) {
      const payload = raw as Partial<SessionPayload>
      if (typeof payload.username === 'string') {
        const restored = dataService.findByUsername(payload.username)
        if (restored?.enabled) {
          setAccount(restored)
        } else {
          storage.remove(SESSION_KEY_STORAGE)
        }
      }
    }
    setReady(true)
  }, [])

  const login = useCallback((username: string, password: string) => {
    const found = dataService.verifyLogin(username, password)
    if (!found) {
      return { ok: false, error: '用户名或密码不正确' }
    }
    setAccount(found)
    const payload: SessionPayload = { username: found.username }
    storage.writeJSON(SESSION_KEY_STORAGE, payload)
    return { ok: true, role: found.role }
  }, [])

  const logout = useCallback(() => {
    setAccount(null)
    storage.remove(SESSION_KEY_STORAGE)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      role: account?.role ?? null,
      ready,
      login,
      logout,
    }),
    [account, ready, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用')
  }
  return ctx
}
