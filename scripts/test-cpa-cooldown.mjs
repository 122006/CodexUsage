import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry, plugins = []) {
  const bundle = await build({ entryPoints: [entry], plugins, bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
const { CpaClient, managedAuthFileName } = await load('src/main/cpa.ts')
const { quotaAllowsRecovery } = await load('src/main/quota-availability.ts')
const { queryUsage } = await load('src/main/quota.ts', [{ name: 'mock-electron', setup(build) {
  build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
  build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const net = { fetch: (...args) => globalThis.fetch(...args) }' }))
} }])
const account = { id: 'plus', accountMode: 'codex', modeVisibility: 'both', accessToken: 'test-only', accountId: 'upstream-plus' }
const payload = () => ({
  plan_type: 'plus',
  rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800 } },
  additional_rate_limits: null,
  model_usage: { 'gpt-6-astra': { available: true } },
  rate_limit_reached_type: null
})
const usage = (overrides = {}) => ({ accountId: account.id, statusCode: 200, windows: [{ name: '5h', remaining: 100 }, { name: '7d', remaining: 100 }], quotaAvailable: true, queriedAt: new Date(Date.now() - 1000).toISOString(), ...overrides })
const cooldown = (overrides = {}) => ({ scope: 'credential', reason: 'credential_quota', retry_at: new Date(Date.now() + 86400000).toISOString(), ...overrides })
const file = (overrides = {}) => ({
  name: managedAuthFileName(account), provider: 'codex', auth_index: 'test-index', disabled: false,
  updated_at: new Date(Date.now() - 10000).toISOString(), quota: { observed_at: new Date(Date.now() - 86400000).toISOString() },
  cooldowns: [cooldown(), cooldown({ scope: 'model', model_key: 'gpt-6-astra', reason: 'quota', http_status: 429 }), cooldown({ scope: 'model', model_key: 'gpt-6.1-sol' })], ...overrides
})

assert.equal(quotaAllowsRecovery(payload()), true)
const partial = payload()
partial.rate_limit.primary_window.used_percent = 95
partial.rate_limit.secondary_window.used_percent = 99.99
assert.equal(quotaAllowsRecovery(partial), true)
const primaryOnly = payload()
primaryOnly.rate_limit.secondary_window = null
assert.equal(quotaAllowsRecovery(primaryOnly), true)
for (const change of [
  (p) => { p.rate_limit.allowed = false },
  (p) => { delete p.rate_limit.allowed },
  (p) => { p.rate_limit.limit_reached = true },
  (p) => { p.rate_limit.primary_window.used_percent = 100 },
  (p) => { p.rate_limit.secondary_window.used_percent = 100 },
  (p) => { p.rate_limit.primary_window.used_percent = -1 },
  (p) => { p.rate_limit.primary_window.used_percent = NaN },
  (p) => { p.rate_limit.primary_window.used_percent = '0' },
  (p) => { p.rate_limit.primary_window.limit_window_seconds = 0 },
  (p) => { p.rate_limit.primary_window = null; p.rate_limit.secondary_window = null },
  (p) => { p.rate_limit = null },
  (p) => { p.additional_rate_limits = [{ rate_limit: { ...p.rate_limit, allowed: false } }] },
  (p) => { p.rate_limits = [{ rate_limit: { ...p.rate_limit, limit_reached: true } }] },
  (p) => { p.additional_rate_limits = {} },
  (p) => { p.model_usage['gpt-6-astra'].available = false },
  (p) => { p.model_usage['gpt-6-astra'] = {} },
  (p) => { p.rate_limit_reached_type = 'weekly' }
]) {
  const p = payload(); change(p)
  assert.equal(quotaAllowsRecovery(p), false, change.toString())
}

const originalFetch = globalThis.fetch
let files, calls, resets, listStatus, resetStatus, upstream, upstreamStatus, discardWrites, invalidReply
function reset() {
  files = [file()]; calls = []; resets = []; listStatus = 200; resetStatus = {}; upstream = payload(); upstreamStatus = 200; discardWrites = false; invalidReply = false
}
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url)
  const method = init.method ?? 'GET'
  calls.push(`${method} ${target.pathname}`)
  if (target.hostname === 'chatgpt.com') {
    assert.equal(target.pathname, '/backend-api/wham/usage')
    assert.equal(method, 'GET')
    return Response.json(upstream, { status: upstreamStatus })
  }
  assert.equal(init.headers.Authorization, 'Bearer test-only')
  if (target.pathname === '/v0/management/auth-files' && method === 'GET') return Response.json({ files, error: 'sensitive-backend-error' }, { status: listStatus })
  if (target.pathname === '/v0/management/reset-quota' && method === 'POST') {
    const body = JSON.parse(init.body)
    assert.deepEqual(Object.keys(body), ['auth_index'])
    resets.push(body.auth_index)
    const status = resetStatus[body.auth_index] ?? 200
    if (status !== 200) return Response.json({ error: 'sensitive-backend-error' }, { status })
    if (!discardWrites) files.find((f) => f.auth_index === body.auth_index).cooldowns = []
    return Response.json(invalidReply ? {} : { status: 'ok', auth_index: body.auth_index })
  }
  throw new Error(`Unexpected request: ${method} ${target.pathname}`)
}
try {
  const client = new CpaClient('http://127.0.0.1:18516', 'test-only')
  reset()
  const queried = await queryUsage(account)
  assert.equal(queried.quotaAvailable, true)
  assert.equal(queried.statusCode, 200)
  assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: queried }]), [{ accountId: account.id, cleared: true }])
  assert.deepEqual(resets, ['test-index'])
  assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: queried }]), [])
  assert.equal(resets.length, 1, 'Repeated refresh must not reset a healthy credential')

  for (const overrides of [{ statusCode: 401 }, { error: 'network failure' }, { quotaAvailable: false }, { quotaAvailable: undefined }, { accountId: 'other-account' }, { queriedAt: 'invalid' }, { queriedAt: new Date(Date.now() - 180000).toISOString() }, { queriedAt: new Date(Date.now() + 180000).toISOString() }]) {
    reset()
    assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: usage(overrides) }]), [])
    assert.equal(calls.length, 0)
  }
  for (const overrides of [{ accountMode: 'api' }, { modeVisibility: 'native' }]) {
    reset()
    assert.deepEqual(await client.recoverQuotaCooldowns([{ account: { ...account, ...overrides }, usage: usage() }]), [])
    assert.equal(calls.length, 0)
  }
  for (const overrides of [
    { disabled: true }, { provider: 'claude' }, { auth_index: '' }, { cooldowns: [] }, { cooldowns: undefined }, { cooldowns: [null] },
    { cooldowns: [cooldown({ scope: 'model', reason: 'quota', http_status: 429 })] },
    { cooldowns: [cooldown({ retry_at: new Date(Date.now() - 10000).toISOString() })] },
    { cooldowns: [cooldown({ retry_at: 'bad-date' })] },
    { cooldowns: [cooldown({ reason: 'unauthorized', http_status: 401 })] },
    { cooldowns: [cooldown(), cooldown({ scope: 'model', reason: 'model_not_found', http_status: 404 })] },
    { cooldowns: [cooldown(), cooldown({ scope: 'model', reason: 'transient', http_status: 500 })] },
    { cooldowns: [cooldown({ http_status: 403 })] },
    { updated_at: new Date(Date.now() + 1000).toISOString() },
    { quota: { observed_at: new Date(Date.now() + 1000).toISOString() } },
    { updated_at: 'bad-date' }
  ]) {
    reset(); files = [file(overrides)]
    assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: usage() }]), [], JSON.stringify(overrides))
    assert.equal(resets.length, 0)
  }
  reset(); files = [file({ name: 'unrelated.json' })]
  assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: usage() }]), [])
  reset(); files = [file({ name: 'imported.json', codex_usage_account_id: account.id })]
  assert.equal((await client.recoverQuotaCooldowns([{ account, usage: usage() }]))[0].cleared, true)
  reset(); files.push(file({ name: 'duplicate.json', codex_usage_account_id: account.id }))
  assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: usage() }]), [])
  reset()
  await client.recoverQuotaCooldowns([{ account, usage: usage() }, { account, usage: usage() }])
  assert.equal(resets.length, 1)

  reset(); listStatus = 503
  const failedList = await client.recoverQuotaCooldowns([{ account, usage: usage() }])
  assert.equal(failedList[0].cleared, false)
  assert.equal(failedList[0].error, 'HTTP 503')
  assert.equal(resets.length, 0)
  reset(); resetStatus['test-index'] = 404
  assert.equal((await client.recoverQuotaCooldowns([{ account, usage: usage() }]))[0].error, 'HTTP 404')
  reset(); invalidReply = true
  assert.equal((await client.recoverQuotaCooldowns([{ account, usage: usage() }]))[0].cleared, false)

  reset()
  const other = { ...account, id: 'pro', cpaAuthFileName: 'imported-pro.json' }
  files.push(file({ name: managedAuthFileName(other), auth_index: 'pro-index' }))
  resetStatus['test-index'] = 500
  const batch = await client.recoverQuotaCooldowns([{ account, usage: usage() }, { account: other, usage: usage({ accountId: other.id }) }])
  assert.deepEqual(batch, [{ accountId: account.id, cleared: false, error: 'HTTP 500' }, { accountId: other.id, cleared: true }])
  assert.equal(calls.filter((call) => call === 'GET /v0/management/auth-files').length, 1)
  assert.deepEqual(resets, ['test-index', 'pro-index'])

  reset(); upstream.rate_limit.allowed = false
  assert.equal((await queryUsage(account)).quotaAvailable, false)
  reset(); upstreamStatus = 401; upstream = { error: { code: 'token_expired' } }
  const failedUsage = await queryUsage(account)
  assert.equal(failedUsage.quotaAvailable, undefined)
  assert.equal(calls.length, 2, 'Quota retries must not refresh OAuth credentials')
  assert.deepEqual(await client.recoverQuotaCooldowns([{ account, usage: failedUsage }]), [])
  console.log('PASS: quota parsing, CPA credential-only recovery, stale/racing data, model/auth protection, batch isolation, idempotency, HTTP failures and secret-safe errors')
} finally {
  globalThis.fetch = originalFetch
}
