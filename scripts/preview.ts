// Serves src/page.html against fixture data, with fake actions, so the page can
// be checked without live agents. Usage: npm run preview [port]
// Suggest replies answers with canned proposals after a short wait.
// Replies to `done-reject` fail like a refused pane and show up under failed replies; other replies succeed and
// the item leaves the feed a moment later, as if the agent started working.
import { readFileSync } from 'node:fs'
import type { ActionResponse, FeedItem, ReplyFailure } from '../src/contract.ts'
import { snapshotOf } from '../src/feed.ts'
import { startServer } from '../src/server.ts'
import { fixtureItems } from '../test/page-fixtures.ts'

const port = Number(process.argv[2] ?? 47824)
let items: FeedItem[] = fixtureItems()
const ok: ActionResponse = { ok: true }
let failures: ReplyFailure[] = []

const server = await startServer({
  port,
  page: readFileSync(new URL('../src/page.html', import.meta.url), 'utf8'),
  getFeed: async () => snapshotOf(items),
  async reply(request) {
    console.log('reply', JSON.stringify(request))
    if (request.id === 'done-reject') {
      const error = { code: 'terminal_rejected' as const, message: 'the pane has unsent text in its composer: "wip"' }
      failures = [{
        id: `f${failures.length}`, at: Date.now(), itemId: request.id, agent: 'claude', kind: 'finished', where: 'ops / half-typed composer',
        reply: request.reply, ...error, keysSent: [],
        screen: ['⏺ Done. Replies to this item fail in the preview.', '─'.repeat(40), '❯ wip', '─'.repeat(40), '  ⏸ manual mode on · ← for agents'],
        draft: 'wip'
      }, ...failures]
      return { ok: false, error }
    }
    setTimeout(() => change(() => (items = items.filter((i) => i.id !== request.id))), 800)
    return ok
  },
  async open(request) {
    console.log('open', request.id)
    change(() => (items = items.map((i) => (i.id === request.id ? { ...i, unread: false } : i))))
    return ok
  },
  async read(request) {
    change(() => (items = items.map((i) => (i.id === request.id ? { ...i, unread: false } : i))))
    return ok
  },
  async dismiss(request) {
    change(() => (items = items.filter((i) => ('id' in request ? i.id !== request.id : i.kind !== 'finished'))))
    return ok
  },
  async suggest(request) {
    console.log('suggest', request.id)
    // Why the delay: shows the loading state the real Haiku call has (~8 s).
    await new Promise((done) => setTimeout(done, 1500))
    return { ok: true, proposals: ['Run the contract tests again', 'Open the PR for review', 'Explain the T0 changes'] }
  },
  failures: async () => ({ ok: true, failures }),
  async clearFailures() {
    failures = []
    return ok
  },
  health: () => ({ pid: process.pid, startedAt: Date.now(), lastHeartbeatAt: null }),
  log: console.log
})

function change(update: () => void): void {
  update()
  server.broadcast(snapshotOf(items))
}

console.log(`preview on ${server.url}`)
