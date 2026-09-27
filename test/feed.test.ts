import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemFromAgent, snapshotOf, type PaneContext } from '../src/feed.ts'
import type { PsAgent } from '../src/cli.ts'
import { agent, worktree } from './fixtures.ts'
import type { FeedItem } from '../src/contract.ts'

function items(agents: PsAgent[], contexts: Record<string, PaneContext> = {}): FeedItem[] {
  const wt = worktree(agents)
  return snapshotOf(agents.flatMap((a) => itemFromAgent(wt, a, contexts[a.paneKey]) ?? [])).items
}

const askPrompt = JSON.stringify({
  questions: [
    {
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }]
    }
  ]
})

test('keeps waiting, blocked and done top-level Claude/Codex panes only', () => {
  const kinds = items([
    agent({ paneKey: 'a', state: 'waiting' }),
    agent({ paneKey: 'b', state: 'blocked', agentType: 'codex' }),
    agent({ paneKey: 'c', state: 'done' }),
    agent({ paneKey: 'd', state: 'working' }),
    agent({ paneKey: 'e', state: 'done', agentType: 'opencode' }),
    agent({ paneKey: 'f', state: 'done', parentPaneKey: 'coordinator' })
  ]).map((item) => [item.id, item.kind])
  assert.deepEqual(kinds, [
    ['a', 'permission'],
    ['b', 'permission'],
    ['c', 'finished']
  ])
})

test('a waiting pane with question options in the hook file is a question', () => {
  const [item] = items([agent({ state: 'waiting' })], {
    'tab:leaf': { entry: { paneKey: 'tab:leaf', payload: { state: 'waiting', interactivePrompt: askPrompt } } }
  })
  assert.equal(item?.kind, 'question')
  assert.deepEqual(item?.question, {
    title: 'Which color?',
    header: 'Color',
    multiSelect: false,
    options: [
      { index: 1, label: 'Red', description: 'warm' },
      { index: 2, label: 'Blue' }
    ]
  })
})

test('a picker with several questions keeps the rest of them in order under `more`', () => {
  const twoParts = JSON.stringify({
    questions: [
      { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olive' }] },
      { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small' }] }
    ]
  })
  const [item] = items([agent({ state: 'waiting' })], {
    'tab:leaf': { entry: { paneKey: 'tab:leaf', payload: { state: 'waiting', interactivePrompt: twoParts } } }
  })
  assert.equal(item?.question?.title, 'Which toppings?')
  assert.equal(item?.question?.multiSelect, true)
  assert.deepEqual(item?.question?.more, [
    { title: 'Which size?', header: 'Size', multiSelect: false, options: [{ index: 1, label: 'Small' }] }
  ])
})

test('a waiting pane with an approval in the hook file is a permission ask', () => {
  const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'runs `rm -rf build`' } })
  const [item] = items([agent({ state: 'waiting' })], {
    'tab:leaf': { entry: { paneKey: 'tab:leaf', payload: { state: 'waiting', interactivePrompt: approval } } }
  })
  assert.equal(item?.kind, 'permission')
  assert.deepEqual(item?.permission, { toolName: 'Bash', summary: 'runs `rm -rf build`' })
})

test('a stale hook entry for another state is ignored', () => {
  const [item] = items([agent({ state: 'waiting', toolName: 'Bash', toolInput: 'ls' })], {
    'tab:leaf': { entry: { paneKey: 'tab:leaf', payload: { state: 'done', interactivePrompt: askPrompt } } }
  })
  assert.deepEqual([item?.kind, item?.permission], ['permission', { toolName: 'Bash', summary: 'ls' }])
})

test('a waiting AskUserQuestion without options is a title-only question', () => {
  const [item] = items([agent({ state: 'waiting', toolName: 'AskUserQuestion', lastAssistantMessage: 'Which one?' })])
  assert.deepEqual(item?.question, { title: 'Which one?', multiSelect: false, options: [] })
})

test('a done Codex pane with a pending transcript question is a question', () => {
  const question = { title: 'Pick', multiSelect: false, options: [{ index: 1, label: 'A' }] }
  const [item] = items([agent({ agentType: 'codex' })], { 'tab:leaf': { codexQuestion: question } })
  assert.deepEqual([item?.kind, item?.state, item?.question], ['question', 'done', question])
})

test('waiting items sort before finished ones, newest first within a group', () => {
  const ids = items([
    agent({ paneKey: 'old-done', stateStartedAt: 1 }),
    agent({ paneKey: 'new-done', stateStartedAt: 3 }),
    agent({ paneKey: 'question', state: 'waiting', stateStartedAt: 2 })
  ]).map((item) => item.id)
  assert.deepEqual(ids, ['question', 'new-done', 'old-done'])
})

test('title falls back from task title to display name to the first prompt line', () => {
  const [a, b, c] = items([
    agent({ paneKey: 'a', taskTitle: 'Task', stateStartedAt: 3 }),
    agent({ paneKey: 'b', displayName: 'Pane', stateStartedAt: 2 }),
    agent({ paneKey: 'c', stateStartedAt: 1 })
  ])
  assert.equal(a?.title, 'Task')
  assert.equal(b?.title, 'Pane')
  assert.equal(c?.title, 'fix the login bug')
  assert.equal(c?.worktreeName, 'app')
})

test('finished turns get parsed proposals, or can ask for suggestions', () => {
  const [parsed, none, empty, question] = items([
    agent({ paneKey: 'a', lastAssistantMessage: 'Done.\nNext: open the PR', stateStartedAt: 4 }),
    agent({ paneKey: 'b', lastAssistantMessage: 'Done.', stateStartedAt: 3 }),
    agent({ paneKey: 'c', lastAssistantMessage: '', stateStartedAt: 2 }),
    agent({ paneKey: 'd', state: 'waiting', toolName: 'AskUserQuestion', lastAssistantMessage: 'Next: pick one' })
  ]).sort((x, y) => x.id.localeCompare(y.id))
  assert.deepEqual([parsed?.proposals, parsed?.canSuggest], [['open the PR'], false])
  assert.deepEqual([none?.proposals, none?.canSuggest], [[], true])
  assert.deepEqual([empty?.proposals, empty?.canSuggest], [[], false])
  assert.deepEqual([question?.proposals, question?.canSuggest], [[], false])
})
