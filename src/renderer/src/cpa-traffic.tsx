import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import { AlertCircle } from 'lucide-react'
import type { AppSnapshot, CpaAccountTraffic, CpaTrafficBucket, CpaTrafficResult } from '../../shared/types'
import { codexUsage } from './bridge'

export function useCpaTraffic(snapshot: AppSnapshot, enabled: boolean): Record<string, CpaAccountTraffic> {
  const [result, setResult] = useState<CpaTrafficResult>()
  const [error, setError] = useState('')
  const refresh = useRef<() => void>(() => {})
  const accountsKey = JSON.stringify(snapshot.accounts.map((account) => [account.id, account.updatedAt, account.modeVisibility]))
  const baseUrl = snapshot.settings.cpaBaseUrl
  const configured = snapshot.cpa.hasManagementSecret
  useEffect(() => { setResult(undefined); setError('') }, [baseUrl, configured])
  useEffect(() => {
    if (!enabled || !configured) return
    let stopped = false
    let pending = false
    const load = async (): Promise<void> => {
      if (stopped || pending || document.hidden) return
      pending = true
      try {
        const next = await codexUsage.getCpaTraffic()
        if (!stopped) { setResult(next); setError('') }
      } catch (reason) { if (!stopped) setError(`流量读取失败：${String(reason)}`) }
      finally { pending = false }
    }
    refresh.current = () => { void load() }
    void load()
    const timer = setInterval(() => { void load() }, 15_000)
    const visible = (): void => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); refresh.current = () => {} }
  }, [enabled, configured, baseUrl, accountsKey])
  const refreshing = snapshot.refreshingIds.length > 0
  const wasRefreshing = useRef(false)
  useEffect(() => { if (wasRefreshing.current && !refreshing) refresh.current(); wasRefreshing.current = refreshing }, [refreshing])
  const currentError = !configured ? '请先配置 CPA 管理密码' : error
  if (!currentError) return result?.accounts ?? {}
  return Object.fromEntries(snapshot.accounts.map((account) => [account.id, { ...result?.accounts[account.id], error: currentError }]))
}

function time(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function blockColor(bucket: CpaTrafficBucket): string {
  const total = bucket.success + bucket.failed
  if (!total) return '#e3e8eb'
  const rate = bucket.success / total
  const stops = [[239, 68, 68], [250, 204, 21], [34, 197, 94]]
  const from = rate < 0.5 ? stops[0] : stops[1]
  const to = rate < 0.5 ? stops[1] : stops[2]
  const progress = rate < 0.5 ? rate * 2 : (rate - 0.5) * 2
  return `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * progress)).join(', ')})`
}

export function CpaTrafficBar({ traffic }: { traffic?: CpaAccountTraffic }): JSX.Element {
  const [hover, setHover] = useState<{ index: number; x: number; y: number; above: boolean }>()
  useEffect(() => {
    const clear = (): void => setHover(undefined)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    return () => { window.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear) }
  }, [])
  const buckets = traffic?.buckets
  if (!buckets) return <div className={`cpa-traffic ${traffic?.error ? 'unavailable' : ''}`}><span title={traffic?.error}>{traffic?.error ?? '正在读取 CPA 流量...'}</span></div>
  const success = buckets.reduce((total, bucket) => total + bucket.success, 0)
  const failed = buckets.reduce((total, bucket) => total + bucket.failed, 0)
  const rate = success + failed > 0 ? `${(success / (success + failed) * 100).toFixed(1)}%` : '--'
  const updated = traffic?.updatedAt ? `更新于 ${new Date(traffic.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''
  const detail = hover && buckets[hover.index]
  const fullNumber = (value?: number): string => value === undefined ? '--' : value.toLocaleString('zh-CN')
  return <div className={`cpa-traffic ${traffic?.error ? 'stale' : ''}`}>
    <div className="traffic-totals" title={`CPA 累计请求次数\n${updated}`}><span className="traffic-success">成功 {fullNumber(traffic?.success)}</span><span className="traffic-failed">失败 {fullNumber(traffic?.failed)}</span></div>
    <div className="traffic-blocks" role="group" aria-label="CPA 最近 200 分钟请求状态">
      {buckets.map((bucket, index) => {
        const total = bucket.success + bucket.failed
        const label = `${time(bucket.startTime)} 至 ${time(bucket.endTime)}，成功 ${bucket.success}，失败 ${bucket.failed}`
        const show = (element: HTMLElement): void => {
          const rect = element.getBoundingClientRect()
          setHover({ index, x: Math.max(8, Math.min(rect.left, window.innerWidth - 282)), y: rect.top > 145 ? rect.top - 8 : rect.bottom + 8, above: rect.top > 145 })
        }
        return <span key={index} className={`traffic-block ${total ? 'active' : 'idle'}`} tabIndex={0} aria-label={label} style={{ backgroundColor: blockColor(bucket) }} onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => setHover(undefined)} onFocus={(event) => show(event.currentTarget)} onBlur={() => setHover(undefined)} />
      })}
    </div>
    <span className="traffic-rate" title={`近 200 分钟：成功 ${success.toLocaleString('zh-CN')}，失败 ${failed.toLocaleString('zh-CN')}\n${updated}`}>{rate === '--' ? '暂无请求' : `成功率 ${rate}`}</span>
    {traffic?.error && <AlertCircle className="traffic-warning" size={14} aria-label={traffic.error}><title>{`${traffic.error}\n保留上次数据，${updated}`}</title></AlertCircle>}
    {hover && detail && createPortal(<div role="tooltip" className="traffic-tooltip" style={{ left: hover.x, top: hover.y, transform: hover.above ? 'translateY(-100%)' : undefined }}>
      <div>{time(detail.startTime)} ~ {time(detail.endTime)}</div><div><span className="traffic-success">成功 {detail.success.toLocaleString('zh-CN')}</span><span className="traffic-failed">失败 {detail.failed.toLocaleString('zh-CN')}</span></div>
      <div>{detail.success + detail.failed ? `成功率 ${(detail.success / (detail.success + detail.failed) * 100).toFixed(1)}%` : '该时段暂无请求'}</div><small>{traffic?.error ? '当前显示上次成功读取的数据；' : ''}{updated}</small>
    </div>, document.body)}
  </div>
}
