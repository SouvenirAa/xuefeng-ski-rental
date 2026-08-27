/**
 * 领域类型 —— 对应 docs/02-数据设计.md 的 13 张表。
 * 状态字段使用联合类型（不退回 string）；主键为 number；日期/时间用 ISO 字符串。
 */

export type ID = number

/** 账号角色 */
export type Role = 'admin' | 'staff' | 'contractor'

/** 技能等级名称 */
export type SkillLevelName = '初级' | '中级' | '高级' | '专家+'

/** 设备类别 */
export type ItemCategory = '滑雪板' | '雪靴' | '雪杖' | '单板' | '护目镜' | '头盔'

/** 设备状态 */
export type ItemStatus = '在库' | '借出中' | '维修中' | '已报废'

/** 合同状态 */
export type ContractStatus = '进行中' | '已完成'

/** 合同明细状态 */
export type ContractLineStatus = '借出中' | '已归还' | '已更换'

/** 合同变更类型 */
export type ChangeType = '增加' | '归还'

/** 维修单状态 */
export type RepairStatus = '待维修' | '维修中' | '已完成'

/** 账号 */
export interface Account {
  account_id: ID
  username: string
  password_placeholder: string
  role: Role
  employee_id: ID | null
  contractor_id: ID | null
  enabled: boolean
}

/** 技能等级 */
export interface SkillLevel {
  skill_level_id: ID
  level_name: SkillLevelName
  sort_order: number
}

/** 门店 */
export interface Store {
  store_id: ID
  store_name: string
  address: string
  phone: string
}

/** 客户 */
export interface Customer {
  customer_id: ID
  full_name: string
  address: string
  phone: string
  email: string | null
  birth_year: number | null
  height_cm: number | null
  weight_kg: number | null
  shoe_size: number | null
}

/** 员工 */
export interface Employee {
  employee_id: ID
  full_name: string
  address: string
  phone: string
  email: string
  notes: string | null
}

/** 租赁物品 */
export interface RentalItem {
  item_id: ID
  item_code: string
  name: string
  description: string
  category: ItemCategory
  purchase_date: string
  purchase_cost: number
  retail_price: number
  daily_rate: number
  skill_level_id: ID | null
  home_store_id: ID
  current_store_id: ID
  status: ItemStatus
}

/** 承包商 */
export interface Contractor {
  contractor_id: ID
  name: string
  address: string
  phone: string
  email: string
}

/** 承包商费率历史 */
export interface ContractorRate {
  rate_id: ID
  contractor_id: ID
  effective_date: string
  hourly_rate: number
}

/** 租赁合同（completed_at：进行中为 null，完成时写入） */
export interface RentalContract {
  contract_id: ID
  contract_no: string
  customer_id: ID
  employee_id: ID
  contract_date: string
  duration_days: number
  total_amount: number
  completed_at: string | null
  status: ContractStatus
}

/** 合同明细（单品粒度，quantity 恒为 1） */
export interface ContractLine {
  contract_line_id: ID
  contract_id: ID
  item_id: ID
  quantity: number
  daily_rate: number
  checkout_time: string
  checkout_store_id: ID
  return_time: string | null
  return_store_id: ID | null
  status: ContractLineStatus
}

/** 合同变更记录（换货拆两条，共享 change_group_id） */
export interface ContractChange {
  change_id: ID
  contract_id: ID
  change_group_id: ID | null
  change_date: string
  change_type: ChangeType
  item_id: ID | null
  quantity: number
  amount_delta: number | null
  note: string | null
}

/** 维修单 */
export interface RepairOrder {
  repair_id: ID
  item_id: ID
  contractor_id: ID
  rate_id: ID
  request_date: string
  fault_description: string
  repair_date: string | null
  repair_hours: number | null
  calculated_cost: number | null
  notes: string | null
  status: RepairStatus
}

