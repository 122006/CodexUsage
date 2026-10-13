import { app, BrowserWindow, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { normalizeModelReasoningEffort } from '../shared/types'
import type { Account, AccountInput, AppSnapshot, CpaStatus, ImportResult, LocalBridge, OperationMode, SwitchResult, UsageResult } from '../shared/types'
import { findCurrentAccountId } from './account-match'
import { queryApiModels } from './api-models'
import { startLocalHttpServer } from './http-server'
import type { LocalHttpServer } from './http-server'
import { AccountStore } from './store'
import { CpaClient, cpaAccountPriority, cpaApiEndpoint, managedAuthFileName, normalizeCpaBaseUrl } from './cpa'
import { codexTokenData, refreshCodexOAuthCredential } from './codex-oauth'
import { cleanupProviderBackups, codexHome, currentAuth, hookSignalPath, importCurrentInput, installStopHook, openCodex, openPath, repairWindowsRolloutPaths, switchAccount, updateCurrentCodexAuth } from './codex'
import { queryResetCredits, querySubscription, queryUsage } from './quota'
import { DailyTokenUsageIndex } from './token-usage'
import { CpaTrafficCache } from './cpa-traffic'

let mainWindow: BrowserWindow | undefined
let widgetWindow: BrowserWindow | undefined
let widgetReady = false
let widgetMenuOpen = false
let windowIcon: Electron.NativeImage | undefined
let httpServer: LocalHttpServer | undefined
let browserUrl = ''
let tray: Tray | undefined
let quitting = false
let autoTimer: NodeJS.Timeout | undefined
let resetTimer: NodeJS.Timeout | undefined
let hookTimer: NodeJS.Timeout | undefined
let hookStamp = 0
const results = new Map<string, UsageResult>()
const refreshing = new Set<string>()
const credentialRefreshing = new Set<string>()
let store: AccountStore
let logPath: string
let tokenUsageIndex: DailyTokenUsageIndex
let cpaRuntime: Pick<CpaStatus, 'connected' | 'version' | 'lastTestedAt' | 'lastError'> = {}
const cpaTrafficCache = new CpaTrafficCache()
let cpaTrafficError = ''

function terminateOtherInstances(): void {
  if (process.platform === 'win32') {
    const pathLiteral = `'${process.execPath.replaceAll("'", "''")}'`
    const nameLiteral = `'${basename(process.execPath).replaceAll("'", "''")}'`
    const script = `$currentPid = ${process.pid}; $path = ${pathLiteral}; $name = ${nameLiteral}; $matchByName = ${app.isPackaged ? '$true' : '$false'}; $others = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $currentPid -and (($matchByName -and $_.Name -eq $name) -or (-not $matchByName -and $_.ExecutablePath -eq $path)) }); foreach ($other in $others) { Stop-Process -Id $other.ProcessId -Force -ErrorAction SilentlyContinue }; if ($others.Count) { Start-Sleep -Milliseconds 500 }`
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 10_000, windowsHide: true })
    } catch (error) {
      console.error('无法关闭旧的 CodexUsage 实例', error)
    }
    return
  }

  try {
    const oldPids = execFileSync('pgrep', ['-x', basename(process.execPath)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number).filter((pid) => pid && pid !== process.pid)
    for (const pid of oldPids) try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
    if (oldPids.length) execFileSync('sleep', ['0.5'])
    for (const pid of oldPids) try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* exited normally */ }
  } catch (error) {
    console.error('无法关闭旧的 CodexUsage 实例', error)
  }
}

async function log(title: string, details: string[] = []): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `[${new Date().toLocaleString('zh-CN')}] ${title}\n${details.join('\n')}\n${'-'.repeat(72)}\n\n`, 'utf8').catch(console.error)
}

async function currentId(): Promise<string | undefined> {
  if (store.settings.operationMode === 'cpa') return undefined
  return findCurrentAccountId(store.accounts, await currentAuth())
}

async function syncCurrentCodexAuth(): Promise<boolean> {
  if (store.settings.operationMode === 'cpa') return false
  const state = await currentAuth()
  if (state.mode !== 'codex') return false
  const id = findCurrentAccountId(store.accounts, state)
  if (!id) return false
  const changed = await store.syncCodexAuth(id, await importCurrentInput())
  if (changed) await log('已同步 Codex 最新登录令牌', [`账号: ${state.email ?? state.accountId ?? id}`, '来源: 当前 auth.json'])
  return changed
}

function cpaStatus(): CpaStatus {
  return {
    hasManagementSecret: Boolean(store.cpaManagementSecret),
    hasClientApiKey: Boolean(store.cpaClientApiKey),
    ...cpaRuntime
  }
}

function cpaClient(): CpaClient {
  return new CpaClient(store.settings.cpaBaseUrl, store.cpaManagementSecret ?? '')
}

