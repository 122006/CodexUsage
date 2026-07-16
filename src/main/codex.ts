import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_API_MODEL, DEFAULT_MODEL_REASONING_EFFORT, normalizeModelReasoningEffort } from '../shared/types'
import type { Account, AccountInput, AccountMode, SwitchResult } from '../shared/types'
import { customEndpoint, rootModel, rootModelReasoningEffort, rootProvider, stripManagedConfig, validApiConfig, validCodexConfig } from './codex-config'
import { identityFromTokens } from './store'

const execFileAsync = promisify(execFile)
const API_CONFIG_BACKUP = 'codex_usage_panel_config_backup.json'

export const codexHome = join(homedir(), '.codex')

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> } catch { return undefined }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }

export async function currentAuth(): Promise<{ accountId?: string; email?: string; mode?: AccountMode; apiKey?: string; apiEndpoint?: string }> {
  const auth = await readJson(join(codexHome, 'auth.json'))
  if (!auth) return {}
  const mode = stringValue(auth.auth_mode)
  if (mode?.toLowerCase() === 'apikey') {
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '')
    return { mode: 'api', apiKey: stringValue(auth.OPENAI_API_KEY), apiEndpoint: customEndpoint(config) }
  }
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens as Record<string, unknown> : undefined
  return { ...identityFromTokens(tokens), mode: 'codex' }
}

export async function importCurrentInput(): Promise<AccountInput> {
  const authPath = join(codexHome, 'auth.json')
  const auth = await readJson(authPath)
  if (!auth) throw new Error(`无法读取当前 Codex 授权文件：${authPath}`)
  if (String(auth.auth_mode ?? '').toLowerCase() === 'apikey') {
    const apiKey = stringValue(auth.OPENAI_API_KEY)
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '')
    const apiEndpoint = customEndpoint(config)
    if (!apiKey || !apiEndpoint) throw new Error('当前 API 授权缺少密钥或 custom 端点')
    return {
      accountMode: 'api', label: '当前 API 账号', apiKey, apiEndpoint,
      apiModel: rootModel(config) ?? DEFAULT_API_MODEL,
      modelReasoningEffort: normalizeModelReasoningEffort(rootModelReasoningEffort(config))
    }
  }
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens as Record<string, unknown> : undefined
  const accessToken = stringValue(tokens?.access_token)
  if (!accessToken || !tokens) throw new Error('当前 Codex 授权中没有 access_token')
  const identity = identityFromTokens(tokens)
  return { accountMode: 'codex', label: identity.email ?? identity.accountId ?? '当前 Codex', accessToken, ...identity, authTokens: { ...tokens } }
}

async function applyConfig(account: Account, previousApi: boolean): Promise<string> {
  const configPath = join(codexHome, 'config.toml')
  const backupPath = join(codexHome, API_CONFIG_BACKUP)
  const current = await readFile(configPath, 'utf8').catch(() => '')
  if (account.accountMode === 'api') {
    if (!previousApi && !existsSync(backupPath)) await atomicWrite(backupPath, `${JSON.stringify({ config: current }, null, 2)}\n`)
    const base = stripManagedConfig(current, 'all')
    const model = account.apiModel ?? DEFAULT_API_MODEL
    const effort = account.modelReasoningEffort ?? DEFAULT_MODEL_REASONING_EFFORT
    const managed = `model_provider = "custom"\nmodel = ${JSON.stringify(model)}\nmodel_reasoning_effort = ${JSON.stringify(effort)}\n\n[model_providers.custom]\nname = "custom"\nbase_url = ${JSON.stringify(account.apiEndpoint)}\nwire_api = "responses"\nrequires_openai_auth = true\n`
    await atomicWrite(configPath, `${managed}\n${base}`)
    const written = await readFile(configPath, 'utf8')
    if (!validApiConfig(written, account.apiEndpoint ?? '', model, effort)) throw new Error('API 配置写入后校验失败，config.toml 未形成完整的 custom provider、模型和推理强度配置')
    return 'custom'
  }
  const backup = await readJson(backupPath)
  const restoreSource = previousApi && backup && typeof backup.config === 'string' ? backup.config : current
  const restored = stripManagedConfig(restoreSource, 'managed')
  await atomicWrite(configPath, restored)
  const written = await readFile(configPath, 'utf8')
  if (!validCodexConfig(written)) throw new Error('授权模式配置清理后校验失败，config.toml 中仍存在 API custom provider 残留')
  return rootProvider(written) ?? 'openai'
}

