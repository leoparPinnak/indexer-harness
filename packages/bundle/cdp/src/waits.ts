/**
 * Plan 02 Faz 3 (§4.7): the seven wait strategies behind `cdp_wait`.
 *
 * The dispatch lives in {@link runWait} against a narrow seam so every
 * strategy's pass/timeout path is testable without a browser. The `css`
 * strategy keeps the legacy contract byte-for-byte: `waitForSelector(selector,
 * timeoutMs)` with the raw caller timeout; a `CdpTimeoutError` comes back
 * in-band (`ok:false, timedOut:true`) instead of throwing — the one sanctioned
 * behaviour change in §10. Infrastructure errors still throw.
 */

import { CdpTimeoutError } from './page.ts'
import { LOCATOR_MAX_WAIT_MS, LOCATOR_POLL_MS, clampWaitTimeout, sleep, type LocatorSpec, type ResolvedTarget } from './locator.ts'

/** Canonical strategy list; also the `strategy` parameter enum. */
export const WAIT_STRATEGIES = ['css', 'aria-label', 'text', 'visible', 'network-idle', 'navigation', 'url'] as const

/** One wait strategy name. */
export type WaitStrategy = (typeof WAIT_STRATEGIES)[number]

/** Default budget when `timeoutMs` is absent (mirrors the legacy 10000). */
export const WAIT_DEFAULT_TIMEOUT_MS = 10_000

/** Default quiet window for `network-idle`. */
export const WAIT_DEFAULT_IDLE_MS = 500

/** Poll interval for the URL matcher. */
export const WAIT_URL_POLL_MS = 100

/** Loose argument view; every field is optional and unknown-typed until validated. */
export interface WaitArgs {
  selector?: unknown
  strategy?: unknown
  text?: unknown
  textMatch?: unknown
  url?: unknown
  idleMs?: unknown
  timeoutMs?: unknown
}

/** A validated, defaulted wait plan handed to {@link runWait}. */
export interface WaitPlan {
  strategy: WaitStrategy
  /** Present for selector strategies (and as the url pattern fallback). */
  selector?: string
  /** Expected visible text for `strategy: 'text'` (selector may carry it instead). */
  text?: string
  /** Comparison mode for `strategy: 'text'` (absent = exact). */
  textMatch?: 'exact' | 'contains'
  /** Compiled-validated regex source for `strategy: 'url'`. */
  urlPattern?: string
  idleMs: number
  timeoutMs: number
}

/** Expected-condition reply for the locator-backed strategies. */
export interface WaitExpectReply {
  passed: boolean
  url?: string
  target?: ResolvedTarget
  reason?: string
}

/** network-idle reply from the service seam. */
export interface WaitNetworkReply {
  ok: boolean
  timedOut: boolean
  waitedMs: number
  reason?: string
}

/** Everything {@link runWait} needs from the session/service layer. */
export interface WaitSeam {
  /** Legacy CSS probe; must call `PageSession.waitForSelector` verbatim. */
  waitForSelector(selector: string, timeoutMs: number): Promise<void>
  /** Session-scoped load wait; must call `PageSession.waitForLoad`. */
  waitForLoad(timeoutMs: number): Promise<void>
  /** Current page URL (best-effort; `''` when unreadable). */
  currentUrl(): Promise<string>
  /** Locator-ladder check for aria-label/text/visible strategies. */
  expectCheck(check: 'exists' | 'visible', spec: LocatorSpec, timeoutMs: number): Promise<WaitExpectReply>
  /** network-idle runner with Network.enable/disable + event counters. */
  networkIdle(timeoutMs: number, idleMs: number): Promise<WaitNetworkReply>
}

/** Envelope `cdp_wait` returns. */
export interface WaitOutcome {
  ok: boolean
  action: 'wait'
  strategy: WaitStrategy
  selector?: string
  /** The expected visible text, echoed for `strategy: 'text'`. */
  text?: string
  waitedMs: number
  timedOut: boolean
  url: string
  target?: ResolvedTarget
  reason?: string
}

