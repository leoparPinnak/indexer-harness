/**
 * Operator RESUME availability fold — the ONE verdict both the Host guard and
 * the client button read. Test names carry the vocabulary explicitly: the
 * checkpoint is the last COMPLETED request; a severed request's finalized
 * prefix is HISTORY (`assistant/message {interrupted: true}`), never a
 * completed answer.
 */

import { describe, expect, it } from 'vitest'
import { evaluateResumeState } from '../src/resume-state.ts'
import type { ResumeStateEvent } from '../src/resume-state.ts'

function turnStart(turn: number, continuation?: { ofTurn: number }): ResumeStateEvent {
  return { type: 'turn/start', data: { turn, ...(continuation === undefined ? {} : { continuation }) } }
}

function turnEnd(turn: number, kind: string): ResumeStateEvent {
  return { type: 'turn/end', data: { turn, reason: { kind } } }
}

function answer(turn: number, step: number, interrupted?: true): ResumeStateEvent {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      ...(interrupted === undefined ? {} : { interrupted }),
      message: { content: [{ type: 'text', text: 'answer' }] },
    },
  }
}

describe('evaluateResumeState', () => {
  it('is READY after an aborted turn with a completed request before the cut', () => {
    const state = evaluateResumeState([
      turnStart(1), answer(1, 1), turnEnd(1, 'completed'),
      turnStart(2), answer(2, 1), turnEnd(2, 'aborted'),
    ])
    expect(state).toEqual({ kind: 'ready', checkpoint: { turn: 2, step: 1 } })
  })

  it('counts the SEVERED PREFIX as history, not as a completed answer', () => {
    // Turn 2's request was cut mid-stream: its finalized prefix is
    // `interrupted: true` — the checkpoint must stay the earlier completed
    // request (turn 1/step 1), never the severed one.
    const state = evaluateResumeState([
      turnStart(1), answer(1, 1), turnEnd(1, 'completed'),
      turnStart(2), answer(1, 1), answer(2, 1, true), turnEnd(2, 'aborted'),
    ])
    expect(state).toEqual({ kind: 'ready', checkpoint: { turn: 1, step: 1 } })
  })

  it('is NO-CHECKPOINT when the cut precedes any completed request', () => {
    const withSeveredOnly = evaluateResumeState([
      turnStart(1), answer(1, 1, true), turnEnd(1, 'aborted'),
    ])
    expect(withSeveredOnly).toEqual({ kind: 'no-checkpoint' })
    expect(evaluateResumeState([turnStart(1), turnEnd(1, 'error')])).toEqual({ kind: 'no-checkpoint' })
  })

  it('is BUSY while a turn is open', () => {
    expect(evaluateResumeState([turnStart(1), answer(1, 1)])).toEqual({ kind: 'busy' })
  })

  it('is NOT-CUT after a normally ended turn or with no turn at all', () => {
    expect(evaluateResumeState([])).toEqual({ kind: 'not-cut' })
    expect(evaluateResumeState([turnStart(1), answer(1, 1), turnEnd(1, 'completed')]))
      .toEqual({ kind: 'not-cut' })
    expect(evaluateResumeState([turnStart(1), turnEnd(1, 'max-tokens')])).toEqual({ kind: 'not-cut' })
    // Crash recovery's `interrupted` closer is history repair, not a resumable cut.
    expect(evaluateResumeState([turnStart(1), turnEnd(1, 'interrupted')])).toEqual({ kind: 'not-cut' })
  })

  it('accepts the optional continuation marker without changing the verdict', () => {
    const state = evaluateResumeState([
      turnStart(1), answer(1, 1), turnEnd(1, 'aborted'),
      turnStart(2, { ofTurn: 1 }), answer(2, 1), turnEnd(2, 'aborted'),
    ])
    expect(state).toEqual({ kind: 'ready', checkpoint: { turn: 2, step: 1 } })
  })
})
