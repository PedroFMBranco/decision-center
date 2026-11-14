import type { FeedItem, FeedKind, FeedQuestion, FeedSnapshot } from './contract.ts'
import { API_VERSION } from './contract.ts'
import { parseProposals } from './proposals.ts'
import type { Ask, Session } from './session.ts'

const GROUP_ORDER: Record<FeedKind, number> = { question: 0, permission: 0, finished: 1, closed: 2 }

function firstLine(text: string | null | undefined, max = 80): string {
  const line = (text ?? '').trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** What the store knows about a session beyond its events. */
export interface SessionContext {
  /** The session's ask, unless its pane shows it was answered without a hook. */
  pending: Ask | null
  /** A Codex question read from the transcript, for a Codex session whose turn is done. */
  codexQuestion?: FeedQuestion | null
  /**
   * When the main agent's ask was denied or cancelled in the pane. No hook
   * fires for that, and the agent then waits at its composer like a finished turn.
   */
  cancelledAt?: number
  /** A turn that ended with no hook, and what the pane says about it (a failure or an interruption). */
  stopped?: { at: number; notice: string }
}

type Classified = Pick<FeedItem, 'kind' | 'state' | 'question' | 'permission' | 'since'>

function classify(session: Session, context: SessionContext): Classified | null {
  const { pending } = context
  if (pending?.kind === 'question') {
    return { kind: 'question', state: 'waiting', question: pending.question, permission: null, since: pending.at }
  }
  if (pending?.kind === 'permission') {
    return { kind: 'permission', state: 'waiting', question: null, permission: pending.permission, since: pending.at }
  }
  if (context.cancelledAt !== undefined) {
    return { kind: 'finished', state: 'done', question: null, permission: null, since: context.cancelledAt }
  }
  if (context.stopped) {
    return { kind: 'finished', state: 'done', question: null, permission: null, since: context.stopped.at }
  }
  if (session.turn !== 'done') {
    return null
  }
  return context.codexQuestion
    ? { kind: 'question', state: 'done', question: context.codexQuestion, permission: null, since: session.turnSince }
    : { kind: 'finished', state: 'done', question: null, permission: null, since: session.turnSince }
}

/** A session that waits on you or finished its turn, as a feed item. Null while it works. */
export function itemFromSession(session: Session, context: SessionContext): FeedItem | null {
  const classified = classify(session, context)
  if (!classified) {
    return null
  }
  // Questions answer with their own options; only finished turns get proposals.
  const finished = classified.kind === 'finished'
  // Why the notice: the last message is from the turn before the one that stopped.
  const lastMessage = context.stopped && !context.pending ? context.stopped.notice : session.lastMessage
  const proposals = finished ? parseProposals(lastMessage) : []
  return {
    id: session.id,
    agent: session.agent,
    ...classified,
    project: basename(session.cwd) || session.cwd,
    cwd: session.cwd,
    terminal: session.pane ? { kind: 'tmux', pane: session.pane.id } : null,
    title: firstLine(session.prompt) || 'Untitled session',
    prompt: session.prompt,
    lastMessage,
    proposals,
    canSuggest: finished && !context.stopped && !proposals.length && !!lastMessage?.trim(),
    updatedAt: session.updatedAt,
    unread: true
  }
}

/**
 * Identifies one waiting episode of a session. Read and dismissed flags hold
 * the key they were set for, so a new episode shows up unread again (issue 0006).
 */
export function itemKey(item: Pick<FeedItem, 'since' | 'kind'>): string {
  return `${item.since}:${item.kind}`
}

export function snapshotOf(items: FeedItem[], now = Date.now()): FeedSnapshot {
  const sorted = [...items].sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || b.since - a.since)
  return {
    version: API_VERSION,
    items: sorted,
    unreadCount: sorted.filter((item) => item.unread).length,
    generatedAt: now
  }
}
