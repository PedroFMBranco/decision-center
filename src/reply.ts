import type { ActionResponse, ApiErrorCode, FeedItem, FeedOption, FeedQuestion, ReplyFailure, ReplyRequest } from './contract.ts'
import { OrcaCliError, type TerminalScreen } from './cli.ts'

// Keystrokes, verified live against Claude Code 2.1.283 and Codex 0.155.1
// (issues 0004, 0012, 0015, 0021, 0022).
const RIGHT = '\x1b[C'
const DOWN = '\x1b[B'
/** Claude's "Tab to amend": adds a note to the highlighted permission row. */
const TAB = '\t'
/** Option+Up: opens Codex's queued question picker. */
const OPTION_UP = '\x1b[1;3A'
/** Option+Down: back from Codex's picker to its main prompt. */
const OPTION_DOWN = '\x1b[1;3B'
// Why: each key is its own `terminal send`, and the TUI needs a moment to
// repaint before the next one lands on the right row.
const KEY_GAP_MS = 250
const SCREEN_WAIT_MS = 3000

export interface SenderDeps {
  terminalFor(paneKey: string): Promise<{ handle: string } | undefined>
  screen(handle: string): Promise<TerminalScreen>
  send(handle: string, input: { text?: string; enter?: boolean }): Promise<void>
  sleep?(ms: number): Promise<void>
  /** Called once for every reply that fails, with what the sender saw and typed. */
  onFailure?(failure: ReplyFailure): void
  now?(): number
}

/** How many screen lines a failure keeps: enough to see the prompt, not the scrollback. */
const FAILURE_SCREEN_LINES = 40

/** Keys as a person would read them in a report. */
export function describeKey(input: { text?: string; enter?: boolean }): string {
  const names: Record<string, string> = {
    '\x1b[A': '↑', '\x1b[B': '↓', '\x1b[C': '→', '\x1b[1;3A': '⌥↑', '\x1b[1;3B': '⌥↓', '\t': 'Tab', '\x1b': 'Esc', '\x7f': '⌫'
  }
  const text = input.text ? (names[input.text] ?? JSON.stringify(input.text)) : ''
  return [text, input.enter ? 'Enter' : ''].filter(Boolean).join(' + ')
}

/** A numbered picker row as the pane renders it. */
export interface ScreenRow {
  index: number
  label: string
}

// `❯ 1. Red`, `  4. [✔] Type something`, `  › 2. Summer`.
const ROW = /^\s*[❯›]?\s*(\d+)\.\s+(?:\[[ ✔]\]\s+)?(.+?)\s*$/

/** The picker rows just above `footer`, read upward until row 1. */
export function pickerRows(lines: string[], footer: number): ScreenRow[] {
  const rows: ScreenRow[] = []
  for (let i = footer - 1; i >= 0; i--) {
    const match = ROW.exec(lines[i] ?? '')
    if (!match) {
      continue
    }
    const index = Number(match[1])
    if (rows.length > 0 && index >= rows[0]!.index) {
      break
    }
    rows.unshift({ index, label: match[2]! })
    if (index === 1) {
      break
    }
  }
  return rows
}

const lastIndex = (lines: string[], test: (line: string) => boolean) => lines.findLastIndex(test)

/** Where Claude's AskUserQuestion picker is on screen, or -1. */
export function claudePickerFooter(lines: string[]): number {
  return lastIndex(lines, (line) => line.includes('Enter to select') && line.includes('Esc to cancel'))
}

/** How many questions Claude's picker holds, from its tab header (`☐ A  ☐ B  ✔ Submit`). */
export function claudeQuestionCount(lines: string[]): number {
  const header = lines[lastIndex(lines, (line) => /[☐☒]/.test(line))] ?? ''
  return Math.max(1, (header.match(/[☐☒]/g) ?? []).length)
}

/** The question heading under the tab header of Claude's picker. */
export function claudePickerHeading(lines: string[]): string {
  const header = lastIndex(lines, (line) => /[☐☒]/.test(line))
  return header < 0 ? '' : (lines[header + 1] ?? '').trim()
}

/** Where Claude's permission prompt is on screen (`Esc to cancel · Tab to amend`), or -1. */
export function claudePermissionFooter(lines: string[]): number {
  const footer = lastIndex(lines, (line) => line.trim().startsWith('Esc to cancel'))
  return footer >= 0 && lines.slice(0, footer).some((line) => line.includes('Do you want to')) ? footer : -1
}

