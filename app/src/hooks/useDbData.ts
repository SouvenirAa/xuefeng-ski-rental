import { useRef, useSyncExternalStore } from 'react'
import { dataService } from '../data/dataService'

/**
 * 订阅 DataService 数据版本并返回最新读取结果。
 * 写操作成功后版本递增 → 触发重渲染 → 重新 read 并缓存；版本不变时直接返回缓存。
 * 用 useSyncExternalStore + useRef 缓存，避免把 version 放进 useMemo 依赖触发 lint 告警。
 */
export function useDbData<T>(read: () => T): T {
  const version = useSyncExternalStore(
    (onChange) => dataService.subscribe(onChange),
    () => dataService.getVersion(),
  )
  const readRef = useRef(read)
  readRef.current = read
  const cacheRef = useRef<{ version: number; data: T } | null>(null)
  if (cacheRef.current === null || cacheRef.current.version !== version) {
    cacheRef.current = { version, data: readRef.current() }
  }
  return cacheRef.current.data
}