async function saveRefreshedCodexAccount(account: Account, credential: Record<string, unknown>, wasCurrent: boolean): Promise<boolean> {
  const tokens = codexTokenData(credential)
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : ''
  if (!accessToken) throw new Error('刷新后的凭据缺少 access_token')
  await store.syncCodexAuth(account.id, { accountMode: 'codex', accessToken, authTokens: tokens })
  if (!wasCurrent) return false
  await updateCurrentCodexAuth(store.get(account.id))
  return true
}

async function syncAccountsToCpa(refreshModels = false): Promise<Awaited<ReturnType<CpaClient['syncAccounts']>>> {
  const client = cpaClient()
  if (store.cpaClientApiKey) await client.ensureClientApiKey(store.cpaClientApiKey)
  const result = await client.syncAccounts(store.orderedAccounts(), { queryModels: queryApiModels, refreshModels })
  await log('CPA 账号同步完成', [
    `OAuth 新增: ${result.oauthAdded}`,
    `OAuth 更新: ${result.oauthUpdated}`,
    `API 新增: ${result.apiAdded}`,
    `API 更新: ${result.apiUpdated}`,
    `跳过: ${result.skipped}`
  ])
  return result
}

async function syncCpaIfConfigured(): Promise<void> {
  if (!store.cpaManagementSecret) return
  try { await syncAccountsToCpa() } catch (error) { await log('自动同步账号到 CPA 失败', [String(error)]) }
}

function unchangedSwitchResult(message: string, targetProvider: string): SwitchResult {
  return { message, targetProvider, changedSessions: 0, encryptedRiskFiles: 0, sqliteProviderRows: 0, skippedSessions: 0, providerSyncFailures: 0 }
}

async function switchOperationMode(mode: OperationMode): Promise<SwitchResult> {
  if (mode === store.settings.operationMode) return unchangedSwitchResult(`当前已经是${mode === 'cpa' ? ' CPA' : '原生'}模式`, mode)
  if (mode === 'cpa') {
    const client = cpaClient()
    const clientApiKey = store.cpaClientApiKey?.trim()
    if (!clientApiKey) throw new Error('请先在 CPA 设置中配置客户端 API Key')
    const connection = await client.testConnection()
    cpaRuntime = { connected: true, version: connection.version, lastTestedAt: connection.testedAt }
    await client.ensureClientApiKey(clientApiKey)
    await syncAccountsToCpa()
    store.settings.lastNativeAccountId = await currentId() ?? store.settings.lastNativeAccountId
    const now = new Date().toISOString()
    const account: Account = {
      id: '__codexusage_cpa__',
      label: 'CLIProxyAPI',
      source: 'codexusage-cpa',
      accountMode: 'api',
      apiEndpoint: cpaApiEndpoint(store.settings.cpaBaseUrl),
      apiKey: clientApiKey,
      apiModel: store.settings.cpaModel,
      apiWireApi: store.settings.cpaWireApi,
      modelReasoningEffort: store.settings.cpaModelReasoningEffort,
      modeVisibility: 'cpa',
      fiveHourWeekPercent: 16,
      addedAt: now,
      updatedAt: now
    }
    const result = await switchAccount(account)
    store.settings.operationMode = 'cpa'
    await store.save()
    await log('已切换到 CPA 模式', [`地址: ${store.settings.cpaBaseUrl}`, `模型: ${store.settings.cpaModel}`])
    await broadcast()
    return { ...result, message: '已切换到 CPA 模式并重新启动 Codex' }
  }

  const target = (store.settings.lastNativeAccountId ? store.accounts.find((account) => account.id === store.settings.lastNativeAccountId && visibleInMode(account, 'native')) : undefined) ?? store.orderedAccounts().find((account) => visibleInMode(account, 'native'))
  if (!target) throw new Error('没有可恢复的原生账号')
  const result = await switchAccount(target)
  store.settings.operationMode = 'native'
  store.settings.lastNativeAccountId = target.id
  await store.save()
  await log('已切换到原生模式', [`账号: ${target.email ?? target.apiEndpoint ?? target.label}`])
  await broadcast()
  return { ...result, message: '已恢复原生账号并重新启动 Codex' }
}

function remaining(result: UsageResult | undefined, key: '5h' | '7d'): number | undefined {
  const values = result?.windows.filter((item) => item.name === key || item.name.endsWith(`:${key}`)).map((item) => item.remaining) ?? []
  return values.length ? Math.min(...values) : undefined
}

function visibleInMode(account: Account, mode: OperationMode): boolean {
  return account.modeVisibility === 'both' || account.modeVisibility === mode
}

function moveWidgetToWorkArea(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const display = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const [width, height] = widgetWindow.getSize()
  const x = Math.max(area.x, area.x + area.width - width - 12)
  const y = Math.max(area.y, area.y + area.height - height)
  widgetWindow.setPosition(Math.round(x), Math.round(y), false)
}

function keepWidgetOnTop(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  if (process.platform === 'win32') widgetWindow.setAlwaysOnTop(true, 'screen-saver')
  else if (process.platform === 'darwin') widgetWindow.setAlwaysOnTop(true, 'floating')
  else widgetWindow.setAlwaysOnTop(true)
  widgetWindow.moveTop()
}

function showMainPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function openBrowserPage(): Promise<void> {
  if (!browserUrl) throw new Error('本地 HTTP 服务尚未启动')
  await shell.openExternal(browserUrl)
}

function loadWindowIcon(): Electron.NativeImage | undefined {
  const path = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png')
  const icon = nativeImage.createFromPath(path)
  return icon.isEmpty() ? undefined : icon
}

async function showWidgetContextMenu(): Promise<void> {
  if (widgetMenuOpen || !widgetWindow || widgetWindow.isDestroyed()) return
  widgetMenuOpen = true
  try {
    const id = await currentId()
    const preferred = store.settings.operationMode === 'cpa' ? store.orderedAccounts().find((item) => visibleInMode(item, 'cpa')) : undefined
    const account = id ? store.accounts.find((item) => item.id === id) : preferred
    const menu = Menu.buildFromTemplate([
      { label: '刷新当前', enabled: Boolean(account?.accountMode === 'codex' && id && !refreshing.has(id)), click: () => { if (id) void refreshAccounts([id]) } },
      { label: '打开面板', click: showMainPanel }
    ])
    menu.popup({ window: widgetWindow, callback: () => { widgetMenuOpen = false } })
  } catch (error) {
    widgetMenuOpen = false
    await log('打开悬浮窗菜单失败', [String(error)])
  }
}

async function snapshot(): Promise<AppSnapshot> {
  const active = await currentId()
  const orderedAccounts = store.orderedAccounts()
  const preferred = store.settings.operationMode === 'cpa' ? orderedAccounts.find((account) => visibleInMode(account, 'cpa'))?.id : undefined
  const resultObject = Object.fromEntries(results)
  const plusWeeks = store.accounts.filter((account) => results.get(account.id)?.planType?.toLowerCase() === 'plus').map((account) => remaining(results.get(account.id), '7d')).filter((value): value is number => value !== undefined)
  return {
    accounts: orderedAccounts.map((account) => store.public(account, store.settings.operationMode === 'native' && account.id === active, account.id === preferred)),
    results: resultObject, settings: store.settings, refreshingIds: [...refreshing],
    plusWeekAverage: plusWeeks.length ? plusWeeks.reduce((sum, item) => sum + item, 0) / plusWeeks.length : undefined,
    cpa: cpaStatus(), logPath, codexHome
  }
}

async function broadcast(): Promise<void> {
  const value = await snapshot()
  httpServer?.publish(value)
  const active = value.accounts.find((account) => account.current || account.preferred)
  const showWidget = widgetReady && value.settings.showStatusWidget && active?.accountMode === 'codex'
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    if (showWidget && !widgetWindow.isVisible()) {
      moveWidgetToWorkArea()
      widgetWindow.showInactive()
    }
    if (showWidget) keepWidgetOnTop()
    if (!showWidget && widgetWindow.isVisible()) widgetWindow.hide()
  }
  updateTray(value)
}

async function runLimited<T>(values: T[], limit: number, task: (value: T) => Promise<void>): Promise<void> {
  const queue = [...values]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) { const value = queue.shift(); if (value) await task(value) }
  }))
}

async function refreshAccounts(ids?: string[]): Promise<void> {
  await syncCurrentCodexAuth().catch(async (error) => log('同步当前 Codex 登录令牌失败', [String(error)]))
  const accounts = store.accounts.filter((account) => account.accountMode === 'codex' && !refreshing.has(account.id) && (!ids?.length || ids.includes(account.id)))
  if (!accounts.length) return
  accounts.forEach((account) => refreshing.add(account.id)); await broadcast()
  const queried: Array<{ account: Account; usage: UsageResult }> = []
  try {
    await runLimited(accounts, 6, async (account) => {
      const result = await queryUsage(account)
      results.set(account.id, result)
      queried.push({ account, usage: result })
      if (result.error) await log('额度查询失败', [`账号: ${account.email ?? account.accountId ?? account.label}`, `HTTP: ${result.statusCode}`, `错误: ${result.error}`])
      await broadcast()
    })
    if (store.cpaManagementSecret) {
      try {
        const entries = queried.flatMap(({ account, usage }) => {
          const current = store.accounts.find((item) => item.id === account.id)
          return current && current.accountId === account.accountId ? [{ account: current, usage }] : []
        })
        for (const recovery of await cpaClient().recoverQuotaCooldowns(entries)) {
          const account = entries.find((item) => item.account.id === recovery.accountId)!.account
          await log(recovery.cleared ? '已自动修正 CPA 账号额度冷却' : '自动修正 CPA 账号额度冷却失败', [
            `账号: ${account.email ?? account.label}`,
            recovery.cleared ? '上游查询确认有额度；仅清除 CPA 本地冷却，未刷新凭证或消耗额度重置次数' : recovery.error ?? '未知错误'
          ])
        }
      } catch (error) { await log('检查 CPA 账号额度冷却失败', [error instanceof Error && error.message.includes('超时') ? '连接超时' : '请检查 CPA 地址、连接和管理密码']) }
    }
  } finally {
    accounts.forEach((account) => refreshing.delete(account.id))
    scheduleResetRefresh(); scheduleAutoRefresh(); await broadcast()
  }
}

