import type { CpaAccountTraffic, CpaTrafficBucket, CpaTrafficResult } from '../shared/types'

const BUCKET_COUNT = 20
const BUCKET_MS = 10 * 60_000

export function trafficRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function count(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined
}

export function parseCpaTraffic(value: unknown, now = Date.now()): CpaAccountTraffic {
  const record = trafficRecord(value)
  if (!record) return { error: 'CPA 返回的流量统计格式无效' }
  const success = count(record.success)
  const failed = count(record.failed)
  const recent = record.recent_requests ?? record.recentRequests
  if (!Array.isArray(recent)) return { success, failed, error: 'CPA 未返回近期流量数据，请检查 CPA 版本' }
  const entries = recent.slice(-BUCKET_COUNT)
  const buckets: CpaTrafficBucket[] = []
  const latestStart = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const padding = BUCKET_COUNT - entries.length
  for (let index = 0; index < BUCKET_COUNT; index++) {
    const entry = index < padding ? { success: 0, failed: 0 } : trafficRecord(entries[index - padding])
    const bucketSuccess = count(entry?.success)
    const bucketFailed = count(entry?.failed)
    if (bucketSuccess === undefined || bucketFailed === undefined) return { success, failed, error: 'CPA 返回的流量时间桶格式无效' }
    const time = typeof entry?.time === 'string' ? Date.parse(entry.time) : NaN
    const startTime = Number.isFinite(time) ? time : latestStart - (BUCKET_COUNT - 1 - index) * BUCKET_MS
    buckets.push({ startTime, endTime: startTime + BUCKET_MS, success: bucketSuccess, failed: bucketFailed })
  }
  return { success, failed, buckets, updatedAt: new Date(now).toISOString() }
}

// Browser and desktop requests share one batch; failures keep the last successful chart.
export class CpaTrafficCache {
  private state?: { scope: string; value?: CpaTrafficResult; loadedAt?: number; pending?: Promise<CpaTrafficResult> }

  async get(scope: string, read: () => Promise<CpaTrafficResult>, now = Date.now()): Promise<CpaTrafficResult> {
    if (this.state?.scope !== scope) this.state = { scope }
    const state = this.state
    if (state.pending) return state.pending
    if (state.value && state.loadedAt !== undefined && now - state.loadedAt < 10_000) return state.value
    state.pending = read().then((next) => {
      const accounts = Object.fromEntries(Object.entries(next.accounts).map(([id, traffic]) => {
        const previous = state.value?.accounts[id]
        return [id, traffic.error && !traffic.buckets && previous?.buckets ? { ...previous, error: traffic.error } : traffic]
      }))
      state.value = { ...next, accounts }
      state.loadedAt = now
      return state.value
    }).finally(() => { state.pending = undefined })
    return state.pending
  }
}
