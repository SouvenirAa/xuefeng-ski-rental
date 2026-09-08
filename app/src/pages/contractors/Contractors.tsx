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
  Space,
  Table,
  Tag,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { ContractorInput } from '../../data/types'
import type { ContractorView, ContractorRateView } from '../../data/cloudContractors'
import { computeCurrentRateView } from '../../data/cloudContractors'
import type {
  ContractorCloudInput,
  ContractorRateCloudInput,
} from '../../data/cloudContractorMutations'
import { isCloudMode } from '../../lib/cloudbase'
import { useContractors } from '../../hooks/useContractors'
import { formatMoney, today } from '../../utils/format'
import { usePagination } from '../../hooks/usePagination'

interface ContractorFormState {
  name: string
  address: string
  phone: string
  email: string
  // 仅 local 新增时使用（首条费率）
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

/** 表单 → cloud 可空输入：address/phone/email 空串归一化为 null（不写虚构文本） */
function toContractorCloudInput(f: ContractorFormState): ContractorCloudInput {
  return {
    name: f.name,
    address: f.address.trim() === '' ? null : f.address.trim(),
    phone: f.phone.trim() === '' ? null : f.phone.trim(),
    email: f.email.trim() === '' ? null : f.email.trim(),
  }
}

/** 费率表单 → cloud 费率输入（未填 hourly_rate 归一化为 0，由校验层拒绝「必须大于 0」） */
function toRateCloudInput(f: RateFormState): ContractorRateCloudInput {
  return { effective_date: f.effective_date, hourly_rate: f.hourly_rate ?? 0 }
}

export function Contractors() {
  const { role } = useAuth()
  const isCloud = isCloudMode()
  const {
    contractors,
    rates,
    referencedRateIds,
    loading,
    error,
    retry,
    createContractor,
    updateContractor,
    removeContractor,
    createRate,
    updateRate,
    removeRate,
    mutating,
  } = useContractors()
  const [keyword, setKeyword] = useState('')

  // 写权限：仅 admin（cloud/local 统一；staff/contractor 由路由层 /contractors 拦截 403）
  const canWrite = role === 'admin'

  // 被维修单引用的费率集合（cloud：来自云端查询；local：空，走 dataService.isContractorRateReferenced）
  const referencedSet = useMemo(() => new Set(referencedRateIds), [referencedRateIds])

  // 卸载防护：异步保存/删除返回后，组件已卸载则不再写状态 / 触发全局消息
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 承包商表单 Drawer
  const [formVisible, setFormVisible] = useState(false)
  const [editingContractor, setEditingContractor] = useState<ContractorView | null>(null)
  const [contractorForm, setContractorForm] = useState<ContractorFormState>(emptyContractorForm)
  const [contractorFieldError, setContractorFieldError] = useState<Record<string, string>>({})
  const [submittingContractor, setSubmittingContractor] = useState(false)

  // 详情 Drawer（local / cloud 均展示承包商资料 + 费率历史）
  const [detailVisible, setDetailVisible] = useState(false)
  const [detailContractor, setDetailContractor] = useState<ContractorView | null>(null)

  // 费率表单 Dialog
  const [rateFormVisible, setRateFormVisible] = useState(false)
  const [editingRate, setEditingRate] = useState<ContractorRateView | null>(null)
  const [rateForm, setRateForm] = useState<RateFormState>(emptyRateForm)
  const [rateFieldError, setRateFieldError] = useState<Record<string, string>>({})
  const [submittingRate, setSubmittingRate] = useState(false)

  // 承包商当前费率：
  // - local：复用服务层 getEffectiveContractorRate（保持既有行为）；
  // - cloud：从云端费率自行计算（只取 effective_date <= today 的最新一条），
  //   绝不调用 dataService.getEffectiveContractorRate。
  const currentRateOf = (contractorId: number): ContractorRateView | null => {
    if (isCloud) return computeCurrentRateView(rates, contractorId, today())
    return dataService.getEffectiveContractorRate(contractorId, today())
  }

  const filtered = useMemo(() => {
    if (!keyword.trim()) return contractors
    return contractors.filter((c) =>
      `${c.name} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase()),
    )
  }, [contractors, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const openCreate = () => {
    if (!canWrite) return
    setEditingContractor(null)
    // 首条费率生效日期默认当天（仅 local 新增使用；cloud 新增无首条费率）
    setContractorForm({ ...emptyContractorForm, effective_date: today() })
    setContractorFieldError({})
    setFormVisible(true)
  }

  const openEdit = (c: ContractorView) => {
    if (!canWrite) return
    setEditingContractor(c)
    setContractorForm({
      name: c.name,
      address: c.address ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      effective_date: '',
      hourly_rate: undefined,
    })
    setContractorFieldError({})
    setFormVisible(true)
  }

  const openDetail = (c: ContractorView) => {
    setDetailContractor(c)
    setDetailVisible(true)
  }

  const handleSaveContractor = async () => {
    if (isCloud) {
      if (mutating || !canWrite) return
      const result = editingContractor
        ? await updateContractor(editingContractor.contractor_id, toContractorCloudInput(contractorForm))
        : await createContractor(toContractorCloudInput(contractorForm))
      // 组件已卸载：不再写状态、不触发全局消息
      if (!mountedRef.current) return
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
      return
    }

    // local：保持既有同步流程（新增含首条费率，原子创建）
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

  const handleDeleteContractor = async (c: ContractorView) => {
    if (isCloud) {
      if (!canWrite) return
      const result = await removeContractor(c.contractor_id)
      if (!mountedRef.current) return
      if (result.ok) {
        MessagePlugin.success('承包商已删除')
      } else {
        MessagePlugin.error(result.error)
      }
      return
    }

    // local：保持既有同步流程
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
    if (!canWrite) return
    setEditingRate(null)
    setRateForm(emptyRateForm)
    setRateFieldError({})
    setRateFormVisible(true)
  }

  const openEditRate = (r: ContractorRateView) => {
    if (!canWrite) return
    setEditingRate(r)
    setRateForm({ effective_date: r.effective_date, hourly_rate: r.hourly_rate })
    setRateFieldError({})
    setRateFormVisible(true)
  }

  const handleSaveRate = async () => {
    if (!detailContractor) return
    if (isCloud) {
      if (mutating || !canWrite) return
      const result = editingRate
        ? await updateRate(editingRate.rate_id, toRateCloudInput(rateForm))
        : await createRate(detailContractor.contractor_id, toRateCloudInput(rateForm))
      if (!mountedRef.current) return
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
      return
    }

    // local：保持既有同步流程
    if (submittingRate || !role) return
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

  const handleDeleteRate = async (r: ContractorRateView) => {
    if (isCloud) {
      if (!canWrite) return
      const result = await removeRate(r.rate_id)
      if (!mountedRef.current) return
      if (result.ok) {
        MessagePlugin.success('费率已删除')
      } else {
        MessagePlugin.error(result.error)
      }
      return
    }

    // local：保持既有同步流程
    if (!role) return
    const result = dataService.removeContractorRate(role, r.rate_id)
    if (result.ok) {
      MessagePlugin.success('费率已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<ContractorView>[] = [
    { colKey: 'name', title: '名称', width: 180 },
    { colKey: 'phone', title: '电话', width: 140, cell: ({ row }) => row.phone ?? '—' },
    { colKey: 'email', title: '邮箱', ellipsis: true, cell: ({ row }) => row.email ?? '—' },
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
      cell: ({ row }) => {
        const detailBtn = (
          <Button size="small" variant="text" theme="primary" onClick={() => openDetail(row)}>
            详情
          </Button>
        )
        if (isCloud && !canWrite) {
          return (
            <Space>
              {detailBtn}
              <span style={{ color: 'var(--snowpeak-text-placeholder)', fontSize: 12 }}>
                仅管理员可操作
              </span>
            </Space>
          )
        }
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {detailBtn}
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
        )
      },
    },
  ]

  const detailRates = detailContractor
    ? rates
        .filter((r) => r.contractor_id === detailContractor.contractor_id)
        .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))
    : []

  /** 费率是否被维修单引用：cloud 用云端 referencedSet，local 用 dataService.isContractorRateReferenced */
  const isRateReferenced = (rateId: number): boolean => {
    if (isCloud) return referencedSet.has(rateId)
    return dataService.isContractorRateReferenced(rateId)
  }

  const rateColumns: PrimaryTableCol<ContractorRateView>[] = [
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
      width: 110,
      cell: ({ row }) =>
        isRateReferenced(row.rate_id) ? (
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
        if (isCloud && !canWrite) {
          return (
            <span style={{ color: 'var(--snowpeak-text-placeholder)', fontSize: 12 }}>
              仅管理员可操作
            </span>
          )
        }
        const referenced = isRateReferenced(row.rate_id)
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
      <PageHeader
        title="承包商与费率管理"
        subtitle={
          isCloud
            ? 'CloudBase PostgreSQL · 云端数据'
            : '维护承包商资料与历史费率（仅管理员可访问）'
        }
      />

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
          {canWrite && (
            <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
              新增承包商
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
          rowKey="contractor_id"
          size="small"
          hover
          loading={isCloud && loading}
          tableLayout="fixed"
          empty={keyword.trim() ? '未找到匹配的承包商' : '暂无承包商数据'}
          pagination={{
            current: page,
            pageSize,
            total,
            showJumper: true,
            onChange: (info) => { setPage(info.current); setPageSize(info.pageSize) },
          }}
        />
      </div>

      {/* 承包商表单 Drawer（cloud 仅基础资料；local 新增含首条费率，编辑不含费率） */}
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
            <Button
              theme="primary"
              loading={isCloud ? mutating : submittingContractor}
              onClick={handleSaveContractor}
              style={{ minWidth: 96 }}
            >
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
            <Input value={contractorForm.phone} onChange={(v) => setContractorForm((p) => ({ ...p, phone: String(v) }))} placeholder="选填" status={contractorFieldError.phone ? 'error' : 'default'} tips={contractorFieldError.phone} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱</label>
            <Input value={contractorForm.email} onChange={(v) => setContractorForm((p) => ({ ...p, email: String(v) }))} placeholder="选填" status={contractorFieldError.email ? 'error' : 'default'} tips={contractorFieldError.email} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>地址</label>
            <Input value={contractorForm.address} onChange={(v) => setContractorForm((p) => ({ ...p, address: String(v) }))} placeholder="选填" status={contractorFieldError.address ? 'error' : 'default'} tips={contractorFieldError.address} />
          </div>

          {/* 首条费率：仅 local 新增时显示（cloud 无原子创建，费率经详情 Drawer 单独新增） */}
          {!isCloud && !editingContractor && (
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

      {/* 详情 Drawer：承包商资料 + 费率历史（local / cloud 均展示） */}
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
              <div style={{ marginBottom: 4 }}>电话：{detailContractor.phone ?? '—'}</div>
              <div style={{ marginBottom: 4 }}>邮箱：{detailContractor.email ?? '—'}</div>
              <div>地址：{detailContractor.address ?? '—'}</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>费率历史</span>
              {canWrite && (
                <Button size="small" theme="primary" icon={<AddIcon />} onClick={openCreateRate}>
                  新增费率
                </Button>
              )}
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

      {/* 费率表单 Dialog（local / cloud 均使用） */}
      <Dialog
        visible={rateFormVisible}
        header={editingRate ? '编辑费率' : '新增费率'}
        width={440}
        confirmBtn={{ content: '保存', theme: 'primary', loading: isCloud ? mutating : submittingRate }}
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
