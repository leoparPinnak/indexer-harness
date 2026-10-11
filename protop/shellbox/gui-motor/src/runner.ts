/**
 * Benchmark runner: drives each backend through the fixture's input scenarios,
 * subtree reads, and capture target for N iterations, measuring per-operation
 * round-trip latency (median + p95) and scoring fidelity against ground truth.
 */

import { performance } from 'node:perf_hooks'
import type { Bounds, CaptureFrame, GuiBackend, UiaElement } from './backend.ts'
import type { GuiFixture } from './fixture.ts'
import { fixtureElements, inputScenarioOps } from './fixture.ts'
import type { ScoreWeights } from './scoring.ts'
import { DEFAULT_WEIGHTS, decideBest } from './scoring.ts'
import type { Verdict } from './scoring.ts'

/** Latency summary for one operation class. */
export interface LatencyStats {
  /** Number of measured round trips. */
  readonly samples: number
  readonly medianMs: number
  readonly p95Ms: number
}

/** Measured outcome for one backend. */
export interface BackendResult {
  readonly backendId: string
  readonly label: string
  readonly mock: boolean
  readonly capabilities: GuiBackend['capabilities']
  readonly latency: {
    readonly sendInput: LatencyStats
    readonly readUia: LatencyStats
    readonly capture: LatencyStats
  }
  /** 0..1 ratios pooled across every iteration: delivered input, found elements, correct properties, matching regions. */
  readonly fidelity: {
    readonly inputReach: number
    readonly uiaCompleteness: number
    readonly uiaPropertyAccuracy: number
    readonly captureFidelity: number
  }
}

/** Runner configuration. */
export interface RunnerOptions {
  /** Iterations per operation class (positive integer). */
  readonly iterations: number
  /** Measurement clock; defaults to `performance.now`. Pair with a mock's virtual clock for deterministic runs. */
  readonly now?: () => number
  /** Composite weights for `runComparison`; defaults to `DEFAULT_WEIGHTS`. */
  readonly weights?: ScoreWeights
}

/** Full A/B comparison document: measured results plus the decision. */
export interface BenchmarkComparison {
  readonly fixtureId: string
  readonly iterations: number
  readonly results: readonly BackendResult[]
  readonly verdict: Verdict
}

/** Median of a sample set; the average of the two middle values on even counts. */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('gui-motor: median needs at least one sample.')
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

/** Nearest-rank p95 of a sample set: the value at `ceil(0.95 * n)` in sorted order. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('gui-motor: p95 needs at least one sample.')
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length)
  return sorted[Math.max(rank - 1, 0)] ?? 0
}

function summarize(samples: readonly number[]): LatencyStats {
  return { samples: samples.length, medianMs: median(samples), p95Ms: p95(samples) }
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Guarded ratio: an empty denominator is trivially perfect, never NaN. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

/**
 * Run one backend through the fixture and measure latency plus fidelity.
 * @param backend - The backend under test (MOCK or real).
 * @param fixture - The deterministic window world driving ground truth.
 * @param options - Iterations and optional clock.
 * @returns The measured result feeding `decideBest`.
 */
export async function runBackend(
  backend: GuiBackend,
  fixture: GuiFixture,
  options: RunnerOptions,
): Promise<BackendResult> {
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
    throw new Error(`gui-motor: iterations must be a positive integer, got ${String(options.iterations)}.`)
  }
  const now = options.now ?? (() => performance.now())
  const scenarioOps = inputScenarioOps(fixture)
  const readTargets = fixture.windows.map(window => window.id)

  const sendSamples: number[] = []
  const readSamples: number[] = []
  const captureSamples: number[] = []
  let delivered = 0
  let attempts = 0
  let foundElements = 0
  let groundElements = 0
  let correctProps = 0
  let comparedProps = 0
  let regionMatches = 0
  let regionTotal = 0

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    for (const op of scenarioOps) {
      const started = now()
      const receipt = await backend.sendInput(op)
      sendSamples.push(now() - started)
      attempts += 1
      if (receipt.delivered) delivered += 1
    }

    for (const windowId of readTargets) {
      const started = now()
      const snapshot = await backend.readUia({ windowId })
      readSamples.push(now() - started)

      const expected = fixtureElements(fixture, windowId)
      const observedByPath = new Map<string, UiaElement>(snapshot.elements.map(element => [element.path, element]))
      groundElements += expected.length
      for (const expectedElement of expected) {
        const observed = observedByPath.get(expectedElement.path)
        if (observed === undefined) continue
        foundElements += 1
        comparedProps += 1
        if (observed.name === expectedElement.name) correctProps += 1
        comparedProps += 1
        if (sameBounds(observed.bounds, expectedElement.bounds)) correctProps += 1
        if (expectedElement.value !== undefined) {
          comparedProps += 1
          if (observed.value === expectedElement.value) correctProps += 1
        }
      }
    }

    const captureStarted = now()
    const frame: CaptureFrame = await backend.capture({ windowId: fixture.primaryWindowId })
    captureSamples.push(now() - captureStarted)
    for (const region of fixture.regions) {
      regionTotal += 1
      if (frame.regions[region.name] === region.color) regionMatches += 1
    }
  }

  return {
    backendId: backend.id,
    label: backend.label,
    mock: backend.mock,
    capabilities: backend.capabilities,
    latency: {
      sendInput: summarize(sendSamples),
      readUia: summarize(readSamples),
      capture: summarize(captureSamples),
    },
    fidelity: {
      inputReach: ratio(delivered, attempts),
      uiaCompleteness: ratio(foundElements, groundElements),
      uiaPropertyAccuracy: ratio(correctProps, comparedProps),
      captureFidelity: ratio(regionMatches, regionTotal),
    },
  }
}

/**
 * Run every backend sequentially (latency measurement must not contend), then
 * decide the verdict. Backends run one after another so a shared virtual clock
 * or a loaded machine never interleaves two samples.
 * @param backends - Competing backends, at least two.
 * @param fixture - The deterministic window world driving ground truth.
 * @param options - Iterations, optional clock, optional weights.
 * @returns The comparison document: results, verdict, printable and JSON-serializable as is.
 */
export async function runComparison(
  backends: readonly GuiBackend[],
  fixture: GuiFixture,
  options: RunnerOptions,
): Promise<BenchmarkComparison> {
  const results: BackendResult[] = []
  for (const backend of backends) results.push(await runBackend(backend, fixture, options))
  const verdict = decideBest(results, options.weights ?? DEFAULT_WEIGHTS)
  return { fixtureId: fixture.id, iterations: options.iterations, results, verdict }
}
