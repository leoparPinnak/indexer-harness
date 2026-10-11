/**
 * @deepseek-ai/dsh-cdp/dialog — plan05 JavaScript-dialog primitives: the
 * record and brief shapes, the per-session auto-answer policy, the
 * `dialog-open` guard error, and the bounded escape-safe text helpers every
 * dialog surface shares. Pure module: no transport, no service, no side
 * effects, so it is exercised without a browser.
 * @module @deepseek-ai/dsh-cdp/dialog
 */

/** CDP `Page.javascriptDialogOpening.type` values a dialog can report. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/** How one dialog was answered (or why it disappeared). */
export type DialogAnswer =
  | 'accepted'
  | 'dismissed'
  | 'auto-accepted'
  | 'auto-dismissed'
  | 'closed-externally'

/** One dialog observed on one page session. */
export interface DialogRecord {
  /** Monotonic per-session id; never reused within a session's lifetime. */
  readonly id: number
  /** Flattened session that reported the dialog. */
  readonly sessionId: string
  /** Dialog kind the protocol reported (normalized to {@link DialogType}). */
  readonly type: DialogType
  /** Bounded, sanitized message text. */
  readonly message: string
  /** Page URL reported with the dialog, bounded at {@link MAX_DIALOG_URL_CHARS}. */
  readonly url: string
  /** Reply pre-filled for `prompt` dialogs (`Page.javascriptDialogOpening.defaultPrompt`). */
  readonly defaultPrompt: string | undefined
  /** `Date.now()` when the opening event arrived; drives `ageMs`. */
  readonly openedAt: number
  /** Answer state; undefined while the dialog is still pending. */
  answered: DialogAnswer | undefined
  /** Reply text sent (or scheduled) when the dialog was accepted. */
  answerPromptText: string | undefined
}

/** Per-session auto-answer policy. Default: `{ action: 'none' }` (queue + fail-fast). */
export interface DialogPolicy {
  /** `none` queues and fails fast; `accept`/`dismiss` answer on the opening event. */
  action: 'none' | 'accept' | 'dismiss'
  /** Fixed reply for auto-accepted `prompt` dialogs; defaults to `defaultPrompt`. */
  promptText?: string | undefined
}

/**
 * JSON-safe dialog row for tool output. Carries the owning target so a
 * cross-tab list stays unambiguous (report R1: never guess the tab).
 */
export interface DialogBrief {
  /** Owning target id; empty when the registry cannot reverse-map the session. */
  readonly targetId: string
  /** Dialog kind. */
  readonly type: DialogType
  /** Bounded, sanitized, single-line-safe message text. */
  readonly message: string
  /** Page URL reported with the dialog. */
  readonly url: string
  /** Pre-filled prompt reply when one was reported; absent otherwise. */
  readonly defaultPrompt?: string
  /** Milliseconds between the opening event and this read. */
  readonly ageMs: number
  /** Answer state; absent while pending. */
  readonly answered?: DialogAnswer
}

/**
 * Thrown by the plan05 guard when a page-scoped call must fail fast because a
 * JavaScript dialog is pending (or opened mid-flight). The stable `code` is
 * what tool outputs and the guard denial reason carry.
 */
export class CdpDialogOpenError extends Error {
  /** Stable machine code shared by every guarded surface. */
  readonly code = 'dialog-open'
  /** The dialog that caused the refusal. */
  readonly dialog: DialogBrief

  /**
   * @param dialog - the pending dialog the call refused to start/continue over.
   */
  constructor(dialog: DialogBrief) {
    super(`dialog-open: a ${dialog.type} dialog is pending on ${dialog.url === '' ? '<unknown url>' : dialog.url}: ${quoteDialogText(dialog.message)}`)
    this.name = 'CdpDialogOpenError'
    this.dialog = dialog
  }
}

/** Largest dialog message text retained after {@link sanitizeDialogText}. */
export const MAX_DIALOG_MESSAGE_CHARS = 2048

/** Largest dialog URL retained on a record. */
export const MAX_DIALOG_URL_CHARS = 2048

/** Largest reply text sent back through `Page.handleJavaScriptDialog.promptText`. */
export const MAX_DIALOG_PROMPT_CHARS = 4096

/** Ring-buffer cap for a session's answered-dialog history. */
export const MAX_DIALOG_HISTORY = 20

