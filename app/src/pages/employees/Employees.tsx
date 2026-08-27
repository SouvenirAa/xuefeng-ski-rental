import { useMemo, useState } from 'react'
import {
  Button,
  DatePicker,
  Dialog,
  Input,
  MessagePlugin,
  Popconfirm,
  Select,
  Table,
  Tabs,
  TimePicker,
  type PrimaryTableCol,
} from 'tdesign-react'
import { AddIcon, ChevronLeftIcon, ChevronRightIcon, DeleteIcon, SearchIcon } from 'tdesign-icons-react'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../auth/AuthContext'
import { dataService } from '../../data/dataService'
import type { Employee, EmployeeInput, Shift, ShiftInput } from '../../data/types'
import { usePagination } from '../../hooks/usePagination'
import { useDbData } from '../../hooks/useDbData'

interface EmployeeFormState {
  full_name: string
  address: string
  phone: string
  email: string
  notes: string
}

const emptyEmployeeForm: EmployeeFormState = { full_name: '', address: '', phone: '', email: '', notes: '' }

interface ShiftFormState {
  employee_id: number | undefined
  store_id: number | undefined
  work_date: string
  start_time: string
  end_time: string
}

const emptyShiftForm: ShiftFormState = { employee_id: undefined, store_id: undefined, work_date: '', start_time: '08:00', end_time: '16:00' }

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

function toEmployeeInput(f: EmployeeFormState): EmployeeInput {
  return { full_name: f.full_name, address: f.address, phone: f.phone, email: f.email, notes: f.notes }
}

/** Date → YYYY-MM-DD */
function toDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 日期字符串 + 偏移天数 → YYYY-MM-DD */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

