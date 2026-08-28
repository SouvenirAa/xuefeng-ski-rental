-- ============================================================================
-- 雪峰滑雪租赁 RLS 行级安全策略 + 授权 + 业务 RPC 事务函数
--
-- 说明：
--   1) CloudBase Auth 角色映射：Publishable Key → anon；登录用户 token → authenticated；
--      管理端 API Key → service_role（绕过 RLS）。业务角色（admin/staff/contractor）
--      由 accounts 表维护，通过 account.uid = auth.uid() 关联。
--   2) 本文件用 auth.uid() 关联当前用户，不使用 current_user（那是 PG 数据库角色名）。
--   3) 封闭业务表（rental_contracts / contract_lines / contract_changes / repair_orders）
--      仅授予 SELECT，所有写入必须通过受控 SECURITY DEFINER RPC，禁止直接 DML。
--   4) 事件时间一律由数据库服务器生成：timezone('Asia/Shanghai', clock_timestamp())，
--      不信任客户端传入的时间（RPC 不接收客户端时间参数）。
--   5) 所有 SECURITY DEFINER 函数 REVOKE FROM PUBLIC，仅 GRANT authenticated；
--      使用安全 search_path = pg_catalog, public 并 schema 限定所有对象。
--   6) 本文件不含任何密钥/凭据。
-- ============================================================================

-- 撤销 PUBLIC 在 public schema 上的 CREATE 权限，降低对象劫持面。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 0. 辅助函数：当前登录用户的业务角色
--    auth.uid() 未登录时返回 NULL；登录后等于 CloudBase Auth 用户 sub。
--    命名 current_app_role，避免与 PostgreSQL 保留/内置名称 current_user 混淆。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT role FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true
$$;
REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;

-- ---------------------------------------------------------------------------
-- 1. 表级 GRANT
--    基础资料表按权限矩阵保留 CRUD（行级由 RLS 控制）；
--    封闭业务表仅 SELECT，写入只能走受控 RPC。
-- ---------------------------------------------------------------------------

-- 基础资料表：CRUD（行级由 RLS 控制）
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_levels     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON stores           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON employees        TO authenticated;
-- rental_items.status 由 SECURITY DEFINER RPC 控制：authenticated 普通 INSERT/UPDATE 不得写 status
-- 先显式清除表级写权限，避免默认/历史权限残留，再授予列级权限
REVOKE INSERT, UPDATE ON public.rental_items FROM authenticated;
GRANT SELECT, DELETE ON rental_items TO authenticated;
GRANT INSERT (item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id) ON rental_items TO authenticated;
GRANT UPDATE (item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id) ON rental_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contractors      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contractor_rates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON shifts           TO authenticated;

-- 封闭业务表：仅 SELECT（写入走 create_contract / exchange_item / return_items /
-- create_repair_order / start_repair / complete_repair RPC）
GRANT SELECT ON rental_contracts TO authenticated;
GRANT SELECT ON contract_lines   TO authenticated;
GRANT SELECT ON contract_changes TO authenticated;
GRANT SELECT ON repair_orders    TO authenticated;

-- 显式撤销封闭表的直接 DML（防御：即使平台/其它 GRANT 覆盖也不允许直接写）
REVOKE INSERT, UPDATE, DELETE ON rental_contracts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON contract_lines   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON contract_changes FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON repair_orders    FROM authenticated;

-- 基础资料表 identity 序列：允许 authenticated 直接 INSERT 时取主键
GRANT USAGE, SELECT ON SEQUENCE public.accounts_account_id_seq         TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.skill_levels_skill_level_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.stores_store_id_seq             TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.customers_customer_id_seq       TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.employees_employee_id_seq       TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.rental_items_item_id_seq        TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.contractors_contractor_id_seq   TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.contractor_rates_rate_id_seq    TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.shifts_shift_id_seq             TO authenticated;
-- 封闭表 identity 序列 + 业务序列 contract_no_seq / change_group_seq
-- 不授予 authenticated，仅供 SECURITY DEFINER RPC 内部使用。

