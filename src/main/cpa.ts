import type { Account, CpaAccountTraffic, CpaConnectionResult, CpaInventory, CpaSyncResult, CpaTrafficResult, UsageResult } from '../shared/types'
import { parseCpaTraffic, trafficRecord } from './cpa-traffic'

interface CpaAuthFile {
  name?: string
  priority?: number
  type?: string
  provider?: string
  email?: string
  plan_type?: string
  disabled?: boolean
  codex_usage_account_id?: string
  [key: string]: unknown
}

interface CpaOpenAICompatibility {
  name: string
  priority?: number
  disabled?: boolean
  prefix?: string
  'base-url': string
  'api-key-entries'?: Array<{ 'api-key': string; weight?: number; 'proxy-url'?: string; 'auth-index'?: string }>
  models?: Array<{ name: string; alias: string; [key: string]: unknown }>
  headers?: Record<string, string>
  [key: string]: unknown
}

interface CpaResponse<T> {
  value: T
  version?: string
}

interface CooldownRecovery {
  accountId: string
  cleared: boolean
  error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function freshAvailableQuota(account: Account, usage: UsageResult): boolean {
  const age = Date.now() - Date.parse(usage.queriedAt)
  return account.accountMode === 'codex' && account.modeVisibility !== 'native' && usage.accountId === account.id &&
    usage.statusCode === 200 && !usage.error && usage.quotaAvailable === true && age >= 0 && age < 120_000
}

function recoverableCredentialCooldown(file: CpaAuthFile, usage: UsageResult): boolean {
  if (text(file.provider, file.type)?.toLowerCase() !== 'codex' || file.disabled === true || !text(file.auth_index)) return false
  if (!Array.isArray(file.cooldowns) || !file.cooldowns.length) return false
  const now = Date.now()
  const cooldowns = file.cooldowns.map(record)
  if (cooldowns.some((item) => !item || !text(item.retry_at) || !Number.isFinite(Date.parse(String(item.retry_at))))) return false
  const active = cooldowns.filter((item) => Date.parse(String(item!.retry_at)) > now)
  if (!active.some((item) => item!.scope === 'credential' && item!.reason === 'credential_quota')) return false
  // The CPA reset endpoint resets all model states, not just the credential-level flag.
  if (!cooldowns.every((item) => (item!.scope === 'credential' || item!.scope === 'model') &&
    (item!.reason === 'credential_quota' || (item!.scope === 'model' && item!.reason === 'quota' && item!.http_status === 429)) &&
    (item!.http_status == null || item!.http_status === 429))) return false
  const queriedAt = Date.parse(usage.queriedAt)
  const observedAt = record(file.quota)?.observed_at
  for (const stamp of [file.updated_at, observedAt]) {
    if (stamp != null && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)) || Date.parse(stamp) > queriedAt)) return false
  }
  return true
}

function recoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const status = message.match(/CPA 管理接口 (\d{3})/)?.[1]
  return status ? `HTTP ${status}` : message.includes('超时') ? '连接 CPA 超时' : 'CPA 冷却修正失败，请检查连接和管理密码'
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

