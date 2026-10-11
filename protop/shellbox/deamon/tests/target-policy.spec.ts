/**
 * Bug C pin — the retarget policy that stops viewport/target churn.
 *
 * Production evidence from `dsh-web.log`: `viewport=800x600` → `target=314x50`
 * (a degenerate sliver took the canvas) → `target=3626x2330`, plus continuous
 * `target=` bursts — the `828x620 → 946x676 → 988x700 → 1010x716 → 1034x738`
 * staircase inside 300 ms and the `1168x2182 ↔ 1168x1554` oscillation — because
 * the loop rebuilt the canvas on every frame whose size differed at all. The
 * fix centralises the math in one pure function, `Resolve-SandboxTarget`, which
 * the helper both uses in its frame loop and exposes headlessly through
 * `-TargetDecision <json-path>`; this spec drives that probe — the real helper
 * script, no desktop, no frame loop.
 *
 * Fail-before semantics: before the fix the probe and the function do not
 * exist (the helper rejects the mode, the spawn exits non-zero, and the spec
 * fails at the first invocation), and the per-scenario expectations pin the
 * behaviour the old loop violated: it committed sub-floor targets, rebuilt on
 * every staircase step, and followed each oscillation.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = fileURLToPath(new URL('../sandbox/sandbox-host.ps1', import.meta.url))

/** One step fed to the probe: the candidate subject and the frame's clock. */
interface StepInput { hwnd: number; w: number; h: number; nowMs: number }
/** Committed target dimensions; hwnd 0 is the desktop fallback. */
interface Target { hwnd: number; w: number; h: number }
interface Pending { hwnd: number; w: number; h: number; count: number; firstMs: number }
interface Decision { action: 'commit' | 'hold'; reason: string; target: Target | null; pending: Pending | null }
interface Scenario { start: Target | null; steps: StepInput[] }

/**
 * Every scenario for one fixture invocation. The probe threads current and
 * pending state across a scenario's steps exactly as the frame loop does, so
 * multi-frame behaviour (staircase, oscillation, stability) is observable in a
 * single deterministic run.
 */
const SCENARIOS: Record<string, Scenario> = {
  // The logged 314x50 sliver with a subject tracked: hold the previous target.
  'below-floor-holds-previous': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [{ hwnd: 1, w: 314, h: 50, nowMs: 1000 }],
  },
  // First frame with a tiny subject and nothing to protect: clamp up to the floor.
  'below-floor-clamps-without-subject': {
    start: null,
    steps: [{ hwnd: 7, w: 100, h: 80, nowMs: 0 }],
  },
  // An identical retarget of the tracked subject is a no-op.
  'identical-retarget-is-noop': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [{ hwnd: 1, w: 800, h: 600, nowMs: 16 }],
  },
  // The logged staircase: a new size every frame must not commit until one
  // size holds still for three frames — exactly one commit at the end.
  'staircase-coalesces-to-one-commit': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [
      { hwnd: 1, w: 828, h: 620, nowMs: 0 },
      { hwnd: 1, w: 946, h: 676, nowMs: 100 },
      { hwnd: 1, w: 988, h: 700, nowMs: 200 },
      { hwnd: 1, w: 1010, h: 716, nowMs: 300 },
      { hwnd: 1, w: 1034, h: 738, nowMs: 400 },
      { hwnd: 1, w: 1034, h: 738, nowMs: 500 },
      { hwnd: 1, w: 1034, h: 738, nowMs: 600 },
    ],
  },
  // The logged oscillation: each flip restarts the wait, so nothing ever
  // commits and the canvas stays where it was.
  'oscillation-never-commits': {
    start: { hwnd: 1, w: 1168, h: 2182 },
    steps: [
      { hwnd: 1, w: 1168, h: 1554, nowMs: 0 },
      { hwnd: 1, w: 1168, h: 2182, nowMs: 300 },
      { hwnd: 1, w: 1168, h: 1554, nowMs: 600 },
      { hwnd: 1, w: 1168, h: 2182, nowMs: 900 },
    ],
  },
  // A normal, stable resize keeps its exact dimensions — the policy changes
  // nothing about real values, only about timing and junk.
  'normal-values-unchanged': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [
      { hwnd: 2, w: 1024, h: 1554, nowMs: 0 },
      { hwnd: 2, w: 1024, h: 1554, nowMs: 16 },
      { hwnd: 2, w: 1024, h: 1554, nowMs: 32 },
    ],
  },
  // A new subject at the same size follows immediately: the canvas already fits.
  'subject-swap-same-size-switches': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [{ hwnd: 2, w: 800, h: 600, nowMs: 16 }],
  },
  // Two frames spanning 500 ms commit on the time arm alone (frame count is 2).
  'stability-time-arm-bounds-low-fps': {
    start: { hwnd: 1, w: 800, h: 600 },
    steps: [
      { hwnd: 3, w: 1440, h: 900, nowMs: 0 },
      { hwnd: 3, w: 1440, h: 900, nowMs: 500 },
    ],
  },
  // A dead subject's degenerate fallback (0x0) must escape the floor hold.
  'degenerate-fallback-clamps': {
    start: { hwnd: 1, w: 1024, h: 1554 },
    steps: [{ hwnd: 0, w: 0, h: 0, nowMs: 100 }],
  },
}

