/**
 * 通用「安全云读取边界」（fail-closed），供客户 / 门店 / 设备等各数据源的云读取复用，
 * 避免把同步 throw / Promise reject / SDK error 三套异常收口复制多份。
 *
 * 语义：
 * - cloudRead 同步 throw（如 getRdb() 在参数求值阶段同步抛错）→ resolve(fallback)；
 * - cloudRead 返回的 Promise reject（如 SDK 网络异常）→ resolve(fallback)；
 * - 正常 resolve 原样透传。
 * 返回的 Promise 永不 reject，始终 resolve 为 T；
 * 绝不调用任何本地 reader、绝不回退 DataService / localStorage。
 */
export function safeCloudLoad<T>(cloudRead: () => Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    try {
      const p = cloudRead()
      Promise.resolve(p).then(resolve).catch(() => {
        resolve(fallback)
      })
    } catch {
      resolve(fallback)
    }
  })
}
