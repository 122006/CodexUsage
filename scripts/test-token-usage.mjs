import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

process.env.TZ = 'Asia/Shanghai'

async function moduleFrom(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
const { DailyTokenUsageIndex } = await moduleFrom('src/main/token-usage.ts')
const { tokenCount } = await moduleFrom('src/renderer/src/token-format.ts')
const root = await mkdtemp(join(tmpdir(), 'codex-token-test-'))
const sessions = join(root, 'sessions'), archives = join(root, 'archives'), cachePath = join(root, 'cache.json')
const p = '00000000-0000-0000-0000-000000000001'
const c = '00000000-0000-0000-0000-000000000002'
const n = '00000000-0000-0000-0000-000000000003'
const unrelated = '00000000-0000-0000-0000-000000000004'
const paginated = '00000000-0000-0000-0000-000000000005'
const unknown = '00000000-0000-0000-0000-000000000006'
const deleted = '00000000-0000-0000-0000-000000000007'
const numbers = (total) => ({ total_tokens: total, input_tokens: total - 10, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 3 })
const usage = (last, cumulative, timestamp = '2026-09-08T04:00:00Z') => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: numbers(last), total_token_usage: numbers(cumulative) } } })
const meta = (id, parent, paged = false) => ({ type: 'session_meta', payload: { id, ...(paged ? { history_base: { thread_id: parent } } : { forked_from_id: parent }) } })
const file = (id) => join(sessions, `rollout-${id}.jsonl`)
const lines = (...records) => records.map((row) => JSON.stringify(row)).join('\n') + '\n'
try {
  await mkdir(sessions); await mkdir(archives)
  const original = [usage(100, 100, '2026-09-07T04:00:00Z'), usage(200, 300, '2026-09-07T04:01:00Z')]
  const copied = [usage(100, 100), usage(200, 300)]
  await writeFile(file(p), lines(meta(p), ...original))
  await writeFile(file(c), lines(meta(c, p), ...copied, usage(40, 340), usage(40, 340)))
  // Nested forks and timestamp-rewritten copies must not inflate totals.
  await writeFile(file(n), lines(meta(n, c), ...copied, usage(40, 340), usage(60, 400)))
  await writeFile(file(unrelated), lines(meta(unrelated), ...copied))
  await writeFile(file(paginated), lines(meta(paginated, p, true), usage(90, 390)))
  const oldDay = { date: '2026-09-08', totalTokens: 77, inputTokens: 67, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, calls: 1 }
  const oldStat = await stat(file(c))
  const legacy = { version: 1, sessions: {
    [c]: { path: file(c), inode: String(oldStat.ino), size: oldStat.size, modifiedAt: oldStat.mtimeMs, offset: oldStat.size, days: { '2026-09-08': { ...oldDay, totalTokens: 340 } } },
    [deleted]: { path: file(deleted), inode: '0', size: 1, modifiedAt: 0, offset: 1, days: { '2026-09-08': oldDay } }
  } }
  await writeFile(cachePath, JSON.stringify(legacy))
  const index = new DailyTokenUsageIndex(cachePath, [sessions, archives])
  const day = (value) => value.days.find((row) => row.date === '2026-09-08')
  const first = await index.query()
  assert.equal(day(first).totalTokens, 567)
  assert.equal(day(first).calls, 6)
  assert.equal(first.totalTokens, 867)
  assert.deepEqual(JSON.parse(await readFile(cachePath + '.before-fork-fix.bak', 'utf8')), legacy)
  const indexed = JSON.parse(await readFile(cachePath, 'utf8'))
  assert.equal(indexed.version, 2)
  assert.equal(indexed.sessions[c].inheritedCalls, 2)
  assert.equal(indexed.sessions[n].inheritedCalls, 3)
  assert.ok(first.errors.some((item) => item.includes(file(deleted))))
  const repeated = await index.query()
  assert.equal(repeated.changedFiles, 0)
  assert.deepEqual(day(repeated), day(first))
  const incomplete = JSON.stringify(usage(70, 410))
  await appendFile(file(c), incomplete.slice(0, 35))
  assert.equal(day(await index.query()).totalTokens, 567)
  await appendFile(file(c), incomplete.slice(35) + '\n')
  assert.equal(day(await index.query()).totalTokens, 637)
  const archived = join(archives, `rollout-${p}.jsonl`)
  await rename(file(p), archived)
  assert.equal(day(await index.query()).totalTokens, 637)
  await rm(archived)
  await rm(file(c))
  const afterDeletion = await new DailyTokenUsageIndex(cachePath, [sessions, archives]).query()
  assert.equal(day(afterDeletion).totalTokens, 637)
  assert.equal(afterDeletion.totalTokens, 937)
  // A missing ancestor is surfaced, not silently guessed or subtracted.
  await writeFile(file(unknown), lines(meta(unknown, deleted), usage(80, 80)))
  const unresolved = await index.query()
  assert.equal(day(unresolved).totalTokens, 717)
  assert.ok(unresolved.errors.some((item) => item.includes(deleted) && item.includes('父会话')))
  // Metadata rewrite + append cannot reuse a shifted byte offset.
  const path = file(paginated)
  const replacement = path + '.tmp'
  await writeFile(replacement, lines({ ...meta(paginated, p, true), extra: 'changed provider metadata' }, usage(90, 390), usage(30, 420)))
  await rename(replacement, path)
  assert.equal(day(await index.query()).totalTokens, 747)
  for (const [value, expected] of [[0, '0'], [999999, '999999'], [1000000, '1M'], [1234567, '1M'], [1500000, '2M'], [55650826, '56M'], [100000000, '100M'], [123456789, '123M'], [999999999, '1000M'], [1000000000, '10.00E'], [1234567890, '12.35E'], [123.456, '123.46']]) assert.equal(tokenCount(value), expected)
  console.log('PASS: fork/ancestor dedup, independent and paginated sessions, v1 migration, deletion retention, incremental partial lines, rewritten metadata and M/E formatting')
} finally {
  await rm(root, { recursive: true, force: true })
}
