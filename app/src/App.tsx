import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Loading } from 'tdesign-react'
import { AuthProvider } from './auth/AuthContext'
import { DbProvider, useDb } from './data/DbContext'
import { AppLayout } from './components/AppLayout'
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
  return (
    <DbProvider>
      <AppGate />
    </DbProvider>
  )
}

/** 根据数据库状态决定渲染：加载中 / 损坏恢复页 / 正常应用 */
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
