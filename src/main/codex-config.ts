function normalizeEndpoint(value?: string): string { return (value ?? '').trim().replace(/\/+$/, '').toLowerCase() }

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

export function rootModel(text: string): string | undefined {
  return rootStringValue(text, 'model')
}

export function rootModelReasoningEffort(text: string): string | undefined {
  return rootStringValue(text, 'model_reasoning_effort')
}

export function stripManagedConfig(text: string, rootMode: 'all' | 'managed'): string {
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

export function validApiConfig(text: string, endpoint: string, model: string, reasoningEffort: string, wireApi: string): boolean {
  return rootProvider(text)?.toLowerCase() === 'custom' && rootModel(text) === model && rootModelReasoningEffort(text)?.toLowerCase() === reasoningEffort.toLowerCase() &&
    tableStringValue(text, 'model_providers.custom', 'name')?.toLowerCase() === 'custom' &&
    normalizeEndpoint(customEndpoint(text)) === normalizeEndpoint(endpoint) &&
    customWireApi(text) === wireApi &&
    /^\s*requires_openai_auth\s*=\s*true\s*(?:#.*)?$/im.test(text)
}

export function validCodexConfig(text: string): boolean {
  return rootProvider(text)?.toLowerCase() !== 'custom' && !tableExists(text, 'model_providers.custom')
}
