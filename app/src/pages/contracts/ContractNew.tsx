import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  DatePicker,
  Drawer,
  Input,
  InputNumber,
  MessagePlugin,
  Select,
  Steps,
  Table,
  type PrimaryTableCol,
} from 'tdesign-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { RentalItem } from '../../data/types'
import type { RentalItemView } from '../../data/cloudMaster'
import { formatMoney, today } from '../../utils/format'
import { useDbData } from '../../hooks/useDbData'
import { useCustomers } from '../../hooks/useCustomers'
import { useMasterData } from '../../hooks/useMasterData'
import { useWorkforce } from '../../hooks/useWorkforce'
import { isCloudMode, getRdb } from '../../lib/cloudbase'
import {
  createContract as cloudCreateContract,
  SAFE_CONTRACT_WRITE_ERROR,
  type ContractCreateCloudInput,
  type ContractRpcClient,
} from '../../data/cloudContractMutations'
import { dispatchContractCreateMutation } from '../../data/contractDataSource'

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

interface QuickCustomerForm {
  full_name: string
  phone: string
  address: string
  email: string
}

const emptyQuickCustomer: QuickCustomerForm = { full_name: '', phone: '', address: '', email: '' }

/**
 * 新建合同路由：local 走本地表单；cloud 走云端表单（仅 RPC create_contract）。
 */
export function ContractNew() {
  const isCloud = isCloudMode()
  if (isCloud) return <ContractNewCloud />
  return <ContractNewForm />
}

// ---------------------------------------------------------------------------
// cloud 模式：新建合同（仅经受控 RPC create_contract，绝不直接 DML）
// ---------------------------------------------------------------------------

