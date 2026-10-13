const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REFRESH_ATTEMPTS = 3
const REFRESH_TIMEOUT_MS = 30_000

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function responseError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return text(payload) ?? '未知错误'
  const value = payload as Record<string, unknown>
  return text(value.error_description) ?? text(value.message) ?? text(value.error) ?? '未知错误'
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function codexTokenData(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['id_token', 'access_token', 'refresh_token', 'account_id', 'expired', 'last_refresh', 'token_type']) {
    if (payload[key] !== undefined && payload[key] !== null) result[key] = payload[key]
  }
  return result
}

export async function refreshCodexOAuthCredential(source: Record<string, unknown>): Promise<Record<string, unknown>> {
  const refreshToken = text(source.refresh_token)
  if (!refreshToken) throw new Error('该账号没有 refresh_token，无法刷新凭证')

  let lastError: Error | undefined
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(attempt * 1_000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    try {
      const response = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'openid profile email'
        })
      })
      const raw = await response.text()
      let payload: unknown = undefined
      if (raw) {
        try { payload = JSON.parse(raw) } catch { payload = raw }
      }
      if (!response.ok) {
        const error = new Error(`Codex OAuth 刷新失败（HTTP ${response.status}）：${responseError(payload)}`)
        if ((response.status >= 400 && response.status < 500 && response.status !== 429) || raw.toLowerCase().includes('refresh_token_reused')) throw error
        lastError = error
        continue
      }
      if (!payload || typeof payload !== 'object') throw new Error('Codex OAuth 刷新响应不是有效 JSON')
      const tokens = payload as Record<string, unknown>
      const accessToken = text(tokens.access_token)
      if (!accessToken) throw new Error('Codex OAuth 刷新响应缺少 access_token')
      const now = new Date()
      const expiresIn = Number(tokens.expires_in)
      return {
        ...source,
        access_token: accessToken,
        refresh_token: text(tokens.refresh_token) ?? refreshToken,
        id_token: text(tokens.id_token) ?? source.id_token,
        token_type: text(tokens.token_type) ?? source.token_type,
        ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expired: new Date(now.getTime() + expiresIn * 1_000).toISOString() } : {}),
        last_refresh: now.toISOString(),
        type: 'codex'
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes('HTTP 4') || error.message.includes('refresh_token_reused'))) throw error
      lastError = (error as Error).name === 'AbortError' ? new Error('Codex OAuth 刷新请求超时') : error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new Error(`Codex OAuth 刷新失败，已尝试 ${REFRESH_ATTEMPTS} 次：${lastError?.message ?? '未知错误'}`)
}
