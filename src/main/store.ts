import { app, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_API_MODEL, DEFAULT_API_WIRE_API, DEFAULT_MODEL_REASONING_EFFORT, normalizeModelReasoningEffort } from '../shared/types'
import type { Account, AccountInput, AccountVisibility, AppSettings, PublicAccount, SecretValue } from '../shared/types'

interface DiskStore {
  version: number
  settings?: Record<string, unknown>
  cpaSecrets?: Record<string, unknown>
  accounts?: Record<string, unknown>[]
}

const defaults: AppSettings = {
  autoQuerySeconds: 900,
  showStatusWidget: true,
  showCpaTraffic: true,
  operationMode: 'native',
  cpaBaseUrl: 'http://127.0.0.1:18516',
  cpaModel: DEFAULT_API_MODEL,
  cpaWireApi: DEFAULT_API_WIRE_API,
  cpaModelReasoningEffort: DEFAULT_MODEL_REASONING_EFFORT,
  accountOrder: []
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function visibility(value: unknown, source?: string, legacyCpaSyncDisabled?: unknown): AccountVisibility {
  if (value === 'native' || value === 'cpa' || value === 'both') return value
  if (Boolean(legacyCpaSyncDisabled)) return 'native'
  if (source === 'cpa-auth') return 'cpa'
  return 'both'
}

function secret(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<SecretValue>
  if (!item.value) return undefined
  if (item.encoding === 'plain') return item.value
  if (item.encoding === 'safe-storage') {
    try {
      return safeStorage.decryptString(Buffer.from(item.value, 'base64')) || undefined
    } catch (error) {
      console.error('无法解密 safe-storage 数据', error)
      return undefined
    }
  }
  return undefined
}

function encrypted(value?: string): SecretValue | null {
  if (!value) return null
  if (safeStorage.isEncryptionAvailable()) {
    return { encoding: 'safe-storage', value: safeStorage.encryptString(value).toString('base64') }
  }
  return { encoding: 'plain', value }
}

function encryptedCpaSecret(value?: string): SecretValue | null {
  if (!value) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用 Electron safeStorage，已拒绝明文保存 CPA 密码')
  return { encoding: 'safe-storage', value: safeStorage.encryptString(value).toString('base64') }
}

function decodeJwt(token?: string): Record<string, unknown> {
  if (!token) return {}
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch { return {} }
}

export function identityFromTokens(tokens?: Record<string, unknown>): { accountId?: string; email?: string } {
  if (!tokens) return {}
  const claims = decodeJwt(text(tokens.id_token))
  const auth = claims['https://api.openai.com/auth']
  const authObject = auth && typeof auth === 'object' ? auth as Record<string, unknown> : {}
  const profile = claims['https://api.openai.com/profile']
  const profileObject = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {}
  return {
    accountId: text(tokens.account_id, authObject.chatgpt_account_id, authObject.account_id, claims.account_id),
    email: text(claims.email, profileObject.email)
  }
}

export class AccountStore {
  readonly path: string
  settings: AppSettings = { ...defaults }
  accounts: Account[] = []
  cpaManagementSecret?: string
  cpaClientApiKey?: string

  constructor() {
    const directory = join(app.getPath('appData'), 'CodexUsagePanel')
    this.path = join(directory, 'accounts.v2.json')
  }

  async load(): Promise<void> {
    let data: DiskStore = { version: 2 }
    try { data = JSON.parse(await readFile(this.path, 'utf8')) as DiskStore } catch { /* first run */ }
    const rawSettings = data.settings ?? {}
    this.settings = {
      autoQuerySeconds: Math.max(0, Math.min(86400, number(rawSettings.autoQuerySeconds, defaults.autoQuerySeconds))),
      showStatusWidget: Boolean(rawSettings.showStatusWidget ?? true),
      showCpaTraffic: Boolean(rawSettings.showCpaTraffic ?? defaults.showCpaTraffic),
      statusWidgetPosition: rawSettings.statusWidgetPosition as AppSettings['statusWidgetPosition'],
      operationMode: text(rawSettings.operationMode) === 'cpa' ? 'cpa' : 'native',
      cpaBaseUrl: text(rawSettings.cpaBaseUrl) ?? defaults.cpaBaseUrl,
      cpaModel: text(rawSettings.cpaModel) ?? defaults.cpaModel,
      cpaWireApi: text(rawSettings.cpaWireApi) ?? defaults.cpaWireApi,
      cpaModelReasoningEffort: normalizeModelReasoningEffort(rawSettings.cpaModelReasoningEffort),
      accountOrder: Array.isArray(rawSettings.accountOrder) ? rawSettings.accountOrder.filter((value): value is string => typeof value === 'string') : [],
      lastNativeAccountId: text(rawSettings.lastNativeAccountId)
    }
    const rawCpaSecrets = data.cpaSecrets ?? {}
    this.cpaManagementSecret = secret(rawCpaSecrets.managementSecret)
    this.cpaClientApiKey = secret(rawCpaSecrets.clientApiKey)
    const rawAccounts = data.accounts ?? []
    this.accounts = rawAccounts.map((item) => this.fromDisk(item)).filter((item): item is Account => Boolean(item))
    const accountIds = new Set(this.accounts.map((account) => account.id))
    this.settings.accountOrder = [...this.settings.accountOrder.filter((id) => accountIds.has(id)), ...this.accounts.map((account) => account.id).filter((id) => !this.settings.accountOrder.includes(id))]
    if (rawAccounts.some((item) => item.modeVisibility !== 'both' && item.modeVisibility !== 'native' && item.modeVisibility !== 'cpa')) await this.save()
  }

  private fromDisk(item: Record<string, unknown>): Account | undefined {
    const accessToken = secret(item.accessToken)
    const apiKey = secret(item.apiKey)
    const mode = text(item.accountMode) === 'api' ? 'api' : 'codex'
    if (mode === 'api' ? !apiKey : !accessToken) return undefined
    let authTokens: Record<string, unknown> | undefined
    const decodedAuthTokens = secret(item.authTokens)
    try { authTokens = decodedAuthTokens ? JSON.parse(decodedAuthTokens) : undefined } catch { /* invalid stored value */ }
    const source = text(item.source) ?? 'manual'
    return {
      id: text(item.id) ?? randomUUID(),
      label: text(item.label) ?? (mode === 'api' ? 'API 账号' : 'Codex 账号'),
      accessToken,
      apiKey,
      apiEndpoint: text(item.apiEndpoint),
      apiModel: mode === 'api' ? text(item.apiModel) ?? DEFAULT_API_MODEL : undefined,
      apiWireApi: mode === 'api' ? text(item.apiWireApi) ?? DEFAULT_API_WIRE_API : undefined,
      modelReasoningEffort: mode === 'api' ? normalizeModelReasoningEffort(item.modelReasoningEffort) : undefined,
      accountId: text(item.accountId),
      email: text(item.email),
      source,
      accountMode: mode,
      authTokens,
      cpaAuthFileName: text(item.cpaAuthFileName),
      modeVisibility: visibility(item.modeVisibility, source, item.cpaSyncDisabled),
      fiveHourWeekPercent: Math.max(0, Math.min(100, number(item.fiveHourWeekPercent, 16))),
      addedAt: text(item.addedAt) ?? new Date().toISOString(),
      updatedAt: text(item.updatedAt) ?? new Date().toISOString()
    }
  }

  async save(): Promise<void> {
    const payload = {
      version: 2,
      settings: this.settings,
      cpaSecrets: {
        managementSecret: encryptedCpaSecret(this.cpaManagementSecret),
        clientApiKey: encryptedCpaSecret(this.cpaClientApiKey)
      },
      accounts: this.accounts.map((account) => ({
        id: account.id, label: account.label, accountId: account.accountId, email: account.email,
        source: account.source, accountMode: account.accountMode, apiEndpoint: account.apiEndpoint,
        apiModel: account.apiModel, apiWireApi: account.apiWireApi, modelReasoningEffort: account.modelReasoningEffort,
        cpaAuthFileName: account.cpaAuthFileName,
        modeVisibility: account.modeVisibility,
        apiKey: encrypted(account.apiKey), accessToken: encrypted(account.accessToken),
        authTokens: account.authTokens ? encrypted(JSON.stringify(account.authTokens)) : null,
        fiveHourWeekPercent: account.fiveHourWeekPercent, addedAt: account.addedAt, updatedAt: account.updatedAt
      }))
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }

  dedupeKey(account: Account): string {
    if (account.accountMode === 'api') return `api:${account.apiEndpoint?.replace(/\/$/, '').toLowerCase()}:${createHash('sha256').update(account.apiKey ?? '').digest('hex')}`
    if (account.accountId) return `account:${account.accountId}`
    if (account.email) return `email:${account.email.toLowerCase()}`
    return `token:${createHash('sha256').update(account.accessToken ?? '').digest('hex')}`
  }

  async upsert(input: AccountInput & Partial<Account>, source = 'manual'): Promise<Account> {
    const now = new Date().toISOString()
    const identity = identityFromTokens(input.authTokens)
    const existingById = input.id ? this.accounts.find((item) => item.id === input.id) : undefined
    const candidate: Account = {
      id: input.id ?? randomUUID(), label: text(input.label, input.email, identity.email) ?? (input.accountMode === 'api' ? 'API 账号' : 'Codex 账号'),
      accountMode: input.accountMode, accessToken: text(input.accessToken, input.authTokens?.access_token, existingById?.accessToken),
      apiKey: text(input.apiKey, existingById?.apiKey), apiEndpoint: text(input.apiEndpoint, existingById?.apiEndpoint),
      apiModel: input.accountMode === 'api' ? text(input.apiModel, existingById?.apiModel) ?? DEFAULT_API_MODEL : undefined,
      apiWireApi: input.accountMode === 'api' ? text(input.apiWireApi, existingById?.apiWireApi) ?? DEFAULT_API_WIRE_API : undefined,
      modelReasoningEffort: input.accountMode === 'api' ? normalizeModelReasoningEffort(input.modelReasoningEffort ?? existingById?.modelReasoningEffort) : undefined,
      accountId: text(input.accountId, identity.accountId, existingById?.accountId),
      email: text(input.email, identity.email), source: text(input.source) ?? source, authTokens: input.authTokens,
      cpaAuthFileName: text(input.cpaAuthFileName, existingById?.cpaAuthFileName),
      modeVisibility: visibility(input.modeVisibility ?? existingById?.modeVisibility, text(input.source) ?? source),
      fiveHourWeekPercent: Math.max(0, Math.min(100, number(input.fiveHourWeekPercent, 16))), addedAt: text(input.addedAt) ?? now, updatedAt: now
    }
    if (candidate.accountMode === 'api' && (!candidate.apiKey || !candidate.apiEndpoint)) throw new Error('API 模式需要端点和密钥')
    if (candidate.accountMode === 'codex' && !candidate.accessToken) throw new Error('Codex 账号需要 access_token')
    const index = this.accounts.findIndex((item) => item.id === candidate.id || this.dedupeKey(item) === this.dedupeKey(candidate))
    if (index >= 0) {
      const old = this.accounts[index]
      candidate.id = old.id; candidate.addedAt = old.addedAt
      candidate.authTokens = candidate.authTokens ?? old.authTokens
      candidate.email = candidate.email ?? old.email
      this.accounts[index] = candidate
    } else {
      this.accounts.push(candidate)
      this.settings.accountOrder.push(candidate.id)
    }
    await this.save()
    return candidate
  }

  async syncCodexAuth(id: string, input: AccountInput): Promise<boolean> {
    const account = this.get(id)
    if (account.accountMode !== 'codex' || input.accountMode !== 'codex') return false
    const authTokens = input.authTokens
    const accessToken = text(authTokens?.access_token, input.accessToken)
    if (!accessToken || !authTokens) throw new Error('当前 auth.json 缺少完整的 Codex 令牌数据')
    const identity = identityFromTokens(authTokens)
    const accountId = text(input.accountId, identity.accountId, account.accountId)
    const email = text(input.email, identity.email, account.email)
    const unchanged = account.accessToken === accessToken && account.accountId === accountId && account.email === email &&
      JSON.stringify(account.authTokens ?? {}) === JSON.stringify(authTokens)
    if (unchanged) return false
    account.accessToken = accessToken
    account.authTokens = { ...authTokens }
    account.accountId = accountId
    account.email = email
    account.updatedAt = new Date().toISOString()
    await this.save()
    return true
  }

  async remove(id: string): Promise<void> {
    this.accounts = this.accounts.filter((item) => item.id !== id)
    this.settings.accountOrder = this.settings.accountOrder.filter((item) => item !== id)
    if (this.settings.lastNativeAccountId === id) this.settings.lastNativeAccountId = undefined
    await this.save()
  }
  get(id: string): Account { const account = this.accounts.find((item) => item.id === id); if (!account) throw new Error('账号不存在'); return account }
  orderedAccounts(): Account[] {
    const ranks = new Map(this.settings.accountOrder.map((id, index) => [id, index]))
    return [...this.accounts].sort((left, right) => (ranks.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.addedAt.localeCompare(right.addedAt))
  }
  async reorder(ids: string[]): Promise<void> {
    const known = new Set(this.accounts.map((account) => account.id))
    const unique = [...new Set(ids.filter((id) => known.has(id)))]
    this.settings.accountOrder = [...unique, ...this.accounts.map((account) => account.id).filter((id) => !unique.includes(id))]
    await this.save()
  }
  public(account: Account, current = false, preferred = false): PublicAccount {
    const { accessToken: _a, apiKey: _k, authTokens: _t, ...rest } = account
    return { ...rest, hasAccessToken: Boolean(account.accessToken), hasApiKey: Boolean(account.apiKey), current, preferred }
  }
}
