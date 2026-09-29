/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-patience: the Hermes
 * jittered-write-patience pattern, ported to the exclusive-publish seam. A
 * contended publish (EEXIST from a stale staging file or a competitor's
 * publication) may clear in milliseconds; failing it instantly punishes the
 * caller for a race that time already lost. The schedule is two-phase like the
 * measured original: a FAST band (20–150ms) inside the first two seconds, then
 * a SLOW band (250–1000ms) up to the budget. Every wait is injected (`sleep`,
 * `now`, `rand`) so tests see the schedule instead of living it, and the
 * budget-exhausted attempt rethrows the CALLER'S last error — patience never
 * rewrites an honest failure into a quiet one.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/retry-jitter
 */

/** Lower edge of the fast band (ms). */
export const FAST_JITTER_MIN_MS = 20
/** Upper edge of the fast band (ms). */
export const FAST_JITTER_MAX_MS = 150
/** Elapsed budget after which waits move to the slow band. */
export const FAST_PHASE_MS = 2_000
/** Lower edge of the slow band (ms). */
export const SLOW_JITTER_MIN_MS = 250
/** Upper edge of the slow band (ms). */
export const SLOW_JITTER_MAX_MS = 1_000
/** Production patience budget for one contended publish. */
export const PUBLISH_PATIENCE_BUDGET_MS = 10_000

/** Injectable schedule seams; production uses the real clock and timers. */
export interface PatienceSeams {
  /** Monotonic-enough clock in milliseconds. */
  now: () => number
  /** Sleep for a fixed interval. */
  sleep: (ms: number) => Promise<void>
  /** Random source in `[0, 1)`; injected so schedules are deterministic in tests. */
  rand: () => number
}

/** Production seams for {@link withJitteredPatience}. */
export const PATIENCE_PRODUCTION_SEAMS: PatienceSeams = {
  now: () => Date.now(),
  sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
  rand: Math.random,
}

/**
 * One next-wait value from the two-phase schedule.
 * @param elapsedMs - elapsed patience time; selects the band.
 * @param rand - the injected random source in `[0, 1)`.
 * @returns the wait in milliseconds inside the band's jitter range.
 */
export function jitterWaitMs(elapsedMs: number, rand: () => number): number {
  const span = elapsedMs < FAST_PHASE_MS
    ? FAST_JITTER_MAX_MS - FAST_JITTER_MIN_MS
    : SLOW_JITTER_MAX_MS - SLOW_JITTER_MIN_MS
  const base = elapsedMs < FAST_PHASE_MS ? FAST_JITTER_MIN_MS : SLOW_JITTER_MIN_MS
  return base + Math.floor(rand() * (span + 1))
}

/**
 * Retry one operation with two-phase jittered patience while the failure is
 * transient. Non-transient failures surface immediately; a drained budget
 * rethrows the LAST failure untouched.
 * @param operation - the attempt body; `attempt` is 0-based.
 * @param options - budget, transient predicate, and the injected seams.
 * @returns the first successful result.
 * @throws the last error when the budget drains or the error is non-transient.
 */
export async function withJitteredPatience<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    budgetMs?: number
    isTransient: (error: unknown) => boolean
    seams?: Partial<PatienceSeams>
    onWait?: (waitMs: number, attempt: number, error: unknown) => void
  },
): Promise<T> {
  const seams: PatienceSeams = { ...PATIENCE_PRODUCTION_SEAMS, ...options.seams }
  const budgetMs = options.budgetMs ?? PUBLISH_PATIENCE_BUDGET_MS
  const start = seams.now()
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (!options.isTransient(error)) throw error
      const elapsed = seams.now() - start
      if (elapsed >= budgetMs) throw error
      const waitMs = Math.min(jitterWaitMs(elapsed, seams.rand), budgetMs - elapsed)
      options.onWait?.(waitMs, attempt, error)
      await seams.sleep(waitMs)
    }
  }
}