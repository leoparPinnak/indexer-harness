/** Browser-safe formatting and recognition of persisted spill-policy notices. */
import { describeOmitted, type Omitted } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'

const OPEN = '('
const CLOSE = ')'
const LOCATION = ' Full formatted result stored at: '
const GUIDANCE_SEPARATOR = '. '
const SEPARATOR = '\n\n'
/**
 * Tag marking the notice as a budget outcome: a retention budget truncated the
 * result and persisted the full text away. Every formatted notice carries it;
 * recognition also accepts the untagged spelling recorded by earlier releases,
 * so sessions persisted before the tag stay renderable without rewriting.
 */
const BUDGET_TAG = '[budget notice] '
const EXACT_OMISSION = describeOmitted({ kind: 'exact', count: 0 }, 'bytes')
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0')
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1)

/**
 * Format the notice appended to a retained preview, preserving its persisted spelling.
 * The `[budget notice]` tag states that a budget — not a tool failure — truncated
 * the result and persisted the full text away.
 * @param omitted - bytes omitted by the retention policy.
 * @param ref - saved text locator and retrieval guidance.
 * @returns the complete notice without a leading preview separator.
 */
export function formatSpillNotice(omitted: Omitted, ref: Pick<SpillRef, 'locator' | 'retrievalHint'>): string {
  return `${BUDGET_TAG}${OPEN}${describeOmitted(omitted, 'bytes')}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`
}

function isOmission(text: string): boolean {
  if (text === describeOmitted({ kind: 'none' }, 'bytes')
    || text === describeOmitted({ kind: 'unknown' }, 'bytes')) return true
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length))
  return Number.isSafeInteger(count) && count >= 0
    && text === describeOmitted({ kind: 'exact', count }, 'bytes')
}

/** Whether a complete final notice body starts at `start`, tagged (current) or untagged (recorded by earlier releases). */
function isNoticeAt(text: string, start: number): boolean {
  const tagged = text.startsWith(BUDGET_TAG, start)
  const body = tagged ? start + BUDGET_TAG.length : start
  if (!text.startsWith(OPEN, body)) return false
  const location = text.indexOf(LOCATION, body + OPEN.length)
  if (location < 0) return false
  if (!isOmission(text.slice(body + OPEN.length, location))) return false
  return text.indexOf(GUIDANCE_SEPARATOR, location + LOCATION.length) >= 0
}

/** Earliest notice-marker boundary at or after `start`, preferring the tagged form on a tie. */
function nextMarker(text: string, start: number): number {
  const tagged = text.indexOf(`${SEPARATOR}${BUDGET_TAG}${OPEN}`, start)
  const plain = text.indexOf(`${SEPARATOR}${OPEN}`, start)
  if (tagged < 0) return plain
  if (plain < 0) return tagged
  return Math.min(tagged, plain)
}

/**
 * Recognize a final spill-policy notice in persisted text, including notice-only output.
 * Both the tagged and the earlier untagged spelling are recognized, so a recorded
 * result keeps its presentation across the vocabulary change.
 * This identifies the text convention, not authenticated provenance of tool output.
 * @param text - complete recorded text result.
 * @returns whether a complete notice occupies the end of the result.
 */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(CLOSE)) return false
  let start = 0
  while (true) {
    const next = nextMarker(text, start)
    if (isNoticeAt(text, start)) return true
    if (next < 0) return false
    start = next + SEPARATOR.length
  }
}
