import type { AccountInput, ApiModelQuery, AppSettings, AppSnapshot, ImportResult, LocalBridge, PublicAccount, ResetCreditDetail, SwitchResult } from '../../shared/types'

const configuredBase = new URLSearchParams(location.search).get('bridge')
const baseUrl = configuredBase ? configuredBase.replace(/\/+$/, '') : location.origin

async function request<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    credentials: 'include',
    headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value)
  })
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
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
  importText: (text: string) => request<ImportResult>('/api/accounts/import-text', 'POST', { text }),
  exportAccounts: async (ids?: string[]) => (await request<{ value: string }>('/api/accounts/export', 'POST', { ids })).value,
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>('/api/settings', 'PATCH', patch),
  getResetCreditDetail: (id: string) => request<ResetCreditDetail>(`/api/accounts/${encodeURIComponent(id)}/reset-credits`),
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
    const events = new EventSource(`${baseUrl}/api/events`, { withCredentials: true })
    events.onmessage = (event) => {
      try { listener(JSON.parse(event.data) as AppSnapshot) } catch { /* ignore incomplete events */ }
    }
    return () => events.close()
  }
}
