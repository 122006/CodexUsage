import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DailyTokenUsage, DailyTokenUsageResult } from '../shared/types'

const CACHE_VERSION = 2
const LINE_HEAD_LIMIT = 1024
type TokenNumbers = [total: number, input: number, cached: number, cacheWrite: number, output: number, reasoning: number]
type TokenEvent = [timestamp: string, signature: string, ...usage: TokenNumbers]

interface SessionUsageIndex {
  path: string
  inode: string
  size: number
  modifiedAt: number
  offset: number
  lastCumulativeTotal?: number
  parentId?: string
  events?: TokenEvent[]
  days: Record<string, DailyTokenUsage>
  inheritedCalls?: number
}

interface TokenUsageCache {
  version: number
  sessions: Record<string, SessionUsageIndex>
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function tokenNumbers(value: unknown): TokenNumbers {
  const item = object(value)
  return [number(item.total_tokens), number(item.input_tokens), number(item.cached_input_tokens), number(item.cache_write_input_tokens), number(item.output_tokens), number(item.reasoning_output_tokens)]
}

function localDate(timestamp: string): string | undefined {
  const value = new Date(timestamp)
  if (!Number.isFinite(value.getTime())) return undefined
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function emptyDay(date: string): DailyTokenUsage {
  return { date, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, calls: 0 }
}

function sessionId(path: string): string {
  const name = basename(path)
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? name
}

async function collectRollouts(root: string, output: Map<string, string>, errors: string[]): Promise<void> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${root}: ${String(error)}`)
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectRollouts(path, output, errors)
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const id = sessionId(path)
      const existing = output.get(id)
      if (!existing) output.set(id, path)
      else {
        const [existingStat, nextStat] = await Promise.all([stat(existing).catch(() => undefined), stat(path).catch(() => undefined)])
        if ((nextStat?.size ?? 0) >= (existingStat?.size ?? 0)) output.set(id, path)
      }
    }
  }
}

async function readCache(path: string): Promise<TokenUsageCache> {
  let value: TokenUsageCache
  try { value = JSON.parse(await readFile(path, 'utf8')) as TokenUsageCache } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: CACHE_VERSION, sessions: {} }
    throw new Error(`无法读取 Token 统计缓存，已保留原文件：${String(error)}`)
  }
  if (![1, CACHE_VERSION].includes(value.version) || !value.sessions || typeof value.sessions !== 'object') throw new Error('Token 统计缓存格式无效，已保留原文件')
  if (value.version === 1) {
    try { await copyFile(path, `${path}.before-fork-fix.bak`, constants.COPYFILE_EXCL) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  // Keep legacy entries whose rollout was deleted; surviving files are reindexed below.
  return { ...value, version: CACHE_VERSION }
}

async function saveCache(path: string, cache: TokenUsageCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cache)}\n`, 'utf8')
  await rename(temporary, path)
}

async function scanTokenLines(path: string, start: number, end: number, onRecord: (record: Record<string, unknown>) => void): Promise<number> {
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 1024 * 1024 })
  let absolute = start
  let lineStart = start
  let head = Buffer.alloc(0)
  let candidate = false
  let candidateParts: Buffer[] = []

  const feed = (segment: Buffer): void => {
    if (candidate) { candidateParts.push(Buffer.from(segment)); return }
    if (head.length >= LINE_HEAD_LIMIT) return
    const inspectionLength = Math.min(segment.length, LINE_HEAD_LIMIT - head.length)
    const inspected = segment.subarray(0, inspectionLength)
    head = head.length ? Buffer.concat([head, inspected]) : Buffer.from(inspected)
    if (!/"type"\s*:\s*"(?:token_count|session_meta)"/.test(head.toString('utf8'))) return
    candidate = true
    candidateParts = [head]
    if (inspectionLength < segment.length) candidateParts.push(Buffer.from(segment.subarray(inspectionLength)))
  }

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const end = newline >= 0 ? newline + 1 : chunk.length
      const segment = chunk.subarray(cursor, end)
      feed(segment)
      absolute += segment.length
      cursor = end
      if (newline >= 0) {
        if (candidate) {
          let record: Record<string, unknown> | undefined
          try { record = JSON.parse(Buffer.concat(candidateParts).toString('utf8')) } catch { /* skip malformed records */ }
          if (record) onRecord(record)
        }
        head = Buffer.alloc(0); candidate = false; candidateParts = []
        lineStart = absolute
      }
    }
  }
  return lineStart
}

