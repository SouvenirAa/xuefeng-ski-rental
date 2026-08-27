import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Loading } from 'tdesign-react'

/** 登录保护：未登录跳转 /login（记录来源，登录后可回跳） */
export function ProtectedRoute() {
  const { account, ready } = useAuth()
  const location = useLocation()

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Loading text="加载中..." />
      </div>
    )
  }

  if (!account) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
