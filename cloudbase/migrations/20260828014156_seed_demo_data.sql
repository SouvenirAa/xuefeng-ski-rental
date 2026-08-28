-- ============================================================
-- 雪峰滑雪租赁 种子数据（来源：app/src/data/seed.ts，仅教学演示虚构数据）
-- 注意：account.uid 预留为 NULL，由 CloudBase Auth 账号创建后回填；
--       accounts 不含任何密码字段，真实密码由 CloudBase Auth 管理；
--       本地 localStorage 模拟用的密码占位字段为纯前端字段，不迁移到云端。
-- ============================================================

-- skill_levels (4 行)
INSERT INTO skill_levels (skill_level_id, level_name, sort_order) VALUES (1, '初级', 1);
INSERT INTO skill_levels (skill_level_id, level_name, sort_order) VALUES (2, '中级', 2);
INSERT INTO skill_levels (skill_level_id, level_name, sort_order) VALUES (3, '高级', 3);
INSERT INTO skill_levels (skill_level_id, level_name, sort_order) VALUES (4, '专家+', 4);

-- stores (2 行)
INSERT INTO stores (store_id, store_name, address, phone) VALUES (1, '云顶东门店', '云顶滑雪度假区东入口 1 号', '0755-81000001');
INSERT INTO stores (store_id, store_name, address, phone) VALUES (2, '云顶西门店', '云顶滑雪度假区西索道下站 2 号', '0755-81000002');

-- customers (12 行)
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (1, '刘雪峰', '云顶镇示例路 1 号', '13810000001', 'liuxf@example.com', 1990, 165, 58, 38);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (2, '孙悦', '云顶镇示例路 2 号', '13810000002', 'sunyue@example.com', 1995, 169, 61, 39);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (3, '马骏', '云顶镇示例路 3 号', '13810000003', NULL, 1988, 173, 64, 40);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (4, '何静怡', '云顶镇示例路 4 号', '13810000004', 'hejy@example.com', 1993, 177, 67, 41);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (5, '罗天成', '云顶镇示例路 5 号', '13810000005', 'luotc@example.com', 1991, 181, 70, 42);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (6, '高翔', '云顶镇示例路 6 号', '13810000006', 'gaox@example.com', 1987, 165, 73, 43);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (7, '唐雪', '云顶镇示例路 7 号', '13810000007', 'tangxue@example.com', 1996, 169, 58, 38);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (8, '冯子墨', '云顶镇示例路 8 号', '13810000008', NULL, 1992, 173, 61, 39);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (9, '曾琳', '云顶镇示例路 9 号', '13810000009', 'zenglin@example.com', 1994, 177, 64, 40);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (10, '许一鸣', '云顶镇示例路 10 号', '13810000010', 'xuym@example.com', 1989, 181, 67, 41);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (11, '邓晴', '云顶镇示例路 11 号', '13810000011', 'dengqing@example.com', 1997, 165, 70, 42);
INSERT INTO customers (customer_id, full_name, address, phone, email, birth_year, height_cm, weight_kg, shoe_size) VALUES (12, '蒋睿', '云顶镇示例路 12 号', '13810000012', NULL, 1993, 169, 73, 43);

-- employees (8 行)
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (1, '林远山', '云顶镇雪松路 8 号', '13800000001', 'lin@xuefeng.example', '总经理');
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (2, '苏晓芸', '云顶镇云杉路 12 号', '13800000002', 'su@xuefeng.example', '运营主管');
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (3, '周子豪', '云顶镇松涛路 3 号', '13800000003', 'zhou@xuefeng.example', '轮岗店员');
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (4, '陈雨桐', '云顶镇雪松路 21 号', '13800000004', 'chen@xuefeng.example', '轮岗店员');
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (5, '王浩然', '云顶镇白桦路 6 号', '13800000005', 'wang@xuefeng.example', '竞技单板选手');
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (6, '李思远', '云顶镇云杉路 30 号', '13800000006', 'li@xuefeng.example', NULL);
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (7, '张敏', '云顶镇松涛路 17 号', '13800000007', 'zhang@xuefeng.example', NULL);
INSERT INTO employees (employee_id, full_name, address, phone, email, notes) VALUES (8, '赵天成', '云顶镇雪松路 5 号', '13800000008', 'zhao@xuefeng.example', NULL);