function scheduleAutoRefresh(): void {
  if (autoTimer) clearTimeout(autoTimer)
  if (store.settings.autoQuerySeconds > 0) autoTimer = setTimeout(() => void refreshAccounts(), store.settings.autoQuerySeconds * 1000)
}

function scheduleResetRefresh(): void {
  if (resetTimer) clearTimeout(resetTimer)
  const now = Date.now() / 1000
  const candidates: Array<{ id: string; resetAt: number }> = []
  for (const [id, result] of results) for (const window of result.windows) {
    if (window.resetAt && window.resetAt > now && (window.name === '5h' || window.name === '7d' || window.name.endsWith(':5h') || window.name.endsWith(':7d'))) candidates.push({ id, resetAt: window.resetAt })
  }
  if (!candidates.length) return
  const next = Math.min(...candidates.map((item) => item.resetAt))
  resetTimer = setTimeout(() => {
    const due = [...new Set(candidates.filter((item) => item.resetAt <= next + 0.5).map((item) => item.id))]
    void refreshAccounts(due)
  }, Math.max(10, (next - now) * 1000 + 300))
}

function scheduleHookPoll(): void {
  if (hookTimer) clearInterval(hookTimer)
  hookTimer = setInterval(async () => {
    const stamp = await stat(hookSignalPath).then((value) => value.mtimeMs).catch(() => 0)
    if (!stamp || stamp === hookStamp) return
    const initial = hookStamp === 0; hookStamp = stamp
    if (initial) return
    const id = await currentId()
    await log('检测到 Codex Stop Hook 信号', [`当前账号: ${id ?? '未匹配，刷新全部'}`])
    void refreshAccounts(id ? [id] : undefined)
  }, 2000)
}

function load(window: BrowserWindow, type?: string): void {
  const target = new URL(browserUrl)
  if (type) target.searchParams.set('window', type)
  void window.loadURL(target.toString())
}

function createWindows(): void {
  mainWindow = new BrowserWindow({
    width: 920, height: 690, minWidth: 720, minHeight: 520, show: true, backgroundColor: '#f4f6f8',
    icon: windowIcon,
    title: 'Codex 额度面板', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => void log('主面板加载失败', [`${code}: ${description}`]))
  mainWindow.webContents.on('render-process-gone', (_event, details) => void log('主面板渲染进程退出', [JSON.stringify(details)]))
  mainWindow.webContents.on('console-message', (_event, level, message, line, source) => void log('主面板控制台', [`级别: ${level}`, `位置: ${source}:${line}`, message]))
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide() } })
  load(mainWindow)

  const display = screen.getPrimaryDisplay().workArea
  const saved = store.settings.statusWidgetPosition
  widgetWindow = new BrowserWindow({
    width: 300, height: 76, x: saved?.x ?? display.x + display.width - 312, y: saved?.y ?? display.y + display.height - 88,
    frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  widgetWindow.setTitle('Codex 额度浮窗')
  widgetWindow.webContents.on('did-finish-load', () => { widgetReady = true; widgetWindow?.setTitle('Codex 额度浮窗'); void broadcast() })
  widgetWindow.webContents.on('context-menu', (event) => { event.preventDefault(); void showWidgetContextMenu() })
  if (process.platform !== 'darwin') widgetWindow.on('system-context-menu', (event) => { event.preventDefault(); void showWidgetContextMenu() })
  keepWidgetOnTop()
  widgetWindow.on('moved', async () => { const [x, y] = widgetWindow!.getPosition(); store.settings.statusWidgetPosition = { x, y }; await store.save() })
  load(widgetWindow, 'widget')
}

function trayImage(): Electron.NativeImage {
  const source = windowIcon && !windowIcon.isEmpty() ? windowIcon : loadWindowIcon()
  if (!source || source.isEmpty()) throw new Error('无法读取托盘图标资源 resources/icon.png')
  const size = process.platform === 'darwin' ? 18 : 20
  return source.resize({ width: size, height: size, quality: 'best' })
}

function updateTray(value?: AppSnapshot): void {
  if (!tray) return
  const active = value?.accounts.find((account) => account.current || account.preferred)
  const week = active ? remaining(value?.results[active.id], '7d') : undefined
  tray.setToolTip(`Codex 额度${week === undefined ? '' : `：周限 ${week.toFixed(1)}%`}`)
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.on('double-click', showMainPanel)
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: showMainPanel },
    { label: '在浏览器中打开', click: () => void openBrowserPage().catch((error) => void log('打开浏览器页面失败', [String(error)])) },
    { label: '打开 Codex', click: () => void openCodex().catch((error) => void log('打开 Codex 失败', [String(error)])) },
    { label: '查询全部', click: () => void refreshAccounts() },
    { label: '显示状态小工具', type: 'checkbox', checked: store.settings.showStatusWidget, click: async (item) => { store.settings.showStatusWidget = item.checked; await store.save(); await broadcast() } },
    { type: 'separator' }, { label: '打开错误日志', click: () => void openPath(logPath) },
    { type: 'separator' }, { label: '退出', click: () => { quitting = true; app.quit() } }
  ])
  tray.setContextMenu(menu); updateTray()
}

function importItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.flatMap(importItems)
  if (!payload || typeof payload !== 'object') return []
  const item = payload as Record<string, unknown>
  if (Array.isArray(item.accounts)) return item.accounts.flatMap(importItems)
  if (item.tokens || item.auth_tokens || item.authTokens || item.access_token || item.accessToken || item.api_key || item.apiKey || item.OPENAI_API_KEY) return [item]
  return []
}

function inputFromImport(raw: unknown): AccountInput | undefined {
  if (typeof raw === 'string') return raw.trim() ? { accountMode: 'codex', accessToken: raw.trim() } : undefined
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const auth = (item.authTokens ?? item.auth_tokens ?? item.tokens) as Record<string, unknown> | undefined
  const apiKey = String(item.apiKey ?? item.api_key ?? item.OPENAI_API_KEY ?? '') || undefined
  const mode = item.accountMode === 'api' || item.account_mode === 'api' || apiKey ? 'api' : 'codex'
  return {
    id: typeof item.id === 'string' ? item.id : undefined, accountMode: mode,
    label: String(item.label ?? item.name ?? '') || undefined, email: String(item.email ?? '') || undefined,
    accountId: String(item.accountId ?? item.account_id ?? '') || undefined,
    accessToken: String(item.accessToken ?? item.access_token ?? auth?.access_token ?? '') || undefined,
    apiKey, apiEndpoint: String(item.apiEndpoint ?? item.api_endpoint ?? item.base_url ?? '') || undefined,
    apiModel: String(item.apiModel ?? item.model ?? '') || undefined,
    apiWireApi: String(item.apiWireApi ?? item.wireApi ?? item.wire_api ?? '') || undefined,
    modelReasoningEffort: mode === 'api' ? normalizeModelReasoningEffort(item.modelReasoningEffort ?? item.model_reasoning_effort) : undefined,
    cpaAuthFileName: String(item.cpaAuthFileName ?? item.cpa_auth_file_name ?? '') || undefined,
    modeVisibility: item.modeVisibility === 'native' || item.modeVisibility === 'cpa' ? item.modeVisibility : item.mode_visibility === 'native' || item.mode_visibility === 'cpa' ? item.mode_visibility : Boolean(item.cpaSyncDisabled ?? item.cpa_sync_disabled) ? 'native' : 'both',
    authTokens: auth, fiveHourWeekPercent: Number(item.fiveHourWeekPercent ?? item.five_hour_week_percent ?? 16)
  }
}

