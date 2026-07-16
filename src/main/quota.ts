import type { Account, ResetCreditDetail, UsageResult, UsageWindow } from '../shared/types'
import { net } from 'electron'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const RESET_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

function headers(account: Account): Record<string, string> {
  const result: Record<string, string> = { Authorization: `Bearer ${account.accessToken}`, 'User-Agent': 'codex-cli', Accept: 'application/json' }
  if (account.accountId) result['ChatGPT-Account-Id'] = account.accountId
  return result
}

function windowName(seconds: unknown): string {
  const value = Number(seconds)
  if (value === 18_000) return '5h'
  if (value === 604_800) return '7d'
  if (Number.isFinite(value) && value > 0 && value % 86400 === 0) return `${value / 86400}d`
  return Number.isFinite(value) ? `${value}s` : '-'
}

function epoch(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return parsed > 10_000_000_000 ? parsed / 1000 : parsed
}

function extractWindows(payload: Record<string, unknown>): UsageWindow[] {
  const result: UsageWindow[] = []
  const add = (raw: unknown, prefix?: string): void => {
    if (!raw || typeof raw !== 'object') return
    const rate = raw as Record<string, unknown>
    for (const key of ['primary_window', 'secondary_window']) {
      const value = rate[key]
      if (!value || typeof value !== 'object') continue
      const item = value as Record<string, unknown>
      const used = Number(item.used_percent)
      if (!Number.isFinite(used)) continue
      const name = windowName(item.limit_window_seconds)
      result.push({ name: prefix ? `${prefix}:${name}` : name, used, remaining: Math.max(0, 100 - used), resetAt: epoch(item.reset_at) })
    }
  }
  add(payload.rate_limit)
  for (const listName of ['additional_rate_limits', 'rate_limits']) {
    const list = payload[listName]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      add(item.rate_limit ?? item, String(item.limit_name ?? item.metered_feature ?? '') || undefined)
    }
  }
  return result
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    if (error && typeof error === 'object') return String((error as Record<string, unknown>).code ?? (error as Record<string, unknown>).message ?? '未知错误')
    return String(error ?? parsed.code ?? parsed.message ?? '未知错误')
  } catch { return body.trim().slice(0, 300) || '空响应' }
}

async function once(account: Account): Promise<UsageResult> {
  const queriedAt = new Date().toISOString()
  if (account.accountMode === 'api') return { accountId: account.id, statusCode: 0, windows: [], queriedAt, planType: 'api' }
  if (!account.accessToken) return { accountId: account.id, statusCode: 0, windows: [], queriedAt, error: '缺少 access_token' }
  const response = await net.fetch(USAGE_URL, { headers: headers(account), signal: AbortSignal.timeout(20_000) })
  const body = await response.text()
  if (!response.ok) return { accountId: account.id, statusCode: response.status, windows: [], queriedAt, error: `HTTP ${response.status}: ${errorText(body)}${[401, 403].includes(response.status) ? '；未刷新令牌' : ''}` }
  const payload = JSON.parse(body) as Record<string, unknown>
  const credits = payload.rate_limit_reset_credits
  const resetCredits = credits && typeof credits === 'object' ? Number((credits as Record<string, unknown>).available_count) : undefined
  const windows = extractWindows(payload)
  const recognized = windows.some((item) => item.name.endsWith(':5h') || item.name.endsWith(':7d') || item.name === '5h' || item.name === '7d')
  return {
    accountId: account.id, statusCode: response.status, windows, queriedAt,
    resetCredits: Number.isFinite(resetCredits) ? resetCredits : undefined,
    planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
    error: !windows.length ? '响应中没有额度窗口数据' : !recognized ? `响应中没有 5小时或周限窗口数据（解析到：${windows.map((item) => item.name).join(', ')}）` : undefined
  }
}

export async function queryUsage(account: Account): Promise<UsageResult> {
  let result: UsageResult | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { result = await once(account) } catch (error) { result = { accountId: account.id, statusCode: 0, windows: [], queriedAt: new Date().toISOString(), error: String(error) } }
    if (!result.error) return result
    if (!attempt) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { ...result!, error: `${result!.error}（已重试 1 次）` }
}

export async function queryResetCredits(account: Account): Promise<ResetCreditDetail> {
  if (!account.accessToken) throw new Error('缺少 access_token')
  const response = await net.fetch(RESET_URL, { headers: headers(account), signal: AbortSignal.timeout(20_000) })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorText(body)}`)
  const data = JSON.parse(body) as Record<string, unknown>
  const credits = Array.isArray(data.credits) ? data.credits : []
  return {
    availableCount: Number.isFinite(Number(data.available_count)) ? Number(data.available_count) : undefined,
    totalSuccessfulReferrals: Number.isFinite(Number(data.total_earned_count)) ? Number(data.total_earned_count) : undefined,
    grants: credits.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')).map((item) => ({ grantedAt: typeof item.granted_at === 'string' ? item.granted_at : undefined, expiresAt: typeof item.expires_at === 'string' ? item.expires_at : undefined })),
    fetchedAt: new Date().toISOString()
  }
}
