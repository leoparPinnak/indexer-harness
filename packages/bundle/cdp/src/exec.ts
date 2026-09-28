/**
 * @deepseek-ai/dsh-cdp/exec — the pure outcome layer for expression runs. It
 * classifies transport/protocol failures into the error envelope's `kind`s,
 * builds the `cdp_exec` and `cdp_eval` success/failure envelopes from
 * {@link PageEvaluation} results, and renders the model-facing text for both.
 * Everything here is transport-free: no socket, no service, no timing — so the
 * semantics are testable without a browser, and both the tool layer and the
 * REST layer answer from the same code.
 * @module @deepseek-ai/dsh-cdp/exec
 */

import {
  CdpConnectionClosedError,
  CdpError,
  CdpTimeoutError as ConnectionTimeoutError,
} from './connection.ts'
import {
  CdpPageError,
  CdpSessionClosedError,
  CdpTimeoutError as PageTimeoutError,
  type EvaluationError,
  type PageEvaluation,
} from './page.ts'
import { CdpTargetError } from './targets.ts'

/** Default per-send reply timeout for `cdp_exec` when none is supplied. */
export const DEFAULT_EXEC_TIMEOUT_MS = 15_000

/** Lowest accepted per-send reply timeout; values below clamp up to this. */
export const MIN_EXEC_TIMEOUT_MS = 100

/** Highest accepted per-send reply timeout; values above clamp down to this. */
export const MAX_EXEC_TIMEOUT_MS = 60_000

/** Bound on the echoed `postCondition.value`, independent of the main result bound. */
export const MAX_POST_CONDITION_CHARS = 512

/**
 * Error kinds `cdp_exec` reports: {@link EvaluationError}'s kinds plus
 * `postCondition`, the assertion failure of a ran-and-falsy condition.
 */
export type ExecErrorKind = EvaluationError['kind'] | 'postCondition'

/** Failure envelope `cdp_exec` reports on `ok:false`. */
export interface ExecError {
  /** Classification of the failure. */
  readonly kind: ExecErrorKind
  /** Thrown value's constructor name; absent when unknown. */
  readonly name?: string
  /** One-line message with any `Name: ` prefix removed. */
  readonly message: string
  /** Stack text when the failure carried one. */
  readonly stack?: string
  /** The expression that was being run when the failure happened. */
  readonly expression?: string
  /** Which phase produced the failure: the script, or its post-condition. */
  readonly phase?: 'script' | 'postCondition'
}

/** The `postCondition` block carried on a {@link ExecOutcome}. */
export interface ExecPostCondition {
  /** Whether a post-condition was requested for this run. */
  readonly requested: boolean
  /** Whether it evaluated truthy; false whenever the block exists but the run is `ok:false`. */
  readonly passed: boolean
  /** The condition's actual returned value as text, cut at {@link MAX_POST_CONDITION_CHARS}. */
  readonly value?: string
}

/**
 * Outcome of one `cdp_exec` run: always a full envelope, never an empty
 * success-shaped string over a failure, and never a thrown pipeline error for
 * an expected failure mode.
 */
export interface ExecOutcome {
  /** Whether the script ran and any requested post-condition passed. */
  readonly ok: boolean
  /** Whether the run verifiably did something: returned a value or passed its post-condition. */
  readonly didAct: boolean
  /** Serialized script result, cut at the evaluate bound; empty on failure. */
  readonly result: string
  /** True when `result` was cut at the bound. */
  readonly truncated: boolean
  /** JSON type of the produced value: `undefined`, `null`, `string`, `number`, `boolean`, `object`, `array`. */
  readonly valueType: string
  /** The target the run resolved to; `''` when no session could be resolved (schema requires the key). */
  readonly targetId: string
  /** Page URL read before the expression ran; evidence against a wrong-tab resolve; `''` when unavailable. */
  readonly url: string
  /** Wall-clock duration of the whole run in milliseconds. */
  readonly durationMs: number
  /** Failure envelope; present only when `ok` is false. */
  readonly error?: ExecError
  /** The post-condition's outcome; present only when one was requested and ran. */
  readonly postCondition?: ExecPostCondition
  /**
   * plan10-fix (T6 §3.3): true when a `timeout` failure triggered
   * `Runtime.terminateExecution` on the page — the script's zombie run was
   * cancelled instead of left running. Present only when a terminate was
   * attempted; false when the terminate request itself failed.
   */
  readonly terminated?: boolean
  /**
   * plan10-fix (T6 §3.3): the probed `document.hidden` value of the target
   * before the run; present when the probe answered. `true` explains timer
   * throttling (Chrome slows timers in hidden tabs) behind timeout surprises.
   * plan15-hidden: now only a CORROBORATED reading reports a value — `true`
   * requires `document.visibilityState === 'hidden'` as well, and a probe that
   * answered nothing (or incoherently) omits the field instead of guessing.
   */
  readonly documentHidden?: boolean
  /**
   * plan15-hidden: the per-send bound this run actually used, reported ONLY
   * when the hidden-tab margin widened it. A silently doubled timeout is a
   * hidden variable; a reported one is evidence.
   */
  readonly effectiveTimeoutMs?: number
}

