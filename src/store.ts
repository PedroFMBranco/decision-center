import type { ActionResponse, DismissRequest, FeedItem, FeedQuestion, FeedSnapshot } from './contract.ts'
import type { PsWorktree } from './cli.ts'
import { itemFromAgent, itemKey, snapshotOf } from './feed.ts'
import type { LastStatusEntry } from './sources.ts'

/** Read and dismissed hold the item key they were set for (see `itemKey`). */
export interface PaneFlags {
  read?: string
  dismissed?: string
  /** Epoch ms the pane was last in `worktree ps`. */
  seen: number
}

/** Persisted in plugin storage under `FLAGS_KEY`. */
export interface StoredFlags {
  v: 1
  installedAt: number
  panes: Record<string, PaneFlags>
}

export const FLAGS_KEY = 'flags'
const DAY_MS = 24 * 60 * 60 * 1000
// On first install, older items start out dismissed (issue 0006).
const FIRST_INSTALL_STALE_MS = DAY_MS
// A pane's flags are dropped once it's been gone this long. Pane keys never
// come back, but Orca can briefly list fewer panes while it starts.
const FORGET_UNSEEN_MS = 7 * DAY_MS

export interface StoreDeps {
  worktreePs(): Promise<PsWorktree[]>
  readLastStatus(): Promise<Map<string, LastStatusEntry>>
  codexQuestion(entry: LastStatusEntry | undefined): Promise<FeedQuestion | null>
  loadFlags(): Promise<unknown>
  saveFlags(flags: StoredFlags): Promise<void>
  log(message: string): void
  now?(): number
}

function isStoredFlags(value: unknown): value is StoredFlags {
  const flags = value as StoredFlags | null
  return flags?.v === 1 && typeof flags.installedAt === 'number' && typeof flags.panes === 'object' && !!flags.panes
}

/**
 * The feed: one item per top-level Claude/Codex pane that isn't working,
 * with read/dismissed flags kept across restarts (issue 0006).
 */
export class FeedStore {
  private flags: StoredFlags | null = null
  private firstRun = false
  private savedJson = ''
  /** Items from the last `worktree ps`, dismissed ones included. */
  private live = new Map<string, FeedItem>()
  /** Panes that left `worktree ps` while they had an item. Memory only. */
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
        this.flags = { v: 1, installedAt: this.now(), panes: {} }
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

  private pane(id: string): PaneFlags {
    const flags = this.flags!
    flags.panes[id] ??= { seen: this.now() }
    return flags.panes[id]
  }

  private find(id: string): { item: FeedItem; key: string } | undefined {
    const item = this.live.get(id)
    return item ? { item, key: itemKey(item) } : this.closed.get(id)
  }

  private visible(): { item: FeedItem; key: string }[] {
    const entries = [...[...this.live.values()].map((item) => ({ item, key: itemKey(item) })), ...this.closed.values()]
    return entries.filter(({ item, key }) => this.flags?.panes[item.id]?.dismissed !== key)
  }

  /** The item for a pane as the feed last saw it, dismissed or closed ones included. */
  item(id: string): FeedItem | undefined {
    return this.find(id)?.item
  }

  snapshot(): FeedSnapshot {
    const items = this.visible().map(({ item, key }) => ({ ...item, unread: this.flags?.panes[item.id]?.read !== key }))
    return snapshotOf(items, this.now())
  }

  async refresh(): Promise<FeedSnapshot> {
    const flags = await this.loadFlags()
    const [worktrees, statuses] = await Promise.all([this.deps.worktreePs(), this.deps.readLastStatus()])
    const now = this.now()
    const present = new Set<string>()
    const next = new Map<string, FeedItem>()
    for (const worktree of worktrees) {
      for (const agent of worktree.agents ?? []) {
        present.add(agent.paneKey)
        const entry = statuses.get(agent.paneKey)
        // Why: Orca never marks a Codex question as waiting, so a `done`
        // Codex pane may still be asking one (issue 0012).
        const codexQuestion =
          agent.agentType === 'codex' && agent.state === 'done' ? await this.deps.codexQuestion(entry) : null
        const item = itemFromAgent(worktree, agent, { entry, codexQuestion })
        if (item) {
          next.set(item.id, item)
        }
      }
    }

    for (const [id, item] of this.live) {
      if (!present.has(id)) {
        const closed: FeedItem = {
          ...item,
          kind: 'closed',
          state: 'closed',
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
      this.pane(id).seen = now
    }
    if (this.firstRun) {
      this.firstRun = false
      for (const item of next.values()) {
        if (item.since < now - FIRST_INSTALL_STALE_MS) {
          const key = itemKey(item)
          Object.assign(this.pane(item.id), { read: key, dismissed: key })
        }
      }
    }
    for (const [id, pane] of Object.entries(flags.panes)) {
      if (pane.seen < now - FORGET_UNSEEN_MS && !this.closed.has(id)) {
        delete flags.panes[id]
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
    this.pane(id).read = found.key
    await this.persist()
    return { ok: true }
  }

  async dismiss(request: DismissRequest): Promise<ActionResponse> {
    await this.loadFlags()
    if ('allFinished' in request) {
      for (const { item, key } of this.visible()) {
        if (item.kind === 'finished') {
          this.pane(item.id).dismissed = key
        }
      }
    } else {
      const found = this.find(request.id)
      if (!found) {
        return { ok: false, error: { code: 'not_found', message: `no feed item ${request.id}` } }
      }
      this.pane(request.id).dismissed = found.key
      // Why: a closed session never gets another episode, so drop it outright.
      this.closed.delete(request.id)
    }
    await this.persist()
    return { ok: true }
  }
}
