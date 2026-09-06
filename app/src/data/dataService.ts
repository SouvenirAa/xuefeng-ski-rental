import { loadDatabase, resetDatabase, saveDatabase } from './db'
import type {
  Account,
  CompleteRepairInput,
  ContractChange,
  ContractDetail,
  ContractLine,
  Contractor,
  ContractorInput,
  ContractorRate,
  ContractorRateInput,
  ContractorWithInitialRateInput,
  CreateContractInput,
  CreateContractResult,
  CreateRepairInput,
  Customer,
  CustomerInput,
  Database,
  Employee,
  EmployeeInput,
  ExchangeInput,
  ExchangeResult,
  OpResult,
  RepairDetail,
  RepairOrder,
  RentalContract,
  RentalItem,
  RentalItemInput,
  ReturnInput,
  ReturnResult,
  Role,
  Shift,
  ShiftInput,
  SkillLevel,
  Store,
  StoreInput,
} from './types'
import { nextId } from '../utils/id'
import { today } from '../utils/format'

/**
 * DataService —— 数据访问层（单例）。
 * 页面与业务代码只能通过本服务访问数据，不得直接操作 localStorage，也不得直接改内部数据库。
 * 本批次提供：初始化、登录、各表查询（返回副本）、基础资料 + 承包商/费率 + 员工/排班 CRUD（含角色权限、业务校验、外键与引用完整性）、保存、重置。
 * 写操作统一返回 OpResult，失败不留下部分修改；成功后 notify 订阅者触发界面刷新。
 * 权限为教学模拟（UI + 服务层双保险），不构成生产安全边界。
 * 业务方法（建合同/换货/归还/维修等）留待后续批次在此扩展；迁移 CloudBase 时仅替换本层实现。
 */

/** 写操作权限矩阵：实体 → 允许执行写操作（create/update/remove）的角色 */
const WRITE_PERMISSIONS: Record<WriteEntity, Role[]> = {
  customer: ['admin', 'staff'],
  item: ['admin'],
  store: ['admin'],
  contractor: ['admin'],
  contractorRate: ['admin'],
  employee: ['admin'],
  shift: ['admin'],
  contract: ['admin', 'staff'],
  repair: ['admin', 'staff'],
}

type WriteEntity =
  | 'customer'
  | 'item'
  | 'store'
  | 'contractor'
  | 'contractorRate'
  | 'employee'
  | 'shift'
  | 'contract'
  | 'repair'

/** 权限拒绝的统一返回（任何数据修改前返回） */
const PERMISSION_DENIED: ValidationError = { ok: false, error: '无权限执行该操作' }

/** 集中权限判断：无权限返回拒绝结果，有权限返回 null */
function checkWritePermission(actorRole: Role, entity: WriteEntity): ValidationError | null {
  return WRITE_PERMISSIONS[entity].includes(actorRole) ? null : PERMISSION_DENIED
}

class DataService {
  private db: Database | null = null
  private listeners = new Set<() => void>()
  private version = 0

  /** 订阅数据变更（写操作成功或重置后触发）；返回取消订阅函数 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.version++
    this.listeners.forEach((l) => l())
  }

  /** 当前数据版本号（供 useSyncExternalStore 快照） */
  getVersion(): number {
    return this.version
  }

  /** 初始化（幂等）：加载本地库或写入种子；不向调用方暴露内部数据库对象 */
  init(): { ok: true } | { ok: false; reason: 'corrupted' | 'version-mismatch' } {
    if (this.db !== null) {
      return { ok: true }
    }
    const result = loadDatabase()
    if (result.ok) {
      this.db = result.db
      return { ok: true }
    }
    // loadDatabase 的 ok:false 只可能是 corrupted / version-mismatch（empty 会内部初始化）
    return {
      ok: false,
      reason: result.reason === 'version-mismatch' ? 'version-mismatch' : 'corrupted',
    }
  }

  /** 当前库（未初始化则抛错） */
  private get store(): Database {
    if (this.db === null) {
      throw new Error('DataService 尚未初始化')
    }
    return this.db
  }

  /** 持久化当前数据并通知订阅者（仅 DataService 内部使用，外部不得直接 saveDatabase） */
  private commit(): void {
    saveDatabase(this.store)
    this.notify()
  }

  /** 账号列表（深拷贝，避免调用方修改内部账号对象） */
  get accounts(): Account[] {
    return this.db ? clone(this.db.accounts) : []
  }

  /** 调试/检查用完整快照（深拷贝，修改返回值不影响内部数据） */
  getSnapshot(): Database {
    return clone(this.store)
  }

  /** 模拟登录：按用户名 + 占位密码校验，返回账号（副本）；未就绪/禁用/不存在/密码不符返回 null */
  verifyLogin(username: string, password: string): Account | null {
    if (this.db === null) return null
    const account = this.db.accounts.find(
      (a) => a.username === username.trim() && a.enabled,
    )
    if (!account) return null
    if (account.password_placeholder !== password) return null
    return clone(account)
  }

  /** 按用户名查找账号（返回副本） */
  findByUsername(username: string): Account | undefined {
    if (this.db === null) return undefined
    const account = this.db.accounts.find((a) => a.username === username)
    return account ? clone(account) : undefined
  }

  /** 重置演示数据（恢复种子），并通知订阅者（返回副本） */
  reset(): Database {
    this.db = resetDatabase()
    this.notify()
    return clone(this.db)
  }

  // -------------------------------------------------------------------------
  // 查询（返回深拷贝，页面不得借此绕过 DataService 修改内部数据库）
  // -------------------------------------------------------------------------

  listCustomers(): Customer[] {
    return clone(this.store.customers)
  }

  listItems(): RentalItem[] {
    return clone(this.store.rental_items)
  }

  listStores(): Store[] {
    return clone(this.store.stores)
  }

  listSkillLevels(): SkillLevel[] {
    return clone(this.store.skill_levels)
  }

  listContractors(): Contractor[] {
    return clone(this.store.contractors)
  }

  /** 全部费率或指定承包商的费率（返回副本） */
  listContractorRates(contractorId?: number): ContractorRate[] {
    const rates = contractorId === undefined
      ? this.store.contractor_rates
      : this.store.contractor_rates.filter((r) => r.contractor_id === contractorId)
    return clone(rates)
  }

