import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGE_CAP, PROMPT_CAP, SUMMARY_CAP, toEvent, type HookEvent } from '../src/events.ts'
import { reduce, type Session } from '../src/session.ts'
import { CLAUDE, CODEX, type Captured } from './captured.ts'

const eventOf = (agent: 'claude' | 'codex', row: Captured, at: number): HookEvent =>
  toEvent(agent, row.body, { env: row.env, ppid: row.ppid, now: at })!

/** Reduces captured rows in order, one second apart, and returns every session after row `upTo`. */
function replay(agent: 'claude' | 'codex', rows: Captured[], upTo = rows.length - 1): Map<string, Session> {
  const sessions = new Map<string, Session>()
  rows.slice(0, upTo + 1).forEach((row, i) => {
    const event = eventOf(agent, row, (i + 1) * 1000)
    sessions.set(`${agent}:${event.sessionId}`, reduce(sessions.get(`${agent}:${event.sessionId}`), event))
  })
  return sessions
}

const claude = (upTo: number, id: string) => replay('claude', CLAUDE, upTo).get(`claude:${id}`)!
const codex = (upTo: number, id: string) => replay('codex', CODEX, upTo).get(`codex:${id}`)!

test('a Claude event keeps the pane and agent pid from the hook env, and never the tool response', () => {
  const event = eventOf('claude', CLAUDE[11]!, 5)
  assert.deepEqual(event.pane, { socket: '/tmp/tmux-501/default', id: '%0' })
  assert.equal(event.pid, 23397)
  assert.equal(event.actor, null)
  assert.equal(event.tool?.summary, 'touch c.txt')
  assert.doesNotMatch(JSON.stringify(event), /secret output|tool_response/)
})

test('a Codex event ignores the hook env, which describes whichever session started the daemon', () => {
  const event = eventOf('codex', CODEX[11]!, 5)
  assert.deepEqual([event.pane, event.pid], [null, null])
})

test('caps the prompt, last message and summary, and drops oversized questions', () => {
  const big = (n: number) => 'x'.repeat(n)
  const env = { env: {}, ppid: 1, now: 0 }
  const body = { session_id: 's', cwd: '/c', hook_event_name: 'UserPromptSubmit', prompt: big(PROMPT_CAP + 10) }
  assert.equal(toEvent('claude', body, env)?.prompt?.length, PROMPT_CAP)
  const stop = { ...body, hook_event_name: 'Stop', last_assistant_message: big(MESSAGE_CAP + 10) }
  assert.equal(toEvent('claude', stop, env)?.lastMessage?.length, MESSAGE_CAP)
  const bash = { ...body, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: big(500) } }
  assert.equal(toEvent('claude', bash, env)?.tool?.summary.length, SUMMARY_CAP)
  const ask = { ...body, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: big(20_000) }] } }
  assert.equal(toEvent('claude', ask, env)?.tool?.questions, undefined)
  assert.equal(toEvent('claude', ask, env)?.pid, null)
})

test('refuses payloads that are not hook calls or whose session id is not a safe file name', () => {
  const env = { env: {}, ppid: 9, now: 0 }
  for (const payload of [null, 'text', {}, { hook_event_name: 'Stop' }, { session_id: '../../x', hook_event_name: 'Stop' }]) {
    assert.equal(toEvent('claude', payload, env), null)
  }
})

test('one tool call keeps its key across PreToolUse, PermissionRequest and PostToolUse', () => {
  const key = (agent: 'claude' | 'codex', row: Captured) => eventOf(agent, row, 0).tool?.key
  assert.equal(key('claude', CLAUDE[6]!), key('claude', CLAUDE[7]!))
  // Codex adds a description to the PermissionRequest input only.
  assert.equal(key('codex', CODEX[11]!), key('codex', CODEX[12]!))
  assert.equal(key('codex', CODEX[12]!), key('codex', CODEX[13]!))
  assert.notEqual(key('claude', CLAUDE[6]!), key('claude', CLAUDE[9]!))
})

test('a permission ask waits until the next prompt when it is denied without a hook (fact 9)', () => {
  const asked = claude(7, '02b924eb')
  assert.equal(asked.turn, 'working')
  assert.deepEqual(asked.pending && { kind: asked.pending.kind, summary: asked.pending.kind === 'permission' && asked.pending.permission.summary }, {
    kind: 'permission',
    summary: 'touch b.txt'
  })
  assert.equal(claude(8, '02b924eb').pending, null)
})

