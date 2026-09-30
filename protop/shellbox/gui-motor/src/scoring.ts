/**
 * Weighted scoring: every metric carries a weight, latency normalizes to the
 * best measured backend, fidelity scores stay absolute, and the composite picks
 * the default-vs-fallback verdict.
 */

import type { BackendResult } from './runner.ts'

/** One decision metric. Latency metrics are p95 milliseconds (lower is better); fidelity metrics are 0..1 ratios. */
export type MetricName =
  | 'sendInputLatency'
  | 'readUiaLatency'
  | 'captureLatency'
  | 'inputReach'
  | 'uiaCompleteness'
  | 'uiaPropertyAccuracy'
  | 'captureFidelity'

/** Every metric in decision order. */
export const METRIC_NAMES: readonly MetricName[] = [
  'sendInputLatency',
  'readUiaLatency',
  'captureLatency',
  'inputReach',
  'uiaCompleteness',
  'uiaPropertyAccuracy',
  'captureFidelity',
]

/** Per-metric decision weight; positive finite values, normalized to a sum of 1. */
export type ScoreWeights = { readonly [K in MetricName]: number }

/**
 * Default rubric: speed (round-trip latency) carries 0.35, native fidelity
 * carries 0.65 — "hızlı ve tam yerli" with the weight on "tam" (fully native).
 * `inputReach` is the top single weight: SendInput reach on windows that drop
 * posted messages or are elevated is the primary native differentiator, ahead
 * of COM-UIA completeness/accuracy and WGC capture fidelity.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  sendInputLatency: 0.1,
  readUiaLatency: 0.15,
  captureLatency: 0.1,
  inputReach: 0.25,
  uiaCompleteness: 0.15,
  uiaPropertyAccuracy: 0.1,
  captureFidelity: 0.15,
}

/** Per-metric score inside the composite. */
export interface MetricScore {
  readonly metric: MetricName
  /** Effective (normalized) weight, summing to 1 across all metrics. */
  readonly weight: number
  /** Raw measured value per backend: p95 ms for latency, 0..1 ratio for fidelity. */
  readonly values: Readonly<Record<string, number>>
  /** Normalized 0..1 score entering the composite. */
  readonly scores: Readonly<Record<string, number>>
  /** Backends tied for the best score on this metric. */
  readonly winnerIds: readonly string[]
}

/** The default-vs-fallback decision with per-criterion rationale. */
export interface Verdict {
  readonly defaultBackendId: string
  readonly fallbackBackendId: string
  /** Weighted composite score per backend, in `[0, 1]`. */
  readonly composite: Readonly<Record<string, number>>
  readonly metrics: readonly MetricScore[]
  /** One line per criterion plus the overall composite, ready to print. */
  readonly rationale: readonly string[]
}

/** Read one metric's raw value from a result. */
function metricValue(result: BackendResult, metric: MetricName): number {
  switch (metric) {
    case 'sendInputLatency':
      return result.latency.sendInput.p95Ms
    case 'readUiaLatency':
      return result.latency.readUia.p95Ms
    case 'captureLatency':
      return result.latency.capture.p95Ms
    case 'inputReach':
      return result.fidelity.inputReach
    case 'uiaCompleteness':
      return result.fidelity.uiaCompleteness
    case 'uiaPropertyAccuracy':
      return result.fidelity.uiaPropertyAccuracy
    case 'captureFidelity':
      return result.fidelity.captureFidelity
  }
}

/** Validate the weights and return them normalized to a sum of 1. */
function normalizedWeights(weights: ScoreWeights): ScoreWeights {
  let total = 0
  for (const metric of METRIC_NAMES) {
    const weight = weights[metric]
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`gui-motor: weight for ${metric} must be a finite positive number, got ${String(weight)}.`)
    }
    total += weight
  }
  const normalized = {} as Record<MetricName, number>
  for (const metric of METRIC_NAMES) normalized[metric] = weights[metric] / total
  return normalized
}

