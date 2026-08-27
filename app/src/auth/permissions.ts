import type { Role } from '../data/types'

/**
 * 权限配置 —— 集中管理，页面/组件不得散落硬编码角色判断。
 * 依据 docs/03 §3 页面清单与 docs/02 §4 权限矩阵。
 */

export interface RouteRule {
  path: string
  roles: Role[]
}

/** 路由权限规则（前缀匹配） */
export const routeRules: RouteRule[] = [
  { path: '/dashboard', roles: ['admin', 'staff'] },
  { path: '/customers', roles: ['admin', 'staff'] },
  { path: '/items', roles: ['admin', 'staff'] },
  { path: '/stores', roles: ['admin'] },
  { path: '/contractors', roles: ['admin'] },
  { path: '/employees', roles: ['admin'] },
  { path: '/contracts', roles: ['admin', 'staff'] },
  { path: '/repairs', roles: ['admin', 'staff', 'contractor'] },
]

/** 角色登录后默认首页 */
export const roleHome: Record<Role, string> = {
  admin: '/dashboard',
  staff: '/dashboard',
  contractor: '/repairs',
}

/** 角色中文名 */
export const roleLabel: Record<Role, string> = {
  admin: '管理员',
  staff: '店员',
  contractor: '承包商',
}

/** 判断某角色能否访问某路径（前缀匹配，如 /contracts 覆盖 /contracts/:id） */
export function canAccess(role: Role, path: string): boolean {
  const rule = routeRules.find((r) => path.startsWith(r.path))
  if (!rule) return false
  return rule.roles.includes(role)
}

/** 侧边栏菜单项（按角色过滤） */
export interface MenuItem {
  path: string
  label: string
}

export const allMenuItems: MenuItem[] = [
  { path: '/dashboard', label: '驾驶舱' },
  { path: '/customers', label: '客户管理' },
  { path: '/items', label: '设备管理' },
  { path: '/stores', label: '门店管理' },
  { path: '/contractors', label: '承包商管理' },
  { path: '/employees', label: '员工与排班' },
  { path: '/contracts', label: '租赁合同' },
  { path: '/repairs', label: '维修单' },
]

/** 按角色生成可访问菜单 */
export function menuForRole(role: Role): MenuItem[] {
  return allMenuItems.filter((item) => canAccess(role, item.path))
}