function ContractNewCloud() {
  const navigate = useNavigate()
  const { role, account } = useAuth()

  const [step, setStep] = useState(0)
  const [customerId, setCustomerId] = useState<number | undefined>(undefined)
  const [contractDate, setContractDate] = useState(today())
  const [durationDays, setDurationDays] = useState<number>(1)
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})

  // 快速登记客户 Drawer
  const [quickVisible, setQuickVisible] = useState(false)
  const [quickForm, setQuickForm] = useState<QuickCustomerForm>(emptyQuickCustomer)
  const [quickError, setQuickError] = useState<Record<string, string>>({})
  const [quickSubmitting, setQuickSubmitting] = useState(false)

  // 卸载防护：异步保存返回后，组件已卸载则不再写状态 / 触发全局消息
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const { customers, create: createCustomer, mutating: customerMutating } = useCustomers()
  const { items, stores, skillLevels: levels } = useMasterData()
  const { employees } = useWorkforce()

  const storeName = (id: number) => stores.find((s) => s.store_id === id)?.store_name ?? `#${id}`
  const levelName = (id: number | null) =>
    id === null ? '—' : levels.find((l) => l.skill_level_id === id)?.level_name ?? '—'

  const availableItems = useMemo(() => items.filter((i) => i.status === '在库'), [items])
  const selectedItems = useMemo(
    () => items.filter((i) => selectedItemIds.includes(i.item_id)),
    [items, selectedItemIds],
  )
  const totalPreview = useMemo(
    () => selectedItems.reduce((sum, i) => sum + i.daily_rate * durationDays, 0),
    [selectedItems, durationDays],
  )

  const employeeName = account?.employee_id
    ? employees.find((e) => e.employee_id === account.employee_id)?.full_name ?? '—'
    : '—'

  const itemColumns: PrimaryTableCol<RentalItemView>[] = [
    { colKey: 'row-select', type: 'multiple', width: 46 },
    { colKey: 'item_code', title: '库存编号', width: 110, className: 'font-mono' },
    { colKey: 'name', title: '名称', width: 170, ellipsis: true },
    { colKey: 'category', title: '类别', width: 90 },
    { colKey: 'skill_level_id', title: '等级', width: 80, cell: ({ row }) => levelName(row.skill_level_id) },
    {
      colKey: 'daily_rate',
      title: '日租金',
      width: 100,
      cell: ({ row }) => <span className="num">{formatMoney(row.daily_rate)}</span>,
    },
    { colKey: 'current_store_id', title: '当前门店', width: 130, cell: ({ row }) => storeName(row.current_store_id) },
  ]

  const handleQuickSave = async () => {
    if (quickSubmitting || customerMutating || !role) return
    setQuickSubmitting(true)
    const result = await createCustomer({
      full_name: quickForm.full_name,
      address: quickForm.address,
      phone: quickForm.phone,
      email: quickForm.email || null,
      birth_year: null,
      height_cm: null,
      weight_kg: null,
      shoe_size: null,
    })
    setQuickSubmitting(false)

    if (!mountedRef.current) return

    if (result.ok) {
      MessagePlugin.success('客户已登记')
      setCustomerId(result.data.customer_id)
      setQuickVisible(false)
      setQuickForm(emptyQuickCustomer)
      setQuickError({})
    } else {
      if (result.field) setQuickError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const handleSubmit = async () => {
    if (submitting || !role) return
    const input: ContractCreateCloudInput = {
      customer_id: customerId as number,
      contract_date: contractDate,
      duration_days: durationDays,
      item_ids: selectedItemIds,
    }
    setSubmitting(true)
    const result = await dispatchContractCreateMutation(
      'cloud',
      role === 'admin' || role === 'staff',
      input,
      () => getRdb() as unknown as ContractRpcClient,
      (rpc) => cloudCreateContract(rpc, input),
      () => ({ ok: false, error: SAFE_CONTRACT_WRITE_ERROR }),
    )
    setSubmitting(false)

    if (!mountedRef.current) return

    if (result.ok) {
      MessagePlugin.success('合同已创建并借出')
      navigate(`/contracts/${result.data.contract_id}`)
    } else {
      if (result.field) setFieldError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  return (
    <div>
      <PageHeader title="新建合同" subtitle="CloudBase PostgreSQL · 登记客户 → 选择设备 → 确认并借出（单品粒度，数量恒为 1）" />

      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, padding: 20 }}>
        <Steps current={step} onChange={(v) => setStep(v as number)} style={{ marginBottom: 24 }}>
          <Steps.StepItem title="选择客户" />
          <Steps.StepItem title="选择设备" />
          <Steps.StepItem title="确认合同" />
        </Steps>

        {/* ① 选择客户 */}
        {step === 0 && (
          <div style={{ maxWidth: 560 }}>
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabel}>
                客户 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
              </label>
              <Select
                value={customerId}
                onChange={(v) => setCustomerId(v === '' ? undefined : Number(v))}
                placeholder="搜索并选择客户（可输入姓名/电话/邮箱）"
                filterable
                options={customers.map((c) => ({
                  label: `${c.full_name}（${c.phone}）`,
                  value: c.customer_id,
                }))}
                status={fieldError.customer_id ? 'error' : 'default'}
                tips={fieldError.customer_id}
                style={{ width: '100%' }}
              />
            </div>
            <Button variant="outline" onClick={() => setQuickVisible(true)}>
              快速登记新客户
            </Button>
            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
              <Button theme="primary" disabled={!customerId} onClick={() => setStep(1)}>
                下一步：选择设备
              </Button>
            </div>
          </div>
        )}

        {/* ② 选择设备 */}
        {step === 1 && (
          <div>
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--snowpeak-text-secondary)' }}>
              仅展示「在库」设备；同一设备不可重复选择，每件数量固定为 1。
            </div>
            <div style={{ overflowX: 'auto' }}>
              <Table
                data={availableItems}
                columns={itemColumns}
                rowKey="item_id"
                size="small"
                hover
                tableLayout="fixed"
                selectedRowKeys={selectedItemIds}
                onSelectChange={(keys) => setSelectedItemIds(keys as number[])}
                empty="暂无可借出的在库设备"
              />
            </div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--snowpeak-text-secondary)' }}>
                已选 {selectedItems.length} 件
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setStep(0)}>
                  上一步
                </Button>
                <Button theme="primary" disabled={selectedItemIds.length === 0} onClick={() => setStep(2)}>
                  下一步：确认
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ③ 确认 */}
        {step === 2 && (
          <div>
            <div
              style={{
                background: 'var(--snowpeak-bg-page)',
                border: '1px solid var(--snowpeak-border)',
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 10, fontSize: 13 }}>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>客户</span>
                <span>{customers.find((c) => c.customer_id === customerId)?.full_name ?? '—'}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>经办员工</span>
                <span>{employeeName}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>合同日期</span>
                <span>{contractDate}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>租赁天数</span>
                <span>{durationDays} 天</span>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ width: 220 }}>
                  <label style={fieldLabel}>
                    合同日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <DatePicker
                    value={contractDate}
                    onChange={(v) => setContractDate(v ? String(v) : '')}
                    disableDate={(date) => date > new Date(`${today()}T23:59:59`)}
                    status={fieldError.contract_date ? 'error' : 'default'}
                    tips={fieldError.contract_date}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ width: 180 }}>
                  <label style={fieldLabel}>
                    租赁天数 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <InputNumber
                    value={durationDays}
                    onChange={(v) => setDurationDays(v as number)}
                    min={1}
                    theme="normal"
                    status={fieldError.duration_days ? 'error' : 'default'}
                    tips={fieldError.duration_days}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>

            <Table
              data={selectedItems}
              rowKey="item_id"
              size="small"
              hover
              columns={[
                { colKey: 'item_code', title: '库存编号', width: 110, className: 'font-mono' },
                { colKey: 'name', title: '名称', width: 180, ellipsis: true },
                { colKey: 'quantity', title: '数量', width: 70, cell: () => '1' },
                {
                  colKey: 'daily_rate',
                  title: '日租金',
                  width: 100,
                  cell: ({ row }) => <span className="num">{formatMoney(row.daily_rate)}</span>,
                },
                {
                  colKey: 'current_store_id',
                  title: '借出门店',
                  width: 130,
                  cell: ({ row }) => storeName(row.current_store_id),
                },
              ]}
            />

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15 }}>
                应收总额：
                <span className="num" style={{ fontWeight: 600, fontSize: 18, color: 'var(--snowpeak-primary)' }}>
                  {formatMoney(totalPreview)}
                </span>
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setStep(1)}>
                  上一步
                </Button>
                <Button theme="primary" loading={submitting} onClick={handleSubmit} style={{ minWidth: 96 }}>
                  保存并借出
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 快速登记客户 Drawer */}
      <Drawer
        visible={quickVisible}
        header="快速登记客户"
        size="440px"
        onClose={() => setQuickVisible(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setQuickVisible(false)} style={{ minWidth: 80 }}>
              取消
            </Button>
            <Button theme="primary" loading={quickSubmitting || customerMutating} onClick={handleQuickSave} style={{ minWidth: 96 }}>
              保存
            </Button>
          </div>
        }
      >
        <div style={{ padding: '4px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              姓名 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.full_name} onChange={(v) => setQuickForm((p) => ({ ...p, full_name: String(v) }))} placeholder="请输入姓名" status={quickError.full_name ? 'error' : 'default'} tips={quickError.full_name} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              电话 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.phone} onChange={(v) => setQuickForm((p) => ({ ...p, phone: String(v) }))} placeholder="请输入电话" status={quickError.phone ? 'error' : 'default'} tips={quickError.phone} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              地址 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.address} onChange={(v) => setQuickForm((p) => ({ ...p, address: String(v) }))} placeholder="请输入地址" status={quickError.address ? 'error' : 'default'} tips={quickError.address} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱（选填，用于识别回头客）</label>
            <Input value={quickForm.email} onChange={(v) => setQuickForm((p) => ({ ...p, email: String(v) }))} placeholder="选填" status={quickError.email ? 'error' : 'default'} tips={quickError.email} />
          </div>
        </div>
      </Drawer>
    </div>
  )
}

