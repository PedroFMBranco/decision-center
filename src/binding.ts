// A Codex hook runs in a shared daemon, so it can't say which pane its session
// is in. The server finds the pane from the `codex` process on the pane's tty.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { PaneRef } from './events.ts'
import type { Session } from './session.ts'
import type { TmuxPane } from './tmux.ts'

export interface Proc {
  pid: number
  /** `/dev/ttys003`, or null for a process with no terminal. */
  tty: string | null
  /** Epoch ms, to the second. */
  startedAt: number
  name: string
}

export interface Binding {
  pane: PaneRef
  pid: number
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      // lsof exits 1 when one of several pids is gone, with the rest still printed.
      error && !stdout ? reject(error) : resolve(stdout)
    )
  })
}

export async function listProcesses(): Promise<Proc[]> {
  const out = await run('ps', ['-A', '-o', 'pid=,tty=,lstart=,comm='])
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.+)$/.exec(line)
    if (!match) {
      return []
    }
    const [, pid, tty, started, command] = match as unknown as [string, string, string, string, string]
    return [{
      pid: Number(pid),
      tty: tty === '??' || tty === '?' ? null : `/dev/${tty}`,
      startedAt: Date.parse(started),
      name: basename(command.trim())
    }]
  })
}

/**
 * Whether a Claude session still runs in a terminal. Claude's hook names its
 * process. A process that started after the session did is a reused pid. One
 * with no terminal is a headless run (`claude -p`, an SDK agent), which nobody
 * can reply to, so it stays out of the feed.
 */
export function claudeInteractive(session: Session, procs: Proc[] | null): boolean {
  if (!procs || session.pid === null) {
    return true
  }
  const proc = procs.find((candidate) => candidate.pid === session.pid)
  return !!proc && proc.startedAt <= session.startedAt && proc.tty !== null
}

/** The working folder of each pid that still runs. */
export async function processCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  if (!pids.length) {
    return cwds
  }
  const out = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'])
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

export interface CodexProc extends Proc {
  cwd: string
}

const paneKey = (pane: PaneRef) => `${pane.socket}\0${pane.id}`

/**
 * Binds live Codex sessions to tmux panes and says which Codex sessions have
 * no process left. A process can only be a session's if it started before
 * the session's first event and runs in the session's folder.
 */
export function bindCodex(input: {
  sessions: Session[]
  previous: Map<string, Binding>
  codex: CodexProc[]
  panes: TmuxPane[]
}): { bindings: Map<string, Binding>; dead: Set<string> } {
  const panesByKey = new Map(input.panes.filter((pane) => !pane.dead).map((pane) => [paneKey(pane), pane]))
  const running = new Set(input.codex.map((proc) => proc.pid))
  const bindings = new Map<string, Binding>()
  const dead = new Set<string>()
  const sessions = input.sessions.filter((session) => session.agent === 'codex').sort((a, b) => a.startedAt - b.startedAt)
  // Why a terminal is required: the shared app-server daemon is a codex process too.
  const ownProcs = (session: Session) =>
    input.codex.filter((proc) => proc.tty && proc.cwd === session.cwd && proc.startedAt <= session.startedAt)

  for (const session of sessions) {
    const kept = input.previous.get(session.id)
    if (kept && running.has(kept.pid) && panesByKey.has(paneKey(kept.pane))) {
      bindings.set(session.id, kept)
    } else if (!ownProcs(session).length) {
      dead.add(session.id)
    }
  }

  const paneOf = (session: Session) => (session.agent === 'codex' ? bindings.get(session.id)?.pane : session.pane)
  // Why only sessions active since this one started: one idle since then may be
  // the session this one replaced in the same process (Codex /new).
  const held = (key: string, by: Session) =>
    input.sessions.some((other) => {
      const pane = other === by || dead.has(other.id) || other.updatedAt <= by.startedAt ? undefined : paneOf(other)
      return pane && paneKey(pane) === key
    })

  const byTty = new Map(input.panes.filter((pane) => !pane.dead).map((pane) => [pane.tty, pane]))
  for (const session of sessions) {
    if (bindings.has(session.id) || dead.has(session.id)) {
      continue
    }
    const candidates = ownProcs(session).flatMap((proc) => {
      const pane = proc.tty ? byTty.get(proc.tty) : undefined
      return pane && !held(paneKey(pane), session) ? [{ proc, pane }] : []
    })
    const latest = Math.max(...candidates.map(({ proc }) => proc.startedAt))
    const best = candidates.filter(({ proc }) => proc.startedAt === latest)
    if (best.length === 1) {
      bindings.set(session.id, { pane: { socket: best[0]!.pane.socket, id: best[0]!.pane.id }, pid: best[0]!.proc.pid })
    }
  }
  return { bindings, dead }
}
