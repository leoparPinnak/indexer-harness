/**
 * Pure live-presentation fold for one compaction: accumulates the transient
 * `compaction/live-chunk` deltas the host stream publishes while the
 * summarizer runs. Owned by the compaction chat nodes; kept pure so the fold
 * is unit-testable without a Conversation harness.
 *
 * @module
 */

import type {
  CompactionLiveLogEntry,
  CompactionLiveView,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The wire frame body carried by a `compaction/live-chunk` event's data. */
export interface CompactionLiveFrameBody {
  readonly compactionId: string
  readonly call: CompactionLiveView['call']
  readonly phase: CompactionLiveView['phase']
  readonly maxTokens: number
  readonly text?: string
  readonly reasoning?: string
}

/** Bound on the rolling stage log; oldest entries drop first. */
const LOG_LIMIT = 50

function sameCall(
  left: CompactionLiveView['call'],
  right: CompactionLiveView['call'],
): boolean {
  return left.stage === right.stage && left.index === right.index
}

/**
 * Fold one live frame into the tracked call's presentation. A frame for a NEW
 * call (stage+index) resets the text accumulators — the panel always shows the
 * outgoing request's stream, never a blend of two calls — while the stage log
 * keeps every call/phase transition so the operator can follow the run.
 * @param previous - accumulated state, or undefined before the first frame.
 * @param frame - one identity-bound live frame body.
 * @param at - Unix epoch ms stamped on a newly logged transition.
 * @returns the next accumulated state.
 */
export function foldCompactionLive(
  previous: CompactionLiveView | undefined,
  frame: CompactionLiveFrameBody,
  at: number,
): CompactionLiveView {
  const reset = previous === undefined || !sameCall(previous.call, frame.call)
  const logged: CompactionLiveLogEntry = {
    call: { ...frame.call },
    phase: frame.phase,
    at,
  }
  const phaseChanged = reset || previous.phase !== frame.phase
  const log = phaseChanged
    ? [...(previous?.log ?? []), logged].slice(-LOG_LIMIT)
    : previous?.log ?? []
  return {
    compactionId: String(frame.compactionId),
    phase: frame.phase,
    call: frame.call,
    maxTokens: frame.maxTokens,
    reasoning: (reset ? '' : previous.reasoning) + (frame.reasoning ?? ''),
    output: (reset ? '' : previous.output) + (frame.text ?? ''),
    log,
  }
}
