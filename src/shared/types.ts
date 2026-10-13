export type AccountMode = 'codex' | 'api'
export type OperationMode = 'native' | 'cpa'
export type AccountVisibility = 'both' | OperationMode
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
  cpaAuthFileName?: string
  modeVisibility: AccountVisibility
  fiveHourWeekPercent: number
  addedAt: string
  updatedAt: string
}

export interface PublicAccount extends Omit<Account, 'accessToken' | 'apiKey' | 'authTokens'> {
  hasAccessToken: boolean
  hasApiKey: boolean
  current: boolean
  preferred: boolean
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
  quotaAvailable?: boolean
}

export interface AppSettings {
  autoQuerySeconds: number
  showStatusWidget: boolean
  showCpaTraffic: boolean
  statusWidgetPosition?: { x: number; y: number }
  operationMode: OperationMode
  cpaBaseUrl: string
  cpaModel: string
  cpaWireApi: string
  cpaModelReasoningEffort: ModelReasoningEffort
  accountOrder: string[]
  lastNativeAccountId?: string
}

export interface CpaStatus {
  hasManagementSecret: boolean
  hasClientApiKey: boolean
  connected?: boolean
  version?: string
  lastTestedAt?: string
  lastError?: string
}

export interface CpaSettingsInput {
  baseUrl?: string
  managementSecret?: string
  clientApiKey?: string
  clearManagementSecret?: boolean
  clearClientApiKey?: boolean
  model?: string
  wireApi?: string
  modelReasoningEffort?: ModelReasoningEffort
}

export interface CpaConnectionResult {
  connected: boolean
  version?: string
  testedAt: string
  authFileCount?: number
  apiProviderCount?: number
}

export interface CpaSyncResult {
  oauthAdded: number
  oauthUpdated: number
  apiAdded: number
  apiUpdated: number
  skipped: number
  syncedAt: string
}

export interface CpaInventory {
  authFiles: Array<{
    name: string
    provider?: string
    email?: string
    planType?: string
    priority?: number
    disabled?: boolean
    managedByCodexUsage: boolean
  }>
  apiProviders: Array<{
    name: string
    baseUrl: string
    priority?: number
    models: string[]
    disabled?: boolean
    managedByCodexUsage: boolean
  }>
}

export interface CpaTrafficBucket {
  startTime: number
  endTime: number
  success: number
  failed: number
}

export interface CpaAccountTraffic {
  success?: number
  failed?: number
  buckets?: CpaTrafficBucket[]
  updatedAt?: string
  error?: string
}

export interface CpaTrafficResult {
  accounts: Record<string, CpaAccountTraffic>
  fetchedAt: string
}

export interface CpaMigrationResult {
  importedAccounts: number
  reusedAccounts: number
  keptLoopbackAccount: boolean
  removedLoopbackProvider: boolean
  syncedAt: string
}

export interface CredentialActionResult {
  message: string
  updatedAt: string
  cpaUpdated?: boolean
  currentAuthUpdated?: boolean
}

export interface DailyTokenUsage {
  date: string
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  calls: number
}

export interface DailyTokenUsageResult {
  days: DailyTokenUsage[]
  totalTokens: number
  indexedFiles: number
  changedFiles: number
  errors: string[]
  timezone: string
  updatedAt: string
  elapsedMs: number
}

export interface AppSnapshot {
  accounts: PublicAccount[]
  results: Record<string, UsageResult>
  settings: AppSettings
  refreshingIds: string[]
  plusWeekAverage?: number
  cpa: CpaStatus
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
  cpaAuthFileName?: string
  modeVisibility?: AccountVisibility
}

export interface ApiModelQuery {
  storedAccountId?: string
  apiEndpoint: string
  apiKey?: string
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
  skippedSessions?: number
  providerSyncFailures?: number
  providerSyncErrors?: string[]
}

export interface ResetCreditDetail {
  availableCount?: number
  totalSuccessfulReferrals?: number
  grants: Array<{ grantedAt?: string; expiresAt?: string }>
  fetchedAt: string
}

export interface SubscriptionDetail {
  planType?: string
  subscriptionPlan?: string
  hasActiveSubscription?: boolean
  expiresAt?: string
  renewsAt?: string
  cancelsAt?: string
  billingPeriod?: string
  willRenew?: boolean
  purchaseOriginPlatform?: string
  isDelinquent?: boolean
  fetchedAt: string
}

export interface LocalBridge {
  getSnapshot(): Promise<AppSnapshot>
  refresh(accountIds?: string[]): Promise<void>
  importCurrent(): Promise<PublicAccount>
  queryApiModels(input: ApiModelQuery): Promise<string[]>
  saveAccount(input: AccountInput): Promise<PublicAccount>
  removeAccount(id: string): Promise<void>
  switchAccount(id: string): Promise<SwitchResult>
  refreshCredential(id: string, sourceMode: OperationMode): Promise<CredentialActionResult>
  importCpaAccount(id: string): Promise<CredentialActionResult>
  repairCodexSessions(): Promise<number>
  importText(text: string): Promise<ImportResult>
  exportAccounts(ids?: string[]): Promise<string>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  updateCpaSettings(input: CpaSettingsInput): Promise<CpaStatus>
  testCpaConnection(): Promise<CpaConnectionResult>
  inspectCpa(): Promise<CpaInventory>
  getCpaTraffic(): Promise<CpaTrafficResult>
  syncCpaAccounts(): Promise<CpaSyncResult>
  migrateCpaLegacy(loopbackAccountId: string): Promise<CpaMigrationResult>
  setOperationMode(mode: OperationMode): Promise<SwitchResult>
  reorderAccounts(ids: string[]): Promise<void>
  getResetCreditDetail(id: string): Promise<ResetCreditDetail>
  getSubscriptionDetail(id: string): Promise<SubscriptionDetail>
  getDailyTokenUsage(): Promise<DailyTokenUsageResult>
  installHook(): Promise<string>
  openCodex(): Promise<void>
  openBrowser(): Promise<void>
  openLog(): Promise<void>
  openLogDirectory(): Promise<void>
  showPanel(): Promise<void>
  hidePanel(): Promise<void>
  quit(): Promise<void>
  startWidgetDrag(): Promise<void>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
}
