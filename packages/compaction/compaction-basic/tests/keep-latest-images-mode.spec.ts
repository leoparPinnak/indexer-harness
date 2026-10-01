/**
 * One-line carrier verification for the dynamic visual window: a
 * `setCompactionMode({keepLatestImages: N})` write folds into
 * `compactionPolicy` state under the shared contract name the pricing
 * consumers read (`stateOf(session,'compactionPolicy')?.keepLatestImages`).
 */

import { describe, expect, it } from 'vitest'
import { setCompactionMode } from '@deepseek-ai/dsh-compaction'
import { compactionPolicyProjection } from '@deepseek-ai/dsh-compaction-basic/src/policy-projection.ts'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

describe('keepLatestImages mode carrier', () => {
  it('mirrors a mode write into the compactionPolicy state fold', () => {
    const projection = compactionPolicyProjection(() => resolveConfig({}))
    const session = Session.create(SessionId('keep-latest-images'))
    setCompactionMode(session, { summarizer: 'conversation', keepLatestImages: 3 })
    let state = projection.init(session.header, session.inheritedEventCount)
    const foldAll = (): void => {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; test assertion.
      for (const event of session.snapshotEvents() as readonly SessionEvent[]) state = projection.apply(state, event)
    }
    foldAll()
    expect(state.keepLatestImages).toBe(3)
    // A whole-value write without the window clears the older mirror: the
    // next request falls back to the route's own window.
    setCompactionMode(session, { summarizer: 'conversation' })
    foldAll()
    expect(state.keepLatestImages).toBeUndefined()
  })
})
