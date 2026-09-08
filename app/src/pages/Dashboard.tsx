import { useNavigate } from 'react-router-dom'
import { Button, Table, Tag, Tooltip, type PrimaryTableCol } from 'tdesign-react'
import {
  DesktopIcon,
  ShopIcon,
  UserIcon,
} from 'tdesign-icons-react'
import { useAuth } from '../auth/AuthContext'
import { roleLabel } from '../auth/permissions'
import { PageHeader } from '../components/PageHeader'
import { useDashboard } from '../hooks/useDashboard'
import { formatUtilizationRate } from '../data/dashboardDataSource'
import type { StoreDistributionItem } from '../data/cloudDashboard'
import { formatMoney, today } from '../utils/format'

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

const cardStyle: React.CSSProperties = {
  background: 'var(--snowpeak-bg-container)',
  border: '1px solid var(--snowpeak-border)',
  borderRadius: 8,
  padding: 16,
}

const kpiTitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--snowpeak-text-secondary)',
  marginBottom: 8,
}

const kpiValueStyle: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 28,
  fontWeight: 600,
  color: 'var(--snowpeak-text)',
}

const kpiHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--snowpeak-text-placeholder)',
  marginTop: 4,
  lineHeight: 1.7,
}

const distributionColumns: PrimaryTableCol<StoreDistributionItem>[] = [
  { colKey: 'store_name', title: '门店', ellipsis: true },
  {
    colKey: 'inStock',
    title: '在库',
    width: 80,
    align: 'right',
    cell: ({ row }) => <span className="num">{row.inStock}</span>,
  },
  {
    colKey: 'rented',
    title: '借出中',
    width: 80,
    align: 'right',
    cell: ({ row }) => <span className="num">{row.rented}</span>,
  },
  {
    colKey: 'repairing',
    title: '维修中',
    width: 80,
    align: 'right',
    cell: ({ row }) => <span className="num">{row.repairing}</span>,
  },
  {
    colKey: 'scrapped',
    title: '已报废',
    width: 80,
    align: 'right',
    cell: ({ row }) => <span className="num">{row.scrapped}</span>,
  },
]

export function Dashboard() {
  const { account, role } = useAuth()
  const navigate = useNavigate()
  const { kpi, loading, error, retry } = useDashboard()

  const entries = role === 'staff' ? staffEntries : adminEntries
  const monthLabel = today().slice(0, 7)

  const hasData = kpi !== null && (kpi.validCount > 0 || kpi.storeDistribution.length > 0 || kpi.monthlyRevenue > 0 || kpi.completedRepairCount > 0)

  return (
    <div>
      <PageHeader
        title="管理驾驶舱"
        subtitle="设备利用率、本月营收、平均维修周转与门店库存分布（由系统数据按既定口径计算）"
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600 }}>欢迎，{account?.username}</span>
        {role ? (
          <Tag
            variant="light-outline"
            style={{ color: 'var(--snowpeak-accent)', background: 'var(--snowpeak-accent-subtle)', borderColor: 'transparent' }}
          >
            {roleLabel[role]}
          </Tag>
        ) : null}
      </div>

      {error ? (
        <div
          style={{
            ...cardStyle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: 'var(--snowpeak-danger)',
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          <span>{error}</span>
          <Button size="small" variant="outline" onClick={retry}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <div style={{ ...cardStyle, fontSize: 13, color: 'var(--snowpeak-text-secondary)', marginBottom: 16 }}>
          正在加载驾驶舱数据…
        </div>
      ) : !hasData ? (
        <div style={{ ...cardStyle, fontSize: 13, color: 'var(--snowpeak-text-secondary)', marginBottom: 16 }}>
          暂无数据，请先创建合同 / 设备。
        </div>
      ) : (
        <>
          {/* KPI 卡片（非对称布局：利用率主卡 + 营收/周转次卡） */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ ...cardStyle, gridColumn: 'span 2' }}>
              <div style={kpiTitleStyle}>
                当前设备利用率
                <Tooltip content="利用率 = 借出中有效设备数 ÷ 有效设备总数（不含已报废；维修中计入总数、不计入借出）">
                  <span style={{ marginLeft: 4, color: 'var(--snowpeak-text-placeholder)', cursor: 'help' }}>ⓘ</span>
                </Tooltip>
              </div>
              <div style={{ ...kpiValueStyle, fontSize: 36 }}>{formatUtilizationRate(kpi!.utilizationRate)}</div>
              <div style={kpiHintStyle}>
                借出中 <span className="num">{kpi!.rentedCount}</span> / 有效设备 <span className="num">{kpi!.validCount}</span>
              </div>
            </div>

            <div style={cardStyle}>
              <div style={kpiTitleStyle}>
                本月营收
                <Tooltip content={`按合同完成时间（completed_at）所在月份（${monthLabel}）统计的最终应收总额之和，含换货补差、扣除退款`}>
                  <span style={{ marginLeft: 4, color: 'var(--snowpeak-text-placeholder)', cursor: 'help' }}>ⓘ</span>
                </Tooltip>
              </div>
              <div style={kpiValueStyle}>
                <span className="num">{formatMoney(kpi!.monthlyRevenue)}</span>
              </div>
              <div style={kpiHintStyle}>本月（{monthLabel}）完成合同</div>
            </div>

            <div style={cardStyle}>
              <div style={kpiTitleStyle}>
                平均维修周转时长
                <Tooltip content="已完成维修单的「维修完成日期 − 申请日期」（按自然日计，含周末）的平均值">
                  <span style={{ marginLeft: 4, color: 'var(--snowpeak-text-placeholder)', cursor: 'help' }}>ⓘ</span>
                </Tooltip>
              </div>
              <div style={kpiValueStyle}>
                {kpi!.avgRepairTurnaroundDays === null ? '—' : <span className="num">{kpi!.avgRepairTurnaroundDays} 天</span>}
              </div>
              <div style={kpiHintStyle}>已完成维修单 <span className="num">{kpi!.completedRepairCount}</span> 单</div>
            </div>
          </div>

          {/* 门店库存分布 */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>门店库存分布</div>
            <div style={{ ...kpiHintStyle, marginTop: 0, marginBottom: 8 }}>
              按设备当前所在门店与状态（在库 / 借出中 / 维修中 / 已报废）汇总数量
            </div>
            <Table
              data={kpi!.storeDistribution}
              columns={distributionColumns}
              rowKey="store_id"
              size="small"
              hover
              tableLayout="fixed"
              empty="暂无设备数据"
            />
          </div>
        </>
      )}

      <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--snowpeak-text-secondary)' }}>
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
    </div>
  )
}
