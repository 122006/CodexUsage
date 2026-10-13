import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/main/cpa.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { CpaClient, managedProviderName, managedAuthFileName } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const api = { id: 'remote', label: 'Remote API', accountMode: 'api', modeVisibility: 'both', apiEndpoint: 'https://example.invalid/v1/', apiKey: 'test-only', apiModel: 'local-default-only' }
const oauth = { id: 'subscription', accountMode: 'codex', modeVisibility: 'both', accessToken: 'test-only' }
const native = { ...api, id: 'native', modeVisibility: 'native' }
const unrelated = { name: 'external', 'base-url': 'https://unrelated.invalid/v1', priority: 7 }
let providers = [unrelated, { name: managedProviderName(native), 'base-url': native.apiEndpoint }]
let authPriority
let malformed = false
let discardWrites = false
let writes = 0
let discoveryCalls = 0
const queryModels = async (endpoint, key) => {
  assert.equal(endpoint, api.apiEndpoint)
  assert.equal(key, api.apiKey)
  discoveryCalls += 1
  return ['model-a', 'model-b', 'model-a']
}
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname
  const method = init.method ?? 'GET'
  if (path.endsWith('/auth-files') && method === 'GET') return Response.json({ files: [{ name: managedAuthFileName(oauth) }] })
  if (path.endsWith('/auth-files/fields') && method === 'PATCH') {
    authPriority = JSON.parse(init.body).priority
    return Response.json({ status: 'ok' })
  }
  if (path.endsWith('/openai-compatibility')) {
    if (method === 'GET') return Response.json(malformed ? {} : { 'openai-compatibility': providers })
    if (method === 'PUT') {
      writes += 1
      if (!discardWrites) providers = JSON.parse(init.body)
      return Response.json({ status: 'ok' })
    }
  }
  throw new Error(`Unexpected request: ${method} ${path}`)
}
try {
  const client = new CpaClient('http://127.0.0.1:18516', 'test-only')
  const first = await client.syncAccounts([api, oauth, native], { queryModels })
  assert.equal(first.apiAdded, 1)
  assert.equal(first.skipped, 1)
  assert.deepEqual(providers.find((p) => p.name === 'external'), unrelated)
  assert.equal(providers.some((p) => p.name === managedProviderName(native)), false)
  let remote = providers.find((p) => p.name === managedProviderName(api))
  assert.equal(remote['base-url'], 'https://example.invalid/v1')
  assert.equal(remote['api-key-entries'][0]['api-key'], api.apiKey)
  assert.deepEqual(remote.models, [{ name: 'model-a', alias: 'model-a' }, { name: 'model-b', alias: 'model-b' }])
  assert.ok(remote.priority > authPriority)
  remote.headers = { 'X-Custom': 'preserve' }
  remote.models.push({ name: 'model-custom', alias: 'custom-alias', thinking: { levels: ['high'] } })
  const preservedModels = structuredClone(remote.models)
  api.apiModel = 'another-default'
  const second = await client.syncAccounts([oauth, api, native])
  assert.equal(second.apiAdded, 0)
  assert.equal(second.apiUpdated, 1)
  remote = providers.find((p) => p.name === managedProviderName(api))
  assert.ok(remote.priority < authPriority)
  assert.deepEqual(remote.headers, { 'X-Custom': 'preserve' })
  assert.deepEqual(remote.models, preservedModels)
  assert.equal(discoveryCalls, 1)
  assert.equal(providers.filter((p) => p.name === remote.name).length, 1)
  await client.syncAccounts([oauth, api, native], { refreshModels: true, queryModels: async () => ['model-c'] })
  remote = providers.find((p) => p.name === managedProviderName(api))
  assert.deepEqual(remote.models, [...preservedModels, { name: 'model-c', alias: 'model-c' }])
  const beforeFailure = writes
  await assert.rejects(client.syncAccounts([api, oauth, native], { refreshModels: true, queryModels: async () => { throw new Error('offline') } }), /读取 API 可用模型失败/)
  assert.equal(writes, beforeFailure)
  await assert.rejects(client.syncAccounts([api, oauth, native], { refreshModels: true, queryModels: async () => [] }), /没有返回可用模型/)
  assert.equal(writes, beforeFailure)
  discardWrites = true
  await assert.rejects(client.syncAccounts([api, oauth, native]), /校验失败/)
  malformed = true
  const before = writes
  await assert.rejects(client.syncAccounts([api, oauth, native]), /配置列表无效/)
  assert.equal(writes, before)
  console.log('PASS: model discovery, default-model independence, alias preservation, discovery failure, mixed priorities and readback checks')
} finally {
  globalThis.fetch = originalFetch
}
