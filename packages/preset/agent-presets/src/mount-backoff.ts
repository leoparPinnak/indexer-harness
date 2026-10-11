/**
 * Standing-mount resilience: the bounded jittered backoff a failed mount
 * attempt waits out, and the errno class that earns a wait at all.
 *
 * A mount fails for two very different reasons. A composition the loader
 * cannot use fails again the instant it is retried — waiting on it only
 * delays the same honest error — while a mount that tripped over a contended
 * file or an exhausted descriptor table may clear in the time a bounded wait
 * takes. So the retry gate is an errno allowlist, the attempt count is
 * bounded, and every wait comes from the shared two-phase jitter schedule
 * (`retry-jitter`'s `jitterWaitMs`: a FAST band for a failure that may clear
 * in milliseconds, a SLOW band once a fast wait has not bought success). What
 * an exhausted sequence rethrows is the attempt's own error, untouched —
 * patience never rewrites an honest failure into a quiet one.
 * @module @deepseek-ai/dsh-agent-presets/mount-backoff
 */

import { setTimeout as delay } from 'node:timers/promises'
import { FAST_PHASE_MS, jitterWaitMs } from '@deepseek-ai/dsh-session-persistence-jsonl'

/** Attempts one fresh mount generation gets before its failure is reported. */
export const MOUNT_MAX_ATTEMPTS = 3

/** TTL of a preset's FIRST recorded failure; `failureMemoTtlMs` doubles it per failure. */
export const MOUNT_FAILURE_TTL_BASE_MS = 5_000

/** Ceiling on that TTL, however many times the mount has failed. */
export const MOUNT_FAILURE_TTL_CAP_MS = 60_000

/**
 * Errno codes a bounded wait can plausibly clear: file contention (a
 * composition replaced mid-read on Windows, a directory locked by a
 * synchronizer) and resource exhaustion (a descriptor table refilled by the
 * time the next attempt runs). Everything else — a composition that will not
 * parse, a row that throws, a service nothing supplies — is reported at once.
 */
const TRANSIENT_CODES: Record<string, true> = {
  EACCES: true,
  EAGAIN: true,
  EBUSY: true,
  EMFILE: true,
  ENFILE: true,
  EPERM: true,
}

/** Injectable wait seams; production uses real timers and real randomness. */
export interface MountBackoffSeams {
  /** Sleep for one backoff wait. */
  sleep: (ms: number) => Promise<void>
  /** Random source in `[0, 1)`; injected so a schedule is deterministic in tests. */
  rand: () => number
}

/** Production seams for `withMountBackoff`. */
export const MOUNT_BACKOFF_PRODUCTION_SEAMS: MountBackoffSeams = { sleep: delay, rand: Math.random }

/**
 * Whether a failure's shape says a bounded wait can clear it: a transient
 * errno on the error itself, on anything it aggregates, or anywhere down its
 * `cause` chain — every layer between here and the syscall (the loader's
 * entry wrapper, the mount's own diagnostic) rethrows with its own message
 * and leaves the code on the cause.
 * @param error - the failure a mount attempt threw.
 * @param depth - remaining cause links to follow; production's default reaches
 * through the loader wrapper, the aggregate, and the entry's import error.
 * @returns whether the failure is errno-transient.
 */
export function isTransientMountError(error: unknown, depth = 5): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(child => isTransientMountError(child, depth))
  }
  // The node is `unknown` here; one named projection keeps the errno probe out
  // of inline casts on every property read.
  const failure = error as { code?: unknown; cause?: unknown }
  if (typeof failure.code === 'string' && TRANSIENT_CODES[failure.code] === true) return true
  return depth > 0 && failure.cause !== undefined && isTransientMountError(failure.cause, depth - 1)
}

/**
 * One wait from the shared two-phase schedule, indexed by ATTEMPT rather than
 * by elapsed time: the first retry reads as the opening milliseconds (the
 * FAST band — a contended mount may clear in milliseconds), every later
 * retry reads past the knee (the SLOW band), because a fast wait that did not
 * buy success deserves a slower one.
 * @param attempt - the 0-based attempt that just failed.
 * @param rand - the injected random source in `[0, 1)`.
 * @returns the wait in milliseconds.
 */
export function mountBackoffWaitMs(attempt: number, rand: () => number): number {
  return jitterWaitMs(attempt === 0 ? 0 : FAST_PHASE_MS, rand)
}

/**
 * How long a recorded failure keeps answering for its preset.
 *
 * This is the cross-call half of the backoff: each fresh attempt that fails
 * again doubles the window, so an unchanged composition that keeps failing
 * stops being re-mounted on every follow-up. A composition that CHANGED never
 * consults the TTL — the stamp mismatch releases the record immediately, which
 * is what keeps "fix the file, retry now" true.
 * @param attempts - consecutive failures recorded for the preset.
 * @returns the TTL in milliseconds, capped.
 */
export function failureMemoTtlMs(attempts: number): number {
  return Math.min(MOUNT_FAILURE_TTL_CAP_MS, MOUNT_FAILURE_TTL_BASE_MS * 2 ** (attempts - 1))
}

/**
 * Run one mount attempt, waiting out a bounded jittered backoff while the
 * failure it throws is errno-transient.
 * @param operation - one full attempt; a fresh scope per call, because a
 * failed attempt disposes the scope it started with.
 * @param seams - sleep and random source.
 * @returns the first attempt's success.
 * @throws the LAST failure untouched once the attempt bound is reached or the
 * failure is not transient — fail-closed, never a quiet success.
 */
export async function withMountBackoff<T>(
  operation: () => Promise<T>,
  seams: MountBackoffSeams,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt + 1 >= MOUNT_MAX_ATTEMPTS) throw error
      if (!isTransientMountError(error)) throw error
      await seams.sleep(mountBackoffWaitMs(attempt, seams.rand))
    }
  }
}
