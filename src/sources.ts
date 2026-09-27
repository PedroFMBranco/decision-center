import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FeedOption, FeedPermission, FeedQuestion } from './contract.ts'

// Orca's hook listener keeps the latest hook payload per pane here. It's the
// only place question options and permission summaries live (issue 0011).
const LAST_STATUS_PATH = join(homedir(), 'Library', 'Application Support', 'orca', 'agent-hooks', 'last-status.json')
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
// A pending question sits at the end of the rollout, so the tail is enough.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024
// How many day folders to search for a rollout by session id, newest first.
const ROLLOUT_SEARCH_DAYS = 60

export interface LastStatusEntry {
  paneKey: string
  providerSession?: { id?: string; transcriptPath?: string } | null
  payload?: {
    state?: string
    toolName?: string | null
    toolInput?: string | null
    interactivePrompt?: string | null
  }
}

export async function readLastStatus(path = LAST_STATUS_PATH): Promise<Map<string, LastStatusEntry>> {
  let entries: Record<string, LastStatusEntry> = {}
  try {
    entries = (JSON.parse(await readFile(path, 'utf8')) as { entries?: Record<string, LastStatusEntry> }).entries ?? {}
  } catch {
    // Missing or mid-write: the feed still works from `worktree ps`, just
    // without options.
  }
  return new Map(Object.entries(entries))
}

type RawOption = string | { label?: string; description?: string }
interface RawQuestion {
  question?: string
  title?: string
  header?: string
  multiSelect?: boolean
  options?: RawOption[]
}

/** Claude's AskUserQuestion input and Codex's request_user_input share this shape, near enough. */
export function questionFromArgs(args: { questions?: RawQuestion[] } | null | undefined): FeedQuestion | null {
  const questions = args?.questions
  const first = questions?.[0]
  if (!first) {
    return null
  }
  const title = (first.question ?? first.title ?? first.header ?? '').trim()
  const options: FeedOption[] = (first.options ?? []).flatMap((option, i) => {
    const label = typeof option === 'string' ? option : option?.label
    if (!label) {
      return []
    }
    const description = typeof option === 'string' ? undefined : option.description
    return [{ index: i + 1, label, ...(description ? { description } : {}) }]
  })
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
  return { title: `${title || 'Question'}${more}`, multiSelect: first.multiSelect === true, options }
}

export interface ParsedPrompt {
  question: FeedQuestion | null
  permission: FeedPermission | null
}

/** Parses `payload.interactivePrompt`: `{questions}` for a question, `{approval}` for a permission ask. */
export function parseInteractivePrompt(raw: string | null | undefined): ParsedPrompt {
  let parsed: { questions?: RawQuestion[]; approval?: { tool?: string; summary?: string } }
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    return { question: null, permission: null }
  }
  const approval = parsed?.approval
  return {
    question: questionFromArgs(parsed),
    permission: approval?.tool ? { toolName: approval.tool, summary: approval.summary ?? '' } : null
  }
}

/**
 * Scans rollout lines newest first. A `request_user_input_async` call with no
 * user message after it is a pending question (issue 0012). Any user message,
 * including a picker answer or a free-text reply, answers it.
 */
export function pendingCodexQuestion(lines: string[]): FeedQuestion | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // Why: most lines are token counts and reasoning; skip them unparsed.
    if (!line || !line.includes('"response_item"')) {
      continue
    }
    let record: { type?: string; payload?: { type?: string; role?: string; name?: string; arguments?: string } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const payload = record.payload
    if (record.type !== 'response_item' || !payload) {
      continue
    }
    if (payload.type === 'message' && payload.role === 'user') {
      return null
    }
    if (payload.type === 'function_call' && payload.name === 'request_user_input_async') {
      try {
        return questionFromArgs(JSON.parse(payload.arguments ?? '{}'))
      } catch {
        return { title: 'Question', multiSelect: false, options: [] }
      }
    }
  }
  return null
}

async function tailLines(path: string, size: number): Promise<string[]> {
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    // Why: a window that starts mid-file starts mid-line.
    return start > 0 ? lines.slice(1) : lines
  } finally {
    await handle.close()
  }
}

async function findRollout(sessionId: string, root: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`
  let searched = 0
  const desc = async (dir: string): Promise<string[]> =>
    (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name)).sort().reverse()
  for (const year of await desc(root)) {
    for (const month of await desc(join(root, year))) {
      for (const day of await desc(join(root, year, month))) {
        const dir = join(root, year, month, day)
        const hit = (await readdir(dir).catch(() => [] as string[])).find((name) => name.endsWith(suffix))
        if (hit) {
          return join(dir, hit)
        }
        if (++searched >= ROLLOUT_SEARCH_DAYS) {
          return null
        }
      }
    }
  }
  return null
}

/** Reads Codex transcripts, re-reading a file only when it has grown or changed. */
export class CodexTranscripts {
  private readonly paths = new Map<string, string>()
  private readonly cache = new Map<string, { size: number; mtimeMs: number; question: FeedQuestion | null }>()
  private readonly sessionsDir: string

  constructor(sessionsDir = CODEX_SESSIONS_DIR) {
    this.sessionsDir = sessionsDir
  }

  private async pathFor(entry: LastStatusEntry): Promise<string | null> {
    const direct = entry.providerSession?.transcriptPath
    if (direct) {
      return direct
    }
    // Why: `transcriptPath` is verified for Claude only; Codex rollouts are
    // named after the session id, so find it by that.
    const id = entry.providerSession?.id
    if (!id) {
      return null
    }
    const known = this.paths.get(id)
    if (known) {
      return known
    }
    const found = await findRollout(id, this.sessionsDir)
    if (found) {
      this.paths.set(id, found)
    }
    return found
  }

  async pendingQuestion(entry: LastStatusEntry | undefined): Promise<FeedQuestion | null> {
    if (!entry) {
      return null
    }
    const path = await this.pathFor(entry)
    if (!path) {
      return null
    }
    try {
      const { size, mtimeMs } = await stat(path)
      const cached = this.cache.get(path)
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
        return cached.question
      }
      const question = pendingCodexQuestion(await tailLines(path, size))
      this.cache.set(path, { size, mtimeMs, question })
      return question
    } catch {
      return null
    }
  }
}
