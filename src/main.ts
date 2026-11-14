import { mkdirSync, watch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { bindCodex, listProcesses, processCwds, type Binding, type Proc } from './binding.ts'
import { claudePrint } from './claude.ts'
import type { ActionResponse, ApiError, FeedSnapshot, OpenRequest, ReplyRequest, SuggestRequest, SuggestResponse } from './contract.ts'
import { FailureLog } from './failures.ts'
import { itemKey } from './feed.ts'
import { sessionsDir } from './home.ts'
import { PAGE } from './page.ts'
import { SUGGEST_SYSTEM_PROMPT, Suggester } from './proposals.ts'
import { NOT_IN_TMUX, ReplySender } from './reply.ts'
import { startServer, type DecisionCenterServer } from './server.ts'
import type { Session } from './session.ts'
import { SessionLog, viewSessions, type SessionView } from './sessionlog.ts'
import { CodexTranscripts } from './sources.ts'
import { jsonFile } from './storage.ts'
import { FeedStore } from './store.ts'
import { TerminalError } from './terminal.ts'
import { focus, panes, screen, send, tmuxSockets } from './tmux.ts'

// Catches what no hook reports: a process that died, an ask answered with Esc.
const POLL_MS = 30_000
const EVENT_DEBOUNCE_MS = 300
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const SUGGEST_MODEL = 'haiku'

/** Claude's hook names its process; a process that started after the session's first event is a reused pid. */
function claudeAlive(session: Session, procs: Proc[] | null): boolean {
  if (!procs || session.pid === null) {
    return true
  }
  const proc = procs.find((candidate) => candidate.pid === session.pid)
  return !!proc && proc.startedAt <= session.startedAt
}

/** Reads the hook's session files and works out which sessions run, and where. */
function sessionSource(dir: string) {
  const log = new SessionLog(dir)
  let bindings = new Map<string, Binding>()
  let current = new Map<string, Session>()

  async function view(): Promise<SessionView> {
    const all = await log.refresh()
    const procs = all.length ? await listProcesses().catch(() => null) : null
    let dead = new Set<string>()
    if (procs && all.some((session) => session.agent === 'codex')) {
      // Why real paths: lsof reports the resolved folder, the hook the one the agent was started in.
      const resolved = await Promise.all(
        all.map(async (session) => (session.agent === 'codex' ? { ...session, cwd: await realpath(session.cwd).catch(() => session.cwd) } : session))
      )
      const codex = procs.filter((proc) => proc.name === 'codex' && proc.tty)
      const cwds = await processCwds(codex.map((proc) => proc.pid)).catch(() => null)
      if (cwds) {
        const bound = bindCodex({
          sessions: resolved,
          previous: bindings,
          codex: codex.flatMap((proc) => (cwds.has(proc.pid) ? [{ ...proc, cwd: cwds.get(proc.pid)! }] : [])),
          panes: await panes(tmuxSockets())
        })
        bindings = bound.bindings
        dead = bound.dead
      }
    }
    const placed = all.map((session) => {
      const binding = session.agent === 'codex' ? bindings.get(session.id) : undefined
      return binding ? { ...session, pane: binding.pane, pid: binding.pid } : session
    })
    const result = viewSessions(placed, (session) => (session.agent === 'codex' ? !dead.has(session.id) : claudeAlive(session, procs)))
    current = new Map(result.live.map((session) => [session.id, session]))
    return result
  }

  return { log, view, session: (id: string) => current.get(id) }
}

export interface ServeOptions {
  port: number
  home: string
  log(message: string): void
}

/** Runs the feed server until the process ends. */
export async function serve(options: ServeOptions): Promise<DecisionCenterServer> {
  const { home, log } = options
  const dir = sessionsDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  const sessions = sessionSource(dir)
  await sessions.log.prune(startedAt, PRUNE_AFTER_MS)

  let current: FeedSnapshot | null = null
  let refreshing: Promise<FeedSnapshot> | null = null
  let refreshAgain = false
  let debounce: NodeJS.Timeout | undefined
  let publishedJson = ''
  let server: DecisionCenterServer | null = null

  const transcripts = new CodexTranscripts()
  const flags = jsonFile(join(home, 'flags.json'))
  const store = new FeedStore({
    sessions: sessions.view,
    screen,
    codexQuestion: (path) => transcripts.pendingQuestion(path),
    loadFlags: flags.load,
    saveFlags: flags.save,
    log
  })

  /** Pushes the feed to open pages when it changed. */
  function publish(snapshot: FeedSnapshot): void {
    current = snapshot
    const json = JSON.stringify({ ...snapshot, generatedAt: 0 })
    if (json !== publishedJson) {
      publishedJson = json
      server?.broadcast(snapshot)
    }
  }

  /** Runs a flag change, then pushes the new feed to every open page. */
  async function change(action: Promise<ActionResponse>): Promise<ActionResponse> {
    const result = await action
    if (result.ok) {
      publish(store.snapshot())
    }
    return result
  }

  function refresh(): Promise<FeedSnapshot> {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = store
      .refresh()
      .then((snapshot) => {
        publish(snapshot)
        return snapshot
      })
      .finally(() => {
        refreshing = null
        if (refreshAgain) {
          refreshAgain = false
          refreshSoon(0)
        }
      })
    return refreshing
  }

  function refreshSoon(delay = EVENT_DEBOUNCE_MS): void {
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh().catch((error: Error) => log(`refresh failed: ${error.message}`)), delay)
  }

  const failuresFile = jsonFile(join(home, 'failures.json'))
  const failures = new FailureLog({ load: failuresFile.load, save: failuresFile.save, log })
  const sender = new ReplySender({
    terminalFor: async (id) => {
      const pane = sessions.session(id)?.pane
      return pane ? { handle: pane } : undefined
    },
    screen,
    send,
    onFailure: (failure) => void failures.add(failure)
  })

  async function reply(request: ReplyRequest): Promise<ActionResponse> {
    const result = await sender.send(store.item(request.id), request)
    if (result.ok) {
      // Why: the agent's next hook can lag; pick the change up now.
      refreshSoon()
    }
    return result
  }

  /** Shows the item's pane and marks it read: the feed can't see you visit a pane. */
  async function open(request: OpenRequest): Promise<ActionResponse> {
    const item = store.item(request.id)
    if (!item) {
      return { ok: false, error: { code: 'not_found', message: `no feed item ${request.id}` } }
    }
    if (item.kind !== 'closed' && !item.terminal) {
      return { ok: false, error: { code: 'session_closed', message: NOT_IN_TMUX } }
    }
    const pane = item.kind === 'closed' ? undefined : sessions.session(item.id)?.pane
    if (!pane) {
      return { ok: false, error: { code: 'session_closed', message: 'the pane has no live terminal' } }
    }
    try {
      await focus(pane)
    } catch (error) {
      const code = error instanceof TerminalError && error.code !== 'cli_failed' ? 'terminal_rejected' : 'cli_failed'
      return { ok: false, error: { code, message: (error as Error).message } }
    }
    return change(store.read(item.id))
  }

  const suggester = new Suggester((input) => claudePrint(input, { model: SUGGEST_MODEL, systemPrompt: SUGGEST_SYSTEM_PROMPT }))

  /** Asks Haiku for replies to a finished turn with none in its message (issue 0009). */
  async function suggest(request: SuggestRequest): Promise<SuggestResponse | ApiError> {
    const item = store.item(request.id)
    if (!item) {
      return { ok: false, error: { code: 'not_found', message: `no feed item ${request.id}` } }
    }
    if (!item.canSuggest) {
      return { ok: false, error: { code: 'bad_request', message: 'only a finished turn without proposals can get suggestions' } }
    }
    try {
      return { ok: true, proposals: await suggester.suggest(`${item.id}@${itemKey(item)}`, item) }
    } catch (error) {
      return { ok: false, error: { code: 'cli_failed', message: (error as Error).message } }
    }
  }

  server = await startServer({
    port: options.port,
    page: PAGE,
    getFeed: () => (current ? Promise.resolve(current) : refresh()),
    reply,
    open,
    read: (request) => change(store.read(request.id)),
    dismiss: (request) => change(store.dismiss(request)),
    suggest,
    failures: async () => ({ ok: true, failures: await failures.list() }),
    clearFailures: async () => {
      await failures.clear()
      return { ok: true }
    },
    health: () => ({ pid: process.pid, startedAt }),
    log
  })

  watch(dir, () => refreshSoon()).on('error', (error) => log(`watching ${dir} failed: ${error.message}`))
  setInterval(() => refreshSoon(0), POLL_MS)
  await refresh().catch((error: Error) => log(`refresh failed: ${error.message}`))
  return server
}
