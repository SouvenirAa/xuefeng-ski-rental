import { useNavigate } from 'react-router-dom'
import { Button, Tag } from 'tdesign-react'
import {
  DesktopIcon,
  ShopIcon,
  UserIcon,
} from 'tdesign-icons-react'
import { useAuth } from '../auth/AuthContext'
import { roleLabel } from '../auth/permissions'
import { PageHeader } from '../components/PageHeader'

interface Entry {
  label: string
  desc: string
  path: string
  icon: React.ReactElement
}

/** 管理员可用功能入口 */
const adminEntries: Entry[] = [
  { label: '客户管理', desc: '登记与查询客户，识别回头客', path: '/customers', icon: <UserIcon /> },
  { label: '设备管理', desc: '维护租赁物品、技能等级与门店', path: '/items', icon: <DesktopIcon /> },
  { label: '门店管理', desc: '维护门店基础信息', path: '/stores', icon: <ShopIcon /> },
]

/** 店员可用功能入口 */
const staffEntries: Entry[] = [
  { label: '登记/管理客户', desc: '新增、编辑与查询客户', path: '/customers', icon: <UserIcon /> },
  { label: '查看设备', desc: '按类别、状态、门店浏览设备', path: '/items', icon: <DesktopIcon /> },
]

export function Dashboard() {
  const { account, role } = useAuth()
  const navigate = useNavigate()

  const entries = role === 'staff' ? staffEntries : adminEntries

  return (
    <div>
      <PageHeader
        title="管理驾驶舱"
        subtitle="当前可用功能入口；完整经营驾驶舱将在后续批次实现"
      />
      <div
        style={{
          background: 'var(--snowpeak-bg-container)',
          border: '1px solid var(--snowpeak-border)',
          borderRadius: 8,
          padding: '24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>
            欢迎，{account?.username}
          </span>
          {role ? (
            <Tag
              variant="light-outline"
              style={{ color: 'var(--snowpeak-accent)', background: 'var(--snowpeak-accent-subtle)', borderColor: 'transparent' }}
            >
              {roleLabel[role]}
            </Tag>
          ) : null}
        </div>

        <div
          style={{
            marginBottom: 8,
            fontSize: 12,
            color: 'var(--snowpeak-text-secondary)',
          }}
        >
          当前可用功能
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {entries.map((e) => (
            <div
              key={e.path}
              style={{
                border: '1px solid var(--snowpeak-border)',
                borderRadius: 8,
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'var(--snowpeak-bg-page)',
              }}
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--snowpeak-primary-subtle)',
                  color: 'var(--snowpeak-primary)',
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                {e.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</div>
                <div style={{ fontSize: 12, color: 'var(--snowpeak-text-secondary)', marginTop: 2 }}>
                  {e.desc}
                </div>
              </div>
              <Button size="small" variant="outline" onClick={() => navigate(e.path)}>
                进入
              </Button>
            </div>
          ))}
        </div>

        <p
          style={{
            margin: '16px 0 0',
            fontSize: 12,
            color: 'var(--snowpeak-text-placeholder)',
            lineHeight: 1.8,
          }}
        >
          完整经营驾驶舱（设备利用率、本月营收、平均维修周转时长、门店库存分布等 KPI 与趋势图）
          将在后续批次接入 ECharts 图表后实现。当前版本为教学演示环境，仅提供基础资料管理能力。
        </p>
      </div>
    </div>
  )
}
