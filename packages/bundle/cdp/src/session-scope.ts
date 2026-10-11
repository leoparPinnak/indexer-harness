/**
 * @deepseek-ai/dsh-cdp/session-scope — the session→target ownership vault.
 *
 * plan18-session-scope (operator directive): every agent session drives its own
 * target ids and ONLY its own. A session may request new targets (through the
 * sanctioned creation paths) but it must be **mechanically impossible** for it
 * to touch a target id belonging to another session — even when it somehow
 * learns that id (scraped from a log, guessed, handed over in chat). "Impossible"
 * is enforced here, at one choke point every tool call funnels through:
 *
 * 1. **Deny-by-default.** A target id with no grant to this session is refused —
 *    unowned, expired, or foreign are all the same wall. There is no admin flag,
 *    no back door, and no "resolve generously" fallback.
 * 2. **Sanctioned grants only.** Ownership is minted exactly at the creation
 *    paths (`open` adoption, `tab-new`, `context-open`); a grant never steals an
 *    owned target from another session.
 * 3. **Default-target resolution stays inside the fence.** A call that names no
 *    target addresses the session's OWN active target — never a shared "whatever
 *    is active" one, which would be a smuggling lane out of the cage.
 * 4. **Raw commands are name- and shape-filtered.** Browser-scope CDP methods are
 *    refused unless explicitly allow-listed, the target-manipulating families are
 *    refused outright, and every target-bearing parameter in an allowed command
 *    is recursively validated against ownership — so an allowed read cannot carry
 *    a foreign id in its params either.
 *
 * Listings cross the fence through {@link SessionTargetScope.filterRows}:
 * foreign rows are dropped before they are rendered, so an agent cannot even
 * *learn* sibling ids from `cdp_tabs`. The operator REST surface (the browser
 * pane) is deliberately out of scope — it is the user's own console, not an
 * agent's.
 *
 * Plain data throughout: one input, one output, no timers, no I/O.
 * @module @deepseek-ai/dsh-cdp/session-scope
 */

/** How one target came to be owned — the sanctioned minting points. */
export type TargetGrantOrigin =
  /** `cdp_open` adopted the endpoint's live targets into the opening session. */
  | 'open'
  /** `cdp_tab_new` created the tab for the calling session. */
  | 'tab-new'
  /** `cdp_contexts` opened a tab in a context owned by the calling session. */
  | 'context-open'

/** One ownership grant: a target id bonded to one session id, permanently. */
export interface TargetGrant {
  /** The CDP target id (tab) the grant covers. */
  readonly targetId: string
  /** The DSH session id (agent turn owner) that holds the grant. */
  readonly sessionId: string
  /** Which sanctioned path minted the grant. */
  readonly origin: TargetGrantOrigin
  /** Epoch ms the grant was minted (diagnostics only — grants do not expire). */
  readonly grantedAt: number
}

/** Refusal codes the vault raises; each maps 1:1 to one clause of the directive. */
export type TargetScopeRefusalCode =
  /** The session holds no grant for this target (unowned or foreign). */
  | 'TARGET_NOT_OWNED'
  /** A grant() tried to take a target another session already owns. */
  | 'TARGET_OWNED_ELSEWHERE'
  /** A call named no target and the session owns none to default to. */
  | 'SCOPE_REQUIRED'
  /** A raw CDP method is not on the read allow-list / is a manipulation. */
  | 'RAW_METHOD_DENIED'
  /** An allowed raw command smuggled a non-owned target id in its params. */
  | 'RAW_PARAM_DENIED'

/**
 * The wall. Thrown before any protocol byte leaves the process, so a refusal is
 * a guaranteed non-effect — never a dispatched action plus a scolding.
 */
export class CdpTargetScopeError extends Error {
  /** Which clause refused the call. */
  readonly code: TargetScopeRefusalCode
  /** The session that tried. */
  readonly sessionId?: string
  /** The target it tried to reach (also the smuggled id for RAW_PARAM_DENIED). */
  readonly targetId?: string
  /** The session that owns the target, when one does. */
  readonly owner?: string
  /** Operation label for the refusal text (tool or method name). */
  readonly operation?: string
  /** The raw CDP method involved, for RAW_* refusals. */
  readonly method?: string

