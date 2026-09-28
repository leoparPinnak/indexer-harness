/**
 * Shared Shellbox input, window-state, and change-awareness wire types.
 * This file contains types only; runtime constants live beside their owners.
 *
 * @module
 */

/** One input event accepted by `POST /api/server/sandbox/input` and the helper spool grammar. */
export type ShellboxInputEvent =
  | { readonly t: 'move'; readonly x: number; readonly y: number }
  | { readonly t: 'button'; readonly b: 'left' | 'right' | 'middle'; readonly p: 'down' | 'up' }
  | { readonly t: 'wheel'; readonly dx: number; readonly dy: number }
  | { readonly t: 'key'; readonly vk: number; readonly p: 'down' | 'up' }
  | { readonly t: 'char'; readonly c: number }

/** One visible window as reported by the helper's `.state` snapshot. */
export interface ShellboxWindowInfo {
  /** Window handle, stable while the window lives on the desktop. */
  readonly hwnd: number
  /** Owning process id. */
  readonly pid: number
  /** Window title text (user data, never localized). */
  readonly title: string
  /** Executable file name, e.g. `notepad.exe`; empty when unknown. */
  readonly exe: string
  /** Window rect left edge in desktop physical pixels. */
  readonly x: number
  /** Window rect top edge in desktop physical pixels. */
  readonly y: number
  /** Window rect width in physical pixels. */
  readonly w: number
  /** Window rect height in physical pixels. */
  readonly h: number
}

/** Full desktop snapshot the helper writes to `<commandFile>.state`. */
export interface ShellboxStateSnapshot {
  /** Monotonic snapshot generation counter within one helper run. */
  readonly gen: number
  /** Snapshot time in epoch milliseconds. */
  readonly time: number
  /** hwnd of the tracked subject window, or `0` when no subject is tracked. */
  readonly subject: number
  /** Visible windows currently on the desktop. */
  readonly windows: readonly ShellboxWindowInfo[]
}

/** Structured desktop change retained in a controller ring. */
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

/** The kinds of desktop change the bridge records. */
export type ShellboxChangeKind =
  | 'window-opened'
  | 'window-closed'
  | 'window-title'
  | 'window-focused'
  | 'process-started'
  | 'process-exited'
  | 'desktop-reset'

/** Result of queuing one input batch: accepted for delivery, or refused with an HTTP-mappable status. */
export type ShellboxInputResult =
  | { readonly ok: true; readonly accepted: number; readonly delivered: boolean }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** Result of one spooled window action: accepted for delivery to the helper. */
export interface ShellboxWindowActionResult {
  /** Always `true` on a successful action. */
  readonly ok: true
  /** Whether the action line reached the helper's input spool. */
  readonly delivered: boolean
}

/** Response of `GET /api/server/sandbox/windows` — the helper's latest window snapshot metadata plus rows. */
export interface ShellboxWindowsResponse {
  /** Always `true` on a successful read. */
  readonly ok: true
  /** Whether the desktop helper is currently running. */
  readonly active: boolean
  /** Whether the `.state` snapshot exists and is recent (age under 2 seconds). */
  readonly fresh: boolean
  /** Visible windows from the latest snapshot, empty when unavailable. */
  readonly windows: readonly ShellboxWindowInfo[]
}

/** A ring entry with its process-unique ring id used for GUI pagination. */
export interface ShellboxRingEntry extends ShellboxChange {
  /** Monotonic ingest id, unique across every ring in one bridge process. */
  id: number
}

/** Response of `GET /api/server/sandbox/changes` — a pure read that never advances the model's ack cursor. */
export interface ShellboxChangesResponse {
  /** Always `true` on a successful read. */
  readonly ok: true
  /** Resolved session key the read was scoped to. */
  readonly session: string
  /** Instance filter that was applied, or `'all'` for every desktop bound to the session. */
  readonly instanceId: string
  /** Whether at least one filtered desktop helper is currently running. */
  readonly active: boolean
  /** Highest ring id currently retained for the filtered desktops. */
  readonly ringCursor: number
  /** Echo of the requested `since` cursor. */
  readonly since: number
  /** Echo of the requested page limit. */
  readonly limit: number
  /** Whether more changes remain after this page. */
  readonly hasMore: boolean
  /** Whether ring retention dropped detail older than this page. */
  readonly truncated: boolean
  /** Matching changes in ascending ring-id order. */
  readonly changes: readonly ShellboxRingEntry[]
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
