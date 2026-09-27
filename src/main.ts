import {
  DEFAULT_PORT,
  type ActionResponse,
  type ApiError,
  type FeedSnapshot,
  type OpenRequest,
  type ReplyRequest,
  type SuggestRequest,
  type SuggestResponse
} from './contract.ts'
import { OrcaCliError, claudePrint, openBrowserTab, terminalHandleForPane, terminalScreen, terminalSend, terminalSwitch, worktreePs } from './cli.ts'
import { itemKey } from './feed.ts'
import { PAGE } from './page.ts'
import { SUGGEST_SYSTEM_PROMPT, Suggester } from './proposals.ts'
import { ReplySender } from './reply.ts'
import { startServer } from './server.ts'
import { CodexTranscripts, readLastStatus } from './sources.ts'
import { FLAGS_KEY, FeedStore } from './store.ts'

/** The `orca` object handed to a plugin worker's `activate` (pluginApi 1). */
export interface OrcaWorkerApi {
  commands: { register(id: string, handler: (args: unknown) => unknown): void }
  events: { on(event: string, handler: (payload: unknown) => void | Promise<void>): void }
  host: { call(method: string, params?: unknown): Promise<unknown> }
  log(message: string): void
}

// Orca reaps a worker after 5 idle minutes, where idle means no command, event
// or host call (plugin-worker-manager.ts reapIdle). A cheap host call well
// inside that window keeps the worker, and so the server, alive.
const HEARTBEAT_MS = 60_000
// Catches state changes that arrive without an event (e.g. a pane closing).
const POLL_MS = 30_000
const EVENT_DEBOUNCE_MS = 300
const SUGGEST_MODEL = 'haiku'

export default function activate(orca: OrcaWorkerApi): void {
  const startedAt = Date.now()
  let lastHeartbeatAt: number | null = null
  let current: FeedSnapshot | null = null
  let refreshing: Promise<FeedSnapshot> | null = null
  let refreshAgain = false
  let debounce: NodeJS.Timeout | undefined
  const transcripts = new CodexTranscripts()
  const store = new FeedStore({
    worktreePs,
    readLastStatus: () => readLastStatus(),
    codexQuestion: (entry) => transcripts.pendingQuestion(entry),
    loadFlags: async () => ((await orca.host.call('storage.get', { key: FLAGS_KEY })) as { value?: unknown } | null)?.value,
    saveFlags: async (flags) => void (await orca.host.call('storage.set', { key: FLAGS_KEY, value: flags })),
    log: orca.log
  })

  async function heartbeat(): Promise<void> {
    try {
      await orca.host.call('storage.get', { key: 'heartbeat' })
      lastHeartbeatAt = Date.now()
    } catch (error) {
      orca.log(`heartbeat failed: ${(error as Error).message}`)
    }
  }

  let publishedJson = ''

  /** Pushes the feed to open pages when it changed; other agents' events refresh it often. */
  function publish(snapshot: FeedSnapshot): void {
    current = snapshot
    const json = JSON.stringify({ ...snapshot, generatedAt: 0 })
    if (json !== publishedJson) {
      publishedJson = json
      server.then((s) => s.broadcast(snapshot)).catch(() => undefined)
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
          void refresh().catch((error: Error) => orca.log(`refresh failed: ${error.message}`))
        }
      })
    return refreshing
  }

  const sender = new ReplySender({ terminalFor: terminalHandleForPane, screen: terminalScreen, send: terminalSend })

  async function reply(request: ReplyRequest): Promise<ActionResponse> {
    const result = await sender.send(store.item(request.id), request)
    if (result.ok) {
      // Why: the agent's next state event can lag; pick the change up now.
      void refresh().catch((error: Error) => orca.log(`refresh failed: ${error.message}`))
    }
    return result
  }

  /**
   * Shows the item's pane and marks it read. Why read here: Orca exposes no
   * focused pane, so the feed can't see you visit it (issue 0014).
   */
  async function open(request: OpenRequest): Promise<ActionResponse> {
    const item = store.item(request.id)
    if (!item) {
      return { ok: false, error: { code: 'not_found', message: `no feed item ${request.id}` } }
    }
    const terminal = item.kind === 'closed' ? undefined : await terminalHandleForPane(item.id)
    if (!terminal) {
      return { ok: false, error: { code: 'session_closed', message: 'the pane has no live terminal' } }
    }
    try {
      await terminalSwitch(terminal.handle)
    } catch (error) {
      const code = error instanceof OrcaCliError && error.code !== 'cli_failed' ? 'terminal_rejected' : 'cli_failed'
      return { ok: false, error: { code, message: (error as Error).message } }
    }
    return change(store.read(item.id))
  }

  const suggester = new Suggester((input) =>
    claudePrint(input, { model: SUGGEST_MODEL, systemPrompt: SUGGEST_SYSTEM_PROMPT })
  )

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

  const server = startServer({
    port: DEFAULT_PORT,
    page: PAGE,
    getFeed: () => (current ? Promise.resolve(current) : refresh()),
    reply,
    open,
    read: (request) => change(store.read(request.id)),
    dismiss: (request) => change(store.dismiss(request)),
    suggest,
    health: () => ({ pid: process.pid, startedAt, lastHeartbeatAt }),
    log: orca.log
  })
  server.then(
    (s) => orca.log(`serving ${s.url}`),
    (error: Error) => orca.log(`server failed to start: ${error.message}`)
  )

  void heartbeat()
  setInterval(() => void heartbeat(), HEARTBEAT_MS)
  setInterval(() => void refresh().catch((error: Error) => orca.log(`refresh failed: ${error.message}`)), POLL_MS)

  orca.events.on('agent.status.changed', () => {
    clearTimeout(debounce)
    debounce = setTimeout(
      () => void refresh().catch((error: Error) => orca.log(`refresh failed: ${error.message}`)),
      EVENT_DEBOUNCE_MS
    )
  })

  orca.commands.register('open', async () => {
    const { url } = await server
    await openBrowserTab(url)
    return { url }
  })
}
