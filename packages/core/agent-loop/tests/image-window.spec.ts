import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { keepLatestImagesOf } from '../src/agent.ts'

const session = { id: SessionId('window-unit') } as never

describe('session keep-newest-N image window', () => {
  it('reads keepLatestImages from the compaction policy projection', () => {
    const projections = {
      stateOf: (_s: never, key: string) => (key === 'compactionPolicy' ? { keepLatestImages: 3 } : undefined),
    }
    expect(keepLatestImagesOf(session, projections)).toBe(3)
    // `0` is the mode validator's "replay no images" window and must survive.
    const zero = {
      stateOf: (_s: never, key: string) => (key === 'compactionPolicy' ? { keepLatestImages: 0 } : undefined),
    }
    expect(keepLatestImagesOf(session, zero)).toBe(0)
  })

  it('degrades to the route default when the projection or field is absent', () => {
    expect(keepLatestImagesOf(session, undefined)).toBeUndefined()
    expect(keepLatestImagesOf(session, { stateOf: () => undefined })).toBeUndefined()
    expect(keepLatestImagesOf(session, { stateOf: () => ({}) })).toBeUndefined()
    // A foreign projection shape never smuggles a bogus window onto requests.
    expect(keepLatestImagesOf(session, { stateOf: () => ({ keepLatestImages: 'three' }) })).toBeUndefined()
  })
})
