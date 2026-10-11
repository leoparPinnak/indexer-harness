/**
 * Pure UI fold tests for the live compaction panel feeds: status phase, raw
 * summary stream, reasoning stream, the outgoing maxTokens, the rolling stage
 * log, and the announced route/identity — plus the NEUTRAL `cancelled` row
 * (never a failure presentation).
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
    let state = foldCompactionLive(undefined, frame(), 1)
    expect(state).toMatchObject({ compactionId: 'c-1', phase: 'requested', maxTokens: 8192, output: '', reasoning: '' })

    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'Hello ', reasoning: 'think' }), 2)
    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'world', reasoning: 'ing' }), 3)
    expect(state.output).toBe('Hello world')
    expect(state.reasoning).toBe('thinking')

    // A NEW call (stage+index) resets the text accumulators: the panel always
    // tracks the outgoing request, never a blend of two calls.
    state = foldCompactionLive(state, frame({
      call: { stage: 'window', index: 1, total: 3 },
      phase: 'requested',
      maxTokens: 30720,
    }), 4)
    expect(state).toMatchObject({ output: '', reasoning: '', maxTokens: 30720, phase: 'requested' })
    expect(state.call).toEqual({ stage: 'window', index: 1, total: 3 })
  })

  it('logs every call/phase transition with its timestamp, oldest first', () => {
    let state = foldCompactionLive(undefined, frame(), 10)
    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'a' }), 20)
    // Same call, same phase: no new log row.
    state = foldCompactionLive(state, frame({ phase: 'streaming', text: 'b' }), 30)
    expect(state.log).toEqual([
      { call: { stage: 'summary', index: 0, total: null }, phase: 'requested', at: 10 },
      { call: { stage: 'summary', index: 0, total: null }, phase: 'streaming', at: 20 },
    ])

    // A new call is a transition even at the same phase.
    state = foldCompactionLive(state, frame({
      call: { stage: 'window', index: 0, total: 2 },
      phase: 'streaming',
    }), 40)
    expect(state.log).toHaveLength(3)
    expect(state.log?.[2]).toEqual({
      call: { stage: 'window', index: 0, total: 2 },
      phase: 'streaming',
      at: 40,
    })
  })

  it('bounds the stage log at the newest 50 transitions', () => {
    let state = foldCompactionLive(undefined, frame(), 0)
    for (let index = 0; index < 60; index += 1) {
      const phase = index % 2 === 0 ? 'streaming' as const : 'done' as const
      state = foldCompactionLive(state, frame({ phase }), index + 1)
    }
    expect(state.log).toHaveLength(50)
    expect(state.log?.[49]?.at).toBe(60)
  })
})

describe('compaction node status folding', () => {
  it('surfaces a RUNNING bracket from its start marker alone', () => {
    const start = match('compaction/start', {
      compactionId: 'c-1',
      turn: null,
      provider: 'prov',
      model: 'mdl',
      contextTotalTokens: 1234,
    })
    const node = compactSummary(updateCompactionState({}, start))
    expect(node.status).toBe('running')
    expect(node.compactionId).toBe('c-1')
    expect(node.provider).toBe('prov')
    expect(node.model).toBe('mdl')
    expect(node.contextTotalTokens).toBe(1234)
  })

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
    // Operator STOP binds to the durable bracket identity.
    expect(node.compactionId).toBe('c-1')
  })

  it('surfaces the media report from the summary record', () => {
    const summary = match('compaction/summary', {
      compactionId: 'c-1',
      turn: null,
      summary: [],
      shadowedSeqs: [3, 4],
      shadowedTokenCount: 10,
      provider: 'prov',
      model: 'mdl',
      replacementTokenCount: 5,
      reductionRatio: 0.5,
      media: {
        images: 3,
        imagesKept: 1,
        imagesPruned: 2,
        inlineRunsPruned: 1,
        charactersPruned: 900,
        tokensPrunedEstimate: 225,
        previews: [{
          attachmentId: 'a1',
          name: 'one.png',
          mediaType: 'image/png',
          bytes: 100,
          disposition: 'pruned',
        }],
      },
    })
    const node = compactSummary(updateCompactionState({}, summary))

    expect(node.media).toEqual({
      images: 3,
      imagesKept: 1,
      imagesPruned: 2,
      inlineRunsPruned: 1,
      charactersPruned: 900,
      tokensPrunedEstimate: 225,
      previews: [{
        attachmentId: 'a1',
        name: 'one.png',
        mediaType: 'image/png',
        bytes: 100,
        disposition: 'pruned',
      }],
    })
  })

  it('keeps failed distinct from cancelled', () => {
    const end = match('compaction/end', { compactionId: 'c-1', turn: null, error: 'boom' })
    expect(compactSummary(updateCompactionState({}, end)).status).toBe('failed')

    const stopped = match('compaction/end', { compactionId: 'c-1', turn: null, cancelled: true })
    expect(compactSummary(updateCompactionState({}, stopped)).status).toBe('cancelled')
  })
})