/** 员工排班 */
export interface Shift {
  shift_id: ID
  employee_id: ID
  store_id: ID
  work_date: string
  start_time: string
  end_time: string
}

/** 数据库整体结构（用于本地持久化） */
export interface Database {
  accounts: Account[]
  skill_levels: SkillLevel[]
  stores: Store[]
  customers: Customer[]
  employees: Employee[]
  rental_items: RentalItem[]
  contractors: Contractor[]
  contractor_rates: ContractorRate[]
  rental_contracts: RentalContract[]
  contract_lines: ContractLine[]
  contract_changes: ContractChange[]
  repair_orders: RepairOrder[]
  shifts: Shift[]
}

/** 写操作统一返回结果：成功带 data，失败带 error 与可选 field（用于字段级提示） */
export type OpResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; field?: string }

/** 客户新增/编辑输入（customer_id 由服务端生成） */
export type CustomerInput = Omit<Customer, 'customer_id'>

/** 门店新增/编辑输入 */
export type StoreInput = Omit<Store, 'store_id'>

/** 设备新增/编辑输入（item_id、status 由服务端控制：新建设备固定"在库"，编辑不改 status） */
export type RentalItemInput = Omit<RentalItem, 'item_id' | 'status'>

/** 承包商新增/编辑输入 */
export type ContractorInput = Omit<Contractor, 'contractor_id'>

/** 承包商费率新增/编辑输入（rate_id、contractor_id 由服务端控制） */
export type ContractorRateInput = Omit<ContractorRate, 'rate_id' | 'contractor_id'>

/** 员工新增/编辑输入 */
export type EmployeeInput = Omit<Employee, 'employee_id'>

/** 员工排班新增/编辑输入 */
export type ShiftInput = Omit<Shift, 'shift_id'>

/** 承包商 + 首条费率的原子创建输入 */
export interface ContractorWithInitialRateInput {
  contractor: ContractorInput
  initialRate: ContractorRateInput
}

/** 创建合同并借出输入（quantity 恒为 1，item_ids 每项一件） */
export interface CreateContractInput {
  customer_id: ID
  contract_date: string
  duration_days: number
  item_ids: ID[]
}

/** 换货输入（change_date 为本地日期 YYYY-MM-DD，变更当天计入新设备剩余天数） */
export interface ExchangeInput {
  contract_id: ID
  old_line_id: ID
  new_item_id: ID
  return_store_id: ID
  change_date: string
}

/** 归还输入（批量归还待归还明细） */
export interface ReturnInput {
  contract_id: ID
  line_ids: ID[]
  return_store_id: ID
}

/** 合同明细详情（明细 + 关联设备 + 借出/归还门店） */
export interface ContractLineDetail {
  line: ContractLine
  item: RentalItem | null
  checkout_store: Store | null
  return_store: Store | null
}

/** 合同详情聚合（供详情页渲染） */
export interface ContractDetail {
  contract: RentalContract
  customer: Customer | null
  employee: Employee | null
  lines: ContractLineDetail[]
  changes: ContractChange[]
}

/** 换货结果 */
export interface ExchangeResult {
  changes: ContractChange[]
  amount_delta: number
}

/** 创建合同结果 */
export interface CreateContractResult {
  contract: RentalContract
  lines: ContractLine[]
}

/** 归还结果 */
export interface ReturnResult {
  contract: RentalContract
  lines: ContractLine[]
}

/** 创建维修单输入（rate_id 由服务层按 request_date 冻结） */
export interface CreateRepairInput {
  item_id: ID
  contractor_id: ID
  request_date: string
  fault_description: string
}

/** 完成维修输入（calculated_cost 由服务层按冻结费率计算） */
export interface CompleteRepairInput {
  repair_date: string
  repair_hours: number
  notes: string
}

/** 维修单详情聚合（供详情 Drawer 渲染） */
export interface RepairDetail {
  repair: RepairOrder
  item: RentalItem | null
  contractor: Contractor | null
  rate: ContractorRate | null
}
