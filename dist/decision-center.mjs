#!/usr/bin/env node

// src/cli.ts
import { execFile as execFile4, spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join10 } from "node:path";
import { fileURLToPath } from "node:url";

// src/contract.ts
var API_VERSION = 2;
var DEFAULT_PORT = 47823;
var STREAM_EVENT_FEED = "feed";

// src/hook.ts
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
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
function sessionStartText(agent, event, env, codexTerminalUi) {
  if (event !== "SessionStart" || env.DECISION_CENTER_REPLY_LINE === "off") {
    return null;
  }
  const interactive = agent === "claude" ? env.CLAUDE_CODE_ENTRYPOINT === "cli" : codexTerminalUi();
  return interactive ? REPLY_LINE_INSTRUCTION : null;
}
function startedInCodexTerminalUi(firstLine3) {
  try {
    const meta = JSON.parse(firstLine3)?.payload;
    return meta?.originator === "codex-tui" && meta?.thread_source === "user";
  } catch {
    return false;
  }
}

// src/hook.ts
var STDIN_LIMIT_MS = 3e3;
var FIRST_LINE_LIMIT = 1024 * 1024;
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
function firstLine(path) {
  if (!path) {
    return null;
  }
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(FIRST_LINE_LIMIT);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        const end = buffer.subarray(length, length + read).indexOf(10);
        if (end >= 0) {
          return buffer.toString("utf8", 0, length + end);
        }
        if (read === 0) {
          return null;
        }
        length += read;
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
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
    const text2 = sessionStartText(agent, event.event, process.env, () => startedInCodexTerminalUi(firstLine(event.transcriptPath) ?? ""));
    if (text2) {
      writeSync(1, text2);
    }
  };
  record().catch(() => void 0).finally(() => process.exit(0));
}

