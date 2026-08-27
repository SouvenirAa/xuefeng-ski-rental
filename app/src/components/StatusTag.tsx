import { Tag } from 'tdesign-react'
import { statusColorMap } from '../theme'

interface StatusTagProps {
  status: string
}

/** 状态标签：色点 + 文字双通道，不单靠颜色区分（可访问性） */
export function StatusTag({ status }: StatusTagProps) {
  const conf = statusColorMap[status]
  const color = conf?.color ?? '#5A6268'
  const bg = conf?.bg ?? '#F5F7F6'

  return (
    <Tag
      variant="light"
      style={{ color, background: bg, borderColor: 'transparent', fontWeight: 600 }}
    >
      {status}
    </Tag>
  )
}
