import type { ActionResponse, DismissRequest, FeedItem, FeedQuestion, FeedSnapshot } from './contract.ts'
import type { PaneRef } from './events.ts'
import { itemFromSession, itemKey, snapshotOf } from './feed.ts'
import { claudePermissionFooter, claudePickerFooter, codexPermissionFooter, codexPickerFooter, codexQuestionQueued } from './reply.ts'
import type { Ask, Session } from './session.ts'
import type { SessionView } from './sessionlog.ts'
import type { TerminalScreen } from './terminal.ts'

/** Read and dismissed hold the item key they were set for (see `itemKey`). */
export interface ItemFlags {
  read?: string
  dismissed?: string
  /** Epoch ms the session was last live. */
  seen: number
}

/** Persisted in `<home>/flags.json`. */
export interface StoredFlags {
  v: 1
  installedAt: number
  sessions: Record<string, ItemFlags>
}

const DAY_MS = 24 * 60 * 60 * 1000
// On first run, older items start out dismissed (issue 0006).
const FIRST_INSTALL_STALE_MS = DAY_MS
const FORGET_UNSEEN_MS = 7 * DAY_MS
// Why wait before checking the screen: the prompt takes a moment to draw after its hook.
const SILENT_CHECK_AFTER_MS = 3000

export interface StoreDeps {
  sessions(): Promise<SessionView>
  screen(pane: PaneRef): Promise<TerminalScreen>
  codexQuestion(transcriptPath: string): Promise<FeedQuestion | null>
  loadFlags(): Promise<unknown>
  saveFlags(flags: StoredFlags): Promise<void>
  log(message: string): void
  now?(): number
}

function isStoredFlags(value: unknown): value is StoredFlags {
  const flags = value as StoredFlags | null
  return flags?.v === 1 && typeof flags.installedAt === 'number' && typeof flags.sessions === 'object' && !!flags.sessions
}

/** Whether the agent's permission prompt or question picker is on screen. */
function askShown(agent: Session['agent'], lines: string[]): boolean {
  return agent === 'claude'
    ? claudePermissionFooter(lines) >= 0 || claudePickerFooter(lines) >= 0
    : codexPermissionFooter(lines) >= 0 || codexPickerFooter(lines) >= 0 || codexQuestionQueued(lines)
}

/**
 * The feed: one item per live session that waits on you or finished its turn,
 * with read/dismissed flags kept across restarts (issue 0006).
 */
export class FeedStore {
  private flags: StoredFlags | null = null
  private firstRun = false
  private savedJson = ''
  /** Items of live sessions from the last refresh, dismissed ones included. */
  private live = new Map<string, FeedItem>()
  /** Sessions that ended or died while they had an item. Memory only. */
  private closed = new Map<string, { item: FeedItem; key: string }>()
  private readonly deps: StoreDeps

  constructor(deps: StoreDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async loadFlags(): Promise<StoredFlags> {
    if (!this.flags) {
      let stored: unknown = null
      try {
        stored = await this.deps.loadFlags()
      } catch (error) {
        this.deps.log(`loading flags failed: ${(error as Error).message}`)
      }
      if (isStoredFlags(stored)) {
        this.flags = stored
        this.savedJson = JSON.stringify(stored)
      } else {
        this.flags = { v: 1, installedAt: this.now(), sessions: {} }
        this.firstRun = true
      }
    }
    return this.flags
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.flags)
    if (json === this.savedJson) {
      return
    }
    try {
      await this.deps.saveFlags(this.flags!)
      this.savedJson = json
    } catch (error) {
      this.deps.log(`saving flags failed: ${(error as Error).message}`)
    }
  }

  private flagsOf(id: string): ItemFlags {
    const flags = this.flags!
    flags.sessions[id] ??= { seen: this.now() }
    return flags.sessions[id]
  }

  private find(id: string): { item: FeedItem; key: string } | undefined {
    const item = this.live.get(id)
    return item ? { item, key: itemKey(item) } : this.closed.get(id)
  }

