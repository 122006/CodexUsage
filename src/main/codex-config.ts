function normalizeEndpoint(value?: string): string { return (value ?? '').trim().replace(/\/+$/, '').toLowerCase() }

const DISCOVERY_BACKUP_MARKER = ' # codexusage-cpa-discovery-previous: '
const FEATURE_NAME = '(?:features|"features"|\'features\')'
const DISCOVERY_NAME = '(?:api_key_model_discovery|"api_key_model_discovery"|\'api_key_model_discovery\')'
const FEATURE_HEADER = new RegExp(`^\\s*\\[\\s*${FEATURE_NAME}\\s*]\\s*(?:#.*)?$`)
const DISCOVERY_SETTING = new RegExp(`^\\s*${DISCOVERY_NAME}\\s*=\\s*(true|false)\\s*(?:#.*)?$`)
const DOTTED_DISCOVERY_SETTING = new RegExp(`^\\s*${FEATURE_NAME}\\s*\\.\\s*${DISCOVERY_NAME}\\s*=\\s*(true|false)\\s*(?:#.*)?$`)

function modelDiscoverySetting(text: string): { index: number; value: boolean } | undefined {
  let root = true
  let features = false
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*\[/.test(line)) { root = false; features = FEATURE_HEADER.test(line) }
    const match = features ? line.match(DISCOVERY_SETTING) : root ? line.match(DOTTED_DISCOVERY_SETTING) : undefined
    if (match) return { index, value: match[1] === 'true' }
  }
  return undefined
}

export function restoreCpaModelDiscovery(text: string): string {
  const setting = modelDiscoverySetting(text)
  if (!setting) return text
  const lines = text.split(/\r?\n/)
  const line = lines[setting.index]
  const markerIndex = line.indexOf(DISCOVERY_BACKUP_MARKER)
  if (markerIndex < 0) return text
  const previous: unknown = JSON.parse(line.slice(markerIndex + DISCOVERY_BACKUP_MARKER.length))
  if (previous !== null && (typeof previous !== 'string' || /[\r\n]/.test(previous) || (!DISCOVERY_SETTING.test(previous) && !DOTTED_DISCOVERY_SETTING.test(previous)))) {
    throw new Error('CPA 模型发现开关的恢复信息无效，已取消配置修改')
  }
  // Restore only our override; keep a flag the user changed while CPA was active.
  if (!setting.value) lines[setting.index] = line.slice(0, markerIndex)
  else if (previous === null) lines.splice(setting.index, 1)
  else lines[setting.index] = previous as string
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
}

export function enableCpaModelDiscovery(text: string): string {
  const clean = restoreCpaModelDiscovery(text)
  const setting = modelDiscoverySetting(clean)
  if (setting?.value) return clean
  const newline = clean.includes('\r\n') ? '\r\n' : '\n'
  const lines = clean.split(/\r?\n/)
  if (setting) {
    const original = lines[setting.index]
    lines[setting.index] = `${original.replace(/=\s*false/, '= true')}${DISCOVERY_BACKUP_MARKER}${JSON.stringify(original)}`
  } else {
    const entry = `api_key_model_discovery = true${DISCOVERY_BACKUP_MARKER}null`
    const headerIndex = lines.findIndex((line) => FEATURE_HEADER.test(line))
    if (headerIndex >= 0) lines.splice(headerIndex + 1, 0, entry)
    else {
      const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
      const root = lines.slice(0, firstTable < 0 ? lines.length : firstTable)
      if (root.some((line) => new RegExp(`^\\s*${FEATURE_NAME}\\s*=`).test(line))) throw new Error('请先将内联 features 配置展开为 [features] 配置段，再启用 CPA 模型发现')
      // A dotted root key may already define features, so use the same TOML form.
      if (root.some((line) => new RegExp(`^\\s*${FEATURE_NAME}\\s*\\.`).test(line))) lines.unshift(`features.${entry}`)
      else lines.push('', '[features]', entry)
    }
  }
  return lines.join(newline)
}

function tableExists(text: string, name: string): boolean {
  return text.split(/\r?\n/).some((line) => line.match(/^\s*\[([^\]]+)]/)?.[1].trim().toLowerCase() === name.toLowerCase())
}