  /**
   * @param code - which clause refused the call.
   * @param message - human-readable refusal, already naming the ids.
   * @param detail - optional ids/owner/operation riding along for diagnostics.
   */
  constructor(
    code: TargetScopeRefusalCode,
    message: string,
    detail: { sessionId?: string; targetId?: string; owner?: string; operation?: string; method?: string } = {},
  ) {
    super(message)
    this.name = 'CdpTargetScopeError'
    this.code = code
    if (detail.sessionId !== undefined) this.sessionId = detail.sessionId
    if (detail.targetId !== undefined) this.targetId = detail.targetId
    if (detail.owner !== undefined) this.owner = detail.owner
    if (detail.operation !== undefined) this.operation = detail.operation
    if (detail.method !== undefined) this.method = detail.method
  }
}

/**
 * Browser-scope CDP methods that are pure reads and therefore allowed without a
 * target. Everything else at browser scope is refused by default — including
 * every method that can create, close, activate, attach to, or otherwise steer a
 * target (the {@link RAW_MANIPULATION_DENY} family).
 */
export const RAW_BROWSER_ALLOW: readonly string[] = [
  'Browser.getVersion',
  'Schema.getDomains',
  'Target.getTargets',
  'Target.discoverTargets',
  'Target.getTargetInfo',
]

/**
 * Named outright refusals: the families that could seize or steer another
 * session's target even from browser scope. Deny-by-default already covers
 * them; they are named so the refusal text can say WHY.
 */
export const RAW_MANIPULATION_DENY: readonly string[] = [
  'Target.attachToTarget',
  'Target.setAutoAttach',
  'Target.activateTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
  'Target.exposeDevToolsProtocol',
  'Target.setDiscoverTargets',
]

/** Parameter keys that address a target somewhere in a raw command's tree. */
const RAW_TARGET_PARAM_KEYS: readonly string[] = [
  'targetId',
  'targetIds',
  'targetInfos',
  'sessionId',
  'destinationId',
  'openerId',
]

/** In-band alternative to throwing, for surfaces that render refusals as data. */
export type TargetScopeCheck =
  | { readonly ok: true; readonly targetId: string }
  | { readonly ok: false; readonly code: TargetScopeRefusalCode; readonly reason: string; readonly owner?: string }

/** Ownership vault: one grant per target, one fence per session. */
export class SessionTargetScope {
  #grants = new Map<string, TargetGrant>()
  #perSession = new Map<string, string[]>()
  #active = new Map<string, string>()

  /**
   * Mint ownership of one target for one session. The sanctioned creation paths
   * (`open`, `tab-new`, `context-open`) are the ONLY callers. Re-granting a
   * target to its existing owner is idempotent; granting it to anybody else is
   * a {@link CdpTargetScopeError} — ownership is never stolen.
   * @param sessionId - the session that created or adopted the target.
   * @param targetId - the target id.
   * @param origin - which sanctioned path minted it.
   * @param now - epoch ms for the diagnostic timestamp.
   * @returns the stored grant.
   */
  grant(sessionId: string, targetId: string, origin: TargetGrantOrigin, now: number = Date.now()): TargetGrant {
    const existing = this.#grants.get(targetId)
    if (existing !== undefined && existing.sessionId !== sessionId) {
      throw new CdpTargetScopeError(
        'TARGET_OWNED_ELSEWHERE',
        `cdp: target ${targetId} belongs to session ${existing.sessionId} and cannot be claimed by ${sessionId}`,
        { sessionId, targetId, owner: existing.sessionId, operation: `grant:${origin}` },
      )
    }
    if (existing !== undefined) return existing
    const grant: TargetGrant = { targetId, sessionId, origin, grantedAt: now }
    this.#grants.set(targetId, grant)
    const held = this.#perSession.get(sessionId)
    if (held === undefined) this.#perSession.set(sessionId, [targetId])
    else held.push(targetId)
    // A fresh grant becomes the session's default target: the one a call with no
    // targetId addresses. setActive can move it, inside the fence.
    this.#active.set(sessionId, targetId)
    return grant
  }

  /**
   * Mint many grants at once (adoption at `cdp_open`).
   * @param sessionId - adopting session.
   * @param targetIds - every target the endpoint currently has.
   * @param origin - the sanctioned path; `'open'` for adoption.
   * @param now - epoch ms.
   * @returns the stored grants, in order.
   */
  grantMany(sessionId: string, targetIds: readonly string[], origin: TargetGrantOrigin, now: number = Date.now()): TargetGrant[] {
    return targetIds.map(targetId => this.grant(sessionId, targetId, origin, now))
  }

  /**
   * @param sessionId - the session to ask about.
   * @param targetId - the target in question.
   * @returns whether this session owns that target.
   */
  owns(sessionId: string, targetId: string): boolean {
    return this.#grants.get(targetId)?.sessionId === sessionId
  }

