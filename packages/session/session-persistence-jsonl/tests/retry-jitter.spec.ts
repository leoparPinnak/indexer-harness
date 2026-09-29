import { describe, expect, it } from 'vitest'
import {
  FAST_JITTER_MAX_MS,
  FAST_JITTER_MIN_MS,
  FAST_PHASE_MS,
  jitterWaitMs,
  SLOW_JITTER_MIN_MS,
  withJitteredPatience,
} from '../src/retry-jitter.ts'

/** Recording clock kit: sleeps advance the clock, rand is pinned. */
function kit(randValue = 0.5): { now: () => number; sleep: (ms: number) => Promise<void>; rand: () => number; slept: number[] } {
  let clock = 0
  const slept: number[] = []
  return {
    slept,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
    rand: () => randValue,
  }
}

const transient = (error: unknown): boolean => (error as { code?: string }).code === 'EEXIST'

describe('retry-jitter: the two-phase schedule', () => {
  it('FAST band before the knee, SLOW band after', () => {
    expect(jitterWaitMs(0, () => 0)).toBe(FAST_JITTER_MIN_MS)
    expect(jitterWaitMs(FAST_PHASE_MS - 1, () => 0.999)).toBeLessThanOrEqual(150)
    expect(jitterWaitMs(FAST_PHASE_MS, () => 0)).toBe(SLOW_JITTER_MIN_MS)
    // Rand=0.5 lands mid-span deterministically (the seams are injected).
    expect(jitterWaitMs(0, () => 0.5)).toBe(FAST_JITTER_MIN_MS + Math.floor(0.5 * (FAST_JITTER_MAX_MS - FAST_JITTER_MIN_MS + 1)))
  })
})

describe('withJitteredPatience: patience with an honest end', () => {
  it('succeeds after transient failures and the waits follow the fast band', async () => {
    const seams = kit(0) // minimum jitter every time
    let calls = 0
    const result = await withJitteredPatience(async () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('kilitli'), { code: 'EEXIST' })
      return 'TAMAM'
    }, { isTransient: transient, seams, budgetMs: 5_000 })
    expect(result).toBe('TAMAM')
    expect(calls).toBe(3)
    expect(seams.slept).toEqual([FAST_JITTER_MIN_MS, FAST_JITTER_MIN_MS])
  })

  it('a NON-transient failure surfaces immediately — zero waits', async () => {
    const seams = kit()
    let calls = 0
    await expect(withJitteredPatience(async () => {
      calls += 1
      throw Object.assign(new Error('gerçek hata'), { code: 'ENOENT' })
    }, { isTransient: transient, seams })).rejects.toThrow('gerçek hata')
    expect(calls).toBe(1)
    expect(seams.slept).toEqual([])
  })

  it('a drained budget rethrows the LAST error untouched (no masking)', async () => {
    const seams = kit()
    let calls = 0
    const last = Object.assign(new Error('hala kilitli'), { code: 'EEXIST', mark: 'son' })
    await expect(withJitteredPatience(async () => {
      calls += 1
      throw last
    }, { isTransient: transient, seams, budgetMs: 200 })).rejects.toBe(last)
    expect(calls).toBeGreaterThan(1) // genuinely tried before giving up
    expect(seams.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(200)
  })

  it('clamps the wait to the REMAINING budget (never overshoots)', async () => {
    const seams = kit(0.999) // maximal jitter
    const waits: number[] = []
    await withJitteredPatience(async () => { throw Object.assign(new Error('x'), { code: 'EEXIST' }) },
      { isTransient: transient, seams, budgetMs: 100, onWait: (waitMs) => { waits.push(waitMs) } })
      .catch(() => {})
    expect(waits[0] ?? 0).toBeLessThanOrEqual(100)
  })

  it('runs on the production seams when none are injected', async () => {
    const started = Date.now()
    let calls = 0
    const result = await withJitteredPatience(async () => {
      calls += 1
      if (calls < 2) throw Object.assign(new Error('gerçek zaman'), { code: 'EEXIST' })
      return 'TAMAM'
    }, { isTransient: transient })

    expect(result).toBe('TAMAM')
    expect(calls).toBe(2)
    // The default seams are the real clock, timer, and rand: the retry waited
    // inside the FAST band (20 ms floor) rather than turning straight around.
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST_JITTER_MIN_MS - 10)
  })
})