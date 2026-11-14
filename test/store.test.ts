import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedQuestion } from '../src/contract.ts'
import type { Session } from '../src/session.ts'
import { FeedStore, type StoredFlags } from '../src/store.ts'
import { permissionAsk, session } from './fixtures.ts'

const HOUR = 60 * 60 * 1000
const NOW = 100 * 24 * HOUR

const CLAUDE_ASK = ['╭───', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend']
const CLAUDE_COMPOSER = ['─'.repeat(20), '❯\xa0', '─'.repeat(20), '  ? for shortcuts']

/** A store over fake sessions: set `sessions`, `screens` and `now`, then refresh. */
function harness(stored: StoredFlags | null = { v: 1, installedAt: 0, sessions: {} }) {
  const world = {
    sessions: [] as Session[],
    replaced: new Set<string>(),
    screen: CLAUDE_ASK as string[] | Error,
    screenReads: 0,
    codexQuestion: null as FeedQuestion | null,
    now: NOW,
    stored: stored as StoredFlags | null,
    saves: 0
  }
  const make = () =>
    new FeedStore({
      sessions: async () => ({ live: world.sessions, replaced: world.replaced }),
      screen: async () => {
        world.screenReads += 1
        if (world.screen instanceof Error) throw world.screen
        return { lines: world.screen, draft: null }
      },
      codexQuestion: async () => world.codexQuestion,
      loadFlags: async () => (world.stored ? structuredClone(world.stored) : null),
      saveFlags: async (flags) => {
        world.stored = structuredClone(flags)
        world.saves += 1
      },
      log: () => undefined,
      now: () => world.now
    })
  return { world, store: make(), restart: make }
}

const s = (id: string, overrides: Partial<Session> = {}) => session({ id: `claude:${id}`, turnSince: NOW, ...overrides })
const ids = (snapshot: { items: { id: string; kind: string; unread: boolean }[] }) =>
  snapshot.items.map((item) => `${item.id.slice(7)}:${item.kind}${item.unread ? '*' : ''}`)

test('new items are unread; reading one clears it from the badge', async () => {
  const { world, store } = harness()
  world.sessions = [s('a')]
  assert.equal((await store.refresh()).unreadCount, 1)
  assert.deepEqual(await store.read('claude:a'), { ok: true })
  assert.deepEqual(ids(store.snapshot()), ['a:finished'])
  assert.equal(store.snapshot().unreadCount, 0)
})

test('an item clears while working and comes back unread on its next turn', async () => {
  const { world, store } = harness()
  world.sessions = [s('a')]
  await store.refresh()
  await store.read('claude:a')
  world.sessions = [s('a', { turn: 'working', turnSince: NOW + 1 })]
  assert.deepEqual(ids(await store.refresh()), [])
  world.sessions = [s('a', { turnSince: NOW + 2 })]
  assert.deepEqual(ids(await store.refresh()), ['a:finished*'])
})

test('a dismissed item stays hidden until the next episode', async () => {
  const { world, store } = harness()
  world.sessions = [s('a')]
  await store.refresh()
  await store.dismiss({ id: 'claude:a' })
  assert.deepEqual(ids(await store.refresh()), [])
  world.sessions = [s('a', { pending: permissionAsk('ls', NOW + 5) })]
  assert.deepEqual(ids(await store.refresh()), ['a:permission*'])
})

test('a session that stops running becomes a closed item until dismissed, and not after a restart', async () => {
  const { world, store, restart } = harness()
  world.sessions = [s('a'), s('b', { turn: 'working' })]
  await store.refresh()
  await store.read('claude:a')
  world.sessions = []
  const closed = await store.refresh()
  assert.deepEqual(ids(closed), ['a:closed'])
  assert.deepEqual([closed.items[0]?.state, closed.items[0]?.terminal, closed.items[0]?.lastMessage], ['closed', null, 'Fixed.'])
  assert.deepEqual(ids(await restart().refresh()), [])
  await store.dismiss({ id: 'claude:a' })
  assert.deepEqual(ids(await store.refresh()), [])
})

test('a session replaced in its pane (/clear) leaves without a closed item', async () => {
  const { world, store } = harness()
  world.sessions = [s('old')]
  await store.refresh()
  world.sessions = [s('new', { turn: 'idle' })]
  world.replaced = new Set(['claude:old'])
  assert.deepEqual(ids(await store.refresh()), [])
})

test('read and dismissed flags survive a restart', async () => {
  const { world, store, restart } = harness()
  world.sessions = [s('a', { updatedAt: NOW }), s('b', { turnSince: NOW - 1 })]
  await store.refresh()
  await store.read('claude:a')
  await store.dismiss({ id: 'claude:b' })
  assert.deepEqual(ids(await restart().refresh()), ['a:finished'])
})

test('dismiss all finished leaves questions and permission asks', async () => {
  const { world, store } = harness()
  world.sessions = [s('a'), s('b'), s('c', { pending: permissionAsk('ls', NOW) })]
  await store.refresh()
  await store.dismiss({ allFinished: true })
  assert.deepEqual(ids(store.snapshot()), ['c:permission*'])
})

test('on first run, items older than 24h start out dismissed', async () => {
  const { world, store } = harness(null)
  world.sessions = [s('old', { turnSince: NOW - 25 * HOUR }), s('new', { turnSince: NOW - HOUR })]
  assert.deepEqual(ids(await store.refresh()), ['new:finished*'])
  assert.equal(world.stored?.installedAt, NOW)
  world.sessions.push(s('later', { turnSince: NOW - 30 * HOUR }))
  assert.deepEqual(ids(await store.refresh()), ['new:finished*', 'later:finished*'])
})

test('unknown ids are not_found; unchanged flags are not rewritten', async () => {
  const { world, store } = harness()
  world.sessions = [s('a')]
  await store.refresh()
  const saves = world.saves
  await store.refresh()
  assert.equal(world.saves, saves)
  assert.equal((await store.read('zzz')).ok, false)
  assert.equal((await store.dismiss({ id: 'zzz' })).ok, false)
})

test('flags of sessions gone for a week are forgotten', async () => {
  const { world, store } = harness()
  world.sessions = [s('a')]
  await store.refresh()
  await store.dismiss({ id: 'claude:a' })
  world.sessions = []
  world.now = NOW + 8 * 24 * HOUR
  await store.refresh()
  await store.dismiss({ id: 'claude:a' })
  await store.refresh()
  assert.deepEqual(Object.keys(world.stored?.sessions ?? {}), [])
})

test('an ask denied or cancelled in the pane without a hook becomes a finished item once the pane shows no prompt (fact 9)', async () => {
  const { world, store } = harness()
  world.sessions = [s('a', { turn: 'working', pending: permissionAsk('touch b.txt', NOW - 4000) })]
  assert.deepEqual(ids(await store.refresh()), ['a:permission*'])
  world.screen = CLAUDE_COMPOSER
  const cancelled = await store.refresh()
  assert.deepEqual(ids(cancelled), ['a:finished*'])
  assert.equal(cancelled.items[0]?.since, NOW - 4000)
  const sub = harness()
  sub.world.screen = CLAUDE_COMPOSER
  sub.world.sessions = [s('sub', { turn: 'working', pending: { ...permissionAsk('touch b.txt', NOW - 4000), actor: 'agent-1' } })]
  assert.deepEqual(ids(await sub.store.refresh()), [])
  world.sessions = [s('a', { pending: permissionAsk('touch b.txt', NOW - 4000) })]
  assert.deepEqual(ids(await store.refresh()), ['a:finished*'])
  world.screen = CLAUDE_ASK
  assert.deepEqual(ids(await store.refresh()), ['a:permission*'])
})

test('the screen check keeps the ask when it is new, outside tmux, or the screen is unreadable', async () => {
  const { world, store } = harness()
  world.screen = CLAUDE_COMPOSER
  world.sessions = [s('fresh', { pending: permissionAsk('ls', NOW - 1000) }), s('outside', { pane: null, pending: permissionAsk('ls', NOW - 9000) })]
  assert.deepEqual(ids(await store.refresh()), ['fresh:permission*', 'outside:permission*'])
  assert.equal(world.screenReads, 0)
  const copy = harness()
  copy.world.screen = new Error('pane in copy mode')
  copy.world.sessions = [s('copy', { pending: permissionAsk('ls', NOW - 9000) })]
  assert.deepEqual(ids(await copy.store.refresh()), ['copy:permission*'])
  assert.equal(copy.world.screenReads, 1)
})

test("a Codex session's transcript question shows once its turn is done", async () => {
  const { world, store } = harness()
  world.codexQuestion = { title: 'Pick', multiSelect: false, options: [{ index: 1, label: 'A' }] }
  world.sessions = [
    s('x', { id: 'codex:x', agent: 'codex', transcriptPath: '/t.jsonl' }),
    s('y', { id: 'codex:y', agent: 'codex', transcriptPath: '/t.jsonl', turn: 'working' })
  ]
  assert.deepEqual((await store.refresh()).items.map((i) => [i.id, i.kind, i.question?.title]), [['codex:x', 'question', 'Pick']])
})
