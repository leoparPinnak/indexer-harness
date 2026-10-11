/**
 * Printed result table: latency (median/p95) and fidelity columns per backend
 * followed by the default-vs-fallback verdict and its per-criterion rationale.
 */

import type { BenchmarkComparison } from './runner.ts'

/** Two-column cell builder kept local to keep the table layout in one place. */
function padRow(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd()
}

/** Column widths for the fixed table layout: widest cell per column. */
function columnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return widths
}

function latencyCell(stats: { medianMs: number; p95Ms: number }): string {
  return `${stats.medianMs.toFixed(1)}/${stats.p95Ms.toFixed(1)}ms`
}

/**
 * Render one comparison as the printed result table plus verdict lines.
 * @param comparison - Results and verdict from `runComparison`.
 * @returns The printable report; the same document serializes to JSON unchanged.
 */
export function formatComparison(comparison: BenchmarkComparison): string {
  const header = [
    'backend',
    'sendInput med/p95',
    'readUia med/p95',
    'capture med/p95',
    'reach',
    'tree',
    'props',
    'frame',
  ]
  const rows = comparison.results.map(result => [
    result.label,
    latencyCell(result.latency.sendInput),
    latencyCell(result.latency.readUia),
    latencyCell(result.latency.capture),
    result.fidelity.inputReach.toFixed(2),
    result.fidelity.uiaCompleteness.toFixed(2),
    result.fidelity.uiaPropertyAccuracy.toFixed(2),
    result.fidelity.captureFidelity.toFixed(2),
  ])
  const widths = columnWidths([header, ...rows])
  const lines = [
    `gui-motor GUI-backend A/B — fixture ${comparison.fixtureId}, ${comparison.iterations} iterations per operation`,
    '',
    padRow(header, widths),
    ...rows.map(row => padRow(row, widths)),
    '',
    `verdict: ${comparison.verdict.defaultBackendId} = default, ${comparison.verdict.fallbackBackendId} = fallback`,
    'rationale:',
    ...comparison.verdict.rationale.map(line => `  - ${line}`),
  ]
  return lines.join('\n')
}
