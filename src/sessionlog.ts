import { open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HookEvent } from './events.ts'
import { reduce, type Session } from './session.ts'

function isHookEvent(value: unknown): value is HookEvent {
  const event = value as HookEvent | null
  return (
    event?.v === 1 &&
    (event.agent === 'claude' || event.agent === 'codex') &&
    typeof event.event === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.at === 'number'
  )
}

interface Tail {
  /** Bytes reduced so far; always just after a newline. */
  offset: number
  session: Session | undefined
}

/** Tails every `<agent>-<session>.jsonl` the hook writes and reduces new lines into sessions. */
export class SessionLog {
  private readonly dir: string
  private readonly tails = new Map<string, Tail>()

  constructor(dir: string) {
    this.dir = dir
  }

  private async read(name: string): Promise<void> {
    const path = join(this.dir, name)
    let tail = this.tails.get(name) ?? { offset: 0, session: undefined }
    const { size } = await stat(path)
    if (size < tail.offset) {
      tail = { offset: 0, session: undefined }
    }
    this.tails.set(name, tail)
    if (size === tail.offset) {
      return
    }
    const buffer = Buffer.alloc(size - tail.offset)
    const handle = await open(path, 'r')
    try {
      await handle.read(buffer, 0, buffer.length, tail.offset)
    } finally {
      await handle.close()
    }
    // Why: a hook may be mid-write; its line is read once its newline lands.
    const end = buffer.lastIndexOf(0x0a)
    if (end < 0) {
      return
    }
    tail.offset += end + 1
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (isHookEvent(event)) {
        tail.session = reduce(tail.session, event)
      }
    }
  }

  /** Every session seen, after reducing what was appended since the last call. */
  async refresh(): Promise<Session[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
    for (const name of this.tails.keys()) {
      if (!names.includes(name)) {
        this.tails.delete(name)
      }
    }
    for (const name of names) {
      await this.read(name).catch(() => this.tails.delete(name))
    }
    return [...this.tails.values()].flatMap((tail) => (tail.session ? [tail.session] : []))
  }

  /** Deletes session files with no event for `maxAgeMs`. */
  async prune(now: number, maxAgeMs: number): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const path = join(this.dir, name)
      const info = await stat(path).catch(() => null)
      if (name.endsWith('.jsonl') && info && info.mtimeMs < now - maxAgeMs) {
        await unlink(path).catch(() => undefined)
      }
    }
  }
}

/** Why the pid too: `/clear` keeps the process, while a child agent started from the pane's shell does not. */
const runKey = (session: Session) =>
  session.pane && session.pid !== null ? `${session.pane.socket}\0${session.pane.id}\0${session.pid}` : null

export interface SessionView {
  /** Sessions still running, at most one per pane and process. */
  live: Session[]
  /** Sessions a newer running session replaced in the same pane and process. They leave the feed without a closed item. */
  replaced: Set<string>
}

/** Why the newest wins: `/clear` starts a new session in the same process, and the old one is over, not closed. */
export function viewSessions(sessions: Session[], alive: (session: Session) => boolean): SessionView {
  const running = sessions.filter((session) => !session.ended && alive(session))
  const newest = new Map<string, Session>()
  for (const session of running) {
    const key = runKey(session)
    const held = key ? newest.get(key) : undefined
    if (key && (!held || held.updatedAt < session.updatedAt)) {
      newest.set(key, session)
    }
  }
  const winner = (session: Session) => {
    const key = runKey(session)
    return key ? newest.get(key) : undefined
  }
  return {
    live: running.filter((session) => (winner(session) ?? session) === session),
    replaced: new Set(sessions.filter((session) => winner(session) && winner(session) !== session).map((session) => session.id))
  }
}
