import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_API_MODEL, DEFAULT_API_WIRE_API, DEFAULT_MODEL_REASONING_EFFORT, normalizeModelReasoningEffort } from '../shared/types'
import type { Account, AccountInput, AccountMode, SwitchResult } from '../shared/types'
import { buildApiConfig, customEndpoint, customWireApi, rootModel, rootModelReasoningEffort, rootProvider, rootSqliteHome, stripManagedConfig, validApiConfig, validCodexConfig } from './codex-config'
import { identityFromTokens } from './store'

const execFileAsync = promisify(execFile)
const API_CONFIG_BACKUP = 'codex_usage_panel_config_backup.json'
const PROVIDER_BACKUP_ROOT = join(homedir(), '.codex', 'backups_state', 'provider-sync')

export const codexHome = join(homedir(), '.codex')

export interface ProviderBackupCleanupResult {
  kept?: string
  removedCount: number
  failures: string[]
}

export async function cleanupProviderBackups(preferredBackup?: string): Promise<ProviderBackupCleanupResult> {
  const root = resolve(PROVIDER_BACKUP_ROOT)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removedCount: 0, failures: [] }
    return { removedCount: 0, failures: [`${root}: ${String(error)}`] }
  }
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = resolve(root, entry.name)
    if (!path.startsWith(`${root}${sep}`)) return undefined
    const modifiedAt = await stat(path).then((value) => value.mtimeMs).catch(() => 0)
    const complete = await stat(join(path, 'manifest.json')).then((value) => value.isFile()).catch(() => false)
    return { path, modifiedAt, complete }
  }))
  const validDirectories = directories.filter((item): item is NonNullable<typeof item> => Boolean(item))
  validDirectories.sort((left, right) => Number(right.complete) - Number(left.complete) || right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path))

  const preferred = preferredBackup ? resolve(preferredBackup) : undefined
  const kept = preferred && validDirectories.some((item) => item.path === preferred) ? preferred : validDirectories[0]?.path
  const failures: string[] = []
  let removedCount = 0
  for (const item of validDirectories) {
    if (item.path === kept) continue
    try {
      await rm(item.path, { recursive: true, force: true })
      removedCount += 1
    } catch (error) {
      failures.push(`${item.path}: ${String(error)}`)
    }
  }
  return { kept, removedCount, failures }
}

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

