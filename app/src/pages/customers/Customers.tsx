import { useMemo, useState } from 'react'
import {
  Button,
  Drawer,
  Input,
  InputNumber,
  MessagePlugin,
  Popconfirm,
  Table,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { Customer, CustomerInput } from '../../data/types'
import { matchesKeyword } from '../../utils/pagination'
import { usePagination } from '../../hooks/usePagination'
import { useDbData } from '../../hooks/useDbData'

interface FormState {
  full_name: string
  address: string
  phone: string
  email: string
  birth_year: number | undefined
  height_cm: number | undefined
  weight_kg: number | undefined
  shoe_size: number | undefined
}

const emptyForm: FormState = {
  full_name: '',
  address: '',
  phone: '',
  email: '',
  birth_year: undefined,
  height_cm: undefined,
  weight_kg: undefined,
  shoe_size: undefined,
}

function toForm(c: Customer): FormState {
  return {
    full_name: c.full_name,
    address: c.address,
    phone: c.phone,
    email: c.email ?? '',
    birth_year: c.birth_year ?? undefined,
    height_cm: c.height_cm ?? undefined,
    weight_kg: c.weight_kg ?? undefined,
    shoe_size: c.shoe_size ?? undefined,
  }
}

function toInput(f: FormState): CustomerInput {
  return {
    full_name: f.full_name,
    address: f.address,
    phone: f.phone,
    email: f.email.trim() === '' ? null : f.email,
    birth_year: f.birth_year ?? null,
    height_cm: f.height_cm ?? null,
    weight_kg: f.weight_kg ?? null,
    shoe_size: f.shoe_size ?? null,
  }
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

export function Customers() {
  const { role } = useAuth()
  const [keyword, setKeyword] = useState('')
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const all = useDbData(() => dataService.listCustomers())
  const filtered = useMemo(() => {
    if (!keyword.trim()) return all
    return all.filter((c) => matchesKeyword(c, keyword, ['full_name', 'phone', 'email']))
  }, [all, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const resetForm = () => {
    setForm(emptyForm)
    setFieldError({})
  }

  const openCreate = () => {
    setEditing(null)
    resetForm()
    setDrawerVisible(true)
  }

  const openEdit = (c: Customer) => {
    setEditing(c)
    setForm(toForm(c))
    setFieldError({})
    setDrawerVisible(true)
  }

  const setField = (key: keyof FormState, value: FormState[keyof FormState]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    if (submitting || !role) return
    setSubmitting(true)
    const result = editing
      ? dataService.updateCustomer(role, editing.customer_id, toInput(form))
      : dataService.createCustomer(role, toInput(form))
    setSubmitting(false)

    if (result.ok) {
      MessagePlugin.success(editing ? '客户已更新' : '客户已新增')
      setDrawerVisible(false)
      resetForm()
    } else {
      if (result.field) {
        setFieldError({ [result.field]: result.error })
      } else {
        MessagePlugin.error(result.error)
      }
    }
  }

  const handleDelete = (c: Customer) => {
    if (!role) return
    const result = dataService.removeCustomer(role, c.customer_id)
    if (result.ok) {
      MessagePlugin.success('客户已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<Customer>[] = [
    { colKey: 'full_name', title: '姓名', width: 120 },
    { colKey: 'phone', title: '电话', width: 140 },
    { colKey: 'email', title: '邮箱', ellipsis: true },
    { colKey: 'birth_year', title: '出生年份', width: 100 },
    { colKey: 'height_cm', title: '身高(cm)', width: 90 },
    { colKey: 'weight_kg', title: '体重(kg)', width: 90 },
    { colKey: 'shoe_size', title: '鞋码', width: 80 },
    { colKey: 'address', title: '地址', ellipsis: true },
    {
      colKey: 'op',
      title: '操作',
      width: 130,
      fixed: 'right',
      cell: ({ row }) => (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Button size="small" variant="text" theme="primary" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            content="删除后该客户记录将不可恢复，确认删除？"
            confirmBtn={{ content: '删除', theme: 'danger' }}
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" variant="text" theme="danger">
              删除
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="客户管理" subtitle="登记与查询客户，通过邮箱识别回头客" />

      <div
        style={{
          background: 'var(--snowpeak-bg-container)',
          border: '1px solid var(--snowpeak-border)',
          borderRadius: 8,
        }}
      >
        {/* 工具栏 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
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
            placeholder="搜索姓名 / 电话 / 邮箱"
            clearable
            prefixIcon={<SearchIcon />}
            style={{ width: 280 }}
          />
          <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
            新增客户
          </Button>
        </div>

        <Table
          data={paged.items}
          columns={columns}
          rowKey="customer_id"
          size="small"
          hover
          tableLayout="fixed"
          empty={
            keyword.trim()
              ? '未找到匹配的客户'
              : '暂无客户，点击右上角「新增客户」开始登记'
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

      <Drawer
        visible={drawerVisible}
        header={editing ? '编辑客户' : '新增客户'}
        size="480px"
        onClose={() => setDrawerVisible(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setDrawerVisible(false)} style={{ minWidth: 80 }}>
              取消
            </Button>
            <Button theme="primary" loading={submitting} onClick={handleSave} style={{ minWidth: 96 }}>
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
            <Input
              value={form.full_name}
              onChange={(v) => setField('full_name', String(v))}
              placeholder="请输入姓名"
              status={fieldError.full_name ? 'error' : 'default'}
              tips={fieldError.full_name}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              电话 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input
              value={form.phone}
              onChange={(v) => setField('phone', String(v))}
              placeholder="请输入电话"
              status={fieldError.phone ? 'error' : 'default'}
              tips={fieldError.phone}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱</label>
            <Input
              value={form.email}
              onChange={(v) => setField('email', String(v))}
              placeholder="选填，用于识别回头客"
              status={fieldError.email ? 'error' : 'default'}
              tips={fieldError.email}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              地址 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input
              value={form.address}
              onChange={(v) => setField('address', String(v))}
              placeholder="请输入地址"
              status={fieldError.address ? 'error' : 'default'}
              tips={fieldError.address}
            />
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>出生年份</label>
              <InputNumber
                value={form.birth_year}
                onChange={(v) => setField('birth_year', v as number | undefined)}
                placeholder="如 1995"
                theme="normal"
                status={fieldError.birth_year ? 'error' : 'default'}
                tips={fieldError.birth_year}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>身高(cm)</label>
              <InputNumber
                value={form.height_cm}
                onChange={(v) => setField('height_cm', v as number | undefined)}
                placeholder="如 170"
                theme="normal"
                status={fieldError.height_cm ? 'error' : 'default'}
                tips={fieldError.height_cm}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>体重(kg)</label>
              <InputNumber
                value={form.weight_kg}
                onChange={(v) => setField('weight_kg', v as number | undefined)}
                placeholder="如 65"
                theme="normal"
                status={fieldError.weight_kg ? 'error' : 'default'}
                tips={fieldError.weight_kg}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>鞋码</label>
              <InputNumber
                value={form.shoe_size}
                onChange={(v) => setField('shoe_size', v as number | undefined)}
                placeholder="如 40"
                theme="normal"
                status={fieldError.shoe_size ? 'error' : 'default'}
                tips={fieldError.shoe_size}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>
      </Drawer>
    </div>
  )
}
