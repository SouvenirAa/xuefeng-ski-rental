import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// TDesign 全局样式（design tokens + 公共样式）必须在前，项目自定义样式在后覆盖
import 'tdesign-react/es/style/index.css'
import './styles/global.css'

// 数据层初始化由 DbProvider 负责，不在此处调用

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
