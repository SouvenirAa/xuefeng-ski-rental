import { useMemo, useState } from 'react'
import { paginate, type Page } from '../utils/pagination'

/**
 * 本地列表分页状态：管理当前页与每页条数，返回分页结果。
 * 过滤在调用方完成；keyword/筛选变化时调用方需 resetPage。
 */
export function usePagination<T>(filtered: T[], defaultPageSize = 10) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)

  const paged: Page<T> = useMemo(
    () => paginate(filtered, page, pageSize),
    [filtered, page, pageSize],
  )

  return {
    page,
    pageSize,
    setPage,
    setPageSize,
    paged,
    total: filtered.length,
  }
}