  /**
   * 按生效日期查询承包商在 asOfDate 时的有效费率：
   * 在 effective_date <= asOfDate 的费率中，取 effective_date 最新的一条。
   * 无匹配返回 null。
   */
  getEffectiveContractorRate(contractorId: number, asOfDate: string): ContractorRate | null {
    const candidates = this.store.contractor_rates
      .filter((r) => r.contractor_id === contractorId && r.effective_date <= asOfDate)
      .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))
    return candidates.length > 0 ? clone(candidates[0]) : null
  }

  listEmployees(): Employee[] {
    return clone(this.store.employees)
  }

  listShifts(): Shift[] {
    return clone(this.store.shifts)
  }

  /** 合同列表（返回副本） */
  listContracts(): RentalContract[] {
    return clone(this.store.rental_contracts)
  }

  /**
   * 合同详情聚合：合同 + 客户 + 经办员工 + 明细（含设备/门店）+ 变更记录。
   * 全部返回深拷贝，页面不得借此修改内部数据。
   */
  getContractDetail(contractId: number): ContractDetail | null {
    const contract = this.store.rental_contracts.find((c) => c.contract_id === contractId)
    if (!contract) return null

    const customer = this.store.customers.find((c) => c.customer_id === contract.customer_id) ?? null
    const employee = this.store.employees.find((e) => e.employee_id === contract.employee_id) ?? null

    const lines = this.store.contract_lines
      .filter((l) => l.contract_id === contractId)
      .sort((a, b) => a.contract_line_id - b.contract_line_id)
      .map((line) => ({
        line: clone(line),
        item: this.store.rental_items.find((i) => i.item_id === line.item_id) ?? null,
        checkout_store:
          this.store.stores.find((s) => s.store_id === line.checkout_store_id) ?? null,
        return_store:
          line.return_store_id === null
            ? null
            : this.store.stores.find((s) => s.store_id === line.return_store_id) ?? null,
      }))

    const changes = this.store.contract_changes
      .filter((ch) => ch.contract_id === contractId)
      .sort((a, b) => a.change_id - b.change_id)

    return clone({ contract, customer, employee, lines, changes })
  }

  /** 费率是否被维修单引用（供页面禁用编辑/删除按钮，只读查询） */
  isContractorRateReferenced(rateId: number): boolean {
    return this.store.repair_orders.some((r) => r.rate_id === rateId)
  }

  /**
   * 维修单列表（返回副本）。权限在数据层落实：
   * admin / staff 可见全部；contractor 仅见 contractor_id 与自己关联的单。
   */
  listRepairs(actorRole: Role, contractorId?: number): RepairOrder[] {
    if (actorRole === 'contractor') {
      if (contractorId === undefined) return []
      return clone(this.store.repair_orders.filter((r) => r.contractor_id === contractorId))
    }
    return clone(this.store.repair_orders)
  }

  /** 维修单详情聚合（返回副本）：维修单 + 设备 + 承包商 + 冻结费率 */
  getRepairDetail(repairId: number): RepairDetail | null {
    const repair = this.store.repair_orders.find((r) => r.repair_id === repairId)
    if (!repair) return null
    const item = this.store.rental_items.find((i) => i.item_id === repair.item_id) ?? null
    const contractor = this.store.contractors.find((c) => c.contractor_id === repair.contractor_id) ?? null
    const rate = this.store.contractor_rates.find((r) => r.rate_id === repair.rate_id) ?? null
    return clone({ repair, item, contractor, rate })
  }

  // -------------------------------------------------------------------------
  // 客户 CRUD（admin / staff）
  // -------------------------------------------------------------------------

  createCustomer(actorRole: Role, input: CustomerInput): OpResult<Customer> {
    const denied = checkWritePermission(actorRole, 'customer')
    if (denied) return denied

    const invalid = validateCustomerInput(input, this.store, null)
    if (invalid) return invalid

    const customer: Customer = {
      customer_id: nextId(this.store.customers, (c) => c.customer_id),
      full_name: input.full_name.trim(),
      address: input.address.trim(),
      phone: input.phone.trim(),
      email: normalizeEmail(input.email),
      birth_year: toNullableNumber(input.birth_year),
      height_cm: toNullableNumber(input.height_cm),
      weight_kg: toNullableNumber(input.weight_kg),
      shoe_size: toNullableNumber(input.shoe_size),
    }
    this.store.customers.push(customer)
    this.commit()
    return { ok: true, data: clone(customer) }
  }

  updateCustomer(actorRole: Role, customerId: number, input: CustomerInput): OpResult<Customer> {
    const denied = checkWritePermission(actorRole, 'customer')
    if (denied) return denied

    const existing = this.store.customers.find((c) => c.customer_id === customerId)
    if (!existing) {
      return { ok: false, error: '客户不存在，可能已被删除' }
    }
    const invalid = validateCustomerInput(input, this.store, customerId)
    if (invalid) return invalid

    existing.full_name = input.full_name.trim()
    existing.address = input.address.trim()
    existing.phone = input.phone.trim()
    existing.email = normalizeEmail(input.email)
    existing.birth_year = toNullableNumber(input.birth_year)
    existing.height_cm = toNullableNumber(input.height_cm)
    existing.weight_kg = toNullableNumber(input.weight_kg)
    existing.shoe_size = toNullableNumber(input.shoe_size)
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeCustomer(actorRole: Role, customerId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'customer')
    if (denied) return denied

    const existing = this.store.customers.find((c) => c.customer_id === customerId)
    if (!existing) {
      return { ok: false, error: '客户不存在，可能已被删除' }
    }
    const ref = this.store.rental_contracts.find((c) => c.customer_id === customerId)
    if (ref) {
      return { ok: false, error: `该客户已被合同 ${ref.contract_no} 引用，不可物理删除` }
    }
    this.store.customers = this.store.customers.filter((c) => c.customer_id !== customerId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 设备 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createItem(actorRole: Role, input: RentalItemInput): OpResult<RentalItem> {
    const denied = checkWritePermission(actorRole, 'item')
    if (denied) return denied

    const invalid = validateItemInput(input, this.store, null)
    if (invalid) return invalid

    const item: RentalItem = {
      item_id: nextId(this.store.rental_items, (i) => i.item_id),
      item_code: input.item_code.trim(),
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category,
      purchase_date: input.purchase_date,
      purchase_cost: toNonNegativeNumber(input.purchase_cost),
      retail_price: toNonNegativeNumber(input.retail_price),
      daily_rate: toNonNegativeNumber(input.daily_rate),
      skill_level_id: resolveSkillLevel(input.category, input.skill_level_id),
      home_store_id: input.home_store_id,
      current_store_id: input.current_store_id,
      status: '在库',
    }
    this.store.rental_items.push(item)
    this.commit()
    return { ok: true, data: clone(item) }
  }

  updateItem(actorRole: Role, itemId: number, input: RentalItemInput): OpResult<RentalItem> {
    const denied = checkWritePermission(actorRole, 'item')
    if (denied) return denied

    const existing = this.store.rental_items.find((i) => i.item_id === itemId)
    if (!existing) {
      return { ok: false, error: '设备不存在，可能已被删除' }
    }
    const invalid = validateItemInput(input, this.store, itemId)
    if (invalid) return invalid

    existing.item_code = input.item_code.trim()
    existing.name = input.name.trim()
    existing.description = input.description.trim()
    existing.category = input.category
    existing.purchase_date = input.purchase_date
    existing.purchase_cost = toNonNegativeNumber(input.purchase_cost)
    existing.retail_price = toNonNegativeNumber(input.retail_price)
    existing.daily_rate = toNonNegativeNumber(input.daily_rate)
    existing.skill_level_id = resolveSkillLevel(input.category, input.skill_level_id)
    existing.home_store_id = input.home_store_id
    existing.current_store_id = input.current_store_id
    // status 不允许通过普通编辑表单修改
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeItem(actorRole: Role, itemId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'item')
    if (denied) return denied

    const existing = this.store.rental_items.find((i) => i.item_id === itemId)
    if (!existing) {
      return { ok: false, error: '设备不存在，可能已被删除' }
    }
    if (existing.status !== '在库') {
      return { ok: false, error: `设备当前状态为「${existing.status}」，仅「在库」设备可删除` }
    }
    const lineRef = this.store.contract_lines.find((l) => l.item_id === itemId)
    if (lineRef) {
      return { ok: false, error: '该设备已被合同明细引用，不可删除' }
    }
    const changeRef = this.store.contract_changes.find((c) => c.item_id === itemId)
    if (changeRef) {
      return { ok: false, error: '该设备已被合同变更记录引用，不可删除' }
    }
    const repairRef = this.store.repair_orders.find((r) => r.item_id === itemId)
    if (repairRef) {
      return { ok: false, error: '该设备已被维修单引用，不可删除' }
    }
    this.store.rental_items = this.store.rental_items.filter((i) => i.item_id !== itemId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 门店 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createStore(actorRole: Role, input: StoreInput): OpResult<Store> {
    const denied = checkWritePermission(actorRole, 'store')
    if (denied) return denied

    const invalid = validateStoreInput(input)
    if (invalid) return invalid

    const store: Store = {
      store_id: nextId(this.store.stores, (s) => s.store_id),
      store_name: input.store_name.trim(),
      address: input.address.trim(),
      phone: input.phone.trim(),
    }
    this.store.stores.push(store)
    this.commit()
    return { ok: true, data: clone(store) }
  }

  updateStore(actorRole: Role, storeId: number, input: StoreInput): OpResult<Store> {
    const denied = checkWritePermission(actorRole, 'store')
    if (denied) return denied

    const existing = this.store.stores.find((s) => s.store_id === storeId)
    if (!existing) {
      return { ok: false, error: '门店不存在，可能已被删除' }
    }
    const invalid = validateStoreInput(input)
    if (invalid) return invalid

    existing.store_name = input.store_name.trim()
    existing.address = input.address.trim()
    existing.phone = input.phone.trim()
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeStore(actorRole: Role, storeId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'store')
    if (denied) return denied

    const existing = this.store.stores.find((s) => s.store_id === storeId)
    if (!existing) {
      return { ok: false, error: '门店不存在，可能已被删除' }
    }
    const homeRef = this.store.rental_items.find((i) => i.home_store_id === storeId)
    if (homeRef) {
      return { ok: false, error: `该门店被 ${homeRef.item_code} 等设备的归属门店引用，不可删除` }
    }
    const currentRef = this.store.rental_items.find((i) => i.current_store_id === storeId)
    if (currentRef) {
      return { ok: false, error: `该门店被 ${currentRef.item_code} 等设备的当前门店引用，不可删除` }
    }
    const shiftRef = this.store.shifts.find((s) => s.store_id === storeId)
    if (shiftRef) {
      return { ok: false, error: '该门店被员工排班引用，不可删除' }
    }
    const checkoutRef = this.store.contract_lines.find((l) => l.checkout_store_id === storeId)
    if (checkoutRef) {
      return { ok: false, error: '该门店被合同借出明细引用，不可删除' }
    }
    const returnRef = this.store.contract_lines.find((l) => l.return_store_id === storeId)
    if (returnRef) {
      return { ok: false, error: '该门店被合同归还明细引用，不可删除' }
    }
    this.store.stores = this.store.stores.filter((s) => s.store_id !== storeId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 承包商 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createContractor(actorRole: Role, input: ContractorInput): OpResult<Contractor> {
    const denied = checkWritePermission(actorRole, 'contractor')
    if (denied) return denied

    const invalid = validateContractorInput(input)
    if (invalid) return invalid

    const contractor: Contractor = {
      contractor_id: nextId(this.store.contractors, (c) => c.contractor_id),
      name: input.name.trim(),
      address: input.address.trim(),
      phone: input.phone.trim(),
      email: input.email.trim(),
    }
    this.store.contractors.push(contractor)
    this.commit()
    return { ok: true, data: clone(contractor) }
  }

  /**
   * 原子创建承包商 + 首条费率：任一字段失败时两张表均不写入，version 不增加。
   */
  createContractorWithInitialRate(
    actorRole: Role,
    input: ContractorWithInitialRateInput,
  ): OpResult<{ contractor: Contractor; rate: ContractorRate }> {
    const denied = checkWritePermission(actorRole, 'contractor')
    if (denied) return denied

    // 先完整校验承包商与费率（不写入）
    const contractorInvalid = validateContractorInput(input.contractor)
    if (contractorInvalid) return contractorInvalid

    const contractorId = nextId(this.store.contractors, (c) => c.contractor_id)
    const rateInvalid = validateContractorRateInput(input.initialRate, this.store, contractorId, null)
    if (rateInvalid) return rateInvalid

    // 全部通过后一次性写入
    const contractor: Contractor = {
      contractor_id: contractorId,
      name: input.contractor.name.trim(),
      address: input.contractor.address.trim(),
      phone: input.contractor.phone.trim(),
      email: input.contractor.email.trim(),
    }
    const rate: ContractorRate = {
      rate_id: nextId(this.store.contractor_rates, (r) => r.rate_id),
      contractor_id: contractorId,
      effective_date: input.initialRate.effective_date,
      hourly_rate: input.initialRate.hourly_rate,
    }
    this.store.contractors.push(contractor)
    this.store.contractor_rates.push(rate)
    this.commit()
    return { ok: true, data: { contractor: clone(contractor), rate: clone(rate) } }
  }

  updateContractor(actorRole: Role, contractorId: number, input: ContractorInput): OpResult<Contractor> {
    const denied = checkWritePermission(actorRole, 'contractor')
    if (denied) return denied

    const existing = this.store.contractors.find((c) => c.contractor_id === contractorId)
    if (!existing) {
      return { ok: false, error: '承包商不存在，可能已被删除' }
    }
    const invalid = validateContractorInput(input)
    if (invalid) return invalid

    existing.name = input.name.trim()
    existing.address = input.address.trim()
    existing.phone = input.phone.trim()
    existing.email = input.email.trim()
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeContractor(actorRole: Role, contractorId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'contractor')
    if (denied) return denied

    const existing = this.store.contractors.find((c) => c.contractor_id === contractorId)
    if (!existing) {
      return { ok: false, error: '承包商不存在，可能已被删除' }
    }
    const accountRef = this.store.accounts.find((a) => a.contractor_id === contractorId)
    if (accountRef) {
      return { ok: false, error: `该承包商被账号 ${accountRef.username} 引用，不可删除` }
    }
    const rateRef = this.store.contractor_rates.find((r) => r.contractor_id === contractorId)
    if (rateRef) {
      return { ok: false, error: '该承包商存在费率记录，不可删除' }
    }
    const repairRef = this.store.repair_orders.find((r) => r.contractor_id === contractorId)
    if (repairRef) {
      return { ok: false, error: '该承包商被维修单引用，不可删除' }
    }
    this.store.contractors = this.store.contractors.filter((c) => c.contractor_id !== contractorId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 承包商费率 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createContractorRate(actorRole: Role, contractorId: number, input: ContractorRateInput): OpResult<ContractorRate> {
    const denied = checkWritePermission(actorRole, 'contractorRate')
    if (denied) return denied

    if (!this.store.contractors.some((c) => c.contractor_id === contractorId)) {
      return { ok: false, error: '承包商不存在', field: 'contractor_id' }
    }
    const invalid = validateContractorRateInput(input, this.store, contractorId, null)
    if (invalid) return invalid

    const rate: ContractorRate = {
      rate_id: nextId(this.store.contractor_rates, (r) => r.rate_id),
      contractor_id: contractorId,
      effective_date: input.effective_date,
      hourly_rate: input.hourly_rate,
    }
    this.store.contractor_rates.push(rate)
    this.commit()
    return { ok: true, data: clone(rate) }
  }

  updateContractorRate(actorRole: Role, rateId: number, input: ContractorRateInput): OpResult<ContractorRate> {
    const denied = checkWritePermission(actorRole, 'contractorRate')
    if (denied) return denied

    const existing = this.store.contractor_rates.find((r) => r.rate_id === rateId)
    if (!existing) {
      return { ok: false, error: '费率不存在，可能已被删除' }
    }
    const repairRef = this.store.repair_orders.find((r) => r.rate_id === rateId)
    if (repairRef) {
      return { ok: false, error: '该费率已被维修单引用，不可修改' }
    }
    const invalid = validateContractorRateInput(input, this.store, existing.contractor_id, rateId)
    if (invalid) return invalid

    existing.effective_date = input.effective_date
    existing.hourly_rate = input.hourly_rate
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeContractorRate(actorRole: Role, rateId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'contractorRate')
    if (denied) return denied

    const existing = this.store.contractor_rates.find((r) => r.rate_id === rateId)
    if (!existing) {
      return { ok: false, error: '费率不存在，可能已被删除' }
    }
    const repairRef = this.store.repair_orders.find((r) => r.rate_id === rateId)
    if (repairRef) {
      return { ok: false, error: '该费率已被维修单引用，不可删除' }
    }
    this.store.contractor_rates = this.store.contractor_rates.filter((r) => r.rate_id !== rateId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 员工 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createEmployee(actorRole: Role, input: EmployeeInput): OpResult<Employee> {
    const denied = checkWritePermission(actorRole, 'employee')
    if (denied) return denied

    const invalid = validateEmployeeInput(input)
    if (invalid) return invalid

    const employee: Employee = {
      employee_id: nextId(this.store.employees, (e) => e.employee_id),
      full_name: input.full_name.trim(),
      address: input.address.trim(),
      phone: input.phone.trim(),
      email: input.email.trim(),
      notes: input.notes === null ? null : input.notes.trim() === '' ? null : input.notes.trim(),
    }
    this.store.employees.push(employee)
    this.commit()
    return { ok: true, data: clone(employee) }
  }

  updateEmployee(actorRole: Role, employeeId: number, input: EmployeeInput): OpResult<Employee> {
    const denied = checkWritePermission(actorRole, 'employee')
    if (denied) return denied

    const existing = this.store.employees.find((e) => e.employee_id === employeeId)
    if (!existing) {
      return { ok: false, error: '员工不存在，可能已被删除' }
    }
    const invalid = validateEmployeeInput(input)
    if (invalid) return invalid

    existing.full_name = input.full_name.trim()
    existing.address = input.address.trim()
    existing.phone = input.phone.trim()
    existing.email = input.email.trim()
    existing.notes = input.notes === null ? null : input.notes.trim() === '' ? null : input.notes.trim()
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeEmployee(actorRole: Role, employeeId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'employee')
    if (denied) return denied

    const existing = this.store.employees.find((e) => e.employee_id === employeeId)
    if (!existing) {
      return { ok: false, error: '员工不存在，可能已被删除' }
    }
    const accountRef = this.store.accounts.find((a) => a.employee_id === employeeId)
    if (accountRef) {
      return { ok: false, error: `该员工被账号 ${accountRef.username} 引用，不可删除` }
    }
    const contractRef = this.store.rental_contracts.find((c) => c.employee_id === employeeId)
    if (contractRef) {
      return { ok: false, error: `该员工被合同 ${contractRef.contract_no} 引用，不可删除` }
    }
    const shiftRef = this.store.shifts.find((s) => s.employee_id === employeeId)
    if (shiftRef) {
      return { ok: false, error: '该员工被排班引用，不可删除' }
    }
    this.store.employees = this.store.employees.filter((e) => e.employee_id !== employeeId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 排班 CRUD（仅 admin）
  // -------------------------------------------------------------------------

  createShift(actorRole: Role, input: ShiftInput): OpResult<Shift> {
    const denied = checkWritePermission(actorRole, 'shift')
    if (denied) return denied

    const invalid = validateShiftInput(input, this.store, null)
    if (invalid) return invalid

    const shift: Shift = {
      shift_id: nextId(this.store.shifts, (s) => s.shift_id),
      employee_id: input.employee_id,
      store_id: input.store_id,
      work_date: input.work_date,
      start_time: input.start_time,
      end_time: input.end_time,
    }
    this.store.shifts.push(shift)
    this.commit()
    return { ok: true, data: clone(shift) }
  }

  updateShift(actorRole: Role, shiftId: number, input: ShiftInput): OpResult<Shift> {
    const denied = checkWritePermission(actorRole, 'shift')
    if (denied) return denied

    const existing = this.store.shifts.find((s) => s.shift_id === shiftId)
    if (!existing) {
      return { ok: false, error: '排班不存在，可能已被删除' }
    }
    const invalid = validateShiftInput(input, this.store, shiftId)
    if (invalid) return invalid

    existing.employee_id = input.employee_id
    existing.store_id = input.store_id
    existing.work_date = input.work_date
    existing.start_time = input.start_time
    existing.end_time = input.end_time
    this.commit()
    return { ok: true, data: clone(existing) }
  }

  removeShift(actorRole: Role, shiftId: number): OpResult {
    const denied = checkWritePermission(actorRole, 'shift')
    if (denied) return denied

    const existing = this.store.shifts.find((s) => s.shift_id === shiftId)
    if (!existing) {
      return { ok: false, error: '排班不存在，可能已被删除' }
    }
    this.store.shifts = this.store.shifts.filter((s) => s.shift_id !== shiftId)
    this.commit()
    return { ok: true, data: undefined }
  }

  // -------------------------------------------------------------------------
  // 合同：创建（借出）/ 换货 / 归还（admin / staff）
  // -------------------------------------------------------------------------

  /**
   * 创建合同并借出（原子）：
   * 生成合同、创建全部明细、记录借出时间/门店、设备状态改「借出中」一次性提交。
   * 经办员工取当前登录账号关联的 employee_id（不允许客户端伪造）。
   * 任一校验失败：合同/明细/设备状态/版本号均不变化。
   */
  createContract(
    actorRole: Role,
    accountEmployeeId: number | null,
    input: CreateContractInput,
    now?: string,
  ): OpResult<CreateContractResult> {
    const denied = checkWritePermission(actorRole, 'contract')
    if (denied) return denied

    if (accountEmployeeId === null) {
      return { ok: false, error: '当前账号未关联员工，无法经办合同' }
    }
    if (!this.store.employees.some((e) => e.employee_id === accountEmployeeId)) {
      return { ok: false, error: '当前账号关联的员工不存在', field: 'employee_id' }
    }

    // 客户外键
    if (!this.store.customers.some((c) => c.customer_id === input.customer_id)) {
      return { ok: false, error: '客户不存在', field: 'customer_id' }
    }
    // 合同日期
    if (!input.contract_date || !isValidDate(input.contract_date)) {
      return { ok: false, error: '合同日期不能为空且须为合法日期', field: 'contract_date' }
    }
    // 租赁天数
    if (!Number.isInteger(input.duration_days) || input.duration_days <= 0) {
      return { ok: false, error: '租赁天数必须为正整数', field: 'duration_days' }
    }
    // 至少一件设备
    if (input.item_ids.length === 0) {
      return { ok: false, error: '请至少选择一件设备', field: 'item_ids' }
    }
    // 重复设备
    if (new Set(input.item_ids).size !== input.item_ids.length) {
      return { ok: false, error: '同一合同不得重复加入相同设备', field: 'item_ids' }
    }

    // 逐项校验设备：存在 + 在库
    for (const itemId of input.item_ids) {
      const item = this.store.rental_items.find((i) => i.item_id === itemId)
      if (!item) {
        return { ok: false, error: `设备 ${itemId} 不存在`, field: 'item_ids' }
      }
      if (item.status !== '在库') {
        return { ok: false, error: `设备 ${item.item_code} 当前状态为「${item.status}」，仅「在库」设备可借出`, field: 'item_ids' }
      }
    }

    // 借出时间校验：不得早于合同日期（防止未来合同日期 + 更早借出时间产生 checkout_time < contract_date）
    const checkoutTime = now ?? localNow()
    if (checkoutTime < input.contract_date) {
      return { ok: false, error: '借出时间不能早于合同日期', field: 'contract_date' }
    }

    // 全部校验通过，一次性写入
    const contractId = nextId(this.store.rental_contracts, (c) => c.contract_id)
    const contractNo = this.nextContractNo(input.contract_date)

    const lines: ContractLine[] = []
    let lineId = nextId(this.store.contract_lines, (l) => l.contract_line_id)
    let total = 0

    for (const itemId of input.item_ids) {
      const item = this.store.rental_items.find((i) => i.item_id === itemId)!
      const line: ContractLine = {
        contract_line_id: lineId++,
        contract_id: contractId,
        item_id: itemId,
        quantity: 1,
        daily_rate: item.daily_rate,
        checkout_time: checkoutTime,
        checkout_store_id: item.current_store_id,
        return_time: null,
        return_store_id: null,
        status: '借出中',
      }
      lines.push(line)
      total += item.daily_rate * input.duration_days
      item.status = '借出中'
    }

    const contract: RentalContract = {
      contract_id: contractId,
      contract_no: contractNo,
      customer_id: input.customer_id,
      employee_id: accountEmployeeId,
      contract_date: input.contract_date,
      duration_days: input.duration_days,
      total_amount: roundMoney(total),
      completed_at: null,
      status: '进行中',
    }

    this.store.rental_contracts.push(contract)
    this.store.contract_lines.push(...lines)
    this.commit()
    return { ok: true, data: { contract: clone(contract), lines: clone(lines) } }
  }

  /**
   * 换货（原子）：旧明细→已更换、新增明细→借出中、两条共享分组的变更记录、
   * 设备状态与门店更新、合同 total_amount 加上独立复算的差价，单次 commit/notify。
   * 差价按合同快照（oldLine.daily_rate / newLine.daily_rate）复算，不信任客户端金额。
   * now 为本地完整时间戳（测试可注入），业务日期 change_date 须与 now 同一天。
   */
  exchangeItem(actorRole: Role, input: ExchangeInput, now?: string): OpResult<ExchangeResult> {
    const denied = checkWritePermission(actorRole, 'contract')
    if (denied) return denied

    const contract = this.store.rental_contracts.find((c) => c.contract_id === input.contract_id)
    if (!contract) {
      return { ok: false, error: '合同不存在', field: 'contract_id' }
    }
    if (contract.status !== '进行中') {
      return { ok: false, error: '仅进行中的合同可换货' }
    }
    if (!input.change_date || !isValidDate(input.change_date)) {
      return { ok: false, error: '换货日期不能为空且须为合法日期', field: 'change_date' }
    }

    // 合同有效期：变更当天计入，remainingDays 必须 > 0
    const elapsedDays = dateDiffDays(contract.contract_date, input.change_date)
    if (elapsedDays < 0) {
      return { ok: false, error: '换货日期不能早于合同日期', field: 'change_date' }
    }
    const remainingDays = contract.duration_days - elapsedDays
    if (remainingDays <= 0) {
      return { ok: false, error: '换货日期超出合同有效期', field: 'change_date' }
    }

    // 旧明细校验
    const oldLine = this.store.contract_lines.find((l) => l.contract_line_id === input.old_line_id)
    if (!oldLine || oldLine.contract_id !== contract.contract_id) {
      return { ok: false, error: '旧明细不存在或不属于该合同', field: 'old_line_id' }
    }
    if (oldLine.status !== '借出中') {
      return { ok: false, error: '仅「借出中」的明细可换货', field: 'old_line_id' }
    }

    // 新设备校验
    const newItem = this.store.rental_items.find((i) => i.item_id === input.new_item_id)
    if (!newItem) {
      return { ok: false, error: '新设备不存在', field: 'new_item_id' }
    }
    if (newItem.status !== '在库') {
      return { ok: false, error: `新设备 ${newItem.item_code} 当前状态为「${newItem.status}」，仅「在库」设备可选`, field: 'new_item_id' }
    }
    if (this.store.contract_lines.some((l) => l.contract_id === contract.contract_id && l.item_id === input.new_item_id)) {
      return { ok: false, error: '新设备已出现在该合同中', field: 'new_item_id' }
    }

    // 归还门店校验
    if (!this.store.stores.some((s) => s.store_id === input.return_store_id)) {
      return { ok: false, error: '归还门店不存在', field: 'return_store_id' }
    }

    // 独立复算差价（BR-08）：(新设备本次固化日租金 − 旧明细合同快照日租金) × 剩余天数
    // 旧明细用 oldLine.daily_rate（借出时固化快照），不受目录价后续调价影响
    const oldItem = this.store.rental_items.find((i) => i.item_id === oldLine.item_id)!
    const newLineDailyRate = newItem.daily_rate
    const amountDelta = roundMoney((newLineDailyRate - oldLine.daily_rate) * remainingDays)

    // 本地完整时间戳：now（测试注入）或当前本地时间
    const changeTimestamp = now ?? localNow()
    // 业务日期须与写入时间戳同一天（remaining 用 change_date 计算，写入用 changeTimestamp）
    if (changeTimestamp.slice(0, 10) !== input.change_date) {
      return { ok: false, error: '换货时间与换货日期不一致', field: 'change_date' }
    }
    // 换货时间必须晚于旧明细借出时间（避免同日换货写出 return_time < checkout_time）
    if (changeTimestamp <= oldLine.checkout_time) {
      return { ok: false, error: '换货时间必须晚于借出时间', field: 'change_date' }
    }

    // 一次性写入
    const firstChangeId = nextId(this.store.contract_changes, (c) => c.change_id)
    const groupId = nextId(this.store.contract_changes, (c) => c.change_group_id ?? 0)
    const note = amountDelta >= 0 ? '升级至更高价款装备' : '更换为更低价位装备（退款）'

    // 1) 旧明细 → 已更换
    oldLine.return_time = changeTimestamp
    oldLine.return_store_id = input.return_store_id
    oldLine.status = '已更换'
    // 2) 旧设备 → 在库，current_store_id 更新为归还门店
    oldItem.status = '在库'
    oldItem.current_store_id = input.return_store_id
    // 3) 新增明细 → 借出中（daily_rate 从 newItem.daily_rate 固化）
    const newLine: ContractLine = {
      contract_line_id: nextId(this.store.contract_lines, (l) => l.contract_line_id),
      contract_id: contract.contract_id,
      item_id: newItem.item_id,
      quantity: 1,
      daily_rate: newLineDailyRate,
      checkout_time: changeTimestamp,
      checkout_store_id: newItem.current_store_id,
      return_time: null,
      return_store_id: null,
      status: '借出中',
    }
    this.store.contract_lines.push(newLine)
    // 4) 新设备 → 借出中
    newItem.status = '借出中'
    // 5) 两条共享分组的变更记录（仅「归还」一条保存 amount_delta；change_id 局部递增避免重复）
    const changes: ContractChange[] = [
      {
        change_id: firstChangeId,
        contract_id: contract.contract_id,
        change_group_id: groupId,
        change_date: changeTimestamp,
        change_type: '归还',
        item_id: oldLine.item_id,
        quantity: 1,
        amount_delta: amountDelta,
        note,
      },
      {
        change_id: firstChangeId + 1,
        contract_id: contract.contract_id,
        change_group_id: groupId,
        change_date: changeTimestamp,
        change_type: '增加',
        item_id: newItem.item_id,
        quantity: 1,
        amount_delta: null,
        note,
      },
    ]
    this.store.contract_changes.push(...changes)
    // 6) 合同 total_amount 加上差价
    contract.total_amount = roundMoney(contract.total_amount + amountDelta)

    this.commit()
    return { ok: true, data: { changes: clone(changes), amount_delta: amountDelta } }
  }

  /**
   * 归还（原子，支持逐条或批量）：
   * 仅「借出中」明细可归还；return_time 晚于 checkout_time；归还门店存在。
   * 设备状态恢复「在库」，current_store_id 更新为归还门店，home_store_id 不变。
   * 全部活动明细归还后合同转「已完成」，写 completed_at 并固化最终总额。
   * 任一明细无效则整批拒绝，零残留。
   */
  returnItems(actorRole: Role, input: ReturnInput, now?: string): OpResult<ReturnResult> {
    const denied = checkWritePermission(actorRole, 'contract')
    if (denied) return denied

    const contract = this.store.rental_contracts.find((c) => c.contract_id === input.contract_id)
    if (!contract) {
      return { ok: false, error: '合同不存在', field: 'contract_id' }
    }
    if (contract.status !== '进行中') {
      return { ok: false, error: '仅进行中的合同可归还' }
    }
    if (input.line_ids.length === 0) {
      return { ok: false, error: '请选择待归还的明细', field: 'line_ids' }
    }
    if (new Set(input.line_ids).size !== input.line_ids.length) {
      return { ok: false, error: '归还明细列表存在重复项', field: 'line_ids' }
    }
    if (!this.store.stores.some((s) => s.store_id === input.return_store_id)) {
      return { ok: false, error: '归还门店不存在', field: 'return_store_id' }
    }

    const returnTime = now ?? localNow()

    // 逐条校验（全部通过后才写入，失败零残留）
    const targetLines: ContractLine[] = []
    for (const lineId of input.line_ids) {
      const line = this.store.contract_lines.find((l) => l.contract_line_id === lineId)
      if (!line || line.contract_id !== contract.contract_id) {
        return { ok: false, error: '明细不存在或不属于该合同', field: 'line_ids' }
      }
      if (line.status !== '借出中') {
        return { ok: false, error: '仅「借出中」的明细可归还', field: 'line_ids' }
      }
      if (returnTime <= line.checkout_time) {
        return { ok: false, error: '归还时间必须晚于借出时间', field: 'line_ids' }
      }
      targetLines.push(line)
    }

    // 一次性写入
    for (const line of targetLines) {
      line.return_time = returnTime
      line.return_store_id = input.return_store_id
      line.status = '已归还'
      const item = this.store.rental_items.find((i) => i.item_id === line.item_id)
      if (item) {
        item.status = '在库'
        item.current_store_id = input.return_store_id
        // home_store_id 不变
      }
    }

    // 全部活动明细归还后合同完成
    const hasActive = this.store.contract_lines.some(
      (l) => l.contract_id === contract.contract_id && l.status === '借出中',
    )
    if (!hasActive) {
      contract.status = '已完成'
      contract.completed_at = returnTime
      contract.total_amount = roundMoney(this.computeFinalTotal(contract.contract_id))
    }

    this.commit()
    const lines = this.store.contract_lines.filter((l) => l.contract_id === contract.contract_id)
    return { ok: true, data: { contract: clone(contract), lines: clone(lines) } }
  }

  /** 合同编号：RC + YYYYMMDD + 4 位全局递增序号（基于现有最大序号，不依赖数组长度） */
  private nextContractNo(contractDate: string): string {
    let maxSeq = 0
    for (const c of this.store.rental_contracts) {
      const m = c.contract_no.match(/-(\d{4})$/)
      if (m) {
        const seq = Number(m[1])
        if (seq > maxSeq) maxSeq = seq
      }
    }
    const ymd = contractDate.replace(/-/g, '')
    return `RC${ymd}-${String(maxSeq + 1).padStart(4, '0')}`
  }

  /**
   * 复算合同最终总额（完成时固化）：
   * 初始明细金额（排除换入明细）Σ(daily_rate × duration_days) + 各换货组 amount_delta 之和。
   * 不信任 total_amount 或客户端金额，从明细与变更记录独立复算。
   */
  private computeFinalTotal(contractId: number): number {
    const contract = this.store.rental_contracts.find((c) => c.contract_id === contractId)!
    const lines = this.store.contract_lines.filter((l) => l.contract_id === contractId)
    const changes = this.store.contract_changes.filter((ch) => ch.contract_id === contractId)

    // 换入的 item（change_type='增加'）
    const exchangedIn = new Set(
      changes.filter((ch) => ch.change_type === '增加' && ch.item_id !== null).map((ch) => ch.item_id as number),
    )
    // 初始金额 = 排除换入明细后的 Σ(daily_rate × quantity × duration_days)
    const initial = lines
      .filter((l) => !exchangedIn.has(l.item_id))
      .reduce((sum, l) => sum + l.daily_rate * l.quantity * contract.duration_days, 0)

    // 各换货组的 amount_delta 之和（组层面只计算一次，已在写入时固化）
    const deltaSum = changes
      .filter((ch) => ch.change_group_id !== null && ch.amount_delta !== null)
      .reduce((sum, ch) => sum + (ch.amount_delta as number), 0)

    return roundMoney(initial + deltaSum)
  }

  // -------------------------------------------------------------------------
  // 维修单：创建（admin / staff）/ 开始 / 完成（分配到该单的 contractor）
  // -------------------------------------------------------------------------

  /**
   * 创建维修单（原子）：admin/staff；仅「在库」设备可报修；按 request_date 冻结 rate_id
   * （忽略未来费率）；设备状态改「维修中」。任一校验失败零残留。
   */
  createRepairOrder(actorRole: Role, input: CreateRepairInput): OpResult<RepairOrder> {
    const denied = checkWritePermission(actorRole, 'repair')
    if (denied) return denied

    // 设备存在 + 在库
    const item = this.store.rental_items.find((i) => i.item_id === input.item_id)
    if (!item) {
      return { ok: false, error: '设备不存在', field: 'item_id' }
    }
    if (item.status !== '在库') {
      return { ok: false, error: `设备 ${item.item_code} 当前状态为「${item.status}」，仅「在库」设备可报修`, field: 'item_id' }
    }
    // 承包商存在
    if (!this.store.contractors.some((c) => c.contractor_id === input.contractor_id)) {
      return { ok: false, error: '承包商不存在', field: 'contractor_id' }
    }
    // 申请日期必填、合法、不得晚于当天
    if (!input.request_date || !isValidDate(input.request_date)) {
      return { ok: false, error: '申请日期不能为空且须为合法日期', field: 'request_date' }
    }
    if (input.request_date > today()) {
      return { ok: false, error: '申请日期不得晚于当天', field: 'request_date' }
    }
    // 故障描述必填
    if (!input.fault_description.trim()) {
      return { ok: false, error: '故障描述不能为空', field: 'fault_description' }
    }
    // 按 request_date 冻结有效费率（未来费率不生效）
    const rate = this.getEffectiveContractorRate(input.contractor_id, input.request_date)
    if (!rate) {
      return { ok: false, error: '该承包商在该日期无有效费率', field: 'contractor_id' }
    }

    // 一次性写入
    const repair: RepairOrder = {
      repair_id: nextId(this.store.repair_orders, (r) => r.repair_id),
      item_id: input.item_id,
      contractor_id: input.contractor_id,
      rate_id: rate.rate_id,
      request_date: input.request_date,
      fault_description: input.fault_description.trim(),
      repair_date: null,
      repair_hours: null,
      calculated_cost: null,
      notes: null,
      status: '待维修',
    }
    this.store.repair_orders.push(repair)
    item.status = '维修中'
    this.commit()
    return { ok: true, data: clone(repair) }
  }

  /** 开始维修（原子）：仅分配到该单的 contractor；待维修 → 维修中，不可跳级/回退/重复 */
  startRepair(actorRole: Role, contractorId: number, repairId: number): OpResult<RepairOrder> {
    const repair = this.store.repair_orders.find((r) => r.repair_id === repairId)
    if (!repair) {
      return { ok: false, error: '维修单不存在' }
    }
    if (actorRole !== 'contractor') {
      return { ok: false, error: '仅承包商可开始维修' }
    }
    if (repair.contractor_id !== contractorId) {
      return { ok: false, error: '只能操作自己承接的维修单' }
    }
    if (repair.status !== '待维修') {
      return { ok: false, error: '仅「待维修」状态的维修单可开始' }
    }
    repair.status = '维修中'
    this.commit()
    return { ok: true, data: clone(repair) }
  }

  /**
   * 完成维修（原子）：仅分配到该单的 contractor；维修中 → 已完成；
   * calculated_cost = 冻结费率 hourly_rate × repair_hours（服务层计算，不信客户端金额）；
   * 设备恢复「在库」。
   */
  completeRepair(
    actorRole: Role,
    contractorId: number,
    repairId: number,
    input: CompleteRepairInput,
  ): OpResult<RepairOrder> {
    const repair = this.store.repair_orders.find((r) => r.repair_id === repairId)
    if (!repair) {
      return { ok: false, error: '维修单不存在' }
    }
    if (actorRole !== 'contractor') {
      return { ok: false, error: '仅承包商可完成维修' }
    }
    if (repair.contractor_id !== contractorId) {
      return { ok: false, error: '只能操作自己承接的维修单' }
    }
    if (repair.status !== '维修中') {
      return { ok: false, error: '仅「维修中」状态的维修单可完成' }
    }
    // 维修完成日期：必填、合法、不得早于申请日期、不得晚于当天
    if (!input.repair_date || !isValidDate(input.repair_date)) {
      return { ok: false, error: '维修完成日期不能为空且须为合法日期', field: 'repair_date' }
    }
    if (input.repair_date < repair.request_date) {
      return { ok: false, error: '维修完成日期不得早于申请日期', field: 'repair_date' }
    }
    if (input.repair_date > today()) {
      return { ok: false, error: '维修完成日期不得晚于当天', field: 'repair_date' }
    }
    // 工时 > 0 且 0.25 步进
    if (!(input.repair_hours > 0)) {
      return { ok: false, error: '维修工时必须大于 0', field: 'repair_hours' }
    }
    if (Math.abs(input.repair_hours * 4 - Math.round(input.repair_hours * 4)) > 1e-9) {
      return { ok: false, error: '维修工时须按 0.25 小时步进', field: 'repair_hours' }
    }
    // 说明必填
    if (!input.notes.trim()) {
      return { ok: false, error: '维修说明不能为空', field: 'notes' }
    }
    // 冻结费率成本计算
    const rate = this.store.contractor_rates.find((r) => r.rate_id === repair.rate_id)
    if (!rate) {
      return { ok: false, error: '冻结费率不存在' }
    }
    const calculatedCost = roundMoney(rate.hourly_rate * input.repair_hours)

    // 一次性写入
    repair.status = '已完成'
    repair.repair_date = input.repair_date
    repair.repair_hours = input.repair_hours
    repair.calculated_cost = calculatedCost
    repair.notes = input.notes.trim()
    // 设备恢复在库
    const item = this.store.rental_items.find((i) => i.item_id === repair.item_id)
    if (item && item.status === '维修中') {
      item.status = '在库'
    }
    this.commit()
    return { ok: true, data: clone(repair) }
  }
}

export const dataService = new DataService()

// ---------------------------------------------------------------------------
// 工具与校验
// ---------------------------------------------------------------------------

/** 深拷贝（数据均为纯 JSON 结构） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 本地当前时间：YYYY-MM-DDTHH:mm:ss（本地时区，避免 toISOString 的 UTC 偏差） */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 金额保留两位小数（避免浮点误差累积） */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/** 自然日差：to − from（取日期部分，UTC 基准，与 validate.ts 口径一致） */
function dateDiffDays(from: string, to: string): number {
  const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`)
  return Math.round((parse(to) - parse(from)) / 86400000)
}

/** 邮箱规范化：trim 后空串视为 null */
function normalizeEmail(email: string | null): string | null {
  if (email === null) return null
  const v = email.trim()
  return v === '' ? null : v
}

/** 可空数值：null/空串/非法值 → null，否则保留 number */
function toNullableNumber(value: number | null): number | null {
  if (value === null) return null
  if (Number.isNaN(value)) return null
  return value
}

/** 非负数值：非法值按 0 处理（金额字段，校验层已拒绝负值） */
function toNonNegativeNumber(value: number): number {
  if (Number.isNaN(value)) return 0
  return value
}

/** 技能等级：配件（护目镜/头盔）强制为空，其余保留输入 */
function resolveSkillLevel(category: RentalItem['category'], skillLevelId: number | null): number | null {
  if (category === '护目镜' || category === '头盔') return null
  return skillLevelId
}

/** 校验错误结果（校验函数只返回失败分支） */
type ValidationError = { ok: false; error: string; field?: string }

/** 客户输入校验（编辑时 excludeId 排除自身邮箱） */
function validateCustomerInput(
  input: CustomerInput,
  db: Database,
  excludeId: number | null,
): ValidationError | null {
  if (!input.full_name.trim()) {
    return { ok: false, error: '姓名不能为空', field: 'full_name' }
  }
  if (!input.address.trim()) {
    return { ok: false, error: '地址不能为空', field: 'address' }
  }
  if (!input.phone.trim()) {
    return { ok: false, error: '电话不能为空', field: 'phone' }
  }
  const email = normalizeEmail(input.email)
  if (email !== null) {
    const dup = db.customers.find(
      (c) => c.customer_id !== excludeId && (c.email ?? '').trim().toLowerCase() === email.toLowerCase(),
    )
    if (dup) {
      return { ok: false, error: '该邮箱已被其他客户使用', field: 'email' }
    }
  }
  const birth = input.birth_year
  // 出生年份：null 或 1900–2100 之间的有限整数（与 cloud 校验同口径，拒绝小数/NaN/±Infinity/字符串）
  if (birth !== null && (!Number.isInteger(birth) || birth < 1900 || birth > 2100)) {
    return { ok: false, error: '出生年份需为 1900–2100 之间的整数', field: 'birth_year' }
  }
  if (!inRange(input.height_cm, 30, 260)) {
    return { ok: false, error: '身高需为 30–260 之间的数值', field: 'height_cm' }
  }
  if (!inRange(input.weight_kg, 5, 300)) {
    return { ok: false, error: '体重需为 5–300 之间的数值', field: 'weight_kg' }
  }
  if (!inRange(input.shoe_size, 15, 55)) {
    return { ok: false, error: '鞋码需为 15–55 之间的数值', field: 'shoe_size' }
  }
  return null
}

/** 设备输入校验（编辑时 excludeId 排除自身 item_code；含外键存在性校验） */
function validateItemInput(
  input: RentalItemInput,
  db: Database,
  excludeId: number | null,
): ValidationError | null {
  const code = input.item_code.trim()
  if (!code) {
    return { ok: false, error: '库存编号不能为空', field: 'item_code' }
  }
  const dup = db.rental_items.find(
    (i) => i.item_id !== excludeId && i.item_code.trim().toLowerCase() === code.toLowerCase(),
  )
  if (dup) {
    return { ok: false, error: '该库存编号已被其他设备使用', field: 'item_code' }
  }
  if (!input.name.trim()) {
    return { ok: false, error: '名称不能为空', field: 'name' }
  }
  if (input.purchase_cost < 0) {
    return { ok: false, error: '购入成本不能为负', field: 'purchase_cost' }
  }
  if (input.retail_price < 0) {
    return { ok: false, error: '零售价不能为负', field: 'retail_price' }
  }
  if (input.daily_rate < 0) {
    return { ok: false, error: '日租金不能为负', field: 'daily_rate' }
  }
  if (!input.home_store_id) {
    return { ok: false, error: '归属门店不能为空', field: 'home_store_id' }
  }
  if (!input.current_store_id) {
    return { ok: false, error: '当前门店不能为空', field: 'current_store_id' }
  }
  // 外键存在性：归属/当前门店必须真实存在
  if (!db.stores.some((s) => s.store_id === input.home_store_id)) {
    return { ok: false, error: '归属门店不存在', field: 'home_store_id' }
  }
  if (!db.stores.some((s) => s.store_id === input.current_store_id)) {
    return { ok: false, error: '当前门店不存在', field: 'current_store_id' }
  }
  const isAccessory = input.category === '护目镜' || input.category === '头盔'
  if (isAccessory && input.skill_level_id !== null) {
    return { ok: false, error: '护目镜、头盔等配件不设技能等级', field: 'skill_level_id' }
  }
  // 外键存在性：非配件且非空时，技能等级必须真实存在
  if (!isAccessory && input.skill_level_id !== null) {
    if (!db.skill_levels.some((l) => l.skill_level_id === input.skill_level_id)) {
      return { ok: false, error: '技能等级不存在', field: 'skill_level_id' }
    }
  }
  return null
}

/** 门店输入校验 */
function validateStoreInput(input: StoreInput): ValidationError | null {
  if (!input.store_name.trim()) {
    return { ok: false, error: '门店名称不能为空', field: 'store_name' }
  }
  return null
}

/** 数值范围校验：null 视为通过；非法或超界返回 false */
function inRange(value: number | null, min: number, max: number): boolean {
  if (value === null) return true
  if (Number.isNaN(value)) return false
  return value >= min && value <= max
}

/** 日期合法性校验：YYYY-MM-DD，且为真实存在的日期（拒绝 2026-02-30） */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** 时间合法性校验：HH:mm */
function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
}

/** 承包商输入校验 */
function validateContractorInput(input: ContractorInput): ValidationError | null {
  if (!input.name.trim()) {
    return { ok: false, error: '承包商名称不能为空', field: 'name' }
  }
  return null
}

/** 费率输入校验（编辑时 excludeId 排除自身；不校验承包商存在性，由调用方负责） */
function validateContractorRateInput(
  input: ContractorRateInput,
  db: Database,
  contractorId: number,
  excludeId: number | null,
): ValidationError | null {
  if (!input.effective_date || !isValidDate(input.effective_date)) {
    return { ok: false, error: '生效日期不能为空且须为合法日期', field: 'effective_date' }
  }
  if (!(input.hourly_rate > 0)) {
    return { ok: false, error: '小时费率必须大于 0', field: 'hourly_rate' }
  }
  const dup = db.contractor_rates.find(
    (r) => r.rate_id !== excludeId && r.contractor_id === contractorId && r.effective_date === input.effective_date,
  )
  if (dup) {
    return { ok: false, error: '该承包商在该生效日期已存在费率', field: 'effective_date' }
  }
  return null
}

/** 员工输入校验 */
function validateEmployeeInput(input: EmployeeInput): ValidationError | null {
  if (!input.full_name.trim()) {
    return { ok: false, error: '员工姓名不能为空', field: 'full_name' }
  }
  return null
}

/** 排班输入校验（编辑时 excludeId 排除自身） */
function validateShiftInput(input: ShiftInput, db: Database, excludeId: number | null): ValidationError | null {
  if (!db.employees.some((e) => e.employee_id === input.employee_id)) {
    return { ok: false, error: '员工不存在', field: 'employee_id' }
  }
  if (!db.stores.some((s) => s.store_id === input.store_id)) {
    return { ok: false, error: '门店不存在', field: 'store_id' }
  }
  if (!input.work_date || !isValidDate(input.work_date)) {
    return { ok: false, error: '排班日期不能为空且须为合法日期', field: 'work_date' }
  }
  if (!isValidTime(input.start_time)) {
    return { ok: false, error: '开始时间须为 HH:mm 格式', field: 'start_time' }
  }
  if (!isValidTime(input.end_time)) {
    return { ok: false, error: '结束时间须为 HH:mm 格式', field: 'end_time' }
  }
  if (input.start_time < '08:00') {
    return { ok: false, error: '开始时间不得早于 08:00', field: 'start_time' }
  }
  if (input.end_time > '22:00') {
    return { ok: false, error: '结束时间不得晚于 22:00', field: 'end_time' }
  }
  if (input.start_time >= input.end_time) {
    return { ok: false, error: '开始时间必须早于结束时间', field: 'end_time' }
  }
  const dup = db.shifts.find(
    (s) => s.shift_id !== excludeId && s.employee_id === input.employee_id && s.work_date === input.work_date,
  )
  if (dup) {
    return { ok: false, error: '该员工在当天已有排班', field: 'work_date' }
  }
  return null
}
