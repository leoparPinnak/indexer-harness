/**
 * Operator RESUME availability — one pure fold over the durable journal shape,
 * shared by the Host guard and the client button so both speak ONE verdict.
 *
 * Vocabulary (documented in the tests' names):
 * - RESUME CHECKPOINT: the last COMPLETED model request — its
 *   `assistant/message` WITHOUT `interrupted`. That request returned 200 OK and
 *   the model closed it with an answer.
 * - SEVERED PREFIX: a cut request's delivered text/reasoning, finalized into
 *   the journal as `assistant/message {interrupted: true}`. It is HISTORY (it
 *   replays into the rebuilt context as past content) and NEVER counts as a
 *   completed answer.
 * - CUT TURN: the newest closed turn whose `turn/end` reason kind is
 *   `aborted` (operator/parent/hook stop) or `error` (failure) — the two ways a
 *   flow severs mid-air. A `completed`/`max-tokens`/`blocked` close is not
 *   cut, and the crash-recovery `interrupted` closer is history repair, not an
 *   operator-resumable cut.
 *
 * @module
 */

/** The completed model request a resume re-drives from. */
export interface ResumeCheckpoint {
  /** Turn owning the checkpoint request. */
  readonly turn: number
  /** Step of that turn whose completed answer is the checkpoint. */
  readonly step: number
}

/** Why an operator resume would (or would not) run right now. */
export type ResumeState =
  | { readonly kind: 'ready'; readonly checkpoint: ResumeCheckpoint }
  /** A turn is open right now — the agent is not idle. */
  | { readonly kind: 'busy' }
  /** The newest closed turn was not cut; there is nothing to resume. */
  | { readonly kind: 'not-cut' }
  /** The flow is cut, but no completed request precedes the cut. */
  | { readonly kind: 'no-checkpoint' }

/** Structural journal event slice the fold needs (Host `SessionEvent`, client mirrors). */
export interface ResumeStateEvent {
  readonly type: string
  readonly data: unknown
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Evaluate operator-resume availability over journal events in order.
 * @param events - durable events in ascending order (turn/step boundaries,
 *   assistant settlements; other types are ignored).
 * @returns the single honest verdict; `ready` carries the checkpoint.
 */
export function evaluateResumeState(
  events: Iterable<ResumeStateEvent>,
): ResumeState {
  let openTurn: number | null = null
  let cutTurn: number | null = null
  let settledTurn: number | null = null
  let checkpoint: ResumeCheckpoint | null = null
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'turn/start') {
      openTurn = typeof data['turn'] === 'number' ? data['turn'] : null
    } else if (event.type === 'turn/end') {
      openTurn = null
      settledTurn = typeof data['turn'] === 'number' ? data['turn'] : null
      const reason = record(data['reason'])
      cutTurn = reason['kind'] === 'aborted' || reason['kind'] === 'error' ? settledTurn : null
    } else if (event.type === 'assistant/message') {
      const message = record(data['message'])
      const interrupted = data['interrupted'] === true
      if (!interrupted
        && Array.isArray(message['content'])
        && message['content'].length > 0
        && typeof data['turn'] === 'number'
        && typeof data['step'] === 'number') {
        checkpoint = { turn: data['turn'], step: data['step'] }
      }
    }
  }
  if (openTurn !== null) return { kind: 'busy' }
  if (cutTurn === null || cutTurn !== settledTurn) return { kind: 'not-cut' }
  if (checkpoint === null) return { kind: 'no-checkpoint' }
  return { kind: 'ready', checkpoint }
}
