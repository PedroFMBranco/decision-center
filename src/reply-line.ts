// The rule the hook hands to a session when it starts, so the agent ends its
// turns with a line of replies the feed can show as buttons. The hook bundle
// imports this file, so it may import only `node:` builtins and types.
import type { AgentType } from './contract.ts'

export const REPLY_LINE_INSTRUCTION = `Decision Center shows this session to the user in a feed, with buttons that send a reply in one click.
When you end a turn and wait for the user, make the last line of your message a list of the replies the user is most likely to send next, in exactly this form:
Replies: "first reply" | "second reply" | "third reply"
Rules for that line:
- Give 1 to 3 replies, the most likely first.
- Write each reply as the user's own words to you, as an instruction you can act on without the rest of your message. "Tag 0.3.0 and push it", not "tag" and not "say tag to continue".
- Keep each reply under 80 characters, with no double quotes inside it.
- Put it after everything else, including any closing line you normally write. Do not mention it.
- Leave the line out when you ask the user a question through a tool, or when no reply is more likely than any other.
`

/**
 * What the hook prints for this call, or null for nothing.
 *
 * Why only an interactive session: stdout of a SessionStart hook becomes
 * context for the model. A scripted run (`claude -p`, `codex exec`, an SDK
 * agent) must not get the rule, because its output is read by a program.
 * Claude Code names the interactive CLI in `CLAUDE_CODE_ENTRYPOINT`. Codex
 * says nothing in the payload or the environment, so the caller reads who
 * started the session from its transcript. Anything but a known interactive
 * program gets nothing.
 */
export function sessionStartText(
  agent: AgentType,
  event: string,
  env: { CLAUDE_CODE_ENTRYPOINT?: string; DECISION_CENTER_REPLY_LINE?: string },
  codexTerminalUi: () => boolean
): string | null {
  if (event !== 'SessionStart' || env.DECISION_CENTER_REPLY_LINE === 'off') {
    return null
  }
  const interactive = agent === 'claude' ? env.CLAUDE_CODE_ENTRYPOINT === 'cli' : codexTerminalUi()
  return interactive ? REPLY_LINE_INSTRUCTION : null
}

/**
 * Whether a person started this Codex session in the terminal UI, read from
 * the transcript's first line, which Codex writes when it creates the session.
 *
 * Why `thread_source` too: a thread the UI starts for itself (a subagent, a
 * review) keeps the UI's `originator`, and its output is read by an agent.
 */
export function startedInCodexTerminalUi(firstLine: string): boolean {
  try {
    const meta = JSON.parse(firstLine)?.payload
    return meta?.originator === 'codex-tui' && meta?.thread_source === 'user'
  } catch {
    return false
  }
}