-- ---------------------------------------------------------------------------
-- 2. 启用行级安全
-- ---------------------------------------------------------------------------
ALTER TABLE accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_levels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees           ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor_rates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_contracts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_changes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts              ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. RLS Policy
--    权限矩阵：admin 全表；staff 客户/合同/维修单可写，其余只读；
--    contractor 仅维修单（本人承接）可读。
--    封闭业务表只有 SELECT policy，无任何 INSERT/UPDATE/DELETE policy。
-- ---------------------------------------------------------------------------

-- accounts：用户读自己；admin 读全部；写仅 admin
CREATE POLICY accounts_select ON accounts FOR SELECT TO authenticated
  USING (uid = (select auth.uid()) OR (select public.current_app_role()) = 'admin');
CREATE POLICY accounts_write ON accounts FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- skill_levels：admin/staff 读；admin 写
CREATE POLICY skill_levels_select ON skill_levels FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY skill_levels_write ON skill_levels FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- stores：admin/staff 读；admin 写
CREATE POLICY stores_select ON stores FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY stores_write ON stores FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- customers：admin/staff 读写
CREATE POLICY customers_select ON customers FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY customers_write ON customers FOR ALL TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'))
  WITH CHECK ((select public.current_app_role()) IN ('admin','staff'));

-- employees：admin/staff 读；admin 写
CREATE POLICY employees_select ON employees FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY employees_write ON employees FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- rental_items：admin/staff 读；admin 写（INSERT/UPDATE/DELETE 三条独立 Policy，status 仍由列级权限封闭）
CREATE POLICY rental_items_select ON rental_items FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY rental_items_insert ON rental_items FOR INSERT TO authenticated
  WITH CHECK ((select public.current_app_role()) = 'admin' AND status = '在库');
CREATE POLICY rental_items_update ON rental_items FOR UPDATE TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');
CREATE POLICY rental_items_delete ON rental_items FOR DELETE TO authenticated
  USING ((select public.current_app_role()) = 'admin' AND status = '在库');

-- contractors：admin/staff 读；admin 写
CREATE POLICY contractors_select ON contractors FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY contractors_write ON contractors FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- contractor_rates：admin/staff 读；admin 写
CREATE POLICY contractor_rates_select ON contractor_rates FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));
CREATE POLICY contractor_rates_write ON contractor_rates FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- rental_contracts（封闭表）：仅 SELECT，admin/staff 读；无写 Policy
CREATE POLICY rental_contracts_select ON rental_contracts FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));

-- contract_lines（封闭表）：仅 SELECT，admin/staff 读；无写 Policy
CREATE POLICY contract_lines_select ON contract_lines FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));

-- contract_changes（封闭表）：仅 SELECT，admin/staff 读；无写 Policy
CREATE POLICY contract_changes_select ON contract_changes FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff'));

-- repair_orders（封闭表）：仅 SELECT，admin/staff 读全部、contractor 读本人承接；无写 Policy
CREATE POLICY repair_orders_select ON repair_orders FOR SELECT TO authenticated
  USING ((select public.current_app_role()) IN ('admin','staff')
         OR ((select public.current_app_role()) = 'contractor'
             AND contractor_id = (SELECT contractor_id FROM public.accounts WHERE uid = (select auth.uid()))));

-- shifts：仅 admin 读写
CREATE POLICY shifts_select ON shifts FOR SELECT TO authenticated
  USING ((select public.current_app_role()) = 'admin');
CREATE POLICY shifts_write ON shifts FOR ALL TO authenticated
  USING ((select public.current_app_role()) = 'admin')
  WITH CHECK ((select public.current_app_role()) = 'admin');