/** Outcome of one `cdp_eval` run in the extended (additive) envelope. */
export interface EvalOutcome {
  /** Whether the expression returned a value without throwing. */
  readonly ok: boolean
  /** Serialized result, cut at the evaluate bound; empty on failure. */
  readonly result: string
  /** True when `result` was cut at the bound. */
  readonly truncated: boolean
  /** Protocol exception text when the expression threw; omitted otherwise. */
  readonly exception?: string
  /** Failure envelope; present only when `ok` is false. */
  readonly error?: EvaluationError
  /** The target the evaluation resolved to; absent when no session could be resolved. */
  readonly targetId?: string
  /** Page URL read before the expression ran. */
  readonly url?: string
  /**
   * plan10-fix (T6 §3.3): true when a `timeout` failure triggered
   * `Runtime.terminateExecution` — the page script's zombie run was cancelled
   * instead of left running; false when the terminate request itself failed.
   * Present only when a terminate was attempted.
   */
  readonly terminated?: boolean
  /**
   * plan10-fix (T6 §3.3): the probed `document.hidden` value before the run;
   * `true` names timer throttling as the likely reason a timeout fired.
   */
  readonly documentHidden?: boolean
}

/**
 * plan10-fix: zombie/termination + hidden-tab context folded into a `cdp_eval`
 * envelope by {@link buildEvalOutcome} and {@link buildEvalFailureOutcome}.
 * Optional fields stay omitted when unknown (exactOptionalPropertyTypes).
 */
export interface EvalFixContext {
  /** Whether `Runtime.terminateExecution` was sent after a timeout. */
  readonly terminated?: boolean
  /** The pre-run page-activity probe answer, when it corroborated one. */
  readonly documentHidden?: boolean
}

/**
 * plan15-hidden: what one page-activity probe could actually corroborate.
 * `unverified` is the honest answer for a probe that did not answer, and for
 * a `document.hidden: true` the page's own `visibilityState` refuses to
 * corroborate — neither may claim throttling.
 */
export type PageHiddenState = 'hidden' | 'visible' | 'unverified'

/** One page-activity probe answer, with the evidence behind the verdict. */
export interface PageActivityProbe {
  /** The corroborated verdict, or `unverified` when nothing could be trusted. */
  readonly state: PageHiddenState
  /** The page's own `document.visibilityState` when it reported one. */
  readonly visibilityState?: string
  /** The page's own `document.hasFocus()` when it reported one. */
  readonly focused?: boolean
}

/** The verdict for a probe that did not answer, or answered incoherently. */
export const UNVERIFIED_ACTIVITY: PageActivityProbe = Object.freeze({ state: 'unverified' })

/**
 * plan15-hidden: one out-of-band read of the page's own activity signals.
 * Sent over the raw connection, never through `session.evaluate`, so the run's
 * own evaluate call pattern (and the plan01 tests that count it) is unchanged.
 * Reads all three signals in ONE round trip so the verdict is drawn from a
 * single instant instead of a mix of readings taken at different moments.
 * No backticks inside: the expression travels verbatim to the page.
 */
export const PAGE_ACTIVITY_EXPRESSION = String.raw`(() => ({
  hidden: document.hidden === true,
  state: String(document.visibilityState || ''),
  focused: document.hasFocus() === true,
}))()`