/** Input shape the renderer accepts (matches the tool's output schema). */
export interface WaitRenderInput {
  ok: boolean
  strategy?: string | undefined
  selector?: string | undefined
  text?: string | undefined
  waitedMs?: number | undefined
  timedOut?: boolean | undefined
  reason?: string | undefined
}

function isStrategy(value: unknown): value is WaitStrategy {
  return typeof value === 'string' && (WAIT_STRATEGIES as readonly string[]).includes(value)
}

/**
 * The strategy a call resolves to: the explicit `strategy` argument, else
 * `text` when a text argument stands alone (§4.7 — `text`/`textMatch` must
 * work without a selector AND without forcing the caller to name the
 * strategy), else the legacy `css` default. Returns the raw value when it is
 * not a known strategy so validation can report it.
 */
function effectiveStrategy(args: WaitArgs): unknown {
  const explicit = args.strategy === undefined || args.strategy === null || args.strategy === '' ? undefined : args.strategy
  if (explicit !== undefined) return explicit
  return typeof args.text === 'string' && args.text.trim() !== '' ? 'text' : 'css'
}

/**
 * Validate `cdp_wait` arguments in-band. Returns the first problem, or
 * undefined when the plan is sound. Defaults apply: `strategy` → `css`,
 * `timeoutMs` → {@link WAIT_DEFAULT_TIMEOUT_MS}, `idleMs` →
 * {@link WAIT_DEFAULT_IDLE_MS}.
 * @param args - raw `cdp_wait` arguments as parsed from the call.
 * @returns the first problem found, or undefined when the plan is sound.
 */
