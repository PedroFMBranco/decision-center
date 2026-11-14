// Decision Center HTTP contract, frozen by the walking skeleton (issue 0013).
// The feed store, reply sender and UI port slices build against it in
// parallel. Changing a shape here means updating all three.
//
// Transport: the plugin worker serves http://127.0.0.1:<DEFAULT_PORT>. Every
// POST must carry `Content-Type: application/json`, and requests whose Host
// or Origin isn't this server are refused (blocks CSRF and DNS rebinding,
// since the API can type into terminals).

export const API_VERSION = 1
export const DEFAULT_PORT = 47823

export type AgentType = 'claude' | 'codex'

/** Orca's raw pane state (`agent-status-types.ts`). */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/**
 * What the item asks of you. `question` and `permission` group under
 * "Waiting on you", `finished` under "Finished", `closed` under "Session
 * closed". A Codex question can be `kind: 'question'` while Orca says
 * `state: 'done'` (issue 0012).
 */
export type FeedKind = 'question' | 'permission' | 'finished' | 'closed'

export interface FeedOption {
  /** 1-based digit sent to the agent to pick this option. */
  index: number
  label: string
  description?: string
}

export interface FeedQuestion {
  title: string
  /** Claude's short tab label for the question, when it has one. */
  header?: string
  multiSelect: boolean
  /** Empty for title-only questions: answer them with free text. */
  options: FeedOption[]
  /** The other questions asked in the same picker, in order (issue 0022). */
  more?: FeedQuestion[]
}

export interface FeedPermission {
  toolName: string
  /** One-line human summary of what the agent wants to run or change. */
  summary: string
}

export interface FeedItem {
  /** Orca paneKey, `<tabId>:<leafId>`. Stable for the life of the pane. */
  id: string
  agent: AgentType
  kind: FeedKind
  /** Orca's state, or `closed` once the pane is gone. */
  state: AgentState | 'closed'
  worktreeId: string
  worktreeName: string
  /** Task title, pane display name, or the first line of the first prompt. */
  title: string
  /** The last prompt you sent this session, if known. */
  prompt: string | null
  /** Raw markdown of the agent's last message. */
  lastMessage: string | null
  question: FeedQuestion | null
  permission: FeedPermission | null
  /** Up to 3 proposed replies for finished turns (issue 0009). */
  proposals: string[]
  /** True when no proposals parsed and `POST /api/suggest` can make some. */
  canSuggest: boolean
  /** Epoch ms the pane entered its current state. */
  since: number
  /** Epoch ms of the last change to this item. */
  updatedAt: number
  unread: boolean
}

/**
 * `GET /api/feed` returns this. Items are already filtered (no `working`
 * panes, no dismissed items, top-level Claude/Codex panes only) and sorted:
 * question/permission first, then finished, then closed, newest first.
 */
export interface FeedSnapshot {
  version: typeof API_VERSION
  items: FeedItem[]
  unreadCount: number
  generatedAt: number
}

/**
 * `GET /api/stream` is a Server-Sent Events stream. It sends one `feed` event
 * with a full FeedSnapshot on connect and after every change, and a comment
 * line every 25 s to keep the connection open.
 */
export const STREAM_EVENT_FEED = 'feed'

/** `POST /api/reply` body. */
export interface ReplyRequest {
  id: string
  reply:
    | { type: 'text'; text: string }
    /** 1-based option indexes; more than one only for multi-select. */
    | { type: 'option'; indexes: number[] }
    /** A question with several parts: one list of option indexes per part, in order. */
    | { type: 'answers'; answers: number[][] }
    /** A permission ask. The note goes to the agent with the decision (issue 0021). */
    | { type: 'permission'; allow: boolean; note?: string }
}

/**
 * A reply that didn't go through, kept on this Mac only (plugin storage, the
 * latest 50). `GET /api/failures` lists them newest first; `POST
 * /api/failures/clear` empties the list.
 */
export interface ReplyFailure {
  /** Unique per failure. */
  id: string
  at: number
  itemId: string
  agent: AgentType | null
  kind: FeedKind | null
  /** `worktree / title` of the item, when it was still in the feed. */
  where: string | null
  reply: ReplyRequest['reply']
  code: ApiErrorCode
  message: string
  /** Keys typed into the pane before it failed, escaped. Empty: the pane wasn't touched. */
  keysSent: string[]
  /** The bottom of the last pane screen the sender read, or null if it read none. */
  screen: string[] | null
  /** Unsent text in the pane's composer at that moment, which the screen lines don't show. */
  draft: string | null
}

export interface FailuresResponse {
  ok: true
  failures: ReplyFailure[]
}

/** `POST /api/read` marks an item read. */
export interface ReadRequest {
  id: string
}

/** `POST /api/dismiss` hides one item, or every finished item. */
export type DismissRequest = { id: string } | { allFinished: true }

/** `POST /api/open` focuses the item's pane in Orca. */
export interface OpenRequest {
  id: string
}

/** `POST /api/suggest` asks a cheap model for proposals (issue 0009). */
export interface SuggestRequest {
  id: string
}

export interface SuggestResponse {
  ok: true
  proposals: string[]
}

export type ApiErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'session_closed'
  | 'terminal_rejected'
  | 'cli_failed'

export interface ApiError {
  ok: false
  error: { code: ApiErrorCode; message: string }
}

/** Response to every POST except `/api/suggest`. */
export type ActionResponse = { ok: true } | ApiError

/** `GET /api/health`. */
export interface HealthResponse {
  ok: true
  version: typeof API_VERSION
  pid: number
  startedAt: number
}
