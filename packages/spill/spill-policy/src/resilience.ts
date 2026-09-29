/**
 * Budget resilience primitives: a thrash detector that notices a spill loop and
 * a circuit breaker that stops persisting to a failing backend.
 *
 * Both are pure state machines — no timers, no I/O, no context — so a caller
 * decides when to feed them and what to do with the message they return. The
 * spill plugin feeds one attempt per spill and logs the returned message once,
 * at the transition.
 *
 * The shapes follow the two patterns the program's competitor binaries use for
 * budget durability, restated in DSH's own vocabulary and thresholds:
 *
 * - **Thrash**: a counter that climbs while consecutive spills repeat the SAME
 *   artifact and resets as soon as a different one arrives; reaching the
 *   threshold reports a repeated-refill loop (three in a row), the spill-side
 *   analog of "the context refilled to the limit within 3 turns of the previous
 *   compact, 3 times in a row".
 * - **Breaker**: a consecutive-failure counter that OPENS at the threshold and
 *   then stays open ("skipping future attempts this session"), so a dead backend
 *   costs one clear error instead of one failed write per oversized result. A
 *   success before the threshold closes the streak.
 *
 * @module @deepseek-ai/dsh-spill-policy/resilience
 */

/** Consecutive repeats of one artifact that count as thrash (three in a row). */
export const THRASH_THRESHOLD = 3

/** Consecutive persist failures that open the circuit (three in a row). */
export const BREAKER_THRESHOLD = 3

/**
 * Detect a spill loop: the same artifact spilled again while the previous spill
 * of the SAME artifact is still the most recent one.
 */
export class SpillThrashDetector {
  private previousKey: string | undefined
  private streak = 0

  constructor(private readonly threshold: number = THRASH_THRESHOLD) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`SpillThrashDetector threshold must be a positive integer (got ${threshold})`)
    }
  }

  /** Consecutive spills of the same artifact since a different one arrived. */
  get consecutive(): number {
    return this.streak
  }

  /**
   * Record one completed spill.
   *
   * @param key - stable identity of the spilled artifact (owner + tool + content).
   * @returns The thrash warning when the streak first reaches the threshold, else `undefined`.
   */
  record(key: string): string | undefined {
    this.streak = this.previousKey === key ? this.streak + 1 : 1
    this.previousKey = key
    if (this.streak !== this.threshold) return undefined
    return `spill thrash: the same oversized result was spilled ${this.streak} times in a row;`
      + ' a file being read or a tool output is likely too large for the context window.'
      + ' Read it in smaller chunks, or start a fresh session.'
  }
}

/**
 * Consecutive-failure circuit breaker for spill persistence: OPEN at the
 * threshold and sticky for the rest of the session.
 */
export class PersistCircuitBreaker {
  private failures = 0
  private opened = false

  constructor(private readonly threshold: number = BREAKER_THRESHOLD) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`PersistCircuitBreaker threshold must be a positive integer (got ${threshold})`)
    }
  }

  /** Whether persistence attempts must be skipped (sticky once opened). */
  get open(): boolean {
    return this.opened
  }

  /** Consecutive failures since the last success (frozen once open). */
  get consecutiveFailures(): number {
    return this.failures
  }

  /**
   * Record one failed persist attempt.
   *
   * @returns The trip message when this failure opens the breaker, else `undefined`.
   */
  recordFailure(): string | undefined {
    if (this.opened) return undefined
    this.failures += 1
    if (this.failures < this.threshold) return undefined
    this.opened = true
    return `spill circuit breaker tripped after ${this.failures} consecutive persist failures`
      + ' — keeping oversized results inline for the rest of this session'
  }

  /**
   * Record one successful persist attempt: the failure streak closes.
   * A success after the breaker opened does not close it — reopening is a
   * deployment decision (reload the plugin), not a per-call one.
   */
  recordSuccess(): void {
    if (this.opened) return
    this.failures = 0
  }
}
