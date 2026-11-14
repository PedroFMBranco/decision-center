import { open, stat } from 'node:fs/promises'
import type { FeedOption, FeedQuestion } from './contract.ts'

// A pending question sits at the end of the rollout, so the tail is enough.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

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
export function questionFromArgs(args: { questions?: unknown } | null | undefined): FeedQuestion | null {
  const list: unknown[] = Array.isArray(args?.questions) ? args.questions : []
  const [first, ...rest] = list.filter((raw): raw is RawQuestion => !!raw && typeof raw === 'object')
  if (!first) {
    return null
  }
  const question = partFromRaw(first)
  return rest.length ? { ...question, more: rest.map(partFromRaw) } : question
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
  async pendingQuestion(path: string): Promise<FeedQuestion | null> {
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
