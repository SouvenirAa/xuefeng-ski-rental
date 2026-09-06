import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Role } from '../data/types'
import { dataService } from '../data/dataService'
import { storage, SESSION_KEY_STORAGE } from '../data/storage'
import { isCloudMode, getConfigError, getAuth, getRdb } from '../lib/cloudbase'
import {
  buildCloudSession,
  toSessionAccount,
  type AccountRow,
  type SessionAccount,
} from './session'

/** 本地会话内容（仅存用户名，刷新后从 DataService 恢复完整账号） */
interface SessionPayload {
  username: string
}

export interface AuthContextValue {
  /** 会话账号（不含 password_placeholder，local/cloud 统一） */
  account: SessionAccount | null
  role: Role | null
  ready: boolean
  login: (
    username: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string; role?: Role }>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** cloud 模式：按 uid 精确查询完整且唯一的账号行；异常时 signOut 并拒绝 */
async function loadCloudAccount(uid: string): Promise<
  { ok: true; account: SessionAccount } | { ok: false; error: string }
> {
  const auth = getAuth()
  const rdb = getRdb()
  const { data, error } = await rdb
    .from('accounts')
    .select('account_id, username, role, employee_id, contractor_id, enabled')
    .eq('uid', uid)
    .limit(2)

  if (error) {
    await auth.signOut().catch(() => undefined)
    return { ok: false, error: '账号查询失败' }
  }

  const rows = (data ?? []) as AccountRow[]
  const result = buildCloudSession(rows)
  if (!result.ok) {
    await auth.signOut().catch(() => undefined)
    return { ok: false, error: result.error }
  }
  return { ok: true, account: result.account }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<SessionAccount | null>(null)
  const [ready, setReady] = useState(false)

  // 初始化：异步恢复会话（local 读 localStorage；cloud 走 getSession + accounts）
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      try {
        // 配置错误：不恢复任何会话（local 也不读 localStorage、不初始化登录态）
        if (getConfigError()) {
          if (!cancelled) setAccount(null)
          return
        }
        if (isCloudMode()) {
          const { data, error } = await getAuth().getSession()
          if (error || !data?.session?.user?.id) {
            if (!cancelled) setAccount(null)
            return
          }
          const result = await loadCloudAccount(data.session.user.id)
          if (!cancelled) setAccount(result.ok ? result.account : null)
        } else {
          const raw = storage.readJSON(SESSION_KEY_STORAGE)
          if (typeof raw === 'object' && raw !== null) {
            const payload = raw as Partial<SessionPayload>
            if (typeof payload.username === 'string') {
              const restored = dataService.findByUsername(payload.username)
              if (restored?.enabled) {
                if (!cancelled) setAccount(toSessionAccount(restored))
              } else {
                storage.remove(SESSION_KEY_STORAGE)
              }
            }
          }
        }
      } catch {
        if (!cancelled) setAccount(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      // 配置错误：直接返回明确错误，不降级走 local，也不抛异常
      const configError = getConfigError()
      if (configError) {
        return { ok: false, error: configError }
      }

      if (isCloudMode()) {
        const { data, error } = await getAuth().signInWithPassword({
          username: username.trim(),
          password,
        })
        if (error || !data?.session?.user?.id) {
          return { ok: false, error: '用户名或密码不正确' }
        }
        // 登录成功后必须再次按 session.user.id 加载完整账号行
        const result = await loadCloudAccount(data.session.user.id)
        if (!result.ok) {
          setAccount(null)
          return { ok: false, error: result.error }
        }
        setAccount(result.account)
        return { ok: true, role: result.account.role }
      }

      // local：保留现有 DataService 验证，仅包装为 Promise
      const found = dataService.verifyLogin(username, password)
      if (!found) {
        return { ok: false, error: '用户名或密码不正确' }
      }
      const session = toSessionAccount(found)
      setAccount(session)
      storage.writeJSON(SESSION_KEY_STORAGE, { username: found.username } satisfies SessionPayload)
      return { ok: true, role: session.role }
    },
    [],
  )

  const logout = useCallback(async () => {
    if (isCloudMode()) {
      // 退出失败会抛出，由调用方提示，不假装已退出
      await getAuth().signOut()
    }
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
