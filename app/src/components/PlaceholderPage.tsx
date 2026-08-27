import { Empty } from 'tdesign-react'
import { PageHeader } from './PageHeader'

interface PlaceholderPageProps {
  title: string
  description: string
}

/** 业务页面规范化占位状态：后续批次实现 CRUD 前，先展示清晰的"未实现"提示 */
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div>
      <PageHeader title={title} />
      <div
        style={{
          background: 'var(--snowpeak-bg-container)',
          border: '1px solid var(--snowpeak-border)',
          borderRadius: 8,
          padding: '48px 24px',
        }}
      >
        <Empty description={description} />
      </div>
    </div>
  )
}
