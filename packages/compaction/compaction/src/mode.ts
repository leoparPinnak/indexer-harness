/**
 * Per-session compaction mode: THE write path and its value guard. The read
 * side is the `compactionPolicy` session projection (registered by the
 * compaction backend), never a history scan — synchronous history reads are
 * deprecated (2026-09-09 deprecation note).
 *
 * @module @deepseek-ai/dsh-compaction/mode
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionSessionMode } from './types.ts'

/** Whether one untrusted token figure is absent or a positive safe integer. */
function isTokenBudget(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
}

/**
 * Whether one untrusted visual-window figure is absent or a non-negative safe
 * integer (`0` replays no images; `N` keeps the newest N).
 */
function isImageWindow(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

/**
 * Whether one untrusted value is a complete, self-consistent
 * {@link CompactionSessionMode} — wire- and durable-boundary validation
 * before a write is accepted.
 * @param value - candidate payload.
 * @returns true when the value names a valid summarizer route and valid
 *   optional token figures.
 */
export function isCompactionSessionMode(value: unknown): value is CompactionSessionMode {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!isTokenBudget(candidate.contextBudgetTokens)
    || !isTokenBudget(candidate.thresholdTokens)
    || !isTokenBudget(candidate.maxTokens)
    || !isImageWindow(candidate.keepLatestImages)) {
    return false
  }
  if (candidate.summarizer === 'conversation') {
    return candidate.provider === undefined && candidate.model === undefined
  }
  return candidate.summarizer === 'dedicated'
    && typeof candidate.provider === 'string'
    && candidate.provider.length > 0
    && typeof candidate.model === 'string'
    && candidate.model.length > 0
}

/**
 * THE write path for a session's compaction mode: appends exactly one
 * `compaction/mode` whole-value-replace event — the switch IS its event, and
 * the last such event is the session's mode. It takes effect on the session's
 * next compaction; consumers read the `compactionPolicy` projection.
 * @param session - the session the mode belongs to.
 * @param mode - complete next mode value.
 * @throws TypeError when `mode` fails {@link isCompactionSessionMode}.
 */
export function setCompactionMode(session: Session, mode: CompactionSessionMode): void {
  if (!isCompactionSessionMode(mode)) {
    throw new TypeError('compaction: invalid session compaction mode')
  }
  session.append('compaction/mode', mode)
}
