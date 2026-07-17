import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { AccountInput, ApiModelQuery, AppSettings, AppSnapshot, LocalBridge } from '../shared/types'

type HttpOperations = Omit<LocalBridge, 'onSnapshot'>

export interface LocalHttpServer {
  url: string
  publish(snapshot: AppSnapshot): void
  close(): Promise<void>
}

interface ServerOptions {
  rendererDirectory: string
  rendererDevUrl?: string
  operations: HttpOperations
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}
const FIRST_LOCAL_PORT = 64991

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const raw of cookies) {
    const [key, ...parts] = raw.trim().split('=')
    if (key === name) {
      try { return decodeURIComponent(parts.join('=')) } catch { return undefined }
    }
  }
  return undefined
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 10 * 1024 * 1024) throw new Error('请求内容超过 10 MB')
    chunks.push(value)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { throw new Error('请求内容不是有效 JSON') }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value ?? null))
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' })
  response.end(payload)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function startLocalHttpServer(options: ServerOptions): Promise<LocalHttpServer> {
  const session = randomBytes(32).toString('hex')
  const cookieName = 'codex_usage_session'
  const clients = new Set<ServerResponse>()
  const rendererRoot = resolve(options.rendererDirectory)
  const devOrigin = options.rendererDevUrl ? new URL(options.rendererDevUrl).origin : undefined
  let localUrl = ''

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', localUrl || 'http://127.0.0.1')
    const origin = request.headers.origin
    const allowedOrigin = !origin || origin === localUrl || origin === devOrigin
    if (origin && allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Access-Control-Allow-Credentials', 'true')
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin) { response.writeHead(403); response.end(); return }
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      response.end(); return
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      if (!allowedOrigin || cookieValue(request, cookieName) !== session) { json(response, 403, { error: '本地会话无效，请从 CodexUsage 重新打开浏览器页面' }); return }
      try {
        if (request.method === 'GET' && requestUrl.pathname === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
          clients.add(response)
          response.on('close', () => clients.delete(response))
          response.write(`data: ${JSON.stringify(await options.operations.getSnapshot())}\n\n`)
          return
        }
        if (request.method === 'GET' && requestUrl.pathname === '/api/snapshot') return json(response, 200, await options.operations.getSnapshot())
        if (request.method === 'POST' && requestUrl.pathname === '/api/refresh') { const input = await body(request); return json(response, 200, await options.operations.refresh(input.accountIds as string[] | undefined)) }
        if (request.method === 'POST' && requestUrl.pathname === '/api/accounts/import-current') return json(response, 200, await options.operations.importCurrent())
        if (request.method === 'POST' && requestUrl.pathname === '/api/models') return json(response, 200, await options.operations.queryApiModels(await body(request) as unknown as ApiModelQuery))
        if (request.method === 'POST' && requestUrl.pathname === '/api/accounts/save') return json(response, 200, await options.operations.saveAccount(await body(request) as unknown as AccountInput))
        if (request.method === 'POST' && requestUrl.pathname === '/api/accounts/import-text') { const input = await body(request); return json(response, 200, await options.operations.importText(String(input.text ?? ''))) }
        if (request.method === 'POST' && requestUrl.pathname === '/api/accounts/export') { const input = await body(request); return json(response, 200, { value: await options.operations.exportAccounts(input.ids as string[] | undefined) }) }
        if (request.method === 'PATCH' && requestUrl.pathname === '/api/settings') return json(response, 200, await options.operations.updateSettings(await body(request) as Partial<AppSettings>))
        if (request.method === 'POST' && requestUrl.pathname === '/api/hook/install') return json(response, 200, { value: await options.operations.installHook() })
        if (request.method === 'POST' && requestUrl.pathname === '/api/codex/open') return json(response, 200, await options.operations.openCodex())
        if (request.method === 'POST' && requestUrl.pathname === '/api/browser/open') return json(response, 200, await options.operations.openBrowser())
        if (request.method === 'POST' && requestUrl.pathname === '/api/log/open') return json(response, 200, await options.operations.openLog())
        if (request.method === 'POST' && requestUrl.pathname === '/api/log/open-directory') return json(response, 200, await options.operations.openLogDirectory())
        if (request.method === 'POST' && requestUrl.pathname === '/api/panel/show') return json(response, 200, await options.operations.showPanel())
        if (request.method === 'POST' && requestUrl.pathname === '/api/panel/hide') return json(response, 200, await options.operations.hidePanel())
        if (request.method === 'POST' && requestUrl.pathname === '/api/widget/start-drag') return json(response, 200, await options.operations.startWidgetDrag())
        if (request.method === 'POST' && requestUrl.pathname === '/api/app/quit') return json(response, 200, await options.operations.quit())

        const accountMatch = requestUrl.pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(switch|reset-credits))?$/)
        if (accountMatch) {
          const id = decodeURIComponent(accountMatch[1]); const action = accountMatch[2]
          if (request.method === 'DELETE' && !action) return json(response, 200, await options.operations.removeAccount(id))
          if (request.method === 'POST' && action === 'switch') return json(response, 200, await options.operations.switchAccount(id))
          if (request.method === 'GET' && action === 'reset-credits') return json(response, 200, await options.operations.getResetCreditDetail(id))
        }
        json(response, 404, { error: '接口不存在' })
      } catch (error) { json(response, 500, { error: errorMessage(error) }) }
      return
    }

    response.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/`)
    if (options.rendererDevUrl) {
      const target = new URL(options.rendererDevUrl)
      for (const [key, value] of requestUrl.searchParams) target.searchParams.set(key, value)
      target.searchParams.set('bridge', localUrl)
      response.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' }); response.end(); return
    }

    let pathname: string
    try { pathname = requestUrl.pathname === '/' ? 'index.html' : decodeURIComponent(requestUrl.pathname.slice(1)) } catch { response.writeHead(400); response.end('Bad request'); return }
    let file = resolve(rendererRoot, pathname)
    if (file !== rendererRoot && !file.startsWith(`${rendererRoot}${sep}`)) { response.writeHead(403); response.end(); return }
    const fileStat = await stat(file).catch(() => undefined)
    if (!fileStat?.isFile()) { pathname = 'index.html'; file = resolve(rendererRoot, pathname) }
    try {
      const content = await readFile(file)
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': pathname === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      response.end(content)
    } catch { response.writeHead(404); response.end('Not found') }
  })

  let selectedPort: number | undefined
  for (let port = FIRST_LOCAL_PORT; port <= 65535; port += 1) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
        const onListening = (): void => { server.off('error', onError); resolvePromise() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      selectedPort = port
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  if (!selectedPort) throw new Error(`端口 ${FIRST_LOCAL_PORT}-65535 均已被占用`)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法确定本地 HTTP 服务端口')
  localUrl = `http://127.0.0.1:${address.port}`
  const heartbeat = setInterval(() => { for (const client of clients) if (!client.destroyed && !client.writableEnded) client.write(': keepalive\n\n') }, 20_000)
  heartbeat.unref()

  return {
    url: localUrl,
    publish(value): void { const message = `data: ${JSON.stringify(value)}\n\n`; for (const client of clients) if (!client.destroyed && !client.writableEnded) client.write(message) },
    close(): Promise<void> {
      clearInterval(heartbeat)
      for (const client of clients) client.end()
      return new Promise((resolvePromise) => server.close(() => resolvePromise()))
    }
  }
}