function tableStringValue(text: string, tableName: string, key: string): string | undefined {
  let table = ''
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]/)
    if (header) table = header[1].trim().toLowerCase()
    if (table === tableName.toLowerCase()) {
      const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'i'))
      if (match) return match[1]
    }
  }
  return undefined
}

function rootStringValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'i'))
    if (match) return match[1]
  }
  return undefined
}

export function customEndpoint(config: string): string | undefined {
  return tableStringValue(config, 'model_providers.custom', 'base_url')
}

export function customWireApi(config: string): string | undefined {
  return tableStringValue(config, 'model_providers.custom', 'wire_api')
}

export function customModelCatalogUrl(config: string): string | undefined {
  return tableStringValue(config, 'model_providers.custom', 'model_catalog_url')
}

export function buildApiConfig(current: string, endpoint: string, model: string, reasoningEffort: string, wireApi: string, modelCatalogUrl?: string): string {
  let base = stripManagedConfig(current, 'all')
  if (modelCatalogUrl) base = enableCpaModelDiscovery(base)
  const root = `model_provider = "custom"\nmodel = ${JSON.stringify(model)}\nmodel_reasoning_effort = ${JSON.stringify(reasoningEffort)}\n`
  const provider = `[model_providers.custom]\nname = "custom"\nbase_url = ${JSON.stringify(endpoint)}\nwire_api = ${JSON.stringify(wireApi)}\nrequires_openai_auth = true\n`
  const catalog = modelCatalogUrl ? `model_catalog_url = ${JSON.stringify(modelCatalogUrl)}\n` : ''
  return `${root}\n${base.trim()}\n\n${provider}${catalog}`
}

export function rootModel(text: string): string | undefined {
  return rootStringValue(text, 'model')
}

export function rootModelReasoningEffort(text: string): string | undefined {
  return rootStringValue(text, 'model_reasoning_effort')
}

export function rootSqliteHome(text: string): string | undefined {
  return rootStringValue(text, 'sqlite_home')
}

export function stripManagedConfig(text: string, rootMode: 'all' | 'managed'): string {
  text = restoreCpaModelDiscovery(text)
  const output: string[] = []
  const managedRoot = rootProvider(text)?.toLowerCase() === 'custom' || tableExists(text, 'model_providers.custom')
  let table: string | undefined
  let custom = false
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)
    if (header) { table = header[1].trim().toLowerCase(); custom = table === 'model_providers.custom' }
    if (custom) continue
    if (!table) {
      const setting = line.match(/^\s*(model_reasoning_effort|model_provider|model)\s*=\s*["']([^"']+)["']/i)
      const key = setting?.[1].toLowerCase()
      const value = setting?.[2].toLowerCase()
      if (setting && (rootMode === 'all' ||
        (key === 'model_provider' && value === 'custom') ||
        (managedRoot && (key === 'model' || key === 'model_reasoning_effort')))) continue
    }
    output.push(line)
  }
  const cleaned = output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned ? `${cleaned}\n` : ''
}

export function rootProvider(text: string): string | undefined {
  return rootStringValue(text, 'model_provider')
}

export function validApiConfig(text: string, endpoint: string, model: string, reasoningEffort: string, wireApi: string, modelCatalogUrl?: string): boolean {
  return rootProvider(text)?.toLowerCase() === 'custom' && rootModel(text) === model && rootModelReasoningEffort(text)?.toLowerCase() === reasoningEffort.toLowerCase() &&
    tableStringValue(text, 'model_providers.custom', 'name')?.toLowerCase() === 'custom' &&
    normalizeEndpoint(customEndpoint(text)) === normalizeEndpoint(endpoint) &&
    customWireApi(text) === wireApi &&
    customModelCatalogUrl(text) === modelCatalogUrl &&
    (!modelCatalogUrl || modelDiscoverySetting(text)?.value === true) &&
    /^\s*requires_openai_auth\s*=\s*true\s*(?:#.*)?$/im.test(text)
}

export function validCodexConfig(text: string): boolean {
  return rootProvider(text)?.toLowerCase() !== 'custom' && !tableExists(text, 'model_providers.custom')
}
