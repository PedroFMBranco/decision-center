// src/hook.ts
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join as join2 } from "node:path";

// src/events.ts
import { createHash } from "node:crypto";
var PROMPT_CAP = 8 * 1024;
var MESSAGE_CAP = 64 * 1024;
var QUESTIONS_CAP = 16 * 1024;
var SUMMARY_CAP = 200;
var SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function isQuestionTool(name) {
  const normalized = (name ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "askuserquestion" || normalized === "requestuserinput";
}
function sessionFileName(agent, sessionId) {
  return `${agent}-${sessionId}.jsonl`;
}
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
var text = (value) => typeof value === "string" ? value : void 0;
var cap = (value, max) => value.length > max ? value.slice(0, max) : value;
function toolKey(name, input) {
  const id = isQuestionTool(name) ? stableJson(input.questions ?? null) : text(input.command) ?? text(input.file_path) ?? stableJson(input);
  return createHash("sha1").update(`${name}\0${id}`).digest("hex").slice(0, 16);
}
function toolSummary(input) {
  const summary = text(input.command) ?? text(input.file_path) ?? (JSON.stringify(input).split("\n")[0] ?? "");
  return cap(summary, SUMMARY_CAP);
}
function toolCall(name, rawInput) {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
  const call = { name, key: toolKey(name, input), summary: toolSummary(input) };
  if (isQuestionTool(name) && input.questions !== void 0 && JSON.stringify(input.questions).length <= QUESTIONS_CAP) {
    call.questions = input.questions;
  }
  return call;
}
function paneFromEnv(env) {
  const parts = env.TMUX?.split(",") ?? [];
  const socket = parts.slice(0, -2).join(",");
  return socket && env.TMUX_PANE ? { socket, id: env.TMUX_PANE } : null;
}
function toEvent(agent, payload, context) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload;
  const sessionId = text(body.session_id);
  const event = text(body.hook_event_name);
  if (!sessionId || !SAFE_ID.test(sessionId) || !event) {
    return null;
  }
  const claude = agent === "claude";
  const result = {
    v: 1,
    at: context.now,
    agent,
    event,
    sessionId,
    cwd: text(body.cwd) ?? "",
    transcriptPath: text(body.transcript_path) ?? null,
    pane: claude ? paneFromEnv(context.env) : null,
    pid: claude && context.ppid > 1 ? context.ppid : null,
    actor: text(body.agent_id) ?? null
  };
  const source = text(body.source);
  const reason = text(body.reason);
  const prompt = text(body.prompt);
  const lastMessage = text(body.last_assistant_message);
  const tool = text(body.tool_name);
  if (source !== void 0) result.source = source;
  if (reason !== void 0) result.reason = reason;
  if (prompt !== void 0) result.prompt = cap(prompt, PROMPT_CAP);
  if (lastMessage !== void 0) result.lastMessage = cap(lastMessage, MESSAGE_CAP);
  if (tool) result.tool = toolCall(tool, body.tool_input);
  return result;
}

// src/home.ts
import { homedir } from "node:os";
import { join } from "node:path";
function homeDir(env = process.env) {
  return env.DECISION_CENTER_HOME || join(homedir(), ".decision-center");
}
var sessionsDir = (home) => join(home, "sessions");

// src/reply-line.ts
var REPLY_LINE_INSTRUCTION = `Decision Center shows this session to the user in a feed, with buttons that send a reply in one click.
When you end a turn and wait for the user, make the last line of your message a list of the replies the user is most likely to send next, in exactly this form:
Replies: "first reply" | "second reply" | "third reply"
Rules for that line:
- Give 1 to 3 replies, the most likely first.
- Write each reply as the user's own words to you, as an instruction you can act on without the rest of your message. "Tag 0.3.0 and push it", not "tag" and not "say tag to continue".
- Keep each reply under 80 characters, with no double quotes inside it.
- Put it after everything else, including any closing line you normally write. Do not mention it.
- Leave the line out when you ask the user a question through a tool, or when no reply is more likely than any other.
`;
function sessionStartText(agent, event, env) {
  if (event !== "SessionStart" || agent !== "claude") {
    return null;
  }
  if (env.CLAUDE_CODE_ENTRYPOINT !== "cli" || env.DECISION_CENTER_REPLY_LINE === "off") {
    return null;
  }
  return REPLY_LINE_INSTRUCTION;
}

// src/hook.ts
var STDIN_LIMIT_MS = 3e3;
function appendEvent(home, event) {
  const dir = sessionsDir(home);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const fd = openSync(join2(dir, sessionFileName(event.agent, event.sessionId)), "a", 384);
  try {
    writeSync(fd, `${JSON.stringify(event)}
`);
  } finally {
    closeSync(fd);
  }
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function runHook(agent) {
  setTimeout(() => process.exit(0), STDIN_LIMIT_MS).unref();
  const record = async () => {
    if (agent !== "claude" && agent !== "codex") {
      return;
    }
    const event = toEvent(agent, JSON.parse(await readStdin()), { env: process.env, ppid: process.ppid, now: Date.now() });
    if (!event) {
      return;
    }
    appendEvent(homeDir(), event);
    const text2 = sessionStartText(agent, event.event, process.env);
    if (text2) {
      writeSync(1, text2);
    }
  };
  record().catch(() => void 0).finally(() => process.exit(0));
}

// src/hook-entry.ts
runHook(process.argv[2]);