/** Where Codex's approval prompt is on screen, or -1. */
export function codexPermissionFooter(lines: string[]): number {
  return lastIndex(lines, (line) => line.includes('Press enter to confirm or esc to cancel'))
}

/**
 * Whether the prompt box above `footer` shows what the feed item asks about:
 * the command for Bash, the file name for a path. Other asks aren't checked.
 */
function claudeAskShown(lines: string[], footer: number, item: FeedItem): boolean {
  const summary = item.permission?.summary.trim().split('\n')[0] ?? ''
  const top = lines.slice(0, footer).findLastIndex((line) => /^─{10,}/.test(line.trim()))
  const box = lines.slice(top + 1, footer)
  if (item.permission?.toolName === 'Bash' && summary) {
    return box.some((line) => sameHeading(line, summary))
  }
  if (summary.startsWith('/')) {
    const file = normalize(summary.split('/').pop() ?? '')
    return box.some((line) => normalize(line).includes(file))
  }
  return true
}

export function claudeReviewShown(lines: string[]): boolean {
  return lines.some((line) => line.includes('Ready to submit your answers?'))
}

/** Where Codex's open question picker is on screen, or -1. */
export function codexPickerFooter(lines: string[]): number {
  return lastIndex(lines, (line) => line.includes('enter submit') && line.includes('main prompt'))
}

export function codexQuestionQueued(lines: string[]): boolean {
  return lines.some((line) => line.includes('⌥ + ↑ to answer'))
}

class Refusal extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ApiErrorCode, message: string): never {
  throw new Refusal(code, message)
}

/** Picker rows that open free text rather than pick an answer. */
const FREE_ROWS = /^(type something|other|chat about this)/

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** True when two headings agree as far as the narrower one shows (panes truncate and wrap). */
function sameHeading(shown: string, want: string): boolean {
  const a = normalize(shown).replace(/…$/, '')
  const b = normalize(want)
  return a.length > 0 && (a.startsWith(b) || b.startsWith(a))
}

type PermissionReply = Extract<ReplyRequest['reply'], { type: 'permission' }>

/** The picker's plain Yes row (always 1) or its No row. Never "Yes, and always allow…". */
function decisionRow(rows: ScreenRow[], allow: boolean): ScreenRow {
  const row = allow
    ? rows.find((candidate) => candidate.index === 1 && /^yes\b/.test(normalize(candidate.label)))
    : rows.find((candidate) => /^no\b/.test(normalize(candidate.label)))
  if (!row) {
    refuse('terminal_rejected', `the pane's prompt has no plain ${allow ? 'Yes' : 'No'} row; answer in the pane`)
  }
  return row
}

const partsOf = (item: FeedItem): FeedQuestion[] => (item.question ? [item.question, ...(item.question.more ?? [])] : [])

/** Checks each index is on screen, and is the option the feed showed you. */
function checkOptions(rows: ScreenRow[], indexes: number[], options: FeedOption[]): void {
  for (const index of indexes) {
    const row = rows.find((candidate) => candidate.index === index)
    const expected = options.find((option) => option.index === index)
    if (!row) {
      refuse('terminal_rejected', `option ${index} isn't on the pane's picker`)
    }
    // Why: a narrow pane truncates long labels.
    const shown = normalize(row.label).replace(/…$/, '')
    const want = normalize(expected?.label ?? '')
    const matches = want ? shown.startsWith(want) || want.startsWith(shown) : !FREE_ROWS.test(shown)
    if (!matches) {
      refuse('terminal_rejected', `option ${index} on the pane is "${row.label}", not "${expected?.label ?? 'an option'}"`)
    }
  }
}

/** Refuses when you've half-typed something in the pane, so a reply never merges with it. */
function checkNoDraft(screen: TerminalScreen): void {
  if (screen.draft?.trim()) {
    refuse('terminal_rejected', `the pane has unsent text in its composer: "${screen.draft.trim().slice(0, 60)}"`)
  }
}

/** Sends one reply to the item's pane, checking the pane's screen first (issue 0015). */
export class ReplySender {
  private readonly deps: SenderDeps
  /** What the reply in progress has read and typed, for its failure record. */
  private trace: { keys: string[]; screen: string[] | null; draft: string | null } = { keys: [], screen: null, draft: null }

  constructor(deps: SenderDeps) {
    this.deps = deps
  }

  private async readScreen(handle: string): Promise<TerminalScreen> {
    const screen = await this.deps.screen(handle)
    this.trace.screen = screen.lines
    this.trace.draft = screen.draft ?? null
    return screen
  }

