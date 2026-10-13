import type { AccountInput, ApiModelQuery, AppSettings, AppSnapshot, CpaConnectionResult, CpaInventory, CpaMigrationResult, CpaSettingsInput, CpaStatus, CpaSyncResult, CpaTrafficResult, CredentialActionResult, DailyTokenUsageResult, ImportResult, LocalBridge, OperationMode, PublicAccount, ResetCreditDetail, SubscriptionDetail, SwitchResult } from '../../shared/types'

const configuredBase = new URLSearchParams(location.search).get('bridge')
const baseUrl = configuredBase ? configuredBase.replace(/\/+$/, '') : location.origin
const SESSION_HEADER = 'X-Codex-Usage-Session'
let sessionToken = ''
let sessionRequest: Promise<string> | undefined

async function renewLocalSession(force = false): Promise<string> {
  if (sessionToken && !force) return sessionToken
  if (!sessionRequest) {
    sessionRequest = fetch(`${baseUrl}/api/session?at=${Date.now()}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    }).then(async (response) => {
      const payload = await response.json().catch(() => undefined) as { session?: string; error?: string } | undefined
      if (!response.ok || !payload?.session) throw new Error(payload?.error ?? `重新建立本地会话失败：HTTP ${response.status}`)
      sessionToken = payload.session
      return sessionToken
    }).finally(() => { sessionRequest = undefined })
  }
  return sessionRequest
}

async function request<T>(path: string, method = 'GET', value?: unknown, retried = false): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(sessionToken ? { [SESSION_HEADER]: sessionToken } : {})
    },
    body: value === undefined ? undefined : JSON.stringify(value)
  })
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
  if (response.status === 403 && payload?.error === '本地会话无效，请从 CodexUsage 重新打开浏览器页面' && !retried) {
    sessionToken = ''
    await renewLocalSession(true)
    return request<T>(path, method, value, true)
  }
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
  return payload as T
}

export const codexUsage: LocalBridge = {
  getSnapshot: () => request<AppSnapshot>('/api/snapshot'),
  refresh: (accountIds?: string[]) => request<void>('/api/refresh', 'POST', { accountIds }),
  importCurrent: () => request<PublicAccount>('/api/accounts/import-current', 'POST'),
  queryApiModels: (input: ApiModelQuery) => request<string[]>('/api/models', 'POST', input),
  saveAccount: (input: AccountInput) => request<PublicAccount>('/api/accounts/save', 'POST', input),
  removeAccount: (id: string) => request<void>(`/api/accounts/${encodeURIComponent(id)}`, 'DELETE'),
  switchAccount: (id: string) => request<SwitchResult>(`/api/accounts/${encodeURIComponent(id)}/switch`, 'POST'),
  refreshCredential: (id: string, sourceMode: OperationMode) => request<CredentialActionResult>(`/api/accounts/${encodeURIComponent(id)}/refresh-credential`, 'POST', { sourceMode }),
  importCpaAccount: (id: string) => request<CredentialActionResult>(`/api/accounts/${encodeURIComponent(id)}/import-cpa`, 'POST'),
  repairCodexSessions: async () => (await request<{ repaired: number }>('/api/codex/repair-sessions', 'POST')).repaired,
  importText: (text: string) => request<ImportResult>('/api/accounts/import-text', 'POST', { text }),
  exportAccounts: async (ids?: string[]) => (await request<{ value: string }>('/api/accounts/export', 'POST', { ids })).value,
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>('/api/settings', 'PATCH', patch),
  updateCpaSettings: (input: CpaSettingsInput) => request<CpaStatus>('/api/cpa/settings', 'PATCH', input),
  testCpaConnection: () => request<CpaConnectionResult>('/api/cpa/test', 'POST'),
  inspectCpa: () => request<CpaInventory>('/api/cpa/inventory'),
  getCpaTraffic: () => request<CpaTrafficResult>('/api/cpa/traffic'),
  syncCpaAccounts: () => request<CpaSyncResult>('/api/cpa/sync', 'POST'),
  migrateCpaLegacy: (loopbackAccountId: string) => request<CpaMigrationResult>('/api/cpa/migrate', 'POST', { loopbackAccountId }),
  setOperationMode: (mode: OperationMode) => request<SwitchResult>('/api/cpa/mode', 'POST', { mode }),
  reorderAccounts: (ids: string[]) => request<void>('/api/accounts/reorder', 'POST', { ids }),
  getResetCreditDetail: (id: string) => request<ResetCreditDetail>(`/api/accounts/${encodeURIComponent(id)}/reset-credits`),
  getSubscriptionDetail: (id: string) => request<SubscriptionDetail>(`/api/accounts/${encodeURIComponent(id)}/subscription`),
  getDailyTokenUsage: () => request<DailyTokenUsageResult>('/api/token-usage/daily'),
  installHook: async () => (await request<{ value: string }>('/api/hook/install', 'POST')).value,
  openCodex: () => request<void>('/api/codex/open', 'POST'),
  openBrowser: () => request<void>('/api/browser/open', 'POST'),
  openLog: () => request<void>('/api/log/open', 'POST'),
  openLogDirectory: () => request<void>('/api/log/open-directory', 'POST'),
  showPanel: () => request<void>('/api/panel/show', 'POST'),
  hidePanel: () => request<void>('/api/panel/hide', 'POST'),
  quit: () => request<void>('/api/app/quit', 'POST'),
  startWidgetDrag: () => request<void>('/api/widget/start-drag', 'POST'),
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void {
    let events: EventSource | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = async (): Promise<void> => {
      try {
        const token = await renewLocalSession()
        if (stopped) return
        events = new EventSource(`${baseUrl}/api/events?session=${encodeURIComponent(token)}`, { withCredentials: true })
        events.onmessage = (event) => {
          try { listener(JSON.parse(event.data) as AppSnapshot) } catch { /* ignore incomplete events */ }
        }
        events.onerror = () => {
          events?.close()
          events = undefined
          sessionToken = ''
          if (!stopped) reconnectTimer = setTimeout(() => void connect(), 1_000)
        }
      } catch {
        if (!stopped) reconnectTimer = setTimeout(() => void connect(), 1_000)
      }
    }
    void connect()
    return () => {
      stopped = true
      events?.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }
}