  /**
   * @param targetId - the target to ask about.
   * @returns the owning session id, or undefined when nobody owns it.
   */
  ownerOf(targetId: string): string | undefined {
    return this.#grants.get(targetId)?.sessionId
  }

  /**
   * The hard wall: throws unless `sessionId` owns `targetId`. Deny-by-default —
   * unowned, unknown, and foreign are one refusal.
   * @param sessionId - the calling session.
   * @param targetId - the addressed target.
   * @param operation - tool/method name for the refusal text.
   */
  assert(sessionId: string, targetId: string, operation: string): void {
    const grant = this.#grants.get(targetId)
    if (grant === undefined) {
      throw new CdpTargetScopeError(
        'TARGET_NOT_OWNED',
        `cdp: ${operation}: target ${targetId} is not within session ${sessionId}'s holdings — request a target of your own (cdp_open / cdp_tab_new)`,
        { sessionId, targetId, operation },
      )
    }
    if (grant.sessionId !== sessionId) {
      throw new CdpTargetScopeError(
        'TARGET_OWNED_ELSEWHERE',
        `cdp: ${operation}: target ${targetId} belongs to session ${grant.sessionId}, not ${sessionId} — foreign targets are unreachable by design`,
        { sessionId, targetId, owner: grant.sessionId, operation },
      )
    }
  }

  /**
   * In-band twin of {@link assert}: same wall, refusal as data.
   * @param sessionId - the calling session.
   * @param targetId - the addressed target.
   * @returns the pass/fail record.
   */
  check(sessionId: string, targetId: string): TargetScopeCheck {
    try {
      this.assert(sessionId, targetId, 'check')
      return { ok: true, targetId }
    } catch (error) {
      if (!(error instanceof CdpTargetScopeError)) throw error
      return {
        ok: false,
        code: error.code,
        reason: error.message,
        ...(error.owner !== undefined ? { owner: error.owner } : {}),
      }
    }
  }

  /**
   * Move the session's default pointer to one of its OWN targets.
   * @param sessionId - the session.
   * @param targetId - the target to make default; must be owned.
   */
  setActive(sessionId: string, targetId: string): void {
    this.assert(sessionId, targetId, 'setActive')
    this.#active.set(sessionId, targetId)
  }

  /**
   * @param sessionId - the session.
   * @returns the target a target-less call addresses: the session's own active
   * one, or its most recent grant. Never another session's.
   */
  defaultTargetId(sessionId: string): string | undefined {
    const active = this.#active.get(sessionId)
    if (active !== undefined && this.owns(sessionId, active)) return active
    const held = this.#perSession.get(sessionId)
    return held?.[held.length - 1]
  }

  /**
   * Fence-safe target resolution for every tool call: an explicit target must be
   * owned; an omitted one falls back to the session's own default; a session with
   * no holdings gets {@link CdpTargetScopeError} `'SCOPE_REQUIRED'`.
   * @param sessionId - the calling session.
   * @param requested - the tool's targetId argument, when given.
   * @param operation - tool name for the refusal text.
   * @returns the target the call may address.
   */
  resolveTargetId(sessionId: string, requested: string | undefined, operation: string): string {
    if (requested !== undefined && requested !== '') {
      this.assert(sessionId, requested, operation)
      return requested
    }
    const fallback = this.defaultTargetId(sessionId)
    if (fallback === undefined) {
      throw new CdpTargetScopeError(
        'SCOPE_REQUIRED',
        `cdp: ${operation}: session ${sessionId} holds no target yet — cdp_open or cdp_tab_new first`,
        { sessionId, operation },
      )
    }
    return fallback
  }

  /**
   * Drop one grant (its target closed). The session default falls back to its
   * most recent remaining grant.
   * @param targetId - the departed target.
   */
  releaseTarget(targetId: string): void {
    const grant = this.#grants.get(targetId)
    if (grant === undefined) return
    this.#grants.delete(targetId)
    const held = this.#perSession.get(grant.sessionId)
    if (held !== undefined) {
      const rest = held.filter(id => id !== targetId)
      if (rest.length === 0) {
        this.#perSession.delete(grant.sessionId)
        this.#active.delete(grant.sessionId)
      } else {
        this.#perSession.set(grant.sessionId, rest)
        const last = rest[rest.length - 1]
        if (this.#active.get(grant.sessionId) === targetId && last !== undefined) {
          this.#active.set(grant.sessionId, last)
        }
      }
    }
  }

