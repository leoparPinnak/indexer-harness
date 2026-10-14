/**
 * Durable-shape checks for the optional operator-RESUME marker on `turn/start`:
 * backward compatible (absent everywhere on old logs) and structurally honest
 * at CREATE time via `validateSessionEventData` (positive safe-integer
 * `ofTurn`). The stricter strictly-earlier relation is enforced by the
 * append-time trace invariant (`core/session/src/invariant.ts`), whose context
 * spans the whole turn sequence.
 */

import { describe, expect, it } from 'vitest'
import { SessionId, Session, SessionSeq, type SessionEvent } from '../src/index.ts'

function freeze<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('turn/start continuation marker', () => {
  it('accepts the optional marker naming a strictly earlier turn', () => {
    const session = Session.create(SessionId('resume-marker'), [
      freeze({ seq: SessionSeq(0), time: 1, type: 'turn/start', data: { turn: 1 } }),
      freeze({ seq: SessionSeq(1), time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
      freeze({
        seq: SessionSeq(2),
        time: 3,
        type: 'turn/start',
        data: { turn: 2, continuation: { ofTurn: 1 } },
      }),
    ])
    expect(session.snapshotEvents()[2]?.data).toMatchObject({ continuation: { ofTurn: 1 } })
  })

  it('keeps logs without the marker reading unchanged (back-compat)', () => {
    const session = Session.create(SessionId('resume-marker'), [
      freeze({ seq: SessionSeq(0), time: 1, type: 'turn/start', data: { turn: 1 } }),
    ])
    expect(session.snapshotEvents()[0]?.data).toEqual({ turn: 1 })
  })

  it('rejects a marker whose owner turn is not a safe integer', () => {
    expect(() => Session.create(SessionId('resume-marker'), [
      freeze({ seq: SessionSeq(0), time: 1, type: 'turn/start', data: { turn: 2, continuation: { ofTurn: 'one' } } }) as unknown as SessionEvent,
    ])).toThrow(/continuation\.ofTurn/u)
  })

  it('rejects a marker that is not an object with a numeric ofTurn', () => {
    expect(() => Session.create(SessionId('resume-marker'), [
      freeze({ seq: SessionSeq(0), time: 1, type: 'turn/start', data: { turn: 2, continuation: true } }) as unknown as SessionEvent,
    ])).toThrow(/continuation\.ofTurn/u)
  })
})
