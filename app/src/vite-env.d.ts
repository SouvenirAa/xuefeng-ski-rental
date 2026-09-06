/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CloudBase 环境 ID（公开） */
  readonly VITE_CLOUDBASE_ENV_ID?: string
  /** CloudBase 地域（公开） */
  readonly VITE_CLOUDBASE_REGION?: string
  /** CloudBase Publishable Key（公开，非密钥） */
  readonly VITE_CLOUDBASE_ACCESS_KEY?: string
  /** 数据模式：local = 本地演示，cloud = CloudBase 后端 */
  readonly VITE_DATA_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
