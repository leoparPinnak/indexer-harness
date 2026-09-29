/**
 * Specs for the budget-durability state machines: the thrash detector (a streak
 * of repeats of one artifact) and the persist circuit breaker (consecutive
 * failures, sticky open). No timers — every transition is driven by explicit
 * attempts, so the sequences below are exact.
 */

import { describe, expect, it } from 'vitest'
import {
  BREAKER_THRESHOLD,
  PersistCircuitBreaker,
  SpillThrashDetector,
  THRASH_THRESHOLD,
} from '../src/resilience.ts'

describe('thresholds', () => {
  it('matches the shipped policy constants', () => {
    expect(THRASH_THRESHOLD).toBe(3)
    expect(BREAKER_THRESHOLD).toBe(3)
  })
})

describe('SpillThrashDetector', () => {
  it('trips when one artifact is spilled three times in a row', () => {
    const detector = new SpillThrashDetector()
    expect(detector.record('s1:bash:aa')).toBeUndefined()
    expect(detector.record('s1:bash:aa')).toBeUndefined()
    const warning = detector.record('s1:bash:aa')
    expect(warning).toContain('spill thrash:')
    expect(warning).toContain('3 times in a row')
    expect(detector.consecutive).toBe(3)
  })

  it('resets the streak when a different artifact arrives', () => {
    const detector = new SpillThrashDetector()
    detector.record('a')
    detector.record('a')
    expect(detector.record('b')).toBeUndefined()
    expect(detector.consecutive).toBe(1)
    expect(detector.record('a')).toBeUndefined()
    expect(detector.consecutive).toBe(1)
  })

  it('reports the threshold crossing exactly once per streak', () => {
    const detector = new SpillThrashDetector()
    detector.record('a')
    detector.record('a')
    expect(detector.record('a')).toBeDefined()
    expect(detector.record('a')).toBeUndefined()
    detector.record('b')
    detector.record('b')
    expect(detector.record('b')).toBeDefined()
  })

  it('rejects a non-positive threshold at construction', () => {
    expect(() => new SpillThrashDetector(0)).toThrow(/positive integer/)
    expect(() => new SpillThrashDetector(2.5)).toThrow(/positive integer/)
  })
})

describe('PersistCircuitBreaker', () => {
  it('stays closed below the threshold and reports the trip once at it', () => {
    const breaker = new PersistCircuitBreaker()
    expect(breaker.recordFailure()).toBeUndefined()
    expect(breaker.recordFailure()).toBeUndefined()
    expect(breaker.open).toBe(false)
    const trip = breaker.recordFailure()
    expect(trip).toContain('spill circuit breaker tripped after 3 consecutive persist failures')
    expect(breaker.open).toBe(true)
    expect(breaker.consecutiveFailures).toBe(3)
  })

  it('closes the failure streak on a success', () => {
    const breaker = new PersistCircuitBreaker()
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()
    expect(breaker.recordFailure()).toBeUndefined()
    expect(breaker.recordFailure()).toBeUndefined()
    expect(breaker.open).toBe(false)
    expect(breaker.recordFailure()).toBeDefined()
  })

  it('stays open through later successes and never re-reports (idempotent trip)', () => {
    const breaker = new PersistCircuitBreaker()
    for (let attempt = 0; attempt < BREAKER_THRESHOLD; attempt++) breaker.recordFailure()
    expect(breaker.open).toBe(true)
    breaker.recordSuccess()
    expect(breaker.open).toBe(true)
    expect(breaker.recordFailure()).toBeUndefined()
    expect(breaker.consecutiveFailures).toBe(BREAKER_THRESHOLD)
  })

  it('counts interleaved attempts in arrival order (race: a success mid-streak only clears a closed breaker)', () => {
    const breaker = new PersistCircuitBreaker()
    // Two overlapping persist attempts failing, one recovering, then failures again.
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()
    expect(breaker.consecutiveFailures).toBe(0)
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.open).toBe(false)
    expect(breaker.recordFailure()).toBeDefined()
  })

  it('rejects a non-positive threshold at construction', () => {
    expect(() => new PersistCircuitBreaker(0)).toThrow(/positive integer/)
    expect(() => new PersistCircuitBreaker(-1)).toThrow(/positive integer/)
  })
})