/** Fidelity is scored absolutely; latency is scored against the best (lowest) p95. */
function metricScores(metric: MetricName, values: Readonly<Record<string, number>>): Record<string, number> {
  if (!metric.endsWith('Latency')) return { ...values }
  const best = Math.min(...Object.values(values))
  const scores: Record<string, number> = {}
  for (const [id, value] of Object.entries(values)) {
    scores[id] = best <= 0 || value <= 0 ? 1 : best / value
  }
  return scores
}

/** Sum of the four fidelity metrics: the composite tie-breaker. */
function fidelitySum(result: BackendResult): number {
  return result.fidelity.inputReach
    + result.fidelity.uiaCompleteness
    + result.fidelity.uiaPropertyAccuracy
    + result.fidelity.captureFidelity
}

/** True when two composite scores are indistinguishable at decision precision. */
function tied(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9
}

/**
 * Decide the default and fallback backend from measured results.
 * @param results - One `BackendResult` per competing backend (at least two, distinct ids).
 * @param weights - Per-metric weights; defaults to `DEFAULT_WEIGHTS`.
 * @returns The verdict: composites, per-metric scores, and printable rationale.
 */
export function decideBest(results: readonly BackendResult[], weights: ScoreWeights = DEFAULT_WEIGHTS): Verdict {
  if (results.length < 2) {
    throw new Error(`gui-motor: expected at least two backend results, got ${String(results.length)}.`)
  }
  const ids = results.map(result => result.backendId)
  if (new Set(ids).size !== ids.length) {
    throw new Error(`gui-motor: backend ids must be distinct, got ${ids.join(', ')}.`)
  }

  const effective = normalizedWeights(weights)
  const metrics: MetricScore[] = []
  const rationale: string[] = []
  const composite: Record<string, number> = {}
  for (const id of ids) composite[id] = 0

  for (const metric of METRIC_NAMES) {
    const values: Record<string, number> = {}
    for (const result of results) values[result.backendId] = metricValue(result, metric)
    const scores = metricScores(metric, values)
    const best = Math.max(...Object.values(scores))
    const winnerIds = ids.filter(id => (scores[id] ?? 0) >= best - 1e-9)
    const weight = effective[metric]
    for (const id of ids) composite[id] = (composite[id] ?? 0) + weight * (scores[id] ?? 0)
    metrics.push({ metric, weight, values, scores, winnerIds })

    const isLatency = metric.endsWith('Latency')
    const detail = ids
      .map((id) => {
        const value = values[id] ?? 0
        return `${id}=${isLatency ? `${value.toFixed(1)}ms` : value.toFixed(2)}`
      })
      .join(', ')
    const winners = winnerIds.length === ids.length ? 'tie' : winnerIds.join(', ')
    rationale.push(`${metric} (weight ${weight.toFixed(2)}): ${winners} — ${detail}`)
  }

  const ranking = [...ids].sort((a, b) => (composite[b] ?? 0) - (composite[a] ?? 0))
  const firstId = ranking[0]!
  const secondId = ranking[1]!
  let defaultId = firstId
  let fallbackId = secondId
  if (tied(composite[firstId] ?? 0, composite[secondId] ?? 0)) {
    const first = results.find(result => result.backendId === firstId)!
    const second = results.find(result => result.backendId === secondId)!
    const fidelityDelta = fidelitySum(first) - fidelitySum(second)
    if (Math.abs(fidelityDelta) <= 1e-9) {
      throw new Error(
        `gui-motor: composite tie between ${firstId} and ${secondId} even after the fidelity tie-break;`
        + ' rerun with more iterations or review the weights.',
      )
    }
    if (fidelityDelta < 0) {
      defaultId = secondId
      fallbackId = firstId
    }
  }

  const compositeDetail = ranking
    .map(id => `${id}=${(composite[id] ?? 0).toFixed(2)}`)
    .join(', ')
  rationale.push(`composite: ${compositeDetail} → default=${defaultId}, fallback=${fallbackId}`)

  return { defaultBackendId: defaultId, fallbackBackendId: fallbackId, composite, metrics, rationale }
}
