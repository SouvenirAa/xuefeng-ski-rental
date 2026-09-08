# 雪峰滑雪租赁管理系统

> 本科《系统分析与设计》与 MBA《管理信息系统》课程教学案例  
> 当前版本：完整教学演示系统（本地 + CloudBase PostgreSQL 双模式，已部署上线）

## 项目简介

本项目将滑雪租赁企业案例中的业务需求、数据表和业务规则，转化为一个可以实际运行的网页管理系统，用于演示从需求分析、数据设计、系统设计到 AI 辅助实现、云端迁移与端到端验收的完整过程。

项目使用 **WorkBuddy + 国产大模型** 辅助开发，采用 React 18 + TypeScript + Vite + TDesign + ECharts 技术栈。系统支持两种数据模式，由环境变量 `VITE_DATA_MODE` 控制：

- **local 模式**：无需服务器，业务数据保存在浏览器 `localStorage`，便于课堂演示与快速上手；
- **cloud 模式**：接入腾讯云 CloudBase（Auth 登录 + PostgreSQL 数据库 + 静态托管），具备真实登录、行级安全（RLS）与多人协作能力。

所有人物、门店、合同及业务数据均为虚构内容，仅用于课堂教学。

## 线上访问

已部署至 CloudBase 静态托管（生产构建，cloud 模式）：

> <https://snowpeak-rental-d6fao36oc26a8db9-1453395692.tcloudbaseapp.com/>

首次访问为 CloudBase 测试域名，会先出现「风险提醒」提示页，点击「确定访问」即可进入系统。

## 当前进度

| 模块 | 当前状态 | 已实现内容 |
| --- | --- | --- |
| 需求、数据与系统设计 | ✅ 已完成 | 需求分析、ER/关系模型、数据字典、权限矩阵、系统架构、界面规范与追踪矩阵 |
| 系统基础 | ✅ 已完成 | 登录、角色路由、403、统一布局、数据初始化、损坏恢复、重置演示数据 |
| 基础资料 | ✅ 已完成 | 客户、设备、门店的查询、校验和权限化增删改 |
| 人力与外包 | ✅ 已完成 | 承包商、历史费率、员工与排班管理 |
| 租赁合同 | ✅ 已完成 | 创建合同、价格快照、换货差价、部分/批量归还、跨店归还、合同完成 |
| 维修单 | ✅ 已完成 | 创建维修单、冻结费率、承包商开始/完成维修、成本计算、设备状态联动 |
| 管理驾驶舱 | ✅ 已完成 | KPI 卡片（利用率 / 营收 / 周转）与门店库存分布 ECharts 图表 |
| CloudBase 迁移 | ✅ 已完成 | Auth 登录、PostgreSQL 读写、RLS 行级安全、SECURITY DEFINER RPC、静态托管部署 |

## 已实现的业务流程

### 租赁流程

1. 店员或管理员选择客户与在库设备创建合同。
2. 合同保存时固化设备日租金快照并将设备改为“借出中”。
3. 租赁期间可进行换货，系统按剩余天数和合同价格快照计算补收或退款。
4. 支持部分归还、批量归还和跨门店归还。
5. 所有有效明细归还后，合同自动转为“已完成”。

### 维修流程

1. 管理员或店员为在库设备创建维修单。
2. 系统按申请日期冻结承包商当时的小时费率，并将设备改为“维修中”。
3. 被分配的承包商只能查看和处理自己的维修单。
4. 维修完成时按冻结费率与维修工时计算成本，设备恢复为“在库”。

## 角色与演示账号

| 账号 | 角色 | 主要权限 |
| --- | --- | --- |
| `admin` | 管理员 | 基础资料、人力、合同、维修单和系统管理 |
| `staff` | 店员 | 客户、合同和维修单操作；设备只读 |
| `contractor` | 承包商 | 只查看并处理分配给自己的维修单 |

密码分两种模式：

- **local 模式**：三角色密码均为 `demo1234`（教学占位，仅用于本地演示）。
- **cloud 模式**：密码在 CloudBase「身份认证」控制台按账号单独设置（须满足 ≥8 位规则），不写入仓库。

## 技术栈

- React 18 + TypeScript + Vite 5
- TDesign React / TDesign Icons
- React Router 6
- ECharts + echarts-for-react
- 数据层：`DataService`（local）与 CloudBase PostgreSQL（cloud）双实现，统一视图模型
- CloudBase：Auth 登录、PostgreSQL（RLS + RPC）、静态托管
- ESLint + 自定义业务校验脚本

