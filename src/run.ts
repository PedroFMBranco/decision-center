// `decision-center run <agent>`: starts an agent inside tmux from any terminal,
// so replies from the feed can reach it.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

/** Our own tmux server: its settings never touch the user's tmux. */
const SERVER = 'decision-center'

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// Why each: no status line or Esc delay, so the agent looks and feels as it
// does outside tmux; the wheel scrolls tmux's history, which is the only
// scrollback there is; closing the terminal window ends the session.
const SETTINGS = [
  ['set', '-g', 'status', 'off'],
  ['set', '-s', 'escape-time', '0'],
  ['set', '-g', 'mouse', 'on'],
  ['set', '-g', 'history-limit', '50000'],
  ['set', '-g', 'destroy-unattached', 'on'],
  ['set', '-g', 'focus-events', 'on'],
  ['set', '-s', 'extended-keys', 'on']
]
const COPY_TO_MAC_CLIPBOARD = ['bind', '-T', 'copy-mode', 'MouseDragEnd1Pane', 'send', '-X', 'copy-pipe-and-cancel', 'pbcopy']

/** The tmux arguments that start `command` in a new session and attach to it. Pure. */
export function runArgs(command: string[], context: { env: NodeJS.ProcessEnv; cwd: string; platform: string; id: string }): string[] {
  const settings = context.platform === 'darwin' ? [...SETTINGS, COPY_TO_MAC_CLIPBOARD] : SETTINGS
  // Why -e: a running tmux server starts sessions with its own environment, not the caller's.
  const env = Object.entries(context.env).flatMap(([name, value]) =>
    value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(TMUX|TMUX_PANE|TERM)$/.test(name) ? [] : ['-e', `${name}=${value}`]
  )
  return [
    '-L',
    SERVER,
    '-f',
    '/dev/null',
    'start-server',
    ';',
    ...settings.flatMap((setting) => [...setting, ';']),
    'new-session',
    '-s',
    `${basename(command[0]!)}-${context.id}`,
    '-c',
    context.cwd,
    ...env,
    '--',
    // Why one quoted string: tmux reads a bare `;` argument as its own separator.
    `exec ${command.map(quote).join(' ')}`
  ]
}

const PRINTS_AND_EXITS = new Set(['-p', '--print', '-v', '-V', '--version', '-h', '--help', '--bg'])
/** Subcommands that open a session. Every other one prints and exits. */
const SESSION_SUBCOMMANDS = new Set(['attach', 'resume', 'fork'])

/**
 * Whether the call opens a session in this terminal. Output that is piped, a
 * print flag or a subcommand (`claude mcp list`) must run outside tmux, where
 * what it prints stays on screen. A wrong "no" only costs replies from the feed.
 */
export function opensSession(args: string[], io: { stdinTty: boolean; stdoutTty: boolean }): boolean {
  if (!io.stdinTty || !io.stdoutTty) return false
  const first = args[0] ?? ''
  if (/^[a-z][a-z-]*$/.test(first) && !SESSION_SUBCOMMANDS.has(first)) return false
  const flags = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  return !flags.some((arg) => PRINTS_AND_EXITS.has(arg))
}

/** Runs `command` to its end and returns the exit code. */
export function run(command: string[]): number {
  if (!command.length) {
    throw new Error('run needs a command, for example: decision-center run claude')
  }
  const io = { stdinTty: process.stdin.isTTY === true, stdoutTty: process.stdout.isTTY === true }
  if (process.env.TMUX || !opensSession(command.slice(1), io)) {
    const direct = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' })
    if (direct.error) throw new Error(`couldn't start ${command[0]}: ${direct.error.message}`)
    return direct.status ?? 1
  }
  const args = runArgs(command, { env: process.env, cwd: process.cwd(), platform: process.platform, id: randomBytes(2).toString('hex') })
  const tmux = spawnSync('tmux', args, { stdio: 'inherit' })
  if (tmux.error) {
    throw new Error(`couldn't start tmux: ${tmux.error.message}. Install tmux 3.2 or later.`)
  }
  return tmux.status ?? 1
}
