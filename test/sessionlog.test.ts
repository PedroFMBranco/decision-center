import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toEvent, type HookEvent } from '../src/events.ts'
import { reduce, type Session } from '../src/session.ts'
import { SessionLog, viewSessions } from '../src/sessionlog.ts'
import { CLAUDE } from './captured.ts'

const line = (i: number, at = i * 1000) => `${JSON.stringify(toEvent('claude', CLAUDE[i]!.body, { env: CLAUDE[i]!.env, ppid: CLAUDE[i]!.ppid, now: at }))}\n`

function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dc-log-'))
  return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('tails each session file by offset, skipping bad lines and waiting for a half-written one', () =>
  withDir(async (dir) => {
    const file = join(dir, 'claude-02b924eb.jsonl')
    writeFileSync(file, line(4) + 'not json\n' + line(5) + line(6).slice(0, 40))
    const log = new SessionLog(dir)
    const [first] = await log.refresh()
    assert.deepEqual([first?.turn, first?.pending], ['working', null])
    appendFileSync(file, line(6).slice(40) + line(7))
    const [asked] = await log.refresh()
    assert.equal(asked?.pending?.kind, 'permission')
    assert.deepEqual((await log.refresh()).map((session) => session.pending?.kind), ['permission'])
  }))

test('a file that shrank is read again from the start, and a deleted one is forgotten', () =>
  withDir(async (dir) => {
    const file = join(dir, 'claude-02b924eb.jsonl')
    writeFileSync(file, line(4) + line(5) + line(6) + line(7))
    const log = new SessionLog(dir)
    assert.equal((await log.refresh())[0]?.pending?.kind, 'permission')
    writeFileSync(file, line(4))
    assert.deepEqual((await log.refresh()).map((session) => session.turn), ['idle'])
    rmSync(file)
    assert.deepEqual(await log.refresh(), [])
  }))

test('prune deletes session files with no event for a week', () =>
  withDir(async (dir) => {
    const old = join(dir, 'claude-old.jsonl')
    const recent = join(dir, 'claude-new.jsonl')
    writeFileSync(old, line(0))
    writeFileSync(recent, line(0))
    const now = Date.now()
    utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000))
    await new SessionLog(dir).prune(now, 7 * 86_400_000)
    assert.deepEqual([existsSync(old), existsSync(recent)], [false, true])
  }))

function session(id: string, overrides: Partial<Session> = {}): Session {
  const event: HookEvent = { v: 1, at: 1, agent: 'claude', event: 'SessionStart', sessionId: id, cwd: '/c', transcriptPath: null, pane: { socket: '/s', id: '%0' }, pid: 10, actor: null }
  return { ...reduce(undefined, event), ...overrides }
}

test('a newer session in the same pane replaces the older one, which leaves without a closed item (fact 3)', () => {
  const old = session('old', { ended: true, updatedAt: 5 })
  const next = session('new', { updatedAt: 6 })
  const elsewhere = session('other', { pane: { socket: '/s', id: '%1' } })
  const view = viewSessions([old, next, elsewhere], () => true)
  assert.deepEqual(view.live.map((s) => s.id), ['claude:new', 'claude:other'])
  assert.deepEqual([...view.replaced], ['claude:old'])
})

test('an ended or dead session with no successor is not live and not replaced', () => {
  const exited = session('exited', { ended: true })
  const crashed = session('crashed', { pane: { socket: '/s', id: '%2' }, pid: 99 })
  const outside = session('outside', { pane: null })
  const view = viewSessions([exited, crashed, outside], (s) => s.pid !== 99)
  assert.deepEqual(view.live.map((s) => s.id), ['claude:outside'])
  assert.deepEqual([...view.replaced], [])
})

test('a child agent that ran and ended in the same pane leaves the parent session live', () => {
  const parent = session('parent', { updatedAt: 5 })
  const child = session('child', { pid: 11, ended: true, updatedAt: 9 })
  const view = viewSessions([parent, child], () => true)
  assert.deepEqual(view.live.map((s) => s.id), ['claude:parent'])
  assert.deepEqual([...view.replaced], [])
})
