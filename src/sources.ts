import { open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FeedOption, FeedPermission, FeedQuestion } from './contract.ts'

// Orca's hook listener keeps the latest hook payload per pane here. It's the
// only place question options and permission summaries live (issue 0011).
const LAST_STATUS_PATH = join(homedir(), 'Library', 'Application Support', 'orca', 'agent-hooks', 'last-status.json')
// A pending question sits at the end of the rollout, so the tail is enough.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

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

function partFromRaw(raw: RawQuestion): FeedQuestion {
  const title = (raw.question ?? raw.title ?? raw.header ?? '').trim()
  const options: FeedOption[] = (raw.options ?? []).flatMap((option, i) => {
    const label = typeof option === 'string' ? option : option?.label
    if (!label) {
      return []
    }
    const description = typeof option === 'string' ? undefined : option.description
    return [{ index: i + 1, label, ...(description ? { description } : {}) }]
  })
  const header = raw.header?.trim()
  return { title: title || 'Question', ...(header ? { header } : {}), multiSelect: raw.multiSelect === true, options }
}

/**
 * Claude's AskUserQuestion input and Codex's request_user_input share this
 * shape, near enough. The first question carries the rest in `more`.
 */
export function questionFromArgs(args: { questions?: RawQuestion[] } | null | undefined): FeedQuestion | null {
  const [first, ...rest] = (args?.questions ?? []).filter(Boolean)
  if (!first) {
    return null
  }
  const question = partFromRaw(first)
  return rest.length ? { ...question, more: rest.map(partFromRaw) } : question
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

/** Reads Codex transcripts, re-reading a file only when it has grown or changed. */
export class CodexTranscripts {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; question: FeedQuestion | null }>()
  async pendingQuestion(entry: LastStatusEntry | undefined): Promise<FeedQuestion | null> {
    if (!entry) {
      return null
    }
    const path = entry.providerSession?.transcriptPath
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
