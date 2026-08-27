import { useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  Input,
  MessagePlugin,
  Popconfirm,
  Space,
  Table,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { Store, StoreInput } from '../../data/types'
import { usePagination } from '../../hooks/usePagination'
import { useDbData } from '../../hooks/useDbData'

interface FormState {
  store_name: string
  address: string
  phone: string
}

const emptyForm: FormState = { store_name: '', address: '', phone: '' }

function toForm(s: Store): FormState {
  return { store_name: s.store_name, address: s.address, phone: s.phone }
}

function toInput(f: FormState): StoreInput {
  return { store_name: f.store_name, address: f.address, phone: f.phone }
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

export function Stores() {
  const { role } = useAuth()
  const [keyword, setKeyword] = useState('')
  const [dialogVisible, setDialogVisible] = useState(false)
  const [editing, setEditing] = useState<Store | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const all = useDbData(() => dataService.listStores())
  const items = useDbData(() => dataService.listItems())

  const countByStore = (storeId: number) => items.filter((i) => i.current_store_id === storeId).length

  const filtered = useMemo(() => {
    if (!keyword.trim()) return all
    return all.filter((s) =>
      `${s.store_name} ${s.address} ${s.phone}`.toLowerCase().includes(keyword.trim().toLowerCase()),
    )
  }, [all, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const resetForm = () => {
    setForm(emptyForm)
    setFieldError({})
  }

  const openCreate = () => {
    setEditing(null)
    resetForm()
    setDialogVisible(true)
  }

  const openEdit = (s: Store) => {
    setEditing(s)
    setForm(toForm(s))
    setFieldError({})
    setDialogVisible(true)
  }

  const setField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    if (submitting || !role) return
    setSubmitting(true)
    const result = editing
      ? dataService.updateStore(role, editing.store_id, toInput(form))
      : dataService.createStore(role, toInput(form))
    setSubmitting(false)

    if (result.ok) {
      MessagePlugin.success(editing ? '门店已更新' : '门店已新增')
      setDialogVisible(false)
      resetForm()
    } else {
      if (result.field) {
        setFieldError({ [result.field]: result.error })
      } else {
        MessagePlugin.error(result.error)
      }
    }
  }

  const handleDelete = (s: Store) => {
    if (!role) return
    const result = dataService.removeStore(role, s.store_id)
    if (result.ok) {
      MessagePlugin.success('门店已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<Store>[] = [
    { colKey: 'store_name', title: '门店名称', width: 180 },
    { colKey: 'address', title: '地址', ellipsis: true },
    { colKey: 'phone', title: '电话', width: 150 },
    {
      colKey: 'count',
      title: '当前在店设备',
      width: 120,
      cell: ({ row }) => <span className="num">{countByStore(row.store_id)}</span>,
    },
    {
      colKey: 'op',
      title: '操作',
      width: 130,
      fixed: 'right',
      cell: ({ row }) => (
        <Space>
          <Button size="small" variant="text" theme="primary" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            content="删除后该门店记录将不可恢复，确认删除？"
            confirmBtn={{ content: '删除', theme: 'danger' }}
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" variant="text" theme="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="门店管理" subtitle="维护门店基础信息（仅管理员可访问）" />

      <div
        style={{
          background: 'var(--snowpeak-bg-container)',
          border: '1px solid var(--snowpeak-border)',
          borderRadius: 8,
        }}
      >
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
            placeholder="搜索门店名称 / 地址 / 电话"
            clearable
            prefixIcon={<SearchIcon />}
            style={{ width: 280 }}
          />
          <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
            新增门店
          </Button>
        </div>

        <Table
          data={paged.items}
          columns={columns}
          rowKey="store_id"
          size="small"
          hover
          tableLayout="fixed"
          empty={keyword.trim() ? '未找到匹配的门店' : '暂无门店，点击右上角「新增门店」录入'}
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

      <Dialog
        visible={dialogVisible}
        header={editing ? '编辑门店' : '新增门店'}
        width={480}
        confirmBtn={{ content: '保存', theme: 'primary', loading: submitting }}
        cancelBtn="取消"
        onConfirm={handleSave}
        onClose={() => setDialogVisible(false)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>
              门店名称 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
            </label>
            <Input
              value={form.store_name}
              onChange={(v) => setField('store_name', String(v))}
              placeholder="请输入门店名称"
              status={fieldError.store_name ? 'error' : 'default'}
              tips={fieldError.store_name}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>地址</label>
            <Input
              value={form.address}
              onChange={(v) => setField('address', String(v))}
              placeholder="请输入地址"
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>电话</label>
            <Input
              value={form.phone}
              onChange={(v) => setField('phone', String(v))}
              placeholder="请输入电话"
            />
          </div>
        </div>
      </Dialog>
    </div>
  )
}