interface LaunchInfo { kind: 'appId' | 'executable' | 'macApp' | 'command'; value: string }

async function resolveWindowsCodex(): Promise<LaunchInfo> {
  const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process); $main=$p|?{$_.ExecutablePath -and $_.CommandLine -notmatch '--type=' -and ($_.Name -ieq 'Codex.exe' -or ($_.Name -ieq 'ChatGPT.exe' -and $_.ExecutablePath -match 'OpenAI.Codex_'))}|select -First 1; $id=(Get-StartApps|?{$_.AppID -match '^OpenAI.Codex_' -or $_.Name -eq 'Codex'}|select -First 1).AppID; if($id){@{kind='appId';value=$id}|ConvertTo-Json -Compress}elseif($main){@{kind='executable';value=$main.ExecutablePath}|ConvertTo-Json -Compress}else{throw '找不到 Codex 启动入口'}`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15_000 })
  return JSON.parse(stdout.trim()) as LaunchInfo
}

async function resolveMacCodex(): Promise<LaunchInfo> {
  const registeredPath = async (name: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', `POSIX path of (path to application "${name}")`], { timeout: 10_000 })
      const path = stdout.trim().replace(/\/+$/, '')
      return path || undefined
    } catch { return undefined }
  }
  for (const name of ['Codex', 'Codex Desktop']) {
    const path = await registeredPath(name)
    if (path) return { kind: 'macApp', value: path }
  }
  const query = 'kMDItemContentType == "com.apple.application-bundle" && (kMDItemFSName == "Codex.app" || kMDItemFSName == "ChatGPT.app")'
  const { stdout } = await execFileAsync('mdfind', [query], { timeout: 10_000 }).catch(() => ({ stdout: '' }))
  const paths = stdout.split(/\r?\n/).map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean)
  const codexPath = paths.find((path) => path.endsWith('/Codex.app'))
  if (codexPath) return { kind: 'macApp', value: codexPath }
  const chatGptPath = await registeredPath('ChatGPT') ?? paths.find((path) => path.endsWith('/ChatGPT.app'))
  if (chatGptPath) return { kind: 'macApp', value: chatGptPath }
  throw new Error('找不到 Codex 应用，请确认 Codex.app 已安装')
}

async function macCodexPids(appPath: string): Promise<number[]> {
  const prefix = `${appPath.replace(/\/+$/, '')}/Contents/`
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    return match && match[2].includes(prefix) ? [Number(match[1])] : []
  }).filter((pid) => pid !== process.pid)
}

async function waitForMacCodexExit(appPath: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let pids = await macCodexPids(appPath)
  while (pids.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    pids = await macCodexPids(appPath)
  }
  return pids
}

async function stopCodex(): Promise<LaunchInfo> {
  if (process.platform === 'win32') {
    const launch = await resolveWindowsCodex()
    const script = `$p=@(Get-CimInstance Win32_Process); $p|?{$_.Name -ieq 'Codex.exe' -or (($_.Name -ieq 'ChatGPT.exe' -or $_.Name -ieq 'codex-code-mode-host.exe') -and ($_.ExecutablePath -match 'OpenAI.Codex_' -or $_.CommandLine -match '[\\/]Codex[\\/]web[\\/]Codex'))}|%{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15_000 })
    return launch
  }
  if (process.platform === 'darwin') {
    const launch = await resolveMacCodex()
    const plist = join(launch.value, 'Contents', 'Info.plist')
    const bundleId = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { timeout: 5000 }).then(({ stdout }) => stdout.trim()).catch(() => '')
    if (bundleId) await execFileAsync('osascript', ['-e', `tell application id "${bundleId}" to quit`], { timeout: 5000 }).catch(() => undefined)
    let pids = await waitForMacCodexExit(launch.value, 3000)
    for (const pid of pids) try { process.kill(pid, 'SIGTERM') } catch { /* process already exited */ }
    pids = await waitForMacCodexExit(launch.value, 1500)
    for (const pid of pids) try { process.kill(pid, 'SIGKILL') } catch { /* process already exited */ }
    if ((await macCodexPids(launch.value)).length) throw new Error('Codex 进程未能完全退出，已取消账号切换')
    return launch
  }
  await execFileAsync('pkill', ['-x', 'codex']).catch(() => undefined)
  return { kind: 'command', value: 'codex' }
}

