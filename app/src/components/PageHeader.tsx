interface PageHeaderProps {
  title: string
  subtitle?: string
}

/** 页面标题栏 */
export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' }}>{title}</h2>
      {subtitle ? (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--snowpeak-text-secondary)' }}>
          {subtitle}
        </p>
      ) : null}
    </div>
  )
}
