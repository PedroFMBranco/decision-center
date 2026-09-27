import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PsAgent } from '../src/cli.ts'
import { FeedStore, type StoredFlags } from '../src/store.ts'
import { agent, worktree } from './fixtures.ts'

const HOUR = 60 * 60 * 1000
const NOW = 100 * 24 * HOUR

/** A store over a fake Orca: set `panes` and `now`, then refresh. */
function harness(stored: StoredFlags | null = { v: 1, installedAt: 0, panes: {} }) {
  const world = { panes: [] as PsAgent[], now: NOW, stored: stored as StoredFlags | null, saves: 0 }
  const make = () =>
    new FeedStore({
      worktreePs: async () => [worktree(world.panes)],
      readLastStatus: async () => new Map(),
      codexQuestion: async () => null,
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

const ids = (snapshot: { items: { id: string; kind: string; unread: boolean }[] }) =>
  snapshot.items.map((item) => `${item.id}:${item.kind}${item.unread ? '*' : ''}`)

test('new items are unread; reading one clears it from the badge', async () => {
  const { world, store } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW })]
  assert.equal((await store.refresh()).unreadCount, 1)
  assert.deepEqual(await store.read('a'), { ok: true })
  assert.deepEqual(ids(store.snapshot()), ['a:finished'])
  assert.equal(store.snapshot().unreadCount, 0)
})

test('an item clears while working and comes back unread on its next state', async () => {
  const { world, store } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW })]
  await store.refresh()
  await store.read('a')
  world.panes = [agent({ paneKey: 'a', state: 'working', stateStartedAt: NOW + 1 })]
  assert.deepEqual(ids(await store.refresh()), [])
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW + 2 })]
  assert.deepEqual(ids(await store.refresh()), ['a:finished*'])
})

test('a dismissed item stays hidden until the next episode', async () => {
  const { world, store } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW })]
  await store.refresh()
  await store.dismiss({ id: 'a' })
  assert.deepEqual(ids(await store.refresh()), [])
  world.panes = [agent({ paneKey: 'a', state: 'waiting', stateStartedAt: NOW + 5 })]
  assert.deepEqual(ids(await store.refresh()), ['a:permission*'])
})

test('a pane that disappears becomes a closed item until dismissed, and not after a restart', async () => {
  const { world, store, restart } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW }), agent({ paneKey: 'b', state: 'working' })]
  await store.refresh()
  await store.read('a')
  world.panes = []
  const closed = await store.refresh()
  assert.deepEqual(ids(closed), ['a:closed'])
  assert.equal(closed.items[0]?.state, 'closed')
  assert.equal(closed.items[0]?.lastMessage, 'Fixed.')
  assert.deepEqual(ids(await restart().refresh()), [])
  await store.dismiss({ id: 'a' })
  assert.deepEqual(ids(await store.refresh()), [])
})

test('read and dismissed flags survive a restart', async () => {
  const { world, store, restart } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW, updatedAt: NOW }), agent({ paneKey: 'b', stateStartedAt: NOW - 1 })]
  await store.refresh()
  await store.read('a')
  await store.dismiss({ id: 'b' })
  assert.deepEqual(ids(await restart().refresh()), ['a:finished'])
})

test('dismiss all finished leaves questions and permission asks', async () => {
  const { world, store } = harness()
  world.panes = [
    agent({ paneKey: 'a', stateStartedAt: NOW }),
    agent({ paneKey: 'b', stateStartedAt: NOW }),
    agent({ paneKey: 'c', state: 'blocked', stateStartedAt: NOW })
  ]
  await store.refresh()
  await store.dismiss({ allFinished: true })
  assert.deepEqual(ids(store.snapshot()), ['c:permission*'])
})

test('on first install, items older than 24h start out dismissed', async () => {
  const { world, store } = harness(null)
  world.panes = [agent({ paneKey: 'old', stateStartedAt: NOW - 25 * HOUR }), agent({ paneKey: 'new', stateStartedAt: NOW - HOUR })]
  assert.deepEqual(ids(await store.refresh()), ['new:finished*'])
  assert.equal(world.stored?.installedAt, NOW)
  world.panes.push(agent({ paneKey: 'later', stateStartedAt: NOW - 30 * HOUR }))
  assert.deepEqual(ids(await store.refresh()), ['new:finished*', 'later:finished*'])
})

test('unknown ids are not_found; unchanged flags are not rewritten', async () => {
  const { world, store } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW })]
  await store.refresh()
  const saves = world.saves
  await store.refresh()
  assert.equal(world.saves, saves)
  assert.equal((await store.read('zzz')).ok, false)
  assert.equal((await store.dismiss({ id: 'zzz' })).ok, false)
})

test('flags of panes gone for a week are forgotten', async () => {
  const { world, store } = harness()
  world.panes = [agent({ paneKey: 'a', stateStartedAt: NOW })]
  await store.refresh()
  await store.dismiss({ id: 'a' })
  world.panes = []
  world.now = NOW + 8 * 24 * HOUR
  await store.refresh()
  await store.dismiss({ id: 'a' })
  await store.refresh()
  assert.deepEqual(Object.keys(world.stored?.panes ?? {}), [])
})
