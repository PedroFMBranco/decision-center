// What the hook keeps from one agent hook call. The hook bundle imports this
// file, so it may import only `node:` builtins and types.
import { createHash } from 'node:crypto'
import type { AgentType } from './contract.ts'

export interface PaneRef {
  /** tmux server socket path. */
  socket: string
  /** tmux pane id, `%3`. */
  id: string
}

export interface ToolCall {
  name: string
  /** Names one tool call across PreToolUse, PermissionRequest and PostToolUse. */
  key: string
  /** What the feed and the reply check compare with the pane's screen. */
  summary: string
  /** Question tools only: the raw `questions` list. */
  questions?: unknown
}

export interface HookEvent {
  v: 1
  at: number
  agent: AgentType
  event: string
  sessionId: string
  cwd: string
  transcriptPath: string | null
  /** Claude only. A Codex hook runs in a shared daemon, so its env names the wrong pane. */
  pane: PaneRef | null
  /** Claude only: the agent process, the hook's parent. */
  pid: number | null
  /** `agent_id` of the subagent that fired the hook, null for the main agent. */
  actor: string | null
  source?: string
  reason?: string
  prompt?: string
  lastMessage?: string
  tool?: ToolCall
}

export const PROMPT_CAP = 8 * 1024
export const MESSAGE_CAP = 64 * 1024
export const QUESTIONS_CAP = 16 * 1024
export const SUMMARY_CAP = 200

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function isQuestionTool(name: string | null | undefined): boolean {
  const normalized = (name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput'
}

export function sessionFileName(agent: AgentType, sessionId: string): string {
  return `${agent}-${sessionId}.jsonl`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const cap = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

/**
 * Why not the input as a whole: Claude's PermissionRequest has no tool-use id,
 * and Codex adds a `description` the matching Pre/PostToolUse lack. A question
 * is keyed on its questions alone, in case the answer is added to the input.
 */
export function toolKey(name: string, input: Record<string, unknown>): string {
  const id = isQuestionTool(name)
    ? stableJson(input.questions ?? null)
    : (text(input.command) ?? text(input.file_path) ?? stableJson(input))
  return createHash('sha1').update(`${name}\0${id}`).digest('hex').slice(0, 16)
}

export function toolSummary(input: Record<string, unknown>): string {
  const summary = text(input.command) ?? text(input.file_path) ?? (JSON.stringify(input).split('\n')[0] ?? '')
  return cap(summary, SUMMARY_CAP)
}

function toolCall(name: string, rawInput: unknown): ToolCall {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {}
  const call: ToolCall = { name, key: toolKey(name, input), summary: toolSummary(input) }
  if (isQuestionTool(name) && input.questions !== undefined && JSON.stringify(input.questions).length <= QUESTIONS_CAP) {
    call.questions = input.questions
  }
  return call
}

/** `TMUX` is `<socket>,<server pid>,<session>`. */
export function paneFromEnv(env: { TMUX?: string; TMUX_PANE?: string }): PaneRef | null {
  const parts = env.TMUX?.split(',') ?? []
  const socket = parts.slice(0, -2).join(',')
  return socket && env.TMUX_PANE ? { socket, id: env.TMUX_PANE } : null
}

/** Picks the fields the feed needs from one hook payload. Null when the payload isn't one. */
export function toEvent(
  agent: AgentType,
  payload: unknown,
  context: { env: { TMUX?: string; TMUX_PANE?: string }; ppid: number; now: number }
): HookEvent | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const body = payload as Record<string, unknown>
  const sessionId = text(body.session_id)
  const event = text(body.hook_event_name)
  if (!sessionId || !SAFE_ID.test(sessionId) || !event) {
    return null
  }
  const claude = agent === 'claude'
  const result: HookEvent = {
    v: 1,
    at: context.now,
    agent,
    event,
    sessionId,
    cwd: text(body.cwd) ?? '',
    transcriptPath: text(body.transcript_path) ?? null,
    pane: claude ? paneFromEnv(context.env) : null,
    pid: claude && context.ppid > 1 ? context.ppid : null,
    actor: text(body.agent_id) ?? null
  }
  const source = text(body.source)
  const reason = text(body.reason)
  const prompt = text(body.prompt)
  const lastMessage = text(body.last_assistant_message)
  const tool = text(body.tool_name)
  if (source !== undefined) result.source = source
  if (reason !== undefined) result.reason = reason
  if (prompt !== undefined) result.prompt = cap(prompt, PROMPT_CAP)
  if (lastMessage !== undefined) result.lastMessage = cap(lastMessage, MESSAGE_CAP)
  if (tool) result.tool = toolCall(tool, body.tool_input)
  return result
}
