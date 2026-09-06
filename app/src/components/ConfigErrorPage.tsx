/**
 * 配置错误阻塞页（fail-closed）。
 * 当 dataMode 非法或 cloud 模式缺少必填配置时渲染，替代正常应用。
 * 只展示安全的错误信息（仅变量名，无任何值/密钥），不进入登录或业务。
 */

export function ConfigErrorPage({ message }: { message: string }) {
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
        应用配置错误，已停止启动
      </div>
      <p
        style={{
          color: 'var(--snowpeak-text-secondary)',
          fontSize: 13,
          maxWidth: 460,
          textAlign: 'center',
          margin: 0,
          lineHeight: 1.8,
        }}
      >
        {message}
      </p>
      <p
        style={{
          color: 'var(--snowpeak-text-placeholder)',
          fontSize: 12,
          maxWidth: 460,
          textAlign: 'center',
          margin: 0,
          lineHeight: 1.8,
        }}
      >
        请检查部署环境变量或 .env.local 后重启应用。为避免泄露密钥，本页不会显示任何配置值。
      </p>
    </div>
  )
}
