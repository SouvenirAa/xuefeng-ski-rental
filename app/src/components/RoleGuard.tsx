import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { routeRules } from '../auth/permissions'

/** 角色守卫：路径匹配到权限规则但角色不符时跳转 /403；未知路径放行交由 404 处理 */
export function RoleGuard() {
  const { role } = useAuth()
  const location = useLocation()

  if (role) {
    const rule = routeRules.find((r) => location.pathname.startsWith(r.path))
    if (rule && !rule.roles.includes(role)) {
      return <Navigate to="/403" replace />
    }
  }

  return <Outlet />
}