test('an allowed ask clears on its PostToolUse, and Stop finishes the turn with the last message', () => {
  assert.equal(claude(10, '02b924eb').pending?.kind, 'permission')
  assert.equal(claude(11, '02b924eb').pending, null)
  const done = claude(12, '02b924eb')
  assert.deepEqual([done.turn, done.turnSince], ['done', 13_000])
  assert.match(done.lastMessage ?? '', /^`touch c.txt` ran/)
  assert.equal(done.prompt, 'Run the bash command: touch c.txt')
})

test('a question asked in several parts is one episode from PreToolUse to PermissionRequest', () => {
  const asked = claude(16, '02b924eb')
  const confirmed = claude(17, '02b924eb')
  assert.equal(confirmed.pending?.kind, 'question')
  assert.equal(confirmed.pending?.at, asked.pending?.at)
  const question = confirmed.pending?.kind === 'question' ? confirmed.pending.question : null
  assert.equal(question?.title, 'Which colour?')
  assert.deepEqual(question?.more?.map((part) => [part.title, part.multiSelect]), [['Which seasons?', true]])
})

test('/clear ends the old session and starts a new one in the same pane (fact 3)', () => {
  assert.equal(claude(18, '02b924eb').ended, true)
  const next = claude(19, '5f9bd9e8')
  assert.deepEqual([next.ended, next.turn, next.pane?.id], [false, 'idle', '%0'])
})

test("a background subagent's ask after the main Stop shows without reopening the turn (fact 11)", () => {
  const stopped = claude(23, '5f9bd9e8')
  assert.equal(stopped.turn, 'done')
  const asking = claude(25, '5f9bd9e8')
  assert.deepEqual([asking.turn, asking.turnSince, asking.pending?.kind, asking.pending?.actor], [
    'done',
    stopped.turnSince,
    'permission',
    'aabea4b82f4c8eff4'
  ])
  const allowed = claude(26, '5f9bd9e8')
  assert.deepEqual([allowed.turn, allowed.pending], ['done', null])
  const notified = claude(29, '5f9bd9e8')
  assert.equal(notified.turn, 'working')
  assert.match(notified.prompt ?? '', /^Spawn one general-purpose subagent/)
  assert.equal(claude(30, '5f9bd9e8').turn, 'done')
  assert.equal(claude(31, '5f9bd9e8').ended, true)
})

test("Stop keeps a subagent's pending ask and drops the main agent's own", () => {
  const subagentAsk = claude(25, '5f9bd9e8')
  const stop = eventOf('claude', CLAUDE[23]!, 99_000)
  assert.equal(reduce(subagentAsk, stop).pending?.actor, 'aabea4b82f4c8eff4')
  const mainAsk = claude(7, '02b924eb')
  assert.equal(reduce(mainAsk, { ...stop, sessionId: '02b924eb' }).pending, null)
})

test('Codex SessionEnd while the TUI stays open changes nothing (fact 17)', () => {
  const done = codex(14, '01a1da71')
  assert.equal(done.turn, 'done')
  assert.deepEqual(codex(17, '01a1da71'), done)
})

test('a Codex approval clears on its PostToolUse despite the extra description', () => {
  const asked = codex(12, '01a1da71')
  assert.deepEqual(asked.pending?.kind === 'permission' && asked.pending.permission, {
    toolName: 'Bash',
    summary: 'touch ~/dc-probe-delete-me.txt'
  })
  assert.equal(codex(13, '01a1da71').pending, null)
  assert.equal(codex(12, '01a1da71').pane, null)
})

test('SessionStart on resume reopens an ended session and takes the new pane, pid and start time', () => {
  const ended = claude(3, '9f44937c')
  assert.equal(ended.ended, true)
  const resumed = reduce(ended, { ...eventOf('claude', CLAUDE[0]!, 50_000), source: 'resume', pane: { socket: '/s', id: '%7' } })
  assert.deepEqual([resumed.ended, resumed.pane?.id, resumed.turn], [false, '%7', 'done'])
  // Liveness compares the agent process's start with this, and a resumed session runs in a newer process.
  assert.deepEqual([resumed.startedAt, resumed.pid], [50_000, 21712])
})
