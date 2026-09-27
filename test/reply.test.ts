import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedItem, FeedQuestion, ReplyRequest } from '../src/contract.ts'
import { OrcaCliError } from '../src/cli.ts'
import { claudeQuestionCount, pickerRows, ReplySender } from '../src/reply.ts'

// Screens captured from real panes with `orca terminal read --screen`
// (Claude Code 2.1.283, Codex 0.155.1).
const CLAUDE_IDLE = ['────', '❯', '────', '  ⏸ manual mode on · ← for agents']
const CLAUDE_SINGLE = [
  '❯ Use the AskUserQuestion tool to ask me which color I prefer.',
  '────',
  ' ☐ Color',
  'Which color do you prefer?',
  '❯ 1. Red',
  '     A warm, energetic color',
  '  2. Green',
  '     A cool, natural color',
  '  3. Blue',
  '     A calm, stable color',
  '  4. Type something.',
  '────',
  '  5. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
]
const CLAUDE_MULTI = [
  '←  ☐ Toppings  ✔ Submit  →',
  'Which pizza toppings do you want?',
  '❯ 1. [ ] Mushroom',
  '         Earthy and savory',
  '  2. [ ] Olive',
  '  3. [ ] Ham',
  '  4. [ ] Type something',
  '     Submit',
  '────',
  '  5. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
]
const CLAUDE_REVIEW = [
  '←  ☒ Toppings  ✔ Submit  →',
  'Review your answers',
  ' ● Which pizza toppings do you want?',
  '   → Mushroom, Ham',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel'
]
const CODEX_QUEUED = [
  '• Which season do you prefer?',
  '  - Spring',
  '  done 9:16 PM',
  '• Queued follow-up inputs',
  '  ? 1 question',
  '    ⌥ + ↑ to answer',
  '› Ask Codex to do anything'
]
const CODEX_PICKER = [
  '• Queued follow-up inputs',
  '  Which season do you prefer?',
  '  › 1. Spring',
  '    2. Summer',
  '    3. Autumn',
  '    4. Other',
  '  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt'
]

function question(labels: string[], multiSelect = false): FeedQuestion {
  return { title: 'Q?', multiSelect, options: labels.map((label, i) => ({ index: i + 1, label })) }
}

function item(overrides: Partial<FeedItem>): FeedItem {
  return {
    id: 'tab:leaf',
    agent: 'claude',
    kind: 'finished',
    state: 'done',
    worktreeId: 'w',
    worktreeName: 'w',
    title: 't',
    prompt: null,
    lastMessage: null,
    question: null,
    permission: null,
    proposals: [],
    canSuggest: false,
    since: 0,
    updatedAt: 0,
    unread: true,
    ...overrides
  }
}

/** A sender over a fake pane: `screens` are shown in turn, the last one sticks. */
function harness(screens: string[][], options: { draft?: string; failFirstSend?: string } = {}) {
  const sent: string[] = []
  let shown = 0
  let failNext = options.failFirstSend
  const sender = new ReplySender({
    terminalFor: async (paneKey) => (paneKey === 'tab:leaf' ? { handle: 'h' } : undefined),
    screen: async () => ({ lines: screens[Math.min(shown++, screens.length - 1)]!, draft: options.draft ?? null }),
    send: async (_handle, input) => {
      if (failNext) {
        const code = failNext
        failNext = undefined
        throw new OrcaCliError('blocked', code)
      }
      sent.push(`${JSON.stringify(input.text ?? '')}${input.enter ? '+enter' : ''}`)
    },
    sleep: async () => undefined
  })
  return { sender, sent }
}

const text = (value: string): ReplyRequest => ({ id: 'tab:leaf', reply: { type: 'text', text: value } })
const pick = (...indexes: number[]): ReplyRequest => ({ id: 'tab:leaf', reply: { type: 'option', indexes } })
const code = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? 'ok' : result.error!.code)

test('reads picker rows upward from the footer, ignoring earlier numbered lists', () => {
  const lines = ['1. an old list item', '2. another', ...CLAUDE_SINGLE]
  assert.deepEqual(
    pickerRows(lines, lines.length - 1).map((row) => `${row.index}:${row.label}`),
    ['1:Red', '2:Green', '3:Blue', '4:Type something.', '5:Chat about this']
  )
  assert.deepEqual(pickerRows(CLAUDE_MULTI, CLAUDE_MULTI.length - 1)[0], { index: 1, label: 'Mushroom' })
})

test('counts the questions in a Claude picker from its tab header', () => {
  assert.equal(claudeQuestionCount(CLAUDE_SINGLE), 1)
  assert.equal(claudeQuestionCount(CLAUDE_MULTI), 1)
  assert.equal(claudeQuestionCount(['←  ☐ Color  ☐ Size  ✔ Submit  →', ...CLAUDE_SINGLE.slice(3)]), 2)
})

