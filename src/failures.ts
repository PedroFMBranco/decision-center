import type { ReplyFailure } from './contract.ts'

const MAX_FAILURES = 50
// Why: a typed reply can be long; the report needs its start, not all of it.
const MAX_TEXT = 2000

export interface FailureLogDeps {
  load(): Promise<unknown>
  save(failures: ReplyFailure[]): Promise<void>
  log(message: string): void
}

function trimmed(failure: ReplyFailure): ReplyFailure {
  const reply = failure.reply
  if (reply.type === 'text' && reply.text.length > MAX_TEXT) {
    return { ...failure, reply: { ...reply, text: `${reply.text.slice(0, MAX_TEXT)}…` } }
  }
  if (reply.type === 'permission' && reply.note && reply.note.length > MAX_TEXT) {
    return { ...failure, reply: { ...reply, note: `${reply.note.slice(0, MAX_TEXT)}…` } }
  }
  return failure
}

/** The latest failed replies, newest first. */
export class FailureLog {
  private readonly deps: FailureLogDeps
  private failures: ReplyFailure[] | null = null
  // Why: saves run one at a time, so a slow write never lands after a newer one.
  private saving: Promise<void> = Promise.resolve()

  constructor(deps: FailureLogDeps) {
    this.deps = deps
  }

  private async loaded(): Promise<ReplyFailure[]> {
    if (!this.failures) {
      try {
        const stored = await this.deps.load()
        this.failures = Array.isArray(stored) ? (stored as ReplyFailure[]) : []
      } catch (error) {
        this.deps.log(`failure log unreadable: ${(error as Error).message}`)
        this.failures = []
      }
    }
    return this.failures
  }

  private persist(): Promise<void> {
    const snapshot = [...(this.failures ?? [])]
    this.saving = this.saving
      .then(() => this.deps.save(snapshot))
      .catch((error: Error) => this.deps.log(`failure log not saved: ${error.message}`))
    return this.saving
  }

  async add(failure: ReplyFailure): Promise<void> {
    const failures = await this.loaded()
    this.failures = [trimmed(failure), ...failures].slice(0, MAX_FAILURES)
    this.deps.log(`reply failed (${failure.code}) for ${failure.itemId}: ${failure.message}`)
    await this.persist()
  }

  async list(): Promise<ReplyFailure[]> {
    return [...(await this.loaded())]
  }

  async clear(): Promise<void> {
    await this.loaded()
    this.failures = []
    await this.persist()
  }
}
