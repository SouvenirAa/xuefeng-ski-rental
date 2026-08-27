/** 通用分页与搜索结果类型 */

/** 分页结果 */
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** 列表查询通用参数 */
export interface ListQuery {
  page: number
  pageSize: number
  keyword?: string
}

/** 对数组做内存分页 */
export function paginate<T>(
  list: T[],
  page: number,
  pageSize: number,
): Page<T> {
  const safePage = Math.max(1, page)
  const safeSize = Math.max(1, pageSize)
  const start = (safePage - 1) * safeSize
  const items = list.slice(start, start + safeSize)
  return { items, total: list.length, page: safePage, pageSize: safeSize }
}

/** 关键词匹配（大小写不敏感，作用于若干字段） */
export function matchesKeyword<T>(record: T, keyword: string, fields: (keyof T)[]): boolean {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return true
  return fields.some((f) => {
    const v = record[f]
    return typeof v === 'string' || typeof v === 'number'
      ? String(v).toLowerCase().includes(kw)
      : false
  })
}
