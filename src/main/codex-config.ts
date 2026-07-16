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

export function stripManagedConfig(text: string, rootMode: 'all' | 'managed'): string {
  const output: string[] = []
  let table: string | undefined
  let custom = false
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)
    if (header) { table = header[1].trim().toLowerCase(); custom = table === 'model_providers.custom' }
    if (custom) continue
    if (!table) {
      const setting = line.match(/^\s*(model_provider|model)\s*=\s*["']([^"']+)["']/i)
      const key = setting?.[1].toLowerCase()
      const value = setting?.[2].toLowerCase()
      if (setting && (rootMode === 'all' || value === (key === 'model_provider' ? 'custom' : 'gpt-5.6-sol'))) continue
    }
    output.push(line)
  }
  const cleaned = output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned ? `${cleaned}\n` : ''
}

export function rootProvider(text: string): string | undefined {
  return rootStringValue(text, 'model_provider')
}

export function validApiConfig(text: string, endpoint: string): boolean {
  return rootProvider(text)?.toLowerCase() === 'custom' && rootStringValue(text, 'model')?.toLowerCase() === 'gpt-5.6-sol' &&
    tableStringValue(text, 'model_providers.custom', 'name')?.toLowerCase() === 'custom' &&
    normalizeEndpoint(customEndpoint(text)) === normalizeEndpoint(endpoint) &&
    tableStringValue(text, 'model_providers.custom', 'wire_api')?.toLowerCase() === 'responses' &&
    /^\s*requires_openai_auth\s*=\s*true\s*(?:#.*)?$/im.test(text)
}

export function validCodexConfig(text: string): boolean {
  return rootProvider(text)?.toLowerCase() !== 'custom' && rootStringValue(text, 'model')?.toLowerCase() !== 'gpt-5.6-sol' && !tableExists(text, 'model_providers.custom')
}
