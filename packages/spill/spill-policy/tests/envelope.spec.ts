/**
 * Specs for the spill envelope rows: the totals receipt, the deterministic
 * truncation marker, and the head/tail composition the policy places above the
 * budget notice.
 */

import { describe, expect, it } from 'vitest'
import { formatSpillReceipt, formatTruncationMarker, renderSpillEnvelope } from '../src/envelope.ts'

const totals = { chars: 1600, bytes: 3015, limit: 200 }

describe('spill receipt row', () => {
  it('preserves the full result totals verbatim', () => {
    expect(formatSpillReceipt({ chars: 1600, bytes: 3015 })).toBe('spill: { chars: 1600, bytes: 3015 }')
  })

  it('prints zero totals without special-casing them', () => {
    expect(formatSpillReceipt({ chars: 0, bytes: 0 })).toBe('spill: { chars: 0, bytes: 0 }')
  })
})

describe('truncation marker', () => {
  it('derives its wording deterministically from the budget', () => {
    expect(formatTruncationMarker(200)).toBe('[truncated after 200 bytes]')
    expect(formatTruncationMarker(0)).toBe('[truncated after 0 bytes]')
  })
})

describe('renderSpillEnvelope', () => {
  it('orders receipt, head, marker, tail', () => {
    expect(renderSpillEnvelope({ totals, head: 'HEADTEXT', tail: 'TAILTEXT' })).toBe(
      'spill: { chars: 1600, bytes: 3015 }\nHEADTEXT\n[truncated after 200 bytes]\nTAILTEXT')
  })

  it('drops the marker when the tail row is absent', () => {
    expect(renderSpillEnvelope({ totals, head: 'HEADTEXT', tail: '' })).toBe(
      'spill: { chars: 1600, bytes: 3015 }\nHEADTEXT')
  })

  it('keeps a tail-only envelope whole without inventing a marker', () => {
    expect(renderSpillEnvelope({ totals, head: '', tail: 'TAILTEXT' })).toBe(
      'spill: { chars: 1600, bytes: 3015 }\nTAILTEXT')
  })

  it('renders the bare receipt when no preview bytes fit', () => {
    expect(renderSpillEnvelope({ totals, head: '', tail: '' })).toBe('spill: { chars: 1600, bytes: 3015 }')
  })

  it('is a pure function of its inputs (same totals and ends render byte-identically)', () => {
    const first = renderSpillEnvelope({ totals, head: 'h', tail: 't' })
    const second = renderSpillEnvelope({ totals, head: 'h', tail: 't' })
    expect(second).toBe(first)
  })
})
