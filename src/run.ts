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

/** Runs `command` to its end and returns the exit code. Inside tmux already, it runs as it is. */
export function run(command: string[]): number {
  if (!command.length) {
    throw new Error('run needs a command, for example: decision-center run claude')
  }
  if (process.env.TMUX) {
    const direct = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' })
    if (direct.error) throw new Error(`couldn't start ${command[0]}: ${direct.error.message}`)
    return direct.status ?? 1
  }
  if (!process.stdin.isTTY) {
    throw new Error('run needs a terminal')
  }
  const args = runArgs(command, { env: process.env, cwd: process.cwd(), platform: process.platform, id: randomBytes(2).toString('hex') })
  const tmux = spawnSync('tmux', args, { stdio: 'inherit' })
  if (tmux.error) {
    throw new Error(`couldn't start tmux: ${tmux.error.message}. Install tmux 3.2 or later.`)
  }
  return tmux.status ?? 1
}
