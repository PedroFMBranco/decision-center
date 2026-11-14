import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { bindCodex, listProcesses, processCwds, type Binding, type CodexProc } from '../src/binding.ts'
import { reduce, type Session } from '../src/session.ts'
import type { TmuxPane } from '../src/tmux.ts'

const pane = (n: number): TmuxPane => ({ socket: '/s', id: `%${n}`, tty: `/dev/ttys00${n}`, pid: 100 + n, inMode: false, dead: false })
const proc = (pid: number, tty: number | null, startedAt: number, cwd = '/code/app'): CodexProc => ({
  pid,
  tty: tty === null ? null : `/dev/ttys00${tty}`,
  startedAt,
  name: 'codex',
  cwd
})

function codexSession(id: string, startedAt: number, updatedAt = startedAt, agent: 'codex' | 'claude' = 'codex'): Session {
  const base = reduce(undefined, { v: 1, at: startedAt, agent, event: 'SessionStart', sessionId: id, cwd: '/code/app', transcriptPath: null, pane: null, pid: null, actor: null })
  return { ...base, updatedAt }
}

function bind(sessions: Session[], codex: CodexProc[], panes: TmuxPane[], previous = new Map<string, Binding>()) {
  const { bindings, dead } = bindCodex({ sessions, previous, codex, panes })
  return { at: Object.fromEntries([...bindings].map(([id, b]) => [id, `${b.pane.id}/${b.pid}`])), dead: [...dead] }
}

test('one codex process in the session folder, started before its first event, binds its pane', () => {
  assert.deepEqual(bind([codexSession('a', 5000)], [proc(7, 1, 1000)], [pane(1)]), { at: { 'codex:a': '%1/7' }, dead: [] })
})

test('several candidates: the one started latest before the first event binds; a tie stays unbound', () => {
  const two = [proc(7, 1, 1000), proc(8, 2, 2000)]
  assert.deepEqual(bind([codexSession('a', 5000)], two, [pane(1), pane(2)]).at, { 'codex:a': '%2/8' })
  const tie = [proc(7, 1, 2000), proc(8, 2, 2000)]
  assert.deepEqual(bind([codexSession('a', 5000)], tie, [pane(1), pane(2)]), { at: {}, dead: [] })
})

test('a process in another folder, started after the session, or without a terminal is not its process', () => {
  const others = [proc(7, 1, 1000, '/other'), proc(8, 2, 9000), proc(9, null, 1000)]
  assert.deepEqual(bind([codexSession('a', 5000)], others, [pane(1), pane(2)]), { at: {}, dead: ['codex:a'] })
})

test('a codex process outside tmux keeps its session alive and unbound', () => {
  assert.deepEqual(bind([codexSession('a', 5000)], [proc(7, 9, 1000)], [pane(1)]), { at: {}, dead: [] })
})

test('a pane held by a session active since this one started is not a candidate', () => {
  const holder = codexSession('a', 3000, 9000)
  const sessions = [holder, codexSession('b', 5000)]
  const previous = new Map([['codex:a', { pane: { socket: '/s', id: '%1' }, pid: 7 }]])
  assert.deepEqual(bind(sessions, [proc(7, 1, 1000)], [pane(1)], previous), { at: { 'codex:a': '%1/7' }, dead: [] })
  const claude = { ...codexSession('c', 3000, 9000, 'claude'), pane: { socket: '/s', id: '%1' } }
  assert.deepEqual(bind([claude, codexSession('b', 5000)], [proc(7, 1, 1000)], [pane(1)]).at, {})
})

test('Codex /new: a session idle since the new one started gives up its pane', () => {
  const old = codexSession('a', 3000, 4000)
  const previous = new Map([['codex:a', { pane: { socket: '/s', id: '%1' }, pid: 7 }]])
  assert.deepEqual(bind([old, codexSession('b', 5000)], [proc(7, 1, 1000)], [pane(1)], previous).at, {
    'codex:a': '%1/7',
    'codex:b': '%1/7'
  })
})

test('a binding holds while its process and pane live, and its session is dead once the process is gone', () => {
  const previous = new Map([['codex:a', { pane: { socket: '/s', id: '%1' }, pid: 7 }]])
  assert.deepEqual(bind([codexSession('a', 5000)], [proc(7, 1, 1000)], [pane(1)], previous).at, { 'codex:a': '%1/7' })
  assert.deepEqual(bind([codexSession('a', 5000)], [], [pane(1)], previous), { at: {}, dead: ['codex:a'] })
  assert.deepEqual(bind([codexSession('a', 5000)], [proc(7, 1, 1000)], [], previous), { at: {}, dead: [] })
})

test('listProcesses and processCwds read this process', async () => {
  const self = (await listProcesses()).find((p) => p.pid === process.pid)
  assert.ok(self && self.startedAt <= Date.now() && self.startedAt > Date.now() - 600_000)
  assert.equal((await processCwds([process.pid])).get(process.pid), realpathSync(process.cwd()))
})