function tokenIssuedAt(token?: string): string | undefined {
  if (!token) return undefined
  try {
    const part = token.split('.')[1]
    if (!part) return undefined
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
    const issuedAt = Number(payload.iat)
    return Number.isFinite(issuedAt) && issuedAt > 0 ? new Date(issuedAt * 1000).toISOString() : undefined
  } catch { return undefined }
}

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
      apiWireApi: customWireApi(config) ?? DEFAULT_API_WIRE_API,
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
    const model = account.apiModel ?? DEFAULT_API_MODEL
    const wireApi = account.apiWireApi ?? DEFAULT_API_WIRE_API
    const effort = account.modelReasoningEffort ?? DEFAULT_MODEL_REASONING_EFFORT
    const endpoint = account.apiEndpoint?.replace(/\/+$/, '') ?? ''
    if (!endpoint) throw new Error('API 账号缺少端点，已取消配置修改')
    const modelCatalogUrl = account.source === 'codexusage-cpa' ? `${endpoint}/models` : undefined
    const managed = buildApiConfig(current, endpoint, model, effort, wireApi, modelCatalogUrl)
    await atomicWrite(configPath, managed)
    const written = await readFile(configPath, 'utf8')
    if (!validApiConfig(written, endpoint, model, effort, wireApi, modelCatalogUrl)) throw new Error('API 配置写入后校验失败，config.toml 未形成完整的 custom provider、模型、推理强度、接口协议和模型目录配置')
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
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
  const processes = stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }] : []
  })
  const pids = new Set(processes.filter((item) => item.command.includes(prefix)).map((item) => item.pid))
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (pids.has(item.parentPid) && !pids.has(item.pid)) {
        pids.add(item.pid)
        changed = true
      }
    }
  }
  pids.delete(process.pid)
  return [...pids]
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
    const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $ids=[System.Collections.Generic.HashSet[int]]::new(); foreach($p in $all){if(($p.ExecutablePath -and ($p.ExecutablePath -match 'OpenAI\\.Codex_' -or $p.ExecutablePath -match '[\\/]AppData[\\/]Local[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]')) -or ($p.CommandLine -and $p.CommandLine -match '[\\/]Codex[\\/]web[\\/]Codex')){[void]$ids.Add([int]$p.ProcessId)}}; do{$added=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added); $ids.Remove(${process.pid})|Out-Null; $targetIds=@($ids|%{$_}); if($targetIds.Count){Stop-Process -Id $targetIds -Force -ErrorAction SilentlyContinue; $deadline=(Get-Date).AddSeconds(10); do{$alive=@($targetIds|?{Get-Process -Id $_ -ErrorAction SilentlyContinue}); if(-not $alive){break}; Start-Sleep -Milliseconds 150}while((Get-Date)-lt $deadline); if($alive){throw ('Codex 进程未能完全退出: '+($alive -join ','))}}`
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20_000 })
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

function configuredHomePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

function stateDatabasePaths(config: string): string[] {
  const paths = [join(codexHome, 'state_5.sqlite')]
  const sqliteHome = rootSqliteHome(config) ?? stringValue(process.env.CODEX_SQLITE_HOME)
  if (sqliteHome) {
    const configured = join(configuredHomePath(sqliteHome), 'state_5.sqlite')
    if (!paths.some((path) => resolve(path).toLowerCase() === resolve(configured).toLowerCase())) paths.push(configured)
  }
  return paths
}

function plainWindowsPath(value: string): string | undefined {
  if (value.startsWith('\\\\?\\UNC\\')) return '\\\\' + value.slice(8)
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return undefined
}

async function normalizeWindowsRolloutPaths(config: string): Promise<number> {
  if (process.platform !== 'win32') return 0
  const { DatabaseSync } = await import('node:sqlite')
  const codexRoot = resolve(codexHome).toLowerCase() + sep
  let changed = 0
  for (const databasePath of stateDatabasePaths(config)) {
    if (!existsSync(databasePath)) continue
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      const columns = (database.prepare('PRAGMA table_info(threads)').all() as Array<Record<string, unknown>>).map((item) => String(item.name))
      if (!columns.includes('id') || !columns.includes('rollout_path')) {
        database.exec('COMMIT')
        continue
      }
      const update = database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      const rows = database.prepare('SELECT id, rollout_path FROM threads').all() as Array<Record<string, unknown>>
      for (const row of rows) {
        const id = stringValue(row.id); const current = stringValue(row.rollout_path)
        const normalized = current ? plainWindowsPath(current) : undefined
        if (!id || !current || !normalized || !resolve(normalized).toLowerCase().startsWith(codexRoot) || !existsSync(normalized)) continue
        changed += Number(update.run(normalized, id, current).changes)
      }
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* no open transaction */ }
      throw new Error('Codex 状态库归档路径修复失败（' + databasePath + '）：' + String(error))
    } finally { database.close() }
  }
  return changed
}

export async function repairWindowsRolloutPaths(): Promise<number> {
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '')
  return normalizeWindowsRolloutPaths(config)
}

interface ProviderSyncStats {
  changedSessions: number
  skippedSessions: number
  sqliteProviderRows: number
  failures: string[]
}

const ROLLOUT_FIRST_LINE_LIMIT = 16 * 1024 * 1024

function isBusyFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

async function readRolloutFirstLine(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  const chunks: Buffer[] = []
  let offset = 0
  try {
    while (offset < ROLLOUT_FIRST_LINE_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, ROLLOUT_FIRST_LINE_LIMIT - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) return Buffer.concat(chunks)
      const content = buffer.subarray(0, bytesRead)
      const newline = content.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(content.subarray(0, newline + 1))
        return Buffer.concat(chunks)
      }
      chunks.push(content)
      offset += bytesRead
    }
    throw new Error(`rollout 首行超过 ${ROLLOUT_FIRST_LINE_LIMIT / 1024 / 1024} MB`)
  } finally {
    await handle.close()
  }
}

async function writeBufferAt(path: string, content: Buffer, position: number): Promise<void> {
  const handle = await open(path, 'r+')
  let offset = 0
  try {
    while (offset < content.length) {
      const { bytesWritten } = await handle.write(content, offset, content.length - offset, position + offset)
      if (!bytesWritten) throw new Error('rollout 元数据写入未取得进展')
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceRolloutFirstLine(path: string, originalLength: number, nextLine: Buffer): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.provider-sync.tmp`
  const source = await open(path, 'r')
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    const sourceStat = await source.stat()
    output = await open(tempPath, 'wx', sourceStat.mode)
    let written = 0
    while (written < nextLine.length) {
      const result = await output.write(nextLine, written, nextLine.length - written)
      if (!result.bytesWritten) throw new Error('rollout 临时文件写入未取得进展')
      written += result.bytesWritten
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let readPosition = originalLength
    let writePosition = nextLine.length
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, readPosition)
      if (!bytesRead) break
      let chunkOffset = 0
      while (chunkOffset < bytesRead) {
        const result = await output.write(buffer, chunkOffset, bytesRead - chunkOffset, writePosition + chunkOffset)
        if (!result.bytesWritten) throw new Error('rollout 临时文件复制未取得进展')
        chunkOffset += result.bytesWritten
      }
      readPosition += bytesRead
      writePosition += bytesRead
    }
    await output.sync()
  } catch (error) {
    await source.close().catch(() => undefined)
    await output?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
  await source.close()
  await output.close()
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function rewriteRolloutProvider(path: string, targetProvider: string): Promise<'changed' | 'unchanged' | 'skipped'> {
  const firstLine = await readRolloutFirstLine(path)
  if (!firstLine.length) return 'unchanged'
  const raw = firstLine.toString('utf8')
  const newline = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : ''
  const body = raw.slice(0, raw.length - newline.length)
  const bom = body.startsWith('\uFEFF') ? '\uFEFF' : ''
  const parsed = JSON.parse(bom ? body.slice(1) : body) as Record<string, unknown>
  if (parsed.type !== 'session_meta' || !parsed.payload || typeof parsed.payload !== 'object') return 'unchanged'
  const payload = parsed.payload as Record<string, unknown>
  const currentProvider = typeof payload.model_provider === 'string' ? payload.model_provider : undefined
  if (currentProvider === targetProvider) return 'unchanged'

  const providerMatch = body.match(/("model_provider"\s*:\s*")([^"]*)(")/)
  if (providerMatch?.index !== undefined && providerMatch[2] === currentProvider && Buffer.byteLength(providerMatch[2]) === Buffer.byteLength(targetProvider)) {
    const valueOffset = Buffer.byteLength(body.slice(0, providerMatch.index + providerMatch[1].length))
    await writeBufferAt(path, Buffer.from(targetProvider), valueOffset)
    return 'changed'
  }

  payload.model_provider = targetProvider
  const nextLine = Buffer.from(`${bom}${JSON.stringify(parsed)}${newline}`)
  await replaceRolloutFirstLine(path, firstLine.length, nextLine)
  return 'changed'
}

async function collectRolloutFiles(root: string, files: string[], failures: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(`${root}: ${String(error)}`)
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectRolloutFiles(path, files, failures)
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path)
  }
}

