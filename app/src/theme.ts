/**
 * 设计令牌 —— 严格遵循 docs/05-界面设计规范.md §3 视觉规范。
 * 主题：工业实用主义「雪线」；主色松绿 + 冰川蓝，规避紫色渐变。
 */
export const colors = {
  primary: '#17402F',
  primaryHover: '#1F4D3A',
  primarySubtle: '#E8F0EC',
  primaryDeep: '#0E2A1F',
  accent: '#17617D',
  accentSubtle: '#E6F0F4',
  success: '#2E7D5B',
  successSubtle: '#E8F3ED',
  warning: '#C77B2E',
  warningSubtle: '#FBF1E3',
  danger: '#B5483A',
  dangerSubtle: '#FAEAE6',
  disabled: '#6B7278',
  textPrimary: '#1F2428',
  textSecondary: '#5A6268',
  textPlaceholder: '#8A9299',
  border: '#D7DCDA',
  bgPage: '#F5F7F6',
  bgContainer: '#FFFFFF',
} as const

export const fonts = {
  serif: "'Noto Serif SC', 'Songti SC', 'SimSun', serif",
  sans: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  mono: "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace",
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const

export const radius = {
  card: 8,
  control: 6,
  tag: 4,
} as const

/** 状态 → 颜色映射（用于状态色点 Tag，配合文字，不单靠颜色） */
export const statusColorMap: Record<string, { color: string; bg: string }> = {
  在库: { color: colors.success, bg: colors.successSubtle },
  已归还: { color: colors.success, bg: colors.successSubtle },
  已完成: { color: colors.success, bg: colors.successSubtle },
  借出中: { color: colors.accent, bg: colors.accentSubtle },
  维修中: { color: colors.accent, bg: colors.accentSubtle },
  待维修: { color: colors.warning, bg: colors.warningSubtle },
  已更换: { color: colors.textSecondary, bg: colors.bgPage },
  已报废: { color: colors.disabled, bg: colors.bgPage },
  停用: { color: colors.disabled, bg: colors.bgPage },
} as const

/** 页面「教学演示环境」标识配色 */
export const demoTag = {
  color: '#5F3B0A',
  bg: '#FBF1E3',
} as const
