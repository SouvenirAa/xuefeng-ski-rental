import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  DateRangePicker,
  Input,
  Select,
  Table,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { useAuth } from '../../auth/AuthContext'
import type { ContractListRowView } from '../../data/cloudContracts'
import { formatDate, formatMoney } from '../../utils/format'
import { usePagination } from '../../hooks/usePagination'
import { useContracts } from '../../hooks/useContracts'
import { isCloudMode } from '../../lib/cloudbase'

export function Contracts() {
  const navigate = useNavigate()
  const isCloud = isCloudMode()
  const { role } = useAuth()
  // 新建合同写权限：仅 admin/staff（与路由层 /contracts 角色限制、RPC 角色校验一致）
  const canWrite = role === 'admin' || role === 'staff'
  const [keyword, setKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [dateRange, setDateRange] = useState<string[]>([])

  const { contracts, loading, error, retry } = useContracts()

  const filtered = useMemo(() => {
    return contracts.filter((c) => {
      if (keyword.trim()) {
        const kw = keyword.trim().toLowerCase()
        const hit = c.contract_no.toLowerCase().includes(kw) || c.customer_name.toLowerCase().includes(kw)
        if (!hit) return false
      }
      if (filterStatus && c.status !== filterStatus) return false
      if (dateRange[0] && c.contract_date < dateRange[0]) return false
      if (dateRange[1] && c.contract_date > dateRange[1]) return false
      return true
    })
  }, [contracts, keyword, filterStatus, dateRange])

  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const columns: PrimaryTableCol<ContractListRowView>[] = [
    {
      colKey: 'contract_no',
      title: '合同编号',
      width: 170,
      className: 'font-mono',
      cell: ({ row }) => (
        <Button
          variant="text"
          theme="primary"
          size="small"
          style={{ padding: 0, height: 'auto' }}
          onClick={() => navigate(`/contracts/${row.contract_id}`)}
        >
          {row.contract_no}
        </Button>
      ),
    },
    { colKey: 'customer', title: '客户', width: 110, cell: ({ row }) => row.customer_name },
    { colKey: 'employee', title: '经办员工', width: 110, cell: ({ row }) => row.employee_name },
    { colKey: 'contract_date', title: '合同日期', width: 120, cell: ({ row }) => formatDate(row.contract_date) },
    { colKey: 'duration_days', title: '租赁天数', width: 90, cell: ({ row }) => `${row.duration_days} 天` },
    {
      colKey: 'total_amount',
      title: '总额',
      width: 120,
      cell: ({ row }) => <span className="num">{formatMoney(row.total_amount)}</span>,
    },
    {
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }) => <StatusTag status={row.status} />,
    },
    {
      colKey: 'op',
      title: '操作',
      width: 100,
      fixed: 'right',
      cell: ({ row }) => (
        <Button size="small" variant="text" theme="primary" onClick={() => navigate(`/contracts/${row.contract_id}`)}>
          查看详情
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="租赁合同"
        subtitle={isCloud ? 'CloudBase PostgreSQL' : '查看合同与状态，执行新建、借出、换货与归还'}
      />

      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'center',
            padding: '12px 16px',
            borderBottom: '1px solid var(--snowpeak-border)',
          }}
        >
          <Input
            value={keyword}
            onChange={(v) => {
              setKeyword(String(v))
              setPage(1)
            }}
            placeholder="搜索合同号 / 客户"
            clearable
            prefixIcon={<SearchIcon />}
            style={{ width: 220 }}
          />
          <Select
            value={filterStatus}
            onChange={(v) => {
              setFilterStatus(String(v ?? ''))
              setPage(1)
            }}
            placeholder="状态"
            clearable
            options={['进行中', '已完成'].map((s) => ({ label: s, value: s }))}
            style={{ width: 130 }}
          />
          <DateRangePicker
            value={dateRange}
            onChange={(v) => {
              setDateRange(v ? [String(v[0] ?? ''), String(v[1] ?? '')] : [])
              setPage(1)
            }}
            placeholder={['开始日期', '结束日期']}
            style={{ width: 260 }}
          />
          <div style={{ flex: 1 }} />
          {canWrite && (
            <Button theme="primary" icon={<AddIcon />} onClick={() => navigate('/contracts/new')}>
              新建合同
            </Button>
          )}
        </div>

        {isCloud && error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid var(--snowpeak-border)',
              color: 'var(--snowpeak-danger)',
              fontSize: 13,
            }}
          >
            <span>{error}</span>
            <Button size="small" variant="outline" onClick={retry}>
              重试
            </Button>
          </div>
        )}

        <Table
          data={paged.items}
          columns={columns}
          rowKey="contract_id"
          size="small"
          hover
          loading={isCloud && loading}
          tableLayout="fixed"
          empty={
            keyword.trim() || filterStatus || dateRange.length > 0
              ? '未找到匹配的合同'
              : isCloud
                ? '暂无合同数据'
                : '暂无合同，点击右上角「新建合同」录入'
          }
          pagination={{
            current: page,
            pageSize,
            total,
            showJumper: true,
            onChange: (info) => {
              setPage(info.current)
              setPageSize(info.pageSize)
            },
          }}
        />
      </div>
    </div>
  )
}
