/** 金额与日期格式化工具 */

/** 金额：人民币，千分位 + 保留 2 位小数 */
export function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}¥${abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** 日期字符串（YYYY-MM-DD）显示为中文日期 */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日期时间字符串显示 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 今天（本地时区 YYYY-MM-DD） */
export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当前时间 ISO 字符串（本地时区） */
export function nowISO(): string {
  return new Date().toISOString()
}

/** 判断两个日期是否同一自然日 */
export function isSameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10)
}
