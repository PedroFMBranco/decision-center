import type { ActionResponse, ApiErrorCode, FeedItem, FeedOption, ReplyRequest } from './contract.ts'
import { OrcaCliError, type TerminalScreen } from './cli.ts'

// Keystrokes, verified live against Claude Code 2.1.283 and Codex 0.155.1
// (issues 0004, 0012, 0015).
const RIGHT = '\x1b[C'
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

  constructor(deps: SenderDeps) {
    this.deps = deps
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((done) => setTimeout(done, ms))
  }

  private async key(handle: string, input: { text?: string; enter?: boolean }): Promise<void> {
    await this.deps.send(handle, input)
    await this.sleep(KEY_GAP_MS)
  }

  /** Re-reads the screen until `ready` holds, for keys whose effect takes a repaint. */
  private async screenUntil(handle: string, ready: (lines: string[]) => boolean): Promise<TerminalScreen | null> {
    for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += KEY_GAP_MS) {
      const screen = await this.deps.screen(handle)
      if (ready(screen.lines)) {
        return screen
      }
      await this.sleep(KEY_GAP_MS)
    }
    return null
  }

  async send(item: FeedItem | undefined, request: ReplyRequest): Promise<ActionResponse> {
    try {
      if (!item) {
        refuse('not_found', `no feed item ${request.id}`)
      }
      if (item.kind === 'closed') {
        refuse('session_closed', 'the session has closed')
      }
      if (item.kind === 'permission') {
        // Why: permission keystrokes are unverified on this host, so never guess them (issue 0010).
        refuse('bad_request', 'permission asks are answered in the pane: use Open pane')
      }
      const terminal = await this.deps.terminalFor(item.id)
      if (!terminal) {
        refuse('session_closed', 'the pane has no live terminal')
      }
      const handle = terminal.handle
      if (item.kind === 'finished') {
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
    const screen = await this.deps.screen(handle)
    if (claudePickerFooter(screen.lines) >= 0 || codexPickerFooter(screen.lines) >= 0) {
      refuse('terminal_rejected', 'the pane has a picker open; answer it there or wait for the feed to catch up')
    }
    checkNoDraft(screen)
    const text = reply.text
    try {
      await this.deps.send(handle, { text, enter: true })
    } catch (error) {
      // Why: a stale `agentWait` blocks text+Enter in one send; split, it goes through (issue 0004).
      if (!(error instanceof OrcaCliError && error.code === 'agent_prompt_blocked')) {
        throw error
      }
      await this.key(handle, { text })
      await this.deps.send(handle, { enter: true })
    }
  }

  private async claudeQuestion(handle: string, item: FeedItem, reply: ReplyRequest['reply']): Promise<void> {
    const screen = await this.deps.screen(handle)
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
    if (claudeQuestionCount(screen.lines) > 1) {
      refuse('terminal_rejected', 'this asks several questions at once; answer them in the pane')
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
      await this.deps.send(handle, { enter: true })
      return
    }

    if (!multiSelect && reply.indexes.length > 1) {
      refuse('bad_request', 'this question takes one option')
    }
    checkOptions(rows, reply.indexes, item.question?.options ?? [])
    if (!multiSelect) {
      // A bare digit selects and submits.
      await this.deps.send(handle, { text: String(reply.indexes[0]) })
      return
    }
    // Each digit toggles a box; Right opens the review; 1 submits it.
    for (const index of new Set(reply.indexes)) {
      await this.key(handle, { text: String(index) })
    }
    await this.deps.send(handle, { text: RIGHT })
    if (!(await this.screenUntil(handle, claudeReviewShown))) {
      refuse('terminal_rejected', "the options are ticked but the review screen didn't open; submit in the pane")
    }
    await this.deps.send(handle, { text: '1' })
  }

  private async codexQuestion(handle: string, item: FeedItem, reply: ReplyRequest['reply']): Promise<void> {
    if (reply.type === 'text') {
      // Why: free text answers a Codex question as a normal message, even a
      // title-only one (issue 0012).
      await this.message(handle, reply)
      return
    }
    if (reply.indexes.length > 1) {
      refuse('bad_request', 'Codex questions take one option')
    }
    let screen = await this.deps.screen(handle)
    let openedHere = false
    if (codexPickerFooter(screen.lines) < 0) {
      if (!codexQuestionQueued(screen.lines)) {
        refuse('terminal_rejected', "the question isn't waiting in the pane any more")
      }
      await this.deps.send(handle, { text: OPTION_UP })
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
        await this.deps.send(handle, { text: OPTION_DOWN })
      }
      throw error
    }
    // A bare digit selects and submits.
    await this.deps.send(handle, { text: String(reply.indexes[0]) })
  }
}