// src/install.ts
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join as join3 } from "node:path";
var HOOK_EVENTS = {
  claude: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd"],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]
};
var TIMEOUT_S = 10;
var MARKER = "# decision-center hook";
var quote = (text2) => `'${text2.replace(/'/g, `'\\''`)}'`;
var NODE_FALLBACKS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
function hookCommand(node, hookPath, agent) {
  const candidates = [quote(node), '"$(command -v node)"', ...NODE_FALLBACKS].join(" ");
  return `for n in ${candidates}; do [ -x "$n" ] && exec "$n" ${quote(hookPath)} ${agent}; done; exit 0 ${MARKER}`;
}
var QUOTED = `'((?:[^']|'\\\\'')*)'`;
var COMMAND_SHAPES = [new RegExp(`^for n in ${QUOTED} .* exec "\\$n" ${QUOTED} `), new RegExp(`^${QUOTED} ${QUOTED} `)];
function parseHookCommand(command) {
  const plain = (text2) => text2.replace(/'\\''/g, "'");
  for (const shape of COMMAND_SHAPES) {
    const match = shape.exec(command);
    if (match) return { node: plain(match[1]), hookPath: plain(match[2]) };
  }
  return null;
}
var HOOK_FILE = "hook.mjs";
async function placeHook(builtHook, home) {
  const target = join3(home, HOOK_FILE);
  const built = await readFile(builtHook);
  const current = await readFile(target).catch(() => null);
  if (!current?.equals(built)) {
    await mkdir(home, { recursive: true, mode: 448 });
    const temp = join3(home, `.${HOOK_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, built, { mode: 420 });
    await rename(temp, target);
  }
  return target;
}
async function removeHook(home) {
  await rm(join3(home, HOOK_FILE), { force: true });
}
function placedHookPath(home) {
  return join3(home, HOOK_FILE);
}
function isOurs(hook) {
  const command = hook?.command;
  return typeof command === "string" && command.includes("decision-center") && command.includes(" hook");
}
function mergeHooks(config, events, entry) {
  const next = structuredClone(config && typeof config === "object" && !Array.isArray(config) ? config : {});
  const hooks2 = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const changes = [];
  for (const event of /* @__PURE__ */ new Set([...Object.keys(hooks2), ...entry ? events : []])) {
    const groups = Array.isArray(hooks2[event]) ? hooks2[event] : [];
    const want = entry && events.includes(event) ? entry : null;
    let placed = false;
    let removed = false;
    let updated = false;
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) {
        return [group];
      }
      const own = group.hooks.flatMap((hook) => {
        if (!isOurs(hook)) return [hook];
        if (want && !placed) {
          placed = true;
          updated ||= JSON.stringify(hook) !== JSON.stringify(want);
          return [want];
        }
        removed = true;
        return [];
      });
      return own.length ? [{ ...group, hooks: own }] : [];
    });
    let action = null;
    if (want && !placed) {
      kept.push({ hooks: [want] });
      action = "add";
    } else if (want && (updated || removed)) {
      action = "update";
    } else if (!want && removed) {
      action = "remove";
    }
    if (!action) {
      continue;
    }
    changes.push({ event, action });
    if (kept.length) {
      hooks2[event] = kept;
    } else {
      delete hooks2[event];
    }
  }
  if (changes.length) {
    next.hooks = hooks2;
  }
  return { config: next, changes };
}
function hookEntry(command) {
  return { type: "command", command, timeout: TIMEOUT_S };
}
async function updateConfigFile(path, change, options) {
  const target = await realpath(path).catch(() => path);
  const folder = await stat(dirname(target)).catch(() => null);
  if (!folder?.isDirectory()) {
    return { path, status: "no-folder", changes: [] };
  }
  const text2 = await readFile(target, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let parsed = {};
  if (text2 !== null && text2.trim()) {
    try {
      parsed = JSON.parse(text2);
    } catch (error) {
      throw new Error(`${path} is not valid JSON, so it was left alone: ${error.message}`);
    }
  }
  const { config, changes } = change(parsed);
  if (!changes.length) {
    return { path, status: "unchanged", changes };
  }
  if (options.dryRun) {
    return { path, status: "would-change", changes };
  }
  const indent = text2 ? /^([ \t]+)"/m.exec(text2)?.[1] ?? "  " : "  ";
  const out = `${JSON.stringify(config, null, indent)}${text2 === null || text2.endsWith("\n") ? "\n" : ""}`;
  let backup;
  let mode = 384;
  if (text2 !== null) {
    const stamp = (options.now ?? /* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    backup = join3(dirname(target), `${basename(target)}.decision-center-backup-${stamp}`);
    await copyFile(target, backup);
    mode = (await stat(target)).mode & 511;
  }
  const temp = join3(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, out, { mode });
  await rename(temp, target);
  return { path, status: "changed", changes, ...backup ? { backup } : {} };
}
async function applyHooks(targets, command, options) {
  const results = [];
  for (const { agent, path } of targets) {
    const entry = command ? hookEntry(command(agent)) : null;
    results.push(await updateConfigFile(path, (config) => mergeHooks(config, HOOK_EVENTS[agent], entry), options));
  }
  return results;
}
function installedEvents(text2) {
  try {
    const hooks2 = JSON.parse(text2 ?? "").hooks ?? {};
    return Object.entries(hooks2).filter(([, groups]) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isOurs))).map(([event]) => event);
  } catch {
    return [];
  }
}
function hookProblems(text2, builtHook) {
  let hooks2 = {};
  try {
    hooks2 = JSON.parse(text2 ?? "").hooks ?? {};
  } catch {
    return [];
  }
  const commands = /* @__PURE__ */ new Set();
  for (const groups of Object.values(hooks2)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (isOurs(hook)) commands.add(hook.command);
      }
    }
  }
  const built = existsSync(builtHook) ? readFileSync(builtHook) : null;
  const problems = /* @__PURE__ */ new Set();
  for (const command of commands) {
    const parsed = parseHookCommand(command);
    if (!parsed) {
      problems.add("The hook command has an unknown shape");
      continue;
    }
    if (!existsSync(parsed.node)) problems.add(`Node is gone from ${parsed.node}, so the hook runs with another node if it finds one`);
    if (!existsSync(parsed.hookPath)) problems.add(`Not recording: the hook file is gone from ${parsed.hookPath}`);
    else if (built && !readFileSync(parsed.hookPath).equals(built)) problems.add(`The hook file at ${parsed.hookPath} is from another build`);
  }
  return [...problems];
}
var BLOCK_START = "# >>> decision-center >>>";
var BLOCK_END = "# <<< decision-center <<<";
var BLOCK = new RegExp(`\\n?${BLOCK_START}\\n[\\s\\S]*?${BLOCK_END}\\n?`);
function shellBlock(node, cli) {
  const fn = (agent) => `${agent}() { if [ -x ${quote(node)} ] && [ -f ${quote(cli)} ]; then ${quote(node)} ${quote(cli)} run ${agent} "$@"; else command ${agent} "$@"; fi; }`;
  return [BLOCK_START, "# Added by `decision-center install --alias`. `decision-center uninstall` removes it.", fn("claude"), fn("codex"), BLOCK_END].join("\n");
}
function hasShellBlock(text2) {
  return BLOCK.test(text2 ?? "");
}
async function updateShellFile(path, block, options) {
  const target = await realpath(path).catch(() => path);
  const text2 = await readFile(target, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const current = text2 ?? "";
  let next;
  if (BLOCK.test(current)) {
    next = current.replace(BLOCK, (match) => block ? `${match.startsWith("\n") ? "\n" : ""}${block}
` : "");
  } else {
    next = block ? `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${block}
` : current;
  }
  if (next === current) {
    return { path, status: "unchanged" };
  }
  if (options.dryRun) {
    return { path, status: "would-change" };
  }
  let backup;
  let mode = 420;
  if (text2 !== null) {
    const stamp = (options.now ?? /* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    backup = join3(dirname(target), `${basename(target)}.decision-center-backup-${stamp}`);
    await copyFile(target, backup);
    mode = (await stat(target)).mode & 511;
  }
  const temp = join3(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, next, { mode });
  await rename(temp, target);
  return { path, status: "changed", ...backup ? { backup } : {} };
}

// src/main.ts
import { mkdirSync as mkdirSync2, watch } from "node:fs";
import { realpath as realpath2 } from "node:fs/promises";
import { join as join9 } from "node:path";

// src/binding.ts
import { execFile } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, isAbsolute, join as join4, relative } from "node:path";
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, LC_ALL: "C" }, timeout: 5e3, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (
        // lsof exits 1 when one of several pids is gone, with the rest still printed.
        error && !stdout ? reject(error) : resolve(stdout)
      )
    );
  });
}
async function listProcesses() {
  const out = await run("ps", ["-A", "-o", "pid=,tty=,lstart=,comm="]);
  return out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.+)$/.exec(line);
    if (!match) {
      return [];
    }
    const [, pid, tty, started, command] = match;
    return [{
      pid: Number(pid),
      tty: tty === "??" || tty === "?" ? null : `/dev/${tty}`,
      startedAt: Date.parse(started),
      name: basename2(command.trim())
    }];
  });
}
function claudeInteractive(session, procs) {
  if (!procs || session.pid === null) {
    return true;
  }
  const proc = procs.find((candidate) => candidate.pid === session.pid);
  return !!proc && proc.startedAt <= session.startedAt && proc.tty !== null;
}
async function processCwds(pids) {
  const cwds = /* @__PURE__ */ new Map();
  if (!pids.length) {
    return cwds;
  }
  const out = await run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}
var paneKey = (pane) => `${pane.socket}\0${pane.id}`;
function codexInternal(session, env = process.env) {
  const fromHome = relative(join4(env.CODEX_HOME || join4(homedir2(), ".codex"), "memories"), session.cwd);
  return session.agent === "codex" && !fromHome.startsWith("..") && !isAbsolute(fromHome);
}
function bindCodex(input) {
  const panesByKey = new Map(input.panes.filter((pane) => !pane.dead).map((pane) => [paneKey(pane), pane]));
  const running = new Set(input.codex.map((proc) => proc.pid));
  const bindings = /* @__PURE__ */ new Map();
  const dead = /* @__PURE__ */ new Set();
  const sessions = input.sessions.filter((session) => session.agent === "codex").sort((a, b) => a.startedAt - b.startedAt);
  const ownProcs = (session) => input.codex.filter((proc) => proc.tty && proc.cwd === session.cwd && proc.startedAt <= session.startedAt);
  for (const session of sessions) {
    const kept = input.previous.get(session.id);
    if (kept && running.has(kept.pid) && panesByKey.has(paneKey(kept.pane))) {
      bindings.set(session.id, kept);
    } else if (!ownProcs(session).length) {
      dead.add(session.id);
    }
  }
  const paneOf = (session) => session.agent === "codex" ? bindings.get(session.id)?.pane : session.pane;
  const held = (key, by) => input.sessions.some((other) => {
    const pane = other === by || dead.has(other.id) || other.updatedAt <= by.startedAt ? void 0 : paneOf(other);
    return pane && paneKey(pane) === key;
  });
  const byTty = new Map(input.panes.filter((pane) => !pane.dead).map((pane) => [pane.tty, pane]));
  for (const session of sessions) {
    if (bindings.has(session.id) || dead.has(session.id)) {
      continue;
    }
    const candidates = ownProcs(session).flatMap((proc) => {
      const pane = proc.tty ? byTty.get(proc.tty) : void 0;
      return pane && !held(paneKey(pane), session) ? [{ proc, pane }] : [];
    });
    const latest = Math.max(...candidates.map(({ proc }) => proc.startedAt));
    const best = candidates.filter(({ proc }) => proc.startedAt === latest);
    if (best.length === 1) {
      bindings.set(session.id, { pane: { socket: best[0].pane.socket, id: best[0].pane.id }, pid: best[0].proc.pid });
    }
  }
  return { bindings, dead };
}

// src/claude.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir3, tmpdir } from "node:os";
import { join as join5 } from "node:path";
function resolveClaudeBin() {
  const candidates = [
    join5(homedir3(), ".local", "bin", "claude"),
    join5(homedir3(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude"
  ];
  return candidates.find((path) => existsSync2(path)) ?? "claude";
}
function claudePrint(input, options) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const args = [
    "-p",
    "--model",
    options.model,
    "--effort",
    "low",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--system-prompt",
    options.systemPrompt
  ];
  return new Promise((resolve, reject) => {
    const child = execFile2(
      resolveClaudeBin(),
      args,
      // Why tmpdir: keeps a project's CLAUDE.md out of the prompt.
      { env, cwd: tmpdir(), timeout: options.timeoutMs ?? 6e4, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout).trim().split("\n").pop() || error.message;
          reject(new Error(`claude -p failed: ${detail}`));
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin?.end(input);
  });
}

// src/failures.ts
var MAX_FAILURES = 50;
var MAX_TEXT = 2e3;
function trimmed(failure) {
  const reply = failure.reply;
  if (reply.type === "text" && reply.text.length > MAX_TEXT) {
    return { ...failure, reply: { ...reply, text: `${reply.text.slice(0, MAX_TEXT)}\u2026` } };
  }
  if (reply.type === "permission" && reply.note && reply.note.length > MAX_TEXT) {
    return { ...failure, reply: { ...reply, note: `${reply.note.slice(0, MAX_TEXT)}\u2026` } };
  }
  return failure;
}
var FailureLog = class {
  deps;
  failures = null;
  // Why: saves run one at a time, so a slow write never lands after a newer one.
  saving = Promise.resolve();
  constructor(deps) {
    this.deps = deps;
  }
  async loaded() {
    if (!this.failures) {
      try {
        const stored = await this.deps.load();
        this.failures = Array.isArray(stored) ? stored : [];
      } catch (error) {
        this.deps.log(`failure log unreadable: ${error.message}`);
        this.failures = [];
      }
    }
    return this.failures;
  }
  persist() {
    const snapshot = [...this.failures ?? []];
    this.saving = this.saving.then(() => this.deps.save(snapshot)).catch((error) => this.deps.log(`failure log not saved: ${error.message}`));
    return this.saving;
  }
  async add(failure) {
    const failures = await this.loaded();
    this.failures = [trimmed(failure), ...failures].slice(0, MAX_FAILURES);
    this.deps.log(`reply failed (${failure.code}) for ${failure.itemId}: ${failure.message}`);
    await this.persist();
  }
  async list() {
    return [...await this.loaded()];
  }
  async clear() {
    await this.loaded();
    this.failures = [];
    await this.persist();
  }
};

// src/proposals.ts
var MAX_PROPOSALS = 3;
var NEXT_LINE = /(?:^\s*(?:[-*]\s+)?|[.!?]\s+)[*_]{0,2}next(?:\s+steps?)?[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.*)$/i;
var NUMBERED = /^(\d{1,2})[.)]\s+(.*)$/;
var FENCE = /^\s*(```|~~~)/;
var QUOTED2 = /["“]([^"“”]+)["”]/g;
var REPLY_CUE = /(?:\b(?:reply|say|type|answer|send)(?:\s+with)?|\bor|,)\s*$/i;
var ASKS_YOU = /^(?:type|tell|say|reply|answer|paste|describe|pick|choose|decide|confirm|share|let me know|give me|send me)\b/i;
var THEN_ASKS_YOU = /\b(?:and|then)\s+(?:type|tell|say|reply|answer|paste|describe|pick|choose|decide|confirm)\b/i;
var YOU_OR_ME = /\b(?:you|your|yours|me|my|I|I'll|I'd|I've)\b/;
function addressedToYou(text2) {
  return ASKS_YOU.test(text2) || THEN_ASKS_YOU.test(text2) || YOU_OR_ME.test(text2);
}
var REPLIES_LINE = /^\s*(?:[-*]\s+)?[*_`]{0,2}replies[*_`]{0,2}\s*:[*_`]{0,2}\s*(.+)$/i;
function clean(text2) {
  return text2.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/\s+/g, " ").trim();
}
function quotedReplies(text2) {
  const replies = [];
  for (const match of text2.matchAll(QUOTED2)) {
    if (REPLY_CUE.test(text2.slice(0, match.index)) && match[1].trim()) {
      replies.push(match[1].trim());
    }
  }
  return replies;
}
function repliesLine(lines) {
  const at = lines.findLastIndex((line) => line.trim());
  const body = at < 0 ? null : REPLIES_LINE.exec(lines[at])?.[1];
  if (!body) {
    return null;
  }
  const quoted = [...body.matchAll(QUOTED2)].map((match) => match[1]);
  const replies = (quoted.length ? quoted : body.split("|")).map((reply) => clean(reply).replace(/^[`'‘]+|[`'’]+$/g, "").trim()).filter(Boolean);
  return replies.length ? { replies, at } : null;
}
function withoutRepliesLine(message) {
  if (message === null) {
    return null;
  }
  const lines = message.trimEnd().split("\n");
  const found = repliesLine(lines);
  return found ? lines.slice(0, found.at).join("\n").trimEnd() : message;
}
function nextLine(lines) {
  const start = lines.findLastIndex((line) => !line.trim()) + 1;
  for (let at = lines.length - 1; at >= start; at--) {
    const text2 = clean(NEXT_LINE.exec(lines[at])?.[1] ?? "");
    if (text2) {
      const replies = quotedReplies(text2);
      return { replies: replies.length || addressedToYou(text2) ? replies : [text2], at };
    }
  }
  return null;
}
function closingList(lines) {
  let list = null;
  let lastList = null;
  let after = [];
  let inFence = false;
  for (const line of lines) {
    const fence = FENCE.test(line);
    const numbered = !inFence && !fence ? NUMBERED.exec(line) : null;
    if (fence) {
      inFence = !inFence;
    }
    if (numbered) {
      if (!list) {
        if (numbered[1] !== "1") {
          continue;
        }
        list = [];
        lastList = null;
        after = [];
      }
      list.push(clean(numbered[2] ?? ""));
    } else if (!line.trim() || list && /^\s/.test(line)) {
    } else {
      if (list) {
        lastList = list;
        list = null;
      }
      after.push(line);
    }
  }
  const items = list ?? (after.length === 1 && after[0].trim().endsWith("?") ? lastList : null);
  return (items ?? []).filter(Boolean);
}
function parseProposals(message) {
  const lines = (message ?? "").trimEnd().split("\n");
  const asked = repliesLine(lines);
  if (asked) {
    return asked.replies.slice(0, MAX_PROPOSALS);
  }
  const next = nextLine(lines);
  if (next?.replies.length) {
    return next.replies.slice(0, MAX_PROPOSALS);
  }
  return closingList(next ? lines.filter((_, at) => at !== next.at) : lines).slice(0, MAX_PROPOSALS);
}
var MESSAGE_TAIL_CHARS = 8e3;
var PROMPT_HEAD_CHARS = 1e3;
var SUGGEST_SYSTEM_PROMPT = `You propose what the user might reply to a coding agent that just finished a turn. Output only a JSON array of at most ${MAX_PROPOSALS} replies, each under 100 characters, written as the user talking to the agent: the most likely next instructions first. No other text.`;
function suggestInput(item) {
  const prompt = (item.prompt ?? "").trim().slice(0, PROMPT_HEAD_CHARS);
  const message = (item.lastMessage ?? "").trim().slice(-MESSAGE_TAIL_CHARS);
  return `${prompt ? `The user's last prompt:
${prompt}

` : ""}The agent's last message:
${message}`;
}
function parseSuggestion(output) {
  const match = /\[[\s\S]*\]/.exec(output);
  let parsed;
  try {
    parsed = JSON.parse(match?.[0] ?? "");
  } catch {
    throw new Error("the model did not return a list of replies");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("the model did not return a list of replies");
  }
  return parsed.filter((value) => typeof value === "string").map(clean).filter(Boolean).slice(0, MAX_PROPOSALS);
}
var CACHE_LIMIT = 200;
var Suggester = class {
  cache = /* @__PURE__ */ new Map();
  run;
  constructor(run3) {
    this.run = run3;
  }
  suggest(key, item) {
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.run(suggestInput(item)).then(parseSuggestion);
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
      if (this.cache.size > CACHE_LIMIT) {
        this.cache.delete(this.cache.keys().next().value);
      }
    }
    return pending;
  }
};

// src/feed.ts
var GROUP_ORDER = { question: 0, permission: 0, finished: 1, closed: 2 };
function firstLine2(text2, max = 80) {
  const line = (text2 ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
function basename3(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}
function classify(session, context) {
  const { pending } = context;
  if (pending?.kind === "question") {
    return { kind: "question", state: "waiting", question: pending.question, permission: null, since: pending.at };
  }
  if (pending?.kind === "permission") {
    return { kind: "permission", state: "waiting", question: null, permission: pending.permission, since: pending.at };
  }
  if (context.cancelledAt !== void 0) {
    return { kind: "finished", state: "done", question: null, permission: null, since: context.cancelledAt };
  }
  if (context.stopped) {
    return { kind: "finished", state: "done", question: null, permission: null, since: context.stopped.at };
  }
  if (session.turn !== "done") {
    return null;
  }
  return context.codexQuestion ? { kind: "question", state: "done", question: context.codexQuestion, permission: null, since: session.turnSince } : { kind: "finished", state: "done", question: null, permission: null, since: session.turnSince };
}
function itemFromSession(session, context) {
  const classified = classify(session, context);
  if (!classified) {
    return null;
  }
  const finished = classified.kind === "finished";
  const lastMessage = context.stopped && !context.pending ? context.stopped.notice : session.lastMessage;
  const proposals = finished ? parseProposals(lastMessage) : [];
  return {
    id: session.id,
    agent: session.agent,
    ...classified,
    project: basename3(session.cwd) || session.cwd,
    cwd: session.cwd,
    terminal: session.pane ? { kind: "tmux", pane: session.pane.id } : null,
    title: firstLine2(session.prompt) || "Untitled session",
    prompt: session.prompt,
    lastMessage: withoutRepliesLine(lastMessage),
    proposals,
    canSuggest: finished && !context.stopped && !proposals.length && !!lastMessage?.trim(),
    updatedAt: session.updatedAt,
    unread: true
  };
}
function itemKey(item) {
  return `${item.since}:${item.kind}`;
}
function snapshotOf(items, now = Date.now()) {
  const sorted = [...items].sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || b.since - a.since);
  return {
    version: API_VERSION,
    items: sorted,
    unreadCount: sorted.filter((item) => item.unread).length,
    generatedAt: now
  };
}

// src/page.html
var page_default = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Decision Center</title>\n<style>\n/* The served page. One self-contained file: the server\'s CSP allows no external\n   fonts or scripts, so it uses system fonts. Flat surfaces and one neutral\n   palette; colour only marks an item\'s state. */\n:root {\n  --bg: #111214; --surface: #18191c; --surface-2: #202226; --line: #2a2c31; --line-2: #3a3d44;\n  --ink: #e8e9ec; --ink-2: #b4b7be; --ink-3: #8b8f98;\n  --accent: #6ea0ff;\n  --q: #d9a441; --p: #e06c6c; --d: #5fb58c; --c: #8b8f98; --w: #8b8f98;\n  --sans: -apple-system, system-ui, "Segoe UI", sans-serif;\n  --mono: ui-monospace, "SF Mono", Menlo, monospace;\n  --row-y: 10px;\n  color-scheme: dark;\n}\n:root[data-theme="light"] {\n  --bg: #ffffff; --surface: #f7f7f8; --surface-2: #efeff1; --line: #e3e4e7; --line-2: #c9cbd1;\n  --ink: #1b1c1f; --ink-2: #474a52; --ink-3: #6b6f78;\n  --accent: #2459c9;\n  --q: #8a5a00; --p: #b3261e; --d: #1f7a4d; --c: #6b6f78; --w: #6b6f78;\n  color-scheme: light;\n}\n:root.compact { --row-y: 6px; }\n\n* { box-sizing: border-box; }\nhtml, body { height: 100%; margin: 0; }\nbody { background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); overflow: hidden; -webkit-font-smoothing: antialiased; }\nbutton { font: inherit; color: inherit; cursor: pointer; }\nkbd { font: 500 10.5px/1 var(--mono); border: 1px solid var(--line-2); border-radius: 4px; padding: 2px 4px; color: var(--ink-3); background: var(--bg); }\n:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.s-question { --tone: var(--q); } .s-permission { --tone: var(--p); } .s-done { --tone: var(--d); } .s-closed { --tone: var(--c); } .s-working { --tone: var(--w); }\n\n/* ---------- shell ---------- */\n.app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; }\nheader.top { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-bottom: 1px solid var(--line); }\n.brand { display: flex; align-items: baseline; gap: 8px; }\n.brand h1 { font: 600 14px/1.4 var(--sans); margin: 0; }\n.count { font: 500 12px var(--sans); color: var(--ink-3); }\n.count.zero { display: none; }\n.top .spacer { flex: 1; }\n.btn { display: inline-flex; align-items: center; gap: 7px; background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 10px; font-size: 13px; color: var(--ink-2); }\n.btn:hover { color: var(--ink); background: var(--surface-2); }\n.btn:disabled { opacity: .5; cursor: default; background: var(--bg); color: var(--ink-3); }\n.btn.primary { background: var(--ink); border-color: var(--ink); color: var(--bg); font-weight: 500; }\n.btn.primary:hover { opacity: .88; }\n.btn.primary:disabled { background: var(--surface-2); border-color: var(--line-2); color: var(--ink-3); opacity: 1; }\n.btn.primary kbd { color: inherit; background: none; border-color: currentColor; opacity: .7; }\n\n/* connection state: a dot in the header, a banner when the server is gone */\n.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-3); }\n.conn i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }\n.conn.live i { background: var(--d); }\n.conn.down i { background: var(--p); }\n.banner { display: none; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 16px; font-size: 13px; border-bottom: 1px solid var(--line); border-left: 3px solid var(--p); background: var(--surface); }\n.banner.on { display: flex; }\n.banner b { font-weight: 600; }\n.banner small { font-size: 12px; color: var(--ink-3); }\n\n.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; }\n.seg button { background: var(--bg); border: 0; border-left: 1px solid var(--line-2); padding: 4px 10px; font-size: 13px; color: var(--ink-3); }\n.seg button:first-child { border-left: 0; }\n.seg button:hover { color: var(--ink); }\n.seg button.on { background: var(--surface-2); color: var(--ink); }\n.seg button b { font-weight: 400; margin-left: 5px; color: var(--ink-3); }\n\n.main { grid-row: 3; display: grid; grid-template-columns: minmax(300px, 380px) 1fr; min-height: 0; }\n@media (max-width: 800px) {\n  .main { grid-template-columns: 1fr; }\n  .main.detail-open .feed { display: none; }\n  .main:not(.detail-open) .detail { display: none; }\n  .back { display: inline-flex !important; }\n  .seg, .conn span, #paletteBtn, #nextBtn { display: none; }\n  .d-head { flex-wrap: wrap; padding: 12px 16px; }\n  .d-head .back { margin-right: auto; }\n  .d-head .where { order: 3; flex: 1 0 100%; }\n  .d-head kbd { display: none; }\n}\n\n/* ---------- feed ---------- */\n.feed { min-width: 0; overflow-y: auto; padding-bottom: 40px; border-right: 1px solid var(--line); background: var(--surface); scrollbar-width: thin; }\n.group-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 14px 16px 6px; font-size: 12px; font-weight: 600; color: var(--ink-3); }\n.group-h button { font-size: 12px; font-weight: 400; background: none; border: 0; color: var(--ink-3); padding: 0; }\n.group-h button:hover { color: var(--ink); text-decoration: underline; }\n\n.card { display: grid; grid-template-columns: 8px 1fr auto; gap: 1px 10px; padding: var(--row-y) 16px; border-left: 2px solid transparent; cursor: pointer; }\n.card:hover { background: var(--surface-2); }\n.card.sel { background: var(--surface-2); border-left-color: var(--ink); }\n/* the state dot: filled while unread, a ring once read */\n.mark { grid-row: span 2; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; border: 1.5px solid var(--tone); }\n.unread .mark { background: var(--tone); }\n.card .title { font-size: 13.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.card .title b { color: var(--ink); font-weight: 500; }\n.card.unread .title { color: var(--ink); } .card.unread .title b { font-weight: 650; }\n.card .when { font-size: 12px; color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }\n.card .preview { grid-column: 2 / 4; font-size: 12.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.card .preview i { font-style: normal; color: var(--tone); }\n.compact .card .preview { display: none; } .compact .mark { grid-row: auto; }\n.card.sent, .card.queued { opacity: .6; }\n\n.empty { padding: 56px 24px; text-align: center; color: var(--ink-3); font-size: 13px; }\n.empty strong { display: block; font-size: 14px; font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }\n\n/* ---------- detail ---------- */\n.detail { display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: minmax(0, 1fr); min-height: 0; min-width: 0; }\n.d-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 24px 12px; border-bottom: 1px solid var(--line); }\n.d-head .where { min-width: 0; flex: 1 1 auto; }\n.d-head > .btn { flex: none; }\n.d-head h2 { font: 600 16px/1.35 var(--sans); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.d-head h2 span { color: var(--ink-3); font-weight: 400; }\n.d-head .meta { display: flex; gap: 6px; align-items: center; margin-top: 2px; font-size: 12.5px; color: var(--ink-3); flex-wrap: wrap; }\n.d-head .meta > * + *::before { content: "\xB7"; margin-right: 6px; color: var(--ink-3); }\n.state { color: var(--tone); font-weight: 500; }\n.back { display: none; }\n\n.d-body { overflow-y: auto; padding: 16px 24px 28px; }\n.label { font-size: 12px; font-weight: 600; color: var(--ink-3); margin: 0 0 6px; }\n\n.msgbox { max-width: 78ch; }\n.msg { font-size: 14px; line-height: 1.6; color: var(--ink); overflow-wrap: anywhere; }\n.msg p { margin: 0 0 .8em; } .msg > :last-child { margin-bottom: 0; }\n.msg .h { font-weight: 600; margin-top: 1.1em; }\n.msg ul, .msg ol { margin: 0 0 .8em; padding-left: 1.3em; } .msg li { margin: .15em 0; } .msg li::marker { color: var(--ink-3); }\n.msg strong { font-weight: 600; }\n.msg code { font: 12.5px var(--mono); background: var(--surface-2); border-radius: 4px; padding: 1px 4px; }\n.msg pre { font: 12.5px/1.55 var(--mono); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; }\n.msg pre code { padding: 0; background: none; }\n.msg table { border-collapse: collapse; font-size: 13px; margin: 0 0 .8em; display: block; overflow-x: auto; }\n.msg th, .msg td { border-bottom: 1px solid var(--line); padding: 5px 16px 5px 0; text-align: left; }\n.msg th { font-weight: 600; color: var(--ink-2); }\n.msg .next-line { font-weight: 600; }\n.msg .none { color: var(--ink-3); }\n.clamp { max-height: 24em; overflow: hidden; }\n.more { margin-top: 10px; }\n\n/* question / permission */\n.ask { max-width: 78ch; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }\n.ask h3 { font: 600 15px/1.4 var(--sans); margin: 0 0 2px; }\n.ask .sub { font-size: 12.5px; color: var(--ink-3); margin-bottom: 10px; }\n.tiles { display: grid; gap: 6px; }\n.tile { display: grid; grid-template-columns: 22px 1fr; gap: 0 10px; text-align: left; padding: 8px 12px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line-2); }\n.tile:hover { background: var(--surface-2); }\n.tile .k { grid-row: span 2; align-self: start; display: inline-grid; place-items: center; height: 20px; margin-top: 1px; border-radius: 4px; font: 500 11.5px var(--mono); border: 1px solid var(--line-2); color: var(--ink-3); }\n.tile .t { font-weight: 500; }\n.tile .d { grid-column: 2; font-size: 12.5px; color: var(--ink-3); }\n.tile.picked { border-color: var(--ink); background: var(--surface-2); }\n.tile.picked .k { background: var(--ink); color: var(--bg); border-color: var(--ink); }\n.tile:disabled { cursor: default; }\n.term { font: 13px/1.5 var(--mono); padding: 10px 12px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); margin-bottom: 10px; word-break: break-all; }\n.term::before { content: "$ "; color: var(--ink-3); }\n.note { font-size: 12.5px; color: var(--ink-3); margin-top: 10px; }\n/* a question with several parts: the highlighted part takes the digits */\n.part { margin-top: 14px; padding-left: 12px; border-left: 2px solid var(--line); }\n.part.active { border-left-color: var(--ink); }\n\n/* ---------- reply dock ---------- */\n.dock { padding: 12px 24px 14px; border-top: 1px solid var(--line); background: var(--surface); }\n.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }\n.dock > .row:last-child { margin-bottom: 0; }\n.prop { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 10px 4px 6px; font-size: 13px; }\n.prop:hover { background: var(--surface-2); }\n.prop .k { font: 500 11px var(--mono); color: var(--ink-3); border: 1px solid var(--line-2); border-radius: 4px; padding: 0 4px; }\n.prop .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 44ch; }\n.src { font-size: 12px; color: var(--ink-3); }\n\n.compose { display: flex; gap: 8px; align-items: flex-end; }\n.field { flex: 1; }\n.field textarea { display: block; width: 100%; resize: none; min-height: 38px; max-height: 180px; font: 14px/1.45 var(--sans); color: var(--ink); background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; padding: 8px 12px; outline: none; }\n.field textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }\n.compose .btn { height: 38px; padding: 0 14px; }\n.hint { font-size: 12px; color: var(--ink-3); margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }\n.sent-note { margin: 0; font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n.sent-note .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line-2); border-top-color: var(--ink-2); animation: rot .9s linear infinite; }\n@keyframes rot { to { transform: rotate(360deg); } }\n/* a reply the pane refused: the server\'s message, and the way out */\n.err { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 10px; padding: 6px 10px; border-radius: 6px; font-size: 13px; border: 1px solid var(--line-2); border-left: 3px solid var(--p); background: var(--bg); }\n.err b { color: var(--p); font-weight: 600; }\n.err span { flex: 1; min-width: 20ch; }\n\n/* ---------- the countdown after a reply ---------- */\n.countdown { position: fixed; left: 50%; bottom: 84px; z-index: 50; transform: translateX(-50%); display: none; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line-2); box-shadow: 0 4px 16px rgba(0,0,0,.18); overflow: hidden; max-width: min(640px, calc(100vw - 32px)); }\n.countdown.on { display: flex; }\n.countdown .secs { font: 500 13px var(--mono); color: var(--ink-3); min-width: 1.2em; text-align: center; }\n.countdown .txt { min-width: 0; display: grid; }\n.countdown .txt small { font-size: 12px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.countdown .txt span { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.countdown .btn { flex: none; }\n.countdown .line { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--ink-3); transform-origin: left; animation: drain linear forwards; }\n@keyframes drain { to { transform: scaleX(0); } }\n\n/* ---------- toasts ---------- */\n.toasts { position: fixed; top: 56px; right: 16px; z-index: 55; display: grid; justify-items: end; gap: 6px; pointer-events: none; }\n.toast { max-width: 360px; font-size: 13px; padding: 8px 12px; border-radius: 6px; background: var(--bg); color: var(--ink); border: 1px solid var(--line-2); box-shadow: 0 4px 16px rgba(0,0,0,.18); transition: opacity .2s; }\n.toast.bad { border-left: 3px solid var(--p); }\n.toast.out { opacity: 0; }\n\n/* ---------- overlays: jump list, help, failed replies ---------- */\n.overlay { position: fixed; inset: 0; z-index: 70; display: none; place-items: start center; padding-top: 12vh; background: rgba(0,0,0,.4); }\n.overlay.on { display: grid; }\n.sheet { width: min(560px, 92vw); border-radius: 8px; background: var(--bg); border: 1px solid var(--line-2); box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }\n.sheet input { width: 100%; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink); font: 15px var(--sans); padding: 12px 16px; outline: none; }\n.plist { max-height: 50vh; overflow-y: auto; padding: 4px; }\n.popt { display: grid; grid-template-columns: 8px 1fr auto; gap: 10px; align-items: baseline; padding: 7px 12px; border-radius: 6px; cursor: pointer; }\n.popt .mark { grid-row: auto; margin-top: 0; }\n.popt.on { background: var(--surface-2); }\n.popt small { font-size: 12px; color: var(--ink-3); }\n.pfoot { display: flex; gap: 14px; padding: 8px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-3); }\n.help h2 { font: 600 15px var(--sans); margin: 0; padding: 16px 20px 0; }\n.help dl { display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; margin: 0; padding: 14px 20px 10px; font-size: 13px; }\n.help dt { text-align: right; }\n.help .prefs { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 4px 20px 16px; }\n#failBtn { color: var(--p); }\n#failBtn[hidden] { display: none; }\n.fails .sheet { width: min(760px, 94vw); }\n.flist { max-height: 60vh; overflow-y: auto; padding: 8px 20px 4px; }\n.fail { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }\n.fail summary { cursor: pointer; font-size: 13px; line-height: 1.5; }\n.fail summary small { font-size: 12px; color: var(--ink-3); }\n.fail .why { display: block; color: var(--ink-2); }\n.fail .why b { font: 500 11.5px var(--mono); color: var(--p); margin-right: 6px; }\n.fail dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 10px 0 0; font-size: 12.5px; }\n.fail dt { color: var(--ink-3); }\n.fail dd { margin: 0; min-width: 0; }\n.fail pre { margin: 0; font: 11.5px/1.45 var(--mono); white-space: pre; overflow-x: auto; padding: 8px 10px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); }\n.fempty { padding: 24px 0; color: var(--ink-3); font-size: 13px; }\n@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }\n</style>\n</head>\n<body>\n\n<div class="app">\n  <header class="top">\n    <div class="brand"><h1>Decision Center</h1><span id="badge" class="count" aria-label="unread"></span></div>\n    <div class="seg" id="seg" role="tablist" aria-label="Filter">\n      <button data-f="all" class="on">All<b></b></button><button data-f="waiting">Waiting<b></b></button><button data-f="done">Finished<b></b></button>\n    </div>\n    <span class="spacer"></span>\n    <span class="conn" id="conn" role="status"><i></i><span>Connecting</span></span>\n    <button class="btn" id="paletteBtn" title="Jump to a session">Jump to <kbd>\u2318K</kbd></button>\n    <button class="btn" id="failBtn" title="Replies that didn\'t go through" hidden>Failed <b id="failCount">0</b></button>\n    <button class="btn" id="nextBtn" title="Next unread item">Next <kbd>n</kbd></button>\n    <button class="btn" id="helpBtn" title="Keyboard shortcuts and settings"><kbd>?</kbd></button>\n  </header>\n  <div class="banner" id="banner" role="alert"></div>\n  <div class="main" id="main">\n    <nav class="feed" id="feed" aria-label="Sessions waiting on you"></nav>\n    <section class="detail" id="detail" aria-live="polite"></section>\n  </div>\n</div>\n\n<div class="countdown" id="countdown" role="status"></div>\n<div class="toasts" id="toasts" aria-live="polite"></div>\n\n<div class="overlay" id="palette"><div class="sheet">\n  <input id="pq" placeholder="Jump to a session\u2026" autocomplete="off" spellcheck="false" aria-label="Jump to a session">\n  <div class="plist" id="plist"></div>\n  <div class="pfoot"><span><kbd>\u2191</kbd> <kbd>\u2193</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>\n</div></div>\n\n<div class="overlay help fails" id="fails"><div class="sheet">\n  <h2>Failed replies</h2>\n  <div class="flist" id="flist"></div>\n  <div class="prefs"><button class="btn" id="failCopy">Copy report</button><button class="btn" id="failClear">Clear</button><span class="src">Kept on this Mac only: the last 50, with the keys typed and the pane\'s screen.</span></div>\n</div></div>\n<div class="overlay help" id="help"><div class="sheet">\n  <h2>Keyboard</h2>\n  <dl>\n    <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Move down / up the feed</dd>\n    <dt><kbd>n</kbd></dt><dd>Jump to the next unread item (questions first)</dd>\n    <dt><kbd>\u2318</kbd>+<kbd>K</kbd></dt><dd>Jump to any session by name</dd>\n    <dt><kbd>1</kbd>\u2013<kbd>9</kbd></dt><dd>Finished: put proposal N in the box. Question: pick option N. Permission: <kbd>1</kbd> allows, <kbd>2</kbd> denies</dd>\n    <dt><kbd>\u2190</kbd> <kbd>\u2192</kbd></dt><dd>Several questions: move between them. <kbd>Enter</kbd> sends every answer</dd>\n    <dt><kbd>s</kbd></dt><dd>Suggest replies (when none parsed)</dd>\n    <dt><kbd>r</kbd> or <kbd>/</kbd></dt><dd>Focus the reply box</dd>\n    <dt><kbd>Enter</kbd></dt><dd>In the box: send. <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line</dd>\n    <dt><kbd>Esc</kbd></dt><dd>Leave the box. During the countdown: undo the reply and stay</dd>\n    <dt><kbd>Enter</kbd> <kbd>n</kbd></dt><dd>During the countdown: send now and move on</dd>\n    <dt><kbd>x</kbd></dt><dd>Dismiss this item</dd>\n    <dt><kbd>Shift</kbd>+<kbd>X</kbd></dt><dd>Dismiss all finished</dd>\n    <dt><kbd>o</kbd></dt><dd>Show the session\'s tmux pane</dd>\n    <dt><kbd>!</kbd></dt><dd>Failed replies: what was sent, the keys typed, and the pane\'s screen</dd>\n  </dl>\n  <div class="prefs"><button class="btn" id="themeBtn"></button><button class="btn" id="densityBtn"></button></div>\n</div></div>\n\n<script>\n// Talks to the worker\'s API (src/contract.ts). The feed arrives as full snapshots on the `feed` SSE event.\nconst COUNTDOWN_MS = 3000;\nconst RETRY_MS = 3000;\nconst min = 60e3;\n\n// ---------------------------------------------------------------- state\nlet snap = null;          // last FeedSnapshot from the server\nlet items = [];           // snapshot items plus local state, what the page draws\nlet selId = null, advancing = null, filter = "all", lastDetail = null;\nlet conn = "connecting", failures = 0, lastLiveAt = null;\nconst picks = {}, drafts = {}, expanded = {}, suggestions = {};\nconst errors = {};        // id -> { since, message } for a reply the pane refused\nconst sent = {};          // id -> { since, label, item } once a reply went out; `item` keeps it drawn after the feed drops it\nconst posting = {};       // id -> { label, item } while its POST /api/reply is in flight\nconst readLocal = new Set(), dismissedLocal = new Set();\nconst $ = s => document.querySelector(s);\nconst esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c]));\nconst episode = i => i.since + ":" + i.kind;\n\nconst GROUPS = [\n  { key: "waiting", label: "Waiting on you", test: i => i.kind === "question" || i.kind === "permission" },\n  { key: "done", label: "Finished", test: i => i.kind === "finished" },\n  { key: "closed", label: "Session closed", test: i => i.kind === "closed" },\n];\nconst STATE_LABEL = { question: "Question", permission: "Permission", done: "Finished", closed: "Closed", working: "Working" };\nconst isSent = i => sent[i.id]?.since === i.since;\nconst busy = i => isSent(i) || advancing?.from === i.id || !!posting[i.id];\nconst stateKey = i => i.kind === "closed" ? "closed" : busy(i) ? "working" : i.kind === "finished" ? "done" : i.kind;\nconst visible = () => GROUPS.flatMap(g => items.filter(g.test));\nconst inFilter = i => filter === "all" || (filter === "waiting" ? GROUPS[0].test(i) : GROUPS[1].test(i));\nconst shown = () => visible().filter(inFilter);\nconst sel = () => items.find(i => i.id === selId);\nfunction ago(t) { const m = Math.round((Date.now() - t) / min); return m < 1 ? "now" : m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m"; }\nconst NOT_IN_TMUX = "This session is not running in tmux. Reply in its terminal.";\nconst where = i => `<b>${esc(i.project)}</b> / ${esc(i.title)}`;\nconst short = i => i.project + " / " + (i.title.length > 32 ? i.title.slice(0, 31) + "\u2026" : i.title);\n\n// What each question accepts, mirroring the reply sender\'s refusals (src/reply.ts).\nconst partsOf = i => i.kind === "question" ? [i.question, ...(i.question.more || [])] : [];\nconst multiPart = i => i.kind === "question" && !!i.question.more?.length;\nconst multiPick = i => i.kind === "question" && !multiPart(i) && i.question.multiSelect && i.agent === "claude";\nconst takesText = i => i.kind === "finished" || i.kind === "permission" || (i.kind === "question" && !multiPart(i) && !multiPick(i));\n// Several questions go part by part for Claude only; Codex\'s, and parts with no options, stay in the pane.\nconst inPaneOnly = i => multiPart(i) && (i.agent !== "claude" || partsOf(i).some(q => !q.options.length));\nconst partPicks = {};     // id -> one Set of option positions per part\nconst activePart = {};    // id -> the part the digits pick in\n\n// ---------------------------------------------------------------- feed from the server\nfunction apply(snapshot) {\n  snap = snapshot;\n  const byId = new Map(snapshot.items.map(i => [i.id, i]));\n  for (const id of Object.keys(sent)) {\n    const live = byId.get(id);\n    if (live && live.since !== sent[id].since) delete sent[id]; // a new episode: the agent answered and stopped again\n  }\n  for (const id of Object.keys(errors)) if (byId.get(id)?.since !== errors[id].since) delete errors[id];\n  for (const id of [...dismissedLocal]) if (!byId.has(id)) dismissedLocal.delete(id);\n  items = snapshot.items.filter(i => !dismissedLocal.has(i.id)).map(i => readLocal.has(i.id + "@" + episode(i)) ? { ...i, unread: false } : i);\n  // Why: a replied-to item leaves the feed once the agent works again; keep it drawn, faded, until you move away.\n  const ghosts = new Map(Object.entries(sent).filter(([id]) => id === selId).map(([id, s]) => [id, s.item]));\n  for (const p of Object.values(posting)) ghosts.set(p.item.id, p.item);\n  if (advancing) ghosts.set(advancing.from, advancing.item);\n  for (const [id, item] of ghosts) if (!byId.has(id) && !dismissedLocal.has(id)) items.push(item);\n  if (selId && !items.some(i => i.id === selId)) selId = null;\n  render();\n}\n\n// ---------------------------------------------------------------- connection\n// The page outlives the server: nothing serves until `decision-center serve` runs again.\n// Keep the last feed on screen, say so, and keep retrying.\nlet stream = null, retryTimer = null;\nfunction connect() {\n  clearTimeout(retryTimer);\n  stream?.close();\n  stream = new EventSource("/api/stream");\n  stream.addEventListener("feed", e => { failures = 0; lastLiveAt = Date.now(); setConn("live"); apply(JSON.parse(e.data)); });\n  stream.onerror = () => {\n    stream.close(); failures++;\n    setConn(failures > 1 || conn === "live" ? "down" : "connecting");\n    retryTimer = setTimeout(connect, RETRY_MS);\n  };\n}\nfunction setConn(state) {\n  conn = state;\n  const el = $("#conn");\n  el.className = "conn " + state;\n  el.querySelector("span").textContent = state === "live" ? "Live" : state === "down" ? "Not running" : "Connecting";\n  const banner = $("#banner");\n  banner.classList.toggle("on", state === "down");\n  if (state === "down") banner.innerHTML = `<span><b>Decision Center isn\'t running.</b> Run <b>decision-center serve</b> in a terminal. Retrying every ${RETRY_MS / 1000} s.</span><small>${lastLiveAt ? "Showing the feed from " + new Date(lastLiveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "No feed yet"}</small>`;\n}\n\nasync function post(path, body) {\n  let res;\n  try {\n    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });\n  } catch {\n    return { ok: false, error: { code: "offline", message: "Decision Center isn\'t running. Run decision-center serve in a terminal, then try again." } };\n  }\n  try { return await res.json(); } catch { return { ok: false, error: { code: "bad_response", message: `the server answered ${res.status}` } }; }\n}\n\n// ---------------------------------------------------------------- tiny markdown\nfunction md(src, markNext) {\n  if (!src || !src.trim()) return `<p class="none">No message yet.</p>`;\n  const out = []; const lines = src.split("\\n"); let i = 0;\n  const inline = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>").replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, \'<span title="$2">$1</span>\');\n  const block = /^(```|\\||\\s*[-*] |\\s*\\d+[.)] |#{1,6} )/;\n  while (i < lines.length) {\n    const l = lines[i];\n    if (l.startsWith("```")) { const buf = []; i++; while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\\n"))}</code></pre>`); continue; }\n    if (/^#{1,6} /.test(l)) { out.push(`<p class="h">${inline(l.replace(/^#+ /, ""))}</p>`); i++; continue; }\n    if (/^\\|/.test(l)) { const rows = []; while (i < lines.length && /^\\|/.test(lines[i])) rows.push(lines[i++]); const cells = r => r.split("|").slice(1, -1).map(c => c.trim());\n      const body = rows.slice(2).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");\n      out.push(`<table><thead><tr>${cells(rows[0]).map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`); continue; }\n    if (/^\\s*[-*] /.test(l)) { const buf = []; while (i < lines.length && /^\\s*[-*] /.test(lines[i])) buf.push(lines[i++].replace(/^\\s*[-*] /, "")); out.push(`<ul>${buf.map(b => `<li>${inline(b)}</li>`).join("")}</ul>`); continue; }\n    if (/^\\s*\\d+[.)] /.test(l)) { const buf = []; while (i < lines.length && /^\\s*\\d+[.)] /.test(lines[i])) buf.push(lines[i++].replace(/^\\s*\\d+[.)] /, "")); out.push(`<ol>${buf.map(b => `<li>${inline(b)}</li>`).join("")}</ol>`); continue; }\n    if (!l.trim()) { i++; continue; }\n    const buf = []; while (i < lines.length && lines[i].trim() && !block.test(lines[i])) buf.push(lines[i++]);\n    const p = buf.join(" "); const isNext = markNext && /^\\s*\\**next:?/i.test(p);\n    out.push(`<p>${isNext ? `<span class="next-line">${inline(p)}</span>` : inline(p)}</p>`);\n  }\n  return out.join("");\n}\n\n// ---------------------------------------------------------------- render\nfunction render() {\n  const unread = items.filter(i => i.unread).length;\n  const badge = $("#badge");\n  badge.textContent = unread + " unread";\n  badge.classList.toggle("zero", !unread);\n  document.title = (unread ? `(${unread}) ` : "") + "Decision Center";\n  const all = visible();\n  const counts = { all: all.filter(i => i.kind !== "closed").length, waiting: all.filter(GROUPS[0].test).length, done: all.filter(GROUPS[1].test).length };\n  document.querySelectorAll("#seg button").forEach(b => { b.querySelector("b").textContent = counts[b.dataset.f]; b.classList.toggle("on", b.dataset.f === filter); });\n  renderFeed();\n  renderDetail();\n}\n\n// Keyed feed: a card keeps its element across snapshots, so focus and scroll stay put.\nconst cardEls = new Map();\nfunction renderFeed() {\n  const feed = $("#feed"), list = shown();\n  const want = [];\n  if (!list.length) want.push(["empty", () => snap ? `<div class="empty"><strong>All clear.</strong>New questions and finished turns land here.</div>` : `<div class="empty"><strong>Connecting\u2026</strong>Loading the feed.</div>`, "empty"]);\n  for (const g of GROUPS) {\n    const rows = list.filter(g.test); if (!rows.length) continue;\n    const action = g.key === "done" ? `<button data-act="dismiss-finished" title="Shift+X">dismiss all</button>` : g.key === "closed" ? `<button data-act="dismiss-closed">clear</button>` : "";\n    want.push(["g:" + g.key, () => `<span>${g.label} \xB7 ${rows.length}</span>${action}`, "group-h"]);\n    rows.forEach(i => want.push([i.id, () => cardInner(i), cardClass(i)]));\n  }\n  const keep = new Set(want.map(w => w[0]));\n  cardEls.forEach((el, k) => { if (!keep.has(k)) { cardEls.delete(k); el.remove(); } });\n  let cursor = feed.firstElementChild;\n  for (const [key, html, cls] of want) {\n    let el = cardEls.get(key);\n    if (!el) { el = document.createElement("div"); el.dataset.key = key; cardEls.set(key, el); }\n    const h = html(); if (el._h !== h) { el.innerHTML = h; el._h = h; }\n    el.className = cls;\n    if (!key.startsWith("g:") && key !== "empty") { el.dataset.id = key; el.setAttribute("role", "button"); el.tabIndex = -1; }\n    if (el !== cursor) feed.insertBefore(el, cursor); else cursor = cursor.nextElementSibling;\n  }\n}\nfunction cardClass(i) {\n  return ["card", "s-" + stateKey(i), i.unread && "unread", i.id === selId && "sel", isSent(i) && "sent", (advancing?.from === i.id || posting[i.id]) && "queued"].filter(Boolean).join(" ");\n}\nconst MARK = `<span class="mark"></span>`;\n// Why a word: the dot\'s colour alone must not carry the state.\nconst KIND_WORD = { question: "Question", permission: "Permission", closed: "Closed" };\nfunction previewOf(i) {\n  if (i.kind === "question") return i.question.title + (multiPart(i) ? ` (+${i.question.more.length} more)` : "");\n  if (i.kind === "permission") return `${i.permission.toolName}: ${i.permission.summary}`;\n  return (i.lastMessage || "").replace(/[*`#|]/g, "").split("\\n").find(l => l.trim()) || "No message yet";\n}\nfunction cardInner(i) {\n  const word = busy(i) ? "" : KIND_WORD[i.kind];\n  return `${MARK}\n    <span class="title">${where(i)}</span>\n    <span class="when">${i.agent} \xB7 <time>${ago(i.since)}</time></span>\n    <span class="preview">${word ? `<i>${word}</i> \xB7 ` : ""}${esc(previewOf(i))}</span>`;\n}\n\nfunction renderDetail() {\n  const d = $("#detail"), i = sel();\n  $("#main").classList.toggle("detail-open", !!i);\n  if (!i) { lastDetail = null; d.innerHTML = `<div></div><div class="d-body"><div class="empty"><strong>Pick a session</strong><div>Press <kbd>n</kbd> for the next thing waiting on you, or <kbd>\u2318K</kbd> to jump.</div></div></div><div></div>`; return; }\n  const fresh = lastDetail !== i.id; lastDetail = i.id;\n  const focusedBox = document.activeElement?.matches?.("#detail textarea");\n  const k = stateKey(i), live = i.kind !== "closed" && !busy(i);\n  const msg = i.lastMessage || "", isLong = msg.length > 900, open = expanded[i.id];\n  let ask = "";\n  if (live && i.kind === "question") {\n    const q = i.question, p = picks[i.id] || new Set();\n    if (inPaneOnly(i)) {\n      ask = `<div class="ask s-question"><p class="label">Several questions</p><h3>${esc(q.title)}</h3>\n        <div class="sub">This asks ${partsOf(i).length} questions at once${i.agent === "claude" ? ", and some have no options to pick" : ""}. Answer them in the pane.</div>\n        <button class="btn" data-act="open">Open pane <kbd>o</kbd></button></div>`;\n    } else if (multiPart(i)) {\n      const qs = partsOf(i), all = partPicks[i.id] || [], a = activePart[i.id] || 0;\n      ask = `<div class="ask s-question"><p class="label">${qs.length} questions</p>\n        <div class="sub">Pick an answer for each, then send them together. The digits pick in the highlighted question, and <kbd>\u2190</kbd> <kbd>\u2192</kbd> move between questions.</div>\n        ${qs.map((part, p) => `<div class="part ${p === a ? "active" : ""}"><p class="label">${p + 1} of ${qs.length}${part.header ? " \xB7 " + esc(part.header) : ""} \xB7 ${part.multiSelect ? "pick one or more" : "pick one"}</p><h3>${esc(part.title)}</h3>\n          <div class="tiles">${part.options.map((o, n) => { const on = !!all[p]?.has(n); return `<button class="tile ${on ? "picked" : ""}" data-act="part-opt" data-p="${p}" data-n="${n}" aria-pressed="${on}"><span class="k">${o.index}</span><span class="t">${esc(o.label)}</span>${o.description ? `<span class="d">${esc(o.description)}</span>` : ""}</button>`; }).join("")}</div></div>`).join("")}</div>`;\n    } else if (!q.options.length) {\n      ask = `<div class="ask s-question"><p class="label">Question</p><h3>${esc(q.title)}</h3><div class="sub">No options to pick. Type your answer below.</div></div>`;\n    } else {\n      const sub = multiPick(i) ? "Toggle with the digits, then send. A typed answer goes in the pane." : "It\'s sent as its digit. Or type your own answer below.";\n      ask = `<div class="ask s-question"><p class="label">${multiPick(i) ? "Pick one or more" : "Pick one"}</p><h3>${esc(q.title)}</h3>\n        <div class="sub">${sub}</div>\n        <div class="tiles">${q.options.map((o, n) => `<button class="tile ${p.has(n) ? "picked" : ""}" data-act="opt" data-n="${n}" aria-pressed="${p.has(n)}"><span class="k">${o.index}</span><span class="t">${esc(o.label)}</span>${o.description ? `<span class="d">${esc(o.description)}</span>` : ""}</button>`).join("")}</div></div>`;\n    }\n  }\n  if (live && i.kind === "permission") ask = `<div class="ask s-permission"><p class="label">Permission</p><h3>Allow ${esc(i.permission.toolName)} to run this?</h3>\n      <div class="term">${esc(i.permission.summary || "(no details)")}</div>\n      <div class="tiles"><button class="tile" data-act="allow"><span class="k">1</span><span class="t">Allow</span><span class="d">Run it this once</span></button><button class="tile" data-act="deny"><span class="k">2</span><span class="t">Deny</span><span class="d">Stop it. Say why in the note</span></button></div>\n      <div class="note">A note typed below goes to ${esc(i.agent)} with your answer. "Always allow" rules are set in the pane.</div></div>`;\n  d.innerHTML = `\n    <div class="d-head s-${k}">\n      <button class="btn back" data-act="back" aria-label="Back to the feed">\u2190</button>\n      <div class="where">\n        <h2>${esc(i.project)} <span>/ ${esc(i.title)}</span></h2>\n        <div class="meta"><span class="state">${STATE_LABEL[k]}</span><span>${i.agent}</span><span>${ago(i.since) === "now" ? "just now" : ago(i.since) + " ago"}</span></div>\n      </div>\n      ${i.kind === "closed" || !i.terminal ? "" : `<button class="btn" data-act="open">Open pane <kbd>o</kbd></button>`}\n      <button class="btn" data-act="dismiss">Dismiss <kbd>x</kbd></button>\n    </div>\n    <div class="d-body s-${k}">\n      <p class="label">Last message</p>\n      <div class="msgbox"><div class="msg ${isLong && !open ? "clamp" : ""}">${md(msg, i.kind === "finished")}</div>\n      ${isLong ? `<button class="btn more" data-act="expand">${open ? "Show less" : "Show the full message"}</button>` : ""}</div>\n      ${ask}\n    </div>\n    ${dockHtml(i)}`;\n  const ta = d.querySelector("textarea");\n  if (ta) { ta.value = drafts[i.id] || ""; autosize(ta); if (focusedBox && !fresh) ta.focus(); }\n}\n\nfunction errorRow(i) {\n  const e = errors[i.id]; if (!e) return "";\n  return `<div class="err" role="alert"><b>Not sent.</b><span>${esc(e.message)}</span><button class="btn" data-act="fail-details">Details <kbd>!</kbd></button>${i.kind !== "closed" && i.terminal ? `<button class="btn" data-act="open">Open pane <kbd>o</kbd></button>` : ""}</div>`;\n}\nfunction dockHtml(i) {\n  const k = stateKey(i);\n  if (i.kind === "closed") return `<div class="dock s-${k}"><p class="sent-note">The session is closed. The message stays readable until you dismiss it.</p></div>`;\n  if (!i.terminal) return `<div class="dock s-${k}"><p class="sent-note">This session is not running in tmux, so replies from here can\'t reach it. Reply in its terminal.</p></div>`;\n  if (advancing?.from === i.id) return `<div class="dock s-${k}"><p class="sent-note"><span class="spin"></span>Sending <b>${esc(advancing.label)}</b> when the countdown ends. <kbd>Esc</kbd> to undo and stay.</p></div>`;\n  if (posting[i.id]) return `<div class="dock s-${k}"><p class="sent-note"><span class="spin"></span>Sending <b>${esc(posting[i.id].label)}</b>\u2026</p></div>`;\n  if (isSent(i)) return `<div class="dock s-${k}"><p class="sent-note"><span class="spin"></span>Sent <b>${esc(sent[i.id].label)}</b>. ${i.agent} is working. This item leaves the feed when you move on.</p></div>`;\n  if (inPaneOnly(i)) return `<div class="dock s-${k}">${errorRow(i)}<p class="sent-note">Answer these questions in the pane. <button class="btn" data-act="open">Open pane <kbd>o</kbd></button></p></div>`;\n  if (i.kind === "permission") return `<div class="dock s-${k}">${errorRow(i)}\n    <div class="compose"><div class="field"><textarea rows="1" placeholder="Optional note for ${esc(i.agent)}\u2026" aria-label="Note"></textarea></div><button class="btn primary" data-act="allow">Allow <kbd>1</kbd></button><button class="btn" data-act="deny">Deny <kbd>2</kbd></button></div>\n    <div class="hint"><span><kbd>1</kbd> allow</span><span><kbd>2</kbd> deny</span><span><kbd>r</kbd> write a note, <kbd>Esc</kbd> to leave it</span><span><kbd>n</kbd> next</span></div></div>`;\n  let top = "";\n  if (multiPart(i)) {\n    const qs = partsOf(i), all = partPicks[i.id] || [], done = qs.filter((_, p) => all[p]?.size).length;\n    top = `<div class="row"><button class="btn primary" data-act="submit-parts" ${partsDone(i) ? "" : "disabled"}>Send answers <kbd>\u21B5</kbd></button><span class="src">${done === qs.length ? esc(partsLabel(i)) : `${done} of ${qs.length} answered`}</span></div>`;\n  } else if (multiPick(i)) {\n    const p = picks[i.id] || new Set();\n    top = `<div class="row"><button class="btn primary" data-act="submit-multi" ${p.size ? "" : "disabled"}>Send ${p.size ? p.size + " picked" : "picks"}</button><span class="src">${p.size ? [...p].map(x => esc(i.question.options[x].label)).join(" + ") : "Nothing picked yet"}</span></div>`;\n  } else if (i.kind === "finished") {\n    const gen = suggestions[i.id + "@" + episode(i)];\n    const props = i.proposals.length ? i.proposals : Array.isArray(gen) ? gen : [];\n    if (gen === "loading") top = `<div class="row"><span class="src">Asking Haiku for replies\u2026</span></div>`;\n    else if (props.length) top = `<div class="row">${props.map((p, n) => `<button class="prop" data-act="prop" data-n="${n}"><span class="k">${n + 1}</span><span class="t">${esc(p)}</span></button>`).join("")}<span class="src">${i.proposals.length ? "from the message" : "suggested by Haiku"}</span></div>`;\n    else if (i.canSuggest) top = `<div class="row"><button class="btn" data-act="suggest">Suggest replies <kbd>s</kbd></button><span class="src">No next actions found in the message</span></div>`;\n  }\n  if (!takesText(i)) return `<div class="dock s-${k}">${errorRow(i)}${top}<div class="row"><span class="src">${multiPart(i) ? "Typed answers to these questions go in the pane." : "Typed answers to multi-select questions go in the pane."}</span><button class="btn" data-act="open">Open pane <kbd>o</kbd></button></div></div>`;\n  const placeholder = i.kind === "question" ? (i.question.options.length ? "Other: type your own answer\u2026" : "Type your answer\u2026") : "Reply to " + i.agent + "\u2026";\n  return `<div class="dock s-${k}">${errorRow(i)}${top}\n    <div class="compose"><div class="field"><textarea rows="1" placeholder="${placeholder}" aria-label="Reply"></textarea></div><button class="btn primary" data-act="send">Send <kbd>\u21B5</kbd></button></div>\n    <div class="hint"><span><kbd>Enter</kbd> send</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span><span><kbd>Esc</kbd> back to feed</span><span><kbd>n</kbd> next</span></div></div>`;\n}\nfunction autosize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 180) + "px"; }\n\n// ---------------------------------------------------------------- actions\nfunction select(id, { focus } = {}) {\n  if (id === selId && !advancing) return;\n  settle(); // moving elsewhere mid-countdown sends a held reply, then goes where you chose\n  const prev = selId;\n  selId = id;\n  if (prev && prev !== id && sent[prev] && !snap?.items.some(x => x.id === prev)) items = items.filter(x => x.id !== prev); // a sent item leaves the feed once you move away\n  const i = sel();\n  if (i?.unread) { i.unread = false; readLocal.add(i.id + "@" + episode(i)); post("/api/read", { id: i.id }); }\n  render();\n  document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });\n  if (focus) $("#detail textarea")?.focus();\n}\nfunction move(d) { const l = shown(); if (!l.length) return; const ix = l.findIndex(i => i.id === selId); select(l[Math.max(0, Math.min(l.length - 1, ix < 0 ? 0 : ix + d))].id); }\nfunction nextWaiting() {\n  if (advancing) return finish();\n  const l = visible().filter(i => i.id !== selId && i.kind !== "closed" && !busy(i));\n  const t = l.find(i => i.unread) || l.find(i => i.kind !== "finished") || l[0];\n  if (t) { if (!inFilter(t)) filter = "all"; select(t.id); } else toast("Nothing else is waiting on you.");\n}\nasync function dismiss(ids) {\n  if (!ids.length) return;\n  if (advancing && ids.includes(advancing.from)) cancelCountdown(true);\n  ids.forEach(id => dismissedLocal.add(id));\n  items = items.filter(x => !ids.includes(x.id));\n  if (ids.includes(selId)) selId = null;\n  render();\n  const results = await Promise.all(ids.map(id => post("/api/dismiss", { id })));\n  const failed = results.find(r => !r.ok);\n  if (failed) { ids.forEach(id => dismissedLocal.delete(id)); toast("Couldn\'t dismiss: " + failed.error.message, true); if (snap) apply(snap); }\n}\nasync function dismissFinished() {\n  const ids = items.filter(x => x.kind === "finished").map(x => x.id); if (!ids.length) return;\n  ids.forEach(id => dismissedLocal.add(id));\n  items = items.filter(x => !ids.includes(x.id)); if (ids.includes(selId)) selId = null;\n  render();\n  const r = await post("/api/dismiss", { allFinished: true });\n  if (r.ok) toast("Dismissed all finished items.");\n  else { ids.forEach(id => dismissedLocal.delete(id)); toast("Couldn\'t dismiss: " + r.error.message, true); if (snap) apply(snap); }\n}\nasync function openPane(i) {\n  if (!i || i.kind === "closed") return;\n  if (!i.terminal) return toast(NOT_IN_TMUX, true);\n  const r = await post("/api/open", { id: i.id }); // it also marks the item read; the feed push follows\n  toast(r.ok ? `Showing ${short(i)} in tmux.` : "Couldn\'t open the pane: " + r.error.message, !r.ok);\n}\n\n// ---- every reply gets one countdown, shown in a bar over the detail pane; the reply is held until it runs out.\n// Undo (Esc) cancels the reply and you stay with your draft. Timeout sends it and goes to the next item in the queue.\nfunction send(i, label, reply) {\n  if (!i.terminal) return toast(NOT_IN_TMUX, true);\n  if (advancing) settle();\n  delete errors[i.id];\n  const draft = drafts[i.id] || ""; drafts[i.id] = "";\n  const next = selId === i.id ? nextInQueue(i.id) : null;\n  const end = Date.now() + COUNTDOWN_MS;\n  advancing = { from: i.id, to: next?.id, label, reply, draft, item: i, timer: setTimeout(finish, COUNTDOWN_MS),\n    tick: setInterval(() => { const el = $("#isecs"); if (el) el.textContent = Math.max(1, Math.ceil((end - Date.now()) / 1000)); }, 100) };\n  render();\n  const isl = $("#countdown");\n  isl.innerHTML = `<span class="secs" id="isecs">${COUNTDOWN_MS / 1000}</span>\n    <span class="txt"><small>Sending ${esc(label)}</small><span>${next ? `then ${esc(next.project)} / ${esc(next.title)}` : `to ${esc(i.project)} / ${esc(i.title)}`}</span></span>\n    <button class="btn" data-act="stay">Undo <kbd>Esc</kbd></button><button class="btn primary" data-act="go-next">Send now <kbd>\u21B5</kbd></button>\n    <i class="line" style="animation-duration:${COUNTDOWN_MS}ms"></i>`;\n  const r = $("#detail").getBoundingClientRect(); isl.style.left = (r.width ? r.left + r.width / 2 : innerWidth / 2) + "px"; // centre over the detail pane\n  isl.classList.add("on");\n}\nfunction nextInQueue(fromId) { return visible().find(x => x.id !== fromId && x.kind !== "closed" && !busy(x)); }\nfunction stopCountdown() {\n  const c = advancing; if (!c) return null;\n  clearTimeout(c.timer); clearInterval(c.tick); advancing = null; $("#countdown").classList.remove("on");\n  return c;\n}\n// The countdown ran out (or you moved on): POST the reply. Resolves true when the pane took it.\nasync function deliver(c) {\n  const i = c.item;\n  posting[i.id] = { label: c.label, item: i }; render();\n  const r = await post("/api/reply", { id: i.id, reply: c.reply });\n  delete posting[i.id];\n  if (r.ok) {\n    sent[i.id] = { since: i.since, label: c.label, item: i };\n    toast(`Sent to ${i.agent} \xB7 ${short(i)}.`);\n  } else {\n    errors[i.id] = { since: i.since, message: r.error.message };\n    noteFailure(i, c.reply, r.error);\n    if (!drafts[i.id]) drafts[i.id] = c.draft;\n    if (selId !== i.id) toast(`Not sent to ${short(i)}: ${r.error.message}`, true);\n  }\n  if (snap) apply(snap); else render();\n  return r.ok;\n}\n// Send the held reply without choosing where to go (used when you move elsewhere mid-countdown).\nfunction settle() { const c = stopCountdown(); if (c) deliver(c); return c; }\nasync function finish() {\n  const c = stopCountdown(); if (!c) return;\n  const ok = await deliver(c);\n  if (!ok || selId !== c.from) return; // a refused reply stays put, with its error and your draft back\n  const to = c.to && items.some(x => x.id === c.to) ? c.to : nextInQueue(c.from)?.id;\n  if (to) { const t = items.find(x => x.id === to); if (t && !inFilter(t)) filter = "all"; select(to); }\n}\nfunction cancelCountdown(quiet) {\n  const c = stopCountdown(); if (!c) return;\n  drafts[c.from] = c.draft;\n  if (!quiet) toast("Not sent. Staying here.");\n  render();\n}\nfunction pickOption(i, n) {\n  const o = i.question.options[n]; if (!o || multiPart(i)) return;\n  if (multiPick(i)) { const p = picks[i.id] = picks[i.id] || new Set(); p.has(n) ? p.delete(n) : p.add(n); render(); return; }\n  send(i, `\u201C${o.label}\u201D`, { type: "option", indexes: [o.index] });\n}\nfunction submitMulti(i) {\n  const p = [...(picks[i.id] || [])].sort((a, b) => a - b); if (!p.length) return;\n  picks[i.id] = new Set();\n  send(i, p.map(x => i.question.options[x].label).join(" + "), { type: "option", indexes: p.map(x => i.question.options[x].index) });\n}\nfunction pickPart(i, p, n) {\n  const qs = partsOf(i), part = qs[p];\n  if (!part?.options[n] || inPaneOnly(i)) return;\n  if (partPicks[i.id]?.length !== qs.length) partPicks[i.id] = qs.map(() => new Set());\n  const set = partPicks[i.id][p];\n  if (part.multiSelect) set.has(n) ? set.delete(n) : set.add(n);\n  else { set.clear(); set.add(n); }\n  activePart[i.id] = part.multiSelect ? p : Math.min(p + 1, qs.length - 1); // a single pick moves on by itself\n  render();\n}\nconst partsDone = i => partPicks[i.id]?.length === partsOf(i).length && partPicks[i.id].every(set => set.size);\nconst sortedPicks = (i, p) => [...partPicks[i.id][p]].sort((a, b) => a - b);\nconst partsLabel = i => partsOf(i).map((q, p) => sortedPicks(i, p).map(n => q.options[n].label).join(" + ")).join(" \xB7 ");\nfunction submitParts(i) {\n  if (!multiPart(i) || inPaneOnly(i)) return;\n  if (!partsDone(i)) return toast("Pick an answer for every question first.", true);\n  const answers = partsOf(i).map((q, p) => sortedPicks(i, p).map(n => q.options[n].index));\n  const label = partsLabel(i);\n  delete partPicks[i.id]; activePart[i.id] = 0;\n  send(i, label, { type: "answers", answers });\n}\nfunction decidePermission(i, allow) {\n  if (!i || i.kind !== "permission" || busy(i)) return;\n  const note = (drafts[i.id] || "").trim();\n  send(i, (allow ? "Allow" : "Deny") + (note ? ` + \u201C${note.length > 30 ? note.slice(0, 30) + "\u2026" : note}\u201D` : ""), { type: "permission", allow, ...(note ? { note } : {}) });\n}\nfunction useProposal(i, n) {\n  const gen = suggestions[i.id + "@" + episode(i)];\n  const props = i.proposals.length ? i.proposals : Array.isArray(gen) ? gen : [];\n  if (!props[n]) return;\n  drafts[i.id] = props[n]; render();\n  const ta = $("#detail textarea"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);\n}\nasync function suggest(i) {\n  const key = i.id + "@" + episode(i);\n  if (i.kind !== "finished" || i.proposals.length || !i.canSuggest || suggestions[key]) return;\n  suggestions[key] = "loading"; render();\n  const r = await post("/api/suggest", { id: i.id });\n  if (r.ok && r.proposals?.length) suggestions[key] = r.proposals.slice(0, 3);\n  else { delete suggestions[key]; toast(r.ok ? "Haiku had no replies to suggest." : "Couldn\'t suggest replies: " + r.error.message, !r.ok); }\n  if (selId === i.id) render();\n}\nfunction sendText(i) {\n  if (!i || !takesText(i) || busy(i)) return;\n  if (i.kind === "permission") return toast("Pick Allow (1) or Deny (2). Esc leaves the note box.");\n  const text = (drafts[i.id] || "").trim(); if (!text) return;\n  send(i, `\u201C${text.length > 40 ? text.slice(0, 40) + "\u2026" : text}\u201D`, { type: "text", text });\n}\n// ---------------------------------------------------------------- failed replies (kept by the worker; offline ones only here)\nlet replyFailures = [];\nconst localFailures = []; // the server was unreachable, so it never saw these\nlet failOpenId = null;    // the failure shown expanded\nconst allFailures = () => [...localFailures, ...replyFailures].sort((a, b) => b.at - a.at);\nasync function loadFailures() {\n  try {\n    const r = await (await fetch("/api/failures")).json();\n    if (r.ok) replyFailures = r.failures;\n  } catch {}\n  renderFailures();\n}\nfunction noteFailure(i, reply, error) {\n  if (error.code !== "offline" && error.code !== "bad_response") return loadFailures();\n  localFailures.unshift({ id: "local-" + Date.now(), at: Date.now(), itemId: i.id, agent: i.agent, kind: i.kind, where: i.project + " / " + i.title, reply, code: error.code, message: error.message, keysSent: [], screen: null, draft: null });\n  renderFailures();\n}\nfunction replySummary(r) {\n  if (r.type === "text") return `\u201C${r.text}\u201D`;\n  if (r.type === "option") return "option " + r.indexes.join(" + ");\n  if (r.type === "answers") return "answers " + r.answers.map(a => a.join(" + ")).join(" \xB7 ");\n  return (r.allow ? "Allow" : "Deny") + (r.note ? ` + note \u201C${r.note}\u201D` : "");\n}\nfunction renderFailures() {\n  const list = allFailures();\n  $("#failBtn").hidden = !list.length;\n  $("#failCount").textContent = list.length;\n  if (!$("#fails").classList.contains("on")) return;\n  $("#flist").innerHTML = list.length ? list.map(f => `<details class="fail" ${f.id === failOpenId ? "open" : ""}>\n      <summary><b>${esc(f.where || f.itemId)}</b> <small>${esc(f.agent || "?")} \xB7 ${esc(f.kind || "gone")} \xB7 ${ago(f.at) === "now" ? "just now" : ago(f.at) + " ago"}</small>\n        <span class="why"><b>${esc(f.code)}</b>${esc(f.message)}</span></summary>\n      <dl><dt>Sent</dt><dd>${esc(replySummary(f.reply))}</dd>\n        <dt>Keys typed</dt><dd>${f.keysSent.length ? esc(f.keysSent.join(", ")) : "none: the pane wasn\'t touched"}</dd>\n        ${f.draft ? `<dt>Unsent in pane</dt><dd>\u201C${esc(f.draft)}\u201D</dd>` : ""}\n        <dt>Screen</dt><dd>${f.screen ? `<pre>${esc(f.screen.join("\\n"))}</pre>` : f.code === "offline" ? "none: Decision Center wasn\'t running" : "none: the pane wasn\'t read"}</dd></dl>\n    </details>`).join("") : `<div class="fempty">No failed replies.</div>`;\n}\nfunction openFailures(itemId) {\n  failOpenId = (itemId && allFailures().find(x => x.itemId === itemId)?.id) || null;\n  $("#fails").classList.add("on");\n  renderFailures();\n  loadFailures();\n}\nasync function copyFailures() {\n  const report = JSON.stringify({ app: "Decision Center", copiedAt: new Date().toISOString(), userAgent: navigator.userAgent, failures: allFailures() }, null, 2);\n  try { await navigator.clipboard.writeText(report); toast("Copied the failure report."); }\n  catch { toast("Couldn\'t reach the clipboard.", true); }\n}\nasync function clearFailures() {\n  const r = await post("/api/failures/clear", {});\n  if (!r.ok) return toast("Couldn\'t clear: " + r.error.message, true);\n  localFailures.length = 0; replyFailures = [];\n  renderFailures();\n}\n$("#failBtn").onclick = () => openFailures();\n$("#failCopy").onclick = copyFailures;\n$("#failClear").onclick = clearFailures;\n\nfunction toast(m, bad) {\n  const box = $("#toasts"), t = document.createElement("div");\n  t.className = "toast" + (bad ? " bad" : ""); t.textContent = m; box.appendChild(t);\n  while (box.children.length > 4) box.firstElementChild.remove();\n  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 200); }, bad ? 6000 : 2800);\n}\n\n// ---------------------------------------------------------------- settings: theme follows the system unless set\nconst prefs = (() => { try { return JSON.parse(localStorage.getItem("dc-prefs")) || {}; } catch { return {}; } })();\nconst savePrefs = () => { try { localStorage.setItem("dc-prefs", JSON.stringify(prefs)); } catch {} };\nconst lightMq = matchMedia("(prefers-color-scheme: light)");\nfunction applyPrefs() {\n  const theme = prefs.theme || "system";\n  document.documentElement.dataset.theme = theme === "system" ? (lightMq.matches ? "light" : "dark") : theme;\n  document.documentElement.classList.toggle("compact", prefs.density === "compact");\n  $("#themeBtn").textContent = "Theme: " + { system: "system", dark: "dark", light: "light" }[theme];\n  $("#densityBtn").textContent = "Density: " + (prefs.density === "compact" ? "compact" : "comfortable");\n}\nlightMq.addEventListener("change", applyPrefs);\n$("#themeBtn").onclick = () => { const order = ["system", "dark", "light"]; prefs.theme = order[(order.indexOf(prefs.theme || "system") + 1) % 3]; savePrefs(); applyPrefs(); };\n$("#densityBtn").onclick = () => { prefs.density = prefs.density === "compact" ? "comfy" : "compact"; savePrefs(); applyPrefs(); };\napplyPrefs();\n\n// ---------------------------------------------------------------- command palette\nlet pIdx = 0;\nfunction openPalette() { $("#palette").classList.add("on"); $("#pq").value = ""; pIdx = 0; renderPalette(); $("#pq").focus(); }\nfunction closePalette() { $("#palette").classList.remove("on"); }\nfunction paletteList() { const q = $("#pq").value.toLowerCase(); return visible().filter(i => (i.project + " " + i.title + " " + i.agent + " " + previewOf(i)).toLowerCase().includes(q)); }\nfunction renderPalette() {\n  const l = paletteList(); pIdx = Math.min(pIdx, Math.max(0, l.length - 1));\n  $("#plist").innerHTML = l.length ? l.map((i, n) => `<div class="popt s-${stateKey(i)} ${n === pIdx ? "on" : ""}" data-pid="${esc(i.id)}">${MARK}<span>${where(i)}<br><small>${esc(previewOf(i).slice(0, 80))}</small></span><small>${STATE_LABEL[stateKey(i)]}</small></div>`).join("")\n    : `<div class="empty" style="padding:30px">No session matches.</div>`;\n  $("#plist .popt.on")?.scrollIntoView({ block: "nearest" });\n}\n$("#pq").addEventListener("input", () => { pIdx = 0; renderPalette(); });\n$("#pq").addEventListener("keydown", e => {\n  const l = paletteList();\n  if (e.key === "ArrowDown") { e.preventDefault(); pIdx = Math.min(l.length - 1, pIdx + 1); renderPalette(); }\n  if (e.key === "ArrowUp") { e.preventDefault(); pIdx = Math.max(0, pIdx - 1); renderPalette(); }\n  if (e.key === "Enter" && l[pIdx]) { e.preventDefault(); closePalette(); if (!inFilter(l[pIdx])) filter = "all"; select(l[pIdx].id); }\n});\n$("#plist").addEventListener("click", e => { const o = e.target.closest(".popt"); if (o) { closePalette(); filter = "all"; select(o.dataset.pid); } });\n\n// ---------------------------------------------------------------- events\ndocument.addEventListener("click", e => {\n  if (e.target.classList.contains("overlay")) return e.target.classList.remove("on");\n  const seg = e.target.closest("#seg button"); if (seg) { filter = seg.dataset.f; if (sel() && !inFilter(sel())) selId = null; return render(); }\n  const b = e.target.closest("[data-act]");\n  const row = e.target.closest(".card"); if (row && row.dataset.id && !b) return select(row.dataset.id);\n  if (!b) return;\n  const i = sel(), n = +b.dataset.n;\n  switch (b.dataset.act) {\n    case "dismiss": return i && dismiss([i.id]);\n    case "dismiss-finished": return dismissFinished();\n    case "dismiss-closed": return dismiss(items.filter(x => x.kind === "closed").map(x => x.id));\n    case "open": return openPane(i);\n    case "expand": expanded[i.id] = !expanded[i.id]; return render();\n    case "opt": return pickOption(i, n);\n    case "submit-multi": return submitMulti(i);\n    case "part-opt": return pickPart(i, +b.dataset.p, n);\n    case "submit-parts": return submitParts(i);\n    case "allow": return decidePermission(i, true);\n    case "deny": return decidePermission(i, false);\n    case "prop": return useProposal(i, n);\n    case "suggest": return suggest(i);\n    case "send": return sendText(i);\n    case "go-next": return finish();\n    case "stay": return cancelCountdown();\n    case "fail-details": return openFailures(i?.id);\n    case "back": selId = null; return render();\n  }\n});\ndocument.addEventListener("input", e => { if (e.target.matches("#detail textarea")) { drafts[selId] = e.target.value; autosize(e.target); } });\ndocument.addEventListener("keydown", e => {\n  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return $("#palette").classList.contains("on") ? closePalette() : openPalette(); }\n  if (e.target.id === "pq") { if (e.key === "Escape") closePalette(); return; }\n  const inBox = e.target.matches("textarea, select, input");\n  if (e.key === "Escape") { if ($("#fails").classList.contains("on")) return $("#fails").classList.remove("on"); if ($("#help").classList.contains("on")) return $("#help").classList.remove("on"); if (advancing) return cancelCountdown(); if (inBox) return e.target.blur(); }\n  if (inBox) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.matches("#detail textarea")) { e.preventDefault(); sendText(sel()); } return; }\n  if (e.metaKey || e.ctrlKey || e.altKey) return;\n  const i = sel();\n  switch (e.key) {\n    case "j": case "ArrowDown": e.preventDefault(); return move(1);\n    case "k": case "ArrowUp": e.preventDefault(); return move(-1);\n    case "n": return nextWaiting();\n    case "?": return $("#help").classList.toggle("on");\n    case "!": return $("#fails").classList.contains("on") ? $("#fails").classList.remove("on") : openFailures(sel()?.id);\n    case "X": return dismissFinished();\n    case "u": return cancelCountdown();\n  }\n  if (advancing && e.key === "Enter") { e.preventDefault(); return finish(); }\n  if (!i) return;\n  if (busy(i) && e.key !== "x") return;\n  if (multiPart(i) && !inPaneOnly(i)) {\n    if (e.key === "Enter") { e.preventDefault(); return submitParts(i); }\n    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {\n      e.preventDefault();\n      activePart[i.id] = Math.max(0, Math.min(partsOf(i).length - 1, (activePart[i.id] || 0) + (e.key === "ArrowRight" ? 1 : -1)));\n      return render();\n    }\n  }\n  switch (e.key) {\n    case "x": return dismiss([i.id]);\n    case "o": return openPane(i);\n    case "r": case "/": case "Enter": e.preventDefault(); return $("#detail textarea")?.focus();\n    case "s": return suggest(i);\n  }\n  if (/^[1-9]$/.test(e.key) && i.kind !== "closed") {\n    const n = +e.key - 1;\n    if (i.kind === "permission") { if (n < 2) decidePermission(i, n === 0); return; }\n    if (multiPart(i)) { const p = activePart[i.id] || 0; return pickPart(i, p, partsOf(i)[p].options.findIndex(o => o.index === n + 1)); }\n    if (i.kind === "question") return pickOption(i, i.question.options.findIndex(o => o.index === n + 1));\n    if (i.kind === "finished" && n < 3) { e.preventDefault(); return useProposal(i, n); }\n  }\n});\n$("#nextBtn").onclick = nextWaiting;\n$("#helpBtn").onclick = () => $("#help").classList.add("on");\n$("#paletteBtn").onclick = openPalette;\nsetInterval(() => document.querySelectorAll(".card[data-id] .when time").forEach(el => { const it = items.find(x => x.id === el.closest(".card").dataset.id); if (it) el.textContent = ago(it.since); }), 30e3);\nrender();\nconnect();\nloadFailures();\n</script>\n</body>\n</html>\n';

// src/page.ts
var PAGE = page_default;

// src/terminal.ts
var TerminalError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
};

// src/reply.ts
var RIGHT = "\x1B[C";
var DOWN = "\x1B[B";
var TAB = "	";
var OPTION_UP = "\x1B[1;3A";
var OPTION_DOWN = "\x1B[1;3B";
var KEY_GAP_MS = 250;
var SCREEN_WAIT_MS = 3e3;
var NOT_IN_TMUX = "this session is not running in tmux; reply in its terminal";
var FAILURE_SCREEN_LINES = 40;
function describeKey(input) {
  const names = {
    "\x1B[A": "\u2191",
    "\x1B[B": "\u2193",
    "\x1B[C": "\u2192",
    "\x1B[1;3A": "\u2325\u2191",
    "\x1B[1;3B": "\u2325\u2193",
    "	": "Tab",
    "\x1B": "Esc",
    "\x7F": "\u232B"
  };
  const text2 = input.text ? names[input.text] ?? JSON.stringify(input.text) : "";
  return [text2, input.enter ? "Enter" : ""].filter(Boolean).join(" + ");
}
var ROW = /^\s*[❯›]?\s*(\d+)\.\s+(?:\[[ ✔]\]\s+)?(.+?)\s*$/;
function pickerRows(lines, footer) {
  const rows = [];
  for (let i = footer - 1; i >= 0; i--) {
    const match = ROW.exec(lines[i] ?? "");
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    if (rows.length > 0 && index >= rows[0].index) {
      break;
    }
    rows.unshift({ index, label: match[2] });
    if (index === 1) {
      break;
    }
  }
  return rows;
}
var lastIndex = (lines, test) => lines.findLastIndex(test);
function claudePickerFooter(lines) {
  return lastIndex(lines, (line) => line.includes("Enter to select") && line.includes("Esc to cancel"));
}
function claudeQuestionCount(lines) {
  const header = lines[lastIndex(lines, (line) => /[☐☒]/.test(line))] ?? "";
  return Math.max(1, (header.match(/[☐☒]/g) ?? []).length);
}
function claudePickerHeading(lines) {
  const header = lastIndex(lines, (line) => /[☐☒]/.test(line));
  return header < 0 ? "" : (lines.slice(header + 1).find((line) => line.trim()) ?? "").trim();
}
function claudePermissionFooter(lines) {
  const footer = lastIndex(lines, (line) => line.trim().startsWith("Esc to cancel"));
  return footer >= 0 && lines.slice(0, footer).some((line) => line.includes("Do you want to")) ? footer : -1;
}
function codexPermissionFooter(lines) {
  return lastIndex(lines, (line) => line.includes("Press enter to confirm or esc to cancel"));
}
function claudeAskShown(lines, footer, item) {
  const summary = item.permission?.summary.trim().split("\n")[0] ?? "";
  const top = lines.slice(0, footer).findLastIndex((line) => /^─{10,}/.test(line.trim()));
  const box = lines.slice(top + 1, footer);
  if (item.permission?.toolName === "Bash" && summary) {
    return box.some((line) => sameHeading(line, summary));
  }
  if (summary.startsWith("/")) {
    const file = normalize(summary.split("/").pop() ?? "");
    return box.some((line) => normalize(line).includes(file));
  }
  return true;
}
function claudeReviewShown(lines) {
  return lines.some((line) => line.includes("Ready to submit your answers?"));
}
function codexPickerFooter(lines) {
  return lastIndex(lines, (line) => line.includes("enter submit") && line.includes("main prompt"));
}
function codexQuestionQueued(lines) {
  return lines.some((line) => line.includes("\u2325 + \u2191 to answer"));
}
var Refusal = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function refuse(code, message) {
  throw new Refusal(code, message);
}
var FREE_ROWS = /^(type something|other|chat about this)/;
var normalize = (text2) => text2.replace(/\s+/g, " ").trim().toLowerCase();
function sameHeading(shown, want) {
  const a = normalize(shown).replace(/…$/, "");
  const b = normalize(want);
  return a.length > 0 && (a.startsWith(b) || b.startsWith(a));
}
function decisionRow(rows, allow) {
  const row = allow ? rows.find((candidate) => candidate.index === 1 && /^yes\b/.test(normalize(candidate.label))) : rows.find((candidate) => /^no\b/.test(normalize(candidate.label)));
  if (!row) {
    refuse("terminal_rejected", `the pane's prompt has no plain ${allow ? "Yes" : "No"} row; answer in the pane`);
  }
  return row;
}
var partsOf = (item) => item.question ? [item.question, ...item.question.more ?? []] : [];
function checkOptions(rows, indexes, options) {
  for (const index of indexes) {
    const row = rows.find((candidate) => candidate.index === index);
    const expected = options.find((option) => option.index === index);
    if (!row) {
      refuse("terminal_rejected", `option ${index} isn't on the pane's picker`);
    }
    const shown = normalize(row.label).replace(/…$/, "");
    const want = normalize(expected?.label ?? "");
    const matches = want ? shown.startsWith(want) || want.startsWith(shown) : !FREE_ROWS.test(shown);
    if (!matches) {
      refuse("terminal_rejected", `option ${index} on the pane is "${row.label}", not "${expected?.label ?? "an option"}"`);
    }
  }
}
function checkNoDraft(screen2) {
  const draft = screen2.draft?.trim();
  if (draft) {
    refuse("terminal_rejected", `the pane has unsent text in its composer: "${draft.slice(0, 60)}"`);
  }
}
var ReplySender = class {
  deps;
  /** What the reply in progress has read and typed, for its failure record. */
  trace = { keys: [], screen: null, draft: null };
  constructor(deps) {
    this.deps = deps;
  }
  async readScreen(handle) {
    const screen2 = await this.deps.screen(handle);
    this.trace.screen = screen2.lines;
    this.trace.draft = screen2.draft ?? null;
    return screen2;
  }
  async press(handle, input) {
    await this.deps.send(handle, input);
    this.trace.keys.push(describeKey(input));
  }
  sleep(ms) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((done) => setTimeout(done, ms));
  }
  async key(handle, input) {
    await this.press(handle, input);
    await this.sleep(KEY_GAP_MS);
  }
  /** Re-reads the screen until `ready` holds, for keys whose effect takes a repaint. */
  async screenUntil(handle, ready) {
    for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += KEY_GAP_MS) {
      const screen2 = await this.readScreen(handle);
      if (ready(screen2.lines)) {
        return screen2;
      }
      await this.sleep(KEY_GAP_MS);
    }
    return null;
  }
  async send(item, request) {
    this.trace = { keys: [], screen: null, draft: null };
    const result = await this.attempt(item, request);
    if (!result.ok) {
      this.deps.onFailure?.(this.failure(item, request, result.error));
    }
    return result;
  }
  failure(item, request, error) {
    const at = this.deps.now?.() ?? Date.now();
    return {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      itemId: request.id,
      agent: item?.agent ?? null,
      kind: item?.kind ?? null,
      where: item ? `${item.project} / ${item.title}` : null,
      reply: request.reply,
      code: error.code,
      message: error.message,
      keysSent: [...this.trace.keys],
      screen: this.trace.screen?.slice(-FAILURE_SCREEN_LINES) ?? null,
      draft: this.trace.draft
    };
  }
  async attempt(item, request) {
    try {
      if (!item) {
        refuse("not_found", `no feed item ${request.id}`);
      }
      if (item.kind === "closed") {
        refuse("session_closed", "the session has closed");
      }
      if (item.kind === "permission" && request.reply.type !== "permission") {
        refuse("bad_request", "answer a permission ask with Allow or Deny");
      }
      if (item.kind !== "permission" && request.reply.type === "permission") {
        refuse("bad_request", "this item is not a permission ask");
      }
      if (!item.terminal) {
        refuse("session_closed", NOT_IN_TMUX);
      }
      const terminal = await this.deps.terminalFor(item.id);
      if (!terminal) {
        refuse("session_closed", "the pane has no live terminal");
      }
      const handle = terminal.handle;
      if (request.reply.type === "permission") {
        await (item.agent === "claude" ? this.claudePermission(handle, item, request.reply) : this.codexPermission(handle, item, request.reply));
      } else if (item.kind === "finished") {
        await this.message(handle, item, request.reply);
      } else if (item.agent === "claude") {
        await this.claudeQuestion(handle, item, request.reply);
      } else {
        await this.codexQuestion(handle, item, request.reply);
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof Refusal) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      const code = error instanceof TerminalError && error.code !== "cli_failed" ? "terminal_rejected" : "cli_failed";
      return { ok: false, error: { code, message: error.message } };
    }
  }
  /** A normal message into the composer. Both agents queue it if a turn is running (issue 0004). */
  async message(handle, item, reply) {
    if (reply.type !== "text") {
      refuse("bad_request", "this item has no options to pick; reply with text");
    }
    const screen2 = await this.readScreen(handle);
    if (claudePickerFooter(screen2.lines) >= 0 || codexPickerFooter(screen2.lines) >= 0) {
      refuse("terminal_rejected", "the pane has a picker open; answer it there or wait for the feed to catch up");
    }
    checkNoDraft(screen2);
    await this.press(handle, { text: reply.text, enter: true });
  }
  async claudeQuestion(handle, item, reply) {
    const screen2 = await this.readScreen(handle);
    const footer = claudePickerFooter(screen2.lines);
    if (footer < 0) {
      if (reply.type === "text") {
        await this.message(handle, item, reply);
        return;
      }
      refuse("terminal_rejected", "the question isn't open in the pane any more");
    }
    const parts = partsOf(item);
    const count = claudeQuestionCount(screen2.lines);
    if (count > 1 || parts.length > 1) {
      if (count !== parts.length) {
        refuse("terminal_rejected", `the pane's picker has ${count} questions, not ${parts.length}`);
      }
      if (reply.type !== "answers") {
        refuse("bad_request", "this asks several questions; pick an answer for each");
      }
      await this.claudeParts(handle, parts, reply.answers);
      return;
    }
    if (reply.type === "answers") {
      reply = { type: "option", indexes: reply.answers[0] ?? [] };
    }
    if (reply.type === "permission") {
      refuse("bad_request", "this item is not a permission ask");
    }
    const rows = pickerRows(screen2.lines, footer);
    const multiSelect = item.question?.multiSelect === true;
    if (reply.type === "text") {
      if (multiSelect) {
        refuse("bad_request", "free text on a multi-select question is typed in the pane");
      }
      const other = rows.find((row) => normalize(row.label).startsWith("type something"));
      if (!other) {
        refuse("terminal_rejected", 'the picker has no "Type something" row');
      }
      await this.key(handle, { text: String(other.index) });
      await this.key(handle, { text: reply.text.replace(/\s*\n\s*/g, " ") });
      await this.press(handle, { enter: true });
      return;
    }
    if (!multiSelect && reply.indexes.length > 1) {
      refuse("bad_request", "this question takes one option");
    }
    checkOptions(rows, reply.indexes, item.question?.options ?? []);
    if (!multiSelect) {
      await this.press(handle, { text: String(reply.indexes[0]) });
      return;
    }
    for (const index of new Set(reply.indexes)) {
      await this.key(handle, { text: String(index) });
    }
    await this.press(handle, { text: RIGHT });
    if (!await this.screenUntil(handle, claudeReviewShown)) {
      refuse("terminal_rejected", "the options are ticked but the review screen didn't open; submit in the pane");
    }
    await this.press(handle, { text: "1" });
  }
  /**
   * Answers each part of a multi-question picker in turn: a digit for a
   * single-select part (it moves on by itself), toggles then Right for a
   * multi-select one. Then 1 submits the review screen.
   */
  async claudeParts(handle, parts, answers) {
    if (answers.length !== parts.length) {
      refuse("bad_request", `pick an answer for each of the ${parts.length} questions`);
    }
    for (const [n, part] of parts.entries()) {
      const answer = answers[n];
      if (!part.options.length) {
        refuse("bad_request", `question ${n + 1} has no options; answer it in the pane`);
      }
      if (!answer.length || !part.multiSelect && answer.length > 1) {
        refuse("bad_request", `question ${n + 1} takes ${part.multiSelect ? "one or more options" : "one option"}`);
      }
      const screen2 = await this.screenUntil(handle, (lines) => sameHeading(claudePickerHeading(lines), part.title));
      if (!screen2) {
        refuse("terminal_rejected", n === 0 ? `the pane's picker doesn't start with "${part.title}"` : `answered ${n} of ${parts.length} questions, then the pane didn't show "${part.title}"; finish in the pane`);
      }
      checkOptions(pickerRows(screen2.lines, claudePickerFooter(screen2.lines)), answer, part.options);
      if (part.multiSelect) {
        for (const index of new Set(answer)) {
          await this.key(handle, { text: String(index) });
        }
        await this.key(handle, { text: RIGHT });
      } else {
        await this.key(handle, { text: String(answer[0]) });
      }
    }
    if (!await this.screenUntil(handle, claudeReviewShown)) {
      refuse("terminal_rejected", "every question is answered but the review screen didn't open; submit in the pane");
    }
    await this.press(handle, { text: "1" });
  }
  /**
   * Claude: the row's digit decides. With a note: Down to the row, Tab to
   * amend it, the note, Enter. Rows: 1. Yes, 2. Yes and always allow…, 3. No.
   */
  async claudePermission(handle, item, reply) {
    const screen2 = await this.readScreen(handle);
    const footer = claudePermissionFooter(screen2.lines);
    if (footer < 0) {
      refuse("terminal_rejected", "the permission ask isn't open in the pane any more");
    }
    if (!claudeAskShown(screen2.lines, footer, item)) {
      refuse("terminal_rejected", `the pane's prompt isn't about "${item.permission?.summary.slice(0, 60)}"; answer in the pane`);
    }
    const row = decisionRow(pickerRows(screen2.lines, footer), reply.allow);
    const note = reply.note?.replace(/\s*\n\s*/g, " ").trim();
    if (!note) {
      await this.press(handle, { text: String(row.index) });
      return;
    }
    if (!screen2.lines.some((line) => /^\s*❯\s*1\./.test(line))) {
      refuse("terminal_rejected", "the pane's cursor isn't on the first row; answer in the pane");
    }
    for (let i = 1; i < row.index; i++) {
      await this.key(handle, { text: DOWN });
    }
    await this.press(handle, { text: TAB });
    const amending = await this.screenUntil(handle, (lines) => {
      const at = claudePermissionFooter(lines);
      return at >= 0 && !lines[at].includes("Tab to amend");
    });
    if (!amending) {
      refuse("terminal_rejected", "the note box didn't open; answer in the pane");
    }
    await this.key(handle, { text: note });
    await this.press(handle, { enter: true });
  }
  /** Codex: the row's digit decides. A note follows as a normal message once the prompt closes. */
  async codexPermission(handle, item, reply) {
    const screen2 = await this.readScreen(handle);
    const footer = codexPermissionFooter(screen2.lines);
    if (footer < 0) {
      refuse("terminal_rejected", "the approval prompt isn't open in the pane any more");
    }
    const command = screen2.lines.slice(0, footer).findLast((line) => line.trim().startsWith("$ "));
    const summary = item.permission?.summary ?? "";
    if (command && summary && !sameHeading(command.trim().slice(2), summary)) {
      refuse("terminal_rejected", `the pane is asking to run "${command.trim().slice(2)}", not "${summary}"`);
    }
    const row = decisionRow(pickerRows(screen2.lines, footer), reply.allow);
    await this.press(handle, { text: String(row.index) });
    const note = reply.note?.trim();
    if (!note) {
      return;
    }
    if (!await this.screenUntil(handle, (lines) => codexPermissionFooter(lines) < 0)) {
      refuse("terminal_rejected", "the decision went through but the note didn't; type it in the pane");
    }
    await this.message(handle, item, { type: "text", text: note });
  }
  async codexQuestion(handle, item, reply) {
    if (reply.type === "answers" || reply.type === "permission") {
      refuse("bad_request", "Codex questions take one option or free text");
    }
    if (reply.type === "text") {
      await this.message(handle, item, reply);
      return;
    }
    if (reply.indexes.length > 1) {
      refuse("bad_request", "Codex questions take one option");
    }
    let screen2 = await this.readScreen(handle);
    let openedHere = false;
    if (codexPickerFooter(screen2.lines) < 0) {
      if (!codexQuestionQueued(screen2.lines)) {
        refuse("terminal_rejected", "the question isn't waiting in the pane any more");
      }
      await this.press(handle, { text: OPTION_UP });
      const opened = await this.screenUntil(handle, (lines) => codexPickerFooter(lines) >= 0);
      if (!opened) {
        refuse("terminal_rejected", "the question picker didn't open");
      }
      screen2 = opened;
      openedHere = true;
    }
    try {
      checkOptions(pickerRows(screen2.lines, codexPickerFooter(screen2.lines)), reply.indexes, item.question?.options ?? []);
    } catch (error) {
      if (openedHere) {
        await this.press(handle, { text: OPTION_DOWN });
      }
      throw error;
    }
    await this.press(handle, { text: String(reply.indexes[0]) });
  }
};

// src/server.ts
import { createServer as createHttpServer } from "node:http";
var MAX_BODY_BYTES = 64 * 1024;
var STREAM_PING_MS = 25e3;
function sendJson(res, status2, body) {
  res.writeHead(status2, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function sendError(res, status2, code, message) {
  sendJson(res, status2, { ok: false, error: { code, message } });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}
function isReplyRequest(body) {
  const candidate = body;
  if (typeof candidate?.id !== "string" || typeof candidate.reply !== "object" || !candidate.reply) {
    return false;
  }
  const reply = candidate.reply;
  const isIndexes = (indexes) => Array.isArray(indexes) && indexes.length > 0 && indexes.every((index) => Number.isInteger(index) && index >= 1);
  switch (reply.type) {
    case "text":
      return typeof reply.text === "string" && reply.text.trim().length > 0;
    case "option":
      return isIndexes(reply.indexes);
    case "answers":
      return Array.isArray(reply.answers) && reply.answers.length > 0 && reply.answers.every(isIndexes);
    case "permission":
      return typeof reply.allow === "boolean" && (reply.note === void 0 || typeof reply.note === "string");
    default:
      return false;
  }
}
function isIdRequest(body) {
  return typeof body?.id === "string";
}
function isDismissRequest(body) {
  const candidate = body;
  return typeof candidate?.id === "string" || candidate?.allFinished === true;
}
function statusFor(result) {
  return result.ok ? 200 : result.error.code === "not_found" ? 404 : result.error.code === "bad_request" ? 400 : 409;
}
function startServer(deps) {
  const allowedHosts = /* @__PURE__ */ new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const streams = /* @__PURE__ */ new Set();
  let lastSnapshot = null;
  function writeFeedEvent(res, snapshot) {
    res.write(`event: ${STREAM_EVENT_FEED}
data: ${JSON.stringify(snapshot)}

`);
  }
  async function handle(req, res) {
    const origin = req.headers.origin;
    if (!allowedHosts.has(req.headers.host ?? "") || origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) {
      sendError(res, 403, "forbidden", "request is not from Decision Center");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET") {
      if (path === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // Why img-src data: the page's grain texture is an inline SVG.
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"
        });
        res.end(deps.page);
        return;
      }
      if (path === "/api/health") {
        sendJson(res, 200, { ok: true, version: API_VERSION, ...deps.health() });
        return;
      }
      if (path === "/api/feed") {
        sendJson(res, 200, await deps.getFeed());
        return;
      }
      if (path === "/api/failures") {
        sendJson(res, 200, await deps.failures());
        return;
      }
      if (path === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive"
        });
        streams.add(res);
        req.on("close", () => streams.delete(res));
        writeFeedEvent(res, lastSnapshot ?? await deps.getFeed());
        return;
      }
    }
    if (req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        sendError(res, 415, "bad_request", "POST bodies must be application/json");
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendError(res, 400, "bad_request", error.message);
        return;
      }
      if (path === "/api/failures/clear") {
        const result = await deps.clearFailures();
        sendJson(res, statusFor(result), result);
        return;
      }
      if (path === "/api/reply") {
        if (!isReplyRequest(body)) {
          sendError(res, 400, "bad_request", "expected { id, reply } with reply type text, option, answers or permission");
          return;
        }
        const result = await deps.reply(body);
        sendJson(res, statusFor(result), result);
        return;
      }
      if (path === "/api/read") {
        if (!isIdRequest(body)) {
          sendError(res, 400, "bad_request", "expected { id }");
          return;
        }
        const result = await deps.read(body);
        sendJson(res, statusFor(result), result);
        return;
      }
      if (path === "/api/open") {
        if (!isIdRequest(body)) {
          sendError(res, 400, "bad_request", "expected { id }");
          return;
        }
        const result = await deps.open(body);
        sendJson(res, statusFor(result), result);
        return;
      }
      if (path === "/api/dismiss") {
        if (!isDismissRequest(body)) {
          sendError(res, 400, "bad_request", "expected { id } or { allFinished: true }");
          return;
        }
        const result = await deps.dismiss(body);
        sendJson(res, statusFor(result), result);
        return;
      }
      if (path === "/api/suggest") {
        if (!isIdRequest(body)) {
          sendError(res, 400, "bad_request", "expected { id }");
          return;
        }
        const result = await deps.suggest(body);
        sendJson(res, statusFor(result), result);
        return;
      }
    }
    sendError(res, 404, "not_found", `${req.method} ${path} is not served`);
  }
  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      deps.log(`request failed: ${error.message}`);
      if (!res.headersSent) {
        sendError(res, 500, "cli_failed", error.message);
      } else {
        res.end();
      }
    });
  });
  const pingTimer = setInterval(() => {
    for (const res of streams) {
      res.write(": ping\n\n");
    }
  }, STREAM_PING_MS);
  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      clearInterval(pingTimer);
      reject(error);
    });
    server.listen(deps.port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${deps.port}/`,
        broadcast(snapshot) {
          lastSnapshot = snapshot;
          for (const res of streams) {
            writeFeedEvent(res, snapshot);
          }
        },
        close() {
          clearInterval(pingTimer);
          for (const res of streams) {
            res.end();
          }
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

// src/sessionlog.ts
import { open as open2, readdir, stat as stat3, unlink } from "node:fs/promises";
import { join as join6 } from "node:path";

// src/sources.ts
import { open, stat as stat2 } from "node:fs/promises";
var TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
function partFromRaw(raw) {
  const title = (raw.question ?? raw.title ?? raw.header ?? "").trim();
  const options = (raw.options ?? []).flatMap((option, i) => {
    const label = typeof option === "string" ? option : option?.label;
    if (!label) {
      return [];
    }
    const description = typeof option === "string" ? void 0 : option.description;
    return [{ index: i + 1, label, ...description ? { description } : {} }];
  });
  const header = raw.header?.trim();
  return { title: title || "Question", ...header ? { header } : {}, multiSelect: raw.multiSelect === true, options };
}
function questionFromArgs(args) {
  const list = Array.isArray(args?.questions) ? args.questions : [];
  const [first, ...rest] = list.filter((raw) => !!raw && typeof raw === "object");
  if (!first) {
    return null;
  }
  const question = partFromRaw(first);
  return rest.length ? { ...question, more: rest.map(partFromRaw) } : question;
}
function pendingCodexQuestion(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"response_item"')) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload;
    if (record.type !== "response_item" || !payload) {
      continue;
    }
    if (payload.type === "message" && payload.role === "user") {
      return null;
    }
    if (payload.type === "function_call" && payload.name === "request_user_input_async") {
      try {
        return questionFromArgs(JSON.parse(payload.arguments ?? "{}"));
      } catch {
        return { title: "Question", multiSelect: false, options: [] };
      }
    }
  }
  return null;
}
async function tailLines(path, size) {
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}
var CodexTranscripts = class {
  cache = /* @__PURE__ */ new Map();
  async pendingQuestion(path) {
    try {
      const { size, mtimeMs } = await stat2(path);
      const cached = this.cache.get(path);
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
        return cached.question;
      }
      const question = pendingCodexQuestion(await tailLines(path, size));
      this.cache.set(path, { size, mtimeMs, question });
      return question;
    } catch {
      return null;
    }
  }
};

// src/session.ts
var isNotification = (prompt) => prompt.trimStart().startsWith("<task-notification>");
function askFor(tool, event, current) {
  const at = current?.key === tool.key ? current.at : event.at;
  if (isQuestionTool(tool.name)) {
    const question = questionFromArgs({ questions: tool.questions }) ?? { title: "Question", multiSelect: false, options: [] };
    return { kind: "question", question, key: tool.key, actor: event.actor, at };
  }
  return { kind: "permission", permission: { toolName: tool.name, summary: tool.summary }, key: tool.key, actor: event.actor, at };
}
function turn(session, next, at) {
  return { turn: next, turnSince: session.turn === next ? session.turnSince : at };
}
var working = (s, e) => e.actor ? {} : turn(s, "working", e.at);
var RULES = {
  // Why startedAt moves: a resumed session runs in a newer process, and liveness checks compare the two.
  SessionStart: (_s, e) => ({ ended: false, startedAt: e.at }),
  UserPromptSubmit: (s, e) => ({
    ...turn(s, "working", e.at),
    pending: null,
    prompt: e.prompt === void 0 || isNotification(e.prompt) ? s.prompt : e.prompt
  }),
  PreToolUse: (s, e) => ({
    ...working(s, e),
    ...e.tool && isQuestionTool(e.tool.name) ? { pending: askFor(e.tool, e, s.pending) } : {}
  }),
  PermissionRequest: (s, e) => e.tool ? { pending: askFor(e.tool, e, s.pending) } : null,
  PostToolUse: (s, e) => ({ ...working(s, e), ...s.pending && s.pending.key === e.tool?.key ? { pending: null } : {} }),
  PostToolUseFailure: (s, e) => RULES.PostToolUse(s, e),
  // Why a subagent's ask survives Stop: a background subagent can ask after the
  // main turn ends. The main agent's own ask was answered if its turn ended.
  Stop: (s, e) => e.actor ? null : { turn: "done", turnSince: e.at, lastMessage: e.lastMessage ?? null, pending: s.pending?.actor ? s.pending : null },
  StopFailure: (s, e) => RULES.Stop(s, e),
  // Why Codex is ignored: it fires SessionEnd seconds after each turn while the TUI stays open.
  SessionEnd: (s) => s.agent === "claude" ? { ended: true } : null
};
function created(event) {
  return {
    id: `${event.agent}:${event.sessionId}`,
    agent: event.agent,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    pane: event.pane,
    pid: event.pid,
    startedAt: event.at,
    turn: "idle",
    turnSince: event.at,
    pending: null,
    prompt: null,
    lastMessage: null,
    ended: false,
    updatedAt: event.at
  };
}
function reduce(session, event) {
  const base = session ?? created(event);
  const change = RULES[event.event]?.(base, event);
  if (!change) {
    return base;
  }
  return {
    ...base,
    cwd: event.cwd || base.cwd,
    transcriptPath: event.transcriptPath ?? base.transcriptPath,
    pane: event.pane ?? base.pane,
    pid: event.pid ?? base.pid,
    ...change,
    updatedAt: Math.max(base.updatedAt, event.at)
  };
}

// src/sessionlog.ts
function isHookEvent(value) {
  const event = value;
  return event?.v === 1 && (event.agent === "claude" || event.agent === "codex") && typeof event.event === "string" && typeof event.sessionId === "string" && typeof event.at === "number";
}
var SessionLog = class {
  dir;
  tails = /* @__PURE__ */ new Map();
  constructor(dir) {
    this.dir = dir;
  }
  async read(name) {
    const path = join6(this.dir, name);
    let tail = this.tails.get(name) ?? { offset: 0, session: void 0 };
    const { size } = await stat3(path);
    if (size < tail.offset) {
      tail = { offset: 0, session: void 0 };
    }
    this.tails.set(name, tail);
    if (size === tail.offset) {
      return;
    }
    const buffer = Buffer.alloc(size - tail.offset);
    const handle = await open2(path, "r");
    try {
      await handle.read(buffer, 0, buffer.length, tail.offset);
    } finally {
      await handle.close();
    }
    const end = buffer.lastIndexOf(10);
    if (end < 0) {
      return;
    }
    tail.offset += end + 1;
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isHookEvent(event)) {
        tail.session = reduce(tail.session, event);
      }
    }
  }
  /** Every session seen, after reducing what was appended since the last call. */
  async refresh() {
    const names = (await readdir(this.dir).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    for (const name of this.tails.keys()) {
      if (!names.includes(name)) {
        this.tails.delete(name);
      }
    }
    for (const name of names) {
      await this.read(name).catch(() => this.tails.delete(name));
    }
    return [...this.tails.values()].flatMap((tail) => tail.session ? [tail.session] : []);
  }
  /** Deletes session files with no event for `maxAgeMs`. */
  async prune(now, maxAgeMs) {
    for (const name of await readdir(this.dir).catch(() => [])) {
      const path = join6(this.dir, name);
      const info = await stat3(path).catch(() => null);
      if (name.endsWith(".jsonl") && info && info.mtimeMs < now - maxAgeMs) {
        await unlink(path).catch(() => void 0);
      }
    }
  }
};
var runKey = (session) => session.pane && session.pid !== null ? `${session.pane.socket}\0${session.pane.id}\0${session.pid}` : null;
function viewSessions(sessions, alive) {
  const running = sessions.filter((session) => !session.ended && alive(session));
  const newest = /* @__PURE__ */ new Map();
  for (const session of running) {
    const key = runKey(session);
    const held = key ? newest.get(key) : void 0;
    if (key && (!held || held.updatedAt < session.updatedAt)) {
      newest.set(key, session);
    }
  }
  const winner = (session) => {
    const key = runKey(session);
    return key ? newest.get(key) : void 0;
  };
  return {
    live: running.filter((session) => (winner(session) ?? session) === session),
    replaced: new Set(sessions.filter((session) => winner(session) && winner(session) !== session).map((session) => session.id))
  };
}

// src/storage.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join7 } from "node:path";
function jsonFile(path) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile2(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async save(value) {
      await mkdir2(dirname2(path), { recursive: true, mode: 448 });
      const temp = join7(dirname2(path), `.${randomBytes2(6).toString("hex")}.tmp`);
      await writeFile2(temp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
      await rename2(temp, path);
    }
  };
}

// src/store.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
var FIRST_INSTALL_STALE_MS = DAY_MS;
var FORGET_UNSEEN_MS = 7 * DAY_MS;
var SILENT_CHECK_AFTER_MS = 3e3;
var NOTICE_LINES = 8;
function codexStopNotice(lines) {
  const filled = lines.filter((line) => line.trim());
  const composer = filled.findLastIndex((line) => /^›(\s|$)/.test(line));
  for (let i = composer - 1; i >= Math.max(0, composer - NOTICE_LINES); i--) {
    const line = filled[i];
    if (line.startsWith("\u25A0")) {
      return filled.slice(i, composer).map((part) => part.trim()).join(" ").replace(/^■\s*/, "");
    }
    if (/^[›•]/.test(line)) {
      return null;
    }
  }
  return null;
}
function isStoredFlags(value) {
  const flags = value;
  return flags?.v === 1 && typeof flags.installedAt === "number" && typeof flags.sessions === "object" && !!flags.sessions;
}
function askShown(agent, lines) {
  return agent === "claude" ? claudePermissionFooter(lines) >= 0 || claudePickerFooter(lines) >= 0 : codexPermissionFooter(lines) >= 0 || codexPickerFooter(lines) >= 0 || codexQuestionQueued(lines);
}
var INTERRUPT_LINES = 4;
function interruptedShown(agent, lines) {
  const filled = lines.filter((line) => line.trim());
  const composer = agent === "claude" ? filled.findLastIndex((line, i) => line.startsWith("\u276F") && /^─{10,}$/.test((filled[i - 1] ?? "").trim())) - 1 : filled.findLastIndex((line) => /^›(\s|$)/.test(line));
  if (composer < 0) {
    return false;
  }
  const notice = agent === "claude" ? "Interrupted \xB7" : "Conversation interrupted";
  return filled.slice(Math.max(0, composer - INTERRUPT_LINES), composer).some((line) => line.includes(notice));
}
var FeedStore = class {
  flags = null;
  firstRun = false;
  savedJson = "";
  /** Items of live sessions from the last refresh, dismissed ones included. */
  live = /* @__PURE__ */ new Map();
  /** Sessions that ended or died while they had an item. Memory only. */
  closed = /* @__PURE__ */ new Map();
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  now() {
    return this.deps.now?.() ?? Date.now();
  }
  async loadFlags() {
    if (!this.flags) {
      let stored = null;
      try {
        stored = await this.deps.loadFlags();
      } catch (error) {
        this.deps.log(`loading flags failed: ${error.message}`);
      }
      if (isStoredFlags(stored)) {
        this.flags = stored;
        this.savedJson = JSON.stringify(stored);
      } else {
        this.flags = { v: 1, installedAt: this.now(), sessions: {} };
        this.firstRun = true;
      }
    }
    return this.flags;
  }
  async persist() {
    const json = JSON.stringify(this.flags);
    if (json === this.savedJson) {
      return;
    }
    try {
      await this.deps.saveFlags(this.flags);
      this.savedJson = json;
    } catch (error) {
      this.deps.log(`saving flags failed: ${error.message}`);
    }
  }
  flagsOf(id) {
    const flags = this.flags;
    flags.sessions[id] ??= { seen: this.now() };
    return flags.sessions[id];
  }
  find(id) {
    const item = this.live.get(id);
    return item ? { item, key: itemKey(item) } : this.closed.get(id);
  }
  visible() {
    const entries = [...[...this.live.values()].map((item) => ({ item, key: itemKey(item) })), ...this.closed.values()];
    return entries.filter(({ item, key }) => this.flags?.sessions[item.id]?.dismissed !== key);
  }
  /**
   * The session's ask as its pane shows it. Why: denying or cancelling an ask
   * in the pane fires no hook (fact 9). `gone` means the prompt left the screen;
   * `interrupted` means the pane also says the turn was interrupted, which
   * tells a denied ask from an allowed command that is still running. Nothing
   * is stored, so the next refresh checks again; an unreadable screen keeps the ask.
   */
  async askOnScreen(session, now) {
    const { pending, pane } = session;
    if (!pending || !pane || pending.at > now - SILENT_CHECK_AFTER_MS) {
      return "shown";
    }
    try {
      const { lines } = await this.deps.screen(pane);
      if (askShown(session.agent, lines)) {
        return "shown";
      }
      return interruptedShown(session.agent, lines) ? "interrupted" : "gone";
    } catch {
      return "shown";
    }
  }
  /**
   * What the pane says ended the session's turn, when no hook did. Why: a
   * Codex turn that fails (a refused model, a dropped connection) or is
   * interrupted fires no Stop hook, and the session then waits at its composer.
   */
  async stoppedOnScreen(session, now) {
    const { pane } = session;
    if (session.agent !== "codex" || session.turn !== "working" || session.pending || !pane || session.turnSince > now - SILENT_CHECK_AFTER_MS) {
      return null;
    }
    try {
      return codexStopNotice((await this.deps.screen(pane)).lines);
    } catch {
      return null;
    }
  }
  /** The item for a session as the feed last saw it, dismissed or closed ones included. */
  item(id) {
    return this.find(id)?.item;
  }
  snapshot() {
    const items = this.visible().map(({ item, key }) => ({ ...item, unread: this.flags?.sessions[item.id]?.read !== key }));
    return snapshotOf(items, this.now());
  }
  async refresh() {
    const flags = await this.loadFlags();
    const view = await this.deps.sessions();
    const now = this.now();
    const present = /* @__PURE__ */ new Set();
    const next = /* @__PURE__ */ new Map();
    for (const session of view.live) {
      present.add(session.id);
      const onScreen = await this.askOnScreen(session, now);
      const pending = onScreen === "shown" ? session.pending : null;
      const codexQuestion = session.agent === "codex" && !pending && session.turn === "done" && session.transcriptPath ? await this.deps.codexQuestion(session.transcriptPath) : null;
      const cancelled = onScreen === "interrupted" && session.pending && !session.pending.actor && session.turn === "working";
      const notice = await this.stoppedOnScreen(session, now);
      const item = itemFromSession(session, {
        pending,
        codexQuestion,
        ...cancelled ? { cancelledAt: session.pending.at } : {},
        ...notice ? { stopped: { at: session.turnSince, notice } } : {}
      });
      if (item) {
        next.set(item.id, item);
      }
    }
    for (const [id, item] of this.live) {
      if (!present.has(id) && !view.replaced.has(id)) {
        const closed = {
          ...item,
          kind: "closed",
          state: "closed",
          terminal: null,
          question: null,
          permission: null,
          proposals: [],
          canSuggest: false,
          updatedAt: now
        };
        this.closed.set(id, { item: closed, key: itemKey(item) });
      }
    }
    for (const id of present) {
      this.closed.delete(id);
    }
    this.live = next;
    for (const id of present) {
      this.flagsOf(id).seen = now;
    }
    if (this.firstRun) {
      this.firstRun = false;
      for (const item of next.values()) {
        if (item.since < now - FIRST_INSTALL_STALE_MS) {
          const key = itemKey(item);
          Object.assign(this.flagsOf(item.id), { read: key, dismissed: key });
        }
      }
    }
    for (const [id, item] of Object.entries(flags.sessions)) {
      if (item.seen < now - FORGET_UNSEEN_MS && !this.closed.has(id)) {
        delete flags.sessions[id];
      }
    }
    await this.persist();
    return this.snapshot();
  }
  async read(id) {
    await this.loadFlags();
    const found = this.find(id);
    if (!found) {
      return { ok: false, error: { code: "not_found", message: `no feed item ${id}` } };
    }
    this.flagsOf(id).read = found.key;
    await this.persist();
    return { ok: true };
  }
  async dismiss(request) {
    await this.loadFlags();
    if ("allFinished" in request) {
      for (const { item, key } of this.visible()) {
        if (item.kind === "finished") {
          this.flagsOf(item.id).dismissed = key;
        }
      }
    } else {
      const found = this.find(request.id);
      if (!found) {
        return { ok: false, error: { code: "not_found", message: `no feed item ${request.id}` } };
      }
      this.flagsOf(request.id).dismissed = found.key;
      this.closed.delete(request.id);
    }
    await this.persist();
    return { ok: true };
  }
};

// src/tmux.ts
import { execFile as execFile3 } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join as join8 } from "node:path";
var TIMEOUT_MS = 5e3;
var ENTER_AFTER_TEXT_MS = 500;
function tmux(socket, args) {
  return new Promise((resolve, reject) => {
    execFile3("tmux", ["-u", "-S", socket, ...args], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new TerminalError(`tmux: ${(stderr || error.message).trim()}`, "cli_failed"));
        return;
      }
      resolve(stdout);
    });
  });
}
function tmuxSockets(env = process.env) {
  const dir = join8(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join8(dir, name);
      try {
        return statSync(path).isSocket() ? [realpathSync(path)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
var PANE_FORMAT = "#{pane_id}	#{pane_tty}	#{pane_pid}	#{pane_in_mode}	#{pane_dead}";
async function panes(sockets) {
  const lists = await Promise.all(
    sockets.map(async (socket) => {
      const out = await tmux(socket, ["list-panes", "-a", "-F", PANE_FORMAT]).catch(() => "");
      return out.split("\n").filter(Boolean).map((line) => {
        const [id = "", tty = "", pid = "", inMode = "", dead = ""] = line.split("	");
        return { socket, id, tty, pid: Number(pid), inMode: inMode === "1", dead: dead === "1" };
      });
    })
  );
  return lists.flat();
}
var SGR = /\x1b\[([0-9;:]*)m/g;
var OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function applySgr(style, params) {
  const codes = params.replace(/:/g, ";").split(";").map((code) => code === "" ? 0 : Number(code));
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) next = { dim: false, fg: null };
    else if (code === 2) next.dim = true;
    else if (code === 22) next.dim = false;
    else if (code === 39) next.fg = null;
    else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) next.fg = String(code);
    else if (code === 38 && codes[i + 1] === 5) {
      next.fg = `38;5;${codes[i + 2]}`;
      i += 2;
    } else if (code === 38 && codes[i + 1] === 2) {
      next.fg = `38;2;${codes.slice(i + 2, i + 5).join(";")}`;
      i += 4;
    } else if (code === 48) {
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  return next;
}
function isGrey(fg) {
  if (!fg) return false;
  if (fg === "90" || fg === "37") return true;
  const indexed = /^38;5;(\d+)$/.exec(fg);
  if (indexed) {
    const n = Number(indexed[1]);
    return n === 8 || n === 7 || n >= 232 && n <= 255;
  }
  const rgb = /^38;2;(\d+);(\d+);(\d+)$/.exec(fg);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number);
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && Math.max(r, g, b) < 230;
  }
  return false;
}
function cellsOf(styled) {
  let style = { dim: false, fg: null };
  return styled.map((raw) => {
    const cells = [];
    const line = raw.replace(OSC, "");
    let at = 0;
    for (const match of line.matchAll(SGR)) {
      if (match.index > at) cells.push({ text: line.slice(at, match.index), style });
      style = applySgr(style, match[1] ?? "");
      at = match.index + match[0].length;
    }
    if (at < line.length) cells.push({ text: line.slice(at), style });
    return cells;
  });
}
var plainOf = (cells) => cells.map((cell) => cell.text).join("");
var typedOf = (cells) => cells.filter((cell) => !cell.style.dim && !isGrey(cell.style.fg)).map((cell) => cell.text).join("");
function dropChars(cells, n) {
  const out = [];
  for (const cell of cells) {
    if (n >= cell.text.length) {
      n -= cell.text.length;
      continue;
    }
    out.push({ ...cell, text: cell.text.slice(n) });
    n = 0;
  }
  return out;
}
var CLAUDE_RULE = /^─{10,}$/;
function parseScreen(styled) {
  const cells = cellsOf(styled);
  const lines = cells.map(plainOf);
  const rules = lines.flatMap((line, i) => CLAUDE_RULE.test(line.trim()) ? [i] : []);
  const [top, bottom] = rules.slice(-2);
  let draft = "";
  if (top !== void 0 && bottom !== void 0 && lines[top + 1]?.startsWith("\u276F\xA0")) {
    draft = cells.slice(top + 1, bottom).map((line, i) => typedOf(i === 0 ? dropChars(line, 2) : line).trim()).filter(Boolean).join("\n");
  } else {
    const composer = lines.findLastIndex((line) => /^›(\s|$)/.test(line));
    if (composer >= 0) {
      draft = typedOf(dropChars(cells[composer], 2)).trim();
    }
  }
  return { lines, draft: draft || null };
}
async function screen(pane) {
  const out = await tmux(pane.socket, ["display-message", "-p", "-t", pane.id, "#{pane_in_mode}", ";", "capture-pane", "-p", "-e", "-t", pane.id]);
  const [inMode, ...styled] = out.replace(/\n$/, "").split("\n");
  if (inMode === "1") {
    throw new TerminalError("the pane is in copy mode; press q in it, then reply", "pane_in_mode");
  }
  return parseScreen(styled);
}
async function send(pane, input) {
  if (input.text) {
    const head = input.text.replace(/;+$/, "");
    const semicolons = input.text.length - head.length;
    const args = head ? ["send-keys", "-t", pane.id, "-l", "--", head] : [];
    if (semicolons) {
      args.push(...args.length ? [";"] : [], "send-keys", "-t", pane.id, "-H", ...Array(semicolons).fill("3b"));
    }
    await tmux(pane.socket, args);
    if (input.enter) {
      await new Promise((done) => setTimeout(done, ENTER_AFTER_TEXT_MS));
    }
  }
  if (input.enter) {
    await tmux(pane.socket, ["send-keys", "-t", pane.id, "Enter"]);
  }
}
async function focus(pane) {
  await tmux(pane.socket, ["select-window", "-t", pane.id, ";", "select-pane", "-t", pane.id]);
  await tmux(pane.socket, ["switch-client", "-t", pane.id]).catch(() => void 0);
}

// src/main.ts
var POLL_MS = 3e4;
var EVENT_DEBOUNCE_MS = 300;
var PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1e3;
var SUGGEST_MODEL = "haiku";
function sessionSource(dir) {
  const log2 = new SessionLog(dir);
  let bindings = /* @__PURE__ */ new Map();
  let current = /* @__PURE__ */ new Map();
  async function view() {
    const all = await log2.refresh();
    const procs = all.length ? await listProcesses().catch(() => null) : null;
    let dead = /* @__PURE__ */ new Set();
    if (procs && all.some((session) => session.agent === "codex")) {
      const resolved = await Promise.all(
        all.map(async (session) => session.agent === "codex" ? { ...session, cwd: await realpath2(session.cwd).catch(() => session.cwd) } : session)
      );
      const codex = procs.filter((proc) => proc.name === "codex" && proc.tty);
      const cwds = await processCwds(codex.map((proc) => proc.pid)).catch(() => null);
      if (cwds) {
        const bound = bindCodex({
          sessions: resolved,
          previous: bindings,
          codex: codex.flatMap((proc) => cwds.has(proc.pid) ? [{ ...proc, cwd: cwds.get(proc.pid) }] : []),
          panes: await panes(tmuxSockets())
        });
        bindings = bound.bindings;
        dead = bound.dead;
      }
    }
    const placed = all.map((session) => {
      const binding = session.agent === "codex" ? bindings.get(session.id) : void 0;
      return binding ? { ...session, pane: binding.pane, pid: binding.pid } : session;
    });
    const result = viewSessions(placed, (session) => session.agent === "codex" ? !dead.has(session.id) && !codexInternal(session) : claudeInteractive(session, procs));
    current = new Map(result.live.map((session) => [session.id, session]));
    return result;
  }
  return { log: log2, view, session: (id) => current.get(id) };
}
async function serve(options) {
  const { home, log: log2 } = options;
  const dir = sessionsDir(home);
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const startedAt = Date.now();
  const sessions = sessionSource(dir);
  await sessions.log.prune(startedAt, PRUNE_AFTER_MS);
  let current = null;
  let refreshing = null;
  let refreshAgain = false;
  let debounce;
  let publishedJson = "";
  let server = null;
  const transcripts = new CodexTranscripts();
  const flags = jsonFile(join9(home, "flags.json"));
  const store = new FeedStore({
    sessions: sessions.view,
    screen,
    codexQuestion: (path) => transcripts.pendingQuestion(path),
    loadFlags: flags.load,
    saveFlags: flags.save,
    log: log2
  });
  function publish(snapshot) {
    current = snapshot;
    const json = JSON.stringify({ ...snapshot, generatedAt: 0 });
    if (json !== publishedJson) {
      publishedJson = json;
      server?.broadcast(snapshot);
    }
  }
  async function change(action) {
    const result = await action;
    if (result.ok) {
      publish(store.snapshot());
    }
    return result;
  }
  function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = store.refresh().then((snapshot) => {
      publish(snapshot);
      return snapshot;
    }).finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        refreshSoon(0);
      }
    });
    return refreshing;
  }
  function refreshSoon(delay = EVENT_DEBOUNCE_MS) {
    clearTimeout(debounce);
    debounce = setTimeout(() => void refresh().catch((error) => log2(`refresh failed: ${error.message}`)), delay);
  }
  const failuresFile = jsonFile(join9(home, "failures.json"));
  const failures = new FailureLog({ load: failuresFile.load, save: failuresFile.save, log: log2 });
  const sender = new ReplySender({
    terminalFor: async (id) => {
      const pane = sessions.session(id)?.pane;
      return pane ? { handle: pane } : void 0;
    },
    screen,
    send,
    onFailure: (failure) => void failures.add(failure)
  });
  async function reply(request) {
    const result = await sender.send(store.item(request.id), request);
    if (result.ok) {
      refreshSoon();
    }
    return result;
  }
  async function open3(request) {
    const item = store.item(request.id);
    if (!item) {
      return { ok: false, error: { code: "not_found", message: `no feed item ${request.id}` } };
    }
    if (item.kind !== "closed" && !item.terminal) {
      return { ok: false, error: { code: "session_closed", message: NOT_IN_TMUX } };
    }
    const pane = item.kind === "closed" ? void 0 : sessions.session(item.id)?.pane;
    if (!pane) {
      return { ok: false, error: { code: "session_closed", message: "the pane has no live terminal" } };
    }
    try {
      await focus(pane);
    } catch (error) {
      const code = error instanceof TerminalError && error.code !== "cli_failed" ? "terminal_rejected" : "cli_failed";
      return { ok: false, error: { code, message: error.message } };
    }
    return change(store.read(item.id));
  }
  const suggester = new Suggester((input) => claudePrint(input, { model: SUGGEST_MODEL, systemPrompt: SUGGEST_SYSTEM_PROMPT }));
  async function suggest(request) {
    const item = store.item(request.id);
    if (!item) {
      return { ok: false, error: { code: "not_found", message: `no feed item ${request.id}` } };
    }
    if (!item.canSuggest) {
      return { ok: false, error: { code: "bad_request", message: "only a finished turn without proposals can get suggestions" } };
    }
    try {
      return { ok: true, proposals: await suggester.suggest(`${item.id}@${itemKey(item)}`, item) };
    } catch (error) {
      return { ok: false, error: { code: "cli_failed", message: error.message } };
    }
  }
  server = await startServer({
    port: options.port,
    page: PAGE,
    getFeed: () => current ? Promise.resolve(current) : refresh(),
    reply,
    open: open3,
    read: (request) => change(store.read(request.id)),
    dismiss: (request) => change(store.dismiss(request)),
    suggest,
    failures: async () => ({ ok: true, failures: await failures.list() }),
    clearFailures: async () => {
      await failures.clear();
      return { ok: true };
    },
    health: () => ({ pid: process.pid, startedAt }),
    log: log2
  });
  watch(dir, () => refreshSoon()).on("error", (error) => log2(`watching ${dir} failed: ${error.message}`));
  setInterval(() => refreshSoon(0), POLL_MS);
  await refresh().catch((error) => log2(`refresh failed: ${error.message}`));
  return server;
}

// src/run.ts
import { spawnSync } from "node:child_process";
import { randomBytes as randomBytes3 } from "node:crypto";
import { basename as basename4 } from "node:path";
var SERVER = "decision-center";
var quote2 = (text2) => `'${text2.replace(/'/g, `'\\''`)}'`;
var SETTINGS = [
  ["set", "-g", "status", "off"],
  ["set", "-s", "escape-time", "0"],
  ["set", "-g", "mouse", "on"],
  ["set", "-g", "history-limit", "50000"],
  ["set", "-g", "destroy-unattached", "on"],
  ["set", "-g", "focus-events", "on"],
  ["set", "-s", "extended-keys", "on"]
];
var COPY_TO_MAC_CLIPBOARD = ["bind", "-T", "copy-mode", "MouseDragEnd1Pane", "send", "-X", "copy-pipe-and-cancel", "pbcopy"];
function runArgs(command, context) {
  const settings = context.platform === "darwin" ? [...SETTINGS, COPY_TO_MAC_CLIPBOARD] : SETTINGS;
  const env = Object.entries(context.env).flatMap(
    ([name, value]) => value === void 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(TMUX|TMUX_PANE|TERM)$/.test(name) ? [] : ["-e", `${name}=${value}`]
  );
  return [
    "-L",
    SERVER,
    "-f",
    "/dev/null",
    "start-server",
    ";",
    ...settings.flatMap((setting) => [...setting, ";"]),
    "new-session",
    "-s",
    `${basename4(command[0])}-${context.id}`,
    "-c",
    context.cwd,
    ...env,
    "--",
    // Why one quoted string: tmux reads a bare `;` argument as its own separator.
    `exec ${command.map(quote2).join(" ")}`
  ];
}
var PRINTS_AND_EXITS = /* @__PURE__ */ new Set(["-p", "--print", "-v", "-V", "--version", "-h", "--help", "--bg"]);
var SESSION_SUBCOMMANDS = /* @__PURE__ */ new Set(["attach", "resume", "fork"]);
function opensSession(args, io) {
  if (!io.stdinTty || !io.stdoutTty) return false;
  const first = args[0] ?? "";
  if (/^[a-z][a-z-]*$/.test(first) && !SESSION_SUBCOMMANDS.has(first)) return false;
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  return !flags.some((arg) => PRINTS_AND_EXITS.has(arg));
}
function run2(command) {
  if (!command.length) {
    throw new Error("run needs a command, for example: decision-center run claude");
  }
  const io = { stdinTty: process.stdin.isTTY === true, stdoutTty: process.stdout.isTTY === true };
  if (process.env.TMUX || !opensSession(command.slice(1), io)) {
    const direct = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
    if (direct.error) throw new Error(`couldn't start ${command[0]}: ${direct.error.message}`);
    return direct.status ?? 1;
  }
  const args = runArgs(command, { env: process.env, cwd: process.cwd(), platform: process.platform, id: randomBytes3(2).toString("hex") });
  const tmux2 = spawnSync("tmux", args, { stdio: "inherit" });
  if (tmux2.error) {
    throw new Error(`couldn't start tmux: ${tmux2.error.message}. Install tmux 3.2 or later.`);
  }
  return tmux2.status ?? 1;
}

