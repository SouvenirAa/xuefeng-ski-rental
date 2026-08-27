import { useMemo, useState } from 'react'
import {
  Button,
  DatePicker,
  Dialog,
  Drawer,
  Input,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Table,
  Tag,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { Contractor, ContractorInput, ContractorRate } from '../../data/types'
import { formatMoney, today } from '../../utils/format'
import { usePagination } from '../../hooks/usePagination'
import { useDbData } from '../../hooks/useDbData'

interface ContractorFormState {
  name: string
  address: string
  phone: string
  email: string
  // 仅新增时使用（首条费率）
  effective_date: string
  hourly_rate: number | undefined
}

const emptyContractorForm: ContractorFormState = {
  name: '',
  address: '',
  phone: '',
  email: '',
  effective_date: '',
  hourly_rate: undefined,
}

interface RateFormState {
  effective_date: string
  hourly_rate: number | undefined
}

const emptyRateForm: RateFormState = { effective_date: '', hourly_rate: undefined }

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

function toContractorInput(f: ContractorFormState): ContractorInput {
  return { name: f.name, address: f.address, phone: f.phone, email: f.email }
}

export function Contractors() {
  const { role } = useAuth()
  const [keyword, setKeyword] = useState('')

  // 承包商表单 Drawer
  const [formVisible, setFormVisible] = useState(false)
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null)
  const [contractorForm, setContractorForm] = useState<ContractorFormState>(emptyContractorForm)
  const [contractorFieldError, setContractorFieldError] = useState<Record<string, string>>({})
  const [submittingContractor, setSubmittingContractor] = useState(false)

  // 详情 Drawer
  const [detailVisible, setDetailVisible] = useState(false)
  const [detailContractor, setDetailContractor] = useState<Contractor | null>(null)

  // 费率表单 Dialog
  const [rateFormVisible, setRateFormVisible] = useState(false)
  const [editingRate, setEditingRate] = useState<ContractorRate | null>(null)
  const [rateForm, setRateForm] = useState<RateFormState>(emptyRateForm)
  const [rateFieldError, setRateFieldError] = useState<Record<string, string>>({})
  const [submittingRate, setSubmittingRate] = useState(false)

  const contractors = useDbData(() => dataService.listContractors())
  const allRates = useDbData(() => dataService.listContractorRates())

  // 承包商当前费率：复用服务层 getEffectiveContractorRate(contractorId, today)，
  // 只取 effective_date <= today 的最新一条，避免未来费率提前显示为“当前费率”。
  const currentRateOf = (contractorId: number): ContractorRate | null => {
    return dataService.getEffectiveContractorRate(contractorId, today())
  }

  const filtered = useMemo(() => {
    if (!keyword.trim()) return contractors
    return contractors.filter((c) =>
      `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(keyword.trim().toLowerCase()),
    )
  }, [contractors, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const openCreate = () => {
    setEditingContractor(null)
    // 首条费率生效日期默认当天（每次点击重新取，避免模块加载时缓存日期）
    setContractorForm({ ...emptyContractorForm, effective_date: today() })
    setContractorFieldError({})
    setFormVisible(true)
  }

  const openEdit = (c: Contractor) => {
    setEditingContractor(c)
    setContractorForm({ name: c.name, address: c.address, phone: c.phone, email: c.email, effective_date: '', hourly_rate: undefined })
    setContractorFieldError({})
    setFormVisible(true)
  }

  const openDetail = (c: Contractor) => {
    setDetailContractor(c)
    setDetailVisible(true)
  }

  const handleSaveContractor = () => {
    if (submittingContractor || !role) return
    setSubmittingContractor(true)
    const result = editingContractor
      ? dataService.updateContractor(role, editingContractor.contractor_id, toContractorInput(contractorForm))
      : dataService.createContractorWithInitialRate(role, {
          contractor: toContractorInput(contractorForm),
          initialRate: {
            effective_date: contractorForm.effective_date,
            hourly_rate: contractorForm.hourly_rate ?? 0,
          },
        })
    setSubmittingContractor(false)

    if (result.ok) {
      MessagePlugin.success(editingContractor ? '承包商已更新' : '承包商已新增')
      setFormVisible(false)
    } else {
      if (result.field) {
        setContractorFieldError({ [result.field]: result.error })
      } else {
        MessagePlugin.error(result.error)
      }
    }
  }

  const handleDeleteContractor = (c: Contractor) => {
    if (!role) return
    const result = dataService.removeContractor(role, c.contractor_id)
    if (result.ok) {
      MessagePlugin.success('承包商已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  // ---- 费率 ----
  const openCreateRate = () => {
    setEditingRate(null)
    setRateForm(emptyRateForm)
    setRateFieldError({})
    setRateFormVisible(true)
  }

  const openEditRate = (r: ContractorRate) => {
    setEditingRate(r)
    setRateForm({ effective_date: r.effective_date, hourly_rate: r.hourly_rate })
    setRateFieldError({})
    setRateFormVisible(true)
  }

  const handleSaveRate = () => {
    if (submittingRate || !role || !detailContractor) return
    setSubmittingRate(true)
    const result = editingRate
      ? dataService.updateContractorRate(role, editingRate.rate_id, {
          effective_date: rateForm.effective_date,
          hourly_rate: rateForm.hourly_rate ?? 0,
        })
      : dataService.createContractorRate(role, detailContractor.contractor_id, {
          effective_date: rateForm.effective_date,
          hourly_rate: rateForm.hourly_rate ?? 0,
        })
    setSubmittingRate(false)

    if (result.ok) {
      MessagePlugin.success(editingRate ? '费率已更新' : '费率已新增')
      setRateFormVisible(false)
    } else {
      if (result.field) {
        setRateFieldError({ [result.field]: result.error })
      } else {
        MessagePlugin.error(result.error)
      }
    }
  }

  const handleDeleteRate = (r: ContractorRate) => {
    if (!role) return
    const result = dataService.removeContractorRate(role, r.rate_id)
    if (result.ok) {
      MessagePlugin.success('费率已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<Contractor>[] = [
    { colKey: 'name', title: '名称', width: 180 },
    { colKey: 'phone', title: '电话', width: 140 },
    { colKey: 'email', title: '邮箱', ellipsis: true },
    {
      colKey: 'current_rate',
      title: '当前费率',
      width: 120,
      cell: ({ row }) => {
        const rate = currentRateOf(row.contractor_id)
        return rate ? <span className="num">{formatMoney(rate.hourly_rate)}</span> : '—'
      },
    },
    {
      colKey: 'effective_date',
      title: '费率生效日期',
      width: 140,
      cell: ({ row }) => currentRateOf(row.contractor_id)?.effective_date ?? '—',
    },
    {
      colKey: 'op',
      title: '操作',
      width: 200,
      fixed: 'right',
      cell: ({ row }) => (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Button size="small" variant="text" theme="primary" onClick={() => openDetail(row)}>
            详情
          </Button>
          <Button size="small" variant="text" theme="primary" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            content="删除后该承包商记录将不可恢复，确认删除？"
            confirmBtn={{ content: '删除', theme: 'danger' }}
            onConfirm={() => handleDeleteContractor(row)}
          >
            <Button size="small" variant="text" theme="danger">
              删除
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  const detailRates = detailContractor
    ? allRates
        .filter((r) => r.contractor_id === detailContractor.contractor_id)
        .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))
    : []

  const rateColumns: PrimaryTableCol<ContractorRate>[] = [
    { colKey: 'effective_date', title: '生效日期', width: 130 },
    {
      colKey: 'hourly_rate',
      title: '小时费率',
      width: 120,
      cell: ({ row }) => <span className="num">{formatMoney(row.hourly_rate)}</span>,
    },
    {
      colKey: 'referenced',
      title: '引用状态',
      width: 100,
      cell: ({ row }) =>
        dataService.isContractorRateReferenced(row.rate_id) ? (
          <Tag variant="light" style={{ color: 'var(--snowpeak-text-secondary)', background: 'var(--snowpeak-bg-page)', borderColor: 'transparent' }}>
            已被维修单引用
          </Tag>
        ) : (
          <Tag variant="light" style={{ color: 'var(--snowpeak-success)', background: 'var(--snowpeak-success-subtle)', borderColor: 'transparent' }}>
            可编辑
          </Tag>
        ),
    },
    {
      colKey: 'op',
      title: '操作',
      width: 130,
      cell: ({ row }) => {
        const referenced = dataService.isContractorRateReferenced(row.rate_id)
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Button size="small" variant="text" theme="primary" disabled={referenced} onClick={() => openEditRate(row)}>
              编辑
            </Button>
            {referenced ? (
              <Button size="small" variant="text" theme="danger" disabled>
                删除
              </Button>
            ) : (
              <Popconfirm
                content="删除后该费率记录将不可恢复，确认删除？"
                confirmBtn={{ content: '删除', theme: 'danger' }}
                onConfirm={() => handleDeleteRate(row)}
              >
                <Button size="small" variant="text" theme="danger">
                  删除
                </Button>
              </Popconfirm>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader title="承包商与费率管理" subtitle="维护承包商资料与历史费率（仅管理员可访问）" />

      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--snowpeak-border)' }}>
          <Input
            value={keyword}
            onChange={(v) => { setKeyword(String(v)); setPage(1) }}
            placeholder="搜索名称 / 电话 / 邮箱"
            clearable
            prefixIcon={<SearchIcon />}
            style={{ width: 280 }}
          />
          <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
            新增承包商
          </Button>
        </div>

        <Table
          data={paged.items}
          columns={columns}
          rowKey="contractor_id"
          size="small"
          hover
          tableLayout="fixed"
          empty={keyword.trim() ? '未找到匹配的承包商' : '暂无承包商，点击右上角「新增承包商」录入'}
          pagination={{
            current: page,
            pageSize,
            total,
            showJumper: true,
            onChange: (info) => { setPage(info.current); setPageSize(info.pageSize) },
          }}
        />
      </div>

      {/* 承包商表单 Drawer（新增含首条费率，编辑不含费率） */}
      <Drawer
        visible={formVisible}
        header={editingContractor ? '编辑承包商' : '新增承包商'}
        size="480px"
        onClose={() => setFormVisible(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setFormVisible(false)} style={{ minWidth: 80 }}>
              取消
            </Button>
            <Button theme="primary" loading={submittingContractor} onClick={handleSaveContractor} style={{ minWidth: 96 }}>
              保存
            </Button>
          </div>
        }
      >
        <div style={{ padding: '4px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>名称 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <Input value={contractorForm.name} onChange={(v) => setContractorForm((p) => ({ ...p, name: String(v) }))} placeholder="如 峰顶装备维修" status={contractorFieldError.name ? 'error' : 'default'} tips={contractorFieldError.name} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>电话</label>
            <Input value={contractorForm.phone} onChange={(v) => setContractorForm((p) => ({ ...p, phone: String(v) }))} placeholder="选填" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱</label>
            <Input value={contractorForm.email} onChange={(v) => setContractorForm((p) => ({ ...p, email: String(v) }))} placeholder="选填" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>地址</label>
            <Input value={contractorForm.address} onChange={(v) => setContractorForm((p) => ({ ...p, address: String(v) }))} placeholder="选填" />
          </div>

          {!editingContractor && (
            <div style={{ borderTop: '1px solid var(--snowpeak-border)', paddingTop: 16, marginTop: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>首条费率</div>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>生效日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
                <DatePicker
                  value={contractorForm.effective_date || undefined}
                  onChange={(v) => setContractorForm((p) => ({ ...p, effective_date: v ? String(v) : '' }))}
                  placeholder="请选择生效日期"
                  status={contractorFieldError.effective_date ? 'error' : 'default'}
                  tips={contractorFieldError.effective_date}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>小时费率（元） <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
                <InputNumber
                  value={contractorForm.hourly_rate}
                  onChange={(v) => setContractorForm((p) => ({ ...p, hourly_rate: v as number | undefined }))}
                  min={0}
                  theme="normal"
                  placeholder="如 180"
                  status={contractorFieldError.hourly_rate ? 'error' : 'default'}
                  tips={contractorFieldError.hourly_rate}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          )}
        </div>
      </Drawer>

      {/* 详情 Drawer：承包商资料 + 费率历史 */}
      <Drawer
        visible={detailVisible}
        header={detailContractor ? `承包商详情：${detailContractor.name}` : '承包商详情'}
        size="560px"
        onClose={() => setDetailVisible(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setDetailVisible(false)} style={{ minWidth: 80 }}>
              关闭
            </Button>
          </div>
        }
      >
        {detailContractor && (
          <div style={{ padding: '4px 0' }}>
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--snowpeak-text-secondary)' }}>
              <div style={{ marginBottom: 4 }}>电话：{detailContractor.phone || '—'}</div>
              <div style={{ marginBottom: 4 }}>邮箱：{detailContractor.email || '—'}</div>
              <div>地址：{detailContractor.address || '—'}</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>费率历史</span>
              <Button size="small" theme="primary" icon={<AddIcon />} onClick={openCreateRate}>
                新增费率
              </Button>
            </div>
            <Table
              data={detailRates}
              columns={rateColumns}
              rowKey="rate_id"
              size="small"
              hover
              empty="暂无费率记录"
            />
          </div>
        )}
      </Drawer>

      {/* 费率表单 Dialog */}
      <Dialog
        visible={rateFormVisible}
        header={editingRate ? '编辑费率' : '新增费率'}
        width={440}
        confirmBtn={{ content: '保存', theme: 'primary', loading: submittingRate }}
        cancelBtn="取消"
        onConfirm={handleSaveRate}
        onClose={() => setRateFormVisible(false)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>生效日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <DatePicker
              value={rateForm.effective_date || undefined}
              onChange={(v) => setRateForm((p) => ({ ...p, effective_date: v ? String(v) : '' }))}
              placeholder="请选择生效日期"
              status={rateFieldError.effective_date ? 'error' : 'default'}
              tips={rateFieldError.effective_date}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>小时费率（元） <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <InputNumber
              value={rateForm.hourly_rate}
              onChange={(v) => setRateForm((p) => ({ ...p, hourly_rate: v as number | undefined }))}
              min={0}
              theme="normal"
              placeholder="如 180"
              status={rateFieldError.hourly_rate ? 'error' : 'default'}
              tips={rateFieldError.hourly_rate}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </Dialog>
    </div>
  )
}
