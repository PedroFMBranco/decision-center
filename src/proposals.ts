import type { FeedItem } from './contract.ts'

// Issue 0009: at most 3 proposals, a longer list is cut to its first 3.
export const MAX_PROPOSALS = 3

// `Next:`, `**Next:**`, `Next steps:`, at the start of a line (or bullet) or
// after a sentence ("Tests pass. Next: open the PR").
const NEXT_LINE = /(?:^\s*(?:[-*]\s+)?|[.!?]\s+)[*_]{0,2}next(?:\s+steps?)?[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.*)$/i
// A top-level numbered item. Indented ones belong to the item above.
const NUMBERED = /^(\d{1,2})[.)]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/

/** Drops markdown emphasis and collapses whitespace; keeps `code`. */
function clean(text: string): string {
  return text
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function nextLine(lines: string[]): string[] {
  // Why the last paragraph only: a `Next:` earlier in the message is usually
  // a step that already happened.
  const start = lines.findLastIndex((line) => !line.trim()) + 1
  for (const line of lines.slice(start).reverse()) {
    const text = clean(NEXT_LINE.exec(line)?.[1] ?? '')
    if (text) {
      return [text]
    }
  }
  return []
}

/**
 * The heads of a numbered list that ends the message. One closing question
 * line after it ("Which one?") still counts as ending it.
 */
function closingList(lines: string[]): string[] {
  let list: string[] | null = null
  let lastList: string[] | null = null
  let after: string[] = []
  let inFence = false
  for (const line of lines) {
    const fence = FENCE.test(line)
    const numbered = !inFence && !fence ? NUMBERED.exec(line) : null
    if (fence) {
      inFence = !inFence
    }
    if (numbered) {
      if (!list) {
        // Why start at 1: a stray "3." mid-prose isn't a list of options.
        if (numbered[1] !== '1') {
          continue
        }
        list = []
        lastList = null
        after = []
      }
      list.push(clean(numbered[2] ?? ''))
    } else if (!line.trim() || (list && /^\s/.test(line))) {
      // Blank lines and indented continuations keep the list open.
    } else {
      if (list) {
        lastList = list
        list = null
      }
      after.push(line)
    }
  }
  const items = list ?? (after.length === 1 && after[0]!.trim().endsWith('?') ? lastList : null)
  return (items ?? []).filter(Boolean)
}

/** Next actions the agent already wrote at the end of its message (issue 0009). */
export function parseProposals(message: string | null | undefined): string[] {
  const lines = (message ?? '').trimEnd().split('\n')
  const found = nextLine(lines)
  return (found.length ? found : closingList(lines)).slice(0, MAX_PROPOSALS)
}

// The tail of a long message carries the ending; the model needs no more.
const MESSAGE_TAIL_CHARS = 8000
const PROMPT_HEAD_CHARS = 1000

export const SUGGEST_SYSTEM_PROMPT =
  'You propose what the user might reply to a coding agent that just finished a turn. ' +
  `Output only a JSON array of at most ${MAX_PROPOSALS} replies, each under 100 characters, ` +
  'written as the user talking to the agent: the most likely next instructions first. No other text.'

/** The stdin for the suggestion model: what you asked and how the agent ended. */
export function suggestInput(item: Pick<FeedItem, 'prompt' | 'lastMessage'>): string {
  const prompt = (item.prompt ?? '').trim().slice(0, PROMPT_HEAD_CHARS)
  const message = (item.lastMessage ?? '').trim().slice(-MESSAGE_TAIL_CHARS)
  return `${prompt ? `The user's last prompt:\n${prompt}\n\n` : ''}The agent's last message:\n${message}`
}

/** Reads the JSON array out of the model's answer, which may sit in a code fence. */
export function parseSuggestion(output: string): string[] {
  const match = /\[[\s\S]*\]/.exec(output)
  let parsed: unknown
  try {
    parsed = JSON.parse(match?.[0] ?? '')
  } catch {
    throw new Error('the model did not return a list of replies')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('the model did not return a list of replies')
  }
  return parsed
    .filter((value): value is string => typeof value === 'string')
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_PROPOSALS)
}

const CACHE_LIMIT = 200

/**
 * Asks the model once per session and message: the key is the pane id plus
 * its episode (`itemKey`), so a new turn asks again. Failures aren't cached,
 * so pressing the button again retries.
 */
export class Suggester {
  private cache = new Map<string, Promise<string[]>>()
  private readonly run: (input: string) => Promise<string>

  constructor(run: (input: string) => Promise<string>) {
    this.run = run
  }

  suggest(key: string, item: Pick<FeedItem, 'prompt' | 'lastMessage'>): Promise<string[]> {
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.run(suggestInput(item)).then(parseSuggestion)
      pending.catch(() => this.cache.delete(key))
      this.cache.set(key, pending)
      if (this.cache.size > CACHE_LIMIT) {
        this.cache.delete(this.cache.keys().next().value!)
      }
    }
    return pending
  }
}