async function indexSession(path: string, previous?: SessionUsageIndex): Promise<SessionUsageIndex> {
  const fileStat = await stat(path)
  const inode = String(fileStat.ino)
  const reset = !previous?.events || previous.inode !== inode || fileStat.size < previous.size || (fileStat.size === previous.size && fileStat.mtimeMs !== previous.modifiedAt)
  const next: SessionUsageIndex = reset ? {
    path, inode, size: fileStat.size, modifiedAt: fileStat.mtimeMs, offset: 0, events: [], days: {}
  } : {
    ...previous!, path, size: fileStat.size, modifiedAt: fileStat.mtimeMs, events: [...previous!.events!]
  }
  if (next.offset >= fileStat.size) return next
  let cumulativeTotal = next.lastCumulativeTotal
  next.offset = await scanTokenLines(path, next.offset, fileStat.size, (record) => {
    const payload = object(record.payload)
    if (record.type === 'session_meta') {
      const parent = payload.forked_from_id ?? object(payload.history_base).thread_id
      if (typeof parent === 'string' && parent !== sessionId(path)) next.parentId = parent
      return
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) return
    const info = object(payload.info)
    const usage = tokenNumbers(info.last_token_usage)
    const cumulative = tokenNumbers(info.total_token_usage)
    let delta = usage[0]
    if (cumulative[0] > 0 && cumulativeTotal !== undefined) {
      if (cumulative[0] === cumulativeTotal) return
      delta = cumulative[0] > cumulativeTotal ? cumulative[0] - cumulativeTotal : usage[0]
    }
    if (cumulative[0] > 0) cumulativeTotal = cumulative[0]
    if (delta <= 0 || typeof record.timestamp !== 'string' || !localDate(record.timestamp)) return
    // Forks can rewrite timestamps. Both last and cumulative usage identify copied events.
    const signature = createHash('sha256').update(JSON.stringify([usage, cumulative])).digest('hex').slice(0, 32)
    next.events!.push([record.timestamp, signature, delta, ...usage.slice(1)] as TokenEvent)
  })
  next.lastCumulativeTotal = cumulativeTotal
  return next
}

function rebuildDays(cache: TokenUsageCache, errors: string[]): void {
  const fingerprints = new Map<string, Set<string>>()
  for (const [id, session] of Object.entries(cache.sessions)) if (session.events) fingerprints.set(id, new Set(session.events.map((event) => event[1])))
  for (const [id, session] of Object.entries(cache.sessions)) {
    if (!session.events) {
      errors.push(`${session.path}: 原会话文件不可用，已保留旧汇总，无法校验分叉历史`)
      continue
    }
    const ancestors: Set<string>[] = []
    const visited = new Set([id])
    let parentId = session.parentId
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = cache.sessions[parentId]
      const signatures = fingerprints.get(parentId)
      if (!parent || !signatures) { errors.push(`${session.path}: 父会话 ${parentId} 缺少用量记录，未扣除无法确认的继承历史`); break }
      ancestors.push(signatures)
      parentId = parent.parentId
    }
    session.days = {}
    session.inheritedCalls = 0
    let inheritedPrefix = ancestors.length > 0
    for (const event of session.events) {
      if (inheritedPrefix && ancestors.some((signatures) => signatures.has(event[1]))) { session.inheritedCalls += 1; continue }
      inheritedPrefix = false
      const date = localDate(event[0])!
      const day = session.days[date] ?? emptyDay(date)
      day.totalTokens += event[2]; day.inputTokens += event[3]; day.cachedInputTokens += event[4]
      day.cacheWriteInputTokens += event[5]; day.outputTokens += event[6]; day.reasoningOutputTokens += event[7]; day.calls += 1
      session.days[date] = day
    }
  }
}

function mergeDay(target: DailyTokenUsage, source: DailyTokenUsage): void {
  target.totalTokens += source.totalTokens; target.inputTokens += source.inputTokens; target.cachedInputTokens += source.cachedInputTokens
  target.cacheWriteInputTokens += source.cacheWriteInputTokens; target.outputTokens += source.outputTokens
  target.reasoningOutputTokens += source.reasoningOutputTokens; target.calls += source.calls
}

export class DailyTokenUsageIndex {
  private running?: Promise<DailyTokenUsageResult>

  constructor(private readonly cachePath: string, private readonly roots: string[]) {}

  query(): Promise<DailyTokenUsageResult> {
    if (!this.running) this.running = this.scan().finally(() => { this.running = undefined })
    return this.running
  }

  private async scan(): Promise<DailyTokenUsageResult> {
    const startedAt = Date.now()
    const cache = await readCache(this.cachePath)
    const files = new Map<string, string>()
    const errors: string[] = []
    for (const root of this.roots) await collectRollouts(root, files, errors)
    let changedFiles = 0
    for (const [id, path] of files) {
      const previous = cache.sessions[id]
      try {
        const nextStat = await stat(path)
        const unchanged = previous?.events && previous.path === path && previous.size === nextStat.size && previous.modifiedAt === nextStat.mtimeMs
        if (!unchanged) { cache.sessions[id] = await indexSession(path, previous); changedFiles += 1 }
      } catch (error) { errors.push(`${path}: ${String(error)}`) }
    }
    rebuildDays(cache, errors)
    await saveCache(this.cachePath, cache)
    const totals = new Map<string, DailyTokenUsage>()
    for (const session of Object.values(cache.sessions)) {
      for (const day of Object.values(session.days)) {
        const target = totals.get(day.date) ?? emptyDay(day.date)
        mergeDay(target, day); totals.set(day.date, target)
      }
    }
    const days = [...totals.values()].sort((left, right) => right.date.localeCompare(left.date))
    return {
      days, totalTokens: days.reduce((sum, day) => sum + day.totalTokens, 0), indexedFiles: Object.keys(cache.sessions).length,
      changedFiles, errors: errors.slice(0, 20), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      updatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt
    }
  }
}