/**
 * Tool names whose page-scoped bodies the plan05 global guard refuses while a
 * dialog is pending. Deliberately excludes browser-level tools (`cdp_status`,
 * `cdp_tabs`, `net_*`), the answerer (`cdp_dialog`), and `cdp_upload`, which
 * reports its own structured `dialog-open` envelope.
 */
export const DIALOG_GUARDED_TOOLS: ReadonlySet<string> = new Set([
  'cdp_navigate',
  'cdp_snapshot',
  'cdp_eval',
  'cdp_click',
  'cdp_type',
  'cdp_wait',
  'cdp_exec',
  // plan07: both touch a page session (register / probe), so a pending dialog
  // would answer with a stale page state.
  'cdp_stealth',
  'cdp_fingerprint',
])

/**
 * Whether a tool is guarded by the plan05 dialog guard: while a dialog is
 * pending, guarded tools refuse to run so they cannot report a stale page
 * state; only the dialog-specific tools are exempt.
 * @param name - tool name about to execute.
 * @returns whether the plan05 dialog guard applies to that tool.
 */
export function isDialogGuardedTool(name: string): boolean {
  return DIALOG_GUARDED_TOOLS.has(name)
}

/**
 * Bound and sanitize text that came from a page-controlled dialog. C0 control
 * characters (including ESC) are stripped while newline and tab survive so
 * multiline messages stay readable; a cut beyond `max` is marked, never silent.
 * @param text - raw message text from the protocol event.
 * @param max - character bound; defaults to {@link MAX_DIALOG_MESSAGE_CHARS}.
 * @returns bounded text safe to render.
 */
export function sanitizeDialogText(text: string, max: number = MAX_DIALOG_MESSAGE_CHARS): string {
  // Filtered by code point instead of a control-character regex so the source
  // itself never embeds a raw control byte: every C0 code except tab/newline/
  // carriage-return is dropped, and DEL (0x7F) goes with it.
  let cleaned = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13) cleaned += ch
    else if (code < 32 || code === 127) continue
    else cleaned += ch
  }
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max)}…[truncated]`
}

/**
 * Render untrusted dialog text as ONE line of escaped content: backslashes
 * and quotes are escaped and newline/carriage-return/tab become visible
 * escapes, so a hostile dialog cannot forge tool-output lines. Callers pass
 * already-sanitized text (see {@link sanitizeDialogText}), which removed ESC
 * and the other control characters.
 * @param text - already-sanitized dialog text.
 * @returns a single-line, double-quoted, escaped rendering.
 */
export function quoteDialogText(text: string): string {
  const single = sanitizeDialogText(text, MAX_DIALOG_MESSAGE_CHARS)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${single}"`
}

/**
 * Normalize a protocol dialog `type` into a known {@link DialogType}, so a
 * value Chromium invents later still lands in a typed record.
 * @param value - the protocol's `type` field.
 * @returns a known {@link DialogType}; unknown values normalize to `alert` so
 *   an unexpected dialog is still reported rather than dropped.
 */
export function normalizeDialogType(value: unknown): DialogType {
  return value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'alert'
}

/**
 * Build the JSON-safe output row for one record.
 * @param record - session-local dialog record.
 * @param targetId - owning target id, empty when unknown.
 * @param now - read timestamp for `ageMs` (defaults to `Date.now()`).
 * @returns the brief carried by tool outputs and errors.
 */
export function briefDialog(record: DialogRecord, targetId: string, now: number = Date.now()): DialogBrief {
  return {
    targetId,
    type: record.type,
    message: record.message,
    url: record.url,
    ageMs: Math.max(0, now - record.openedAt),
    // Optional keys are OMITTED when absent: the tool output schemas are
    // additionalProperties:false and must never see `key: undefined`.
    ...(record.defaultPrompt !== undefined ? { defaultPrompt: record.defaultPrompt } : {}),
    ...(record.answered !== undefined ? { answered: record.answered } : {}),
  }
}

/**
 * The exact denial reason the plan05 global guard returns (and the exact
 * prefix `cdp_dialog` failures reuse), so every surface teaches the same
 * recovery move.
 * @param dialog - the pending dialog.
 * @returns one line telling the model what is open and how to answer it.
 */
export function dialogDenialReason(dialog: DialogBrief): string {
  return `dialog-open: a ${dialog.type} dialog is pending on ${dialog.url === '' ? '<unknown url>' : dialog.url}: ${quoteDialogText(dialog.message)} - answer it with cdp_dialog({action:"accept"|"dismiss"})`
}