/**
 * plan15-hidden: turn one probe answer into a corroborated verdict.
 *
 * A bare `document.hidden` is not trusted on its own. The pre-fix code read
 * that single boolean and, whenever it was `true`, wrote the literal claim
 * `document.hidden=true — timer throttling possible` into the timeout
 * message — a claim the page itself contradicted whenever the reading was
 * wrong or stale. Now a `true` is only believed when the page's own
 * `visibilityState` says `hidden` too; anything else degrades to
 * `unverified`, which produces NO throttling hint and NO timeout margin.
 * Absence of evidence is never evidence of a hidden tab.
 * @param value - the `returnByValue` payload of {@link PAGE_ACTIVITY_EXPRESSION}.
 * @returns the corroborated verdict plus the evidence that produced it.
 */
export function readPageActivity(value: unknown): PageActivityProbe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return UNVERIFIED_ACTIVITY
  const record = value as Record<string, unknown>
  const evidence = {
    ...(typeof record.state === 'string' && record.state !== '' ? { visibilityState: record.state } : {}),
    ...(typeof record.focused === 'boolean' ? { focused: record.focused } : {}),
  }
  if (record.hidden === false) return { state: 'visible', ...evidence }
  if (record.hidden !== true) return { state: 'unverified', ...evidence }
  if (record.state === 'hidden') return { state: 'hidden', visibilityState: 'hidden', ...evidence }
  // A hidden flag the visibility state does not corroborate is a reading this
  // tool will not repeat as a fact: it is reported, not believed.
  return { state: 'unverified', ...evidence }
}

/**
 * plan15-hidden: the envelope's `documentHidden` for one verdict — `true` only
 * for a corroborated hidden tab, `false` for a corroborated visible one, and
 * `undefined` (omitted from every envelope) when the probe proved nothing.
 * @param probe - one corroborated probe answer.
 * @returns the tri-state envelope value.
 */
export function hiddenEnvelopeValue(probe: PageActivityProbe): boolean | undefined {
  if (probe.state === 'hidden') return true
  if (probe.state === 'visible') return false
  return undefined
}

/** Options one `cdp_exec` run carries. */
export interface ExecOptions {
  /** The script to run. */
  readonly expression: string
  /** Preferred target; omitted means the active target. */
  readonly targetId?: string
  /** Await a returned promise before reading the value. */
  readonly awaitPromise?: boolean
  /** Assertion evaluated after the script, truthiness decided in-page. */
  readonly postCondition?: string
  /** Per-send reply timeout in milliseconds; clamped by the service. */
  readonly timeoutMs?: number
}

/** Input {@link buildExecOutcome} folds into an {@link ExecOutcome}. */
export interface ExecBuildInput {
  /** The script that was run, carried onto error envelopes. */
  readonly expression: string
  /** Resolved target, when one could be resolved. */
  readonly targetId?: string
  /** Page URL read before the run. */
  readonly url?: string
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
  /** The script's evaluation; required unless `failure` is given. */
  readonly script?: PageEvaluation
  /** The requested post-condition text; present with its `post` once it ran. */
  readonly postCondition?: string
  /** The post-condition's evaluation; present only after it ran. */
  readonly post?: PageEvaluation
  /** An infrastructure failure in place of a script evaluation. */
  readonly failure?: EvaluationError
  /** The phase an infrastructure failure happened in. */
  readonly phase?: 'script' | 'postCondition'
  /**
   * plan10-fix: whether `Runtime.terminateExecution` was sent after a
   * timeout, so the envelope says the page script was cancelled.
   */
  readonly terminated?: boolean
  /**
   * plan10-fix: the pre-run `document.hidden` probe answer, echoed onto every
   * envelope shape so hidden-tab throttling is visible to the caller.
   * plan15-hidden: a corroborated value only — see {@link hiddenEnvelopeValue}.
   */
  readonly documentHidden?: boolean
  /**
   * plan15-hidden: present only when the hidden-tab margin widened the bound,
   * so an applied ×2 is reported instead of silently changing the deadline.
   */
  readonly effectiveTimeoutMs?: number
}

