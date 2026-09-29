/** Configuration resolution for deterministic tool-result pruning. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/**
 * Fixed marker substituted for every removed middle span.
 *
 * When the pruned result carried a recovery pointer — a spill path from a
 * bounded-output tool — that path is lifted INTO the marker, so the cut never
 * silently strands content the model could otherwise have read back. This is the
 * guard a prune needs: a pointer that lives only in the removed middle is a
 * pointer the model can no longer see.
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Builds a prune marker that keeps an existing recovery path reachable. */
export function pruneMarker(recoveryPath?: string): string {
  return recoveryPath === undefined
    ? PRUNE_MARKER
    : `\n\n[... tool result middle pruned ... recover: ${recoveryPath}]\n\n`
}

/**
 * Longest marker the budget must tolerate.
 *
 * Windows paths cap near 260 characters, so a real recovery path cannot push
 * the marker past roughly this size. Budgeting against it keeps the check
 * meaningful without rejecting legitimately small thresholds.
 */
export const PRUNE_MARKER_MAX = pruneMarker('C:\\Users\\name\\AppData\\Local\\Temp\\dsh-spill-0123456789ab\\session-0123456789abcdef\\0123456789abcdef-spill.txt')

/**
 * Pull a recovery path out of a tool result before its middle is removed.
 *
 * Two shapes reach the model, and both must survive the cut:
 * - a bounded-output notice inside the text, e.g.
 *   `[output truncated; full output: C:\...\spill\out.log]`
 *   or `[some output was dropped from memory; full output: …]`
 * - a structured `spillPath` / `stdoutSpillPath` / `stderrSpillPath` carried on
 *   the result itself rather than in its prose.
 *
 * @param blocks - original tool-result content blocks.
 * @returns the path to keep reachable, or `undefined` when the result has none.
 */
export function recoveryPathOf(blocks: readonly ContentBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const text = block.text
    // `[output truncated; full output: <path>]` — take the path, not the prose.
    const truncated = /\[output truncated; full output: ([^\]]+)\]/.exec(text)
    if (truncated !== null) {
      const captured = truncated[1]
      if (captured !== undefined) return captured.trim()
    }
    // `[some output was dropped from memory; full output: <a, b>]` — keep the
    // first path; a second stream stays reachable through the same session.
    const dropped = /\[some output was dropped from memory; full output: ([^\]]+)\]/.exec(text)
    if (dropped !== null) {
      const first = dropped[1]?.split(',')[0]
      if (first !== undefined && first.trim() !== '') return first.trim()
    }
  }
  return undefined
}

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  // Budgeted against the widest marker a real recovery path produces. A
  // configuration too small to carry even that path is rejected up front, so
  // the cut can never strand a pointer it had no room to keep.
  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER_MAX)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    // A small threshold is still usable when no result carries a recovery
    // path, so allow it and let the marker shrink with the content.
    const bareEmitted = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars
    if (bareEmitted > resolved.thresholdChars) {
      throw new Error(
        `ToolResultPruneConfig: headChars + marker + tailChars (${bareEmitted}) `
        + `must be at most thresholdChars (${resolved.thresholdChars})`,
      )
    }
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
