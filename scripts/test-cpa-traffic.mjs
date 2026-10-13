import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
const { CpaClient, managedProviderName, managedAuthFileName } = await load('src/main/cpa.ts')
const { parseCpaTraffic, CpaTrafficCache } = await load('src/main/cpa-traffic.ts')
const now = Date.parse('2026-09-08T12:05:00+08:00')
const raw = { success: '900', failed: 100, recent_requests: [
  { time: '2026-09-08T11:50:00+08:00', success: 3, failed: 1 },
  { time: '2026-09-08T12:00:00+08:00', success: 5, failed: 0 }
] }
const chart = parseCpaTraffic(raw, now)
assert.equal(chart.buckets.length, 20)
assert.equal(chart.success, 900)
assert.equal(chart.failed, 100)
assert.equal(chart.buckets.reduce((sum, bucket) => sum + bucket.success, 0), 8)
assert.equal(chart.buckets[19].startTime, Date.parse(raw.recent_requests[1].time))
assert.equal(chart.buckets[19].endTime - chart.buckets[19].startTime, 600_000)
assert.ok(chart.buckets.slice(0, 18).every((bucket) => !bucket.success && !bucket.failed))
assert.equal(parseCpaTraffic({ recent_requests: Array.from({ length: 24 }, (_, success) => ({ success, failed: 0 })) }, now).buckets[0].success, 4)
assert.equal(parseCpaTraffic({ success: 0, failed: 0, recent_requests: [] }, now).buckets.length, 20)
assert.ok(parseCpaTraffic({ success: 1, failed: 2 }, now).error)
assert.ok(parseCpaTraffic({ recent_requests: [{ success: -1, failed: 0 }] }, now).error)
assert.ok(parseCpaTraffic({ recent_requests: [null] }, now).error)

const oauth = { id: 'subscription', accountMode: 'codex', modeVisibility: 'both' }
const imported = { ...oauth, id: 'imported', cpaAuthFileName: 'imported.json' }
const api = { id: 'remote', accountMode: 'api', modeVisibility: 'both', apiEndpoint: 'https://example.invalid/v1/', apiKey: 'test-secret-one' }
const api2 = { ...api, id: 'remote-two', apiKey: 'test-secret-two' }
const idle = { ...api, id: 'idle', apiKey: 'test-idle' }
const native = { ...api, id: 'loopback', modeVisibility: 'native' }
const missing = { ...oauth, id: 'missing' }
const provider = (account) => ({ name: managedProviderName(account), 'base-url': 'https://example.invalid/v1', 'api-key-entries': [{ 'api-key': account.apiKey }] })
const usage = {
  [managedProviderName(api).toLowerCase()]: { [`https://example.invalid/v1|${api.apiKey}`]: raw },
  [managedProviderName(api2)]: { [`https://example.invalid/v1|${api2.apiKey}`]: { ...raw, success: 27 } },
  unrelated: { [`https://example.invalid/v1|${api.apiKey}`]: { ...raw, success: 1000000 } }
}
let upstreamError = false
let authMalformed = false
let wrongKey = false
let calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.method ?? 'GET', 'GET', 'Traffic reads must never change CPA state')
  assert.equal(init.headers.Authorization, 'Bearer test-management')
  const path = new URL(url).pathname
  calls.push(path)
  if (path.endsWith('/auth-files')) return Response.json(authMalformed ? {} : { files: [
    { name: managedAuthFileName(oauth), ...raw }, { name: imported.cpaAuthFileName, ...raw, success: 41 }
  ] })
  if (path.endsWith('/openai-compatibility')) return Response.json({ 'openai-compatibility': [provider(api), provider({ ...api2, apiKey: wrongKey ? 'changed' : api2.apiKey }), provider(idle)] })
  if (path.endsWith('/api-key-usage')) return upstreamError ? Response.json({ error: `upstream accidentally leaked ${api.apiKey}` }, { status: 404 }) : Response.json(usage)
  throw new Error(`Unexpected endpoint ${path}`)
}
try {
  const client = new CpaClient('http://127.0.0.1:18516', 'test-management')
  const accounts = [oauth, imported, api, api2, native, idle, missing]
  const value = await client.getTraffic(accounts)
  assert.equal(calls.length, 3, 'One batch, not one query per account')
  assert.equal(value.accounts[api.id].success, 900)
  assert.equal(value.accounts[api2.id].success, 27)
  assert.equal(value.accounts[imported.id].success, 41)
  assert.equal(value.accounts[idle.id].success, 0)
  assert.equal(value.accounts[native.id], undefined)
  assert.ok(value.accounts[missing.id].error)
  assert.ok(!JSON.stringify(value).includes(api.apiKey))
  wrongKey = true
  assert.match((await client.getTraffic(accounts)).accounts[api2.id].error, /密钥与本地不一致/)
  upstreamError = true
  const partial = await client.getTraffic(accounts)
  assert.match(partial.accounts[api.id].error, /不支持/)
  assert.equal(partial.accounts[oauth.id].success, 900)
  assert.ok(!JSON.stringify(partial).includes(api.apiKey))
  authMalformed = true
  assert.ok((await client.getTraffic(accounts)).accounts[oauth.id].error)
  calls = []
  await client.getTraffic([oauth])
  assert.deepEqual(calls, ['/v0/management/auth-files'])
  calls = []
  await client.getTraffic([native])
  assert.equal(calls.length, 0)
} finally { globalThis.fetch = originalFetch }

const cache = new CpaTrafficCache()
let reads = 0
const success = { accounts: { a: chart }, fetchedAt: new Date(now).toISOString() }
const loadOk = async () => { reads++; return success }
await Promise.all([cache.get('scope', loadOk, 0), cache.get('scope', loadOk, 0)])
assert.equal(reads, 1)
await cache.get('scope', loadOk, 9999)
assert.equal(reads, 1)
const stale = await cache.get('scope', async () => ({ ...success, accounts: { a: { error: 'offline' } } }), 10001)
assert.deepEqual(stale.accounts.a.buckets, chart.buckets)
assert.equal(stale.accounts.a.error, 'offline')
assert.equal(stale.accounts.a.updatedAt, chart.updatedAt)
const recovered = await cache.get('scope', loadOk, 20002)
assert.equal(recovered.accounts.a.error, undefined)
const changed = await cache.get('new-scope', async () => ({ ...success, accounts: { a: { error: 'offline' } } }), 20003)
assert.equal(changed.accounts.a.buckets, undefined, 'Never reuse data from a different CPA configuration')
console.log('PASS: 20 time buckets, totals vs recent window, OAuth/API association, key isolation, read-only requests, partial failures, redaction, shared cache and stale recovery')