function startCodex(info: LaunchInfo): void {
  if (info.kind === 'appId') spawn('explorer.exe', [`shell:AppsFolder\\${info.value}`], { detached: true, stdio: 'ignore' }).unref()
  else if (info.kind === 'macApp') spawn('open', [info.value], { detached: true, stdio: 'ignore' }).unref()
  else spawn(info.value, [], { detached: true, stdio: 'ignore' }).unref()
}

export async function openCodex(): Promise<void> {
  const launch = process.platform === 'win32' ? await resolveWindowsCodex() : process.platform === 'darwin' ? await resolveMacCodex() : { kind: 'command' as const, value: 'codex' }
  startCodex(launch)
}

async function sessionPaths(root: string): Promise<string[]> {
  const output: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path)
    }
  }
  await Promise.all([walk(join(root, 'sessions')), walk(join(root, 'archived_sessions'))])
  return output
}

async function syncProvider(target: string, authBackup: string, configBackup: string): Promise<Omit<SwitchResult, 'message'>> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const backupDirectory = join(codexHome, 'backups_state', 'provider-sync', `${stamp}-${target.replace(/[^a-z0-9_-]/gi, '_')}`)
  await mkdir(backupDirectory, { recursive: true })
  await writeFile(join(backupDirectory, 'auth.json'), authBackup, 'utf8')
  await writeFile(join(backupDirectory, 'config.toml'), configBackup, 'utf8')
  const stateDatabase = join(codexHome, 'state_5.sqlite')
  if (existsSync(stateDatabase)) {
    await copyFile(stateDatabase, join(backupDirectory, 'state_5.sqlite'))
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${stateDatabase}${suffix}`)) await copyFile(`${stateDatabase}${suffix}`, join(backupDirectory, `state_5.sqlite${suffix}`))
  }
  let changedSessions = 0; let encryptedRiskFiles = 0
  const threadCwds = new Map<string, string>()
  for (const path of await sessionPaths(codexHome)) {
    const content = await readFile(path, 'utf8').catch(() => '')
    if (!content) continue
    if (content.includes('"encrypted_content"')) encryptedRiskFiles += 1
    const newline = content.indexOf('\n')
    const first = newline >= 0 ? content.slice(0, newline) : content
    try {
      const record = JSON.parse(first) as Record<string, unknown>
      if (record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') continue
      const payload = record.payload as Record<string, unknown>
      if (typeof payload.id === 'string' && typeof payload.cwd === 'string') threadCwds.set(payload.id, payload.cwd)
      if (payload.model_provider === target) continue
      const relative = path.slice(codexHome.length + 1)
      const destination = join(backupDirectory, 'sessions', relative)
      await mkdir(dirname(destination), { recursive: true }); await copyFile(path, destination)
      payload.model_provider = target
      const replaced = `${JSON.stringify(record)}${newline >= 0 ? content.slice(newline) : '\n'}`
      await atomicWrite(path, replaced); changedSessions += 1
    } catch { /* malformed rollout remains untouched */ }
  }
  let sqliteProviderRows = 0
  if (existsSync(stateDatabase)) {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(stateDatabase)
    try {
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      const columns = (database.prepare('PRAGMA table_info(threads)').all() as Array<Record<string, unknown>>).map((item) => String(item.name))
      if (!columns.length) throw new Error(`SQLite 中缺少 threads 表：${stateDatabase}`)
      if (columns.includes('model_provider')) sqliteProviderRows = Number(database.prepare("UPDATE threads SET model_provider = ? WHERE COALESCE(model_provider, '') <> ?").run(target, target).changes)
      if (columns.includes('cwd')) {
        const update = database.prepare("UPDATE threads SET cwd = ? WHERE id = ? AND COALESCE(cwd, '') <> ?")
        for (const [id, cwd] of threadCwds) update.run(cwd, id, cwd)
      }
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* no open transaction */ }
      throw new Error(`state_5.sqlite 无法同步，请确认 Codex 已关闭：${String(error)}`)
    } finally { database.close() }
  }
  await writeFile(join(backupDirectory, 'manifest.json'), `${JSON.stringify({ target, changedSessions, encryptedRiskFiles, sqliteProviderRows, createdAt: new Date().toISOString() }, null, 2)}\n`)
  return { targetProvider: target, changedSessions, encryptedRiskFiles, sqliteProviderRows, backupDirectory }
}

export async function switchAccount(account: Account): Promise<SwitchResult> {
  const authPath = join(codexHome, 'auth.json'); const configPath = join(codexHome, 'config.toml')
  const configStateBackupPath = join(codexHome, API_CONFIG_BACKUP)
  const authBackup = await readFile(authPath, 'utf8').catch(() => '{}\n')
  const configBackup = await readFile(configPath, 'utf8').catch(() => '')
  const previous = JSON.parse(authBackup) as Record<string, unknown>
  const previousApi = String(previous.auth_mode ?? '').toLowerCase() === 'apikey'
  const launch = await stopCodex()
  try {
    const targetProvider = await applyConfig(account, previousApi)
    let auth: Record<string, unknown>
    if (account.accountMode === 'api') auth = { auth_mode: 'apikey', OPENAI_API_KEY: account.apiKey }
    else {
      const tokens: Record<string, unknown> = { ...(account.authTokens ?? {}), access_token: account.accessToken }
      if (account.accountId) tokens.account_id = account.accountId
      auth = { ...previous, auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() }
      delete auth.OPENAI_API_KEY
    }
    await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`)
    const writtenAuth = await readJson(authPath)
    const authValid = account.accountMode === 'api'
      ? String(writtenAuth?.auth_mode ?? '').toLowerCase() === 'apikey' && writtenAuth?.OPENAI_API_KEY === account.apiKey
      : String(writtenAuth?.auth_mode ?? '').toLowerCase() !== 'apikey' && !writtenAuth?.OPENAI_API_KEY && Boolean(writtenAuth?.tokens)
    if (!authValid) throw new Error('auth.json 写入后校验失败')
    const sync = await syncProvider(targetProvider, authBackup, configBackup)
    if (account.accountMode === 'codex') await unlink(configStateBackupPath).catch(() => undefined)
    startCodex(launch)
    return { message: '账号已切换并重新启动 Codex', ...sync }
  } catch (error) {
    await atomicWrite(authPath, authBackup); await atomicWrite(configPath, configBackup); startCodex(launch); throw error
  }
}

