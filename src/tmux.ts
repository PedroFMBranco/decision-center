import { execFile } from 'node:child_process'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PaneRef } from './events.ts'
import { TerminalError, type TerminalScreen } from './terminal.ts'

export interface TmuxPane extends PaneRef {
  tty: string
  /** The pane's first process, usually a shell. */
  pid: number
  inMode: boolean
  dead: boolean
}

const TIMEOUT_MS = 5000

/** Every call names its server, so panes on several tmux servers all work. */
function tmux(socket: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-S', socket, ...args], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new TerminalError(`tmux: ${(stderr || error.message).trim()}`, 'cli_failed'))
        return
      }
      resolve(stdout)
    })
  })
}

/** Sockets of every tmux server this user runs, by the path tmux itself reports. */
export function tmuxSockets(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`)
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      try {
        return statSync(path).isSocket() ? [realpathSync(path)] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

const PANE_FORMAT = '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_in_mode}\t#{pane_dead}'

export async function panes(sockets: string[]): Promise<TmuxPane[]> {
  const lists = await Promise.all(
    sockets.map(async (socket) => {
      const out = await tmux(socket, ['list-panes', '-a', '-F', PANE_FORMAT]).catch(() => '')
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id = '', tty = '', pid = '', inMode = '', dead = ''] = line.split('\t')
          return { socket, id, tty, pid: Number(pid), inMode: inMode === '1', dead: dead === '1' }
        })
    })
  )
  return lists.flat()
}

// SGR, plus OSC sequences such as hyperlinks.
const SGR = /\x1b\[([0-9;:]*)m/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

interface Style {
  dim: boolean
  /** Foreground SGR parameters, e.g. `38;5;246`; null for the default colour. */
  fg: string | null
}

interface Cell {
  text: string
  style: Style
}

function applySgr(style: Style, params: string): Style {
  const codes = params.replace(/:/g, ';').split(';').map((code) => (code === '' ? 0 : Number(code)))
  let next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) next = { dim: false, fg: null }
    else if (code === 2) next.dim = true
    else if (code === 22) next.dim = false
    else if (code === 39) next.fg = null
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = String(code)
    else if (code === 38 && codes[i + 1] === 5) {
      next.fg = `38;5;${codes[i + 2]}`
      i += 2
    } else if (code === 38 && codes[i + 1] === 2) {
      next.fg = `38;2;${codes.slice(i + 2, i + 5).join(';')}`
      i += 4
    } else if (code === 48) {
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
    }
  }
  return next
}

function isGrey(fg: string | null): boolean {
  if (!fg) return false
  if (fg === '90' || fg === '37') return true
  const indexed = /^38;5;(\d+)$/.exec(fg)
  if (indexed) {
    const n = Number(indexed[1])
    return n === 8 || n === 7 || (n >= 232 && n <= 255)
  }
  const rgb = /^38;2;(\d+);(\d+);(\d+)$/.exec(fg)
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number) as [number, number, number]
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && Math.max(r, g, b) < 230
  }
  return false
}

/** Splits styled lines into cells. Style carries across lines, as `capture-pane -e` writes it. */
function cellsOf(styled: string[]): Cell[][] {
  let style: Style = { dim: false, fg: null }
  return styled.map((raw) => {
    const cells: Cell[] = []
    const line = raw.replace(OSC, '')
    let at = 0
    for (const match of line.matchAll(SGR)) {
      if (match.index > at) cells.push({ text: line.slice(at, match.index), style })
      style = applySgr(style, match[1] ?? '')
      at = match.index + match[0].length
    }
    if (at < line.length) cells.push({ text: line.slice(at), style })
    return cells
  })
}

const plainOf = (cells: Cell[]) => cells.map((cell) => cell.text).join('')
/** What you typed: the composer text that is neither dim nor grey (placeholders and predictions are). */
const typedOf = (cells: Cell[]) =>
  cells
    .filter((cell) => !cell.style.dim && !isGrey(cell.style.fg))
    .map((cell) => cell.text)
    .join('')

/** Drops the first `n` characters of a line's cells. */
function dropChars(cells: Cell[], n: number): Cell[] {
  const out: Cell[] = []
  for (const cell of cells) {
    if (n >= cell.text.length) {
      n -= cell.text.length
      continue
    }
    out.push({ ...cell, text: cell.text.slice(n) })
    n = 0
  }
  return out
}

const CLAUDE_RULE = /^─{10,}$/

/**
 * Plain screen lines plus the unsent composer text. Claude's composer is
 * `❯\xa0<text>` between two `─` rules; Codex's is `› <text>` at column 0.
 */
export function parseScreen(styled: string[]): TerminalScreen {
  const cells = cellsOf(styled)
  const lines = cells.map(plainOf)
  const rules = lines.flatMap((line, i) => (CLAUDE_RULE.test(line.trim()) ? [i] : []))
  const [top, bottom] = rules.slice(-2)
  let draft = ''
  if (top !== undefined && bottom !== undefined && lines[top + 1]?.startsWith('❯\xa0')) {
    draft = cells
      .slice(top + 1, bottom)
      .map((line, i) => typedOf(i === 0 ? dropChars(line, 2) : line).trim())
      .filter(Boolean)
      .join('\n')
  } else {
    const composer = lines.findLastIndex((line) => /^›(\s|$)/.test(line))
    if (composer >= 0) {
      draft = typedOf(dropChars(cells[composer]!, 2)).trim()
    }
  }
  return { lines, draft: draft || null }
}

export async function screen(pane: PaneRef): Promise<TerminalScreen> {
  const out = await tmux(pane.socket, ['display-message', '-p', '-t', pane.id, '#{pane_in_mode}', ';', 'capture-pane', '-p', '-e', '-t', pane.id])
  const [inMode, ...styled] = out.replace(/\n$/, '').split('\n')
  if (inMode === '1') {
    // Why: keys sent now would go to tmux's copy mode, not the agent.
    throw new TerminalError('the pane is in copy mode; press q in it, then reply', 'pane_in_mode')
  }
  return parseScreen(styled)
}

/** Types `text` literally, then Enter as its own key press. */
export async function send(pane: PaneRef, input: { text?: string; enter?: boolean }): Promise<void> {
  if (input.text) {
    // Why: tmux reads an argument ending in `;` as a command separator, so trailing ones go as hex.
    const head = input.text.replace(/;+$/, '')
    const semicolons = input.text.length - head.length
    const args = head ? ['send-keys', '-t', pane.id, '-l', '--', head] : []
    if (semicolons) {
      args.push(...(args.length ? [';'] : []), 'send-keys', '-t', pane.id, '-H', ...Array(semicolons).fill('3b'))
    }
    await tmux(pane.socket, args)
  }
  if (input.enter) {
    await tmux(pane.socket, ['send-keys', '-t', pane.id, 'Enter'])
  }
}

/** Shows the pane. With no client attached, still selects its window and pane. */
export async function focus(pane: PaneRef): Promise<void> {
  await tmux(pane.socket, ['select-window', '-t', pane.id, ';', 'select-pane', '-t', pane.id])
  await tmux(pane.socket, ['switch-client', '-t', pane.id]).catch(() => undefined)
}