async function syncRolloutProviders(targetProvider: string): Promise<Pick<ProviderSyncStats, 'changedSessions' | 'skippedSessions' | 'failures'>> {
  const files: string[] = []
  const failures: string[] = []
  await collectRolloutFiles(join(codexHome, 'sessions'), files, failures)
  await collectRolloutFiles(join(codexHome, 'archived_sessions'), files, failures)
  let changedSessions = 0
  let skippedSessions = 0
  for (const path of files) {
    try {
      const result = await rewriteRolloutProvider(path, targetProvider)
      if (result === 'changed') changedSessions += 1
      else if (result === 'skipped') skippedSessions += 1
    } catch (error) {
      if (isBusyFileError(error)) skippedSessions += 1
      else failures.push(`${path}: ${String(error)}`)
    }
  }
  return { changedSessions, skippedSessions, failures }
}

async function syncSqliteProviders(config: string, targetProvider: string): Promise<Pick<ProviderSyncStats, 'sqliteProviderRows' | 'failures'>> {
  const failures: string[] = []
  let sqliteProviderRows = 0
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  } catch (error) {
    return { sqliteProviderRows, failures: [`无法加载 SQLite 支持：${String(error)}`] }
  }
  for (const databasePath of stateDatabasePaths(config)) {
    if (!existsSync(databasePath)) continue
    let database: InstanceType<typeof DatabaseSync> | undefined
    try {
      database = new DatabaseSync(databasePath)
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      const columns = (database.prepare('PRAGMA table_info(threads)').all() as Array<Record<string, unknown>>).map((item) => String(item.name))
      if (columns.includes('model_provider')) {
        sqliteProviderRows += Number(database.prepare("UPDATE threads SET model_provider = ? WHERE COALESCE(model_provider, '') <> ?").run(targetProvider, targetProvider).changes)
      }
      database.exec('COMMIT')
    } catch (error) {
      try { database?.exec('ROLLBACK') } catch { /* no open transaction */ }
      failures.push(`${databasePath}: ${String(error)}`)
    } finally {
      database?.close()
    }
  }
  return { sqliteProviderRows, failures }
}

