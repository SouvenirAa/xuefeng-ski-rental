-- ============================================================================
-- 雪峰滑雪租赁 权限加固补丁（harden_cloudbase_acl）
--
-- 背景：CloudBase PG 平台对 public schema 预置了 ALTER DEFAULT PRIVILEGES，
--   导致 anon/authenticated/service_role 对新创建的表/序列/函数自动获得宽泛
--   权限（表 arwdDxtm、序列 rwU、函数 X）。前三个迁移虽做了显式 GRANT/REVOKE，
--   但 REVOKE FROM PUBLIC 不覆盖 default privileges 已直接授予 anon/service_role
--   的权限，也未撤销 TRUNCATE/TRIGGER/MAINTAIN/REFERENCES。
--
-- 本补丁目标（不改变 service_role 的平台管理权限）：
--   1) anon 对本案例 13 张表、15 个序列、9 个函数均无权限。
--   2) authenticated 仅保留业务所需最小权限。
--   3) 撤销 anon/authenticated 的 TRUNCATE / TRIGGER / MAINTAIN / 非必要 REFERENCES。
--   4) 内部触发器函数 protect_contractor_rate 不向 anon/authenticated/PUBLIC 暴露。
--
-- 重要说明（安全边界）：
--   CloudBase PostgREST 当前不把函数的 GRANT EXECUTE 作为可靠的网关安全边界。
--   因此 SECURITY DEFINER RPC 函数内部的角色校验（accounts.uid = auth.uid()、
--   enabled=true、角色匹配）才是主要安全边界，本补丁不放松任何函数内部校验。
--
-- 本文件不含任何密钥/凭据。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 表权限：先整体撤销 anon/authenticated，再按权限矩阵精确重授权
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE
    accounts, skill_levels, stores, customers, employees,
    contractors, contractor_rates, shifts,
    rental_items, rental_contracts, contract_lines, contract_changes, repair_orders
  FROM anon, authenticated;

-- 1.1 基础资料表（8 张）：authenticated 直接 CRUD（行级由 RLS 控制）
GRANT SELECT, INSERT, UPDATE, DELETE ON
    accounts, skill_levels, stores, customers, employees,
    contractors, contractor_rates, shifts
  TO authenticated;

-- 1.2 rental_items：表级 SELECT、DELETE；列级 INSERT/UPDATE（不含 item_id、status）
GRANT SELECT, DELETE ON rental_items TO authenticated;
GRANT INSERT (item_code, name, description, category, purchase_date, purchase_cost,
              retail_price, daily_rate, skill_level_id, home_store_id, current_store_id)
  ON rental_items TO authenticated;
GRANT UPDATE (item_code, name, description, category, purchase_date, purchase_cost,
              retail_price, daily_rate, skill_level_id, home_store_id, current_store_id)
  ON rental_items TO authenticated;

-- 1.3 封闭业务表（4 张）：仅 SELECT，写入一律走 SECURITY DEFINER RPC
GRANT SELECT ON rental_contracts, contract_lines, contract_changes, repair_orders
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. 序列权限：撤销 anon/authenticated 全部，仅基础资料 identity 序列重授权
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON SEQUENCE
    accounts_account_id_seq, skill_levels_skill_level_id_seq, stores_store_id_seq,
    customers_customer_id_seq, employees_employee_id_seq, rental_items_item_id_seq,
    contractors_contractor_id_seq, contractor_rates_rate_id_seq, shifts_shift_id_seq,
    rental_contracts_contract_id_seq, contract_lines_contract_line_id_seq,
    contract_changes_change_id_seq, repair_orders_repair_id_seq,
    contract_no_seq, change_group_seq
  FROM anon, authenticated;

-- 基础资料直接 INSERT 所需的 9 个 identity 序列：USAGE + SELECT
-- 封闭表 identity 序列与业务序列 contract_no_seq / change_group_seq 仅供
-- SECURITY DEFINER RPC 内部使用，不授予 authenticated。
GRANT USAGE, SELECT ON SEQUENCE
    accounts_account_id_seq, skill_levels_skill_level_id_seq, stores_store_id_seq,
    customers_customer_id_seq, employees_employee_id_seq, rental_items_item_id_seq,
    contractors_contractor_id_seq, contractor_rates_rate_id_seq, shifts_shift_id_seq
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 函数权限：撤销 PUBLIC/anon；8 个 RPC 授权 authenticated；内部触发器不外露
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.current_app_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_contract(bigint, date, integer, bigint[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.exchange_item(bigint, bigint, bigint, bigint, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.return_items(bigint, bigint[], bigint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_repair_order(bigint, bigint, date, varchar) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_repair(bigint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.complete_repair(bigint, date, numeric, varchar) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_my_repairs() FROM PUBLIC, anon;
-- 内部触发器函数：撤销 PUBLIC、anon、authenticated 的 EXECUTE（不对外暴露）
REVOKE EXECUTE ON FUNCTION public.protect_contractor_rate() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_contract(bigint, date, integer, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exchange_item(bigint, bigint, bigint, bigint, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_items(bigint, bigint[], bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_repair_order(bigint, bigint, date, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_repair(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_repair(bigint, date, numeric, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_repairs() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. public schema：显式撤销 anon/authenticated 的 CREATE（保留 USAGE）
--    不影响 CloudBase 的 auth / storage schema。
-- ---------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. 默认权限：撤销当前迁移用户未来对象的宽泛默认授权。
--    已只读核验：current_user = session_user = cloudbase_postgres_pgdb_1yrutwe3，
--    且 13 表/15 序列/9 函数 owner 均为该角色、pg_has_role(..., 'MEMBER')=true。
--    因此使用「无 FOR ROLE」写法，作用于当前迁移用户，避免环境专属角色名
--    硬编码（可迁移到其它环境）。
--    函数默认权限同时撤销 PUBLIC、anon、authenticated：PUBLIC 是 PostgreSQL
--    内置默认，anon/authenticated 是平台 default ACL 显式授予；保留
--    service_role 的平台管理权限。不修改 cloudbase_admin_pgdb_1yrutwe3。
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
