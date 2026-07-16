import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { normalizeModelReasoningEffort } from '../shared/types'
import type { Account, AccountInput, AppSettings, AppSnapshot, ImportResult, UsageResult } from '../shared/types'
import { findCurrentAccountId } from './account-match'
import { AccountStore } from './store'
import { codexHome, currentAuth, hookSignalPath, importCurrentInput, installStopHook, openCodex, openPath, switchAccount } from './codex'
import { queryResetCredits, queryUsage } from './quota'

let mainWindow: BrowserWindow | undefined
let widgetWindow: BrowserWindow | undefined
let widgetReady = false
let tray: Tray | undefined
let quitting = false
let autoTimer: NodeJS.Timeout | undefined
let resetTimer: NodeJS.Timeout | undefined
let hookTimer: NodeJS.Timeout | undefined
let hookStamp = 0
const results = new Map<string, UsageResult>()
const refreshing = new Set<string>()
let store: AccountStore
let logPath: string

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
  return findCurrentAccountId(store.accounts, await currentAuth())
}

function remaining(result: UsageResult | undefined, key: '5h' | '7d'): number | undefined {
  const values = result?.windows.filter((item) => item.name === key || item.name.endsWith(`:${key}`)).map((item) => item.remaining) ?? []
  return values.length ? Math.min(...values) : undefined
}

async function snapshot(): Promise<AppSnapshot> {
  const active = await currentId()
  const resultObject = Object.fromEntries(results)
  const plusWeeks = store.accounts.filter((account) => results.get(account.id)?.planType?.toLowerCase() === 'plus').map((account) => remaining(results.get(account.id), '7d')).filter((value): value is number => value !== undefined)
  return {
    accounts: store.accounts.map((account) => store.public(account, account.id === active)),
    results: resultObject, settings: store.settings, refreshingIds: [...refreshing],
    plusWeekAverage: plusWeeks.length ? plusWeeks.reduce((sum, item) => sum + item, 0) / plusWeeks.length : undefined,
    logPath, codexHome
  }
}

