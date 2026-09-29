/** Runner proof: both MOCK backends are measured for median/p95 latency and scored for fidelity against fixture ground truth. */

import { describe, expect, it } from 'vitest'
import { GUI_MOTOR_FIXTURE } from '../src/fixture.ts'
import { createCodexNativeMockBackend, createKoffiMockBackend } from '../src/mocks/mock-backend.ts'
import { createVirtualClock } from '../src/mocks/clock.ts'
import { median, p95, runBackend } from '../src/runner.ts'
import type { BackendResult } from '../src/runner.ts'

const ITERATIONS = 10
const fixture = GUI_MOTOR_FIXTURE

/** Measure both mocks sequentially on one virtual clock so samples are exact and wall time is zero. */
async function measureMocks(): Promise<{ koffi: BackendResult; native: BackendResult }> {
  const clock = createVirtualClock()
  const options = { iterations: ITERATIONS, now: clock.now }
  const koffiResult = await runBackend(createKoffiMockBackend(fixture, { wait: clock.wait }), fixture, options)
  const nativeResult = await runBackend(createCodexNativeMockBackend(fixture, { wait: clock.wait }), fixture, options)
  return { koffi: koffiResult, native: nativeResult }
}

const measured = await measureMocks()

describe('latency statistics', () => {
  it('computes median and nearest-rank p95 over known samples', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(p95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19)
    expect(() => median([])).toThrow(/at least one sample/)
    expect(() => p95([])).toThrow(/at least one sample/)
  })
})

describe('the runner measures both mocks', () => {
  it('collects one sample per operation call for every iteration', () => {
    // 2 ops per window × 3 windows + 1 trailing key = 7 inputs; 3 subtree reads; 1 capture.
    expect(measured.koffi.latency.sendInput.samples).toBe(7 * ITERATIONS)
    expect(measured.koffi.latency.readUia.samples).toBe(3 * ITERATIONS)
    expect(measured.koffi.latency.capture.samples).toBe(ITERATIONS)
    expect(measured.native.latency.sendInput.samples).toBe(7 * ITERATIONS)
    expect(measured.native.latency.readUia.samples).toBe(3 * ITERATIONS)
    expect(measured.native.latency.capture.samples).toBe(ITERATIONS)
  })

  it('reports ordered latency stats for each operation class', () => {
    for (const result of [measured.koffi, measured.native]) {
      for (const stats of [result.latency.sendInput, result.latency.readUia, result.latency.capture]) {
        expect(stats.medianMs).toBeGreaterThan(0)
        expect(stats.medianMs).toBeLessThanOrEqual(stats.p95Ms)
      }
    }
  })

  it('shows the helper-vs-interop gap: the koffi interop path is slower on every operation class', () => {
    expect(measured.koffi.latency.sendInput.medianMs).toBeGreaterThan(measured.native.latency.sendInput.medianMs)
    expect(measured.koffi.latency.readUia.medianMs).toBeGreaterThan(measured.native.latency.readUia.medianMs)
    expect(measured.koffi.latency.capture.medianMs).toBeGreaterThan(measured.native.latency.capture.medianMs)
    expect(measured.koffi.latency.sendInput.p95Ms).toBeGreaterThan(measured.native.latency.sendInput.p95Ms)
    expect(measured.koffi.latency.readUia.p95Ms).toBeGreaterThan(measured.native.latency.readUia.p95Ms)
    expect(measured.koffi.latency.capture.p95Ms).toBeGreaterThan(measured.native.latency.capture.p95Ms)
  })

  it('stays deterministic across reruns on a fresh virtual clock', async () => {
    const again = await measureMocks()
    expect(again.koffi.latency.sendInput.medianMs).toBe(measured.koffi.latency.sendInput.medianMs)
    expect(again.native.latency.readUia.p95Ms).toBe(measured.native.latency.readUia.p95Ms)
  })
})

describe('fidelity against fixture ground truth', () => {
  it('scores message injection reach at the delivered-scenario ratio', () => {
    // main: move + click + key land; kiosk (drops posts) and admin (elevated) drop 4 of 7.
    expect(measured.koffi.fidelity.inputReach).toBeCloseTo(3 / 7, 10)
    expect(measured.native.fidelity.inputReach).toBe(1)
  })

  it('scores tree completeness from found-vs-ground-truth elements', () => {
    // 10 ground-truth elements; the message probe misses the 3 COM-only ones.
    expect(measured.koffi.fidelity.uiaCompleteness).toBeCloseTo(7 / 10, 10)
    expect(measured.native.fidelity.uiaCompleteness).toBe(1)
  })

  it('scores property accuracy from compared name/value/bounds observations', () => {
    // Found elements contribute 14 correct props; the 2 message-unreadable values are wrong.
    expect(measured.koffi.fidelity.uiaPropertyAccuracy).toBeCloseTo(14 / 16, 10)
    expect(measured.native.fidelity.uiaPropertyAccuracy).toBe(1)
  })

  it('scores capture fidelity from regions matching their expected color', () => {
    // The GDI blit misses the two desktop-scope regions (black boxes).
    expect(measured.koffi.fidelity.captureFidelity).toBeCloseTo(3 / 5, 10)
    expect(measured.native.fidelity.captureFidelity).toBe(1)
  })

  it('flags every MOCK result as synthetic', () => {
    expect(measured.koffi.mock).toBe(true)
    expect(measured.native.mock).toBe(true)
    expect(measured.koffi.backendId).toBe('koffi-message-mock')
    expect(measured.native.backendId).toBe('codex-native-mock')
  })
})

describe('runner configuration', () => {
  it('rejects a non-positive iteration count', async () => {
    const clock = createVirtualClock()
    const backend = createKoffiMockBackend(fixture, { wait: clock.wait })
    await expect(runBackend(backend, fixture, { iterations: 0, now: clock.now })).rejects.toThrow(/positive integer/)
  })
})