function createOperations(): Omit<LocalBridge, 'onSnapshot'> {
  return {
    getSnapshot: snapshot,
    refresh: refreshAccounts,
    importCurrent: async () => {
      if (store.settings.operationMode === 'cpa') throw new Error('CPA 模式下当前 auth.json 是中转配置，请切回原生模式后再导入当前 Codex')
      const account = await store.upsert(await importCurrentInput(), 'codex-auth')
      await syncCpaIfConfigured(); await broadcast()
      return store.public(account, true, false)
    },
    queryApiModels: async (input) => {
      const endpoint = typeof input?.apiEndpoint === 'string' ? input.apiEndpoint.trim() : ''
      try {
        let key = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
        if (!key && input?.storedAccountId) {
          const account = store.get(input.storedAccountId)
          if (account.accountMode === 'api') key = account.apiKey ?? ''
        }
        return await queryApiModels(endpoint, key)
      } catch (error) {
        await log('读取 API 模型列表失败', [`端点: ${endpoint || '未填写'}`, String(error)])
        throw error
      }
    },
    saveAccount: async (input) => {
      const account = await store.upsert(input)
      await syncCpaIfConfigured(); await broadcast()
      return store.public(account, false, false)
    },
    removeAccount: async (id) => { await store.remove(id); results.delete(id); await broadcast() },
    switchAccount: async (id) => {
      if (store.settings.operationMode === 'cpa') throw new Error('CPA 模式不直接切换账号，请拖拽账号顺序调整优先级')
      await syncCurrentCodexAuth()
      const account = store.get(id)
      if (!visibleInMode(account, 'native')) throw new Error('该账号配置为仅 CPA 模式，不能直接进行原生账号切换')
      const result = await switchAccount(account)
      store.settings.lastNativeAccountId = account.id
      await store.save()
      await log('账号切换完成', [
        `目标: ${account.email ?? account.label}`,
        `Provider: ${result.targetProvider}`,
        `已同步 rollout: ${result.changedSessions}`,
        `已同步 SQLite: ${result.sqliteProviderRows ?? 0}`,
        `跳过锁定 rollout: ${result.skippedSessions ?? 0}`,
        `同步失败: ${result.providerSyncFailures ?? 0}`,
        ...(result.providerSyncErrors ?? [])
      ])
      await broadcast()
      return result
    },
    refreshCredential: async (id, sourceMode) => {
      if (sourceMode !== 'native' && sourceMode !== 'cpa') throw new Error('凭证刷新来源无效')
      if (credentialRefreshing.has(id)) throw new Error('该账号的凭证正在刷新，请稍候')
      const account = store.get(id)
      if (account.accountMode !== 'codex') throw new Error('API Key 账号没有可刷新的 Codex OAuth 凭证')
      if (!visibleInMode(account, sourceMode)) throw new Error(`该账号不在${sourceMode === 'cpa' ? ' CPA' : '原生'}模式中`)
      credentialRefreshing.add(id)
      try {
        const wasCurrent = store.settings.operationMode === 'native' && await currentId() === id
        let credential: Record<string, unknown>
        let cpaUpdated = false
        let cpaWarning = ''
        if (sourceMode === 'cpa') {
          const client = cpaClient()
          const current = await client.downloadAuthFile(managedAuthFileName(account))
          credential = await refreshCodexOAuthCredential(current)
          await client.saveCodexCredential(account, credential, cpaAccountPriority(account, store.orderedAccounts()))
          cpaUpdated = true
        } else {
          credential = await refreshCodexOAuthCredential({ ...(account.authTokens ?? {}), access_token: account.accessToken })
        }
        const currentAuthUpdated = await saveRefreshedCodexAccount(account, credential, wasCurrent)
        if (sourceMode === 'native' && store.cpaManagementSecret && visibleInMode(account, 'cpa')) {
          try {
            await cpaClient().saveCodexCredential(store.get(id), credential, cpaAccountPriority(account, store.orderedAccounts()))
            cpaUpdated = true
          } catch (error) {
            cpaWarning = `；但同步到 CPA 失败：${String(error)}`
            await log('Codex OAuth 凭证已刷新，但同步到 CPA 失败', [`账号: ${account.email ?? account.label}`, String(error)])
          }
        }
        const updatedAt = new Date().toISOString()
        await log('Codex OAuth 凭证刷新成功', [
          `账号: ${account.email ?? account.label}`,
          `来源: ${sourceMode === 'cpa' ? 'CPA 凭据' : '程序本地凭据'}`,
          `CPA 已更新: ${cpaUpdated ? '是' : '否'}`,
          `当前 auth.json 已更新: ${currentAuthUpdated ? '是' : '否'}`
        ])
        await broadcast()
        return { message: `凭证刷新成功，不涉及额度重置${cpaWarning}`, updatedAt, cpaUpdated, currentAuthUpdated }
      } catch (error) {
        await log('Codex OAuth 凭证刷新失败', [`账号: ${account.email ?? account.label}`, `来源: ${sourceMode === 'cpa' ? 'CPA' : '原生'}`, String(error)])
        throw error
      } finally {
        credentialRefreshing.delete(id)
      }
    },
    importCpaAccount: async (id) => {
      const account = store.get(id)
      if (!visibleInMode(account, 'cpa')) throw new Error('该账号未配置为 CPA 模式可用')
      try {
        const client = cpaClient()
        let currentAuthUpdated = false
        if (account.accountMode === 'codex') {
          const payload = await client.downloadAuthFile(managedAuthFileName(account))
          const wasCurrent = store.settings.operationMode === 'native' && await currentId() === id
          currentAuthUpdated = await saveRefreshedCodexAccount(account, payload, wasCurrent)
        } else {
          const provider = await client.downloadApiProvider(account)
          const apiKey = provider['api-key-entries']?.find((item) => typeof item['api-key'] === 'string' && item['api-key'].trim())?.['api-key']
          if (!apiKey) throw new Error('CPA API 配置中没有可导回的密钥')
          await store.upsert({
            ...account,
            accountMode: 'api',
            apiEndpoint: provider['base-url'],
            apiKey,
            apiModel: account.apiModel
          }, account.source)
        }
        const updatedAt = new Date().toISOString()
        await log('CPA 配置已导回程序', [`账号: ${account.email ?? account.apiEndpoint ?? account.label}`, `类型: ${account.accountMode === 'codex' ? 'Codex OAuth' : 'API'}`])
        await broadcast()
        return { message: 'CPA 中的最新配置已导回程序', updatedAt, currentAuthUpdated }
      } catch (error) {
        await log('CPA 配置导回失败', [`账号: ${account.email ?? account.apiEndpoint ?? account.label}`, String(error)])
        throw error
      }
    },
    repairCodexSessions: async () => { const repaired = await repairWindowsRolloutPaths(); await log('Codex 会话检查完成', [`已修复: ${repaired}`]); return repaired },
    importText: async (value: string): Promise<ImportResult> => {
      const errors: string[] = []; let raw: unknown
      try { raw = JSON.parse(value) } catch { raw = value.split(/\r?\n/).filter(Boolean) }
      const items = importItems(raw); let imported = 0
      for (const [index, item] of items.entries()) { const input = inputFromImport(item); if (!input) { errors.push(`第 ${index + 1} 条无法识别`); continue } try { await store.upsert(input, 'clipboard'); imported += 1 } catch (error) { errors.push(`第 ${index + 1} 条：${String(error)}`) } }
      await syncCpaIfConfigured(); await broadcast(); return { imported, errors }
    },
    exportAccounts: async (ids) => JSON.stringify({ format: 'codex_usage_accounts', version: 2, exportedAt: new Date().toISOString(), accounts: store.accounts.filter((item) => !ids?.length || ids.includes(item.id)).map((item) => ({ ...item, lastQuery: results.get(item.id) })) }, null, 2),
    updateSettings: async (patch) => {
      if (typeof patch.autoQuerySeconds === 'number') store.settings.autoQuerySeconds = Math.max(0, Math.min(86400, patch.autoQuerySeconds))
      if (typeof patch.showStatusWidget === 'boolean') store.settings.showStatusWidget = patch.showStatusWidget
      if (typeof patch.showCpaTraffic === 'boolean') store.settings.showCpaTraffic = patch.showCpaTraffic
      if (patch.statusWidgetPosition) store.settings.statusWidgetPosition = patch.statusWidgetPosition
      await store.save(); scheduleAutoRefresh(); await broadcast(); return store.settings
    },
    updateCpaSettings: async (input) => {
      if (input.baseUrl !== undefined) store.settings.cpaBaseUrl = normalizeCpaBaseUrl(input.baseUrl)
      if (input.model !== undefined) store.settings.cpaModel = input.model.trim() || store.settings.cpaModel
      if (input.wireApi !== undefined) store.settings.cpaWireApi = input.wireApi.trim() || store.settings.cpaWireApi
      if (input.modelReasoningEffort !== undefined) store.settings.cpaModelReasoningEffort = normalizeModelReasoningEffort(input.modelReasoningEffort)
      if (input.clearManagementSecret) store.cpaManagementSecret = undefined
      else if (input.managementSecret?.trim()) store.cpaManagementSecret = input.managementSecret.trim()
      if (input.clearClientApiKey) store.cpaClientApiKey = undefined
      else if (input.clientApiKey?.trim()) store.cpaClientApiKey = input.clientApiKey.trim()
      cpaRuntime = {}
      await store.save(); await broadcast()
      return cpaStatus()
    },
    testCpaConnection: async () => {
      try {
        const result = await cpaClient().testConnection()
        cpaRuntime = { connected: true, version: result.version, lastTestedAt: result.testedAt }
        await log('CPA 连接测试成功', [`地址: ${store.settings.cpaBaseUrl}`, `版本: ${result.version ?? '未知'}`, `凭据: ${result.authFileCount ?? 0}`, `API Provider: ${result.apiProviderCount ?? 0}`])
        await broadcast()
        return result
      } catch (error) {
        cpaRuntime = { connected: false, lastTestedAt: new Date().toISOString(), lastError: String(error) }
        await log('CPA 连接测试失败', [`地址: ${store.settings.cpaBaseUrl}`, String(error)])
        await broadcast()
        throw error
      }
    },
    inspectCpa: async () => cpaClient().inspect(),
    getCpaTraffic: async () => {
      const accounts = store.orderedAccounts().filter((account) => account.modeVisibility !== 'native')
      const scope = createHash('sha256').update(JSON.stringify([
        store.settings.cpaBaseUrl, store.cpaManagementSecret,
        accounts.map((account) => [account.id, account.accountMode, account.cpaAuthFileName, account.apiEndpoint, account.apiKey]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ])).digest('hex')
      return cpaTrafficCache.get(scope, async () => {
        const result = await cpaClient().getTraffic(accounts)
        const errors = Object.entries(result.accounts).flatMap(([id, traffic]) => traffic.error ? [`${id}: ${traffic.error}`] : []).sort().join('\n')
        if (errors && errors !== cpaTrafficError) await log('CPA 流量查询失败', [errors])
        cpaTrafficError = errors
        return result
      })
    },
    syncCpaAccounts: async () => { const result = await syncAccountsToCpa(true); await broadcast(); return result },
    migrateCpaLegacy: async (loopbackAccountId) => {
      const loopback = store.get(loopbackAccountId)
      if (loopback.accountMode !== 'api' || !loopback.apiKey) throw new Error('指定的 CPA 回环账号不是有效 API 账号')
      const client = cpaClient()
      const authFiles = await client.listAuthFiles()
      const existingNames = new Set(store.accounts.map((account) => account.cpaAuthFileName).filter((name): name is string => Boolean(name)))
      let importedAccounts = 0
      let reusedAccounts = 0
      for (const file of authFiles) {
        const name = typeof file.name === 'string' ? file.name.trim() : ''
        const provider = String(file.provider ?? file.type ?? '').toLowerCase()
        if (!name || provider !== 'codex' || name.toLowerCase().startsWith('codexusage-')) continue
        if (existingNames.has(name)) { reusedAccounts += 1; continue }
        const payload = await client.downloadAuthFile(name)
        const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
        if (!accessToken) throw new Error(`CPA 凭据 ${name} 缺少 access_token`)
        const tokens = { ...payload }
        for (const key of ['type', 'priority', 'note', 'disabled', 'codex_usage_account_id']) delete tokens[key]
        await store.upsert({
          accountMode: 'codex',
          label: typeof payload.email === 'string' ? payload.email : name.replace(/\.json$/i, ''),
          email: typeof payload.email === 'string' ? payload.email : undefined,
          accountId: typeof payload.account_id === 'string' ? payload.account_id : undefined,
          accessToken,
          authTokens: tokens,
          cpaAuthFileName: name,
          fiveHourWeekPercent: 16
        }, 'cpa-auth')
        existingNames.add(name)
        importedAccounts += 1
      }
      loopback.modeVisibility = 'native'
      loopback.updatedAt = new Date().toISOString()
      if (!store.cpaClientApiKey) store.cpaClientApiKey = loopback.apiKey
      await store.save()
      await client.ensureClientApiKey(store.cpaClientApiKey)
      const removedLoopbackProvider = await client.removeManagedApiAccount(loopback)
      await syncAccountsToCpa()
      await log('CPA 一次性账号迁移完成', [
        `导入 OAuth: ${importedAccounts}`,
        `复用 OAuth: ${reusedAccounts}`,
        `保留回环账号: ${loopback.apiEndpoint ?? loopback.label}`,
        `删除回环 Provider: ${removedLoopbackProvider ? '是' : '未找到'}`
      ])
      await broadcast()
      return { importedAccounts, reusedAccounts, keptLoopbackAccount: true, removedLoopbackProvider, syncedAt: new Date().toISOString() }
    },
    setOperationMode: switchOperationMode,
    reorderAccounts: async (ids) => {
      const previous = [...store.settings.accountOrder]
      await store.reorder(ids)
      try {
        if (store.settings.operationMode === 'cpa') await syncAccountsToCpa()
      } catch (error) {
        await store.reorder(previous)
        throw error
      }
      await broadcast()
    },
    getResetCreditDetail: async (id) => queryResetCredits(store.get(id)),
    getSubscriptionDetail: async (id) => {
      const account = store.get(id)
      try { return await querySubscription(account) } catch (error) {
        await log('查询订阅到期时间失败', [`账号: ${account.email ?? account.label}`, String(error)])
        throw error
      }
    },
    getDailyTokenUsage: async () => {
      try {
        const result = await tokenUsageIndex.query()
        if (result.errors.length) await log('Token 日统计存在部分文件读取失败', result.errors)
        return result
      } catch (error) {
        await log('Token 日统计失败', [String(error)])
        throw error
      }
    },
    installHook: async () => installStopHook(logPath),
    openCodex,
    openBrowser: openBrowserPage,
    openLog: async () => { await appendFile(logPath, ''); await openPath(logPath) },
    openLogDirectory: async () => openPath(dirname(logPath)),
    showPanel: async () => showMainPanel(),
    hidePanel: async () => { mainWindow?.hide() },
    quit: async () => { quitting = true; setImmediate(() => app.quit()) },
    startWidgetDrag: async () => undefined
  }
}

terminateOtherInstances()
const ownsSingleInstanceLock = app.requestSingleInstanceLock()

if (!ownsSingleInstanceLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.codex.usage-panel')
    windowIcon = loadWindowIcon()
    if (process.platform === 'darwin' && windowIcon) app.dock?.setIcon(windowIcon)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    store = new AccountStore(); await store.load(); logPath = join(dirname(store.path), 'query_errors.log')
    tokenUsageIndex = new DailyTokenUsageIndex(join(dirname(store.path), 'token_usage.v1.json'), [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')])
    await appendFile(logPath, '').catch(() => undefined)
    await syncCurrentCodexAuth().catch(async (error) => log('启动时同步 Codex 登录令牌失败', [String(error)]))
    const backupCleanup = await cleanupProviderBackups()
    if (backupCleanup.removedCount || backupCleanup.failures.length) {
      await log('Provider 历史快照清理', [
        `保留: ${backupCleanup.kept ?? '无'}`,
        `已删除: ${backupCleanup.removedCount}`,
        ...backupCleanup.failures.map((failure) => `失败: ${failure}`)
      ])
    }
    const rendererDevUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
    httpServer = await startLocalHttpServer({ rendererDirectory: join(__dirname, '../renderer'), rendererDevUrl, operations: createOperations() })
    browserUrl = httpServer.url
    createWindows(); createTray(); scheduleAutoRefresh(); scheduleHookPoll(); await broadcast()
    void refreshAccounts()
  })

  app.on('activate', () => { mainWindow?.show() })
  app.on('before-quit', () => { quitting = true; void httpServer?.close() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && quitting) app.quit() })
}
