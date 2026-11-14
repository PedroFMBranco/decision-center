import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TerminalError, type TerminalScreen } from './terminal.ts'

// The worker runs as Orca's own Electron binary (ELECTRON_RUN_AS_NODE), so
// the bundled CLI sits next to it. Orca started from the Dock has a bare
// PATH, so don't rely on /usr/local/bin being there.
function resolveOrcaBin(): string {
  const candidates = [
    join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca'),
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    '/usr/local/bin/orca'
  ]
  return candidates.find((path) => existsSync(path)) ?? 'orca'
}

const ORCA_BIN = resolveOrcaBin()


/** Runs `orca <args> --json` and returns its `result`. */
export function orca<T>(args: string[], timeoutMs = 15_000): Promise<T> {
  const env = { ...process.env }
  // Why: the CLI launches Electron itself; an inherited flag would change how.
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    execFile(
      ORCA_BIN,
      [...args, '--json'],
      { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        let parsed: { ok?: boolean; result?: T; error?: { code?: string; message?: string } }
        try {
          parsed = JSON.parse(stdout)
        } catch {
          reject(new TerminalError(error?.message ?? 'orca CLI returned no JSON', 'cli_failed'))
          return
        }
        if (parsed.ok) {
          resolve(parsed.result as T)
        } else {
          reject(
            new TerminalError(
              parsed.error?.message ?? 'orca CLI failed',
              parsed.error?.code ?? 'cli_failed'
            )
          )
        }
      }
    )
  })
}

export interface PsAgent {
  paneKey: string
  parentPaneKey: string | null
  state: string
  agentType: string
  prompt: string | null
  taskTitle: string | null
  displayName: string | null
  lastAssistantMessage: string | null
  toolName?: string | null
  /** Raw tool argument, capped at 160 chars by Orca. */
  toolInput?: string | null
  stateStartedAt: number
  updatedAt: number
}

export interface PsWorktree {
  worktreeId: string
  path: string
  displayName: string | null
  isActive: boolean
  agents: PsAgent[]
}

export interface TerminalInfo {
  handle: string
  tabId: string
  leafId: string
  writable: boolean
}

export async function worktreePs(): Promise<PsWorktree[]> {
  const result = await orca<{ worktrees: PsWorktree[] }>(['worktree', 'ps'])
  return result.worktrees
}

export async function terminalList(): Promise<TerminalInfo[]> {
  const result = await orca<{ terminals: TerminalInfo[] }>(['terminal', 'list'])
  return result.terminals
}

export async function terminalHandleForPane(paneKey: string): Promise<TerminalInfo | undefined> {
  const terminals = await terminalList()
  return terminals.find((terminal) => `${terminal.tabId}:${terminal.leafId}` === paneKey)
}

/** Types `text` and/or presses Enter in a terminal. */
export async function terminalSend(handle: string, input: { text?: string; enter?: boolean }): Promise<void> {
  const args = ['terminal', 'send', '--terminal', handle]
  if (input.text !== undefined) {
    args.push('--text', input.text)
  }
  if (input.enter) {
    args.push('--enter')
  }
  await orca(args)
}

/**
 * Reads what the terminal renders. Why: the default stream read of a
 * repainting TUI is garbled and can miss the picker entirely (issue 0004).
 */
export async function terminalScreen(handle: string): Promise<TerminalScreen> {
  const result = await orca<{ terminal: { tail?: string[]; draft?: string | null; source?: string } }>([
    'terminal',
    'read',
    '--terminal',
    handle,
    '--screen'
  ])
  if (result.terminal.source !== 'screen') {
    // Why: some live panes keep no screen in Orca, so every retry fails the
    // same way (issue 0028).
    throw new TerminalError(
      "Orca has no screen for this pane, so the reply can't be checked; reply in the pane",
      'screen_unavailable'
    )
  }
  return { lines: result.terminal.tail ?? [], draft: result.terminal.draft || null }
}

/** Shows the terminal's tab in Orca. */
export async function terminalSwitch(handle: string): Promise<void> {
  await orca(['terminal', 'switch', '--terminal', handle])
}

/** Opens `url` in a browser tab of the worktree you're looking at. */
export async function openBrowserTab(url: string): Promise<void> {
  // Why: the `active` selector means "the worktree containing cwd", and the
  // worker's cwd isn't in one. `worktree ps` flags the focused worktree.
  const focused = (await worktreePs()).find((worktree) => worktree.isActive)
  if (!focused) {
    throw new TerminalError('no focused Orca worktree to open the tab in', 'selector_not_found')
  }
  await orca(['tab', 'create', '--worktree', `id:${focused.worktreeId}`, '--url', url])
}
