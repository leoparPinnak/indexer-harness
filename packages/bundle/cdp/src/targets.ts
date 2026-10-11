/**
 * @deepseek-ai/dsh-cdp — the `Target`-domain registry. It owns the browser's
 * tab list, the flattened session each attached target is spoken through, and
 * which tab is active. The list follows the browser's own lifecycle events
 * (`Target.targetCreated`, `Target.targetDestroyed`, `Target.targetInfoChanged`)
 * and the attachment event `Target.detachedFromTarget`; every command reply is
 * validated before it changes that state, because a `Target` reply crosses a
 * wire boundary that Chromium versions can drift.
 * @module @deepseek-ai/dsh-cdp/targets
 */

/**
 * The subset of a CDP connection the target registry reads. The connection owns
 * the socket, correlates reply ids, and fans events out; this interface stays
 * narrow so the registry is exercised without a transport.
 */
export interface TargetConnection {
  /**
   * Send one browser-level CDP command.
   * @param method - CDP method name, for example `Target.getTargets`.
   * @param params - protocol parameters; omitted for a method that takes none.
   * @returns the reply's `result` object. Rejects with the connection's own
   *   error when the browser answers with a protocol error.
   */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * Subscribe to one browser-level CDP event.
   * @param event - event name, for example `Target.targetCreated`.
   * @param listener - receives the event's `params`.
   * @returns a disposer that removes the subscription; calling it twice is safe.
   */
  on(event: string, listener: (params: unknown) => void): () => void
}

/** One browser target, narrowed to the fields the registry tracks. */
export interface TargetInfo {
  /** Browser-assigned target id (`Target.targetId`). */
  readonly targetId: string
  /** Target kind: `page`, `iframe`, `worker`, `browser`, or `other`. */
  readonly type: string
  /** Document title the browser reports. */
  readonly title: string
  /** Current document URL the browser reports. */
  readonly url: string
  /** Whether the browser reports the target as attached to some session. */
  readonly attached: boolean
}

/** Error thrown when a `Target` reply is unusable or a local target operation is refused. */
export class CdpTargetError extends Error {
  /**
   * @param message - what was refused, naming the method and the missing field or unknown id.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CdpTargetError'
  }
}

/**
 * @param value - candidate protocol field.
 * @returns the value as a string-keyed record, or undefined for a non-object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * @param value - candidate protocol field.
 * @returns true when the value is an array, narrowed without exposing `any`.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Read one `TargetInfo` from a reply entry or event payload.
 * @param value - candidate `targetInfo` value.
 * @returns the target, or undefined when `targetId`, `type`, `title`, `url`, or
 *   `attached` is missing or has the wrong type.
 */
function readTargetInfo(value: unknown): TargetInfo | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const { targetId, type, title, url, attached } = record
  if (typeof targetId !== 'string' || targetId === '') return undefined
  if (typeof type !== 'string') return undefined
  if (typeof title !== 'string' || typeof url !== 'string') return undefined
  if (typeof attached !== 'boolean') return undefined
  return { targetId, type, title, url, attached }
}

/**
 * @param params - a `Target.targetCreated` or `Target.targetInfoChanged` payload.
 * @returns the carried target, or undefined when the payload has no usable `targetInfo`.
 */
function readTargetInfoFromParams(params: unknown): TargetInfo | undefined {
  const record = asRecord(params)
  return record === undefined ? undefined : readTargetInfo(record.targetInfo)
}

/**
 * @param params - a `Target` event payload.
 * @param field - name of the string field to read.
 * @returns the non-empty string, or undefined when the payload has no such field.
 */
