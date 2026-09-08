# 雪峰滑雪租赁管理系统（SnowPeak Ski Rental）

教学演示型网页系统 · 案例 01 · 完整版（本地 + CloudBase PostgreSQL 双模式）

> 本系统为本科《系统分析与设计》/ MBA《管理信息系统》教学案例的自编改写版，全部数据为虚构内容，仅用于课堂演示。

## 技术栈

- React 18 + Vite + TypeScript
- TDesign React + TDesign Icons
- React Router（BrowserRouter）
- ECharts + echarts-for-react（驾驶舱）
- 数据层：`DataService`（local）与 CloudBase PostgreSQL（cloud）双实现，统一视图模型与数据源分派
- CloudBase：Auth 登录、PostgreSQL（RLS 行级安全 + SECURITY DEFINER RPC）、静态托管

## 快速启动

### 本地模式（默认）

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（默认 local 模式）
npm run dev
# 浏览器访问 http://localhost:5173
```

### 云端模式

```bash
# 1. 配置环境变量（参考 .env.example）
cp .env.example .env.local
# 编辑 .env.local 填入 envId / region / accessKey，并将 VITE_DATA_MODE 改为 cloud

# 2. 启动
npm run dev
```

## 演示账号

| 账号 | 角色 | 登录后首页 |
| --- | --- | --- |
| admin | 管理员 | /dashboard |
| staff | 店员 | /dashboard |
| contractor | 承包商 | /repairs |

> local 模式密码为 `demo1234`；cloud 模式密码在 CloudBase「身份认证」控制台按账号单独设置（≥8 位），不写入仓库。

## 数据模式

- `VITE_DATA_MODE=local`（默认）：数据存 `localStorage`，登录为模拟校验；
- `VITE_DATA_MODE=cloud`：数据存 CloudBase PostgreSQL，登录走 CloudBase Auth，读写受 RLS 约束，写操作走 SECURITY DEFINER RPC；
- 配置缺失或取值非法时 fail-closed（不静默降级为 local）。

## 常用命令

```bash
npm run dev        # 开发服务器
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览生产构建
npm run validate:* # 各模块服务层/逻辑层自动校验
npm run audit:migrations # 迁移文件静态审计
```

## 重置演示数据（local 模式）

登录后在全局顶栏右上角的**用户菜单**（点击当前用户名）中点击「重置演示数据」，可将 localStorage 中的演示数据恢复为内置种子数据（需二次确认）。cloud 模式下由数据库种子与迁移管理，无此入口。

## 目录结构

```
src/
├─ main.tsx            # 入口
├─ App.tsx             # 路由与权限骨架
├─ theme.ts            # 设计令牌（颜色/字体/间距）
├─ styles/global.css   # 全局样式
├─ data/               # 领域类型 + local/cloud 双实现
│  ├─ types.ts         # 领域类型（13 个实体）
│  ├─ dataService.ts   # 本地数据访问层（模拟表 + 约束 + 业务方法）
│  ├─ cloudMaster.ts / cloudContracts.ts / cloudRepairs.ts / cloudContractors.ts / cloudWorkforce.ts / cloudDashboard.ts
│  ├─ cloud*Mutations.ts  # 云端写操作（RPC）
│  └─ *DataSource.ts   # 数据源分派（local/cloud 统一出口）
├─ auth/
│  ├─ permissions.ts   # 权限配置（集中管理）
│  └─ AuthContext.tsx  # 登录态与会话（双模式）
├─ components/         # 布局、路由守卫、页面头、状态标签等
├─ hooks/              # useCustomers / useMasterData / useRepairs 等数据 Hook
├─ pages/              # 各业务页面（客户/设备/门店/承包商/员工/合同/维修/驾驶舱）
└─ utils/              # 工具（编号/日期/金额/分页）
```

## 说明

- **local 模式**：登录为账号表 + 占位密码校验，非真实认证；权限为 UI + 服务层模拟。
- **cloud 模式**：登录为 CloudBase Auth，行级安全由 PostgreSQL RLS 保障，写操作由 SECURITY DEFINER RPC 完成，具备多人协作能力。
- 迁移细节与架构边界见 `../docs/03-系统设计.md` 与 `../cloudbase/migrations/`。
