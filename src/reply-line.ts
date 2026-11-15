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
 * Why only an interactive Claude session: stdout of a SessionStart hook
 * becomes context for the model. A scripted run (`claude -p`, an SDK agent)
 * must not get the rule, because its output is read by a program. Claude Code
 * names the interactive CLI in `CLAUDE_CODE_ENTRYPOINT`; anything else gets
 * nothing. Codex gives a hook no way to tell its terminal UI from `codex exec`,
 * so Codex sessions get nothing.
 */
export function sessionStartText(
  agent: AgentType,
  event: string,
  env: { CLAUDE_CODE_ENTRYPOINT?: string; DECISION_CENTER_REPLY_LINE?: string }
): string | null {
  if (event !== 'SessionStart' || agent !== 'claude') {
    return null
  }
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || env.DECISION_CENTER_REPLY_LINE === 'off') {
    return null
  }
  return REPLY_LINE_INSTRUCTION
}
