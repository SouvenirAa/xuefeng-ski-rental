import { useRef, useSyncExternalStore } from 'react'
import { dataService } from '../data/dataService'

/** disabled 时使用的稳定快照与订阅：不订阅 DataService、不读取版本 */
const noopSubscribe = () => () => {}
const noopGetSnapshot = () => 0

/**
 * enabled 为 false 时必须提供类型安全的 disabledValue（禁止用 undefined 伪装成 T）；
 * enabled 缺省或为 true 时无需 disabledValue。
 */
export type UseDbDataOptions<T> =
  | { enabled?: true; disabledValue?: undefined }
  | { enabled: false; disabledValue: T }

/**
 * 订阅 DataService 数据版本并返回最新读取结果。
 * 写操作成功后版本递增 → 触发重渲染 → 重新 read 并缓存；版本不变时直接返回缓存。
 * 用 useSyncExternalStore + useRef 缓存，避免把 version 放进 useMemo 依赖触发 lint 告警。
 *
 * enabled=false（如 cloud 模式）：必须提供类型安全的 disabledValue，
 * 不订阅、不执行 read，避免触碰本地 DataService / localStorage。
 * 无论 enabled 与否，Hooks 调用顺序固定不变。
 */
export function useDbData<T>(read: () => T, options?: UseDbDataOptions<T>): T {
  const disabled = options !== undefined && options.enabled === false
  const version = useSyncExternalStore(
    disabled ? noopSubscribe : (onChange) => dataService.subscribe(onChange),
    disabled ? noopGetSnapshot : () => dataService.getVersion(),
  )
  const readRef = useRef(read)
  readRef.current = read
  const cacheRef = useRef<{ version: number; data: T } | null>(null)

  // 此处用 options 直接判空收窄：disabled 时 options 必为 { enabled:false; disabledValue:T }，
  // disabledValue 类型为 T（非 undefined），无需 `as T` 伪装。
  if (options !== undefined && options.enabled === false) {
    return options.disabledValue
  }
  if (cacheRef.current === null || cacheRef.current.version !== version) {
    cacheRef.current = { version, data: readRef.current() }
  }
  return cacheRef.current.data
}