/**
 * Map a known CDP failure class onto the envelope's `kind`.
 *
 * Every failure mode the bundle can expect is named here — send timeout,
 * dropped socket, closed session, protocol error replies, and the service's
 * own resolution failures — so an expected failure is always reported instead
 * of reaching the agent pipeline as a crash.
 * @param error - the caught failure.
 * @returns the structured failure carrying kind and message.
 * @throws the original error when it is not one of the known classes.
 */
export function classifyCdpError(error: unknown): EvaluationError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ConnectionTimeoutError || error instanceof PageTimeoutError) {
    return { kind: 'timeout', message }
  }
  if (error instanceof CdpConnectionClosedError) {
    return { kind: 'connection', message }
  }
  if (error instanceof CdpSessionClosedError) {
    return { kind: 'session', message }
  }
  if (error instanceof CdpError || error instanceof CdpPageError || error instanceof CdpTargetError) {
    return { kind: 'protocol', message }
  }
  if (error instanceof Error) {
    if (error.message.startsWith('cdp: no active')) return { kind: 'connection', message }
    if (error.message.startsWith('cdp: could not resolve')) return { kind: 'protocol', message }
  }
  throw error
}

/**
 * @param error - the caught failure.
 * @returns whether {@link classifyCdpError} can classify it; unknown errors are for the pipeline.
 */
export function isInfrastructureError(error: unknown): boolean {
  try {
    classifyCdpError(error)
    return true
  } catch {
    return false
  }
}

/**
 * Clamp one requested per-send reply timeout into the accepted band.
 * @param timeoutMs - the requested value of any type; non-finite falls back to the default.
 * @returns the bounded timeout: default 15 000, floor 100, ceiling 60 000.
 */
export function clampTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_EXEC_TIMEOUT_MS
  if (timeoutMs < MIN_EXEC_TIMEOUT_MS) return MIN_EXEC_TIMEOUT_MS
  if (timeoutMs > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS
  return timeoutMs
}

/**
 * Wrap a post-condition so one evaluate yields both its truthiness and its
 * actual returned value. The wrapper only observes: an expression that throws
 * still throws, now under the `postCondition` phase.
 * @param postCondition - the author's assertion expression.
 * @returns the wrapped expression handed to {@link PageSession.evaluate}.
 */
export function postConditionExpression(postCondition: string): string {
  return `(() => { const value = (${postCondition}); return { passed: Boolean(value), value: String(value) } })()`
}

/**
 * Fold one `cdp_exec` run into its complete outcome envelope, applying the
 * semantics table: a script throw ends the run (the post-condition never
 * runs), a falsy post-condition makes the whole run `ok:false`, and `didAct`
 * reads only from the outcome — never from `result` being a non-empty string.
 * @param input - the run's evaluations, timing, and resolution evidence.
 * @returns the envelope; expected failures are values here, never throws.
 */
