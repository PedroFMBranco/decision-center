import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { startServer, type DecisionCenterServer } from '../src/server.ts'
import { API_VERSION, type DismissRequest, type ReplyRequest } from '../src/contract.ts'

const PORT = 47899
const replies: ReplyRequest[] = []
const dismissals: DismissRequest[] = []
const opened: string[] = []
let server: DecisionCenterServer

before(async () => {
  server = await startServer({
    port: PORT,
    page: '<p>page</p>',
    getFeed: async () => ({ version: API_VERSION, items: [], unreadCount: 0, generatedAt: 0 }),
    reply: async (body) => {
      replies.push(body)
      return { ok: true }
    },
    open: async ({ id }) => {
      opened.push(id)
      return { ok: true }
    },
    read: async ({ id }) => (id === 'known' ? { ok: true } : { ok: false, error: { code: 'not_found', message: 'no' } }),
    dismiss: async (body) => {
      dismissals.push(body)
      return { ok: true }
    },
    failures: async () => ({ ok: true, failures: [] }),
    clearFailures: async () => ({ ok: true }),
    suggest: async ({ id }) =>
      id === 'known' ? { ok: true, proposals: ['Ship it'] } : { ok: false, error: { code: 'not_found', message: 'no' } },
    health: () => ({ pid: 1, startedAt: 0, lastHeartbeatAt: null }),
    log: () => undefined
  })
})

after(() => server.close())

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const json = { 'Content-Type': 'application/json' }
const textReply = JSON.stringify({ id: 'tab:leaf', reply: { type: 'text', text: 'hi' } })

test('serves the page and the feed', async () => {
  assert.equal((await call('GET', '/')).body, '<p>page</p>')
  assert.deepEqual(JSON.parse((await call('GET', '/api/feed')).body).items, [])
})

test('accepts a same-origin JSON reply', async () => {
  const res = await call('POST', '/api/reply', { ...json, Origin: `http://127.0.0.1:${PORT}` }, textReply)
  assert.equal(res.status, 200)
  assert.equal(replies.at(-1)?.id, 'tab:leaf')
})

test('refuses a reply from another origin', async () => {
  const res = await call('POST', '/api/reply', { ...json, Origin: 'https://evil.example' }, textReply)
  assert.equal(res.status, 403)
})

test('refuses a request addressed to another host name (DNS rebinding)', async () => {
  const res = await call('GET', '/api/feed', { Host: `evil.example:${PORT}` })
  assert.equal(res.status, 403)
})

test('refuses a non-JSON POST, which a cross-site form could send', async () => {
  const res = await call('POST', '/api/reply', { 'Content-Type': 'text/plain' }, textReply)
  assert.equal(res.status, 415)
})

test('rejects a malformed reply', async () => {
  const res = await call('POST', '/api/reply', json, JSON.stringify({ id: 'x', reply: { type: 'text', text: ' ' } }))
  assert.equal(res.status, 400)
})

test('accepts permission and several-answer replies, and rejects malformed ones', async () => {
  const post = (reply: unknown) => call('POST', '/api/reply', json, JSON.stringify({ id: 'tab:leaf', reply }))
  assert.equal((await post({ type: 'permission', allow: true })).status, 200)
  assert.equal((await post({ type: 'permission', allow: false, note: 'not now' })).status, 200)
  assert.equal((await post({ type: 'answers', answers: [[2], [1, 3]] })).status, 200)
  assert.equal((await post({ type: 'permission', allow: 'yes' })).status, 400)
  assert.equal((await post({ type: 'answers', answers: [[2], []] })).status, 400)
  assert.equal((await post({ type: 'shell', command: 'ls' })).status, 400)
})

test('lists failed replies and clears them', async () => {
  const list = await call('GET', '/api/failures', {}, undefined)
  assert.equal(list.status, 200)
  assert.equal((await call('POST', '/api/failures/clear', json, '{}')).status, 200)
})

test('marks an item read, and 404s an unknown one', async () => {
  assert.equal((await call('POST', '/api/read', json, JSON.stringify({ id: 'known' }))).status, 200)
  assert.equal((await call('POST', '/api/read', json, JSON.stringify({ id: 'gone' }))).status, 404)
  assert.equal((await call('POST', '/api/read', json, JSON.stringify({}))).status, 400)
})

test('dismisses one item or all finished ones', async () => {
  assert.equal((await call('POST', '/api/dismiss', json, JSON.stringify({ id: 'a' }))).status, 200)
  assert.equal((await call('POST', '/api/dismiss', json, JSON.stringify({ allFinished: true }))).status, 200)
  assert.equal((await call('POST', '/api/dismiss', json, JSON.stringify({ allFinished: 'yes' }))).status, 400)
  assert.deepEqual(dismissals, [{ id: 'a' }, { allFinished: true }])
})

test('opens the pane of an item', async () => {
  assert.equal((await call('POST', '/api/open', json, JSON.stringify({ id: 'tab:leaf' }))).status, 200)
  assert.equal((await call('POST', '/api/open', json, JSON.stringify({}))).status, 400)
  assert.deepEqual(opened, ['tab:leaf'])
})

test('suggests replies for an item, and 404s an unknown one', async () => {
  const res = await call('POST', '/api/suggest', json, JSON.stringify({ id: 'known' }))
  assert.deepEqual([res.status, JSON.parse(res.body)], [200, { ok: true, proposals: ['Ship it'] }])
  assert.equal((await call('POST', '/api/suggest', json, JSON.stringify({ id: 'gone' }))).status, 404)
  assert.equal((await call('POST', '/api/suggest', json, JSON.stringify({}))).status, 400)
})