export function validateWaitArgs(args: WaitArgs): string | undefined {
  const strategy = effectiveStrategy(args)
  if (!isStrategy(strategy)) {
    return `unknown wait strategy: ${JSON.stringify(String(strategy))} (expected one of ${WAIT_STRATEGIES.join(', ')})`
  }
  if (strategy === 'network-idle') {
    if (args.idleMs !== undefined && (typeof args.idleMs !== 'number' || !Number.isFinite(args.idleMs) || args.idleMs < 0)) {
      return 'idleMs must be a non-negative number'
    }
    return undefined
  }
  if (strategy === 'navigation') return undefined
  if (strategy === 'url') {
    const pattern = typeof args.url === 'string' && args.url !== ''
      ? args.url
      : typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
    if (pattern === undefined) return 'strategy url requires a pattern (pass url, or selector)'
    try {
      new RegExp(pattern)
    } catch (error) {
      return `invalid url regular expression: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }
  // §4.7 `text`: works standalone on `text` (+ optional `textMatch`); the
  // legacy `selector` slot keeps carrying the value for old callers.
  if (strategy === 'text') {
    const text = typeof args.text === 'string' && args.text.trim() !== ''
      ? args.text
      : typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector : undefined
    if (text === undefined) return 'strategy text requires text (or selector for back-compat)'
    if (args.textMatch !== undefined && args.textMatch !== null && args.textMatch !== ''
      && args.textMatch !== 'exact' && args.textMatch !== 'contains') {
      return 'textMatch must be "exact" or "contains"'
    }
    return undefined
  }
  if (typeof args.selector !== 'string' || args.selector.trim() === '') return `strategy ${strategy} requires selector`
  return undefined
}

/**
 * Build the defaulted plan for already-validated arguments. The `css`
 * strategy keeps the caller's raw timeout (or 10000) so the legacy
 * `waitForSelector` command is byte-identical; every other strategy clamps
 * into the locator budget.
 * @param args - the already-validated `cdp_wait` arguments.
 * @returns the fully defaulted {@link WaitPlan} for the resolved strategy.
 */
export function waitPlan(args: WaitArgs): WaitPlan {
  const resolved = effectiveStrategy(args)
  const strategy: WaitStrategy = isStrategy(resolved) ? resolved : 'css'
  const rawTimeout = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
  if (strategy === 'css') {
    return {
      strategy,
      selector: typeof args.selector === 'string' ? args.selector : '',
      idleMs: WAIT_DEFAULT_IDLE_MS,
      timeoutMs: rawTimeout ?? WAIT_DEFAULT_TIMEOUT_MS,
    }
  }
  const timeoutMs = rawTimeout === undefined ? WAIT_DEFAULT_TIMEOUT_MS : clampWaitTimeout(rawTimeout)
  const idleMs = typeof args.idleMs === 'number' && Number.isFinite(args.idleMs)
    ? Math.min(Math.max(0, Math.trunc(args.idleMs)), LOCATOR_MAX_WAIT_MS)
    : WAIT_DEFAULT_IDLE_MS
  if (strategy === 'url') {
    const pattern = typeof args.url === 'string' && args.url !== '' ? args.url : String(args.selector ?? '')
    return { strategy, urlPattern: pattern, idleMs, timeoutMs }
  }
  if (strategy === 'text') {
    // `text` wins over the legacy selector slot; both are echoed when given.
    const text = typeof args.text === 'string' && args.text.trim() !== ''
      ? args.text
      : typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector : undefined
    const match = args.textMatch === 'exact' || args.textMatch === 'contains' ? args.textMatch : undefined
    return {
      strategy,
      idleMs,
      timeoutMs,
      ...(text !== undefined ? { text } : {}),
      ...(match !== undefined ? { textMatch: match } : {}),
      ...(typeof args.selector === 'string' && args.selector.trim() !== '' ? { selector: args.selector } : {}),
    }
  }
  // Selector-bearing strategies (aria-label/visible); navigation and
  // network-idle have none, so the key stays ABSENT — never `undefined`
  // (exactOptionalPropertyTypes) and never an empty string in the reason line.
  return {
    strategy,
    idleMs,
    timeoutMs,
    ...(typeof args.selector === 'string' && args.selector !== '' ? { selector: args.selector } : {}),
  }
}

/**
 * Poll one URL pattern until it matches (or the budget expires). One attempt
 * always runs, so `timeoutMs: 0` degrades to a single read.
 * @param getUrl - reads the current page URL once per attempt (errors read as `''`).
 * @param pattern - the regular expression the URL must match.
 * @param timeoutMs - budget for the whole wait; `0` still runs one read.
 * @param pollMs - delay between attempts, when given.
 * @returns the outcome: `ok`, `waitedMs`, `timedOut`, the last `actual` URL and a `reason` on failure.
 */
export async function waitForUrlPattern(
  getUrl: () => Promise<string>,
  pattern: string,
  timeoutMs: number,
  pollMs: number = WAIT_URL_POLL_MS,
): Promise<{ ok: boolean, waitedMs: number, timedOut: boolean, actual: string, reason?: string }> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    return {
      ok: false,
      waitedMs: 0,
      timedOut: false,
      actual: '',
      reason: `invalid url regular expression: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const started = Date.now()
  const deadline = started + Math.max(0, timeoutMs)
  let actual = ''
  for (;;) {
    try {
      actual = await getUrl()
    } catch {
      actual = ''
    }
    if (regex.test(actual)) {
      return { ok: true, waitedMs: Date.now() - started, timedOut: false, actual }
    }
    const now = Date.now()
    if (now >= deadline) {
      return {
        ok: false,
        waitedMs: now - started,
        timedOut: true,
        actual,
        reason: `timed out after ${timeoutMs}ms waiting for url ~ /${pattern}/ (still ${actual})`,
      }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now)))
  }
}

/** Listener view {@link waitForNetworkIdle} subscribes through. */
export interface NetworkIdleEvent {
  method: string
  params: Readonly<Record<string, unknown>>
  sessionId: string | undefined
}

