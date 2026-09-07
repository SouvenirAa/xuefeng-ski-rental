import { useEffect, useMemo, useRef, useState } from 'react'
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
import { isCloudMode } from '../../lib/cloudbase'
import { useMasterData } from '../../hooks/useMasterData'
import type { StoreView } from '../../data/cloudMaster'
import type { StoreCloudInput } from '../../data/cloudStoreMutations'
import { usePagination } from '../../hooks/usePagination'

interface FormState {
  store_name: string
  address: string
  phone: string
}

const emptyForm: FormState = { store_name: '', address: '', phone: '' }

/** 列表行（含可空 address/phone）→ 表单：null 回填为空白 */
function toForm(s: StoreView): FormState {
  return { store_name: s.store_name, address: s.address ?? '', phone: s.phone ?? '' }
}

/** 表单 → cloud 可空输入：address/phone 空串归一化为 null（不写虚构文本） */
function toCloudInput(f: FormState): StoreCloudInput {
  return {
    store_name: f.store_name,
    address: f.address.trim() === '' ? null : f.address.trim(),
    phone: f.phone.trim() === '' ? null : f.phone.trim(),
  }
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

export function Stores() {
  const { role } = useAuth()
  const isCloud = isCloudMode()
  const {
    stores: all,
    items,
    loading,
    error,
    retry,
    createStore,
    updateStore,
    removeStore,
    storeMutating,
  } = useMasterData()

  // 门店写权限：仅 admin（cloud/local 统一；staff/contractor 由路由层 /stores 拦截 403）
  const canWrite = role === 'admin'

  const [keyword, setKeyword] = useState('')
  const [dialogVisible, setDialogVisible] = useState(false)
  const [editing, setEditing] = useState<StoreView | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})

  // 卸载防护：异步保存/删除返回后，组件已卸载则不再写状态 / 触发全局消息
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const countByStore = (storeId: number) => items.filter((i) => i.current_store_id === storeId).length

  const filtered = useMemo(() => {
    if (!keyword.trim()) return all
    return all.filter((s) =>
      `${s.store_name} ${s.address ?? ''} ${s.phone ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase()),
    )
  }, [all, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filtered, 10)

  const resetForm = () => {
    setForm(emptyForm)
    setFieldError({})
  }

  const openCreate = () => {
    if (!canWrite) return
    setEditing(null)
    resetForm()
    setDialogVisible(true)
  }

  const openEdit = (s: StoreView) => {
    if (!canWrite) return
    setEditing(s)
    setForm(toForm(s))
    setFieldError({})
    setDialogVisible(true)
  }

  const setField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    // 字段重新输入时清除该字段错误
    setFieldError((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const handleSave = async () => {
    if (storeMutating || !canWrite) return
    const input = toCloudInput(form)
    const result = editing
      ? await updateStore(editing.store_id, input)
      : await createStore(input)

    // 组件已卸载：不再写状态、不触发全局消息
    if (!mountedRef.current) return

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

  const handleDelete = async (s: StoreView) => {
    if (!canWrite) return
    const result = await removeStore(s.store_id)
    // 组件已卸载：不再触发全局消息
    if (!mountedRef.current) return
    if (result.ok) {
      MessagePlugin.success('门店已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<StoreView>[] = [
    { colKey: 'store_name', title: '门店名称', width: 180 },
    { colKey: 'address', title: '地址', ellipsis: true, cell: ({ row }) => row.address ?? '—' },
    { colKey: 'phone', title: '电话', width: 150, cell: ({ row }) => row.phone ?? '—' },
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
      cell: ({ row }) => {
        if (!canWrite) {
          return (
            <span style={{ color: 'var(--snowpeak-text-placeholder)', fontSize: 12 }}>
              仅管理员可操作
            </span>
          )
        }
        return (
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
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader
        title="门店管理"
        subtitle={
          isCloud
            ? 'CloudBase PostgreSQL · 云端数据'
            : '维护门店基础信息（仅管理员可访问）'
        }
      />

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
          {canWrite && (
            <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
              新增门店
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
          rowKey="store_id"
          size="small"
          hover
          loading={isCloud && loading}
          tableLayout="fixed"
          empty={keyword.trim() ? '未找到匹配的门店' : '暂无门店数据'}
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
        confirmBtn={{ content: '保存', theme: 'primary', loading: storeMutating }}
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
              status={fieldError.address ? 'error' : 'default'}
              tips={fieldError.address}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>电话</label>
            <Input
              value={form.phone}
              onChange={(v) => setField('phone', String(v))}
              placeholder="请输入电话"
              status={fieldError.phone ? 'error' : 'default'}
              tips={fieldError.phone}
            />
          </div>
        </div>
      </Dialog>
    </div>
  )
}
