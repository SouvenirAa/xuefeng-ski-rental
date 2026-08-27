import { Button, Empty } from 'tdesign-react'
import { useNavigate } from 'react-router-dom'

export function NotFound() {
  const navigate = useNavigate()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
      }}
    >
      <Empty description="页面不存在（404）" />
      <Button theme="primary" onClick={() => navigate('/dashboard', { replace: true })}>
        返回首页
      </Button>
    </div>
  )
}
