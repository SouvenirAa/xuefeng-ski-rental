import { Button, MessagePlugin } from 'tdesign-react'
import { useDb, type DbErrorReason } from '../data/DbContext'

const reasonText: Record<DbErrorReason, string> = {
  corrupted: '本地演示数据已损坏，无法读取',
  'version-mismatch': '本地演示数据版本不匹配，需要重置',
}

export function DataRecovery() {
  const { reason, reset } = useDb()

  const handleReset = () => {
    reset()
    MessagePlugin.success('演示数据已重置')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
        padding: 24,
      }}
    >
      <div className="font-serif" style={{ fontSize: 20, fontWeight: 600 }}>
        雪峰滑雪租赁
      </div>
      <div style={{ color: 'var(--snowpeak-danger)', fontSize: 14 }}>
        {reason ? reasonText[reason] : '本地演示数据异常'}
      </div>
      <p style={{ color: 'var(--snowpeak-text-secondary)', fontSize: 13, maxWidth: 420, textAlign: 'center', margin: 0 }}>
        你可以重置演示数据以恢复内置种子数据，重置后即可正常进入系统。
      </p>
      <Button theme="primary" onClick={handleReset}>
        重置演示数据
      </Button>
    </div>
  )
}