async function broadcast(): Promise<void> {
  const value = await snapshot()
  for (const window of [mainWindow, widgetWindow]) if (window && !window.isDestroyed()) window.webContents.send('snapshot', value)
  const active = value.accounts.find((account) => account.current)
  const showWidget = widgetReady && value.settings.showStatusWidget && active?.accountMode === 'codex'
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    if (showWidget && !widgetWindow.isVisible()) widgetWindow.showInactive()
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
  const accounts = store.accounts.filter((account) => account.accountMode === 'codex' && (!ids?.length || ids.includes(account.id)))
  if (!accounts.length) return
  accounts.forEach((account) => refreshing.add(account.id)); await broadcast()
  await runLimited(accounts, 6, async (account) => {
    const result = await queryUsage(account)
    results.set(account.id, result); refreshing.delete(account.id)
    if (result.error) await log('额度查询失败', [`账号: ${account.email ?? account.accountId ?? account.label}`, `HTTP: ${result.statusCode}`, `错误: ${result.error}`])
    await broadcast()
  })
  scheduleResetRefresh(); scheduleAutoRefresh(); await broadcast()
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

function appUrl(windowType?: string): { url?: string; file?: string; query?: Record<string, string> } {
  const query = windowType ? { window: windowType } : undefined
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}${windowType ? `?window=${windowType}` : ''}` }
  return { file: join(__dirname, '../renderer/index.html'), query }
}

function load(window: BrowserWindow, type?: string): void {
  const target = appUrl(type)
  if (target.url) void window.loadURL(target.url); else void window.loadFile(target.file!, { query: target.query })
}

function createWindows(): void {
  mainWindow = new BrowserWindow({
    width: 920, height: 690, minWidth: 720, minHeight: 520, show: true, backgroundColor: '#f4f6f8',
    title: 'Codex 额度面板', webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
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
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  widgetWindow.setTitle('Codex 额度浮窗')
  widgetWindow.webContents.on('did-finish-load', () => { widgetReady = true; widgetWindow?.setTitle('Codex 额度浮窗'); void broadcast() })
  widgetWindow.setAlwaysOnTop(true, 'floating')
  widgetWindow.on('moved', async () => { const [x, y] = widgetWindow!.getPosition(); store.settings.statusWidgetPosition = { x, y }; await store.save() })
  load(widgetWindow, 'widget')
}

function trayImage(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#f7fafb" stroke="#b8c7cf"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="#dfe8ec" stroke-width="5"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="#3999e8" stroke-width="5" pathLength="100" stroke-dasharray="62 38" transform="rotate(-90 16 16)"/><circle cx="16" cy="16" r="5" fill="none" stroke="#22c866" stroke-width="3.5" pathLength="100" stroke-dasharray="38 62" transform="rotate(-90 16 16)"/></svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 18, height: 18 })
}

function updateTray(value?: AppSnapshot): void {
  if (!tray) return
  const active = value?.accounts.find((account) => account.current)
  const week = active ? remaining(value?.results[active.id], '7d') : undefined
  tray.setToolTip(`Codex 额度${week === undefined ? '' : `：周限 ${week.toFixed(1)}%`}`)
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => { mainWindow?.show(); mainWindow?.focus() } },
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
    modelReasoningEffort: mode === 'api' ? normalizeModelReasoningEffort(item.modelReasoningEffort ?? item.model_reasoning_effort) : undefined,
    authTokens: auth, fiveHourWeekPercent: Number(item.fiveHourWeekPercent ?? item.five_hour_week_percent ?? 16)
  }
}

function registerIpc(): void {
  ipcMain.handle('snapshot:get', snapshot)
  ipcMain.handle('refresh', (_event, ids?: string[]) => refreshAccounts(ids))
  ipcMain.handle('account:import-current', async () => { const account = await store.upsert(await importCurrentInput(), 'codex-auth'); await broadcast(); return store.public(account, true) })
  ipcMain.handle('account:save', async (_event, input: AccountInput) => { const account = await store.upsert(input); await broadcast(); return store.public(account, false) })
  ipcMain.handle('account:remove', async (_event, id: string) => { await store.remove(id); results.delete(id); await broadcast() })
  ipcMain.handle('account:switch', async (_event, id: string) => { const result = await switchAccount(store.get(id)); await log('账号切换完成', [`目标: ${store.get(id).email ?? store.get(id).label}`, `Provider: ${result.targetProvider}`, `会话: ${result.changedSessions}`, `加密风险: ${result.encryptedRiskFiles}`]); await broadcast(); return result })
  ipcMain.handle('account:import-text', async (_event, value: string): Promise<ImportResult> => {
    const errors: string[] = []; let raw: unknown
    try { raw = JSON.parse(value) } catch { raw = value.split(/\r?\n/).filter(Boolean) }
    const items = importItems(raw); let imported = 0
    for (const [index, item] of items.entries()) { const input = inputFromImport(item); if (!input) { errors.push(`第 ${index + 1} 条无法识别`); continue } try { await store.upsert(input, 'clipboard'); imported += 1 } catch (error) { errors.push(`第 ${index + 1} 条：${String(error)}`) } }
    await broadcast(); return { imported, errors }
  })
  ipcMain.handle('account:export', (_event, ids?: string[]) => JSON.stringify({ format: 'codex_usage_accounts', version: 2, exportedAt: new Date().toISOString(), accounts: store.accounts.filter((item) => !ids?.length || ids.includes(item.id)).map((item) => ({ ...item, lastQuery: results.get(item.id) })) }, null, 2))
  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>) => { store.settings = { ...store.settings, ...patch }; await store.save(); scheduleAutoRefresh(); await broadcast(); return store.settings })
  ipcMain.handle('reset-credits:get', (_event, id: string) => queryResetCredits(store.get(id)))
  ipcMain.handle('hook:install', async () => installStopHook(logPath))
  ipcMain.handle('codex:open', openCodex)
  ipcMain.handle('log:open', async () => { await appendFile(logPath, ''); await openPath(logPath) })
  ipcMain.handle('log:open-directory', () => openPath(dirname(logPath)))
  ipcMain.handle('panel:show', () => { mainWindow?.show(); mainWindow?.focus() })
  ipcMain.handle('panel:hide', () => mainWindow?.hide())
  ipcMain.handle('app:quit', () => { quitting = true; app.quit() })
  ipcMain.handle('widget:start-drag', () => undefined)
}

terminateOtherInstances()
const ownsSingleInstanceLock = app.requestSingleInstanceLock()

if (!ownsSingleInstanceLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.codex.usage-panel')
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    store = new AccountStore(); await store.load(); logPath = join(dirname(store.path), 'query_errors.log')
    await appendFile(logPath, '').catch(() => undefined)
    registerIpc(); createWindows(); createTray(); scheduleAutoRefresh(); scheduleHookPoll(); await broadcast()
    void refreshAccounts()
  })

  app.on('activate', () => { mainWindow?.show() })
  app.on('before-quit', () => { quitting = true })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && quitting) app.quit() })
}