export async function installStopHook(logPath: string): Promise<string> {
  const hooksDir = join(codexHome, 'hooks'); const scriptPath = join(hooksDir, 'codex_usage_panel_stop_hook.js')
  const signalPath = join(codexHome, 'codex_usage_panel_stop_signal.json'); const hooksPath = join(codexHome, 'hooks.json')
  await mkdir(hooksDir, { recursive: true })
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(signalPath)},JSON.stringify({at:new Date().toISOString(),pid:process.pid})+'\\n');fs.appendFileSync(${JSON.stringify(logPath)},'['+new Date().toISOString()+'] Hook 已发出刷新信号\\n');`
  await atomicWrite(scriptPath, script)
  const config = await readJson(hooksPath) ?? {}
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks as Record<string, unknown> : {}
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop as unknown[] : []
  const marker = 'codex_usage_panel_stop_hook.js'
  const filtered = stop.filter((item) => !JSON.stringify(item).includes(marker))
  filtered.push({ hooks: [{ type: 'command', command: `"${process.execPath}" "${scriptPath}"`, timeout: 10, statusMessage: '通知额度面板刷新' }] })
  hooks.Stop = filtered; config.hooks = hooks
  await atomicWrite(hooksPath, `${JSON.stringify(config, null, 2)}\n`)
  return hooksPath
}

export async function openPath(path: string): Promise<void> { const error = await shell.openPath(path); if (error) throw new Error(error) }
export async function saveWidgetPosition(position: { x: number; y: number }): Promise<void> { void position }
export const hookSignalPath = join(codexHome, 'codex_usage_panel_stop_signal.json')
export function newAccountId(): string { return randomUUID() }