export function buildExecOutcome(input: ExecBuildInput): ExecOutcome {
  // §4.2: `targetId`/`url` are required output keys — `''` marks "could not
  // resolve" (the renders hide the segment) so validation never rejects an
  // envelope produced before a session existed.
  const target = {
    targetId: input.targetId ?? '',
    url: input.url ?? '',
  }
  // plan10-fix: the hidden-tab probe and the timeout-terminate flag ride every
  // branch that has them, omitted entirely when unknown (exactOptionalPropertyTypes).
  // plan15-hidden: the applied hidden-tab margin rides them too, so a doubled
  // deadline is reported rather than silently changing the timeout.
  const hidden = {
    ...(input.documentHidden !== undefined ? { documentHidden: input.documentHidden } : {}),
    ...(input.effectiveTimeoutMs !== undefined ? { effectiveTimeoutMs: input.effectiveTimeoutMs } : {}),
  }

  if (input.failure !== undefined) {
    const phase = input.phase ?? 'script'
    return {
      ok: false,
      didAct: false,
      result: '',
      truncated: false,
      valueType: 'undefined',
      durationMs: input.durationMs,
      ...target,
      ...hidden,
      ...(input.terminated !== undefined ? { terminated: input.terminated } : {}),
      error: { ...input.failure, expression: input.failure.expression ?? input.expression, phase },
      ...(input.postCondition !== undefined && phase === 'postCondition'
        ? { postCondition: { requested: true, passed: false } }
        : {}),
    }
  }

  const script = input.script
  if (script === undefined) throw new Error('cdp: buildExecOutcome requires a script evaluation')

  if (script.error !== undefined) {
    return {
      ok: false,
      didAct: false,
      result: '',
      truncated: false,
      valueType: 'undefined',
      durationMs: input.durationMs,
      ...target,
      ...hidden,
      error: {
        ...script.error,
        expression: script.error.expression ?? input.expression,
        phase: 'script' as const,
      },
    }
  }

  const base = {
    result: script.value,
    truncated: script.truncated,
    valueType: script.valueType,
    durationMs: input.durationMs,
    ...target,
    ...hidden,
  }

  if (input.postCondition === undefined) {
    return { ok: true, didAct: script.hasValue, ...base }
  }

  const post = input.post
  if (post === undefined) throw new Error('cdp: buildExecOutcome requires the post-condition evaluation')

  if (post.error !== undefined) {
    return {
      ok: false,
      didAct: false,
      ...base,
      error: {
        ...post.error,
        expression: input.postCondition,
        phase: 'postCondition' as const,
      },
      postCondition: { requested: true, passed: false },
    }
  }

  const parsed = parsePostConditionValue(post.value)
  return {
    ok: parsed.passed,
    didAct: parsed.passed,
    ...base,
    ...(parsed.passed
      ? {}
      : {
          error: {
            kind: 'postCondition' as const,
            message: `expected truthy, got "${parsed.value}"`,
            expression: input.postCondition,
            phase: 'postCondition' as const,
          },
        }),
    postCondition: { requested: true, passed: parsed.passed, value: parsed.value },
  }
}

/**
 * Fold one `cdp_eval` evaluation into the extended envelope: success keeps
 * today's `ok`/`result`/`truncated` and adds the resolution evidence, a
 * throw reports `{ok:false, error}` instead of an empty success-shaped string.
 * @param evaluation - the bounded evaluation result.
 * @param targetId - the resolved target, when one was resolved.
 * @param url - the page URL read before the evaluation.
 * @returns the envelope both the tool and the REST route answer with.
 */
export function buildEvalOutcome(evaluation: PageEvaluation, targetId?: string, url?: string, context?: EvalFixContext): EvalOutcome {
  const target = {
    ...(targetId !== undefined ? { targetId } : {}),
    ...(url !== undefined ? { url } : {}),
  }
  // plan10-fix: termination + hidden-tab context, omitted when unknown.
  const fix = {
    ...(context?.terminated !== undefined ? { terminated: context.terminated } : {}),
    ...(context?.documentHidden !== undefined ? { documentHidden: context.documentHidden } : {}),
  }
  if (evaluation.error !== undefined) {
    return {
      ok: false,
      result: '',
      truncated: false,
      ...(evaluation.exception !== undefined ? { exception: evaluation.exception } : {}),
      // §4.1: the eval error carries exactly kind/name/message/stack — the
      // expression lives only in cdp_exec's envelope, so the output schema's
      // additionalProperties:false never rejects it.
      error: pickEvalError(evaluation.error),
      ...target,
      ...fix,
    }
  }
  return { ok: true, result: evaluation.value, truncated: evaluation.truncated, ...target, ...fix }
}

/**
 * Fold an infrastructure failure of `cdp_eval` into its envelope. The tool
 * layer catches known failures so the model reads a classified envelope;
 * unknown errors are rethrown by {@link classifyCdpError} beforehand.
 * @param error - the classified infrastructure failure.
 * @param expression - the expression the evaluation attempted.
 * @param targetId - the requested target, when one was given.
 * @param context - plan10-fix: termination + hidden-tab context, when known.
 * @returns the failure envelope.
 */
export function buildEvalFailureOutcome(error: EvaluationError, expression: string, targetId?: string, context?: EvalFixContext): EvalOutcome {
  void expression
  return {
    ok: false,
    result: '',
    truncated: false,
    error: pickEvalError(error),
    ...(targetId !== undefined ? { targetId } : {}),
    ...(context?.terminated !== undefined ? { terminated: context.terminated } : {}),
    ...(context?.documentHidden !== undefined ? { documentHidden: context.documentHidden } : {}),
  }
}