-- ============================================================================
-- 4. 业务 RPC 事务函数（SECURITY DEFINER，绕过 RLS，内部完整校验 + 原子提交）
--    前端只调用这些函数完成多表操作，不拆成多个独立请求。
--    每个函数：REVOKE FROM PUBLIC + GRANT authenticated；安全 search_path；
--    事件时间由 timezone('Asia/Shanghai', clock_timestamp()) 生成，无 p_now 参数。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 4.1 创建合同并借出（对应 DataService.createContract）
--     返回新合同 contract_id；经办员工取自当前账号关联 employee_id，不信客户端。
--     合同编号全局序号用 contract_no_seq（并发安全，不使用基于现有最大序号加一的编号）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_contract(
  p_customer_id   bigint,
  p_contract_date date,
  p_duration_days integer,
  p_item_ids      bigint[]
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_employee_id bigint;
  v_contract_id bigint;
  v_contract_no varchar(20);
  v_seq bigint;
  v_now timestamp;
  v_item rental_items%ROWTYPE;
  v_total numeric(10,2) := 0;
  v_id bigint;
BEGIN
  -- 服务器生成借出时间（上海时区），禁止客户端伪造
  v_now := timezone('Asia/Shanghai', clock_timestamp());

  SELECT role, employee_id INTO v_role, v_employee_id
    FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','staff') THEN
    RAISE EXCEPTION '无权限创建合同';
  END IF;
  IF v_employee_id IS NULL THEN
    RAISE EXCEPTION '当前账号未关联员工';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE customer_id = p_customer_id) THEN
    RAISE EXCEPTION '客户不存在';
  END IF;
  IF p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RAISE EXCEPTION '租赁天数必须为正整数';
  END IF;
  IF cardinality(p_item_ids) = 0 THEN
    RAISE EXCEPTION '请至少选择一件设备';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_item_ids) AS x) <> cardinality(p_item_ids) THEN
    RAISE EXCEPTION '同一合同不得重复加入相同设备';
  END IF;
  IF v_now::date < p_contract_date THEN
    RAISE EXCEPTION '合同日期不得晚于当天';
  END IF;

  -- 逐设备校验（FOR UPDATE 锁定）
  FOREACH v_id IN ARRAY p_item_ids LOOP
    SELECT * INTO v_item FROM public.rental_items WHERE item_id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '设备 % 不存在', v_id; END IF;
    IF v_item.status <> '在库' THEN
      RAISE EXCEPTION '设备 % 当前状态为 %，仅「在库」设备可借出', v_item.item_code, v_item.status;
    END IF;
  END LOOP;

  -- 合同编号全局递增序号（sequence，并发安全）
  v_seq := nextval('public.contract_no_seq');
  v_contract_no := 'RC' || to_char(p_contract_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO public.rental_contracts
    (contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status)
  VALUES (v_contract_no, p_customer_id, v_employee_id, p_contract_date, p_duration_days, 0, NULL, '进行中')
  RETURNING contract_id INTO v_contract_id;

  FOREACH v_id IN ARRAY p_item_ids LOOP
    SELECT * INTO v_item FROM public.rental_items WHERE item_id = v_id FOR UPDATE;
    INSERT INTO public.contract_lines
      (contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status)
    VALUES (v_contract_id, v_id, 1, v_item.daily_rate, v_now, v_item.current_store_id, NULL, NULL, '借出中');
    v_total := v_total + v_item.daily_rate * p_duration_days;
    UPDATE public.rental_items SET status = '借出中' WHERE item_id = v_id;
  END LOOP;

  UPDATE public.rental_contracts SET total_amount = round(v_total, 2) WHERE contract_id = v_contract_id;
  RETURN v_contract_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_contract(bigint, date, integer, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_contract(bigint, date, integer, bigint[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.2 换货（对应 DataService.exchangeItem）
--     差价服务端复算：(新日租金 − 旧明细快照日租金) × 剩余天数；负数为退款。
--     换货日期必须为服务器当天（换货按实际操作时间记录）；时间由服务器生成。
--     change_id 由 identity 自动生成；change_group_id 用 change_group_seq。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exchange_item(
  p_contract_id     bigint,
  p_old_line_id     bigint,
  p_new_item_id     bigint,
  p_return_store_id bigint,
  p_change_date     date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_now timestamp;
  v_contract rental_contracts%ROWTYPE;
  v_old_line contract_lines%ROWTYPE;
  v_new_item rental_items%ROWTYPE;
  v_remaining integer;
  v_amount_delta numeric(10,2);
  v_group_id bigint;
  v_note varchar(500);
BEGIN
  v_now := timezone('Asia/Shanghai', clock_timestamp());

  SELECT role INTO v_role FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','staff') THEN
    RAISE EXCEPTION '无权限换货';
  END IF;

  SELECT * INTO v_contract FROM public.rental_contracts WHERE contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '合同不存在'; END IF;
  IF v_contract.status <> '进行中' THEN RAISE EXCEPTION '仅进行中的合同可换货'; END IF;

  -- 剩余天数（变更当天计入；change_date 不得早于合同日期，且必须为服务器当天）
  IF p_change_date < v_contract.contract_date THEN RAISE EXCEPTION '换货日期不能早于合同日期'; END IF;
  v_remaining := v_contract.duration_days - (p_change_date - v_contract.contract_date);
  IF v_remaining <= 0 THEN RAISE EXCEPTION '换货日期超出合同有效期'; END IF;
  IF p_change_date <> v_now::date THEN
    RAISE EXCEPTION '换货日期必须为当天（换货按实际操作时间记录）';
  END IF;

  SELECT * INTO v_old_line FROM public.contract_lines
    WHERE contract_line_id = p_old_line_id AND contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '旧明细不存在或不属于该合同'; END IF;
  IF v_old_line.status <> '借出中' THEN RAISE EXCEPTION '仅「借出中」的明细可换货'; END IF;

  SELECT * INTO v_new_item FROM public.rental_items WHERE item_id = p_new_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '新设备不存在'; END IF;
  IF v_new_item.status <> '在库' THEN
    RAISE EXCEPTION '新设备 % 当前状态为 %，仅「在库」设备可选', v_new_item.item_code, v_new_item.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.contract_lines WHERE contract_id = p_contract_id AND item_id = p_new_item_id) THEN
    RAISE EXCEPTION '新设备已出现在该合同中';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE store_id = p_return_store_id) THEN
    RAISE EXCEPTION '归还门店不存在';
  END IF;
  IF v_now <= v_old_line.checkout_time THEN
    RAISE EXCEPTION '换货时间必须晚于借出时间';
  END IF;

  -- 差价复算（用旧明细合同快照 daily_rate，不用目录价）
  v_amount_delta := round((v_new_item.daily_rate - v_old_line.daily_rate) * v_remaining, 2);
  v_note := CASE WHEN v_amount_delta >= 0 THEN '升级至更高价款装备' ELSE '更换为更低价位装备（退款）' END;

  -- 组号（sequence，并发安全）；change_id 交由 identity 自动生成
  v_group_id := nextval('public.change_group_seq');

  -- 旧明细 → 已更换；旧设备 → 在库（归还原门店）
  UPDATE public.contract_lines
     SET return_time = v_now, return_store_id = p_return_store_id, status = '已更换'
   WHERE contract_line_id = p_old_line_id;
  UPDATE public.rental_items SET status = '在库', current_store_id = p_return_store_id
   WHERE item_id = v_old_line.item_id;

  -- 新增明细（借出中）
  INSERT INTO public.contract_lines
    (contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status)
  VALUES (p_contract_id, p_new_item_id, 1, v_new_item.daily_rate, v_now, v_new_item.current_store_id, NULL, NULL, '借出中');
  UPDATE public.rental_items SET status = '借出中' WHERE item_id = p_new_item_id;

  -- 两条共享分组的变更记录（仅「归还」一条保存 amount_delta；change_id 自动生成）
  INSERT INTO public.contract_changes
    (contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note)
  VALUES
    (p_contract_id, v_group_id, v_now, '归还', v_old_line.item_id, 1, v_amount_delta, v_note),
    (p_contract_id, v_group_id, v_now, '增加', p_new_item_id,        1, NULL,           v_note);

  -- 合同总额累加差价
  UPDATE public.rental_contracts SET total_amount = round(total_amount + v_amount_delta, 2)
   WHERE contract_id = p_contract_id;
END;
$$;
REVOKE ALL ON FUNCTION public.exchange_item(bigint, bigint, bigint, bigint, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exchange_item(bigint, bigint, bigint, bigint, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.3 归还（对应 DataService.returnItems，支持逐条/批量）
--     全部活动明细归还后合同自动完成并固化最终总额。
--     最终总额复算用 NOT EXISTS 排除换入明细，避免 nullable NOT IN 隐患。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.return_items(
  p_contract_id     bigint,
  p_line_ids        bigint[],
  p_return_store_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_now timestamp;
  v_contract rental_contracts%ROWTYPE;
  v_line contract_lines%ROWTYPE;
  v_id bigint;
  v_final numeric(10,2);
  v_has_active boolean;
BEGIN
  v_now := timezone('Asia/Shanghai', clock_timestamp());

  SELECT role INTO v_role FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','staff') THEN
    RAISE EXCEPTION '无权限归还';
  END IF;

  SELECT * INTO v_contract FROM public.rental_contracts WHERE contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '合同不存在'; END IF;
  IF v_contract.status <> '进行中' THEN RAISE EXCEPTION '仅进行中的合同可归还'; END IF;
  IF cardinality(p_line_ids) = 0 THEN RAISE EXCEPTION '请选择待归还的明细'; END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_line_ids) AS x) <> cardinality(p_line_ids) THEN
    RAISE EXCEPTION '归还明细列表存在重复项';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE store_id = p_return_store_id) THEN
    RAISE EXCEPTION '归还门店不存在';
  END IF;

  FOREACH v_id IN ARRAY p_line_ids LOOP
    SELECT * INTO v_line FROM public.contract_lines
      WHERE contract_line_id = v_id AND contract_id = p_contract_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '明细不存在或不属于该合同'; END IF;
    IF v_line.status <> '借出中' THEN RAISE EXCEPTION '仅「借出中」的明细可归还'; END IF;
    IF v_now <= v_line.checkout_time THEN RAISE EXCEPTION '归还时间必须晚于借出时间'; END IF;

    UPDATE public.contract_lines
       SET return_time = v_now, return_store_id = p_return_store_id, status = '已归还'
     WHERE contract_line_id = v_id;
    UPDATE public.rental_items SET status = '在库', current_store_id = p_return_store_id
     WHERE item_id = v_line.item_id;
  END LOOP;

  -- 是否仍有活动明细
  SELECT EXISTS (
    SELECT 1 FROM public.contract_lines
     WHERE contract_id = p_contract_id AND status = '借出中'
  ) INTO v_has_active;

  IF NOT v_has_active THEN
    -- 复算最终总额：初始明细（排除换入，NOT EXISTS）Σ(daily_rate × duration_days)
    -- + 各换货组 amount_delta
    SELECT round(
      (SELECT COALESCE(SUM(l.daily_rate * l.quantity * v_contract.duration_days), 0)
         FROM public.contract_lines l
         WHERE l.contract_id = p_contract_id
           AND NOT EXISTS (
             SELECT 1 FROM public.contract_changes ch
              WHERE ch.contract_id = p_contract_id AND ch.change_type = '增加'
                AND ch.item_id = l.item_id
           )
      )
      + (SELECT COALESCE(SUM(ch.amount_delta), 0)
           FROM public.contract_changes ch
          WHERE ch.contract_id = p_contract_id
            AND ch.change_group_id IS NOT NULL AND ch.amount_delta IS NOT NULL
        ),
      2
    ) INTO v_final;

    UPDATE public.rental_contracts
       SET status = '已完成', completed_at = v_now, total_amount = v_final
     WHERE contract_id = p_contract_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.return_items(bigint, bigint[], bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_items(bigint, bigint[], bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.4 创建维修单（对应 DataService.createRepairOrder）
--     设备在库 → 维修中；按 request_date 冻结 rate_id（未来费率不生效）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_repair_order(
  p_item_id           bigint,
  p_contractor_id     bigint,
  p_request_date      date,
  p_fault_description varchar
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_today date;
  v_item rental_items%ROWTYPE;
  v_rate_id bigint;
  v_repair_id bigint;
BEGIN
  v_today := (timezone('Asia/Shanghai', clock_timestamp()))::date;

  SELECT role INTO v_role FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','staff') THEN
    RAISE EXCEPTION '无权限创建维修单';
  END IF;

  SELECT * INTO v_item FROM public.rental_items WHERE item_id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '设备不存在'; END IF;
  IF v_item.status <> '在库' THEN
    RAISE EXCEPTION '设备 % 当前状态为 %，仅「在库」设备可报修', v_item.item_code, v_item.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contractors WHERE contractor_id = p_contractor_id) THEN
    RAISE EXCEPTION '承包商不存在';
  END IF;
  IF p_request_date > v_today THEN RAISE EXCEPTION '申请日期不得晚于当天'; END IF;
  IF p_fault_description IS NULL OR btrim(p_fault_description) = '' THEN
    RAISE EXCEPTION '故障描述不能为空';
  END IF;

  -- 冻结有效费率（effective_date <= request_date 中最新一条）
  SELECT rate_id INTO v_rate_id FROM public.contractor_rates
   WHERE contractor_id = p_contractor_id AND effective_date <= p_request_date
   ORDER BY effective_date DESC LIMIT 1;
  IF v_rate_id IS NULL THEN RAISE EXCEPTION '该承包商在该日期无有效费率'; END IF;

  INSERT INTO public.repair_orders
    (item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status)
  VALUES (p_item_id, p_contractor_id, v_rate_id, p_request_date, p_fault_description, NULL, NULL, NULL, NULL, '待维修')
  RETURNING repair_id INTO v_repair_id;

  UPDATE public.rental_items SET status = '维修中' WHERE item_id = p_item_id;
  RETURN v_repair_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_repair_order(bigint, bigint, date, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_repair_order(bigint, bigint, date, varchar) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.5 开始维修（对应 DataService.startRepair）
--     仅分配到该单的 contractor；待维修 → 维修中。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_repair(p_repair_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_contractor_id bigint;
  v_repair repair_orders%ROWTYPE;
BEGIN
  SELECT role, contractor_id INTO v_role, v_contractor_id
    FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role <> 'contractor' THEN
    RAISE EXCEPTION '仅承包商可开始维修';
  END IF;
  IF v_contractor_id IS NULL THEN
    RAISE EXCEPTION '承包商账号未关联承包商实体';
  END IF;

  SELECT * INTO v_repair FROM public.repair_orders WHERE repair_id = p_repair_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '维修单不存在'; END IF;
  IF v_repair.contractor_id IS DISTINCT FROM v_contractor_id THEN RAISE EXCEPTION '只能操作自己承接的维修单'; END IF;
  IF v_repair.status <> '待维修' THEN RAISE EXCEPTION '仅「待维修」状态的维修单可开始'; END IF;

  UPDATE public.repair_orders SET status = '维修中' WHERE repair_id = p_repair_id;
END;
$$;
REVOKE ALL ON FUNCTION public.start_repair(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_repair(bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.6 完成维修（对应 DataService.completeRepair）
--     成本服务端计算 = 冻结费率 × 工时；设备维修中 → 在库。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_repair(
  p_repair_id    bigint,
  p_repair_date  date,
  p_repair_hours numeric,
  p_notes        varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_today date;
  v_contractor_id bigint;
  v_repair repair_orders%ROWTYPE;
  v_rate contractor_rates%ROWTYPE;
  v_cost numeric(10,2);
BEGIN
  v_today := (timezone('Asia/Shanghai', clock_timestamp()))::date;

  SELECT role, contractor_id INTO v_role, v_contractor_id
    FROM public.accounts WHERE uid = (select auth.uid()) AND enabled = true;
  IF v_role IS NULL OR v_role <> 'contractor' THEN
    RAISE EXCEPTION '仅承包商可完成维修';
  END IF;
  IF v_contractor_id IS NULL THEN
    RAISE EXCEPTION '承包商账号未关联承包商实体';
  END IF;

  SELECT * INTO v_repair FROM public.repair_orders WHERE repair_id = p_repair_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '维修单不存在'; END IF;
  IF v_repair.contractor_id IS DISTINCT FROM v_contractor_id THEN RAISE EXCEPTION '只能操作自己承接的维修单'; END IF;
  IF v_repair.status <> '维修中' THEN RAISE EXCEPTION '仅「维修中」状态的维修单可完成'; END IF;
  IF p_repair_date < v_repair.request_date THEN RAISE EXCEPTION '维修完成日期不得早于申请日期'; END IF;
  IF p_repair_date > v_today THEN RAISE EXCEPTION '维修完成日期不得晚于当天'; END IF;
  IF p_repair_hours IS NULL OR p_repair_hours <= 0 THEN RAISE EXCEPTION '维修工时必须大于 0'; END IF;
  IF p_repair_hours % 0.25 <> 0 THEN RAISE EXCEPTION '维修工时须按 0.25 小时步进'; END IF;
  IF p_notes IS NULL OR btrim(p_notes) = '' THEN RAISE EXCEPTION '维修说明不能为空'; END IF;

  SELECT * INTO v_rate FROM public.contractor_rates WHERE rate_id = v_repair.rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION '冻结费率不存在'; END IF;
  v_cost := round(v_rate.hourly_rate * p_repair_hours, 2);

  UPDATE public.repair_orders
     SET status = '已完成', repair_date = p_repair_date, repair_hours = p_repair_hours,
         calculated_cost = v_cost, notes = p_notes
   WHERE repair_id = p_repair_id;

  UPDATE public.rental_items SET status = '在库' WHERE item_id = v_repair.item_id AND status = '维修中';
END;
$$;
REVOKE ALL ON FUNCTION public.complete_repair(bigint, date, numeric, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_repair(bigint, date, numeric, varchar) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4.7 contractor 查询本人维修单（SECURITY DEFINER，绕过引用表 RLS，返回聚合）
--     严格校验：已登录、uid 匹配、enabled=true、role='contractor'、contractor_id 非空。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_my_repairs()
RETURNS TABLE (
  repair_id bigint,
  item_code varchar(20),
  item_name varchar(80),
  contractor_name varchar(80),
  rate_hourly numeric(10,2),
  request_date date,
  fault_description varchar(500),
  repair_date date,
  repair_hours numeric(4,2),
  calculated_cost numeric(10,2),
  notes varchar(500),
  status varchar(20)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_contractor_id bigint;
  v_enabled boolean;
BEGIN
  IF (select auth.uid()) IS NULL THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT role, contractor_id, enabled INTO v_role, v_contractor_id, v_enabled
    FROM public.accounts WHERE uid = (select auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION '账号已禁用';
  END IF;
  IF v_role IS DISTINCT FROM 'contractor' THEN
    RAISE EXCEPTION '仅承包商可查询本人维修单';
  END IF;
  IF v_contractor_id IS NULL THEN
    RAISE EXCEPTION '承包商账号未关联承包商实体';
  END IF;

  RETURN QUERY
    SELECT r.repair_id, i.item_code, i.name, c.name, cr.hourly_rate,
           r.request_date, r.fault_description, r.repair_date, r.repair_hours,
           r.calculated_cost, r.notes, r.status
      FROM public.repair_orders r
      JOIN public.rental_items i ON i.item_id = r.item_id
      JOIN public.contractors c ON c.contractor_id = r.contractor_id
      JOIN public.contractor_rates cr ON cr.rate_id = r.rate_id
     WHERE r.contractor_id = v_contractor_id
     ORDER BY r.repair_id;
END;
$$;
REVOKE ALL ON FUNCTION public.list_my_repairs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_repairs() TO authenticated;

-- ============================================================================
-- 5. 费率冻结保护触发器（内部函数，非前端 RPC）
--    被维修单引用的费率（repair_orders.rate_id 引用 OLD.rate_id）不可 UPDATE 或 DELETE，
--    防止修改 hourly_rate/effective_date 后破坏已冻结的成本语义。
--    触发器函数仅 REVOKE FROM PUBLIC，不 GRANT authenticated（不对外暴露）。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.protect_contractor_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM public.repair_orders WHERE rate_id = OLD.rate_id) THEN
      RAISE EXCEPTION '该费率已被维修单引用，不可修改或删除';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  ELSE
    RETURN OLD;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_contractor_rate() FROM PUBLIC;

CREATE TRIGGER trg_contractor_rates_protect
  BEFORE UPDATE OR DELETE ON contractor_rates
  FOR EACH ROW EXECUTE FUNCTION public.protect_contractor_rate();
