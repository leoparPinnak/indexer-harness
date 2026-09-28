import { describe, expect, it } from 'vitest'
import { clampLockTtl, TabLockRegistry, MAX_LOCK_TTL_MS, MIN_LOCK_TTL_MS } from '../src/tab-lock.ts'

describe('tab-lock: lease semantics', () => {
  it('grants the first lease and reports the second as lock-held (in-band)', () => {
    const desk = new TabLockRegistry()
    const first = desk.acquire('t1', 'agent-a', 60_000, 1_000)
    expect(first.ok).toBe(true)
    const second = desk.acquire('t1', 'agent-b', 60_000, 1_500)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected lock-held')
    expect(second.reason).toBe('lock-held')
    expect(second.holder).toBe('agent-a')
  })

  it('isolates different target keys', () => {
    const desk = new TabLockRegistry()
    expect(desk.acquire('t1', 'a', 60_000, 0).ok).toBe(true)
    expect(desk.acquire('t2', 'b', 60_000, 0).ok).toBe(true)
  })

  it('an expired lease yields silently at the next acquire', () => {
    const desk = new TabLockRegistry()
    desk.acquire('t1', 'agent-a', 1_000, 0)
    // 61s later the 1s-floor lease is long dead.
    const next = desk.acquire('t1', 'agent-b', 60_000, 61_000)
    expect(next.ok).toBe(true)
  })

  it('release returns the lease and frees the key; double unlock is unknown-lock', () => {
    const desk = new TabLockRegistry()
    const got = desk.acquire('t1', 'agent-a', 60_000, 0)
    if (!got.ok) throw new Error('expected lease')
    const freed = desk.release(got.lease.lockId, 'agent-a', 10)
    expect(freed.ok).toBe(true)
    const again = desk.release(got.lease.lockId, 'agent-a', 20)
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('expected unknown-lock')
    expect(again.reason).toBe('unknown-lock')
  })

  it('a bystander cannot unlock (not-holder), the owner can', () => {
    const desk = new TabLockRegistry()
    const got = desk.acquire('t1', 'agent-a', 60_000, 0)
    if (!got.ok) throw new Error('expected lease')
    const stranger = desk.release(got.lease.lockId, 'agent-b', 10)
    expect(stranger.ok).toBe(false)
    if (stranger.ok) throw new Error('expected not-holder')
    expect(stranger.reason).toBe('not-holder')
    expect(desk.release(got.lease.lockId, 'agent-a', 20).ok).toBe(true)
  })

  it('inspect reports the live lease and sweeps report dead keys', () => {
    const desk = new TabLockRegistry()
    desk.acquire('t1', 'a', 1_000, 0)
    desk.acquire('t2', 'b', 60_000, 0)
    expect(desk.inspect('t1', 10)?.holder).toBe('a')
    expect(desk.inspect('t1', 5_000)).toBeUndefined()
    expect(desk.sweep(5_000)).toBe(1)
    expect(desk.sweep(5_000)).toBe(0)
  })

  it('clampLockTtl enforces the window and survives NaN', () => {
    expect(clampLockTtl(10)).toBe(MIN_LOCK_TTL_MS)
    expect(clampLockTtl(999_999)).toBe(MAX_LOCK_TTL_MS)
    expect(clampLockTtl(Number.NaN)).toBe(60_000)
    expect(clampLockTtl(42_500.9)).toBe(42_500)
  })
})