export function normalizeCpaBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  if (!raw) throw new Error('请填写 CPA 地址')
  const parsed = new URL(raw)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('CPA 地址仅支持 http 或 https')
  parsed.pathname = parsed.pathname.replace(/\/(?:v0\/management|v1)\/?$/i, '').replace(/\/+$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

export function cpaApiEndpoint(baseUrl: string): string {
  return `${normalizeCpaBaseUrl(baseUrl)}/v1`
}

export function managedAuthFileName(account: Account): string {
  return account.cpaAuthFileName ?? `codexusage-${account.id.replace(/[^a-z0-9_-]/gi, '_')}.json`
}

export function managedProviderName(account: Account): string {
  return `CodexUsage-${account.id.replace(/[^a-z0-9_-]/gi, '_')}`
}

function priorityFor(index: number, total: number): number {
  return Math.max(1, total - index) * 100
}

export function cpaAccountPriority(account: Account, orderedAccounts: Account[]): number {
  const index = orderedAccounts.findIndex((item) => item.id === account.id)
  if (index < 0) throw new Error('账号不在 CPA 优先级列表中')
  return priorityFor(index, orderedAccounts.length)
}

function codexAuthPayload(account: Account, priority: number): Record<string, unknown> {
  const tokens = { ...(account.authTokens ?? {}) }
  const accessToken = text(tokens.access_token) ?? account.accessToken
  if (!accessToken) throw new Error(`${account.email ?? account.label} 缺少 access_token`)
  const payload: Record<string, unknown> = {
    ...tokens,
    type: 'codex',
    access_token: accessToken,
    priority,
    note: account.label,
    codex_usage_account_id: account.id
  }
  if (account.accountId) payload.account_id = account.accountId
  if (account.email) payload.email = account.email
  return payload
}

function apiProviderPayload(account: Account, priority: number, models: CpaOpenAICompatibility['models']): CpaOpenAICompatibility {
  if (!account.apiEndpoint || !account.apiKey) throw new Error(`${account.label} 缺少 API 端点或密钥`)
  return {
    name: managedProviderName(account),
    priority,
    disabled: false,
    'base-url': account.apiEndpoint.replace(/\/+$/, ''),
    'api-key-entries': [{ 'api-key': account.apiKey }],
    models
  }
}

export class CpaClient {
  readonly baseUrl: string
  private readonly managementSecret: string

  constructor(baseUrl: string, managementSecret: string) {
    this.baseUrl = normalizeCpaBaseUrl(baseUrl)
    this.managementSecret = managementSecret.trim()
    if (!this.managementSecret) throw new Error('请先配置 CPA 管理密码')
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<CpaResponse<T>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await fetch(`${this.baseUrl}/v0/management${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.managementSecret}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers
        }
      })
      const raw = await response.text()
      let payload: unknown = undefined
      if (raw) {
        try { payload = JSON.parse(raw) } catch { payload = raw }
      }
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' ? text((payload as Record<string, unknown>).error) : text(payload)
        throw new Error(`CPA 管理接口 ${response.status}${detail ? `：${detail}` : ''}`)
      }
      return { value: payload as T, version: text(response.headers.get('x-cpa-version')) }
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('连接 CPA 超时')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async testConnection(): Promise<CpaConnectionResult> {
    const [config, authFiles, providers] = await Promise.all([
      this.request<Record<string, unknown>>('/config'),
      this.listAuthFiles(),
      this.listApiProviders()
    ])
    return {
      connected: true,
      version: config.version,
      testedAt: new Date().toISOString(),
      authFileCount: authFiles.length,
      apiProviderCount: providers.length
    }
  }

  async listAuthFiles(): Promise<CpaAuthFile[]> {
    const response = await this.request<{ files?: CpaAuthFile[] }>('/auth-files')
    return Array.isArray(response.value?.files) ? response.value.files : []
  }

  async recoverQuotaCooldowns(entries: Array<{ account: Account; usage: UsageResult }>): Promise<CooldownRecovery[]> {
    const candidates = entries.filter(({ account, usage }) => freshAvailableQuota(account, usage))
    if (!candidates.length) return []
    let files: CpaAuthFile[]
    try {
      files = await this.listAuthFiles()
    } catch (error) {
      return candidates.map(({ account }) => ({ accountId: account.id, cleared: false, error: recoveryError(error) }))
    }
    const results: CooldownRecovery[] = []
    const attempted = new Set<string>()
    for (const { account, usage } of candidates) {
      if (!freshAvailableQuota(account, usage)) continue
      const matches = files.filter((file) => file.name === managedAuthFileName(account) || file.codex_usage_account_id === account.id)
      if (matches.length !== 1) continue
      const file = matches[0]
      if (!recoverableCredentialCooldown(file, usage)) continue
      const authIndex = text(file.auth_index)!
      if (attempted.has(authIndex)) continue
      attempted.add(authIndex)
      try {
        // CPA-local routing reset only. Never call OpenAI's rate-limit-reset-credits endpoint here.
        const response = await this.request<{ status?: string; auth_index?: string }>('/reset-quota', {
          method: 'POST', body: JSON.stringify({ auth_index: authIndex })
        })
        if (response.value?.status !== 'ok' || response.value.auth_index !== authIndex) throw new Error('Invalid cooldown reset response')
        results.push({ accountId: account.id, cleared: true })
      } catch (error) {
        results.push({ accountId: account.id, cleared: false, error: recoveryError(error) })
      }
    }
    return results
  }

  async inspect(): Promise<CpaInventory> {
    const [authFiles, providers] = await Promise.all([this.listAuthFiles(), this.listApiProviders()])
    return {
      authFiles: authFiles.flatMap((item) => {
        const name = text(item.name)
        if (!name) return []
        return [{
          name,
          provider: text(item.provider, item.type),
          email: text(item.email),
          planType: text(item.plan_type),
          priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : undefined,
          disabled: typeof item.disabled === 'boolean' ? item.disabled : undefined,
          managedByCodexUsage: name.toLowerCase().startsWith('codexusage-') || Boolean(text(item.codex_usage_account_id))
        }]
      }),
      apiProviders: providers.map((provider) => ({
        name: provider.name,
        baseUrl: provider['base-url'],
        priority: Number.isFinite(Number(provider.priority)) ? Number(provider.priority) : undefined,
        models: (provider.models ?? []).map((model) => model.alias || model.name).filter(Boolean),
        disabled: provider.disabled,
        managedByCodexUsage: provider.name.toLowerCase().startsWith('codexusage-')
      }))
    }
  }

  async getTraffic(accounts: Account[]): Promise<CpaTrafficResult> {
    const visible = accounts.filter((account) => account.modeVisibility !== 'native')
    const traffic: Record<string, CpaAccountTraffic> = {}
    // Do not expose upstream statistics maps: API usage keys contain the actual API key.
    const readGroup = async (group: Account[], read: () => Promise<void>, kind: string): Promise<void> => {
      if (!group.length) return
      try { await read() } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const status = message.match(/CPA 管理接口 (\d{3})/)?.[1]
        const detail = status === '404' ? '当前 CPA 版本不支持该统计接口' : status ? `HTTP ${status}` : message.includes('超时') ? '连接超时' : '请检查 CPA 连接和管理密码'
        for (const account of group) traffic[account.id] = { error: `读取 CPA ${kind}流量失败：${detail}` }
      }
    }
    const oauth = visible.filter((account) => account.accountMode === 'codex')
    const api = visible.filter((account) => account.accountMode === 'api')
    await Promise.all([
      readGroup(oauth, async () => {
        const { value } = await this.request<{ files?: CpaAuthFile[] }>('/auth-files')
        if (!Array.isArray(value?.files)) throw new Error('Invalid auth-files response')
        for (const account of oauth) {
          const file = value.files.find((file) => file.name === managedAuthFileName(account))
            ?? value.files.find((file) => file.codex_usage_account_id === account.id)
          traffic[account.id] = file ? parseCpaTraffic(file) : { error: 'CPA 中未找到该账号凭据，请同步账号' }
        }
      }, '订阅账号'),
      readGroup(api, async () => {
        const [providers, response] = await Promise.all([this.listApiProviders(), this.request<unknown>('/api-key-usage')])
        const usage = trafficRecord(response.value)
        if (!usage || Object.values(usage).some((value) => !trafficRecord(value))) throw new Error('Invalid api-key-usage response')
        const byProvider = new Map(Object.entries(usage).map(([name, value]) => [name.trim().toLowerCase(), trafficRecord(value)]))
        for (const account of api) {
          const provider = providers.find((item) => item.name === managedProviderName(account))
          if (!provider) { traffic[account.id] = { error: 'CPA 中未找到该 API 配置，请同步账号' }; continue }
          const credential = provider['api-key-entries']?.find((item) => item['api-key'] === account.apiKey)
          if (!credential) { traffic[account.id] = { error: 'CPA 中的 API 密钥与本地不一致，请同步账号或配置导回' }; continue }
          const group = byProvider.get(provider.name.trim().toLowerCase())
          const key = `${provider['base-url'].trim()}|${credential['api-key'].trim()}`
          traffic[account.id] = parseCpaTraffic(group?.[key] ?? { success: 0, failed: 0, recent_requests: [] })
        }
      }, 'API 账号')
    ])
    return { accounts: traffic, fetchedAt: new Date().toISOString() }
  }

  async uploadCodexAccount(account: Account, priority: number): Promise<void> {
    const name = managedAuthFileName(account)
    await this.uploadAuthFile(name, codexAuthPayload(account, priority))
  }

  async uploadAuthFile(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(payload) })
  }

  async downloadAuthFile(name: string): Promise<Record<string, unknown>> {
    const response = await this.request<Record<string, unknown>>(`/auth-files/download?name=${encodeURIComponent(name)}`)
    if (!response.value || typeof response.value !== 'object') throw new Error(`CPA 凭据 ${name} 内容无效`)
    return response.value
  }

  async patchAuthPriority(account: Account, priority: number): Promise<void> {
    await this.request('/auth-files/fields', {
      method: 'PATCH',
      body: JSON.stringify({ name: managedAuthFileName(account), priority, note: account.label, codex_usage_account_id: account.id })
    })
  }

  async saveCodexCredential(account: Account, credential: Record<string, unknown>, priority: number): Promise<void> {
    const name = managedAuthFileName(account)
    const authFiles = await this.listAuthFiles()
    const exists = authFiles.some((item) => text(item.name) === name)
    const current = exists ? await this.downloadAuthFile(name) : {}
    const payload: Record<string, unknown> = {
      ...current,
      ...credential,
      type: 'codex',
      priority,
      note: account.label,
      codex_usage_account_id: account.id
    }
    if (account.accountId) payload.account_id = account.accountId
    if (account.email) payload.email = account.email
    await this.uploadAuthFile(name, payload)
  }

  async deleteAuthFile(name: string): Promise<void> {
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  async listApiProviders(): Promise<CpaOpenAICompatibility[]> {
    const response = await this.request<{ 'openai-compatibility'?: CpaOpenAICompatibility[] }>('/openai-compatibility')
    const providers = response.value?.['openai-compatibility']
    if (!Array.isArray(providers)) throw new Error('CPA 返回的 OpenAI 配置列表无效，已停止同步')
    return providers
  }

  async downloadApiProvider(account: Account): Promise<CpaOpenAICompatibility> {
    const name = managedProviderName(account)
    const provider = (await this.listApiProviders()).find((item) => item.name === name)
    if (!provider) throw new Error(`CPA 中没有找到 API 配置 ${name}`)
    return provider
  }

  async putApiProviders(providers: CpaOpenAICompatibility[]): Promise<void> {
    await this.request('/openai-compatibility', { method: 'PUT', body: JSON.stringify(providers) })
  }

  async removeManagedApiAccount(account: Account): Promise<boolean> {
    const providers = await this.listApiProviders()
    const name = managedProviderName(account)
    const filtered = providers.filter((provider) => provider.name !== name)
    if (filtered.length === providers.length) return false
    await this.putApiProviders(filtered)
    return true
  }

  async ensureClientApiKey(apiKey: string): Promise<boolean> {
    const key = apiKey.trim()
    if (!key) throw new Error('请先配置 CPA 客户端 API Key')
    const response = await this.request<{ 'api-keys'?: string[] }>('/api-keys')
    const keys = Array.isArray(response.value?.['api-keys']) ? response.value['api-keys'].filter((item): item is string => typeof item === 'string') : []
    if (keys.includes(key)) return false
    await this.request('/api-keys', { method: 'PUT', body: JSON.stringify([...keys, key]) })
    return true
  }

  async syncAccounts(accounts: Account[], options: { queryModels?: (endpoint: string, apiKey: string) => Promise<string[]>; refreshModels?: boolean } = {}): Promise<CpaSyncResult> {
    const authFiles = await this.listAuthFiles()
    const authNames = new Set(authFiles.map((item) => item.name).filter((name): name is string => Boolean(name)))
    const allProviders = await this.listApiProviders()
    const excludedProviderNames = new Set(accounts.filter((account) => account.accountMode === 'api' && account.modeVisibility === 'native').map(managedProviderName))
    const providers = allProviders.filter((provider) => !excludedProviderNames.has(provider.name))
    const providerIndexes = new Map(providers.map((provider, index) => [provider.name, index]))
    const apiPayloads = new Map<string, CpaOpenAICompatibility>()
    // Resolve models before mutating CPA, so a failed discovery cannot partially reorder accounts.
    for (const account of accounts.filter((item) => item.accountMode === 'api' && item.modeVisibility !== 'native' && item.apiEndpoint && item.apiKey)) {
      const existing = providers.find((item) => item.name === managedProviderName(account))
      const sameEndpoint = existing?.['base-url']?.replace(/\/+$/, '') === account.apiEndpoint!.replace(/\/+$/, '')
      const sameKey = existing?.['api-key-entries']?.some((item) => item['api-key'] === account.apiKey)
      let models = existing?.models
      if (options.refreshModels || !models?.length || !sameEndpoint || !sameKey) {
        if (!options.queryModels) throw new Error(`需要读取 API 可用模型后注册 CPA：${account.label}`)
        let ids: string[]
        try { ids = [...new Set((await options.queryModels(account.apiEndpoint!, account.apiKey!)).map((id) => id.trim()).filter(Boolean))] }
        catch { throw new Error(`读取 API 可用模型失败：${account.label}；请检查端点和密钥后重试同步`) }
        if (!ids.length) throw new Error(`API 没有返回可用模型：${account.label}`)
        // Preserve manually configured aliases and capabilities for the same upstream.
        models = sameEndpoint && sameKey ? [...(models ?? [])] : []
        for (const id of ids) if (!models.some((model) => model.name === id)) models.push({ name: id, alias: id })
      }
      apiPayloads.set(account.id, apiProviderPayload(account, cpaAccountPriority(account, accounts), models))
    }
    let oauthAdded = 0
    let oauthUpdated = 0
    let apiAdded = 0
    let apiUpdated = 0
    let skipped = 0
    let providersChanged = providers.length !== allProviders.length

    for (const [index, account] of accounts.entries()) {
      const priority = priorityFor(index, accounts.length)
      if (account.modeVisibility === 'native') {
        if (account.accountMode === 'codex') {
          const fileName = managedAuthFileName(account)
          if (authNames.has(fileName)) {
            await this.deleteAuthFile(fileName)
            authNames.delete(fileName)
          }
        }
        skipped += 1
        continue
      }
      if (account.accountMode === 'codex') {
        const fileName = managedAuthFileName(account)
        if (authNames.has(fileName)) {
          await this.patchAuthPriority(account, priority)
          oauthUpdated += 1
        } else {
          await this.uploadCodexAccount(account, priority)
          oauthAdded += 1
        }
        continue
      }
      if (!account.apiEndpoint || !account.apiKey) {
        skipped += 1
        continue
      }
      const next = apiPayloads.get(account.id)!
      const providerIndex = providerIndexes.get(next.name)
      if (providerIndex === undefined) {
        providerIndexes.set(next.name, providers.length)
        providers.push(next)
        apiAdded += 1
      } else {
        providers[providerIndex] = { ...providers[providerIndex], ...next }
        apiUpdated += 1
      }
      providersChanged = true
    }
    if (providersChanged) {
      await this.putApiProviders(providers)
      const saved = await this.listApiProviders()
      for (const account of accounts.filter((item) => item.accountMode === 'api' && item.modeVisibility !== 'native' && item.apiEndpoint && item.apiKey)) {
        const expected = apiPayloads.get(account.id)!
        const actual = saved.find((provider) => provider.name === expected.name)
        if (!actual || Number(actual.priority) !== expected.priority || actual['base-url']?.replace(/\/+$/, '') !== expected['base-url'] ||
          !actual['api-key-entries']?.some((entry) => entry['api-key'] === account.apiKey) ||
          expected.models?.some((model) => !actual.models?.some((item) => item.name === model.name && (item.alias || item.name) === model.alias))) {
          throw new Error(`CPA OpenAI 配置或优先级校验失败：${account.label}`)
        }
      }
    }
    return { oauthAdded, oauthUpdated, apiAdded, apiUpdated, skipped, syncedAt: new Date().toISOString() }
  }
}
