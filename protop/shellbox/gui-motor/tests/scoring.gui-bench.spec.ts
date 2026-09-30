/** Scoring proof: weighted composites pick the expected winner on synthetic inputs and the mocks end in the documented verdict. */

import { describe, expect, it } from 'vitest'
import { GUI_MOTOR_FIXTURE } from '../src/fixture.ts'
import { createVirtualClock } from '../src/mocks/clock.ts'
import { createCodexNativeMockBackend, createKoffiMockBackend } from '../src/mocks/mock-backend.ts'
import { runComparison } from '../src/runner.ts'
import type { BackendResult } from '../src/runner.ts'
import { DEFAULT_WEIGHTS, METRIC_NAMES, decideBest } from '../src/scoring.ts'
import type { ScoreWeights } from '../src/scoring.ts'

/** Synthetic result: identical p95 per operation class, uniform fidelity across the four ratios. */
function syntheticResult(
  backendId: string,
  p95Ms: number,
  fidelity: number,
): BackendResult {
  const stats = { samples: 1, medianMs: p95Ms, p95Ms }
  return {
    backendId,
    label: `${backendId} (synthetic)`,
    mock: true,
    capabilities: { nativeInjection: true, comUia: true, capturesWinRt: true },
    latency: { sendInput: stats, readUia: stats, capture: stats },
    fidelity: { inputReach: fidelity, uiaCompleteness: fidelity, uiaPropertyAccuracy: fidelity, captureFidelity: fidelity },
  }
}

const fastButIncomplete = syntheticResult('fast-but-incomplete', 2, 0.5)
const slowButFaithful = syntheticResult('slow-but-faithful', 200, 1)

const speedFirstWeights: ScoreWeights = {
  sendInputLatency: 1,
  readUiaLatency: 1,
  captureLatency: 1,
  inputReach: 0.001,
  uiaCompleteness: 0.001,
  uiaPropertyAccuracy: 0.001,
  captureFidelity: 0.001,
}

const fidelityFirstWeights: ScoreWeights = {
  sendInputLatency: 0.001,
  readUiaLatency: 0.001,
  captureLatency: 0.001,
  inputReach: 1,
  uiaCompleteness: 1,
  uiaPropertyAccuracy: 1,
  captureFidelity: 1,
}

describe('the default rubric', () => {
  it('weights every metric and sums to 1', () => {
    const total = METRIC_NAMES.reduce((sum, metric) => sum + DEFAULT_WEIGHTS[metric], 0)
    expect(METRIC_NAMES).toHaveLength(7)
    expect(total).toBeCloseTo(1, 10)
  })

  it('normalizes custom weights before they enter the composite', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful], speedFirstWeights)
    const weightTotal = verdict.metrics.reduce((sum, metric) => sum + metric.weight, 0)
    expect(weightTotal).toBeCloseTo(1, 10)
    expect(verdict.metrics.map(metric => metric.metric)).toEqual([...METRIC_NAMES])
  })
})

describe('weighted composites on synthetic inputs', () => {
  it('picks the fast backend when speed carries the weight', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful], speedFirstWeights)
    expect(verdict.defaultBackendId).toBe('fast-but-incomplete')
    expect(verdict.fallbackBackendId).toBe('slow-but-faithful')
    expect(verdict.composite['fast-but-incomplete']).toBeGreaterThan(verdict.composite['slow-but-faithful'] ?? 0)
  })

  it('picks the faithful backend when fidelity carries the weight', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful], fidelityFirstWeights)
    expect(verdict.defaultBackendId).toBe('slow-but-faithful')
    expect(verdict.fallbackBackendId).toBe('fast-but-incomplete')
  })

  it('scores fidelity absolutely and latency against the best p95', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful], speedFirstWeights)
    const reach = verdict.metrics.find(metric => metric.metric === 'inputReach')
    expect(reach?.values['slow-but-faithful']).toBe(1)
    expect(reach?.scores['slow-but-faithful']).toBe(1)
    const readLatency = verdict.metrics.find(metric => metric.metric === 'readUiaLatency')
    expect(readLatency?.scores['fast-but-incomplete']).toBe(1)
    expect(readLatency?.scores['slow-but-faithful']).toBeCloseTo(2 / 200, 10)
  })

  it('names a winner per criterion in the rationale', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful], speedFirstWeights)
    const reachLine = verdict.rationale.find(line => line.startsWith('inputReach'))
    expect(reachLine).toContain('slow-but-faithful')
    const latencyLine = verdict.rationale.find(line => line.startsWith('readUiaLatency'))
    expect(latencyLine).toContain('fast-but-incomplete')
    expect(verdict.rationale.at(-1)).toContain(`default=${verdict.defaultBackendId}`)
  })

  it('keeps composites inside [0, 1]', () => {
    const verdict = decideBest([fastButIncomplete, slowButFaithful])
    for (const metric of METRIC_NAMES) expect(DEFAULT_WEIGHTS[metric]).toBeGreaterThan(0)
    for (const id of ['fast-but-incomplete', 'slow-but-faithful']) {
      expect(verdict.composite[id]).toBeGreaterThanOrEqual(0)
      expect(verdict.composite[id]).toBeLessThanOrEqual(1)
    }
  })
})

describe('invalid decisions fail loud', () => {
  it('rejects fewer than two results', () => {
    expect(() => decideBest([fastButIncomplete])).toThrow(/at least two/)
  })

  it('rejects duplicate backend ids', () => {
    expect(() => decideBest([fastButIncomplete, syntheticResult('fast-but-incomplete', 5, 1)])).toThrow(/distinct/)
  })

  it('rejects non-positive weights', () => {
    const broken = { ...DEFAULT_WEIGHTS, inputReach: 0 }
    expect(() => decideBest([fastButIncomplete, slowButFaithful], broken)).toThrow(/inputReach/)
  })
})

describe('the harness verdict on the two MOCK backends', () => {
  it('defaults to the native-fidelity mock and explains each criterion', async () => {
    const clock = createVirtualClock()
    const comparison = await runComparison(
      [createKoffiMockBackend(GUI_MOTOR_FIXTURE, { wait: clock.wait }), createCodexNativeMockBackend(GUI_MOTOR_FIXTURE, { wait: clock.wait })],
      GUI_MOTOR_FIXTURE,
      { iterations: 10, now: clock.now },
    )
    const { verdict } = comparison
    expect(verdict.defaultBackendId).toBe('codex-native-mock')
    expect(verdict.fallbackBackendId).toBe('koffi-message-mock')
    expect(verdict.composite['codex-native-mock']).toBeGreaterThan(verdict.composite['koffi-message-mock'] ?? 0)

    const latencyWinner = verdict.metrics.find(metric => metric.metric === 'sendInputLatency')
    expect(latencyWinner?.winnerIds).toEqual(['codex-native-mock'])
    const reachWinner = verdict.metrics.find(metric => metric.metric === 'inputReach')
    expect(reachWinner?.winnerIds).toEqual(['codex-native-mock'])
    const sendInputLine = verdict.rationale.find(line => line.startsWith('sendInputLatency'))
    expect(sendInputLine).toContain(': codex-native-mock —')
    expect(verdict.rationale.some(line => line.includes('captureFidelity') && line.includes('codex-native-mock'))).toBe(true)
  })
})
