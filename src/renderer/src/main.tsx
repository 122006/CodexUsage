import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

if (new URLSearchParams(location.search).get('window') === 'widget') document.documentElement.classList.add('widget-page')

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo): void { console.error('面板渲染失败', error, info.componentStack) }
  render(): React.ReactNode {
    if (this.state.error) return <main style={{ padding: 24, color: '#b42318' }}>界面加载失败：{this.state.error.message}</main>
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>)