/**
 * @param error - the classified failure.
 * @returns exactly the four keys the `cdp_eval` output schema declares for
 * `error` (§4.1), so `additionalProperties:false` accepts the envelope.
 */
function pickEvalError(error: EvaluationError): EvaluationError {
  return {
    kind: error.kind,
    ...(error.name !== undefined ? { name: error.name } : {}),
    message: error.message,
    ...(error.stack !== undefined ? { stack: error.stack } : {}),
  }
}

/**
 * Render the model-facing line for one `cdp_exec` outcome. Success names the
 * target, the evidence URL, the duration, and the value's type; a failure
 * names the error class first so the model can branch on `[kind]` alone.
 * @param outcome - the outcome to render.
 * @returns the single text block for the tool card.
 */
export function renderExecText(outcome: ExecOutcome): string {
  if (outcome.ok) {
    const target = outcome.targetId
      ? ` on ${outcome.targetId}${outcome.url ? ` (${outcome.url})` : ''}`
      : ''
    const display = outcome.valueType === 'string' ? JSON.stringify(outcome.result) : outcome.result
    const condition = outcome.postCondition?.passed === true ? ' | postCondition passed' : ''
    return `cdp_exec OK${target} in ${String(outcome.durationMs)}ms → ${display} (${outcome.valueType})${condition}`
  }
  const error = outcome.error
  const kind = error?.kind ?? 'error'
  const where = outcome.targetId
    ? ` on ${outcome.targetId}${outcome.url ? ` (${outcome.url})` : ''} in ${String(outcome.durationMs)}ms`
    : ''
  const detail = error === undefined ? '' : renderErrorDetail(error)
  const expression = error !== undefined
    && error.expression !== undefined
    && (kind === 'exception' || kind === 'postCondition')
    ? ` | expression: ${error.expression}`
    : ''
  return `cdp_exec FAILED [${kind}]${where}: ${detail}${expression}`
}

/**
 * Render the model-facing line for a failed `cdp_eval`.
 * @param outcome - the failure outcome to render.
 * @returns `Eval FAILED [kind] …` naming the class, the target evidence, and the message.
 */
export function renderEvalFailure(outcome: EvalOutcome): string {
  const error = outcome.error
  const kind = error?.kind ?? 'exception'
  const where = outcome.targetId === undefined
    ? ''
    : ` on ${outcome.targetId}${outcome.url === undefined ? '' : ` (${outcome.url})`}`
  const detail = error === undefined ? '' : renderErrorDetail(error)
  return `Eval FAILED [${kind}]${where}: ${detail}`
}

/**
 * @param error - a failure carrying a message and an optional name.
 * @returns `name: message`, collapsing when they are the same text or the name is absent.
 */
function renderErrorDetail(error: { readonly name?: string; readonly message: string }): string {
  if (error.name === undefined || error.name === error.message) return error.message
  return `${error.name}: ${error.message}`
}

/**
 * Read the wrapper's `{passed, value}` result from its serialized text.
 * A shape the wrapper never produces falls back to `passed:false` with the
 * raw text, so a tampered reply can never fail open.
 * @param raw - the post-condition evaluation's serialized value.
 * @returns the truthiness and the bounded actual value.
 */
function parsePostConditionValue(raw: string): { passed: boolean; value: string } {
  try {
    const parsed: unknown = JSON.parse(raw)
    const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
    if (record !== undefined && typeof record.passed === 'boolean') {
      const value = typeof record.value === 'string' ? record.value : String(record.value)
      return { passed: record.passed, value: boundPostValue(value) }
    }
  } catch {
    // Not JSON: fall through to the raw-text reading below.
  }
  return { passed: false, value: boundPostValue(raw) }
}

/**
 * @param value - the condition's actual returned value as text.
 * @returns the value cut at {@link MAX_POST_CONDITION_CHARS}.
 */
function boundPostValue(value: string): string {
  return value.length > MAX_POST_CONDITION_CHARS ? value.slice(0, MAX_POST_CONDITION_CHARS) : value
}
