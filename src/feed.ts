import type { AgentState, AgentType, FeedItem, FeedKind, FeedSnapshot } from './contract.ts'
import { API_VERSION } from './contract.ts'
import type { PsAgent, PsWorktree } from './cli.ts'
import type { FeedQuestion } from './contract.ts'
import { parseProposals } from './proposals.ts'
import { parseInteractivePrompt, type LastStatusEntry } from './sources.ts'

const GROUP_ORDER: Record<FeedKind, number> = { question: 0, permission: 0, finished: 1, closed: 2 }

function firstLine(text: string | null | undefined, max = 80): string {
  const line = (text ?? '').trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Orca's own question-tool test (agent-question-answered-intent.js). */
function isQuestionTool(name: string | null | undefined): boolean {
  const normalized = (name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput'
}

/** What the store knows about a pane beyond `worktree ps`. */
export interface PaneContext {
  entry?: LastStatusEntry
  /** Pending Codex question from the transcript, for a `done` Codex pane. */
  codexQuestion?: FeedQuestion | null
}

function classify(
  agent: PsAgent,
  context: PaneContext
): Pick<FeedItem, 'kind' | 'question' | 'permission'> | null {
  if (agent.state === 'done') {
    return context.codexQuestion
      ? { kind: 'question', question: context.codexQuestion, permission: null }
      : { kind: 'finished', question: null, permission: null }
  }
  if (agent.state !== 'waiting' && agent.state !== 'blocked') {
    return null
  }
  // Why: the hook file keeps the last payload even after the pane moved on,
  // so only trust its prompt while it describes the same state.
  const payload = context.entry?.payload?.state === agent.state ? context.entry.payload : undefined
  const { question, permission } = parseInteractivePrompt(payload?.interactivePrompt)
  if (question) {
    return { kind: 'question', question, permission: null }
  }
  if (permission) {
    return { kind: 'permission', question: null, permission }
  }
  const toolName = payload?.toolName ?? agent.toolName ?? null
  if (agent.state === 'waiting' && isQuestionTool(toolName)) {
    const title = firstLine(agent.lastAssistantMessage, 200) || 'Question'
    return { kind: 'question', question: { title, multiSelect: false, options: [] }, permission: null }
  }
  return {
    kind: 'permission',
    question: null,
    permission: { toolName: toolName ?? 'unknown tool', summary: firstLine(payload?.toolInput ?? agent.toolInput, 200) }
  }
}

/** A top-level Claude or Codex pane that isn't working, as a feed item. */
export function itemFromAgent(worktree: PsWorktree, agent: PsAgent, context: PaneContext = {}): FeedItem | null {
  if (agent.parentPaneKey || (agent.agentType !== 'claude' && agent.agentType !== 'codex')) {
    return null
  }
  const classified = classify(agent, context)
  if (!classified) {
    return null
  }
  // Questions answer with their own options; only finished turns get proposals.
  const finished = classified.kind === 'finished'
  const proposals = finished ? parseProposals(agent.lastAssistantMessage) : []
  return {
    id: agent.paneKey,
    agent: agent.agentType as AgentType,
    ...classified,
    state: agent.state as AgentState,
    worktreeId: worktree.worktreeId,
    worktreeName: worktree.displayName || basename(worktree.path),
    title: agent.taskTitle || agent.displayName || firstLine(agent.prompt) || 'Untitled session',
    prompt: agent.prompt,
    lastMessage: agent.lastAssistantMessage,
    proposals,
    canSuggest: finished && !proposals.length && !!agent.lastAssistantMessage?.trim(),
    since: agent.stateStartedAt,
    updatedAt: agent.updatedAt,
    unread: true
  }
}

/**
 * Identifies one waiting episode of a pane. Read and dismissed flags hold the
 * key they were set for, so a new episode shows up unread again (issue 0006).
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
