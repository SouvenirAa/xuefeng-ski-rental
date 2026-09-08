import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  DatePicker,
  Dialog,
  Drawer,
  Input,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Select,
  Table,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { RepairRowView } from '../../data/cloudRepairs'
import type {
  RepairCreateCloudInput,
  RepairCompleteCloudInput,
} from '../../data/cloudRepairMutations'
import { formatDate, formatMoney, today } from '../../utils/format'
import { usePagination } from '../../hooks/usePagination'
import { useRepairs } from '../../hooks/useRepairs'
import { useMasterData } from '../../hooks/useMasterData'
import { useContractors } from '../../hooks/useContractors'
import { isCloudMode } from '../../lib/cloudbase'
import {
  buildRepairContractorFilterOptions,
  filterRepairsByContractor,
} from '../../data/repairDataSource'

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

/** 维修单号（数据模型无 repair_no，按 repair_id 格式化展示） */
function repairNo(id: number): string {
  return `RO-${String(id).padStart(4, '0')}`
}

/** 设备展示（cloud/local 统一由 RepairRowView 提供，item_code 恒非空） */
function itemLabel(row: RepairRowView): string {
  return row.item_code ? `${row.item_code} · ${row.item_name}` : `#${row.repair_id}`
}

interface CreateForm {
  item_id: number | undefined
  contractor_id: number | undefined
  request_date: string
  fault_description: string
}

const emptyCreateForm: CreateForm = {
  item_id: undefined,
  contractor_id: undefined,
  request_date: today(),
  fault_description: '',
}

interface CompleteForm {
  repair_date: string
  repair_hours: number | undefined
  notes: string
}