// src/cli.ts
var USAGE = `Usage: decision-center <command>

  serve                 Run the feed server in the foreground (the default).
  open                  Open the feed in your browser.
  run <agent> [args]    Start an agent inside tmux, from any terminal, so the
                        feed can reply to it. Example: decision-center run claude
  install [--dry-run] [--alias] [--claude-settings <path>] [--codex-hooks <path>]
                        Add the hooks to Claude Code and Codex. With --alias,
                        also make claude and codex start through run, by
                        adding two functions to your zsh or bash startup file.
  uninstall [--dry-run] [--claude-settings <path>] [--codex-hooks <path>]
                        Remove the hooks again.
  status                Show the home folder, hooks, sessions and tmux.
  hook <claude|codex>   Record one hook call (agents run this).

Environment: DECISION_CENTER_PORT (default ${DEFAULT_PORT}), DECISION_CENTER_HOME (default ~/.decision-center).`;
var port = () => Number(process.env.DECISION_CENTER_PORT) || DEFAULT_PORT;
var feedUrl = () => `http://127.0.0.1:${port()}/`;
function log(message) {
  console.log(`${(/* @__PURE__ */ new Date()).toISOString()} ${message}`);
}
var DEFAULT_TARGETS = [
  { agent: "claude", path: join10(homedir4(), ".claude", "settings.json") },
  { agent: "codex", path: join10(homedir4(), ".codex", "hooks.json") }
];
function targetsFrom(args) {
  const named = [];
  let dryRun = false;
  let alias = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--alias") alias = true;
    else if (arg === "--claude-settings" || arg === "--codex-hooks") {
      const path = args[++i];
      if (!path) throw new Error(`${arg} needs a path`);
      named.push({ agent: arg === "--claude-settings" ? "claude" : "codex", path });
    } else throw new Error(`unknown option ${arg}

${USAGE}`);
  }
  return { targets: named.length ? named : DEFAULT_TARGETS, dryRun, everyFile: !named.length, alias };
}
var AGENT_NAME = { claude: "Claude Code", codex: "Codex" };
function report(results, targets) {
  results.forEach((result, i) => {
    const name = AGENT_NAME[targets[i].agent];
    const what = result.changes.map((change) => `${change.action} ${change.event}`).join(", ");
    const line = {
      unchanged: `${name}: ${result.path} is already up to date.`,
      changed: `${name}: updated ${result.path} (${what}). Backup: ${result.backup ?? "none, the file is new"}.`,
      "would-change": `${name}: would update ${result.path} (${what}).`,
      "no-folder": `${name}: skipped, ${result.path} has no folder (is ${name} installed?).`
    }[result.status];
    console.log(line);
  });
}
function shellFiles() {
  const shell = process.env.SHELL ?? "";
  const zsh = join10(process.env.ZDOTDIR || homedir4(), ".zshrc");
  const bash = join10(homedir4(), ".bashrc");
  return [...existsSync3(zsh) || shell.endsWith("zsh") ? [zsh] : [], ...existsSync3(bash) || shell.endsWith("bash") ? [bash] : []];
}
async function shellFunctions(add, dryRun) {
  const block = add ? shellBlock(process.execPath, fileURLToPath(import.meta.url)) : null;
  const files = shellFiles();
  if (add && !files.length) {
    console.log(`Shell: found no zsh or bash startup file. Add this to your shell's startup file yourself:
${block}`);
    return;
  }
  for (const path of files) {
    const result = await updateShellFile(path, block, { dryRun });
    const did = add ? "added the claude and codex functions to" : "removed the claude and codex functions from";
    const line = {
      unchanged: add ? `Shell: ${path} is already up to date.` : null,
      changed: `Shell: ${did} ${path}. Backup: ${result.backup ?? "none, the file is new"}.${add ? " Open a new terminal window to use them." : ""}`,
      "would-change": `Shell: would have ${did} ${path}.`
    }[result.status];
    if (line) console.log(line);
  }
}
var BUILT_HOOK = fileURLToPath(new URL("./hook.mjs", import.meta.url));
async function hooks(args, install) {
  const { targets, dryRun, everyFile, alias } = targetsFrom(args);
  if (alias && !install) {
    throw new Error(`uninstall takes no --alias; it removes the functions on its own

${USAGE}`);
  }
  if (install && !existsSync3(BUILT_HOOK)) {
    throw new Error(`${BUILT_HOOK} is missing. Run npm run build first.`);
  }
  const home = homeDir();
  const hookPath = install && !dryRun ? await placeHook(BUILT_HOOK, home) : placedHookPath(home);
  const command = install ? (agent) => hookCommand(process.execPath, hookPath, agent) : null;
  const results = await applyHooks(targets, command, { dryRun });
  report(results, targets);
  if (!install && !dryRun && everyFile) {
    await removeHook(home);
  }
  if (alias || !install && everyFile) {
    await shellFunctions(install, dryRun);
  } else if (install && !shellFiles().some((path) => existsSync3(path) && hasShellBlock(readFileSync2(path, "utf8")))) {
    console.log("Replies reach agents started with `decision-center run claude`. To make plain `claude` and `codex` start that way, run install --alias.");
  }
  if (install && !dryRun && results.some((result) => result.status === "changed" && targets[results.indexOf(result)].agent === "codex")) {
    console.log("Codex asks you to trust new or changed hooks the next time it starts. Untrusted hooks do not run.");
  }
}
async function status() {
  const home = homeDir();
  const dir = sessionsDir(home);
  const files = existsSync3(dir) ? readdirSync2(dir).filter((name) => name.endsWith(".jsonl")) : [];
  console.log(`Home: ${home}${existsSync3(home) ? "" : " (not created yet)"}`);
  console.log(`Sessions seen: ${files.length} (${files.filter((f) => f.startsWith("claude-")).length} Claude, ${files.filter((f) => f.startsWith("codex-")).length} Codex)`);
  for (const { agent, path } of DEFAULT_TARGETS) {
    const text2 = existsSync3(path) ? readFileSync2(path, "utf8") : null;
    const events = installedEvents(text2);
    const missing = HOOK_EVENTS[agent].filter((event) => !events.includes(event));
    console.log(`${AGENT_NAME[agent]} hooks: ${!events.length ? "not installed" : missing.length ? `partly installed, missing ${missing.join(", ")}` : "installed"} (${path})`);
    for (const problem of hookProblems(text2, BUILT_HOOK)) {
      console.log(`  ${problem}. Run install again.`);
    }
  }
  const withFunctions = shellFiles().filter((path) => existsSync3(path) && hasShellBlock(readFileSync2(path, "utf8")));
  console.log(`Shell functions: ${withFunctions.length ? `installed (${withFunctions.join(", ")})` : "not installed, so start agents with `decision-center run claude`"}`);
  const tmux2 = spawnSync2("tmux", ["-V"], { encoding: "utf8" });
  console.log(`tmux: ${tmux2.status === 0 ? tmux2.stdout.trim() : "not found"}`);
  const health = await fetch(`${feedUrl()}api/health`).then((res) => res.ok).catch(() => false);
  console.log(`Server: ${health ? `running at ${feedUrl()}` : `not running on port ${port()}`}`);
}
function openFeed() {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFile4(opener, [feedUrl()], (error) => {
    if (error) {
      console.error(`Couldn't open a browser: ${error.message}. Open ${feedUrl()} yourself.`);
      process.exitCode = 1;
    }
  });
}
async function main() {
  const [command = "serve", ...args] = process.argv.slice(2);
  switch (command) {
    case "serve": {
      const server = await serve({ port: port(), home: homeDir(), log });
      log(`serving ${server.url} from ${homeDir()}`);
      return;
    }
    case "open":
      return openFeed();
    case "run":
      process.exitCode = run2(args);
      return;
    case "hook":
      return runHook(args[0]);
    case "install":
      return hooks(args, true);
    case "uninstall":
      return hooks(args, false);
    case "status":
      return status();
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command ${command}

${USAGE}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
