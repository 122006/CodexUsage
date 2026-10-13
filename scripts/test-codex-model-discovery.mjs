import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/main/codex-config.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { buildApiConfig, customModelCatalogUrl, enableCpaModelDiscovery, restoreCpaModelDiscovery, stripManagedConfig, validApiConfig, validCodexConfig } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const endpoint = 'http://127.0.0.1:18516/v1'
const catalog = `${endpoint}/models`
const model = 'gpt-6-astra'
const configs = []

for (const source of [
  '',
  '[features]\nshell_snapshot = true\n',
  '[features]\n  api_key_model_discovery = false # user preference\nshell_snapshot = true\n',
  '[features]\napi_key_model_discovery = true # already enabled\n',
  'features.api_key_model_discovery = false\n[other]\nflag = false\n',
  'features.shell_snapshot = true\n[other]\nflag = false\n',
  '["features"]\n"api_key_model_discovery" = false\n',
  "['features']\n'api_key_model_discovery' = false\n",
  '[features]\r\napi_key_model_discovery = false # CRLF\r\n'
]) {
  const enabled = enableCpaModelDiscovery(source)
  assert.equal(enableCpaModelDiscovery(enabled), enabled, 'Repeated enable must be idempotent')
  const restored = restoreCpaModelDiscovery(enabled)
  if (source) assert.equal(restored.trim(), source.trim(), 'Restore previous flag and comments')
  else assert.doesNotMatch(restored, /api_key_model_discovery/)
  const cpa = buildApiConfig(source, endpoint, model, 'high', 'responses', catalog)
  assert.ok(validApiConfig(cpa, endpoint, model, 'high', 'responses', catalog))
  assert.equal(customModelCatalogUrl(cpa), catalog)
  assert.equal(buildApiConfig(cpa, endpoint, model, 'high', 'responses', catalog), cpa)
  const api = buildApiConfig(cpa, 'https://example.invalid/v1', 'another-model', 'max', 'responses')
  assert.ok(validApiConfig(api, 'https://example.invalid/v1', 'another-model', 'max', 'responses'))
  assert.doesNotMatch(api, /model_catalog_url|codexusage-cpa-discovery-previous/)
  const native = stripManagedConfig(cpa, 'managed')
  assert.ok(validCodexConfig(native))
  assert.doesNotMatch(native, /model_catalog_url|codexusage-cpa-discovery-previous/)
  if (/api_key_model_discovery["']?\s*=\s*false/.test(source)) assert.match(api, /api_key_model_discovery["']?\s*=\s*false/)
  configs.push(cpa, api, native)
}

const base = 'model = "original-model"\nsqlite_home = "C:/codex-state"\nmodel_context_window = 123456\n[features]\nshell_snapshot = true\n[model_providers.other]\nname = "other"\nbase_url = "https://other.invalid/v1"\n'
const cpa = buildApiConfig(base, endpoint, model, 'high', 'responses', catalog)
assert.match(cpa.slice(0, cpa.indexOf('[')), /sqlite_home = "C:\/codex-state"/)
assert.match(cpa.slice(0, cpa.indexOf('[')), /model_context_window = 123456/)
assert.match(cpa, /\[model_providers.other\]\nname = "other"/)
assert.equal((cpa.match(/\[features\]/g) ?? []).length, 1)
assert.equal((cpa.match(/\[model_providers.custom\]/g) ?? []).length, 1)
const movedCatalog = 'http://localhost:18517/v1/models'
const moved = buildApiConfig(cpa, 'http://localhost:18517/v1', model, 'high', 'responses', movedCatalog)
assert.equal(customModelCatalogUrl(moved), movedCatalog)
assert.doesNotMatch(moved, /18516/)
assert.ok(!validApiConfig(cpa.replace('api_key_model_discovery = true', 'api_key_model_discovery = false'), endpoint, model, 'high', 'responses', catalog))
assert.ok(!validApiConfig(cpa, endpoint, model, 'high', 'responses'))
assert.throws(() => enableCpaModelDiscovery('features = { shell_snapshot = true }\n'), /features/)
const edited = enableCpaModelDiscovery('[features]\napi_key_model_discovery = true\n').replace('= true', '= false')
assert.match(restoreCpaModelDiscovery(edited), /= false/)
const editedManaged = enableCpaModelDiscovery('[features]\n').replace('= true', '= false')
assert.equal(restoreCpaModelDiscovery(editedManaged), '[features]\napi_key_model_discovery = false\n')
configs.push(cpa, moved)
console.log('PASS: CPA discovery, API/native restoration, user preferences, repeated switching, root settings, quoted/dotted keys and CRLF')

// Optional integration check with Codex's actual TOML/catalog parser, fully offline.
const binary = process.env.CODEX_TEST_BINARY
if (binary) {
  const home = await mkdtemp(join(tmpdir(), 'codex-discovery-test-'))
  const run = (args) => {
    const result = spawnSync(binary, args, { cwd: home, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return JSON.parse(result.stdout)
  }
  try {
    const bundled = run(['debug', 'models', '--bundled'])
    const catalogPath = join(home, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(bundled))
    for (const config of configs) {
      await writeFile(join(home, 'config.toml'), config)
      const result = run(['debug', 'models', '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`])
      assert.deepEqual(result.models.map((entry) => entry.slug), bundled.models.map((entry) => entry.slug))
    }
    console.log(`PASS: ${configs.length} configurations accepted by the installed Codex parser`)
  } finally {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(basename(home).startsWith('codex-discovery-test-'))
    await rm(home, { recursive: true, force: true })
  }
}