-- rental_items (36 行)
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (1, 'SN0001', 'Head XTC 滑雪板 #1', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 3, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (2, 'SN0002', 'Head XTC 滑雪板 #2', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 3, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (3, 'SN0003', 'Head XTC 滑雪板 #3', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 3, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (4, 'SN0004', 'Head XTC 滑雪板 #4', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 3, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (5, 'SN0005', 'Rossignol 初级滑雪板 #1', '常规尺码', '滑雪板', '2025-11-15', 800, 1200, 100, 1, 1, 1, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (6, 'SN0006', 'Rossignol 初级滑雪板 #2', '常规尺码', '滑雪板', '2025-11-15', 800, 1200, 100, 1, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (7, 'SN0007', 'Rossignol 初级滑雪板 #3', '常规尺码', '滑雪板', '2025-11-15', 800, 1200, 100, 1, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (8, 'SN0008', 'Salomon 中阶滑雪板 #1', '常规尺码', '滑雪板', '2025-11-15', 1040, 1560, 130, 2, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (9, 'SN0009', 'Salomon 中阶滑雪板 #2', '常规尺码', '滑雪板', '2025-11-15', 1040, 1560, 130, 2, 1, 1, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (10, 'SN0010', 'Salomon 中阶滑雪板 #3', '常规尺码', '滑雪板', '2025-11-15', 1040, 1560, 130, 2, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (11, 'SN0011', 'Nordica 专家滑雪板 #1', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 4, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (12, 'SN0012', 'Nordica 专家滑雪板 #2', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 4, 2, 2, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (13, 'SN0013', 'Nordica 专家滑雪板 #3', '常规尺码', '滑雪板', '2025-11-15', 1600, 2400, 200, 4, 1, 1, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (14, 'SN0014', '雪杖 #1', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (15, 'SN0015', '雪杖 #2', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (16, 'SN0016', '雪杖 #3', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (17, 'SN0017', '雪杖 #4', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (18, 'SN0018', '雪杖 #5', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (19, 'SN0019', '雪杖 #6', '成对出租', '雪杖', '2025-11-15', 240, 360, 30, NULL, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (20, 'SN0020', '单板 Burton 中级 #1', '常规尺码', '单板', '2025-11-15', 1200, 1800, 150, 2, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (21, 'SN0021', '单板 Burton 中级 #2', '常规尺码', '单板', '2025-11-15', 1200, 1800, 150, 2, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (22, 'SN0022', '单板 Burton 中级 #3', '常规尺码', '单板', '2025-11-15', 1200, 1800, 150, 2, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (23, 'SN0023', '单板 入门 #1', '常规尺码', '单板', '2025-11-15', 720, 1080, 90, 1, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (24, 'SN0024', '单板 入门 #2', '常规尺码', '单板', '2025-11-15', 720, 1080, 90, 1, 2, 2, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (25, 'SN0025', '单板 入门 #3', '常规尺码', '单板', '2025-11-15', 720, 1080, 90, 1, 1, 1, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (26, 'SN0026', '雪靴 Head 26 #1', '常规尺码', '雪靴', '2025-11-15', 640, 960, 80, NULL, 2, 2, '借出中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (27, 'SN0027', '雪靴 Head 26 #2', '常规尺码', '雪靴', '2025-11-15', 640, 960, 80, NULL, 1, 1, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (28, 'SN0028', '雪靴 Head 26 #3', '常规尺码', '雪靴', '2025-11-15', 640, 960, 80, NULL, 2, 2, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (29, 'SN0029', '雪靴 Head 26 #4', '常规尺码', '雪靴', '2025-11-15', 640, 960, 80, NULL, 1, 1, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (30, 'SN0030', '雪靴 Head 26 #5', '常规尺码', '雪靴', '2025-11-15', 640, 960, 80, NULL, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (31, 'SN0031', '护目镜 #1', '常规尺码', '护目镜', '2025-11-15', 200, 300, 25, NULL, 1, 1, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (32, 'SN0032', '护目镜 #2', '常规尺码', '护目镜', '2025-11-15', 200, 300, 25, NULL, 2, 2, '维修中');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (33, 'SN0033', '护目镜 #3', '常规尺码', '护目镜', '2025-11-15', 200, 300, 25, NULL, 1, 1, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (34, 'SN0034', '头盔 M #1', '常规尺码', '头盔', '2025-11-15', 200, 300, 25, NULL, 2, 2, '在库');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (35, 'SN0035', '头盔 M #2', '常规尺码', '头盔', '2025-11-15', 200, 300, 25, NULL, 1, 1, '已报废');
INSERT INTO rental_items (item_id, item_code, name, description, category, purchase_date, purchase_cost, retail_price, daily_rate, skill_level_id, home_store_id, current_store_id, status) VALUES (36, 'SN0036', '头盔 M #3', '常规尺码', '头盔', '2025-11-15', 200, 300, 25, NULL, 2, 2, '已报废');

-- contractors (3 行)
INSERT INTO contractors (contractor_id, name, address, phone, email) VALUES (1, '峰顶装备维修', '云顶工业园 A 栋', '13900000001', 'service@fengding.example');
INSERT INTO contractors (contractor_id, name, address, phone, email) VALUES (2, '极速雪具工坊', '云顶工业园 B 栋', '13900000002', 'speed@jisu.example');
INSERT INTO contractors (contractor_id, name, address, phone, email) VALUES (3, '雪山维护中心', '云顶镇南街 9 号', '13900000003', 'maint@xueshan.example');

-- contractor_rates (6 行)
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (1, 1, '2026-01-01', 180);
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (2, 1, '2026-07-01', 200);
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (3, 2, '2026-01-01', 160);
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (4, 2, '2026-07-01', 175);
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (5, 3, '2026-01-01', 150);
INSERT INTO contractor_rates (rate_id, contractor_id, effective_date, hourly_rate) VALUES (6, 3, '2026-07-01', 165);

-- rental_contracts (15 行)
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (1, 'RC20260801-0001', 1, 2, '2026-08-01', 3, 1590, '2026-08-03T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (2, 'RC20260805-0002', 2, 3, '2026-08-05', 2, 360, '2026-08-06T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (3, 'RC20260808-0003', 3, 4, '2026-08-08', 4, 960, '2026-08-11T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (4, 'RC20260812-0004', 4, 3, '2026-08-12', 2, 100, '2026-08-13T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (5, 'RC20260815-0005', 5, 4, '2026-08-15', 3, 385, '2026-08-17T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (6, 'RC20260818-0006', 6, 2, '2026-08-18', 2, 450, '2026-08-19T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (7, 'RC20260820-0007', 7, 3, '2026-08-20', 5, 3000, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (8, 'RC20260822-0008', 8, 4, '2026-08-22', 3, 1130, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (9, 'RC20260823-0009', 9, 3, '2026-08-23', 2, 120, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (10, 'RC20260824-0010', 10, 2, '2026-08-24', 4, 360, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (11, 'RC20260824-0011', 11, 4, '2026-08-24', 2, 600, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (12, 'RC20260825-0012', 12, 3, '2026-08-25', 3, 780, NULL, '进行中');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (13, 'RC20260710-0013', 1, 2, '2026-07-10', 3, 690, '2026-07-12T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (14, 'RC20260715-0014', 5, 3, '2026-07-15', 2, 320, '2026-07-16T18:00:00', '已完成');
INSERT INTO rental_contracts (contract_id, contract_no, customer_id, employee_id, contract_date, duration_days, total_amount, completed_at, status) VALUES (15, 'RC20260720-0015', 9, 4, '2026-07-20', 4, 520, '2026-07-23T18:00:00', '已完成');

-- contract_lines (39 行)
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (1, 1, 2, 1, 200, '2026-08-01T09:00:00', 2, '2026-08-03T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (2, 1, 8, 1, 130, '2026-08-01T09:07:00', 2, '2026-08-03T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (3, 1, 13, 1, 200, '2026-08-01T09:14:00', 1, '2026-08-03T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (4, 2, 14, 1, 30, '2026-08-05T09:00:00', 2, '2026-08-06T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (5, 2, 20, 1, 150, '2026-08-05T09:07:00', 2, '2026-08-06T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (6, 3, 27, 1, 80, '2026-08-08T09:00:00', 1, '2026-08-11T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (7, 3, 29, 1, 80, '2026-08-08T09:07:00', 1, '2026-08-11T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (8, 3, 30, 1, 80, '2026-08-08T09:14:00', 2, '2026-08-11T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (9, 4, 31, 1, 25, '2026-08-12T09:00:00', 1, '2026-08-13T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (10, 4, 33, 1, 25, '2026-08-12T09:07:00', 1, '2026-08-13T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (11, 5, 34, 1, 25, '2026-08-15T09:00:00', 2, '2026-08-17T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (12, 5, 20, 1, 150, '2026-08-15T09:07:00', 2, '2026-08-16T14:00:00', 2, '已更换');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (13, 5, 27, 1, 80, '2026-08-16T14:00:00', 1, '2026-08-17T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (14, 6, 34, 1, 25, '2026-08-18T09:00:00', 2, '2026-08-19T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (15, 6, 2, 1, 200, '2026-08-18T09:07:00', 2, '2026-08-19T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (16, 7, 1, 1, 200, '2026-08-20T09:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (17, 7, 3, 1, 200, '2026-08-20T09:07:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (18, 7, 4, 1, 200, '2026-08-20T09:14:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (19, 8, 6, 1, 100, '2026-08-22T09:00:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (20, 8, 7, 1, 100, '2026-08-22T09:07:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (21, 8, 10, 1, 130, '2026-08-22T09:14:00', 2, '2026-08-23T14:00:00', 2, '已更换');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (22, 8, 11, 1, 200, '2026-08-23T14:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (23, 9, 15, 1, 30, '2026-08-23T09:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (24, 9, 16, 1, 30, '2026-08-23T09:07:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (25, 10, 17, 1, 30, '2026-08-24T09:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (26, 10, 18, 1, 30, '2026-08-24T09:07:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (27, 10, 19, 1, 30, '2026-08-24T09:14:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (28, 11, 21, 1, 150, '2026-08-24T09:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (29, 11, 22, 1, 150, '2026-08-24T09:07:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (30, 12, 23, 1, 90, '2026-08-25T09:00:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (31, 12, 25, 1, 90, '2026-08-25T09:07:00', 1, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (32, 12, 26, 1, 80, '2026-08-25T09:14:00', 2, NULL, NULL, '借出中');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (33, 13, 13, 1, 200, '2026-07-10T09:00:00', 1, '2026-07-12T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (34, 13, 14, 1, 30, '2026-07-10T09:07:00', 2, '2026-07-12T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (35, 14, 27, 1, 80, '2026-07-15T09:00:00', 1, '2026-07-16T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (36, 14, 29, 1, 80, '2026-07-15T09:07:00', 1, '2026-07-16T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (37, 15, 30, 1, 80, '2026-07-20T09:00:00', 2, '2026-07-23T17:00:00', 2, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (38, 15, 31, 1, 25, '2026-07-20T09:07:00', 1, '2026-07-23T17:00:00', 1, '已归还');
INSERT INTO contract_lines (contract_line_id, contract_id, item_id, quantity, daily_rate, checkout_time, checkout_store_id, return_time, return_store_id, status) VALUES (39, 15, 33, 1, 25, '2026-07-20T09:14:00', 1, '2026-07-23T17:00:00', 1, '已归还');

-- contract_changes (4 行)
INSERT INTO contract_changes (change_id, contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note) VALUES (1, 5, 1, '2026-08-16T14:00:00', '归还', 20, 1, -140, '更换为更低价位装备（退款）');
INSERT INTO contract_changes (change_id, contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note) VALUES (2, 5, 1, '2026-08-16T14:00:00', '增加', 27, 1, NULL, '更换为更低价位装备（退款）');
INSERT INTO contract_changes (change_id, contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note) VALUES (3, 8, 2, '2026-08-23T14:00:00', '归还', 10, 1, 140, '升级至更高价款装备');
INSERT INTO contract_changes (change_id, contract_id, change_group_id, change_date, change_type, item_id, quantity, amount_delta, note) VALUES (4, 8, 2, '2026-08-23T14:00:00', '增加', 11, 1, NULL, '升级至更高价款装备');

-- repair_orders (10 行)
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (1, 2, 1, 2, '2026-08-18', '固定器卡扣松动', '2026-08-20', 1.5, 300, '更换卡扣', '已完成');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (2, 8, 2, 4, '2026-08-20', '板底划痕打磨', '2026-08-22', 2, 350, NULL, '已完成');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (3, 14, 3, 6, '2026-08-21', '雪杖杖尖磨损', '2026-08-23', 1, 165, NULL, '已完成');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (4, 20, 1, 2, '2026-08-23', '单板固定器调节', '2026-08-24', 0.5, 100, NULL, '已完成');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (5, 5, 2, 4, '2026-08-24', '初级滑雪板板刃卷边', NULL, NULL, NULL, NULL, '维修中');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (6, 9, 1, 2, '2026-08-24', '中阶滑雪板蜡层脱落', NULL, NULL, NULL, NULL, '维修中');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (7, 12, 3, 6, '2026-08-25', '专家滑雪板板刃崩口', NULL, NULL, NULL, NULL, '待维修');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (8, 24, 2, 4, '2026-08-25', '入门单板边刃开胶', NULL, NULL, NULL, NULL, '待维修');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (9, 28, 1, 2, '2026-08-25', '雪靴内胆开胶', NULL, NULL, NULL, NULL, '待维修');
INSERT INTO repair_orders (repair_id, item_id, contractor_id, rate_id, request_date, fault_description, repair_date, repair_hours, calculated_cost, notes, status) VALUES (10, 32, 3, 6, '2026-08-25', '护目镜镜片更换', NULL, NULL, NULL, NULL, '待维修');

-- shifts (42 行)
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (1, 1, 1, '2026-08-19', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (2, 2, 2, '2026-08-19', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (3, 3, 1, '2026-08-19', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (4, 4, 2, '2026-08-19', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (5, 5, 1, '2026-08-19', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (6, 6, 2, '2026-08-19', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (7, 1, 1, '2026-08-20', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (8, 2, 2, '2026-08-20', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (9, 3, 1, '2026-08-20', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (10, 4, 2, '2026-08-20', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (11, 5, 1, '2026-08-20', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (12, 6, 2, '2026-08-20', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (13, 1, 1, '2026-08-21', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (14, 2, 2, '2026-08-21', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (15, 3, 1, '2026-08-21', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (16, 4, 2, '2026-08-21', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (17, 5, 1, '2026-08-21', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (18, 6, 2, '2026-08-21', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (19, 1, 1, '2026-08-22', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (20, 2, 2, '2026-08-22', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (21, 3, 1, '2026-08-22', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (22, 4, 2, '2026-08-22', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (23, 5, 1, '2026-08-22', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (24, 6, 2, '2026-08-22', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (25, 1, 1, '2026-08-23', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (26, 2, 2, '2026-08-23', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (27, 3, 1, '2026-08-23', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (28, 4, 2, '2026-08-23', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (29, 5, 1, '2026-08-23', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (30, 6, 2, '2026-08-23', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (31, 1, 1, '2026-08-24', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (32, 2, 2, '2026-08-24', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (33, 3, 1, '2026-08-24', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (34, 4, 2, '2026-08-24', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (35, 5, 1, '2026-08-24', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (36, 6, 2, '2026-08-24', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (37, 1, 1, '2026-08-25', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (38, 2, 2, '2026-08-25', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (39, 3, 1, '2026-08-25', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (40, 4, 2, '2026-08-25', '12:00', '20:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (41, 5, 1, '2026-08-25', '08:00', '16:00');
INSERT INTO shifts (shift_id, employee_id, store_id, work_date, start_time, end_time) VALUES (42, 6, 2, '2026-08-25', '12:00', '20:00');

-- accounts (3 行) —— 放在 employees、contractors 之后，满足外键依赖
INSERT INTO accounts (account_id, uid, username, role, employee_id, contractor_id, enabled) VALUES (1, NULL, 'admin', 'admin', 1, NULL, true);
INSERT INTO accounts (account_id, uid, username, role, employee_id, contractor_id, enabled) VALUES (2, NULL, 'staff', 'staff', 2, NULL, true);
INSERT INTO accounts (account_id, uid, username, role, employee_id, contractor_id, enabled) VALUES (3, NULL, 'contractor', 'contractor', NULL, 1, true);

-- ============================================================
-- 同步 identity 序列，避免后续新增产生重复主键
-- ============================================================
SELECT setval(pg_get_serial_sequence('accounts', 'account_id'), (SELECT MAX(account_id) FROM accounts));
SELECT setval(pg_get_serial_sequence('skill_levels', 'skill_level_id'), (SELECT MAX(skill_level_id) FROM skill_levels));
SELECT setval(pg_get_serial_sequence('stores', 'store_id'), (SELECT MAX(store_id) FROM stores));
SELECT setval(pg_get_serial_sequence('customers', 'customer_id'), (SELECT MAX(customer_id) FROM customers));
SELECT setval(pg_get_serial_sequence('employees', 'employee_id'), (SELECT MAX(employee_id) FROM employees));
SELECT setval(pg_get_serial_sequence('rental_items', 'item_id'), (SELECT MAX(item_id) FROM rental_items));
SELECT setval(pg_get_serial_sequence('contractors', 'contractor_id'), (SELECT MAX(contractor_id) FROM contractors));
SELECT setval(pg_get_serial_sequence('contractor_rates', 'rate_id'), (SELECT MAX(rate_id) FROM contractor_rates));
SELECT setval(pg_get_serial_sequence('rental_contracts', 'contract_id'), (SELECT MAX(contract_id) FROM rental_contracts));
SELECT setval(pg_get_serial_sequence('contract_lines', 'contract_line_id'), (SELECT MAX(contract_line_id) FROM contract_lines));
SELECT setval(pg_get_serial_sequence('contract_changes', 'change_id'), (SELECT MAX(change_id) FROM contract_changes));
SELECT setval(pg_get_serial_sequence('repair_orders', 'repair_id'), (SELECT MAX(repair_id) FROM repair_orders));
SELECT setval(pg_get_serial_sequence('shifts', 'shift_id'), (SELECT MAX(shift_id) FROM shifts));

-- 同步业务序列（并发安全 ID 来源），避免与种子显式值冲突：
--   contract_no_seq  → 现有合同编号最大全局序号
--   change_group_seq → 现有换货变更最大组号
SELECT setval('contract_no_seq', (SELECT COALESCE(MAX((substring(contract_no FROM '-([0-9]+)$'))::bigint), 0) FROM rental_contracts));
SELECT setval('change_group_seq', (SELECT COALESCE(MAX(change_group_id), 0) FROM contract_changes));