  private async press(handle: string, input: { text?: string; enter?: boolean }): Promise<void> {
    await this.deps.send(handle, input)
    this.trace.keys.push(describeKey(input))
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((done) => setTimeout(done, ms))
  }

  private async key(handle: string, input: { text?: string; enter?: boolean }): Promise<void> {
    await this.press(handle, input)
    await this.sleep(KEY_GAP_MS)
  }

  /** Re-reads the screen until `ready` holds, for keys whose effect takes a repaint. */
  private async screenUntil(handle: string, ready: (lines: string[]) => boolean): Promise<TerminalScreen | null> {
    for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += KEY_GAP_MS) {
      const screen = await this.readScreen(handle)
      if (ready(screen.lines)) {
        return screen
      }
      await this.sleep(KEY_GAP_MS)
    }
    return null
  }

  async send(item: FeedItem | undefined, request: ReplyRequest): Promise<ActionResponse> {
    this.trace = { keys: [], screen: null, draft: null }
    const result = await this.attempt(item, request)
    if (!result.ok) {
      this.deps.onFailure?.(this.failure(item, request, result.error))
    }
    return result
  }

  private failure(item: FeedItem | undefined, request: ReplyRequest, error: { code: ApiErrorCode; message: string }): ReplyFailure {
    const at = this.deps.now?.() ?? Date.now()
    return {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      itemId: request.id,
      agent: item?.agent ?? null,
      kind: item?.kind ?? null,
      where: item ? `${item.worktreeName} / ${item.title}` : null,
      reply: request.reply,
      code: error.code,
      message: error.message,
      keysSent: [...this.trace.keys],
      screen: this.trace.screen?.slice(-FAILURE_SCREEN_LINES) ?? null,
      draft: this.trace.draft
    }
  }

  private async attempt(item: FeedItem | undefined, request: ReplyRequest): Promise<ActionResponse> {
    try {
      if (!item) {
        refuse('not_found', `no feed item ${request.id}`)
      }
      if (item.kind === 'closed') {
        refuse('session_closed', 'the session has closed')
      }
      if (item.kind === 'permission' && request.reply.type !== 'permission') {
        refuse('bad_request', 'answer a permission ask with Allow or Deny')
      }
      if (item.kind !== 'permission' && request.reply.type === 'permission') {
        refuse('bad_request', 'this item is not a permission ask')
      }
      const terminal = await this.deps.terminalFor(item.id)
      if (!terminal) {
        refuse('session_closed', 'the pane has no live terminal')
      }
      const handle = terminal.handle
      if (request.reply.type === 'permission') {
        await (item.agent === 'claude'
          ? this.claudePermission(handle, item, request.reply)
          : this.codexPermission(handle, item, request.reply))
      } else if (item.kind === 'finished') {
        await this.message(handle, request.reply)
      } else if (item.agent === 'claude') {
        await this.claudeQuestion(handle, item, request.reply)
      } else {
        await this.codexQuestion(handle, item, request.reply)
      }
      return { ok: true }
    } catch (error) {
      if (error instanceof Refusal) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      const code = error instanceof OrcaCliError && error.code !== 'cli_failed' ? 'terminal_rejected' : 'cli_failed'
      return { ok: false, error: { code, message: (error as Error).message } }
    }
  }

  /** A normal message into the composer. Both agents queue it if a turn is running (issue 0004). */
  private async message(handle: string, reply: ReplyRequest['reply']): Promise<void> {
    if (reply.type !== 'text') {
      refuse('bad_request', 'this item has no options to pick; reply with text')
    }
    const screen = await this.readScreen(handle)
    if (claudePickerFooter(screen.lines) >= 0 || codexPickerFooter(screen.lines) >= 0) {
      refuse('terminal_rejected', 'the pane has a picker open; answer it there or wait for the feed to catch up')
    }
    checkNoDraft(screen)
    const text = reply.text
    try {
      await this.press(handle, { text, enter: true })
    } catch (error) {
      // Why: a stale `agentWait` blocks text+Enter in one send; split, it goes through (issue 0004).
      if (!(error instanceof OrcaCliError && error.code === 'agent_prompt_blocked')) {
        throw error
      }
      await this.key(handle, { text })
      await this.press(handle, { enter: true })
    }
  }

  private async claudeQuestion(handle: string, item: FeedItem, reply: ReplyRequest['reply']): Promise<void> {
    const screen = await this.readScreen(handle)
    const footer = claudePickerFooter(screen.lines)
    if (footer < 0) {
      // Why: Orca can keep a pane `waiting` after the picker is cancelled.
      // Text still makes sense as a message; a digit would land as a typo.
      if (reply.type === 'text') {
        await this.message(handle, reply)
        return
      }
      refuse('terminal_rejected', "the question isn't open in the pane any more")
    }
    const parts = partsOf(item)
    const count = claudeQuestionCount(screen.lines)
    if (count > 1 || parts.length > 1) {
      if (count !== parts.length) {
        refuse('terminal_rejected', `the pane's picker has ${count} questions, not ${parts.length}`)
      }
      if (reply.type !== 'answers') {
        refuse('bad_request', 'this asks several questions; pick an answer for each')
      }
      await this.claudeParts(handle, parts, reply.answers)
      return
    }
    if (reply.type === 'answers') {
      reply = { type: 'option', indexes: reply.answers[0] ?? [] }
    }
    if (reply.type === 'permission') {
      refuse('bad_request', 'this item is not a permission ask')
    }
    const rows = pickerRows(screen.lines, footer)
    const multiSelect = item.question?.multiSelect === true

    if (reply.type === 'text') {
      if (multiSelect) {
        refuse('bad_request', 'free text on a multi-select question is typed in the pane')
      }
      const other = rows.find((row) => normalize(row.label).startsWith('type something'))
      if (!other) {
        refuse('terminal_rejected', 'the picker has no "Type something" row')
      }
      // Digit lands on the row, text replaces its placeholder, Enter submits.
      // Why separate sends: digit+text in one send is dropped, and text+Enter
      // is refused while the picker is up (issue 0004). A newline would submit early.
      await this.key(handle, { text: String(other.index) })
      await this.key(handle, { text: reply.text.replace(/\s*\n\s*/g, ' ') })
      await this.press(handle, { enter: true })
      return
    }

    if (!multiSelect && reply.indexes.length > 1) {
      refuse('bad_request', 'this question takes one option')
    }
    checkOptions(rows, reply.indexes, item.question?.options ?? [])
    if (!multiSelect) {
      // A bare digit selects and submits.
      await this.press(handle, { text: String(reply.indexes[0]) })
      return
    }
    // Each digit toggles a box; Right opens the review; 1 submits it.
    for (const index of new Set(reply.indexes)) {
      await this.key(handle, { text: String(index) })
    }
    await this.press(handle, { text: RIGHT })
    if (!(await this.screenUntil(handle, claudeReviewShown))) {
      refuse('terminal_rejected', "the options are ticked but the review screen didn't open; submit in the pane")
    }
    await this.press(handle, { text: '1' })
  }

  /**
   * Answers each part of a multi-question picker in turn: a digit for a
   * single-select part (it moves on by itself), toggles then Right for a
   * multi-select one. Then 1 submits the review screen.
   */
  private async claudeParts(handle: string, parts: FeedQuestion[], answers: number[][]): Promise<void> {
    if (answers.length !== parts.length) {
      refuse('bad_request', `pick an answer for each of the ${parts.length} questions`)
    }
    for (const [n, part] of parts.entries()) {
      const answer = answers[n]!
      if (!part.options.length) {
        refuse('bad_request', `question ${n + 1} has no options; answer it in the pane`)
      }
      if (!answer.length || (!part.multiSelect && answer.length > 1)) {
        refuse('bad_request', `question ${n + 1} takes ${part.multiSelect ? 'one or more options' : 'one option'}`)
      }
      // Why: parts after the first only show once the earlier ones are answered.
      const screen = await this.screenUntil(handle, (lines) => sameHeading(claudePickerHeading(lines), part.title))
      if (!screen) {
        refuse('terminal_rejected', n === 0
          ? `the pane's picker doesn't start with "${part.title}"`
          : `answered ${n} of ${parts.length} questions, then the pane didn't show "${part.title}"; finish in the pane`)
      }
      checkOptions(pickerRows(screen.lines, claudePickerFooter(screen.lines)), answer, part.options)
      if (part.multiSelect) {
        for (const index of new Set(answer)) {
          await this.key(handle, { text: String(index) })
        }
        await this.key(handle, { text: RIGHT })
      } else {
        await this.key(handle, { text: String(answer[0]) })
      }
    }
    if (!(await this.screenUntil(handle, claudeReviewShown))) {
      refuse('terminal_rejected', "every question is answered but the review screen didn't open; submit in the pane")
    }
    await this.press(handle, { text: '1' })
  }

  /**
   * Claude: the row's digit decides. With a note: Down to the row, Tab to
   * amend it, the note, Enter. Rows: 1. Yes, 2. Yes and always allow…, 3. No.
   */
  private async claudePermission(handle: string, item: FeedItem, reply: PermissionReply): Promise<void> {
    const screen = await this.readScreen(handle)
    const footer = claudePermissionFooter(screen.lines)
    if (footer < 0) {
      refuse('terminal_rejected', "the permission ask isn't open in the pane any more")
    }
    if (!claudeAskShown(screen.lines, footer, item)) {
      refuse('terminal_rejected', `the pane's prompt isn't about "${item.permission?.summary.slice(0, 60)}"; answer in the pane`)
    }
    const row = decisionRow(pickerRows(screen.lines, footer), reply.allow)
    const note = reply.note?.replace(/\s*\n\s*/g, ' ').trim()
    if (!note) {
      await this.press(handle, { text: String(row.index) })
      return
    }
    if (!screen.lines.some((line) => /^\s*❯\s*1\./.test(line))) {
      refuse('terminal_rejected', "the pane's cursor isn't on the first row; answer in the pane")
    }
    for (let i = 1; i < row.index; i++) {
      await this.key(handle, { text: DOWN })
    }
    await this.press(handle, { text: TAB })
    // Why: in amend mode the footer drops "Tab to amend", and typed text lands on the row.
    const amending = await this.screenUntil(handle, (lines) => {
      const at = claudePermissionFooter(lines)
      return at >= 0 && !lines[at]!.includes('Tab to amend')
    })
    if (!amending) {
      refuse('terminal_rejected', "the note box didn't open; answer in the pane")
    }
    await this.key(handle, { text: note })
    await this.press(handle, { enter: true })
  }

  /** Codex: the row's digit decides. A note follows as a normal message once the prompt closes. */
  private async codexPermission(handle: string, item: FeedItem, reply: PermissionReply): Promise<void> {
    const screen = await this.readScreen(handle)
    const footer = codexPermissionFooter(screen.lines)
    if (footer < 0) {
      refuse('terminal_rejected', "the approval prompt isn't open in the pane any more")
    }
    const command = screen.lines.slice(0, footer).findLast((line) => line.trim().startsWith('$ '))
    const summary = item.permission?.summary ?? ''
    if (command && summary && !sameHeading(command.trim().slice(2), summary)) {
      refuse('terminal_rejected', `the pane is asking to run "${command.trim().slice(2)}", not "${summary}"`)
    }
    const row = decisionRow(pickerRows(screen.lines, footer), reply.allow)
    await this.press(handle, { text: String(row.index) })
    const note = reply.note?.trim()
    if (!note) {
      return
    }
    if (!(await this.screenUntil(handle, (lines) => codexPermissionFooter(lines) < 0))) {
      refuse('terminal_rejected', "the decision went through but the note didn't; type it in the pane")
    }
    await this.message(handle, { type: 'text', text: note })
  }

  private async codexQuestion(handle: string, item: FeedItem, reply: ReplyRequest['reply']): Promise<void> {
    if (reply.type === 'answers' || reply.type === 'permission') {
      refuse('bad_request', 'Codex questions take one option or free text')
    }
    if (reply.type === 'text') {
      // Why: free text answers a Codex question as a normal message, even a
      // title-only one (issue 0012).
      await this.message(handle, reply)
      return
    }
    if (reply.indexes.length > 1) {
      refuse('bad_request', 'Codex questions take one option')
    }
    let screen = await this.readScreen(handle)
    let openedHere = false
    if (codexPickerFooter(screen.lines) < 0) {
      if (!codexQuestionQueued(screen.lines)) {
        refuse('terminal_rejected', "the question isn't waiting in the pane any more")
      }
      await this.press(handle, { text: OPTION_UP })
      const opened = await this.screenUntil(handle, (lines) => codexPickerFooter(lines) >= 0)
      if (!opened) {
        refuse('terminal_rejected', "the question picker didn't open")
      }
      screen = opened
      openedHere = true
    }
    try {
      checkOptions(pickerRows(screen.lines, codexPickerFooter(screen.lines)), reply.indexes, item.question?.options ?? [])
    } catch (error) {
      // Why: leave the pane as it was, with the question still queued.
      if (openedHere) {
        await this.press(handle, { text: OPTION_DOWN })
      }
      throw error
    }
    // A bare digit selects and submits.
    await this.press(handle, { text: String(reply.indexes[0]) })
  }
}
