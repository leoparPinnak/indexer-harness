/**
 * Head/tail envelope rows for a spilled result: a totals receipt first, the
 * retained head and tail after it, and the deterministic truncation marker
 * between them.
 *
 * The receipt keeps the totals the bounded preview cannot show — the same
 * `spill: { … }` receipt convention the `cdp` spill writers established for
 * structured results (`spill: { chars }`, `spill: { rows }`), restated here as
 * text because a tool result the policy bounds is a text block. This module
 * renders rows only: it owns no storage (that is `ctx.spillStore`) and no notice
 * vocabulary (that is `./notice.ts`).
 *
 * The wording is deterministic — a pure function of the totals and the budget —
 * so a recorded envelope can be recognized and re-rendered byte for byte.
 *
 * @module @deepseek-ai/dsh-spill-policy/envelope
 */

/** The totals the receipt row prints about the FULL result. */
export interface SpillReceiptTotals {
  /** Characters in the full result. */
  chars: number
  /** UTF-8 bytes in the full result. */
  bytes: number
}

/** Totals a spill envelope preserves about the FULL result behind a bounded preview. */
export interface SpillEnvelopeTotals extends SpillReceiptTotals {
  /** The retention budget that triggered the spill, in UTF-8 bytes. */
  limit: number
}

/**
 * The receipt row: totals of the full result, preserved verbatim so a head/tail
 * preview still reports the whole.
 *
 * @param totals - the full result's character and byte totals.
 * @returns the first envelope row.
 */
export function formatSpillReceipt(totals: SpillReceiptTotals): string {
  return `spill: { chars: ${totals.chars}, bytes: ${totals.bytes} }`
}

/**
 * The truncation marker standing between the retained head and tail rows.
 *
 * @param limit - the retention budget, in UTF-8 bytes, that cut the result.
 * @returns the marker row.
 */
export function formatTruncationMarker(limit: number): string {
  return `[truncated after ${limit} bytes]`
}

/**
 * Compose the model-facing envelope: receipt row, retained head, truncation
 * marker, retained tail. An empty end drops its row (a zero preview budget
 * leaves the receipt alone); the marker appears only when a real gap separates
 * head from tail.
 *
 * @param input - the full result's totals plus the retained head and tail text.
 * @returns the complete envelope without the notice that follows it.
 */
export function renderSpillEnvelope(input: SpillEnvelopeRender): string {
  const parts = [formatSpillReceipt(input.totals)]
  if (input.head.length > 0) parts.push(input.head)
  if (input.tail.length > 0) {
    if (input.head.length > 0) parts.push(formatTruncationMarker(input.totals.limit))
    parts.push(input.tail)
  }
  return parts.join('\n')
}

/** Inputs to {@link renderSpillEnvelope}. */
export interface SpillEnvelopeRender {
  /** Totals of the full result. */
  totals: SpillEnvelopeTotals
  /** Retained head text (possibly empty). */
  head: string
  /** Retained tail text (possibly empty). */
  tail: string
}