/** Connection seam for the network-idle counters. */
export interface NetworkIdleSeam {
  sessionId: string
  send(method: string, params: Record<string, unknown>, sessionId: string): Promise<unknown>
  /** Subscribes already scoped to `sessionId` (the service pre-binds it). */
  on(event: string, listener: (event: NetworkIdleEvent) => void): () => void
}

/**
 * Pass once no request has been in flight for `idleMs`. Enables the Network
 * domain for the wait and always disables it + drops the listeners again —
 * the disposer contract of §9.6.
 * @param seam - the connection used to enable/disable Network and subscribe.
 * @param timeoutMs - budget for the whole wait; `0` fails on the first check.
 * @param idleMs - required quiet period before the wait passes.
 * @param pollMs - delay between checks, when given.
 * @returns the reply: `ok` once idle, otherwise `timedOut` with a reason.
 */
export async function waitForNetworkIdle(
  seam: NetworkIdleSeam,
  timeoutMs: number,
  idleMs: number,
  pollMs: number = LOCATOR_POLL_MS,
): Promise<WaitNetworkReply> {
  const started = Date.now()
  const disposers: Array<() => void> = []
  let inflight = 0
  let lastChange = started
  try {
    await seam.send('Network.enable', {}, seam.sessionId)
    const settle = () => {
      if (inflight > 0) inflight -= 1
      lastChange = Date.now()
    }
    disposers.push(seam.on('Network.requestWillBeSent', () => { inflight += 1; lastChange = Date.now() }))
    disposers.push(seam.on('Network.loadingFinished', settle))
    disposers.push(seam.on('Network.loadingFailed', settle))
    const deadline = started + Math.max(0, timeoutMs)
    for (;;) {
      const now = Date.now()
      if (inflight === 0 && now - lastChange >= idleMs) {
        return { ok: true, timedOut: false, waitedMs: now - started }
      }
      if (now >= deadline) {
        return {
          ok: false,
          timedOut: true,
          waitedMs: now - started,
          reason: `timed out after ${timeoutMs}ms waiting for network-idle (${inflight} request(s) still in flight)`,
        }
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - now)))
    }
  } finally {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A failing disposer must never mask the wait's result.
      }
    }
    await seam.send('Network.disable', {}, seam.sessionId).catch(() => undefined)
  }
}

/**
 * Run one validated wait plan against the seam. Expected failures return
 * in-band with `timedOut:true`; `CdpTimeoutError` from the legacy session
 * waits converts to the same envelope; anything else (protocol/session/page
 * errors) propagates as infrastructure.
 * @param seam - the session-backed operations each strategy dispatches to.
 * @param plan - the validated, defaulted plan from {@link waitPlan}.
 * @returns the wait outcome envelope for the tool's reply.
 */