const tempDir = mkdtempSync(join(tmpdir(), 'dsh-target-policy-'))
afterAll(() => { rmSync(tempDir, { recursive: true, force: true }) })

let flight: Promise<Record<string, Decision[]>> | undefined

/** One probe run for the whole file; every test reads its own scenario. */
function decisions(): Promise<Record<string, Decision[]>> {
  flight ??= runScenarios()
  return flight
}

function runScenarios(): Record<string, Decision[]> {
  const scenarioPath = join(tempDir, 'scenarios.json')
  writeFileSync(scenarioPath, JSON.stringify(SCENARIOS), 'utf8')
  const out = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-TargetDecision', scenarioPath],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  )
  expect(out.status, `probe failed: ${out.stderr}`).toBe(0)
  return JSON.parse(out.stdout.trim()) as Record<string, Decision[]>
}

describe('sandbox retarget policy', () => {
  it('holds the previous target when a candidate falls below the 320x240 floor', async () => {
    // Fail-before: the old loop accepted target=314x50 (logged) and rebuilt the
    // canvas around the sliver; with the policy absent this scenario file is
    // rejected by the helper and the run never parses.
    const results = await decisions()
    const [decision] = results['below-floor-holds-previous'] ?? []
    expect(decision).toMatchObject({
      action: 'hold',
      reason: 'below-floor',
      target: { hwnd: 1, w: 800, h: 600 },
      pending: null,
    })
  }, 60000)

  it('clamps a first-frame sub-floor subject up to the floor', async () => {
    const results = await decisions()
    const [decision] = results['below-floor-clamps-without-subject'] ?? []
    expect(decision).toMatchObject({
      action: 'commit',
      reason: 'clamped-floor',
      target: { hwnd: 7, w: 320, h: 240 },
    })
  }, 60000)

  it('treats an identical retarget of the tracked subject as a no-op', async () => {
    const results = await decisions()
    const [decision] = results['identical-retarget-is-noop'] ?? []
    expect(decision).toMatchObject({ action: 'hold', reason: 'near-identical', pending: null })
  }, 60000)

  it('coalesces the logged staircase into exactly one commit', async () => {
    // Fail-before: the old loop logged every step as its own target= line
    // (828x620 → 946x676 → 988x700 → 1010x716 → 1034x738 within 300 ms).
    const results = await decisions()
    const steps = results['staircase-coalesces-to-one-commit'] ?? []
    expect(steps).toHaveLength(7)
    expect(steps.filter((step) => step.action === 'commit')).toHaveLength(1)
    expect(steps[6]).toMatchObject({ action: 'commit', reason: 'stable', target: { hwnd: 1, w: 1034, h: 738 } })
    expect(steps.slice(0, 6).every((step) => step.action === 'hold')).toBe(true)
  }, 60000)

  it('never commits the logged oscillation and keeps the last stable target', async () => {
    // Fail-before: the old loop flipped the canvas 1168x2182 ↔ 1168x1554 with
    // every frame (the logged thrash); zero commits is the new invariant.
    const results = await decisions()
    const steps = results['oscillation-never-commits'] ?? []
    expect(steps).toHaveLength(4)
    expect(steps.every((step) => step.action === 'hold')).toBe(true)
    expect(steps.every((step) => step.target?.w === 1168 && step.target?.h === 2182)).toBe(true)
  }, 60000)

  it('commits a normal stable resize with its exact dimensions', async () => {
    const results = await decisions()
    const steps = results['normal-values-unchanged'] ?? []
    expect(steps.map((step) => step.action)).toEqual(['hold', 'hold', 'commit'])
    expect(steps[2]).toMatchObject({ reason: 'stable', target: { hwnd: 2, w: 1024, h: 1554 } })
  }, 60000)

  it('switches immediately when a new subject arrives at the same size', async () => {
    const results = await decisions()
    const [decision] = results['subject-swap-same-size-switches'] ?? []
    expect(decision).toMatchObject({ action: 'commit', reason: 'subject-swap', target: { hwnd: 2, w: 800, h: 600 } })
  }, 60000)

  it('commits on the 500 ms arm so a slow frame rate cannot stall a switch', async () => {
    // The second step is only the 2nd observation — the time arm, not the
    // 3-frame arm, is what commits it.
    const results = await decisions()
    const steps = results['stability-time-arm-bounds-low-fps'] ?? []
    expect(steps).toHaveLength(2)
    expect(steps[1]).toMatchObject({ action: 'commit', reason: 'stable', target: { hwnd: 3, w: 1440, h: 900 } })
  }, 60000)

  it('lets a dead subject escape the floor through the clamped fallback', async () => {
    // Without this arm a 0x0 fallback would be held over a dead subject and
    // the canvas would pin forever.
    const results = await decisions()
    const [decision] = results['degenerate-fallback-clamps'] ?? []
    expect(decision).toMatchObject({ action: 'commit', reason: 'clamped-floor', target: { hwnd: 0, w: 320, h: 240 } })
  }, 60000)
})
