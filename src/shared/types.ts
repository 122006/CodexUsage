export type AccountMode = 'codex' | 'api'
export const API_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ModelReasoningEffort = typeof API_REASONING_EFFORTS[number]
export const DEFAULT_API_MODEL = 'gpt-5.6-sol'
export const DEFAULT_API_WIRE_API = 'responses'
export const DEFAULT_MODEL_REASONING_EFFORT: ModelReasoningEffort = 'high'
export function normalizeModelReasoningEffort(value: unknown): ModelReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return API_REASONING_EFFORTS.includes(normalized as ModelReasoningEffort) ? normalized as ModelReasoningEffort : DEFAULT_MODEL_REASONING_EFFORT
}

export interface SecretValue {
  encoding: 'safe-storage' | 'plain'
  value: string
}

export interface Account {
  id: string
  label: string
  accountId?: string
  email?: string
  source: string
  accountMode: AccountMode
  apiEndpoint?: string
  apiModel?: string
  apiWireApi?: string
  modelReasoningEffort?: ModelReasoningEffort
  accessToken?: string
  apiKey?: string
  authTokens?: Record<string, unknown>
  fiveHourWeekPercent: number
  addedAt: string
  updatedAt: string
}

export interface PublicAccount extends Omit<Account, 'accessToken' | 'apiKey' | 'authTokens'> {
  hasAccessToken: boolean
  hasApiKey: boolean
  current: boolean
}

export interface UsageWindow {
  name: string
  used: number
  remaining: number
  resetAt?: number
}

export interface UsageResult {
  accountId: string
  statusCode: number
  windows: UsageWindow[]
  error?: string
  queriedAt: string
  resetCredits?: number
  planType?: string
}

export interface AppSettings {
  autoQuerySeconds: number
  showStatusWidget: boolean
  statusWidgetPosition?: { x: number; y: number }
}

export interface AppSnapshot {
  accounts: PublicAccount[]
  results: Record<string, UsageResult>
  settings: AppSettings
  refreshingIds: string[]
  plusWeekAverage?: number
  logPath: string
  codexHome: string
}

export interface AccountInput {
  id?: string
  label?: string
  accountMode: AccountMode
  accessToken?: string
  accountId?: string
  email?: string
  apiEndpoint?: string
  apiModel?: string
  apiWireApi?: string
  modelReasoningEffort?: ModelReasoningEffort
  apiKey?: string
  fiveHourWeekPercent?: number
  authTokens?: Record<string, unknown>
}

export interface ImportResult {
  imported: number
  errors: string[]
}

export interface SwitchResult {
  message: string
  changedSessions: number
  encryptedRiskFiles: number
  targetProvider: string
  backupDirectory?: string
  sqliteProviderRows?: number
}

export interface ResetCreditDetail {
  availableCount?: number
  totalSuccessfulReferrals?: number
  grants: Array<{ grantedAt?: string; expiresAt?: string }>
  fetchedAt: string
}

export interface LocalBridge {
  getSnapshot(): Promise<AppSnapshot>
  refresh(accountIds?: string[]): Promise<void>
  importCurrent(): Promise<PublicAccount>
  saveAccount(input: AccountInput): Promise<PublicAccount>
  removeAccount(id: string): Promise<void>
  switchAccount(id: string): Promise<SwitchResult>
  importText(text: string): Promise<ImportResult>
  exportAccounts(ids?: string[]): Promise<string>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getResetCreditDetail(id: string): Promise<ResetCreditDetail>
  installHook(): Promise<string>
  openCodex(): Promise<void>
  openLog(): Promise<void>
  openLogDirectory(): Promise<void>
  showPanel(): Promise<void>
  hidePanel(): Promise<void>
  quit(): Promise<void>
  startWidgetDrag(): Promise<void>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
}