export async function runWait(seam: WaitSeam, plan: WaitPlan): Promise<WaitOutcome> {
  const started = Date.now()
  const base = {
    action: 'wait' as const,
    strategy: plan.strategy,
    ...(plan.selector !== undefined ? { selector: plan.selector } : {}),
    ...(plan.text !== undefined ? { text: plan.text } : {}),
  }
  const urlOf = async (): Promise<string> => {
    try {
      return await seam.currentUrl()
    } catch {
      return ''
    }
  }
  try {
    if (plan.strategy === 'css') {
      await seam.waitForSelector(plan.selector ?? '', plan.timeoutMs)
      return { ok: true, ...base, waitedMs: Date.now() - started, timedOut: false, url: await urlOf() }
    }
    if (plan.strategy === 'navigation') {
      await seam.waitForLoad(plan.timeoutMs)
      return { ok: true, ...base, waitedMs: Date.now() - started, timedOut: false, url: await urlOf() }
    }
    if (plan.strategy === 'url') {
      const result = await waitForUrlPattern(() => seam.currentUrl(), plan.urlPattern ?? '', plan.timeoutMs)
      return {
        ok: result.ok,
        ...base,
        waitedMs: result.waitedMs,
        timedOut: !result.ok && result.timedOut,
        url: result.actual,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      }
    }
    if (plan.strategy === 'network-idle') {
      const result = await seam.networkIdle(plan.timeoutMs, plan.idleMs)
      return {
        ok: result.ok,
        ...base,
        waitedMs: result.waitedMs,
        timedOut: !result.ok && result.timedOut,
        url: await urlOf(),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      }
    }
    const selector = plan.selector ?? ''
    const spec: LocatorSpec = plan.strategy === 'aria-label'
      ? { ariaLabel: selector }
      : plan.strategy === 'text'
        ? {
            text: plan.text ?? selector,
            ...(plan.textMatch !== undefined ? { textMatch: plan.textMatch } : {}),
          }
        : { css: selector }
    const reply = await seam.expectCheck(plan.strategy === 'aria-label' ? 'exists' : 'visible', spec, plan.timeoutMs)
    const url = reply.url ?? await urlOf()
    // What the timeout line promises to explain. For `text` it ALWAYS names
    // the expected text (+ comparison mode), never a bare strategy.
    const condition = plan.strategy === 'text'
      ? `text ${JSON.stringify(plan.text ?? selector)}${plan.textMatch !== undefined ? ` (${plan.textMatch})` : ''}`
      : `${plan.strategy}${plan.selector !== undefined ? `: ${plan.selector}` : ''}`
    if (reply.passed) {
      return {
        ok: true,
        ...base,
        waitedMs: Date.now() - started,
        timedOut: false,
        url,
        ...(reply.target !== undefined ? { target: reply.target } : {}),
      }
    }
    return {
      ok: false,
      ...base,
      waitedMs: Date.now() - started,
      timedOut: true,
      url,
      ...(reply.target !== undefined ? { target: reply.target } : {}),
      reason: plan.strategy === 'text'
        ? `timed out after ${plan.timeoutMs}ms waiting for ${condition}${reply.reason !== undefined ? `: ${reply.reason}` : ''}`
        : reply.reason ?? `timed out after ${plan.timeoutMs}ms waiting for ${condition}`,
    }
  } catch (error) {
    if (error instanceof CdpTimeoutError) {
      return {
        ok: false,
        ...base,
        waitedMs: Date.now() - started,
        timedOut: true,
        url: await urlOf(),
        reason: `timed out after ${plan.timeoutMs}ms waiting for ${plan.strategy}`
          + `${plan.selector !== undefined ? `: ${plan.selector}` : plan.text !== undefined ? `: ${JSON.stringify(plan.text)}` : ''}`,
      }
    }
    throw error
  }
}

/**
 * Render one `cdp_wait` outcome. The legacy css-success line is preserved
 * verbatim; every other line names the strategy and the measured wait.
 * @param value - the outcome to render; missing fields degrade to safe defaults.
 * @returns the one-line result text shown to the caller.
 */
export function renderWait(value: WaitRenderInput): string {
  const strategy = typeof value.strategy === 'string' ? value.strategy : 'css'
  const selector = typeof value.selector === 'string' ? value.selector : undefined
  const text = typeof value.text === 'string' ? value.text : undefined
  const waited = typeof value.waitedMs === 'number' ? value.waitedMs : 0
  const subject = `strategy=${strategy}`
    + `${selector !== undefined ? `, ${selector}` : text !== undefined ? `, ${JSON.stringify(text)}` : ''}`
  if (value.ok !== false) {
    if (strategy === 'css' && selector !== undefined) return `Selector "${selector}" is now present.`
    return `Waited ${waited}ms: ${subject} condition met.`
  }
  const reason = typeof value.reason === 'string' ? value.reason : 'condition not met'
  return `Wait FAILED after ${waited}ms (${subject}): ${reason}`
}
