import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Loading } from 'tdesign-react'
import { AuthProvider } from './auth/AuthContext'
import { DbProvider, useDb } from './data/DbContext'
import { getConfigError } from './lib/cloudbase'
import { AppLayout } from './components/AppLayout'
import { ConfigErrorPage } from './components/ConfigErrorPage'
import { HomeRedirect } from './components/HomeRedirect'
import { ProtectedRoute } from './components/ProtectedRoute'
import { RoleGuard } from './components/RoleGuard'
import { Dashboard } from './pages/Dashboard'
import { DataRecovery } from './pages/DataRecovery'
import { Forbidden } from './pages/Forbidden'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { Customers } from './pages/customers/Customers'
import { Items } from './pages/items/Items'
import { Stores } from './pages/stores/Stores'
import { Contractors } from './pages/contractors/Contractors'
import { Employees } from './pages/employees/Employees'
import { Contracts } from './pages/contracts/Contracts'
import { ContractNew } from './pages/contracts/ContractNew'
import { ContractDetail } from './pages/contracts/ContractDetail'
import { Repairs } from './pages/repairs/Repairs'

export function App() {
  // 配置门禁：必须在 DbProvider 之前，避免配置错误时挂载 DbProvider 并初始化/读写本地数据库。
  // dataMode 非法或 cloud 缺必填配置时，直接渲染错误页，不挂载 DbProvider / AuthProvider，
  // 不初始化 dataService，不进入 Router 和业务页面（fail-closed）。
  const configError = getConfigError()
  if (configError) {
    return <ConfigErrorPage message={configError} />
  }

  return (
    <DbProvider>
      <AppGate />
    </DbProvider>
  )
}

/** 仅负责数据库 loading / error / ready，配置门禁已上移到 App() 最外层 */
function AppGate() {
  const { status } = useDb()

  if (status === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
        }}
      >
        <Loading text="加载中..." />
      </div>
    )
  }

  if (status === 'error') {
    return <DataRecovery />
  }

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              {/* 403 页面不经过角色守卫，避免重定向死循环 */}
              <Route path="/403" element={<Forbidden />} />

              <Route element={<RoleGuard />}>
                <Route path="/" element={<HomeRedirect />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/customers" element={<Customers />} />
                <Route path="/items" element={<Items />} />
                <Route path="/stores" element={<Stores />} />
                <Route path="/contractors" element={<Contractors />} />
                <Route path="/employees" element={<Employees />} />
                <Route path="/contracts" element={<Contracts />} />
                <Route path="/contracts/new" element={<ContractNew />} />
                <Route path="/contracts/:id" element={<ContractDetail />} />
                <Route path="/repairs" element={<Repairs />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
