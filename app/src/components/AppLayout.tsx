import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Breadcrumb,
  DialogPlugin,
  Dropdown,
  Layout,
  Menu,
  MessagePlugin,
  Tag,
  type MenuValue,
} from 'tdesign-react'
import {
  ChevronDownIcon,
  DashboardIcon,
  DesktopIcon,
  FileIcon,
  LogoutIcon,
  RefreshIcon,
  ShopIcon,
  ToolsIcon,
  UserCircleIcon,
  UserIcon,
  UsergroupIcon,
} from 'tdesign-icons-react'
import type { ReactElement } from 'react'
import { useAuth } from '../auth/AuthContext'
import { menuForRole, roleLabel } from '../auth/permissions'
import { useDb } from '../data/DbContext'
import { isCloudMode } from '../lib/cloudbase'
import { demoTag } from '../theme'

const { Header, Aside, Content } = Layout

const iconMap: Record<string, ReactElement> = {
  '/dashboard': <DashboardIcon />,
  '/customers': <UserIcon />,
  '/items': <DesktopIcon />,
  '/stores': <ShopIcon />,
  '/contractors': <UsergroupIcon />,
  '/employees': <UserCircleIcon />,
  '/contracts': <FileIcon />,
  '/repairs': <ToolsIcon />,
}

const pathLabel: Record<string, string> = {
  '/dashboard': '驾驶舱',
  '/customers': '客户管理',
  '/items': '设备管理',
  '/stores': '门店管理',
  '/contractors': '承包商管理',
  '/employees': '员工与排班',
  '/contracts': '租赁合同',
  '/repairs': '维修单',
}

/** 根据当前路径定位所属菜单项 */
function activeMenu(path: string): string {
  const keys = Object.keys(pathLabel).sort((a, b) => b.length - a.length)
  return keys.find((k) => path.startsWith(k)) ?? '/dashboard'
}

export function AppLayout() {
  const { account, role, logout } = useAuth()
  const { reset: resetDb } = useDb()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const onResize = () => setCollapsed(window.innerWidth < 1280)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!role) return null

  const items = menuForRole(role)
  const active = activeMenu(location.pathname)

  const handleMenuChange = (value: MenuValue) => {
    navigate(String(value))
  }

  const handleReset = () => {
    const dialog = DialogPlugin.confirm({
      header: '重置演示数据',
      body: '将清除当前所有本地数据，并恢复为内置种子数据。此操作不可撤销，确认继续？',
      confirmBtn: '确认重置',
      cancelBtn: '取消',
      theme: 'warning',
      onConfirm: () => {
        resetDb()
        MessagePlugin.success('演示数据已重置')
        dialog.hide()
      },
      onClose: () => dialog.hide(),
    })
  }

  // cloud 模式隐藏「重置演示数据」，仅保留退出登录
  const userMenu = isCloudMode()
    ? [{ content: '退出登录', value: 'logout', prefixIcon: <LogoutIcon /> }]
    : [
        { content: '重置演示数据', value: 'reset', prefixIcon: <RefreshIcon /> },
        { content: '退出登录', value: 'logout', prefixIcon: <LogoutIcon /> },
      ]

  const handleUserAction = async (value: string | number) => {
    if (value === 'reset') {
      handleReset()
    } else if (value === 'logout') {
      try {
        await logout()
        navigate('/login', { replace: true })
      } catch {
        // 退出失败：保持登录态，提示错误，不假装已退出
        MessagePlugin.error('退出登录失败，请稍后重试')
      }
    }
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <Aside
        width={collapsed ? '64px' : '208px'}
        className="snowpeak-aside"
        style={{ background: 'var(--snowpeak-primary-deep)', transition: 'width 0.2s' }}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            color: '#fff',
            gap: 8,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            className="font-serif"
            style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}
          >
            {collapsed ? '雪' : '雪峰滑雪租赁'}
          </span>
        </div>
        <div className="snowline" />
        <Menu
          value={active}
          onChange={handleMenuChange}
          theme="dark"
          collapsed={collapsed}
          style={{ background: 'transparent' }}
        >
          {items.map((item) => (
            <Menu.MenuItem key={item.path} value={item.path} icon={iconMap[item.path]}>
              {item.label}
            </Menu.MenuItem>
          ))}
        </Menu>
      </Aside>

      <Layout style={{ minWidth: 0 }}>
        <Header
          style={{
            height: 56,
            background: '#fff',
            borderBottom: '1px solid var(--snowpeak-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
          }}
        >
          <Breadcrumb style={{ fontSize: 13 }}>
            <Breadcrumb.BreadcrumbItem>雪峰滑雪租赁</Breadcrumb.BreadcrumbItem>
            <Breadcrumb.BreadcrumbItem>{pathLabel[active] ?? ''}</Breadcrumb.BreadcrumbItem>
          </Breadcrumb>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Tag
              variant="light-outline"
              style={{ color: demoTag.color, background: demoTag.bg, borderColor: demoTag.bg }}
            >
              教学演示环境
            </Tag>
            <Dropdown
              options={userMenu}
              onClick={(data) => handleUserAction(String(data.value))}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--snowpeak-text)',
                }}
              >
                {account?.username}
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>({roleLabel[role]})</span>
                <ChevronDownIcon />
              </span>
            </Dropdown>
          </div>
        </Header>

        <Content
          style={{
            padding: 20,
            overflow: 'auto',
            minWidth: 0,
            background: 'var(--snowpeak-bg-page)',
          }}
        >
          {isCloudMode() && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                fontSize: 13,
                color: 'var(--snowpeak-accent)',
                background: 'var(--snowpeak-accent-subtle)',
                border: '1px solid var(--snowpeak-accent)',
                borderRadius: 6,
              }}
            >
              客户列表已接入 CloudBase PostgreSQL；客户写入及其他业务模块仍处于迁移阶段。
            </div>
          )}
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