function ContractNewForm() {
  const navigate = useNavigate()
  const { role, account } = useAuth()

  const [step, setStep] = useState(0)
  const [customerId, setCustomerId] = useState<number | undefined>(undefined)
  const [contractDate, setContractDate] = useState(today())
  const [durationDays, setDurationDays] = useState<number>(1)
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})

  // 快速登记客户 Drawer
  const [quickVisible, setQuickVisible] = useState(false)
  const [quickForm, setQuickForm] = useState<QuickCustomerForm>(emptyQuickCustomer)
  const [quickError, setQuickError] = useState<Record<string, string>>({})
  const [quickSubmitting, setQuickSubmitting] = useState(false)

  const customers = useDbData(() => dataService.listCustomers())
  const items = useDbData(() => dataService.listItems())
  const stores = useDbData(() => dataService.listStores())
  const levels = useDbData(() => dataService.listSkillLevels())
  const employees = useDbData(() => dataService.listEmployees())

  const storeName = (id: number) => stores.find((s) => s.store_id === id)?.store_name ?? `#${id}`
  const levelName = (id: number | null) =>
    id === null ? '—' : levels.find((l) => l.skill_level_id === id)?.level_name ?? '—'

  const availableItems = useMemo(() => items.filter((i) => i.status === '在库'), [items])
  const selectedItems = useMemo(
    () => items.filter((i) => selectedItemIds.includes(i.item_id)),
    [items, selectedItemIds],
  )
  const totalPreview = useMemo(
    () => selectedItems.reduce((sum, i) => sum + i.daily_rate * durationDays, 0),
    [selectedItems, durationDays],
  )

  const employeeName = account?.employee_id
    ? employees.find((e) => e.employee_id === account.employee_id)?.full_name ?? '—'
    : '—'

  const itemColumns: PrimaryTableCol<RentalItem>[] = [
    { colKey: 'row-select', type: 'multiple', width: 46 },
    { colKey: 'item_code', title: '库存编号', width: 110, className: 'font-mono' },
    { colKey: 'name', title: '名称', width: 170, ellipsis: true },
    { colKey: 'category', title: '类别', width: 90 },
    { colKey: 'skill_level_id', title: '等级', width: 80, cell: ({ row }) => levelName(row.skill_level_id) },
    {
      colKey: 'daily_rate',
      title: '日租金',
      width: 100,
      cell: ({ row }) => <span className="num">{formatMoney(row.daily_rate)}</span>,
    },
    { colKey: 'current_store_id', title: '当前门店', width: 130, cell: ({ row }) => storeName(row.current_store_id) },
  ]

  const handleQuickSave = () => {
    if (quickSubmitting || !role) return
    setQuickSubmitting(true)
    const result = dataService.createCustomer(role, {
      full_name: quickForm.full_name,
      address: quickForm.address,
      phone: quickForm.phone,
      email: quickForm.email || null,
      birth_year: null,
      height_cm: null,
      weight_kg: null,
      shoe_size: null,
    })
    setQuickSubmitting(false)

    if (result.ok) {
      MessagePlugin.success('客户已登记')
      setCustomerId(result.data.customer_id)
      setQuickVisible(false)
      setQuickForm(emptyQuickCustomer)
      setQuickError({})
    } else {
      if (result.field) setQuickError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const handleSubmit = () => {
    if (submitting || !role) return
    setSubmitting(true)
    const result = dataService.createContract(
      role,
      account?.employee_id ?? null,
      {
        customer_id: customerId as number,
        contract_date: contractDate,
        duration_days: durationDays,
        item_ids: selectedItemIds,
      },
    )
    setSubmitting(false)

    if (result.ok) {
      MessagePlugin.success('合同已创建并借出')
      navigate(`/contracts/${result.data.contract.contract_id}`)
    } else {
      if (result.field) setFieldError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  return (
    <div>
      <PageHeader title="新建合同" subtitle="登记客户 → 选择设备 → 确认并借出（单品粒度，数量恒为 1）" />

      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, padding: 20 }}>
        <Steps current={step} onChange={(v) => setStep(v as number)} style={{ marginBottom: 24 }}>
          <Steps.StepItem title="选择客户" />
          <Steps.StepItem title="选择设备" />
          <Steps.StepItem title="确认合同" />
        </Steps>

        {/* ① 选择客户 */}
        {step === 0 && (
          <div style={{ maxWidth: 560 }}>
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabel}>
                客户 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
              </label>
              <Select
                value={customerId}
                onChange={(v) => setCustomerId(v === '' ? undefined : Number(v))}
                placeholder="搜索并选择客户（可输入姓名/电话/邮箱）"
                filterable
                options={customers.map((c) => ({
                  label: `${c.full_name}（${c.phone}）`,
                  value: c.customer_id,
                }))}
                status={fieldError.customer_id ? 'error' : 'default'}
                tips={fieldError.customer_id}
                style={{ width: '100%' }}
              />
            </div>
            <Button variant="outline" onClick={() => setQuickVisible(true)}>
              快速登记新客户
            </Button>
            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
              <Button theme="primary" disabled={!customerId} onClick={() => setStep(1)}>
                下一步：选择设备
              </Button>
            </div>
          </div>
        )}

        {/* ② 选择设备 */}
        {step === 1 && (
          <div>
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--snowpeak-text-secondary)' }}>
              仅展示「在库」设备；同一设备不可重复选择，每件数量固定为 1。
            </div>
            <div style={{ overflowX: 'auto' }}>
              <Table
                data={availableItems}
                columns={itemColumns}
                rowKey="item_id"
                size="small"
                hover
                tableLayout="fixed"
                selectedRowKeys={selectedItemIds}
                onSelectChange={(keys) => setSelectedItemIds(keys as number[])}
                empty="暂无可借出的在库设备"
              />
            </div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--snowpeak-text-secondary)' }}>
                已选 {selectedItems.length} 件
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setStep(0)}>
                  上一步
                </Button>
                <Button theme="primary" disabled={selectedItemIds.length === 0} onClick={() => setStep(2)}>
                  下一步：确认
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ③ 确认 */}
        {step === 2 && (
          <div>
            <div
              style={{
                background: 'var(--snowpeak-bg-page)',
                border: '1px solid var(--snowpeak-border)',
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 10, fontSize: 13 }}>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>客户</span>
                <span>{customers.find((c) => c.customer_id === customerId)?.full_name ?? '—'}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>经办员工</span>
                <span>{employeeName}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>合同日期</span>
                <span>{contractDate}</span>
                <span style={{ color: 'var(--snowpeak-text-secondary)' }}>租赁天数</span>
                <span>{durationDays} 天</span>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ width: 220 }}>
                  <label style={fieldLabel}>
                    合同日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <DatePicker
                    value={contractDate}
                    onChange={(v) => setContractDate(v ? String(v) : '')}
                    disableDate={(date) => date > new Date(`${today()}T23:59:59`)}
                    status={fieldError.contract_date ? 'error' : 'default'}
                    tips={fieldError.contract_date}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ width: 180 }}>
                  <label style={fieldLabel}>
                    租赁天数 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <InputNumber
                    value={durationDays}
                    onChange={(v) => setDurationDays(v as number)}
                    min={1}
                    theme="normal"
                    status={fieldError.duration_days ? 'error' : 'default'}
                    tips={fieldError.duration_days}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>

            <Table
              data={selectedItems}
              rowKey="item_id"
              size="small"
              hover
              columns={[
                { colKey: 'item_code', title: '库存编号', width: 110, className: 'font-mono' },
                { colKey: 'name', title: '名称', width: 180, ellipsis: true },
                { colKey: 'quantity', title: '数量', width: 70, cell: () => '1' },
                {
                  colKey: 'daily_rate',
                  title: '日租金',
                  width: 100,
                  cell: ({ row }) => <span className="num">{formatMoney(row.daily_rate)}</span>,
                },
                {
                  colKey: 'current_store_id',
                  title: '借出门店',
                  width: 130,
                  cell: ({ row }) => storeName(row.current_store_id),
                },
              ]}
            />

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15 }}>
                应收总额：
                <span className="num" style={{ fontWeight: 600, fontSize: 18, color: 'var(--snowpeak-primary)' }}>
                  {formatMoney(totalPreview)}
                </span>
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setStep(1)}>
                  上一步
                </Button>
                <Button theme="primary" loading={submitting} onClick={handleSubmit} style={{ minWidth: 96 }}>
                  保存并借出
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 快速登记客户 Drawer */}
      <Drawer
        visible={quickVisible}
        header="快速登记客户"
        size="440px"
        onClose={() => setQuickVisible(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setQuickVisible(false)} style={{ minWidth: 80 }}>
              取消
            </Button>
            <Button theme="primary" loading={quickSubmitting} onClick={handleQuickSave} style={{ minWidth: 96 }}>
              保存
            </Button>
          </div>
        }
      >
        <div style={{ padding: '4px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              姓名 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.full_name} onChange={(v) => setQuickForm((p) => ({ ...p, full_name: String(v) }))} placeholder="请输入姓名" status={quickError.full_name ? 'error' : 'default'} tips={quickError.full_name} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              电话 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.phone} onChange={(v) => setQuickForm((p) => ({ ...p, phone: String(v) }))} placeholder="请输入电话" status={quickError.phone ? 'error' : 'default'} tips={quickError.phone} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              地址 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input value={quickForm.address} onChange={(v) => setQuickForm((p) => ({ ...p, address: String(v) }))} placeholder="请输入地址" status={quickError.address ? 'error' : 'default'} tips={quickError.address} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱（选填，用于识别回头客）</label>
            <Input value={quickForm.email} onChange={(v) => setQuickForm((p) => ({ ...p, email: String(v) }))} placeholder="选填" status={quickError.email ? 'error' : 'default'} tips={quickError.email} />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