async function syncProviderState(targetProvider: string, config: string): Promise<ProviderSyncStats> {
  const rollout = await syncRolloutProviders(targetProvider)
  const sqlite = await syncSqliteProviders(config, targetProvider)
  return {
    changedSessions: rollout.changedSessions,
    skippedSessions: rollout.skippedSessions,
    sqliteProviderRows: sqlite.sqliteProviderRows,
    failures: [...rollout.failures, ...sqlite.failures]
  }
}

async function snapshotProviderState(target: string, authBackup: string, configBackup: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const backupDirectory = join(PROVIDER_BACKUP_ROOT, `${stamp}-${target.replace(/[^a-z0-9_-]/gi, '_')}`)
  await mkdir(backupDirectory, { recursive: true })
  await writeFile(join(backupDirectory, 'auth.json'), authBackup, 'utf8')
  await writeFile(join(backupDirectory, 'config.toml'), configBackup, 'utf8')
  await writeFile(join(backupDirectory, 'manifest.json'), `${JSON.stringify({ target, historyPolicy: 'provider-metadata-only-no-history-backup', createdAt: new Date().toISOString() }, null, 2)}\n`)
  const cleanup = await cleanupProviderBackups(backupDirectory)
  if (cleanup.failures.length) console.error('部分旧 Provider 快照清理失败', cleanup.failures)
  return backupDirectory
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
      auth = { ...previous, auth_mode: 'chatgpt', tokens, last_refresh: tokenIssuedAt(account.accessToken) ?? new Date().toISOString() }
      delete auth.OPENAI_API_KEY
    }
    await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`)
    const writtenAuth = await readJson(authPath)
    const authValid = account.accountMode === 'api'
      ? String(writtenAuth?.auth_mode ?? '').toLowerCase() === 'apikey' && writtenAuth?.OPENAI_API_KEY === account.apiKey
      : String(writtenAuth?.auth_mode ?? '').toLowerCase() !== 'apikey' && !writtenAuth?.OPENAI_API_KEY && Boolean(writtenAuth?.tokens)
    if (!authValid) throw new Error('auth.json 写入后校验失败')
    const backupDirectory = await snapshotProviderState(targetProvider, authBackup, configBackup)
    const writtenConfig = await readFile(configPath, 'utf8').catch(() => '')
    const providerSync = await syncProviderState(targetProvider, writtenConfig)
    if (providerSync.failures.length) console.error('部分 Codex Provider 元数据同步失败', providerSync.failures)
    if (account.accountMode === 'codex') await unlink(configStateBackupPath).catch(() => undefined)
    startCodex(launch)
    return {
      message: '账号已切换并重新启动 Codex',
      targetProvider,
      changedSessions: providerSync.changedSessions,
      encryptedRiskFiles: 0,
      sqliteProviderRows: providerSync.sqliteProviderRows,
      skippedSessions: providerSync.skippedSessions,
      providerSyncFailures: providerSync.failures.length,
      providerSyncErrors: providerSync.failures.slice(0, 10),
      backupDirectory
    }
  } catch (error) {
    await atomicWrite(authPath, authBackup); await atomicWrite(configPath, configBackup); startCodex(launch); throw error
  }
}

export async function updateCurrentCodexAuth(account: Account): Promise<void> {
  if (account.accountMode !== 'codex' || !account.accessToken) throw new Error('只能更新 Codex OAuth 账号的当前认证')
  const authPath = join(codexHome, 'auth.json')
  const previous = await readJson(authPath) ?? {}
  if (String(previous.auth_mode ?? '').toLowerCase() === 'apikey') throw new Error('当前 Codex 正在使用 API Key 模式')
  const tokens: Record<string, unknown> = { ...(account.authTokens ?? {}), access_token: account.accessToken }
  if (account.accountId) tokens.account_id = account.accountId
  const auth: Record<string, unknown> = { ...previous, auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() }
  delete auth.OPENAI_API_KEY
  await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`)
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
