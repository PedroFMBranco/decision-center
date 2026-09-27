import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type {
  ActionResponse,
  ApiError,
  ApiErrorCode,
  DismissRequest,
  FeedSnapshot,
  HealthResponse,
  OpenRequest,
  ReadRequest,
  ReplyRequest,
  SuggestRequest,
  SuggestResponse
} from './contract.ts'
import { API_VERSION, STREAM_EVENT_FEED } from './contract.ts'

export interface ServerDeps {
  port: number
  page: string
  getFeed(): Promise<FeedSnapshot>
  reply(request: ReplyRequest): Promise<ActionResponse>
  open(request: OpenRequest): Promise<ActionResponse>
  read(request: ReadRequest): Promise<ActionResponse>
  dismiss(request: DismissRequest): Promise<ActionResponse>
  suggest(request: SuggestRequest): Promise<SuggestResponse | ApiError>
  health(): Omit<HealthResponse, 'ok' | 'version'>
  log(message: string): void
}

export interface DecisionCenterServer {
  url: string
  broadcast(snapshot: FeedSnapshot): void
  close(): Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024
const STREAM_PING_MS = 25_000

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, code: ApiErrorCode, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function isReplyRequest(body: unknown): body is ReplyRequest {
  const candidate = body as ReplyRequest | null
  if (typeof candidate?.id !== 'string' || typeof candidate.reply !== 'object' || !candidate.reply) {
    return false
  }
  const reply = candidate.reply
  if (reply.type === 'text') {
    return typeof reply.text === 'string' && reply.text.trim().length > 0
  }
  return (
    reply.type === 'option' &&
    Array.isArray(reply.indexes) &&
    reply.indexes.length > 0 &&
    reply.indexes.every((index) => Number.isInteger(index) && index >= 1)
  )
}

function isIdRequest(body: unknown): body is ReadRequest & OpenRequest {
  return typeof (body as ReadRequest | null)?.id === 'string'
}

function isDismissRequest(body: unknown): body is DismissRequest {
  const candidate = body as { id?: unknown; allFinished?: unknown } | null
  return typeof candidate?.id === 'string' || candidate?.allFinished === true
}

function statusFor(result: { ok: true } | ApiError): number {
  return result.ok ? 200 : result.error.code === 'not_found' ? 404 : result.error.code === 'bad_request' ? 400 : 409
}

export function startServer(deps: ServerDeps): Promise<DecisionCenterServer> {
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`])
  const streams = new Set<ServerResponse>()
  let lastSnapshot: FeedSnapshot | null = null

  function writeFeedEvent(res: ServerResponse, snapshot: FeedSnapshot): void {
    res.write(`event: ${STREAM_EVENT_FEED}\ndata: ${JSON.stringify(snapshot)}\n\n`)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Why: the API types into terminals. Refuse anything not addressed to this
    // server (DNS rebinding) or sent from another page (CSRF).
    const origin = req.headers.origin
    if (!allowedHosts.has(req.headers.host ?? '') || (origin && !allowedHosts.has(origin.replace(/^http:\/\//, '')))) {
      sendError(res, 403, 'forbidden', 'request is not from Decision Center')
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET') {
      if (path === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // Why img-src data: the page's grain texture is an inline SVG.
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"
        })
        res.end(deps.page)
        return
      }
      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, version: API_VERSION, ...deps.health() } satisfies HealthResponse)
        return
      }
      if (path === '/api/feed') {
        sendJson(res, 200, await deps.getFeed())
        return
      }
      if (path === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive'
        })
        streams.add(res)
        req.on('close', () => streams.delete(res))
        writeFeedEvent(res, lastSnapshot ?? (await deps.getFeed()))
        return
      }
    }

    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        sendError(res, 415, 'bad_request', 'POST bodies must be application/json')
        return
      }
      let body: unknown
      try {
        body = await readJson(req)
      } catch (error) {
        sendError(res, 400, 'bad_request', (error as Error).message)
        return
      }
      if (path === '/api/reply') {
        if (!isReplyRequest(body)) {
          sendError(res, 400, 'bad_request', 'expected { id, reply: { type: "text", text } | { type: "option", indexes } }')
          return
        }
        const result = await deps.reply(body)
        sendJson(res, statusFor(result), result)
        return
      }
      if (path === '/api/read') {
        if (!isIdRequest(body)) {
          sendError(res, 400, 'bad_request', 'expected { id }')
          return
        }
        const result = await deps.read(body)
        sendJson(res, statusFor(result), result)
        return
      }
      if (path === '/api/open') {
        if (!isIdRequest(body)) {
          sendError(res, 400, 'bad_request', 'expected { id }')
          return
        }
        const result = await deps.open(body)
        sendJson(res, statusFor(result), result)
        return
      }
      if (path === '/api/dismiss') {
        if (!isDismissRequest(body)) {
          sendError(res, 400, 'bad_request', 'expected { id } or { allFinished: true }')
          return
        }
        const result = await deps.dismiss(body)
        sendJson(res, statusFor(result), result)
        return
      }
      if (path === '/api/suggest') {
        if (!isIdRequest(body)) {
          sendError(res, 400, 'bad_request', 'expected { id }')
          return
        }
        const result = await deps.suggest(body)
        sendJson(res, statusFor(result), result)
        return
      }
    }

    sendError(res, 404, 'not_found', `${req.method} ${path} is not served`)
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      deps.log(`request failed: ${error.message}`)
      if (!res.headersSent) {
        sendError(res, 500, 'cli_failed', error.message)
      } else {
        res.end()
      }
    })
  })

  const pingTimer = setInterval(() => {
    for (const res of streams) {
      res.write(': ping\n\n')
    }
  }, STREAM_PING_MS)

  return new Promise((resolve, reject) => {
    let attempts = 0
    // Why: a reaped worker gets 2 s to exit, so the next generation can find
    // the port still held for a moment.
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && attempts < 20) {
        attempts += 1
        setTimeout(() => server.listen(deps.port, '127.0.0.1'), 250)
        return
      }
      clearInterval(pingTimer)
      reject(error)
    })
    server.listen(deps.port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${deps.port}/`,
        broadcast(snapshot) {
          lastSnapshot = snapshot
          for (const res of streams) {
            writeFeedEvent(res, snapshot)
          }
        },
        close() {
          clearInterval(pingTimer)
          for (const res of streams) {
            res.end()
          }
          return new Promise((done) => server.close(() => done()))
        }
      })
    })
  })
}
