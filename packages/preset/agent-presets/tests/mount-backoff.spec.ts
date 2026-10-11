/**
 * The mount seam's bounded jittered backoff: the shared two-phase schedule,
 * the errno gate that decides whether a wait is worth making, and the
 * fail-closed end of the retry loop.
 */
import { describe, expect, it } from 'vitest'
import {
  FAST_JITTER_MAX_MS, FAST_JITTER_MIN_MS, SLOW_JITTER_MAX_MS, SLOW_JITTER_MIN_MS,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  failureMemoTtlMs, isTransientMountError, MOUNT_FAILURE_TTL_BASE_MS, MOUNT_FAILURE_TTL_CAP_MS,
  MOUNT_MAX_ATTEMPTS, mountBackoffWaitMs, withMountBackoff, type MountBackoffSeams,
} from '../src/mount-backoff.ts'

/** Seams that record each wait instead of living it, with a pinned rand. */
function recordingSeams(randValue = 0): MountBackoffSeams & { waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => { waits.push(ms) },
    rand: () => randValue,
  }
}

const transient = () => Object.assign(new Error('contended'), { code: 'EBUSY' })

describe('the mount backoff schedule', () => {
  it('reads the first retry as the FAST band and every later one as the SLOW band', () => {
    // Both bands are retry-jitter's own: the mount seam projects an attempt
    // index onto the schedule rather than inventing a second one.
    expect(mountBackoffWaitMs(0, () => 0)).toBe(FAST_JITTER_MIN_MS)
    expect(mountBackoffWaitMs(0, () => 0.999)).toBe(FAST_JITTER_MAX_MS)
    expect(mountBackoffWaitMs(1, () => 0)).toBe(SLOW_JITTER_MIN_MS)
    expect(mountBackoffWaitMs(1, () => 0.999)).toBe(SLOW_JITTER_MAX_MS)
    // A fast wait that did not buy success is followed by a slower one.
    expect(mountBackoffWaitMs(1, () => 0)).toBeGreaterThan(mountBackoffWaitMs(0, () => 1))
    expect(mountBackoffWaitMs(2, () => 0)).toBe(mountBackoffWaitMs(1, () => 0))
  })

  it('grows the failure-record TTL per recorded failure and caps it', () => {
    expect(failureMemoTtlMs(1)).toBe(MOUNT_FAILURE_TTL_BASE_MS)
    expect(failureMemoTtlMs(2)).toBe(MOUNT_FAILURE_TTL_BASE_MS * 2)
    expect(failureMemoTtlMs(3)).toBe(MOUNT_FAILURE_TTL_BASE_MS * 4)
    expect(failureMemoTtlMs(4)).toBe(MOUNT_FAILURE_TTL_BASE_MS * 8)
    // The cap holds however many times the same file has failed.
    expect(failureMemoTtlMs(64)).toBe(MOUNT_FAILURE_TTL_CAP_MS)
  })
})

describe('the transient-errno gate', () => {
  it('accepts a transient code wherever the chain leaves it', () => {
    const busy = Object.assign(new Error('module busy'), { code: 'EBUSY' })
    expect(isTransientMountError(busy)).toBe(true)
    // Every layer between the syscall and the mount rethrows with its own
    // message; the code survives only on the cause.
    expect(isTransientMountError(new Error('failed to apply', { cause: new Error('inner', { cause: busy }) }))).toBe(true)
    // A group reports several row failures as one aggregate.
    expect(isTransientMountError(new AggregateError([new Error('plain'), busy], 'several rows'))).toBe(true)
  })

  it('refuses a failure a wait cannot clear', () => {
    expect(isTransientMountError(new Error('composition will not parse'))).toBe(false)
    expect(isTransientMountError(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(false)
    expect(isTransientMountError(new AggregateError([new Error('plain')], 'one row'))).toBe(false)
    // A hostile thrown value is a failure, not a crash.
    expect(isTransientMountError('hostile value')).toBe(false)
  })

  it('stops at the cause-depth bound instead of following a cycle forever', () => {
    let deep: unknown = new Error('bottom')
    for (let link = 0; link < 8; link += 1) deep = new Error(`link ${link}`, { cause: deep })
    expect(isTransientMountError(deep)).toBe(false)
    // The depth is a seam too: zero means "this node only".
    const busy = Object.assign(new Error('module busy'), { code: 'EBUSY' })
    expect(isTransientMountError(new Error('wrapper', { cause: busy }), 0)).toBe(false)
    expect(isTransientMountError(new Error('wrapper', { cause: busy }), 1)).toBe(true)
  })
})

describe('withMountBackoff', () => {
  it('waits out the bounded schedule for transient failures and returns the first success', async () => {
    const seams = recordingSeams(0)
    let attempts = 0
    const mounted = await withMountBackoff(async () => {
      attempts += 1
      if (attempts < MOUNT_MAX_ATTEMPTS) throw transient()
      return 'mounted'
    }, seams)

    expect(mounted).toBe('mounted')
    expect(attempts).toBe(MOUNT_MAX_ATTEMPTS)
    // Two waits for three attempts: FAST then SLOW, both at their band floor
    // because rand is pinned at 0.
    expect(seams.waits).toEqual([FAST_JITTER_MIN_MS, SLOW_JITTER_MIN_MS])
  })

  it('gives up at the attempt bound and rethrows the LAST failure untouched', async () => {
    const seams = recordingSeams(0)
    let attempts = 0
    const last = transient()
    await expect(withMountBackoff<string>(async () => {
      attempts += 1
      if (attempts < MOUNT_MAX_ATTEMPTS) throw transient()
      throw last
    }, seams)).rejects.toBe(last)

    expect(attempts).toBe(MOUNT_MAX_ATTEMPTS)
    expect(seams.waits).toHaveLength(MOUNT_MAX_ATTEMPTS - 1)
  })

  it('surfaces a failure a wait cannot clear on the first attempt, with no wait', async () => {
    const seams = recordingSeams()
    const failure = new Error('composition will not parse')
    let attempts = 0
    await expect(withMountBackoff(async () => {
      attempts += 1
      throw failure
    }, seams)).rejects.toBe(failure)

    expect(attempts).toBe(1)
    expect(seams.waits).toEqual([])
  })
})
