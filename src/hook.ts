// `decision-center hook <agent>`: runs on every hook call of every session, so
// it stays small, never reads before it writes, and never fails the agent.
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { sessionFileName, toEvent, type HookEvent } from './events.ts'
import { homeDir, sessionsDir } from './home.ts'

const STDIN_LIMIT_MS = 3000

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Records one hook call, then exits 0 with nothing on stdout, whatever happened. */
export function runHook(agent: string | undefined): void {
  setTimeout(() => process.exit(0), STDIN_LIMIT_MS).unref()
  const record = async () => {
    if (agent !== 'claude' && agent !== 'codex') {
      return
    }
    const event = toEvent(agent, JSON.parse(await readStdin()), { env: process.env, ppid: process.ppid, now: Date.now() })
    if (event) {
      appendEvent(homeDir(), event)
    }
  }
  record()
    .catch(() => undefined)
    .finally(() => process.exit(0))
}
