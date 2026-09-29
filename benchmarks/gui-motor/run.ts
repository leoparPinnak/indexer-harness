/**
 * Runnable A/B entry: scores the two MOCK backends against the deterministic
 * fixture and prints the result table plus the JSON comparison document.
 * Run with `pnpm exec tsx benchmarks/gui-motor/run.ts`.
 */

import { GUI_MOTOR_FIXTURE } from './src/fixture.ts'
import { createCodexNativeMockBackend, createKoffiMockBackend } from './src/mocks/mock-backend.ts'
import { formatComparison } from './src/report.ts'
import { runComparison } from './src/runner.ts'

/** Reviewed constant: iterations per operation class for the printed run. */
const ITERATIONS = 30

const comparison = await runComparison(
  [createKoffiMockBackend(GUI_MOTOR_FIXTURE), createCodexNativeMockBackend(GUI_MOTOR_FIXTURE)],
  GUI_MOTOR_FIXTURE,
  { iterations: ITERATIONS },
)

console.log(formatComparison(comparison))
console.log('')
console.log(JSON.stringify(comparison, null, 2))
