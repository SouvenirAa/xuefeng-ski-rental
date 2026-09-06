import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button,
  DatePicker,
  Descriptions,
  Dialog,
  Empty,
  Loading,
  MessagePlugin,
  Popconfirm,
  Select,
  Table,
  Tag,
  Timeline,
  type PrimaryTableCol,
} from 'tdesign-react'
import { ChevronLeftIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { RentalItem } from '../../data/types'
import type {
  ContractChangeView,
  ContractLineView,
  ItemRefView,
} from '../../data/cloudContracts'
import { formatDateTime, formatMoney, today } from '../../utils/format'
import { useDbData, type UseDbDataOptions } from '../../hooks/useDbData'
import { useContractDetail } from '../../hooks/useContractDetail'
import { parseContractIdParam } from '../../data/contractDataSource'
import { isCloudMode } from '../../lib/cloudbase'

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

/** 自然日差（与 DataService 口径一致） */
function dateDiffDays(from: string, to: string): number {
  const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`)
  return Math.round((parse(to) - parse(from)) / 86400000)
}

interface LineRow {
  item: ItemRefView | null
  line: ContractLineView
  checkout_store_name: string
  return_store_name: string
}

/** 稳定空设备数组：cloud 模式下 useDbData 的 disabledValue */
const EMPTY_ITEMS: RentalItem[] = []

export function ContractDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { role } = useAuth()
  // 严格解析路由 ID：非法值（abc/0/负数/小数/Infinity/NaN/指数/多余字符/超安全整数）→ null
  const contractId = parseContractIdParam(id)
  const isCloud = isCloudMode()

  const { detail, loading, error, notFound, invalid, retry } = useContractDetail(contractId)

  // 门店名解析：优先用详情自带 stores（local/cloud 均可用）；local 的详情视图已含 stores。
  const stores = useMemo(() => detail?.stores ?? [], [detail])

  // 完整设备列表仅本地模式的换货候选/差价预估需要；cloud 模式或非法 ID 下零订阅零 read。
  const itemsOptions: UseDbDataOptions<RentalItem[]> = isCloud || invalid
    ? { enabled: false, disabledValue: EMPTY_ITEMS }
    : { enabled: true }
  const items = useDbData(() => dataService.listItems(), itemsOptions)

  const contract = detail?.contract ?? null
  const lines = useMemo(() => detail?.lines ?? [], [detail])
  const changes = useMemo(() => detail?.changes ?? [], [detail])

  // 换货 Dialog 状态（仅 local 使用）
  const [exchangeVisible, setExchangeVisible] = useState(false)
  const [exchangeLine, setExchangeLine] = useState<ContractLineView | null>(null)
  const [newItemId, setNewItemId] = useState<number | undefined>(undefined)
  const [returnStoreId, setReturnStoreId] = useState<number | undefined>(undefined)
  const [changeDate, setChangeDate] = useState(today())
  const [exchangeSubmitting, setExchangeSubmitting] = useState(false)
  const [exchangeError, setExchangeError] = useState<Record<string, string>>({})

  // 归还 Dialog 状态（仅 local 使用）
  const [returnVisible, setReturnVisible] = useState(false)
  const [returnLineIds, setReturnLineIds] = useState<number[]>([])
  const [returnStoreId2, setReturnStoreId2] = useState<number | undefined>(undefined)
  const [returnSubmitting, setReturnSubmitting] = useState(false)
  const [returnError, setReturnError] = useState<Record<string, string>>({})

  const storeName = (sid: number | null) =>
    sid === null ? '—' : stores.find((s) => s.store_id === sid)?.store_name ?? `#${sid}`

  const isCompleted = contract?.status === '已完成'
  const activeLines = lines.filter((l) => l.line.status === '借出中')

  const exchangeOldItem = exchangeLine
    ? items.find((i) => i.item_id === exchangeLine.item_id) ?? null
    : null

  const contractItemIds = useMemo(
    () => new Set(lines.map((l) => l.line.item_id)),
    [lines],
  )
  const exchangeCandidates = useMemo(
    () => items.filter((i) => i.status === '在库' && !contractItemIds.has(i.item_id)),
    [items, contractItemIds],
  )
  const exchangeNewItem = newItemId ? items.find((i) => i.item_id === newItemId) ?? null : null

  // 换货预估差价（仅展示，最终由 DataService 复算）。
  // 口径与服务层一致：新设备本次目录价 − 旧明细合同快照 daily_rate（而非目录价）。
  const exchangePreview = useMemo(() => {
    if (!exchangeLine || !exchangeNewItem || !contract) return null
    const elapsed = dateDiffDays(contract.contract_date, changeDate)
    const remaining = contract.duration_days - elapsed
    if (remaining <= 0) return null
    return {
      remaining,
      delta: (exchangeNewItem.daily_rate - exchangeLine.daily_rate) * remaining,
    }
  }, [exchangeLine, exchangeNewItem, contract, changeDate])

  // 变更时间线：按分组聚合
  const groupedChanges = useMemo(() => {
    const groups = new Map<number | null, ContractChangeView[]>()
    for (const ch of changes) {
      const key = ch.change_group_id
      const arr = groups.get(key) ?? []
      arr.push(ch)
      groups.set(key, arr)
    }
    return Array.from(groups.entries()).sort((a, b) => (a[1][0].change_date < b[1][0].change_date ? -1 : 1))
  }, [changes])

  // 五态渲染：invalid（非法路由 ID，不查询、不 loading、不重试）→ loading → error → notFound → found
  if (invalid) {
    return (
      <div>
        <PageHeader
          title="合同详情"
          subtitle={isCloud ? 'CloudBase PostgreSQL · 只读阶段' : undefined}
        />
        <Empty description="合同编号无效" />
      </div>
    )
  }

  if (isCloud && loading) {
    return (
      <div>
        <PageHeader title="合同详情" subtitle="CloudBase PostgreSQL · 只读阶段" />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Loading text="加载中..." />
        </div>
      </div>
    )
  }

  if (isCloud && error) {
    return (
      <div>
        <PageHeader title="合同详情" subtitle="CloudBase PostgreSQL · 只读阶段" />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px',
            border: '1px solid var(--snowpeak-border)',
            borderRadius: 8,
            color: 'var(--snowpeak-danger)',
            fontSize: 13,
          }}
        >
          <span>{error}</span>
          <Button size="small" variant="outline" onClick={retry}>
            重试
          </Button>
        </div>
      </div>
    )
  }

  if (notFound || !contract) {
    return (
      <div>
        <PageHeader
          title="合同详情"
          subtitle={isCloud ? 'CloudBase PostgreSQL · 只读阶段' : undefined}
        />
        <Empty description="合同不存在或已被删除" />
      </div>
    )
  }

  const openExchange = (line: ContractLineView) => {
    setExchangeLine(line)
    setNewItemId(undefined)
    setReturnStoreId(line.checkout_store_id)
    setChangeDate(today())
    setExchangeError({})
    setExchangeVisible(true)
  }

  const handleExchange = () => {
    if (exchangeSubmitting || !role || !exchangeLine) return
    setExchangeSubmitting(true)
    const result = dataService.exchangeItem(role, {
      contract_id: contract.contract_id,
      old_line_id: exchangeLine.contract_line_id,
      new_item_id: newItemId as number,
      return_store_id: returnStoreId as number,
      change_date: changeDate,
    })
    setExchangeSubmitting(false)

    if (result.ok) {
      const d = result.data.amount_delta
      MessagePlugin.success(d >= 0 ? `换货完成，补收 ${formatMoney(d)}` : `换货完成，退款 ${formatMoney(-d)}`)
      setExchangeVisible(false)
    } else {
      if (result.field) setExchangeError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const openReturn = (lineIds: number[]) => {
    setReturnLineIds(lineIds)
    const first = lines.find((l) => lineIds.includes(l.line.contract_line_id))
    setReturnStoreId2(first?.line.checkout_store_id ?? undefined)
    setReturnError({})
    setReturnVisible(true)
  }

  const handleReturn = () => {
    if (returnSubmitting || !role) return
    setReturnSubmitting(true)
    const result = dataService.returnItems(role, {
      contract_id: contract.contract_id,
      line_ids: returnLineIds,
      return_store_id: returnStoreId2 as number,
    })
    setReturnSubmitting(false)

    if (result.ok) {
      MessagePlugin.success(result.data.contract.status === '已完成' ? '全部归还，合同已完成' : '归还成功')
      setReturnVisible(false)
    } else {
      if (result.field) setReturnError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const lineColumns: PrimaryTableCol<LineRow>[] = [
    {
      colKey: 'item_code',
      title: '库存编号',
      width: 110,
      className: 'font-mono',
      cell: ({ row }) => row.item?.item_code ?? '—',
    },
    { colKey: 'name', title: '设备名称', width: 180, ellipsis: true, cell: ({ row }) => row.item?.name ?? '—' },
    {
      colKey: 'daily_rate',
      title: '日租金',
      width: 100,
      cell: ({ row }) => <span className="num">{formatMoney(row.line.daily_rate)}</span>,
    },
    { colKey: 'quantity', title: '数量', width: 70, cell: () => '1' },
    { colKey: 'checkout', title: '借出', width: 150, cell: ({ row }) => `${formatDateTime(row.line.checkout_time)} · ${row.checkout_store_name}` },
    {
      colKey: 'return',
      title: '归还',
      width: 150,
      cell: ({ row }) =>
        row.line.return_time ? `${formatDateTime(row.line.return_time)} · ${row.return_store_name}` : '—',
    },
    {
      colKey: 'status',
      title: '状态',
      width: 90,
      cell: ({ row }) => <StatusTag status={row.line.status} />,
    },
    // 操作列仅在 local 模式存在（cloud 只读，隐藏换货/单件归还）
    ...(isCloud
      ? []
      : [
          {
            colKey: 'op',
            title: '操作',
            width: 130,
            fixed: 'right' as const,
            cell: ({ row }: { row: LineRow }) => {
              if (row.line.status !== '借出中' || isCompleted) return null
              return (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <Button size="small" variant="text" theme="primary" onClick={() => openExchange(row.line)}>
                    换货
                  </Button>
                  <Popconfirm
                    content="确认归还该设备？"
                    confirmBtn={{ content: '归还', theme: 'primary' }}
                    onConfirm={() => openReturn([row.line.contract_line_id])}
                  >
                    <Button size="small" variant="text" theme="primary">
                      归还
                    </Button>
                  </Popconfirm>
                </div>
              )
            },
          },
        ]),
  ]

  const lineRows: LineRow[] = lines.map((l) => ({
    item: l.item,
    line: l.line,
    checkout_store_name: storeName(l.line.checkout_store_id),
    return_store_name: storeName(l.line.return_store_id),
  }))

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button variant="text" icon={<ChevronLeftIcon />} onClick={() => navigate('/contracts')}>
          返回合同列表
        </Button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <PageHeader
          title={`合同 ${contract.contract_no}`}
          subtitle={isCloud ? 'CloudBase PostgreSQL · 只读阶段' : '查看明细、执行换货与归还'}
        />
        <StatusTag status={contract.status} />
      </div>

      {/* 概要 */}
      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <Descriptions column={3} colon>
          <Descriptions.DescriptionsItem label="客户">{detail?.customer?.full_name ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="经办员工">{detail?.employee?.full_name ?? '—'}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="合同日期">{contract.contract_date}</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="租赁天数">{contract.duration_days} 天</Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="应收总额">
            <span className="num">{formatMoney(contract.total_amount)}</span>
          </Descriptions.DescriptionsItem>
          <Descriptions.DescriptionsItem label="完成时间">
            {contract.completed_at ? formatDateTime(contract.completed_at) : '—'}
          </Descriptions.DescriptionsItem>
        </Descriptions>
      </div>

      {/* 明细 */}
      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--snowpeak-border)' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>合同明细</span>
          {!isCloud && !isCompleted && activeLines.length > 0 && (
            <Button size="small" variant="outline" onClick={() => openReturn(activeLines.map((l) => l.line.contract_line_id))}>
              批量归还（{activeLines.length}）
            </Button>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <Table data={lineRows} columns={lineColumns} rowKey="line.contract_line_id" size="small" hover tableLayout="fixed" />
        </div>
      </div>

      {/* 变更记录时间线 */}
      <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>变更记录</div>
        {groupedChanges.length === 0 ? (
          <Empty description="暂无变更记录" />
        ) : (
          <Timeline>
            {groupedChanges.map(([, group]) => {
              const returnRec = group.find((c) => c.change_type === '归还')
              const addRec = group.find((c) => c.change_type === '增加')
              const delta = returnRec?.amount_delta ?? null
              const isExchange = Boolean(returnRec && addRec)
              return (
                <Timeline.Item
                  key={group[0].change_id}
                  label={formatDateTime(group[0].change_date)}
                  dotColor={
                    isExchange
                      ? delta !== null && delta < 0
                        ? 'var(--snowpeak-danger)'
                        : 'var(--snowpeak-accent)'
                      : 'var(--snowpeak-success)'
                  }
                >
                  {isExchange ? (
                    <div style={{ fontSize: 13 }}>
                      <div>
                        换货：{returnRec?.item_id !== null && addRec?.item_id !== null ? `#${returnRec?.item_id} → #${addRec?.item_id}` : '—'}
                      </div>
                      <div style={{ color: 'var(--snowpeak-text-secondary)' }}>
                        {delta !== null ? (
                          delta >= 0 ? (
                            <span>
                              补收 <span className="num">{formatMoney(delta)}</span>
                            </span>
                          ) : (
                            <span style={{ color: 'var(--snowpeak-danger)' }}>
                              退款 <span className="num negative">{formatMoney(delta)}</span>
                            </span>
                          )
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13 }}>{group[0].change_type === '归还' ? '归还' : '增加'}</div>
                  )}
                </Timeline.Item>
              )
            })}
          </Timeline>
        )}
      </div>

      {/* 换货 / 归还 Dialog —— 仅 local 模式 */}
      {!isCloud && (
        <>
          <Dialog
            visible={exchangeVisible}
            header="换货"
            width={520}
            confirmBtn={{ content: '确认换货', theme: 'primary', loading: exchangeSubmitting }}
            cancelBtn="取消"
            onConfirm={handleExchange}
            onClose={() => setExchangeVisible(false)}
          >
            <div style={{ padding: '8px 0' }}>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>旧设备（只读）</label>
                <div style={{ fontSize: 13 }}>
                  {exchangeOldItem ? `${exchangeOldItem.item_code} · ${exchangeOldItem.name}（日租金 ${formatMoney(exchangeLine?.daily_rate ?? exchangeOldItem.daily_rate)}）` : '—'}
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>
                  新设备 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Select
                  value={newItemId}
                  onChange={(v) => setNewItemId(v === '' ? undefined : Number(v))}
                  placeholder="选择在库设备（不含本合同已有设备）"
                  filterable
                  options={exchangeCandidates.map((i) => ({
                    label: `${i.item_code} · ${i.name}（${formatMoney(i.daily_rate)}）`,
                    value: i.item_id,
                  }))}
                  status={exchangeError.new_item_id ? 'error' : 'default'}
                  tips={exchangeError.new_item_id}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabel}>
                    归还门店 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <Select
                    value={returnStoreId}
                    onChange={(v) => setReturnStoreId(v === '' ? undefined : Number(v))}
                    options={stores.map((s) => ({ label: s.store_name, value: s.store_id }))}
                    status={exchangeError.return_store_id ? 'error' : 'default'}
                    tips={exchangeError.return_store_id}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabel}>
                    换货日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                  </label>
                  <DatePicker
                    value={changeDate}
                    onChange={(v) => setChangeDate(v ? String(v) : '')}
                    disableDate={(date) => {
                      const dt = new Date(date as Date)
                      const p = (n: number) => String(n).padStart(2, '0')
                      const ymd = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
                      return ymd !== today()
                    }}
                    status={exchangeError.change_date ? 'error' : 'default'}
                    tips={exchangeError.change_date}
                    style={{ width: '100%' }}
                  />
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--snowpeak-text-placeholder)' }}>
                    换货按实际操作时间记录，仅允许选择今天
                  </div>
                </div>
              </div>
              <div style={{ background: 'var(--snowpeak-bg-page)', border: '1px solid var(--snowpeak-border)', borderRadius: 6, padding: 12, fontSize: 13 }}>
                {exchangePreview ? (
                  <>
                    <div>剩余天数：{exchangePreview.remaining} 天</div>
                    <div style={{ marginTop: 4 }}>
                      预估差价：
                      {exchangePreview.delta >= 0 ? (
                        <span className="num" style={{ color: 'var(--snowpeak-success)' }}>
                          补收 {formatMoney(exchangePreview.delta)}
                        </span>
                      ) : (
                        <span className="num negative" style={{ color: 'var(--snowpeak-danger)' }}>
                          退款 {formatMoney(exchangePreview.delta)}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 4, color: 'var(--snowpeak-text-placeholder)' }}>最终金额以系统复核为准</div>
                  </>
                ) : (
                  <span style={{ color: 'var(--snowpeak-text-placeholder)' }}>选择新设备与有效日期后显示差价预估</span>
                )}
              </div>
            </div>
          </Dialog>

          <Dialog
            visible={returnVisible}
            header="归还"
            width={520}
            confirmBtn={{ content: '确认归还', theme: 'primary', loading: returnSubmitting }}
            cancelBtn="取消"
            onConfirm={handleReturn}
            onClose={() => setReturnVisible(false)}
          >
            <div style={{ padding: '8px 0' }}>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>待归还明细（{returnLineIds.length} 件）</label>
                <div style={{ fontSize: 13 }}>
                  {returnLineIds.map((lid) => {
                    const l = lines.find((x) => x.line.contract_line_id === lid)
                    return l ? (
                      <div key={lid} style={{ padding: '4px 0' }}>
                        <Tag variant="light" style={{ marginRight: 8, background: 'var(--snowpeak-accent-subtle)', color: 'var(--snowpeak-accent)', borderColor: 'transparent' }}>
                          {l.item?.item_code ?? '—'}
                        </Tag>
                        {l.item?.name ?? '—'}
                      </div>
                    ) : null
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label style={fieldLabel}>
                  归还门店 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span>
                </label>
                <Select
                  value={returnStoreId2}
                  onChange={(v) => setReturnStoreId2(v === '' ? undefined : Number(v))}
                  options={stores.map((s) => ({ label: s.store_name, value: s.store_id }))}
                  status={returnError.return_store_id ? 'error' : 'default'}
                  tips={returnError.return_store_id}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </Dialog>
        </>
      )}
    </div>
  )
}
