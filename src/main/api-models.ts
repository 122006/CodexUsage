import { net } from 'electron'

function modelsUrl(endpoint: string): string {
  let url: URL
  try { url = new URL(endpoint.trim()) } catch { throw new Error('API 端点不是有效的网址') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API 端点仅支持 HTTP 或 HTTPS')
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.toLowerCase().endsWith('/models')) url.pathname = `${path}/models`
  url.hash = ''
  return url.toString()
}

function errorText(body: string): string {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>
    const error = payload.error
    if (error && typeof error === 'object') return String((error as Record<string, unknown>).message ?? (error as Record<string, unknown>).code ?? '未知错误')
    return String(error ?? payload.message ?? payload.code ?? '未知错误')
  } catch { return body.trim().slice(0, 300) || '空响应' }
}

function modelIds(payload: unknown): string[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  const items = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : []
  const ids = items.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()]
    if (!item || typeof item !== 'object') return []
    const id = (item as Record<string, unknown>).id
    return typeof id === 'string' ? [id.trim()] : []
  }).filter(Boolean)
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
}

export async function queryApiModels(endpoint: string, apiKey: string): Promise<string[]> {
  if (!endpoint.trim()) throw new Error('请先填写 API 端点')
  if (!apiKey.trim()) throw new Error('请先填写 API 密钥')
  const response = await net.fetch(modelsUrl(endpoint), {
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json', 'User-Agent': 'CodexUsage' },
    signal: AbortSignal.timeout(20_000)
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorText(body)}`)
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new Error('模型接口返回的不是有效 JSON') }
  const models = modelIds(payload)
  if (!models.length) throw new Error('模型接口响应中没有可用的模型 ID')
  return models
}
