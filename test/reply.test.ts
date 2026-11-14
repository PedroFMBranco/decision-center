import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedItem, FeedQuestion, ReplyFailure, ReplyRequest } from '../src/contract.ts'
import { claudeQuestionCount, describeKey, pickerRows, ReplySender } from '../src/reply.ts'

// Screens captured from real panes (Claude Code 2.1.283, Codex 0.155.1). The
// plain lines match what `tmux capture-pane -p` gives today (issue 0029, fact 23).
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
    project: 'w',
    cwd: '/code/w',
    terminal: { kind: 'tmux', pane: '%1' },
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
function harness(screens: string[][], options: { draft?: string; onFailure?: (failure: ReplyFailure) => void } = {}) {
  const sent: string[] = []
  let shown = 0
  const sender = new ReplySender({
    terminalFor: async (id) => (id === 'tab:leaf' ? { handle: { socket: '/s', id: '%1' } } : undefined),
    screen: async () => ({ lines: screens[Math.min(shown++, screens.length - 1)]!, draft: options.draft ?? null }),
    send: async (_handle, input) => {
      sent.push(`${JSON.stringify(input.text ?? '')}${input.enter ? '+enter' : ''}`)
    },
    sleep: async () => undefined,
    onFailure: options.onFailure,
    now: () => 1000
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
  const permission = item({ kind: 'permission', state: 'waiting', permission: { toolName: 'Bash', summary: 'rm' } })
  assert.equal(code(await sender.send(permission, pick(1))), 'bad_request')
  assert.equal(code(await sender.send(item({ kind: 'closed', state: 'closed' }), text('hi'))), 'session_closed')
  assert.equal(code(await sender.send(item({ id: 'gone:pane' }), text('hi'))), 'session_closed')
  const outside = await sender.send(item({ terminal: null }), text('hi'))
  assert.deepEqual(outside.ok ? null : outside.error, { code: 'session_closed', message: 'this session is not running in tmux; reply in its terminal' })
  assert.equal(code(await sender.send(undefined, text('hi'))), 'not_found')
  assert.deepEqual(sent, [])
})

// Permission prompts and multi-question pickers, captured 2026-09-27 (issues 0021, 0022).
const RULE = '─'.repeat(40)
const CLAUDE_BASH_ASK = [
  '⏺ Bash(touch probe.txt)',
  '  ⎿  Waiting…',
  RULE,
  ' Bash command',
  '   touch probe.txt',
  '   Create a probe file',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to /tmp/pane from this project',
  '   3. No',
  ' Esc to cancel · Tab to amend'
]
const CLAUDE_WRITE_ASK = [
  '⏺ Write(notes.txt)',
  RULE,
  ' Create file',
  ' notes.txt',
  '╌╌╌╌',
  '  1 hi',
  '╌╌╌╌',
  ' Do you want to create notes.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
  '   3. No',
  ' Esc to cancel · Tab to amend'
]
// After Down, Down, Tab: the highlighted row turns into a note field.
const CLAUDE_BASH_AMEND = [
  ...CLAUDE_BASH_ASK.slice(0, 7),
  '   1. Yes',
  '   2. Yes, and always allow access to /tmp/pane from this project',
  ' ❯ 3. No, and tell Claude what to do differently',
  ' Esc to cancel'
]
const CODEX_ASK = [
  '• Running touch codex-probe.txt',
  '  Would you like to run the following command?',
  '  Environment: local',
  '  Reason: May I create codex-probe.txt in the current directory, as requested?',
  '  $ touch codex-probe.txt',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `touch codex-probe.txt` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '  Press enter to confirm or esc to cancel'
]
const CODEX_WORKING = ['✔ You approved codex to run touch codex-probe.txt this time', '• Working (11s • esc to interrupt)', '› Ask Codex to do anything']
const PARTS_FOOTER = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
const partScreen = (tabs: string, heading: string, labels: string[], box = false) => [
  RULE,
  tabs,
  heading,
  ...labels.map((label, i) => `${i ? '  ' : '❯ '}${i + 1}. ${box ? '[ ] ' : ''}${label}`),
  `  ${labels.length + 1}. Type something.`,
  '────',
  `  ${labels.length + 2}. Chat about this`,
  PARTS_FOOTER
]
const COLOUR = partScreen('←  ☐ Color  ☐ Size  ✔ Submit  →', 'Which colour?', ['Red', 'Green', 'Blue'])
const SIZE = partScreen('←  ☒ Color  ☐ Size  ✔ Submit  →', 'Which size?', ['Small', 'Medium', 'Large'])
const TOPPINGS = partScreen('←  ☐ Toppings  ☐ Size  ✔ Submit  →', 'Which toppings?', ['Cheese', 'Olive', 'Mushroom'], true)
const PARTS_REVIEW = [
  '←  ☒ Color  ☒ Size  ✔ Submit  →',
  'Review your answers',
  ' ● Which colour?',
  '   → Green',
  ' ● Which size?',
  '   → Large',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel'
]

const decide = (allow: boolean, note?: string): ReplyRequest => ({
  id: 'tab:leaf',
  reply: { type: 'permission', allow, ...(note ? { note } : {}) }
})
const answers = (...parts: number[][]): ReplyRequest => ({ id: 'tab:leaf', reply: { type: 'answers', answers: parts } })
const bashAsk = (agent: 'claude' | 'codex', summary: string) =>
  item({ agent, kind: 'permission', state: 'waiting', permission: { toolName: 'Bash', summary } })

test('Claude permission: Allow sends 1 and Deny sends the No row, never the always-allow row', async () => {
  const allow = harness([CLAUDE_BASH_ASK])
  assert.equal(code(await allow.sender.send(bashAsk('claude', 'touch probe.txt'), decide(true))), 'ok')
  assert.deepEqual(allow.sent, ['"1"'])
  const deny = harness([CLAUDE_WRITE_ASK])
  const write = item({ kind: 'permission', state: 'waiting', permission: { toolName: 'Write', summary: '/tmp/pane/notes.txt' } })
  assert.equal(code(await deny.sender.send(write, decide(false))), 'ok')
  assert.deepEqual(deny.sent, ['"3"'])
})

test('Claude permission with a note moves to the row, amends it with Tab, types, and submits', async () => {
  const { sender, sent } = harness([CLAUDE_BASH_ASK, CLAUDE_BASH_AMEND])
  assert.equal(code(await sender.send(bashAsk('claude', 'touch probe.txt'), decide(false, 'skip it,\nsay why'))), 'ok')
  assert.deepEqual(sent, ['"\\u001b[B"', '"\\u001b[B"', '"\\t"', '"skip it, say why"', '""+enter'])
})

test('Claude permission refuses when the pane asks about something else, or nothing', async () => {
  const other = harness([CLAUDE_BASH_ASK])
  assert.equal(code(await other.sender.send(bashAsk('claude', 'rm -rf build'), decide(true))), 'terminal_rejected')
  const gone = harness([CLAUDE_IDLE])
  assert.equal(code(await gone.sender.send(bashAsk('claude', 'touch probe.txt'), decide(true))), 'terminal_rejected')
  assert.deepEqual([...other.sent, ...gone.sent], [])
})

test('Codex permission: the digit decides, and a note follows as a message once the prompt closes', async () => {
  const deny = harness([CODEX_ASK])
  assert.equal(code(await deny.sender.send(bashAsk('codex', 'touch codex-probe.txt'), decide(false))), 'ok')
  assert.deepEqual(deny.sent, ['"3"'])
  const noted = harness([CODEX_ASK, CODEX_WORKING])
  assert.equal(code(await noted.sender.send(bashAsk('codex', 'touch codex-probe.txt'), decide(true, 'then list the folder'))), 'ok')
  assert.deepEqual(noted.sent, ['"1"', '"then list the folder"+enter'])
  const other = harness([CODEX_ASK])
  assert.equal(code(await other.sender.send(bashAsk('codex', 'curl example.com'), decide(true))), 'terminal_rejected')
})

test('a permission ask only takes a permission reply, and only permission asks do', async () => {
  const { sender, sent } = harness([CLAUDE_BASH_ASK])
  assert.equal(code(await sender.send(bashAsk('claude', 'touch probe.txt'), text('yes'))), 'bad_request')
  assert.equal(code(await sender.send(item({}), decide(true))), 'bad_request')
  assert.deepEqual(sent, [])
})

function parts(...questions: FeedQuestion[]): FeedQuestion {
  const [first, ...more] = questions
  return { ...first!, more }
}
const titled = (title: string, labels: string[], multiSelect = false) => ({ ...question(labels, multiSelect), title })

test('a Claude picker with several questions answers each part, then submits the review', async () => {
  const { sender, sent } = harness([COLOUR, COLOUR, SIZE, PARTS_REVIEW])
  const claude = item({
    kind: 'question',
    state: 'waiting',
    question: parts(titled('Which colour?', ['Red', 'Green', 'Blue']), titled('Which size?', ['Small', 'Medium', 'Large']))
  })
  assert.equal(code(await sender.send(claude, answers([2], [3]))), 'ok')
  assert.deepEqual(sent, ['"2"', '"3"', '"1"'])
})

test('a multi-select part ticks its boxes, then Right moves to the next part', async () => {
  const { sender, sent } = harness([TOPPINGS, TOPPINGS, SIZE, PARTS_REVIEW])
  const claude = item({
    kind: 'question',
    state: 'waiting',
    question: parts(titled('Which toppings?', ['Cheese', 'Olive', 'Mushroom'], true), titled('Which size?', ['Small', 'Medium', 'Large']))
  })
  assert.equal(code(await sender.send(claude, answers([1, 3], [2]))), 'ok')
  assert.deepEqual(sent, ['"1"', '"3"', '"\\u001b[C"', '"2"', '"1"'])
})

test('several questions refuse a single pick, a missing answer, and a part that never shows', async () => {
  const claude = item({
    kind: 'question',
    state: 'waiting',
    question: parts(titled('Which colour?', ['Red', 'Green', 'Blue']), titled('Which size?', ['Small', 'Medium', 'Large']))
  })
  const single = harness([COLOUR])
  assert.equal(code(await single.sender.send(claude, pick(1))), 'bad_request')
  const short = harness([COLOUR])
  assert.equal(code(await short.sender.send(claude, answers([1]))), 'bad_request')
  const stuck = harness([COLOUR])
  const result = await stuck.sender.send(claude, answers([2], [3]))
  assert.equal(code(result), 'terminal_rejected')
  assert.match((result as { error: { message: string } }).error.message, /answered 1 of 2/)
  assert.deepEqual([...single.sent, ...short.sent, ...stuck.sent], ['"2"'])
})

test('a failed reply is recorded with the keys already typed and the screen the sender saw', async () => {
  const failures: ReplyFailure[] = []
  const { sender } = harness([COLOUR], { onFailure: (failure) => failures.push(failure) })
  const claude = item({
    kind: 'question',
    state: 'waiting',
    project: 'shop',
    title: 'order',
    question: parts(titled('Which colour?', ['Red', 'Green', 'Blue']), titled('Which size?', ['Small', 'Medium', 'Large']))
  })
  await sender.send(claude, answers([2], [3]))
  assert.equal(failures.length, 1)
  const [failure] = failures
  assert.deepEqual(
    { ...failure, id: undefined, screen: failure!.screen?.at(-1) },
    {
      id: undefined,
      at: 1000,
      itemId: 'tab:leaf',
      agent: 'claude',
      kind: 'question',
      where: 'shop / order',
      reply: { type: 'answers', answers: [[2], [3]] },
      code: 'terminal_rejected',
      message: failure!.message,
      keysSent: ['"2"'],
      screen: PARTS_FOOTER,
      draft: null
    }
  )
  assert.match(failure!.message, /answered 1 of 2/)
})

test('a refusal before any key is recorded with no keys, and a success records nothing', async () => {
  const failures: ReplyFailure[] = []
  const refused = harness([CLAUDE_BASH_ASK], { onFailure: (failure) => failures.push(failure) })
  await refused.sender.send(bashAsk('claude', 'rm -rf build'), decide(true))
  await refused.sender.send(undefined, text('hi'))
  const fine = harness([CLAUDE_BASH_ASK], { onFailure: (failure) => failures.push(failure) })
  await fine.sender.send(bashAsk('claude', 'touch probe.txt'), decide(true))
  assert.deepEqual(failures.map((f) => [f.code, f.keysSent.length, f.screen === null]), [
    ['terminal_rejected', 0, false],
    ['not_found', 0, true]
  ])
})

test("a failure keeps the composer's unsent text, which the screen lines don't show", async () => {
  const failures: ReplyFailure[] = []
  const { sender } = harness([CLAUDE_IDLE], { draft: 'wip', onFailure: (failure) => failures.push(failure) })
  await sender.send(item({}), text('ship it'))
  assert.deepEqual([failures[0]?.code, failures[0]?.draft], ['terminal_rejected', 'wip'])
})

test('keys read as a person would type them', () => {
  assert.deepEqual(
    [describeKey({ text: '\x1b[B' }), describeKey({ text: '\t' }), describeKey({ enter: true }), describeKey({ text: 'hi', enter: true })],
    ['↓', 'Tab', 'Enter', '"hi" + Enter']
  )
})
