import type { AgentType, FeedPermission, FeedQuestion } from './contract.ts'
import { isQuestionTool, type HookEvent, type PaneRef, type ToolCall } from './events.ts'
import { questionFromArgs } from './sources.ts'

/** `idle`: no turn has finished yet in this session. */
export type Turn = 'idle' | 'working' | 'done'

export type Ask =
  | { kind: 'question'; question: FeedQuestion; key: string; actor: string | null; at: number }
  | { kind: 'permission'; permission: FeedPermission; key: string; actor: string | null; at: number }

export interface Session {
  /** `${agent}:${sessionId}`, the feed item id. */
  id: string
  agent: AgentType
  cwd: string
  transcriptPath: string | null
  /** Claude only, from the hook env. A Codex session is bound to a pane by the server. */
  pane: PaneRef | null
  /** Claude only: the agent process. */
  pid: number | null
  /** Epoch ms of the session's latest SessionStart, else its first event seen. */
  startedAt: number
  turn: Turn
  turnSince: number
  pending: Ask | null
  prompt: string | null
  lastMessage: string | null
  ended: boolean
  updatedAt: number
}

const isNotification = (prompt: string) => prompt.trimStart().startsWith('<task-notification>')

function askFor(tool: ToolCall, event: HookEvent, current: Ask | null): Ask {
  // Why: PreToolUse then PermissionRequest for one question is one waiting episode.
  const at = current?.key === tool.key ? current.at : event.at
  if (isQuestionTool(tool.name)) {
    const question = questionFromArgs({ questions: tool.questions }) ?? { title: 'Question', multiSelect: false, options: [] }
    return { kind: 'question', question, key: tool.key, actor: event.actor, at }
  }
  return { kind: 'permission', permission: { toolName: tool.name, summary: tool.summary }, key: tool.key, actor: event.actor, at }
}

function turn(session: Session, next: Turn, at: number): Pick<Session, 'turn' | 'turnSince'> {
  return { turn: next, turnSince: session.turn === next ? session.turnSince : at }
}

/** A subagent's events never move the main turn. */
const working = (s: Session, e: HookEvent) => (e.actor ? {} : turn(s, 'working', e.at))

/** One rule per hook event: the change it makes, or null to ignore the event. */
type Rule = (session: Session, event: HookEvent) => Partial<Session> | null

const RULES: Record<string, Rule> = {
  // Why startedAt moves: a resumed session runs in a newer process, and liveness checks compare the two.
  SessionStart: (_s, e) => ({ ended: false, startedAt: e.at }),
  UserPromptSubmit: (s, e) => ({
    ...turn(s, 'working', e.at),
    pending: null,
    prompt: e.prompt === undefined || isNotification(e.prompt) ? s.prompt : e.prompt
  }),
  PreToolUse: (s, e) => ({
    ...working(s, e),
    ...(e.tool && isQuestionTool(e.tool.name) ? { pending: askFor(e.tool, e, s.pending) } : {})
  }),
  PermissionRequest: (s, e) => (e.tool ? { pending: askFor(e.tool, e, s.pending) } : null),
  PostToolUse: (s, e) => ({ ...working(s, e), ...(s.pending && s.pending.key === e.tool?.key ? { pending: null } : {}) }),
  PostToolUseFailure: (s, e) => RULES.PostToolUse!(s, e),
  // Why a subagent's ask survives Stop: a background subagent can ask after the
  // main turn ends. The main agent's own ask was answered if its turn ended.
  Stop: (s, e) =>
    e.actor
      ? null
      : { turn: 'done', turnSince: e.at, lastMessage: e.lastMessage ?? null, pending: s.pending?.actor ? s.pending : null },
  StopFailure: (s, e) => RULES.Stop!(s, e),
  // Why Codex is ignored: it fires SessionEnd seconds after each turn while the TUI stays open.
  SessionEnd: (s) => (s.agent === 'claude' ? { ended: true } : null)
}

function created(event: HookEvent): Session {
  return {
    id: `${event.agent}:${event.sessionId}`,
    agent: event.agent,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    pane: event.pane,
    pid: event.pid,
    startedAt: event.at,
    turn: 'idle',
    turnSince: event.at,
    pending: null,
    prompt: null,
    lastMessage: null,
    ended: false,
    updatedAt: event.at
  }
}

/** Folds one hook event into its session. Pure. */
export function reduce(session: Session | undefined, event: HookEvent): Session {
  const base = session ?? created(event)
  const change = RULES[event.event]?.(base, event)
  if (!change) {
    return base
  }
  return {
    ...base,
    cwd: event.cwd || base.cwd,
    transcriptPath: event.transcriptPath ?? base.transcriptPath,
    pane: event.pane ?? base.pane,
    pid: event.pid ?? base.pid,
    ...change,
    updatedAt: Math.max(base.updatedAt, event.at)
  }
}