  /**
   * Drop every grant of one session (the session closed).
   * @param sessionId - the departing session.
   */
  releaseSession(sessionId: string): void {
    for (const targetId of this.#perSession.get(sessionId) ?? []) this.#grants.delete(targetId)
    this.#perSession.delete(sessionId)
    this.#active.delete(sessionId)
  }

  /**
   * @param sessionId - the session to inventory.
   * @returns every target id the session owns, oldest grant first.
   */
  targetsOf(sessionId: string): readonly string[] {
    return [...(this.#perSession.get(sessionId) ?? [])]
  }

  /**
   * The fence for listings: foreign rows disappear before any rendering, so an
   * agent cannot even enumerate sibling ids.
   * @param sessionId - the viewing session.
   * @param rows - candidate rows (targets, endpoints…).
   * @param pick - extracts the target id from one row.
   * @returns only the rows whose id this session owns.
   */
  filterRows<T>(sessionId: string, rows: readonly T[], pick: (row: T) => string | undefined): T[] {
    return rows.filter((row) => {
      const targetId = pick(row)
      return targetId !== undefined && this.owns(sessionId, targetId)
    })
  }

  /**
   * The raw-command wall — the mechanical impossibility layer for `cdp_raw`.
   * Browser-scope commands pass only when allow-listed AND smuggling clean;
   * target-scoped commands must address an owned target and must not carry any
   * OTHER target id anywhere in their parameter tree.
   * @param sessionId - the calling session.
   * @param method - the CDP method being sent.
   * @param params - the parameter tree.
   * @param targetId - the page target the send is bound to, when scoped.
   */
  assertRaw(sessionId: string, method: string, params: Readonly<Record<string, unknown>>, targetId: string | undefined): void {
    if (RAW_MANIPULATION_DENY.includes(method)) {
      throw new CdpTargetScopeError(
        'RAW_METHOD_DENIED',
        `cdp: raw: ${method} manipulates targets and is unreachable for sessions (the target-isolation vault)`,
        { sessionId, method, operation: 'raw' },
      )
    }
    if (targetId === undefined || targetId === '') {
      // Unbound callers get ONLY the named read allow-list — an unknown domain
      // is not "probably page-scoped", it is denied. Page-scoped work must bind
      // one of the session's own targets.
      if (!RAW_BROWSER_ALLOW.includes(method)) {
        throw new CdpTargetScopeError(
          'RAW_METHOD_DENIED',
          `cdp: raw: ${method} is not on the read allow-list — bind one of your own targets instead`,
          { sessionId, method, operation: 'raw' },
        )
      }
    } else {
      this.assert(sessionId, targetId, `raw:${method}`)
    }
    this.#assertRawParams(sessionId, method, params, targetId)
  }

  /**
   * Recursive smuggle check: every target-bearing parameter must name the one
   * owned target (or a list of owned targets) — a read can never piggy-back a
   * foreign id.
   * @param sessionId - the calling session.
   * @param method - the CDP method being sent.
   * @param node - the parameter subtree to walk.
   * @param boundTargetId - the target the send is bound to, when scoped.
   */
  #assertRawParams(sessionId: string, method: string, node: unknown, boundTargetId: string | undefined): void {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) this.#assertRawParams(sessionId, method, item, boundTargetId)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const isTargetKey = RAW_TARGET_PARAM_KEYS.includes(key)
      if (isTargetKey) {
        const ids = Array.isArray(value) ? value : [value]
        for (const id of ids) {
          const candidate = typeof id === 'string'
            ? id
            : id !== null && typeof id === 'object' && typeof (id as { targetId?: unknown }).targetId === 'string'
              ? (id as { targetId: string }).targetId
              : undefined
          if (candidate === undefined) continue
          if (!this.owns(sessionId, candidate) || (boundTargetId !== undefined && candidate !== boundTargetId && key !== 'targetIds')) {
            throw new CdpTargetScopeError(
              'RAW_PARAM_DENIED',
              `cdp: raw: ${method}.${key} names target ${candidate} outside session ${sessionId}'s holdings — foreign ids cannot be used even when known`,
              { sessionId, method, targetId: candidate, operation: 'raw' },
            )
          }
        }
        continue
      }
      this.#assertRawParams(sessionId, method, value, boundTargetId)
    }
  }

  /**
   * Diagnostic snapshot for status surfaces (ids only — no live objects).
   * @returns every grant as plain data, plus each session's default target.
   */
  snapshot(): { grants: readonly TargetGrant[]; active: Readonly<Record<string, string>> } {
    const active: Record<string, string> = {}
    for (const [sessionId, targetId] of this.#active) active[sessionId] = targetId
    return { grants: [...this.#grants.values()], active }
  }
}
