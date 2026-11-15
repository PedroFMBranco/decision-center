import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemFromSession, snapshotOf, type SessionContext } from '../src/feed.ts'
import type { FeedItem } from '../src/contract.ts'
import type { Session } from '../src/session.ts'
import { permissionAsk, questionAsk, session } from './fixtures.ts'

const item = (s: Session, context: Partial<SessionContext> = {}) => itemFromSession(s, { pending: s.pending, ...context })
const items = (sessions: Session[]): FeedItem[] => snapshotOf(sessions.flatMap((s) => item(s) ?? [])).items

const colour = { title: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ index: 1, label: 'Red' }] }

test('a finished turn, a permission ask and a question are items; a working or idle session is not', () => {
  const kinds = items([
    session({ id: 'claude:a', pending: permissionAsk('rm -rf build', 3000) }),
    session({ id: 'claude:b', pending: questionAsk(colour, 2000), turn: 'working' }),
    session({ id: 'claude:c' }),
    session({ id: 'claude:d', turn: 'working' }),
    session({ id: 'claude:e', turn: 'idle' })
  ]).map((i) => [i.id, i.kind, i.state])
  assert.deepEqual(kinds, [
    ['claude:a', 'permission', 'waiting'],
    ['claude:b', 'question', 'waiting'],
    ['claude:c', 'finished', 'done']
  ])
})

test('an ask dates from when it was asked, a finished turn from when the turn ended', () => {
  assert.equal(item(session({ pending: permissionAsk('ls', 4321) }))?.since, 4321)
  assert.equal(item(session({ turnSince: 1234 }))?.since, 1234)
  assert.deepEqual(item(session({ pending: permissionAsk('ls', 1) }))?.permission, { toolName: 'Bash', summary: 'ls' })
})

test('a Codex session done with its turn and a pending transcript question is a question', () => {
  const codex = session({ id: 'codex:x', agent: 'codex', pane: null })
  const asked = item(codex, { codexQuestion: colour })
  assert.deepEqual([asked?.kind, asked?.state, asked?.question], ['question', 'done', colour])
})

test('project is the last folder of cwd; terminal names the tmux pane, or null outside tmux', () => {
  const inside = item(session({ cwd: '/code/billing-api/' }))
  assert.deepEqual([inside?.project, inside?.cwd, inside?.terminal], ['billing-api', '/code/billing-api/', { kind: 'tmux', pane: '%1' }])
  assert.equal(item(session({ pane: null }))?.terminal, null)
})

test('title is the first line of the last prompt', () => {
  assert.equal(item(session())?.title, 'fix the login bug')
  assert.equal(item(session({ prompt: null }))?.title, 'Untitled session')
})

test('waiting items sort before finished ones, newest first within a group', () => {
  const ids = items([
    session({ id: 'claude:old-done', turnSince: 1 }),
    session({ id: 'claude:new-done', turnSince: 3 }),
    session({ id: 'claude:question', pending: questionAsk(colour, 2) })
  ]).map((i) => i.id)
  assert.deepEqual(ids, ['claude:question', 'claude:new-done', 'claude:old-done'])
})

test('finished turns get parsed proposals, or can ask for suggestions', () => {
  const [parsed, none, empty, question] = [
    item(session({ lastMessage: 'Done.\nNext: open the PR' })),
    item(session({ lastMessage: 'Done.' })),
    item(session({ lastMessage: '' })),
    item(session({ lastMessage: 'Next: pick one', pending: questionAsk(colour, 5) }))
  ]
  assert.deepEqual([parsed?.proposals, parsed?.canSuggest], [['open the PR'], false])
  assert.deepEqual([none?.proposals, none?.canSuggest], [[], true])
  assert.deepEqual([empty?.proposals, empty?.canSuggest], [[], false])
  assert.deepEqual([question?.proposals, question?.canSuggest], [[], false])
})

test('a closing Replies: line becomes proposals and never shows in the message', () => {
  const lastMessage = 'Done.\nReplies: "Open the PR" | "Run the tests"'
  const [finished, question] = [item(session({ lastMessage })), item(session({ lastMessage, pending: questionAsk(colour, 5) }))]
  assert.deepEqual([finished?.lastMessage, finished?.proposals, finished?.canSuggest], ['Done.', ['Open the PR', 'Run the tests'], false])
  assert.deepEqual([question?.kind, question?.lastMessage, question?.proposals], ['question', 'Done.', []])
})