export function Repairs() {
  const { role, account } = useAuth()
  const isCloud = isCloudMode()
  const isStaffSide = role === 'admin' || role === 'staff'
  const isContractor = role === 'contractor'
  const myContractorId = account?.contractor_id ?? undefined

  const [keyword, setKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterContractor, setFilterContractor] = useState<string>('')

  // 列表 + 写操作（local/cloud 统一 RepairRowView；写操作走 useRepairs 的 mutation）。
  const { repairs, loading, error, retry, createRepair, startRepair, completeRepair, mutating } =
    useRepairs()

  // 写操作依赖：新增维修单的设备（在库）/承包商下拉。
  // 统一走 useMasterData / useContractors（local/cloud 均返回视图类型）；
  // contractor 角色无这两张表 SELECT 权限（RLS），fail-closed 返回空，但 contractor 不显示新增入口。
  const { items } = useMasterData()
  const { contractors } = useContractors()

  // 卸载防护：异步写操作返回后，组件已卸载则不再写状态 / 触发全局消息
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 新增维修单
  const [createVisible, setCreateVisible] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm)
  const [createError, setCreateError] = useState<Record<string, string>>({})

  // 详情（只读，local/cloud 均显示）
  const [detailRepair, setDetailRepair] = useState<RepairRowView | null>(null)

  // 完成维修（contractor；local/cloud 均支持）
  const [completeTarget, setCompleteTarget] = useState<RepairRowView | null>(null)
  const [completeForm, setCompleteForm] = useState<CompleteForm>({ repair_date: today(), repair_hours: undefined, notes: '' })
  const [completeError, setCompleteError] = useState<Record<string, string>>({})

  const filtered = useMemo(() => {
    return filterRepairsByContractor(repairs, filterContractor).filter((r) => {
      if (keyword.trim()) {
        const kw = keyword.trim().toLowerCase()
        const hit = `${r.item_code} ${r.item_name}`.toLowerCase().includes(kw)
        if (!hit) return false
      }
      if (filterStatus && r.status !== filterStatus) return false
      return true
    })
  }, [repairs, keyword, filterStatus, filterContractor])

  // 承包商筛选选项：cloud 从已加载 RepairRowView 去重生成；local 用 contractors 列表。
  const contractorFilterOptions = useMemo(() => {
    if (isCloud) return buildRepairContractorFilterOptions(repairs)
    return contractors.map((c) => ({ label: c.name, value: String(c.contractor_id) }))
  }, [isCloud, repairs, contractors])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  // 新增：冻结费率（仅 local 本地计算；cloud 由 RPC 服务端按申请日期冻结，前端不计算）
  const frozenRate = useMemo(() => {
    if (isCloud) return null
    if (!createForm.contractor_id || !createForm.request_date) return null
    return dataService.getEffectiveContractorRate(createForm.contractor_id, createForm.request_date)
  }, [isCloud, createForm.contractor_id, createForm.request_date])

  // 在库设备选项（新增维修单）
  const availableItems = useMemo(() => items.filter((i) => i.status === '在库'), [items])

  /** 判断某行是否「本人承接」（contractor 角色）：cloud 下 list_my_repairs 已保证全是本人；local 按 contractor_id。 */
  const isMine = (row: RepairRowView): boolean => {
    if (!isContractor) return false
    if (isCloud) return true
    return row.contractor_id === myContractorId
  }

  const openCreate = () => {
    setCreateForm(emptyCreateForm)
    setCreateError({})
    setCreateVisible(true)
  }

  const handleCreate = async () => {
    if (mutating || !role) return
    const input: RepairCreateCloudInput = {
      item_id: createForm.item_id as number,
      contractor_id: createForm.contractor_id as number,
      request_date: createForm.request_date,
      fault_description: createForm.fault_description,
    }
    const result = await createRepair(input)
    if (!mountedRef.current) return

    if (result.ok) {
      MessagePlugin.success('维修单已创建，设备转入维修中')
      setCreateVisible(false)
    } else {
      if (result.field) setCreateError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const openDetail = (r: RepairRowView) => {
    setDetailRepair(r)
  }

  const handleStart = async (r: RepairRowView) => {
    if (mutating || !role) return
    const result = await startRepair(r.repair_id)
    if (!mountedRef.current) return
    if (result.ok) MessagePlugin.success('已开始维修')
    else MessagePlugin.error(result.error)
  }

  const openComplete = (r: RepairRowView) => {
    setCompleteTarget(r)
    setCompleteForm({ repair_date: today(), repair_hours: undefined, notes: '' })
    setCompleteError({})
  }

  const handleComplete = async () => {
    if (mutating || !role || !completeTarget) return
    const input: RepairCompleteCloudInput = {
      repair_id: completeTarget.repair_id,
      repair_date: completeForm.repair_date,
      repair_hours: completeForm.repair_hours ?? 0,
      notes: completeForm.notes,
    }
    const result = await completeRepair(input)
    if (!mountedRef.current) return

    if (result.ok) {
      MessagePlugin.success('维修已完成，设备恢复在库')
      setCompleteTarget(null)
    } else {
      if (result.field) setCompleteError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  // 完成维修成本预估（冻结费率来自统一视图 rate_hourly，不再调用 listContractorRates）
  const rateHourly = completeTarget ? completeTarget.rate_hourly : null
  const costPreview = rateHourly !== null && rateHourly > 0 && completeForm.repair_hours
    ? rateHourly * completeForm.repair_hours
    : null

  const columns: PrimaryTableCol<RepairRowView>[] = [
    { colKey: 'no', title: '维修单号', width: 110, className: 'font-mono', cell: ({ row }) => repairNo(row.repair_id) },
    { colKey: 'item', title: '设备', width: 190, ellipsis: true, cell: ({ row }) => itemLabel(row) },
    { colKey: 'contractor', title: '承包商', width: 130, cell: ({ row }) => row.contractor_name },
    { colKey: 'request_date', title: '申请日期', width: 110, cell: ({ row }) => formatDate(row.request_date) },
    { colKey: 'status', title: '状态', width: 90, cell: ({ row }) => <StatusTag status={row.status} /> },
    {
      colKey: 'repair_hours',
      title: '维修工时',
      width: 90,
      cell: ({ row }) => (row.repair_hours !== null ? `${row.repair_hours} h` : '—'),
    },
    {
      colKey: 'calculated_cost',
      title: '维修成本',
      width: 110,
      cell: ({ row }) =>
        row.calculated_cost !== null ? <span className="num">{formatMoney(row.calculated_cost)}</span> : '—',
    },
    {
      colKey: 'op',
      title: '操作',
      width: 150,
      fixed: 'right',
      cell: ({ row }) => {
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Button size="small" variant="text" theme="primary" onClick={() => openDetail(row)}>
              详情
            </Button>
            {isMine(row) && row.status === '待维修' && (
              <Popconfirm
                content="确认开始维修该设备？开始后状态将变为「维修中」"
                confirmBtn={{ content: '开始维修', theme: 'primary' }}
                onConfirm={() => handleStart(row)}
              >
                <Button size="small" variant="text" theme="primary">
                  开始
                </Button>
              </Popconfirm>
            )}
            {isMine(row) && row.status === '维修中' && (
              <Button size="small" variant="text" theme="primary" onClick={() => openComplete(row)}>
                完成
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader
        title="维修单管理"
        subtitle="设备报修、承包商接单与完成维修（费率按申请日期冻结）"
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
            placeholder="搜索设备编号 / 名称"
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
            options={['待维修', '维修中', '已完成'].map((s) => ({ label: s, value: s }))}
            style={{ width: 130 }}
          />
          {isStaffSide && (
            <Select
              value={filterContractor}
              onChange={(v) => {
                setFilterContractor(String(v ?? ''))
                setPage(1)
              }}
              placeholder="承包商"
              clearable
              options={contractorFilterOptions}
              style={{ width: 160 }}
            />
          )}
          <div style={{ flex: 1 }} />
          {isStaffSide && (
            <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
              新增维修单
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
          rowKey="repair_id"
          size="small"
          hover
          loading={isCloud && loading}
          tableLayout="fixed"
          empty={
            keyword.trim() || filterStatus || filterContractor
              ? '未找到匹配的维修单'
              : isCloud
                ? '暂无维修单数据'
                : '暂无维修单'
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

      {/* 新增维修单 Dialog（admin/staff） */}
      <Dialog
        visible={createVisible}
        header="新增维修单"
        width={480}
        confirmBtn={{ content: '创建', theme: 'primary', loading: mutating }}
        cancelBtn="取消"
        onConfirm={handleCreate}
        onClose={() => setCreateVisible(false)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              设备 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Select
              value={createForm.item_id}
              onChange={(v) => setCreateForm((p) => ({ ...p, item_id: v === '' ? undefined : Number(v) }))}
              placeholder="选择在库设备"
              filterable
              options={availableItems.map((i) => ({ label: `${i.item_code} · ${i.name}`, value: i.item_id }))}
              status={createError.item_id ? 'error' : 'default'}
              tips={createError.item_id}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              承包商 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Select
              value={createForm.contractor_id}
              onChange={(v) => setCreateForm((p) => ({ ...p, contractor_id: v === '' ? undefined : Number(v) }))}
              placeholder="选择承包商"
              filterable
              options={contractors.map((c) => ({ label: c.name, value: c.contractor_id }))}
              status={createError.contractor_id ? 'error' : 'default'}
              tips={createError.contractor_id}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              申请日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <DatePicker
              value={createForm.request_date}
              onChange={(v) => setCreateForm((p) => ({ ...p, request_date: v ? String(v) : '' }))}
              disableDate={(date) => {
                const dt = new Date(date as Date)
                const p = (n: number) => String(n).padStart(2, '0')
                const ymd = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
                return ymd > today()
              }}
              status={createError.request_date ? 'error' : 'default'}
              tips={createError.request_date}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              故障描述 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input
              value={createForm.fault_description}
              onChange={(v) => setCreateForm((p) => ({ ...p, fault_description: String(v) }))}
              placeholder="描述故障现象"
              status={createError.fault_description ? 'error' : 'default'}
              tips={createError.fault_description}
            />
          </div>
          <div style={{ background: 'var(--snowpeak-bg-page)', border: '1px solid var(--snowpeak-border)', borderRadius: 6, padding: 12, fontSize: 13 }}>
            {isCloud ? (
              <span style={{ color: 'var(--snowpeak-text-secondary)' }}>
                将由服务端按申请日期自动冻结有效费率
              </span>
            ) : frozenRate ? (
              <span>
                将冻结有效费率：<span className="num">{formatMoney(frozenRate.hourly_rate)}</span>/小时
                （生效日期 {frozenRate.effective_date}）
              </span>
            ) : (
              <span style={{ color: 'var(--snowpeak-danger)' }}>
                {createForm.contractor_id ? '该承包商在所选日期无有效费率，无法创建' : '选择承包商与日期后显示冻结费率'}
              </span>
            )}
          </div>
        </div>
      </Dialog>

      {/* 详情 Drawer（只读，local/cloud 均显示） */}
      <Drawer
        visible={detailRepair !== null}
        header={detailRepair ? `维修单 ${repairNo(detailRepair.repair_id)}` : '维修单详情'}
        size="480px"
        onClose={() => setDetailRepair(null)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setDetailRepair(null)} style={{ minWidth: 80 }}>
              关闭
            </Button>
          </div>
        }
      >
        {detailRepair && (
          <div style={{ padding: '4px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>状态</span>
              <StatusTag status={detailRepair.status} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--snowpeak-text-secondary)', lineHeight: 2 }}>
              <div>设备：{itemLabel(detailRepair)}</div>
              <div>承包商：{detailRepair.contractor_name || '—'}</div>
              <div>申请日期：{formatDate(detailRepair.request_date)}</div>
              <div>
                冻结费率：
                <span className="num">{formatMoney(detailRepair.rate_hourly)}/小时</span>
              </div>
              <div>故障描述：{detailRepair.fault_description}</div>
              {detailRepair.status === '已完成' && (
                <>
                  <div>维修完成日期：{formatDate(detailRepair.repair_date as string)}</div>
                  <div>维修工时：{detailRepair.repair_hours} h</div>
                  <div>
                    维修成本：
                    <span className="num">{formatMoney(detailRepair.calculated_cost as number)}</span>
                  </div>
                  <div>维修说明：{detailRepair.notes ?? '—'}</div>
                </>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* 完成维修 Dialog（contractor） */}
      <Dialog
        visible={completeTarget !== null}
        header={completeTarget ? `完成维修 ${repairNo(completeTarget.repair_id)}` : '完成维修'}
        width={480}
        confirmBtn={{ content: '完成维修', theme: 'primary', loading: mutating }}
        cancelBtn="取消"
        onConfirm={handleComplete}
        onClose={() => setCompleteTarget(null)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              维修完成日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <DatePicker
              value={completeForm.repair_date}
              onChange={(v) => setCompleteForm((p) => ({ ...p, repair_date: v ? String(v) : '' }))}
              disableDate={(date) => {
                const dt = new Date(date as Date)
                const p = (n: number) => String(n).padStart(2, '0')
                const ymd = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
                return ymd > today() || (completeTarget ? ymd < completeTarget.request_date : false)
              }}
              status={completeError.repair_date ? 'error' : 'default'}
              tips={completeError.repair_date}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              维修工时（小时，0.25 步进） <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <InputNumber
              value={completeForm.repair_hours}
              onChange={(v) => setCompleteForm((p) => ({ ...p, repair_hours: v as number | undefined }))}
              min={0.25}
              step={0.25}
              theme="normal"
              status={completeError.repair_hours ? 'error' : 'default'}
              tips={completeError.repair_hours}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              维修说明 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input
              value={completeForm.notes}
              onChange={(v) => setCompleteForm((p) => ({ ...p, notes: String(v) }))}
              placeholder="说明维修处理情况"
              status={completeError.notes ? 'error' : 'default'}
              tips={completeError.notes}
            />
          </div>
          <div style={{ background: 'var(--snowpeak-bg-page)', border: '1px solid var(--snowpeak-border)', borderRadius: 6, padding: 12, fontSize: 13 }}>
            {rateHourly !== null && rateHourly > 0 && completeForm.repair_hours ? (
              <span>
                预计成本：<span className="num">{formatMoney(costPreview as number)}</span>
                （冻结费率 {formatMoney(rateHourly)}/小时 × {completeForm.repair_hours} h）
              </span>
            ) : (
              <span style={{ color: 'var(--snowpeak-text-placeholder)' }}>
                冻结费率 {rateHourly !== null && rateHourly > 0 ? `${formatMoney(rateHourly)}/小时` : '—'}，输入工时后显示预计成本
              </span>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  )
}
