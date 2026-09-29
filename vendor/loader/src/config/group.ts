import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Build-safe delay: a global `setTimeout` (no `node:` builtins — the vendor loader bundles for browser-safe builds). */
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Attempts one group update gets before its failure is reported. */
const UPDATE_MAX_ATTEMPTS = 3
/** Ceiling of the first update backoff wait; doubles per attempt. */
const UPDATE_BACKOFF_BASE_MS = 50
/** Ceiling of any single update backoff wait. */
const UPDATE_BACKOFF_CAP_MS = 1_000

/**
 * Errno codes a bounded wait can plausibly clear: file contention (a module
 * replaced mid-import, a directory locked by a synchronizer) and resource
 * exhaustion. Anything else fails at once — a composition that will not parse
 * does not become parseable by waiting.
 */
const TRANSIENT_UPDATE_CODES: Record<string, true> = {
  EACCES: true,
  EAGAIN: true,
  EBUSY: true,
  EMFILE: true,
  ENFILE: true,
  EPERM: true,
}

/**
 * One wait for a group update: an exponential ceiling (base × 2^attempt,
 * capped) jittered into its upper half, so two loaders recovering from the
 * same contention never retry in lockstep.
 * @param attempt - the 0-based attempt that just failed.
 * @param rand - random source in `[0, 1)`; injected so tests are deterministic.
 * @returns the wait in milliseconds.
 */
export function updateBackoffWaitMs(attempt: number, rand: () => number): number {
  const ceiling = Math.min(UPDATE_BACKOFF_CAP_MS, UPDATE_BACKOFF_BASE_MS * 2 ** attempt)
  const floor = Math.floor(ceiling / 2)
  return floor + Math.floor(rand() * (ceiling - floor + 1))
}

/**
 * Whether a failure's shape says a bounded wait can clear it: a transient
 * errno on the error itself, on anything it aggregates, or anywhere down its
 * `cause` chain — the loader wraps every entry failure in its own message and
 * leaves the code on the cause.
 * @param error - the failure an update attempt threw.
 * @param depth - remaining cause links to follow.
 * @returns whether the failure is errno-transient.
 */
function isTransientUpdateError(error: unknown, depth = 4): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(child => isTransientUpdateError(child, depth))
  }
  // The node is `unknown` here; one named projection keeps the errno probe out
  // of inline casts on every property read.
  const failure = error as { code?: unknown; cause?: unknown }
  if (typeof failure.code === 'string' && TRANSIENT_UPDATE_CODES[failure.code] === true) return true
  return depth > 0 && failure.cause !== undefined && isTransientUpdateError(failure.cause, depth - 1)
}

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const existing = this.tree.store[id]
    const entry: Entry = existing ?? (this.tree.store[id] = new Entry(this.ctx.loader))
    const previousParent = entry.parent
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    try {
      await entry.update(options, true, true)
    } catch (error) {
      if (existing) {
        entry.parent = previousParent
      } else {
        delete this.tree.store[id]
      }
      throw error
    }
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  async remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    await entry._dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  /**
   * Reconcile this group's entries to `config`, retrying a transient failure
   * on a bounded jittered backoff before the transaction is reported.
   */
  async update(config: EntryOptions[]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.applyUpdate(config)
        return
      } catch (error) {
        // Disposal owns termination: a tree that has gone away must not be
        // re-applied into, whatever the failure was.
        if (this.ctx.fiber.uid === null) throw error
        if (attempt + 1 >= UPDATE_MAX_ATTEMPTS) throw error
        if (!isTransientUpdateError(error)) throw error
        await delay(updateBackoffWaitMs(attempt, Math.random))
      }
    }
  }

  /** One transactional attempt: apply every entry, or roll back and rethrow. */
  private async applyUpdate(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    const seen = new Set<string>()
    for (const options of config) {
      const id = this.tree.ensureId(options)
      if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`)
      seen.add(id)
    }
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id, options]))

    try {
      const outcomes = await Promise.allSettled(config.map(options => this.create(options)))
      // Disposal owns termination: sibling starts can still be settling after
      // the containing tree has gone away, but their failures no longer
      // describe a live update to roll back.
      if (this.ctx.fiber.uid === null) return
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(outcome => outcome.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'loader entries failed to apply')
      for (const id of Object.keys(oldMap)) {
        if (!newMap[id]) await this.remove(id, true)
      }
      this.data = config
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const id of Object.keys(newMap).reverse()) {
        if (oldMap[id]) continue
        try {
          await this.remove(id, true)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      for (const options of oldConfig) {
        try {
          await this.create(options)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      this.data = oldConfig
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'loader entry rollback failed')
      throw error
    }
  }

  async stop() {
    for (const options of this.data) {
      await this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', config => this.update(config))
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
