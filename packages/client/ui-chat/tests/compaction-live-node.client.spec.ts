/**
 * Pure UI fold tests for the live compaction panel feeds: status phase, raw
 * summary stream, reasoning stream, and the outgoing maxTokens — plus the
 * NEUTRAL `cancelled` row (never a failure presentation).
 */

import { describe, expect, it } from 'vitest'
import type { ConversationMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { foldCompactionLive } from '../src/client/conversation-nodes/compaction-live-state.ts'
import {
  compactSummary,
  updateCompactionState,
} from '../src/client/conversation-nodes/command.ts'

function frame(overrides: Partial<Parameters<typeof foldCompactionLive>[1]> = {}) {
  return {
    compactionId: 'c-1',
    call: { stage: 'summary' as const, index: 0, total: null },
    phase: 'requested' as const,
    maxTokens: 8192,
    ...overrides,
  }
}

function match(type: string, data: unknown): ConversationMatch {
  return { event: { type, seq: 1, time: 1, data } } as unknown as ConversationMatch
}

describe('compaction live panel fold', () => {
  it('accumulates output and reasoning per call and resets on a new call', () => {
    let state = foldCompactionLive(undefined, frame())
    expect(state).toMatchObject({ compactionId: 'c-1', phase: 'requested', maxTokens: 8192, output: '', reasoning: '' })

    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'Hello ', reasoning: 'think' }))
    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'world', reasoning: 'ing' }))
    expect(state.output).toBe('Hello world')
    expect(state.reasoning).toBe('thinking')

    // A NEW call (stage+index) resets the text accumulators: the panel always
    // tracks the outgoing request, never a blend of two calls.
    state = foldCompactionLive(state, frame({
      call: { stage: 'window', index: 1, total: 3 },
      phase: 'requested',
      maxTokens: 30720,
    }))
    expect(state).toMatchObject({ output: '', reasoning: '', maxTokens: 30720, phase: 'requested' })
    expect(state.call).toEqual({ stage: 'window', index: 1, total: 3 })
  })
})

describe('compaction node status folding', () => {
  it('feeds live frames into the view node and closes the row NEUTRALLY on cancelled', () => {
    const live = match('compaction/live-chunk', frame({ phase: 'streaming', text: 'partial' }))
    const end = match('compaction/end', { compactionId: 'c-1', turn: null, cancelled: true })
    let state = updateCompactionState({}, live)
    state = updateCompactionState(state, end)
    const node = compactSummary(state)

    // Panel feeds: status, stream, and (via live) maxTokens.
    expect(node.live).toMatchObject({ phase: 'streaming', output: 'partial', maxTokens: 8192 })
    // Neutral close: `cancelled` status — never `failed`, never an error row.
    expect(node.status).toBe('cancelled')
  })

  it('keeps failed distinct from cancelled', () => {
    const end = match('compaction/end', { compactionId: 'c-1', turn: null, error: 'boom' })
    expect(compactSummary(updateCompactionState({}, end)).status).toBe('failed')

    const stopped = match('compaction/end', { compactionId: 'c-1', turn: null, cancelled: true })
    expect(compactSummary(updateCompactionState({}, stopped)).status).toBe('cancelled')
  })
})