/** 所在周的周一（周一为一周起点） */
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  const day = d.getDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return toDateStr(d)
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function Employees() {
  const { role } = useAuth()
  const [tab, setTab] = useState('employees')

  // 员工
  const [keyword, setKeyword] = useState('')
  const [empFormVisible, setEmpFormVisible] = useState(false)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null)
  const [empForm, setEmpForm] = useState<EmployeeFormState>(emptyEmployeeForm)
  const [empFieldError, setEmpFieldError] = useState<Record<string, string>>({})
  const [submittingEmployee, setSubmittingEmployee] = useState(false)

  // 排班
  const [weekAnchor, setWeekAnchor] = useState(() => mondayOf(toDateStr(new Date())))
  const [filterStore, setFilterStore] = useState<string>('')
  const [shiftFormVisible, setShiftFormVisible] = useState(false)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)
  const [shiftForm, setShiftForm] = useState<ShiftFormState>(emptyShiftForm)
  const [shiftFieldError, setShiftFieldError] = useState<Record<string, string>>({})
  const [submittingShift, setSubmittingShift] = useState(false)

  const employees = useDbData(() => dataService.listEmployees())
  const stores = useDbData(() => dataService.listStores())
  const shifts = useDbData(() => dataService.listShifts())

  const storeName = (id: number) => stores.find((s) => s.store_id === id)?.store_name ?? `#${id}`

  // ---- 员工列表 ----
  const filteredEmployees = useMemo(() => {
    if (!keyword.trim()) return employees
    return employees.filter((e) =>
      `${e.full_name} ${e.phone} ${e.email}`.toLowerCase().includes(keyword.trim().toLowerCase()),
    )
  }, [employees, keyword])
  const { page, pageSize, setPage, setPageSize, paged, total } = usePagination(filteredEmployees, 10)

  const openCreateEmployee = () => {
    setEditingEmployee(null)
    setEmpForm(emptyEmployeeForm)
    setEmpFieldError({})
    setEmpFormVisible(true)
  }

  const openEditEmployee = (e: Employee) => {
    setEditingEmployee(e)
    setEmpForm({ full_name: e.full_name, address: e.address, phone: e.phone, email: e.email, notes: e.notes ?? '' })
    setEmpFieldError({})
    setEmpFormVisible(true)
  }

  const handleSaveEmployee = () => {
    if (submittingEmployee || !role) return
    setSubmittingEmployee(true)
    const result = editingEmployee
      ? dataService.updateEmployee(role, editingEmployee.employee_id, toEmployeeInput(empForm))
      : dataService.createEmployee(role, toEmployeeInput(empForm))
    setSubmittingEmployee(false)

    if (result.ok) {
      MessagePlugin.success(editingEmployee ? '员工已更新' : '员工已新增')
      setEmpFormVisible(false)
    } else {
      if (result.field) setEmpFieldError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const handleDeleteEmployee = (e: Employee) => {
    if (!role) return
    const result = dataService.removeEmployee(role, e.employee_id)
    if (result.ok) MessagePlugin.success('员工已删除')
    else MessagePlugin.error(result.error)
  }

  const employeeColumns: PrimaryTableCol<Employee>[] = [
    { colKey: 'full_name', title: '姓名', width: 140 },
    { colKey: 'phone', title: '电话', width: 140 },
    { colKey: 'email', title: '邮箱', ellipsis: true },
    { colKey: 'notes', title: '备注', ellipsis: true },
    {
      colKey: 'op',
      title: '操作',
      width: 130,
      fixed: 'right',
      cell: ({ row }) => (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Button size="small" variant="text" theme="primary" onClick={() => openEditEmployee(row)}>
            编辑
          </Button>
          <Popconfirm
            content="删除后该员工记录将不可恢复，确认删除？"
            confirmBtn={{ content: '删除', theme: 'danger' }}
            onConfirm={() => handleDeleteEmployee(row)}
          >
            <Button size="small" variant="text" theme="danger">
              删除
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  // ---- 排班周视图 ----
  const weekDays = useMemo(() => {
    const days: string[] = []
    for (let i = 0; i < 7; i++) days.push(addDays(weekAnchor, i))
    return days
  }, [weekAnchor])

  const shiftOf = (employeeId: number, date: string): Shift | undefined => {
    return shifts.find((s) => s.employee_id === employeeId && s.work_date === date)
  }

  const goPrevWeek = () => setWeekAnchor((w) => addDays(w, -7))
  const goNextWeek = () => setWeekAnchor((w) => addDays(w, 7))
  const goThisWeek = () => setWeekAnchor(mondayOf(toDateStr(new Date())))

  const openCreateShift = (employeeId: number, date: string) => {
    setEditingShift(null)
    setShiftForm({ employee_id: employeeId, store_id: undefined, work_date: date, start_time: '08:00', end_time: '16:00' })
    setShiftFieldError({})
    setShiftFormVisible(true)
  }

  const openEditShift = (s: Shift) => {
    setEditingShift(s)
    setShiftForm({ employee_id: s.employee_id, store_id: s.store_id, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time })
    setShiftFieldError({})
    setShiftFormVisible(true)
  }

  const handleSaveShift = () => {
    if (submittingShift || !role) return
    setSubmittingShift(true)
    const input: ShiftInput = {
      employee_id: shiftForm.employee_id as number,
      store_id: shiftForm.store_id as number,
      work_date: shiftForm.work_date,
      start_time: shiftForm.start_time,
      end_time: shiftForm.end_time,
    }
    const result = editingShift
      ? dataService.updateShift(role, editingShift.shift_id, input)
      : dataService.createShift(role, input)
    setSubmittingShift(false)

    if (result.ok) {
      MessagePlugin.success(editingShift ? '排班已更新' : '排班已新增')
      setShiftFormVisible(false)
    } else {
      if (result.field) setShiftFieldError({ [result.field]: result.error })
      else MessagePlugin.error(result.error)
    }
  }

  const handleDeleteShift = (s: Shift) => {
    if (!role) return
    const result = dataService.removeShift(role, s.shift_id)
    if (result.ok) MessagePlugin.success('排班已删除')
    else MessagePlugin.error(result.error)
  }

  return (
    <div>
      <PageHeader title="员工与排班" subtitle="维护员工信息与跨店排班（仅管理员可访问）" />

      <Tabs value={tab} onChange={(v) => setTab(String(v))}>
        <Tabs.TabPanel value="employees" label="员工管理">
          <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--snowpeak-border)' }}>
              <Input
                value={keyword}
                onChange={(v) => { setKeyword(String(v)); setPage(1) }}
                placeholder="搜索姓名 / 电话 / 邮箱"
                clearable
                prefixIcon={<SearchIcon />}
                style={{ width: 280 }}
              />
              <Button theme="primary" icon={<AddIcon />} onClick={openCreateEmployee}>
                新增员工
              </Button>
            </div>
            <Table
              data={paged.items}
              columns={employeeColumns}
              rowKey="employee_id"
              size="small"
              hover
              tableLayout="fixed"
              empty={keyword.trim() ? '未找到匹配的员工' : '暂无员工，点击右上角「新增员工」录入'}
              pagination={{
                current: page,
                pageSize,
                total,
                showJumper: true,
                onChange: (info) => { setPage(info.current); setPageSize(info.pageSize) },
              }}
            />
          </div>
        </Tabs.TabPanel>

        <Tabs.TabPanel value="shifts" label="员工排班">
          <div style={{ background: 'var(--snowpeak-bg-container)', border: '1px solid var(--snowpeak-border)', borderRadius: 8, padding: 16 }}>
            {/* 周导航 + 门店筛选 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <Button variant="outline" icon={<ChevronLeftIcon />} onClick={goPrevWeek}>
                上一周
              </Button>
              <Button variant="outline" onClick={goThisWeek}>
                本周
              </Button>
              <Button variant="outline" onClick={goNextWeek}>
                下一周
                <ChevronRightIcon />
              </Button>
              <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 8 }}>
                {weekDays[0]} ~ {weekDays[6]}
              </span>
              <div style={{ flex: 1 }} />
              <Select
                value={filterStore}
                onChange={(v) => setFilterStore(String(v ?? ''))}
                placeholder="门店筛选"
                clearable
                options={stores.map((s) => ({ label: s.store_name, value: String(s.store_id) }))}
                style={{ width: 160 }}
              />
            </div>

            {/* 周视图表格：行=员工，列=7 天 */}
            <div style={{ overflowX: 'auto' }}>
              <Table
                data={employees}
                rowKey="employee_id"
                size="small"
                hover
                bordered
                tableLayout="fixed"
                columns={[
                  {
                    colKey: 'full_name',
                    title: '员工',
                    width: 120,
                    fixed: 'left',
                    cell: ({ row }) => <span style={{ fontWeight: 600 }}>{row.full_name}</span>,
                  },
                  ...weekDays.map((date, idx) => ({
                    colKey: `day-${idx}`,
                    title: `${date.slice(5)} ${WEEKDAY_LABELS[idx]}`,
                    width: 150,
                    cell: ({ row }: { row: Employee }) => {
                      const shift = shiftOf(row.employee_id, date)
                      if (shift) {
                        const inFilter = !filterStore || String(shift.store_id) === filterStore
                        if (!inFilter) {
                          return (
                            <span style={{ fontSize: 12, color: 'var(--snowpeak-text-placeholder)' }}>
                              已在别店排班
                            </span>
                          )
                        }
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <div
                              style={{
                                flex: 1,
                                minWidth: 0,
                                background: 'var(--snowpeak-primary-subtle)',
                                color: 'var(--snowpeak-primary)',
                                borderRadius: 4,
                                padding: '4px 8px',
                                fontSize: 12,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                              onClick={() => openEditShift(shift)}
                              title={`${storeName(shift.store_id)} ${shift.start_time}-${shift.end_time}`}
                            >
                              {storeName(shift.store_id)} {shift.start_time}-{shift.end_time}
                            </div>
                            <Popconfirm
                              content={`确认删除${row.full_name} ${shift.work_date} ${shift.start_time}–${shift.end_time} 的排班？`}
                              confirmBtn={{ content: '删除', theme: 'danger' }}
                              onConfirm={() => handleDeleteShift(shift)}
                            >
                              <Button
                                size="small"
                                variant="text"
                                theme="danger"
                                icon={<DeleteIcon />}
                                aria-label="删除排班"
                              />
                            </Popconfirm>
                          </div>
                        )
                      }
                      return (
                        <Button
                          size="small"
                          variant="text"
                          theme="primary"
                          icon={<AddIcon />}
                          onClick={() => openCreateShift(row.employee_id, date)}
                        >
                          排班
                        </Button>
                      )
                    },
                  })),
                ]}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--snowpeak-text-placeholder)' }}>
              点击排班卡片可编辑；点击单元格「排班」可为该员工在当天新增班次（08:00–22:00，同员工同日仅一个班次）。
            </div>
          </div>
        </Tabs.TabPanel>
      </Tabs>

      {/* 员工表单 Dialog */}
      <Dialog
        visible={empFormVisible}
        header={editingEmployee ? '编辑员工' : '新增员工'}
        width={480}
        confirmBtn={{ content: '保存', theme: 'primary', loading: submittingEmployee }}
        cancelBtn="取消"
        onConfirm={handleSaveEmployee}
        onClose={() => setEmpFormVisible(false)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>姓名 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <Input value={empForm.full_name} onChange={(v) => setEmpForm((p) => ({ ...p, full_name: String(v) }))} placeholder="请输入姓名" status={empFieldError.full_name ? 'error' : 'default'} tips={empFieldError.full_name} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>电话</label>
            <Input value={empForm.phone} onChange={(v) => setEmpForm((p) => ({ ...p, phone: String(v) }))} placeholder="选填" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>邮箱</label>
            <Input value={empForm.email} onChange={(v) => setEmpForm((p) => ({ ...p, email: String(v) }))} placeholder="选填" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>地址</label>
            <Input value={empForm.address} onChange={(v) => setEmpForm((p) => ({ ...p, address: String(v) }))} placeholder="选填" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>备注</label>
            <Input value={empForm.notes} onChange={(v) => setEmpForm((p) => ({ ...p, notes: String(v) }))} placeholder="选填，如特长" />
          </div>
        </div>
      </Dialog>

      {/* 排班表单 Dialog */}
      <Dialog
        visible={shiftFormVisible}
        header={editingShift ? '编辑排班' : '新增排班'}
        width={480}
        confirmBtn={{ content: '保存', theme: 'primary', loading: submittingShift }}
        cancelBtn="取消"
        onConfirm={handleSaveShift}
        onClose={() => setShiftFormVisible(false)}
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>员工 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <Select
              value={shiftForm.employee_id}
              onChange={(v) => setShiftForm((p) => ({ ...p, employee_id: v === '' ? undefined : Number(v) }))}
              placeholder="请选择员工"
              options={employees.map((e) => ({ label: e.full_name, value: e.employee_id }))}
              status={shiftFieldError.employee_id ? 'error' : 'default'}
              tips={shiftFieldError.employee_id}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>日期 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <DatePicker
              value={shiftForm.work_date || undefined}
              onChange={(v) => setShiftForm((p) => ({ ...p, work_date: v ? String(v) : '' }))}
              placeholder="请选择日期"
              status={shiftFieldError.work_date ? 'error' : 'default'}
              tips={shiftFieldError.work_date}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabel}>门店 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
            <Select
              value={shiftForm.store_id}
              onChange={(v) => setShiftForm((p) => ({ ...p, store_id: v === '' ? undefined : Number(v) }))}
              placeholder="请选择门店"
              options={stores.map((s) => ({ label: s.store_name, value: s.store_id }))}
              status={shiftFieldError.store_id ? 'error' : 'default'}
              tips={shiftFieldError.store_id}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>开始时间 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
              <TimePicker
                value={shiftForm.start_time}
                onChange={(v) => setShiftForm((p) => ({ ...p, start_time: v ? String(v) : '' }))}
                format="HH:mm"
                status={shiftFieldError.start_time ? 'error' : 'default'}
                tips={shiftFieldError.start_time}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabel}>结束时间 <span style={{ color: 'var(--snowpeak-danger)' }}>*</span></label>
              <TimePicker
                value={shiftForm.end_time}
                onChange={(v) => setShiftForm((p) => ({ ...p, end_time: v ? String(v) : '' }))}
                format="HH:mm"
                status={shiftFieldError.end_time ? 'error' : 'default'}
                tips={shiftFieldError.end_time}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
