import { useMemo, useState } from 'react'
import {
  Button,
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
import { isCloudMode } from '../../lib/cloudbase'
import { useMasterData } from '../../hooks/useMasterData'
import type { ItemCategory } from '../../data/types'
import type { RentalItemView } from '../../data/cloudMaster'
import type { RentalItemCloudInput } from '../../data/cloudItemMutations'
import { formatMoney } from '../../utils/format'
import { usePagination } from '../../hooks/usePagination'

const CATEGORIES: ItemCategory[] = ['滑雪板', '雪靴', '雪杖', '单板', '护目镜', '头盔']
const ACCESSORY_CATEGORIES: ItemCategory[] = ['护目镜', '头盔']

interface FormState {
  item_code: string
  name: string
  description: string
  category: ItemCategory
  purchase_date: string
  purchase_cost: number | undefined
  retail_price: number | undefined
  daily_rate: number | undefined
  skill_level_id: number | undefined
  home_store_id: number | undefined
  current_store_id: number | undefined
}

const emptyForm: FormState = {
  item_code: '',
  name: '',
  description: '',
  category: '滑雪板',
  purchase_date: '',
  purchase_cost: undefined,
  retail_price: undefined,
  daily_rate: undefined,
  skill_level_id: undefined,
  home_store_id: undefined,
  current_store_id: undefined,
}

/**
 * 统一用 RentalItemView（云端可空字段显式建模为 null）回填表单：
 * null 字段回填为空白/undefined，local 的 RentalItem 结构性可赋值、回填行为不变。
 * cloud 编辑直接使用列表行，不调用 dataService.listItems 取详情。
 */
function toForm(i: RentalItemView): FormState {
  return {
    item_code: i.item_code,
    name: i.name,
    description: i.description ?? '',
    category: i.category,
    purchase_date: i.purchase_date ?? '',
    purchase_cost: i.purchase_cost ?? undefined,
    retail_price: i.retail_price ?? undefined,
    daily_rate: i.daily_rate,
    skill_level_id: i.skill_level_id ?? undefined,
    home_store_id: i.home_store_id,
    current_store_id: i.current_store_id,
  }
}

/** cloud 输入：空值写为 null（不得转 0 / 空日期 / 虚构文本），与 local 非空类型明确区分 */
function toCloudInput(f: FormState): RentalItemCloudInput {
  return {
    item_code: f.item_code,
    name: f.name,
    description: f.description.trim() === '' ? null : f.description.trim(),
    category: f.category,
    purchase_date: f.purchase_date.trim() === '' ? null : f.purchase_date.trim(),
    purchase_cost: f.purchase_cost ?? null,
    retail_price: f.retail_price ?? null,
    daily_rate: f.daily_rate ?? null,
    skill_level_id: f.skill_level_id ?? null,
    home_store_id: f.home_store_id as number,
    current_store_id: f.current_store_id as number,
  }
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

export function Items() {
  const { role } = useAuth()
  const isCloud = isCloudMode()
  // 设备写操作仅 admin（local 与 cloud 一致；staff 只读，contractor 由路由层 403 拦截）
  const canWrite = role === 'admin'

  const {
    items: all,
    stores,
    skillLevels: levels,
    loading,
    error,
    retry,
    create,
    update,
    remove,
    mutating,
  } = useMasterData()

  const [keyword, setKeyword] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterLevel, setFilterLevel] = useState<string>('')
  const [filterStore, setFilterStore] = useState<string>('')

  const [drawerVisible, setDrawerVisible] = useState(false)
  const [editing, setEditing] = useState<RentalItemView | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [fieldError, setFieldError] = useState<Record<string, string>>({})

  const storeName = (id: number) => stores.find((s) => s.store_id === id)?.store_name ?? `#${id}`
  const levelName = (id: number | null) =>
    id === null ? '—' : levels.find((l) => l.skill_level_id === id)?.level_name ?? `#${id}`

  const filtered = useMemo(() => {
    return all.filter((i) => {
      if (keyword.trim() && !`${i.item_code} ${i.name}`.toLowerCase().includes(keyword.trim().toLowerCase())) {
        return false
      }
      if (filterCategory && i.category !== filterCategory) return false
      if (filterStatus && i.status !== filterStatus) return false
      if (filterLevel && String(i.skill_level_id ?? '') !== filterLevel) return false
      if (filterStore && String(i.current_store_id) !== filterStore) return false
      return true
    })
  }, [all, keyword, filterCategory, filterStatus, filterLevel, filterStore])
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

  const openEdit = (i: RentalItemView) => {
    setEditing(i)
    setForm(toForm(i))
    setFieldError({})
    setDrawerVisible(true)
  }

  const setField = (key: keyof FormState, value: FormState[keyof FormState]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // 切换类别：配件自动清空技能等级
  const handleCategoryChange = (v: string) => {
    const category = v as ItemCategory
    setForm((prev) => ({
      ...prev,
      category,
      skill_level_id: ACCESSORY_CATEGORIES.includes(category) ? undefined : prev.skill_level_id,
    }))
  }

  const isAccessory = ACCESSORY_CATEGORIES.includes(form.category)

  const handleSave = async () => {
    if (!role) return
    const result = editing
      ? await update(editing.item_id, toCloudInput(form))
      : await create(toCloudInput(form))

    if (result.ok) {
      MessagePlugin.success(editing ? '设备已更新' : '设备已新增')
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

  const handleDelete = async (i: RentalItemView) => {
    if (!role) return
    // cloud：delete 受 RLS「仅 status=在库」约束，发请求前对非在库设备给出明确提示；
    // local：仍由 DataService.removeItem 内部做状态与引用校验，行为不回归。
    if (isCloud && i.status !== '在库') {
      MessagePlugin.error(`设备当前状态为「${i.status}」，仅「在库」设备可删除`)
      return
    }
    const result = await remove(i.item_id)
    if (result.ok) {
      MessagePlugin.success('设备已删除')
    } else {
      MessagePlugin.error(result.error)
    }
  }

  const columns: PrimaryTableCol<RentalItemView>[] = [
    { colKey: 'item_code', title: '库存编号', width: 110, className: 'font-mono' },
    { colKey: 'name', title: '名称', width: 160, ellipsis: true },
    { colKey: 'category', title: '类别', width: 90 },
    {
      colKey: 'daily_rate',
      title: '日租金',
      width: 100,
      cell: ({ row }) => <span className="num">{formatMoney(row.daily_rate)}</span>,
    },
    {
      colKey: 'skill_level_id',
      title: '技能等级',
      width: 100,
      cell: ({ row }) => levelName(row.skill_level_id),
    },
    {
      colKey: 'home_store_id',
      title: '归属门店',
      width: 120,
      cell: ({ row }) => storeName(row.home_store_id),
    },
    {
      colKey: 'current_store_id',
      title: '当前门店',
      width: 120,
      cell: ({ row }) => storeName(row.current_store_id),
    },
    {
      colKey: 'status',
      title: '状态',
      width: 90,
      cell: ({ row }) => <StatusTag status={row.status} />,
    },
    {
      colKey: 'op',
      title: '操作',
      width: 130,
      fixed: 'right',
      cell: ({ row }) => {
        if (!canWrite) {
          return <span style={{ color: 'var(--snowpeak-text-placeholder)' }}>仅查看</span>
        }
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Button size="small" variant="text" theme="primary" onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Popconfirm
              content="删除后该设备记录将不可恢复，确认删除？"
              confirmBtn={{ content: '删除', theme: 'danger' }}
              onConfirm={() => handleDelete(row)}
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

  return (
    <div>
      <PageHeader
        title="设备管理"
        subtitle={
          isCloud
            ? 'CloudBase PostgreSQL · 云端数据'
            : '以单品粒度维护租赁物品、技能等级与归属/当前门店'
        }
      />

      <div
        style={{
          background: 'var(--snowpeak-bg-container)',
          border: '1px solid var(--snowpeak-border)',
          borderRadius: 8,
        }}
      >
        {/* 工具栏：关键词 + 筛选 + 新增 */}
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
            placeholder="搜索编号 / 名称"
            clearable
            prefixIcon={<SearchIcon />}
            style={{ width: 200 }}
          />
          <Select
            value={filterCategory}
            onChange={(v) => {
              setFilterCategory(String(v ?? ''))
              setPage(1)
            }}
            placeholder="类别"
            clearable
            options={CATEGORIES.map((c) => ({ label: c, value: c }))}
            style={{ width: 120 }}
          />
          <Select
            value={filterStatus}
            onChange={(v) => {
              setFilterStatus(String(v ?? ''))
              setPage(1)
            }}
            placeholder="状态"
            clearable
            options={['在库', '借出中', '维修中', '已报废'].map((s) => ({ label: s, value: s }))}
            style={{ width: 120 }}
          />
          <Select
            value={filterLevel}
            onChange={(v) => {
              setFilterLevel(String(v ?? ''))
              setPage(1)
            }}
            placeholder="技能等级"
            clearable
            options={levels.map((l) => ({ label: l.level_name, value: String(l.skill_level_id) }))}
            style={{ width: 120 }}
          />
          <Select
            value={filterStore}
            onChange={(v) => {
              setFilterStore(String(v ?? ''))
              setPage(1)
            }}
            placeholder="当前门店"
            clearable
            options={stores.map((s) => ({ label: s.store_name, value: String(s.store_id) }))}
            style={{ width: 140 }}
          />
          <div style={{ flex: 1 }} />
          {canWrite && (
            <Button theme="primary" icon={<AddIcon />} onClick={openCreate}>
              新增设备
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
          rowKey="item_id"
          size="small"
          hover
          loading={isCloud && loading}
          empty={
            keyword.trim() || filterCategory || filterStatus || filterLevel || filterStore
              ? '未找到匹配的设备'
              : isCloud
                ? '暂无设备数据'
                : '暂无设备，点击右上角「新增设备」录入'
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

      {canWrite && (
        <Drawer
          visible={drawerVisible}
          header={
            editing
              ? `编辑设备 ${editing.item_code}`
              : '新增设备'
          }
          size="520px"
          onClose={() => setDrawerVisible(false)}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="outline" onClick={() => setDrawerVisible(false)} style={{ minWidth: 80 }}>
                取消
              </Button>
              <Button theme="primary" loading={mutating} onClick={handleSave} style={{ minWidth: 96 }}>
                保存
              </Button>
            </div>
          }
        >
          <div style={{ padding: '4px 0' }}>
            {editing && (
              <div
                style={{
                  marginBottom: 16,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: 'var(--snowpeak-text-secondary)',
                }}
              >
                当前状态：
                <StatusTag status={editing.status} />
                <span>（状态由借还/维修流程驱动，此处不可修改）</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>
                  库存编号 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Input
                  value={form.item_code}
                  onChange={(v) => setField('item_code', String(v))}
                  placeholder="如 SN0037"
                  status={fieldError.item_code ? 'error' : 'default'}
                  tips={fieldError.item_code}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>
                  类别 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Select
                  value={form.category}
                  onChange={(v) => handleCategoryChange(String(v))}
                  options={CATEGORIES.map((c) => ({ label: c, value: c }))}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabel}>
                名称 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
              </label>
              <Input
                value={form.name}
                onChange={(v) => setField('name', String(v))}
                placeholder="如 Head XTC 滑雪板"
                status={fieldError.name ? 'error' : 'default'}
                tips={fieldError.name}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabel}>描述</label>
              <Input
                value={form.description}
                onChange={(v) => setField('description', String(v))}
                placeholder="选填，如规格/尺码"
              />
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>购入日期</label>
                <Input
                  value={form.purchase_date}
                  onChange={(v) => setField('purchase_date', String(v))}
                  placeholder="如 2025-11-15"
                  status={fieldError.purchase_date ? 'error' : 'default'}
                  tips={fieldError.purchase_date}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>技能等级</label>
                <Select
                  value={form.skill_level_id}
                  onChange={(v) => setField('skill_level_id', v === '' ? undefined : Number(v))}
                  placeholder={isAccessory ? '配件不设等级' : '选填'}
                  disabled={isAccessory}
                  clearable
                  options={levels.map((l) => ({ label: l.level_name, value: l.skill_level_id }))}
                  status={fieldError.skill_level_id ? 'error' : 'default'}
                  tips={fieldError.skill_level_id}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>
                  日租金 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <InputNumber
                  value={form.daily_rate}
                  onChange={(v) => setField('daily_rate', v as number | undefined)}
                  min={0}
                  theme="normal"
                  status={fieldError.daily_rate ? 'error' : 'default'}
                  tips={fieldError.daily_rate}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>购入成本</label>
                <InputNumber
                  value={form.purchase_cost}
                  onChange={(v) => setField('purchase_cost', v as number | undefined)}
                  min={0}
                  theme="normal"
                  status={fieldError.purchase_cost ? 'error' : 'default'}
                  tips={fieldError.purchase_cost}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>零售价</label>
                <InputNumber
                  value={form.retail_price}
                  onChange={(v) => setField('retail_price', v as number | undefined)}
                  min={0}
                  theme="normal"
                  status={fieldError.retail_price ? 'error' : 'default'}
                  tips={fieldError.retail_price}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>
                  归属门店 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Select
                  value={form.home_store_id}
                  onChange={(v) => setField('home_store_id', v === '' ? undefined : Number(v))}
                  placeholder="请选择"
                  options={stores.map((s) => ({ label: s.store_name, value: s.store_id }))}
                  status={fieldError.home_store_id ? 'error' : 'default'}
                  tips={fieldError.home_store_id}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>
                  当前门店 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Select
                  value={form.current_store_id}
                  onChange={(v) => setField('current_store_id', v === '' ? undefined : Number(v))}
                  placeholder="请选择"
                  options={stores.map((s) => ({ label: s.store_name, value: s.store_id }))}
                  status={fieldError.current_store_id ? 'error' : 'default'}
                  tips={fieldError.current_store_id}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  )
}
