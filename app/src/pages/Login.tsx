import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, MessagePlugin, Tag } from 'tdesign-react'
import { useAuth } from '../auth/AuthContext'
import { roleHome } from '../auth/permissions'
import { demoTag } from '../theme'

interface DemoAccount {
  username: string
  password: string
  roleLabel: string
}

const demoAccounts: DemoAccount[] = [
  { username: 'admin', password: 'demo123', roleLabel: '管理员' },
  { username: 'staff', password: 'demo123', roleLabel: '店员' },
  { username: 'contractor', password: 'demo123', roleLabel: '承包商' },
]

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  color: 'var(--snowpeak-text)',
}

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 单一数据源：完全由 React state 控制，登录/回车共用此入口
  const handleSubmit = () => {
    if (submitting) return
    if (!username.trim() || !password) {
      MessagePlugin.warning('请输入用户名和密码')
      return
    }
    setSubmitting(true)
    const result = login(username, password)
    if (result.ok && result.role) {
      MessagePlugin.success('登录成功')
      navigate(roleHome[result.role], { replace: true })
    } else {
      MessagePlugin.error(result.error ?? '登录失败')
      setSubmitting(false)
    }
  }

  const fillDemo = (acc: DemoAccount) => {
    setUsername(acc.username)
    setPassword(acc.password)
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* 左侧品牌区 */}
      <div
        className="login-brand"
        style={{
          flex: '0 0 40%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 48px',
          color: '#fff',
        }}
      >
        <div className="font-serif" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.4 }}>
          雪峰滑雪租赁
        </div>
        <div className="font-serif" style={{ fontSize: 16, color: '#9FE1CB', marginTop: 8 }}>
          SnowPeak Ski Rental
        </div>
        <div className="snowline" style={{ width: 120, marginTop: 20 }} />
        <p style={{ marginTop: 24, fontSize: 13, color: '#9FE1CB', maxWidth: 360, lineHeight: 1.7 }}>
          面向门店店员与维修承包商的教学演示型运营后台。演示客户、设备、合同、换货、归还与维修的完整业务闭环。
        </p>
      </div>

      {/* 右侧登录卡 */}
      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          background: 'var(--snowpeak-bg-page)',
          padding: '0 64px',
        }}
      >
        <div style={{ width: 360 }}>
          <div style={{ marginBottom: 8 }}>
            <Tag
              variant="light-outline"
              style={{ color: demoTag.color, background: demoTag.bg, borderColor: demoTag.bg }}
            >
              教学演示环境
            </Tag>
          </div>
          <h2 className="font-serif" style={{ margin: '0 0 24px', fontSize: 22, fontWeight: 600 }}>
            登录
          </h2>

          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabelStyle}>
              用户名
            </label>
            <Input
              value={username}
              onChange={(v) => setUsername(String(v))}
              placeholder="请输入用户名"
              clearable
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabelStyle}>
              密码
            </label>
            <Input
              type="password"
              value={password}
              onChange={(v) => setPassword(String(v))}
              placeholder="请输入密码"
              onEnter={handleSubmit}
            />
          </div>
          <Button
            theme="primary"
            block
            loading={submitting}
            onClick={handleSubmit}
            style={{ marginTop: 8, minWidth: 96 }}
          >
            登录
          </Button>

          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 13, color: 'var(--snowpeak-text-secondary)', marginBottom: 12 }}>
              演示账号（点击填充）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {demoAccounts.map((acc) => (
                <button
                  key={acc.username}
                  type="button"
                  onClick={() => fillDemo(acc)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    background: '#fff',
                    border: '1px solid var(--snowpeak-border)',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                >
                  <span className="font-mono" style={{ color: 'var(--snowpeak-text)' }}>
                    {acc.username} / {acc.password}
                  </span>
                  <span style={{ color: 'var(--snowpeak-text-secondary)' }}>{acc.roleLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