function readNonEmptyString(params: unknown, field: string): string | undefined {
  const record = asRecord(params)
  if (record === undefined) return undefined
  const value = record[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Largest variance a target list is trusted to carry; a larger reply is refused whole. */
const MAX_TRACKED_TARGETS = 512

/**
 * Owner of the browser's target list and of the registry's attachments to it.
 *
 * A command reply is authoritative for the state it names: `list` replaces the
 * tracked list, `attach` and `detach` add and remove one session, `close`
 * removes a target only when the browser reports success. A lifecycle event
 * whose payload does not carry the fields read is ignored, because an event has
 * no caller to reject; only command replies fail loud.
 */
export class TargetRegistry {
  /** Tracked targets in arrival order: the tab list. */
  private readonly tracked = new Map<string, TargetInfo>()
  /** Flattened session per attached target, keyed by target id. */
  private readonly sessions = new Map<string, string>()
  /** Reverse lookup from a flattened session to its target id. */
  private readonly sessionTargets = new Map<string, string>()
  /** Target the caller selected as active, when it is still tracked. */
  private activeTargetId: string | undefined
  /** True once {@link dispose} ran; commands are refused afterwards. */
  private disposed = false
  /** Removers of this registry's event subscriptions. */
  private readonly unsubscribe: Array<() => void>

  /**
   * @param connection - the CDP connection the registry commands and observes.
   */
  constructor(private readonly connection: TargetConnection) {
    this.unsubscribe = [
      // Creation and change both replace one entry: a change for an untracked
      // target reports a target the registry has not listed yet.
      connection.on('Target.targetCreated', (params) => { this.upsert(params) }),
      connection.on('Target.targetInfoChanged', (params) => { this.upsert(params) }),
      connection.on('Target.targetDestroyed', (params) => { this.forgetDestroyed(params) }),
      connection.on('Target.detachedFromTarget', (params) => {
        const sessionId = readNonEmptyString(params, 'sessionId')
        if (sessionId !== undefined) this.forgetSession(sessionId)
      }),
    ]
  }

  /**
   * Enumerate the browser's targets and make the reply the tracked tab list.
   * A still-tracked active target stays active; one the reply omits does not.
   * @returns the browser's targets in reply order.
   * @throws CdpTargetError when the reply is not an object, carries no
   *   `targetInfos` array, carries more than 512 entries, or carries an entry
   *   without `targetId`, `type`, `title`, `url`, or `attached`; also when the
   *   registry is disposed.
   * Rejects with the connection's protocol error when the browser refuses the command.
   */
  async list(): Promise<TargetInfo[]> {
    this.assertLive()
    const result = await this.connection.send('Target.getTargets', {})
    const record = asRecord(result)
    if (record === undefined) throw new CdpTargetError('Target.getTargets reply was not an object')
    const infos = record.targetInfos
    if (!isUnknownArray(infos)) throw new CdpTargetError('Target.getTargets reply carried no targetInfos array')
    if (infos.length > MAX_TRACKED_TARGETS) {
      throw new CdpTargetError(`Target.getTargets returned more than ${String(MAX_TRACKED_TARGETS)} targets`)
    }
    const listed: TargetInfo[] = []
    for (const entry of infos) {
      const info = readTargetInfo(entry)
      if (info === undefined) {
        throw new CdpTargetError('Target.getTargets carried an entry without targetId, type, title, url, or attached')
      }
      listed.push(info)
    }
    this.tracked.clear()
    for (const info of listed) this.tracked.set(info.targetId, info)
    if (this.activeTargetId !== undefined && !this.tracked.has(this.activeTargetId)) this.activeTargetId = undefined
    return listed
  }

  /**
   * The tracked tab list without a browser round trip, in event arrival order.
   * Empty before {@link list} or the first `Target.targetCreated` event, and
   * empty again after {@link dispose}.
   * @returns a copy of the tracked targets.
   */
  targets(): TargetInfo[] {
    return [...this.tracked.values()]
  }

  /**
   * Look one tracked target up in the local registry without a browser round
   * trip (unlike {@link list}, which refreshes from the browser first).
   * @param targetId - browser target id.
   * @returns the tracked target, or undefined when the registry does not track it.
   */
  find(targetId: string): TargetInfo | undefined {
    return this.tracked.get(targetId)
  }

  /**
   * The tracked target currently selected as the active tab — the default
   * page-session target for commands that do not name one.
   * @returns the active target, or undefined when none was selected or the
   *   selected target was destroyed, closed, or dropped by a later `list` reply.
   */
  active(): TargetInfo | undefined {
    return this.activeTargetId === undefined ? undefined : this.tracked.get(this.activeTargetId)
  }

  /**
   * Select one tracked target as the active tab.
   * @param targetId - browser target id already present in the tracked list.
   * @throws CdpTargetError when the registry does not track the target, or is disposed.
   */
  setActive(targetId: string): void {
    this.assertLive()
    if (!this.tracked.has(targetId)) throw new CdpTargetError(`TargetRegistry.setActive: unknown target ${targetId}`)
    this.activeTargetId = targetId
  }

  /**
   * Attach the registry to a target through its own flattened session. An
   * already-attached target returns its existing session without another
   * `Target.attachToTarget` command, so attaching twice cannot leak a session.
   * @param targetId - browser target id to attach.
   * @returns the flattened session id commands are routed through.
   * @throws CdpTargetError when the reply is not an object or carries no
   *   `sessionId`, or when the registry is disposed.
   * Rejects with the connection's protocol error when the browser refuses the command.
   */
  async attach(targetId: string): Promise<string> {
    this.assertLive()
    const existing = this.sessions.get(targetId)
    if (existing !== undefined) return existing
    const result = await this.connection.send('Target.attachToTarget', { targetId, flatten: true })
    const record = asRecord(result)
    if (record === undefined) throw new CdpTargetError('Target.attachToTarget reply was not an object')
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new CdpTargetError('Target.attachToTarget reply carried no sessionId')
    }
    this.sessions.set(targetId, sessionId)
    this.sessionTargets.set(sessionId, targetId)
    return sessionId
  }

  /**
   * The flattened session this registry attached for a target, read without
   * attaching — use {@link attach} to establish one.
   * @param targetId - browser target id.
   * @returns the flattened session this registry attached for the target, or
   *   undefined when it is not attached here.
   */
  attachedSession(targetId: string): string | undefined {
    return this.sessions.get(targetId)
  }

  /**
   * Detach one session this registry attached. Bookkeeping is removed only
   * after the browser accepts the command.
   * @param sessionId - flattened session id to detach, as returned by {@link attach}.
   * @throws CdpTargetError when the registry attached no such session, or is disposed.
   * Rejects with the connection's protocol error when the browser refuses the command.
   */
  async detach(sessionId: string): Promise<void> {
    this.assertLive()
    if (!this.sessionTargets.has(sessionId)) {
      throw new CdpTargetError(`TargetRegistry.detach: unknown session ${sessionId}`)
    }
    await this.connection.send('Target.detachFromTarget', { sessionId })
    this.forgetSession(sessionId)
  }

  /**
   * Ask the browser to close one target. The tracked entry and its attachment
   * are removed only when the browser reports success; a refused close leaves
   * the target tracked for a later retry.
   * @param targetId - browser target id to close.
   * @returns true when the browser reported the target closed.
   * @throws CdpTargetError when the reply is not an object or carries no boolean
   *   `success`, or when the registry is disposed.
   * Rejects with the connection's protocol error when the browser refuses the command.
   */
  async close(targetId: string): Promise<boolean> {
    this.assertLive()
    const result = await this.connection.send('Target.closeTarget', { targetId })
    const record = asRecord(result)
    if (record === undefined) throw new CdpTargetError('Target.closeTarget reply was not an object')
    const success = record.success
    if (typeof success !== 'boolean') throw new CdpTargetError('Target.closeTarget reply carried no boolean success')
    if (success) this.forgetTarget(targetId)
    return success
  }

  /**
   * Stop observing lifecycle events and drop all tracked state. No detach
   * command is sent: the connection's own teardown owns transport sessions.
   * Idempotent; every command rejects with {@link CdpTargetError} afterwards
   * and the local reads report the cleared state.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.tracked.clear()
    this.sessions.clear()
    this.sessionTargets.clear()
    this.activeTargetId = undefined
  }

  /** Insert or replace one entry from a `targetCreated`/`targetInfoChanged` payload. */
  private upsert(params: unknown): void {
    const info = readTargetInfoFromParams(params)
    if (info === undefined) return
    this.tracked.set(info.targetId, info)
  }

  /** Remove one target from a `targetDestroyed` payload. */
  private forgetDestroyed(params: unknown): void {
    const targetId = readNonEmptyString(params, 'targetId')
    if (targetId === undefined) return
    this.forgetTarget(targetId)
  }

  /** Drop one target, its attachment, and its active selection. */
  private forgetTarget(targetId: string): void {
    this.tracked.delete(targetId)
    const sessionId = this.sessions.get(targetId)
    if (sessionId !== undefined) this.forgetSession(sessionId)
    if (this.activeTargetId === targetId) this.activeTargetId = undefined
  }

  /** Drop one attachment in both directions; an already-forgotten session is a no-op. */
  private forgetSession(sessionId: string): void {
    const targetId = this.sessionTargets.get(sessionId)
    if (targetId === undefined) return
    this.sessionTargets.delete(sessionId)
    this.sessions.delete(targetId)
  }

  /** Refuse a command on a disposed registry. */
  private assertLive(): void {
    if (this.disposed) throw new CdpTargetError('TargetRegistry is disposed')
  }
}