## 快速运行

### 环境要求

- Node.js 18 或更高版本
- npm

### 本地模式（默认，无需服务器）

```bash
cd app
npm install
npm run dev
```

浏览器访问：<http://localhost:5173>

### 云端模式（接入 CloudBase）

1. 在 `app` 目录下创建 `.env.local`（模板见 `.env.example`），填入：
   - `VITE_CLOUDBASE_ENV_ID`：CloudBase 环境 ID
   - `VITE_CLOUDBASE_REGION`：地域（如 `ap-shanghai`）
   - `VITE_CLOUDBASE_ACCESS_KEY`：匿名访问令牌
   - `VITE_DATA_MODE=cloud`
2. 确保云端 PostgreSQL 已按 `cloudbase/migrations/` 应用迁移（4 个 migration）。
3. 启动开发服务器：

```bash
cd app
npm run dev
```

### 生产构建与预览

```bash
cd app
npm run build
npm run preview
```

## 质量检查

进入 `app` 目录后可运行：

```bash
npm run typecheck
npm run lint
npm run build
npm run validate:seed
npm run validate:master
npm run validate:workforce
npm run validate:contracts
npm run validate:repairs
npm run validate:auth
npm run validate:cloud-read
npm run validate:cloud-master-read
npm run validate:cloud-workforce-read
npm run validate:cloud-contract-read
npm run validate:cloud-repair-read
npm run validate:cloud-contractor-write
npm run validate:cloud-workforce-write
npm run validate:cloud-contract-write
npm run validate:cloud-repair-write
npm run validate:cloud-dashboard
npm run audit:migrations
```

当前已通过全部自动化校验：种子数据（正向 1 + 反向 12）、基础资料 50 项、人力与排班 52 项、合同 81 项、维修单 48 项，以及云端读/写逻辑层与迁移审计合计 1600+ 项断言。

## 数据说明

- **local 模式**：演示数据写入浏览器 `localStorage`，刷新后保留，可从右上角用户菜单「重置演示数据」恢复种子；
- **cloud 模式**：数据写入 CloudBase PostgreSQL，由 RLS 行级安全策略约束角色访问，跨浏览器、跨电脑、多人共享；
- 检测到本地数据损坏时，系统会进入数据恢复页面。

## 项目结构

```text
案例01_雪峰滑雪租赁/
├─ README.md                 # 项目总览与当前进度
├─ docs/
│  ├─ 01-需求分析.md
│  ├─ 02-数据设计.md
│  ├─ 03-系统设计.md
│  ├─ 04-阶段0到2回溯审计报告.md
│  ├─ 05-界面设计规范.md
│  ├─ 06-云端E2E验收报告.md
│  └─ 07-教学使用指南.md
├─ cloudbase/
│  └─ migrations/            # PostgreSQL 迁移（建表/RLS/种子/ACL 加固）
└─ app/
   ├─ src/                   # React 页面、权限、数据层（local/cloud 双实现）
   ├─ scripts/               # 数据与服务层自动校验脚本
   ├─ package.json
   └─ README.md              # 应用技术说明
```

## 设计文档

- [需求分析](docs/01-需求分析.md)
- [数据设计](docs/02-数据设计.md)
- [系统设计](docs/03-系统设计.md)
- [阶段 0–2 回溯审计报告](docs/04-阶段0到2回溯审计报告.md)
- [界面设计规范](docs/05-界面设计规范.md)
- [云端 E2E 验收报告](docs/06-云端E2E验收报告.md)
- [教学使用指南](docs/07-教学使用指南.md)

## 当前版本边界

当前仓库用于展示教学案例的完整成果，仍非可直接上线的生产系统：

- **local 模式**：登录与权限为前端模拟，不构成真实安全边界；
- **cloud 模式**：登录与行级安全由 CloudBase Auth + PostgreSQL RLS 提供真实边界，但演示账号密码由课程管理员管理；
- 匿名访问令牌（accessKey）仅用于教学演示环境的只读/受限访问，不应承载生产敏感数据。

## 后续计划

1. 如需多人课堂演示，由课程管理员在 CloudBase 控制台统一管理账号与密码；
2. 按需要补充教学操作手册与案例提示词归档；
3. 可继续扩展自定义域名、CDN 与审计日志等生产化能力。
