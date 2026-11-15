// `decision-center hook <agent>`: runs on every hook call of every session, so
// it stays small, never reads before it writes, and never fails the agent.
import { closeSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { sessionFileName, toEvent, type HookEvent } from './events.ts'
import { homeDir, sessionsDir } from './home.ts'
import { originatorOf, sessionStartText } from './reply-line.ts'

const STDIN_LIMIT_MS = 3000
// Why this size: the first line of a Codex transcript holds the session's base instructions, about 22 kB in Codex 0.169.
const FIRST_LINE_LIMIT = 1024 * 1024

/** One line per call, one write, O_APPEND: concurrent hooks of one session never lose a line. */
export function appendEvent(home: string, event: HookEvent): void {
  const dir = sessionsDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fd = openSync(join(dir, sessionFileName(event.agent, event.sessionId)), 'a', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`)
  } finally {
    closeSync(fd)
  }
}

/** The first line of a file, or null when the file is missing, unreadable or has no line end within the limit. */
function firstLine(path: string | null): string | null {
  if (!path) {
    return null
  }
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(FIRST_LINE_LIMIT)
      let length = 0
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null)
        const end = buffer.subarray(length, length + read).indexOf(10)
        if (end >= 0) {
          return buffer.toString('utf8', 0, length + end)
        }
        if (read === 0) {
          return null
        }
        length += read
      }
      return null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Records one hook call, then exits 0, whatever happened. It prints nothing,
 * except the reply-line rule when an interactive session starts.
 */
export function runHook(agent: string | undefined): void {
  setTimeout(() => process.exit(0), STDIN_LIMIT_MS).unref()
  const record = async () => {
    if (agent !== 'claude' && agent !== 'codex') {
      return
    }
    const event = toEvent(agent, JSON.parse(await readStdin()), { env: process.env, ppid: process.ppid, now: Date.now() })
    if (!event) {
      return
    }
    appendEvent(homeDir(), event)
    const text = sessionStartText(agent, event.event, process.env, () => originatorOf(firstLine(event.transcriptPath) ?? ''))
    if (text) {
      // Why writeSync: the process exits right after, and an async write could be cut off.
      writeSync(1, text)
    }
  }
  record()
    .catch(() => undefined)
    .finally(() => process.exit(0))
}
