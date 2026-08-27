import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { dataService } from './dataService'

export type DbStatus = 'loading' | 'ready' | 'error'
export type DbErrorReason = 'corrupted' | 'version-mismatch'

interface DbContextValue {
  status: DbStatus
  reason: DbErrorReason | null
  /** 每次重置递增，供数据展示页面订阅以重新读取 */
  revision: number
  reset: () => void
}

const DbContext = createContext<DbContextValue | null>(null)

/** 数据库生命周期管理：初始化、损坏状态暴露、重置。页面经此订阅，重置后可同步刷新。 */
export function DbProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DbStatus>('loading')
  const [reason, setReason] = useState<DbErrorReason | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const result = dataService.init()
    if (result.ok) {
      setStatus('ready')
      setReason(null)
    } else {
      // result.reason 只可能是 'corrupted' | 'version-mismatch'（'empty' 会内部初始化）
      setReason(result.reason === 'version-mismatch' ? 'version-mismatch' : 'corrupted')
      setStatus('error')
    }
  }, [])

  // 订阅 DataService 变更：写操作成功或重置后触发，使页面重新读取
  useEffect(() => {
    return dataService.subscribe(() => setRevision((r) => r + 1))
  }, [])

  const reset = useCallback(() => {
    dataService.reset()
    setStatus('ready')
    setReason(null)
  }, [])

  const value = useMemo<DbContextValue>(
    () => ({ status, reason, revision, reset }),
    [status, reason, revision, reset],
  )

  return <DbContext.Provider value={value}>{children}</DbContext.Provider>
}

export function useDb(): DbContextValue {
  const ctx = useContext(DbContext)
  if (!ctx) {
    throw new Error('useDb 必须在 DbProvider 内使用')
  }
  return ctx
}
