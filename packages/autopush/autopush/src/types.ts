/**
 * The auto-push domain's shared types: the two session events and the projection
 * that carries them to the composer dashboard.
 *
 * `enabled` is a logged, whole-value fact rather than host memory, so the
 * instruction the model reads and the toggle the reader clicks are the same
 * value replayed from the log. `push` records one completed push; the log keeps
 * every one of them and the wire view carries the newest few.
 *
 * @module @deepseek-ai/dsh-autopush/types
 */

import type { ProjectPushRecord } from './project-history.ts'

/** One completed push, as the dashboard lists it. */
export interface PushRecord {
  /** Wall-clock time of the push, in milliseconds since the epoch. */
  readonly at: number
  /** The Turkish description the commit carried. */
  readonly message: string
  /** Short commit id that was pushed. */
  readonly sha: string
  /** Files the commit included; `0` when an existing commit was pushed as-is. */
  readonly files: number
  /** Remote the push went to. */
  readonly remote: string
  /** Branch the push went to. */
  readonly branch: string
}

/**
 * The `autopush` projection's wire value.
 *
 * `count` counts every push in the log, `lastAt` is the newest push's time, and
 * `history` is newest first. Capability absence (this plugin not composed) is
 * the key's absence, never a value.
 */
export interface AutoPushProjection {
  /** Whether the session's auto-push toggle is on. */
  enabled: boolean
  /** Pushes recorded in this session. */
  count: number
  /** Newest push time, or null when nothing was pushed yet. */
  lastAt: number | null
  /** The newest pushes first, at most {@link HISTORY_LIMIT} of them. */
  history: readonly PushRecord[]
  /** Project-level push history across all sessions in this workspace. */
  projectHistory: readonly ProjectPushRecord[]
}

/** How many pushes the wire view carries; the log keeps every one. */
export const HISTORY_LIMIT = 50

/** Host state used to derive {@link AutoPushProjection}. */
export interface AutoPushUnitState {
  /** Logged toggle. */
  enabled: boolean
  /** Newest pushes first, trimmed to {@link HISTORY_LIMIT}. */
  history: readonly PushRecord[]
  /** Pushes recorded in this session, including any trimmed from `history`. */
  count: number
  /** Project-level push history across all sessions in this workspace. */
  projectHistory: readonly ProjectPushRecord[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether auto-push is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `autopush/mode` wins; a log with none folds
     * to off.
     */
    'autopush/mode': { enabled: boolean }
    /**
     * One completed push: log-only, non-surface, append-only. The projection
     * counts these and shows the newest first, so a restored session lists the
     * pushes it made.
     */
    'autopush/push': PushRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host auto-push fold state. */
    autopush: AutoPushUnitState
  }
  interface SessionProjectionMap {
    /** Auto-push toggle and push history folded from the session log. */
    autopush: AutoPushProjection
  }
}