test('a finished turn gets free text as one text+Enter send', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE])
  assert.equal(code(await sender.send(item({}), text('line one\nline two'))), 'ok')
  assert.deepEqual(sent, ['"line one\\nline two"+enter'])
})

test('free text never merges with text you half-typed in the pane', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE], { draft: 'half typed' })
  const result = await sender.send(item({}), text('hi'))
  assert.equal(code(result), 'terminal_rejected')
  assert.match(!result.ok ? result.error.message : '', /half typed/)
  assert.deepEqual(sent, [])
})

test('a blocked text+Enter is retried as two sends', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE], { failFirstSend: 'agent_prompt_blocked' })
  assert.equal(code(await sender.send(item({}), text('hi'))), 'ok')
  assert.deepEqual(sent, ['"hi"', '""+enter'])
})

test('a Claude option is one bare digit', async () => {
  const { sender, sent } = harness([CLAUDE_SINGLE])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Red', 'Green', 'Blue']) })
  assert.equal(code(await sender.send(claude, pick(2))), 'ok')
  assert.deepEqual(sent, ['"2"'])
})

test('refuses an option whose row on screen is a different answer', async () => {
  const { sender, sent } = harness([CLAUDE_SINGLE])
  const stale = item({ kind: 'question', state: 'waiting', question: question(['Small', 'Large']) })
  assert.equal(code(await sender.send(stale, pick(2))), 'terminal_rejected')
  assert.deepEqual(sent, [])
})

test('refuses when the question is no longer open in the pane', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Red']) })
  assert.equal(code(await sender.send(claude, pick(1))), 'terminal_rejected')
  assert.deepEqual(sent, [])
})

test('free text to a question whose picker is gone goes as a normal message', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Red']) })
  assert.equal(code(await sender.send(claude, text('Purple'))), 'ok')
  assert.deepEqual(sent, ['"Purple"+enter'])
})

test('free text to a Claude question goes through the "Type something" row, in three sends', async () => {
  const { sender, sent } = harness([CLAUDE_SINGLE])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Red', 'Green', 'Blue']) })
  assert.equal(code(await sender.send(claude, text('Purple\nplease'))), 'ok')
  assert.deepEqual(sent, ['"4"', '"Purple please"', '""+enter'])
})

test('a Claude multi-select ticks each digit, opens the review, and submits it', async () => {
  const { sender, sent } = harness([CLAUDE_MULTI, CLAUDE_REVIEW])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Mushroom', 'Olive', 'Ham'], true) })
  assert.equal(code(await sender.send(claude, pick(1, 3))), 'ok')
  assert.deepEqual(sent, ['"1"', '"3"', '"\\u001b[C"', '"1"'])
})

test('a single-select question refuses several options', async () => {
  const { sender } = harness([CLAUDE_SINGLE])
  const claude = item({ kind: 'question', state: 'waiting', question: question(['Red', 'Green']) })
  assert.equal(code(await sender.send(claude, pick(1, 2))), 'bad_request')
})

test('a Codex option opens the queued picker with Option+Up, then sends the digit', async () => {
  const { sender, sent } = harness([CODEX_QUEUED, CODEX_PICKER])
  const codex = item({ agent: 'codex', kind: 'question', question: question(['Spring', 'Summer', 'Autumn']) })
  assert.equal(code(await sender.send(codex, pick(3))), 'ok')
  assert.deepEqual(sent, ['"\\u001b[1;3A"', '"3"'])
})

test('a refused Codex option closes the picker it opened', async () => {
  const { sender, sent } = harness([CODEX_QUEUED, CODEX_PICKER])
  const codex = item({ agent: 'codex', kind: 'question', question: question(['Spring', 'Summer', 'Autumn']) })
  assert.equal(code(await sender.send(codex, pick(9))), 'terminal_rejected')
  assert.deepEqual(sent, ['"\\u001b[1;3A"', '"\\u001b[1;3B"'])
})

test('free text to a Codex question is a normal message', async () => {
  const { sender, sent } = harness([CODEX_QUEUED])
  const codex = item({ agent: 'codex', kind: 'question', question: question([]) })
  assert.equal(code(await sender.send(codex, text('Winter'))), 'ok')
  assert.deepEqual(sent, ['"Winter"+enter'])
})

test('permission asks, closed sessions and unknown items never get keys', async () => {
  const { sender, sent } = harness([CLAUDE_IDLE])
  const permission = item({ kind: 'permission', state: 'blocked', permission: { toolName: 'Bash', summary: 'rm' } })
  assert.equal(code(await sender.send(permission, pick(1))), 'bad_request')
  assert.equal(code(await sender.send(item({ kind: 'closed', state: 'closed' }), text('hi'))), 'session_closed')
  assert.equal(code(await sender.send(item({ id: 'gone:pane' }), text('hi'))), 'session_closed')
  assert.equal(code(await sender.send(undefined, text('hi'))), 'not_found')
  assert.deepEqual(sent, [])
})
