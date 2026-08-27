import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { roleHome } from '../auth/permissions'

/** 根路径角色感知跳转：admin/staff → /dashboard，contractor → /repairs */
export function HomeRedirect() {
  const { role } = useAuth()
  if (!role) {
    return <Navigate to="/login" replace />
  }
  return <Navigate to={roleHome[role]} replace />
}
