# 雪峰滑雪租赁管理系统（SnowPeak Ski Rental）

教学演示型网页系统 · 案例 01 · 第一版（单机教学演示）

> 本系统为本科《系统分析与设计》/ MBA《管理信息系统》教学案例的自编改写版，全部数据为虚构内容，仅用于课堂演示。

## 技术栈

- React 18 + Vite + TypeScript
- TDesign React + TDesign Icons
- React Router（BrowserRouter）
- ECharts + echarts-for-react（驾驶舱，后续批次接入）
- 数据层：DataService + localStorage（本地模拟，预留迁移 CloudBase PostgreSQL 接口边界）

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器
npm run dev
# 浏览器访问 http://localhost:5173
```

## 演示账号

| 账号 | 密码 | 角色 | 登录后首页 |
| --- | --- | --- | --- |
| admin | demo123 | 管理员 | /dashboard |
| staff | demo123 | 店员 | /dashboard |
| contractor | demo123 | 承包商 | /repairs |

> 密码为教学演示占位，不构成真实认证。

## 常用命令

```bash
npm run dev        # 开发服务器
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览生产构建
```

## 重置演示数据

登录后在全局顶栏右上角的**用户菜单**（点击当前用户名）中点击「重置演示数据」，可将 localStorage 中的演示数据恢复为内置种子数据（需二次确认）。

## 目录结构

```
src/
├─ main.tsx            # 入口
├─ App.tsx             # 路由与权限骨架
├─ theme.ts            # 设计令牌（颜色/字体/间距）
├─ styles/global.css   # 全局样式
├─ data/
│  ├─ types.ts         # 领域类型（13 个实体）
│  ├─ storage.ts       # localStorage 适配器
│  ├─ db.ts            # 数据库版本 / 初始化 / 重置 / 损坏处理
│  ├─ seed.ts          # 种子数据
│  └─ dataService.ts   # 数据访问层（模拟表 + 约束 + 业务方法）
├─ auth/
│  ├─ permissions.ts   # 权限配置（集中管理）
│  └─ AuthContext.tsx  # 登录态与会话
├─ components/
│  ├─ AppLayout.tsx    # 后台公共布局
│  ├─ ProtectedRoute.tsx
│  ├─ RoleGuard.tsx
│  ├─ PageHeader.tsx
│  └─ PlaceholderPage.tsx
├─ pages/              # 页面（本批为占位）
└─ utils/              # 工具（编号/日期/金额/分页）
```

## 说明

- **模拟登录**：账号表 + 占位密码校验，非真实认证。
- **权限**：UI + 服务层模拟，非安全边界。
- **多人协作 / 并发**：未实现（单机 localStorage）。
- 迁移到 CloudBase PostgreSQL 的接口边界见 `../docs/03-系统设计.md` §7。