  private visible(): { item: FeedItem; key: string }[] {
    const entries = [...[...this.live.values()].map((item) => ({ item, key: itemKey(item) })), ...this.closed.values()]
    return entries.filter(({ item, key }) => this.flags?.sessions[item.id]?.dismissed !== key)
  }

  /**
   * The session's ask, unless its pane shows none. Why: denying or cancelling
   * an ask in the pane fires no hook (fact 9). Nothing is stored, so the next
   * refresh checks again; an unreadable screen keeps the ask.
   */
  private async pendingShown(session: Session, now: number): Promise<Ask | null> {
    const { pending, pane } = session
    if (!pending || !pane || pending.at > now - SILENT_CHECK_AFTER_MS) {
      return pending
    }
    try {
      return askShown(session.agent, (await this.deps.screen(pane)).lines) ? pending : null
    } catch {
      return pending
    }
  }

  /** The item for a session as the feed last saw it, dismissed or closed ones included. */
  item(id: string): FeedItem | undefined {
    return this.find(id)?.item
  }

  snapshot(): FeedSnapshot {
    const items = this.visible().map(({ item, key }) => ({ ...item, unread: this.flags?.sessions[item.id]?.read !== key }))
    return snapshotOf(items, this.now())
  }

  async refresh(): Promise<FeedSnapshot> {
    const flags = await this.loadFlags()
    const view = await this.deps.sessions()
    const now = this.now()
    const present = new Set<string>()
    const next = new Map<string, FeedItem>()
    for (const session of view.live) {
      present.add(session.id)
      const pending = await this.pendingShown(session, now)
      const codexQuestion =
        session.agent === 'codex' && !pending && session.turn === 'done' && session.transcriptPath
          ? await this.deps.codexQuestion(session.transcriptPath)
          : null
      const item = itemFromSession(session, { pending, codexQuestion })
      if (item) {
        next.set(item.id, item)
      }
    }

    for (const [id, item] of this.live) {
      if (!present.has(id) && !view.replaced.has(id)) {
        const closed: FeedItem = {
          ...item,
          kind: 'closed',
          state: 'closed',
          terminal: null,
          question: null,
          permission: null,
          proposals: [],
          canSuggest: false,
          updatedAt: now
        }
        this.closed.set(id, { item: closed, key: itemKey(item) })
      }
    }
    for (const id of present) {
      this.closed.delete(id)
    }
    this.live = next

    for (const id of present) {
      this.flagsOf(id).seen = now
    }
    if (this.firstRun) {
      this.firstRun = false
      for (const item of next.values()) {
        if (item.since < now - FIRST_INSTALL_STALE_MS) {
          const key = itemKey(item)
          Object.assign(this.flagsOf(item.id), { read: key, dismissed: key })
        }
      }
    }
    for (const [id, item] of Object.entries(flags.sessions)) {
      if (item.seen < now - FORGET_UNSEEN_MS && !this.closed.has(id)) {
        delete flags.sessions[id]
      }
    }

    await this.persist()
    return this.snapshot()
  }

  async read(id: string): Promise<ActionResponse> {
    await this.loadFlags()
    const found = this.find(id)
    if (!found) {
      return { ok: false, error: { code: 'not_found', message: `no feed item ${id}` } }
    }
    this.flagsOf(id).read = found.key
    await this.persist()
    return { ok: true }
  }

  async dismiss(request: DismissRequest): Promise<ActionResponse> {
    await this.loadFlags()
    if ('allFinished' in request) {
      for (const { item, key } of this.visible()) {
        if (item.kind === 'finished') {
          this.flagsOf(item.id).dismissed = key
        }
      }
    } else {
      const found = this.find(request.id)
      if (!found) {
        return { ok: false, error: { code: 'not_found', message: `no feed item ${request.id}` } }
      }
      this.flagsOf(request.id).dismissed = found.key
      // Why: a closed session never gets another episode, so drop it outright.
      this.closed.delete(request.id)
    }
    await this.persist()
    return { ok: true }
  }
}
