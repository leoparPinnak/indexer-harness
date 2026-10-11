/**
 * Retained historical log vocabulary: `shellbox/change` and `shellbox/ack` were
 * committed to durable session logs by the Shellbox deamon bundle before that
 * feature was retired from the product on 2026-10-01 (extracted into
 * `protop/shellbox/` — see `.agents/notes/implemented/simplification/2026-10-01-shellbox-retired-to-protop.md`).
 * Both are log-only, non-surface records: neither reconstructs chat content nor
 * carries a surface operation, and the only cursor they hold (`shellbox/ack`'s
 * `throughSeq`) is meaningful solely to the retired feature.
 *
 * Why this file exists instead of letting the names go: the persistence read
 * path (see `storage-contract.ts`) refuses to interpret a log whose event type
 * is outside `KNOWN_SESSION_EVENT_TYPES` and not marked `ignorable` — and the
 * Shellbox producer deliberately committed these events WITHOUT `ignorable`.
 * Dropping the declarations would therefore make every pre-retirement session
 * that used Shellbox unreadable in all later builds. Keeping the declarations
 * (as pure type merges with no producer anywhere) keeps that corpus
 * interpretable while keeping the "unknown and not ignorable" guard intact for
 * genuinely foreign logs.
 *
 * Payload shapes are copied verbatim from the retired producer's wire types
 * (`protop/shellbox/deamon/src/types.ts`) so restored records type-check
 * against their historical form.
 *
 * Removal condition: retire these declarations only together with an explicit
 * corpus migration (either a released-format edge for pre-retirement logs or an
 * in-place `ignorable: true` retrofit of their `shellbox/*` events), or once no
 * supported installation can hold pre-2026-10-01 logs. Until then this is the
 * single sanctioned home of the retired names.
 *
 * @module @deepseek-ai/dsh-session-persistence/retained-log-vocabulary
 */

/** The kinds of desktop change the retired bridge recorded. */
export type ShellboxChangeKind =
  | 'window-opened'
  | 'window-closed'
  | 'window-title'
  | 'window-focused'
  | 'process-started'
  | 'process-exited'
  | 'desktop-reset'

/** Structured desktop change retained in the retired controller ring. */
export interface ShellboxChange {
  /** Detection time in epoch milliseconds, assigned at ingest. */
  time: number
  /** What changed on the desktop. */
  kind: ShellboxChangeKind
  /** Desktop instance the change belongs to. */
  instanceId: string
  /** Win32 desktop name of that instance. */
  desktop: string
  /** Affected window handle, when the change names one window. */
  windowId?: number
  /** Window title at detection (user data, never localized). */
  title?: string
  /** Owning process id, when known. */
  processId?: number
  /** Executable file name, when known. */
  process?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One committed batch of Shellbox desktop changes — log-only, non-surface; this event's seq is the model-visible change cursor.
     * @param session - session key the desktops are bound to
     * @param instanceId - desktop instance the batch was ingested from
     * @param firstRingId - lowest ring id represented in this batch
     * @param lastRingId - highest ring id represented in this batch
     * @param count - total changes represented; exceeds `changes.length` when detail overflowed
     * @param kinds - distinct change kinds present in the batch
     * @param changes - bounded detail, at most 50 entries
     * @param overflow - present when batch detail was truncated at commit
     */
    'shellbox/change': {
      session: string
      instanceId: string
      firstRingId: number
      lastRingId: number
      count: number
      kinds: string[]
      changes: ShellboxChange[]
      overflow?: true
    }
    /**
     * A `shellbox_state` read accepted changes through `throughSeq` — log-only, non-surface.
     * @param session - session key whose dirty flag this ack advances
     * @param throughSeq - seq of the newest `shellbox/change` event the model has read
     * @param throughRingId - highest ring id covered by the completed read, the next default `since` cursor
     */
    'shellbox/ack': {
      session: string
      throughSeq: number
      throughRingId: number
    }
  }
}
