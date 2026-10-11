/**
 * Desktop-gated REAL A/B run: both real backends against the same live target
 * window (CodexNative on the interactive input desktop, NativeWin on its
 * private shellbox desktop — each engine's reachable domain), scored by the
 * same runner/scoring as the mock phase.
 *
 * Gate: win32 + DSH_D8_DESKTOP=1 + DSH_CUA_DESKTOP=1.
 *   DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts
 *
 * Element ground truth below is probe-pinned: observed on this machine from
 * each backend's own read (stable across repeated probes) plus designed values
 * the backend must report (the `metin` textbox value NativeWin currently omits
 * is deliberately part of its truth, so property accuracy scores the real gap).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FixtureElement, GuiFixture } from './src/fixture.ts'
import { createCodexNativeBackend } from './src/adapters/codex-native.adapter.ts'
import type { CodexNativeBackendHandle } from './src/adapters/codex-native.adapter.ts'
import { createNativeWinBackend } from './src/adapters/native-win.adapter.ts'
import type { NativeWinBackend } from './src/adapters/native-win.adapter.ts'
import { LIVE_WINDOW_TITLE, relativeToForm, spawnRealDesktopTarget, waitForProbe, writeTargetScript } from './src/live-target.ts'
import type { LiveProbe } from './src/live-target.ts'
import { formatComparison } from './src/report.ts'
import { runBackend } from './src/runner.ts'
import type { BackendResult, BenchmarkComparison } from './src/runner.ts'
import { DEFAULT_WEIGHTS, decideBest } from './src/scoring.ts'

/** The real run moves the physical cursor and composes a private desktop: gates required. */
const GATED = process.platform === 'win32'
  && process.env.DSH_D8_DESKTOP === '1'
  && process.env.DSH_CUA_DESKTOP === '1'

if (!GATED) {
  console.error(
    'gui-motor real run refused: needs a live Win32 desktop with\n'
    + '  DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts\n'
    + 'Run `pnpm exec tsx protop/shellbox/gui-motor/run.ts` for the mock-phase verdict.',
  )
  process.exit(2)
}

/** Iterations per operation class on the live desktop (real spawns cost seconds; explicit generous budget). */
const LIVE_ITERATIONS = 6

/** Expected capture anchors: colors this run painted into the target itself. */
const LIVE_REGIONS = [
  { name: 'accent', scope: 'window' as const, color: '#2b6cb0' },
  { name: 'formbg', scope: 'window' as const, color: '#1e1e1e' },
]

/** CodexNative observed tree (COM UIA, screen-absolute bounds, titlebar chrome included by the helper). */
function codexElements(): FixtureElement[] {
  const w = LIVE_WINDOW_TITLE
  return [
    { windowId: w, path: `/${w}`, name: w, bounds: { x: 40, y: 40, width: 640, height: 480 } },
    { windowId: w, path: `/${w}/pane/accent`, name: '', bounds: { x: 73, y: 118, width: 240, height: 90 } },
    { windowId: w, path: `/${w}/pane/edit`, name: '', bounds: { x: 73, y: 228, width: 360, height: 70 } },
    { windowId: w, path: `/${w}/pane/edit/edit/username`, name: '', value: 'metin', bounds: { x: 81, y: 236, width: 340, height: 31 } },
    { windowId: w, path: `/${w}/button/ok`, name: 'OK', bounds: { x: 73, y: 318, width: 100, height: 36 } },
    { windowId: w, path: `/${w}/text/status`, name: 'Ready', bounds: { x: 73, y: 378, width: 200, height: 30 } },
    { windowId: w, path: `/${w}/text/hello`, name: 'gui-motor live', bounds: { x: 73, y: 418, width: 240, height: 30 } },
    { windowId: w, path: `/${w}/titlebar/7`, name: '', value: w, bounds: { x: 85, y: 43, width: 582, height: 55 } },
    { windowId: w, path: `/${w}/titlebar/7/menubar/MenuBar`, name: 'Sistem', bounds: { x: 53, y: 53, width: 44, height: 44 } },
    { windowId: w, path: `/${w}/titlebar/7/menubar/MenuBar/menuitem/sistem`, name: 'Sistem', bounds: { x: 53, y: 53, width: 44, height: 44 } },
    { windowId: w, path: `/${w}/titlebar/7/button/simge-durumuna-klt`, name: 'Simge Durumuna Küçült', bounds: { x: 388, y: 41, width: 94, height: 57 } },
    { windowId: w, path: `/${w}/titlebar/7/button/ekran-kapla`, name: 'Ekranı Kapla', bounds: { x: 482, y: 41, width: 92, height: 57 } },
    { windowId: w, path: `/${w}/titlebar/7/button/kapat`, name: 'Kapat', bounds: { x: 574, y: 41, width: 94, height: 57 } },
  ]
}

/** NativeWin observed tree (managed UIA walk: content controls only, root-relative bounds; designed value included). */
function nativeWinElements(): FixtureElement[] {
  const w = LIVE_WINDOW_TITLE
  return [
    { windowId: w, path: `/${w}`, name: w, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { windowId: w, path: `/${w}/pane-1`, name: '', bounds: { x: 33, y: 78, width: 240, height: 90 } },
    { windowId: w, path: `/${w}/pane-2`, name: '', bounds: { x: 33, y: 188, width: 360, height: 70 } },
    { windowId: w, path: `/${w}/metin`, name: 'metin', value: 'metin', bounds: { x: 41, y: 196, width: 340, height: 31 } },
    { windowId: w, path: `/${w}/ok`, name: 'OK', bounds: { x: 33, y: 278, width: 100, height: 36 } },
    { windowId: w, path: `/${w}/ready`, name: 'Ready', bounds: { x: 33, y: 338, width: 200, height: 30 } },
    { windowId: w, path: `/${w}/gui-motor-live`, name: 'gui-motor live', bounds: { x: 33, y: 378, width: 240, height: 30 } },
  ]
}

/** One backend's live fixture: same window id and capture anchors, its own element truth. */
function liveFixture(id: string, elements: FixtureElement[], bounds: { x: number; y: number; width: number; height: number }): GuiFixture {
  return {
    id,
    primaryWindowId: LIVE_WINDOW_TITLE,
    windows: [
      {
        id: LIVE_WINDOW_TITLE,
        title: LIVE_WINDOW_TITLE,
        bounds,
        ignoresPostedMessages: false,
        elevated: false,
      },
    ],
    elements,
    regions: LIVE_REGIONS,
  }
}

const directory = mkdtempSync(join(tmpdir(), 'gui-motor-real-'))
const script = writeTargetScript(directory)
let target: ChildProcess | undefined
let codex: CodexNativeBackendHandle | undefined
let nativewin: NativeWinBackend | undefined

try {
  const realProbe = await waitForProbeFile(spawnRealDesktopTarget(script, join(directory, 'probe-real.json')), join(directory, 'probe-real.json'))
  const accentRel = relativeToForm(realProbe, realProbe.controls.accent)
  const regions = [
    { name: 'accent', scope: 'window' as const, x: accentRel.x, y: accentRel.y },
    { name: 'formbg', scope: 'window' as const, x: realProbe.form.w - 30, y: realProbe.form.h - 30 },
  ]
  const bounds = { x: realProbe.form.x, y: realProbe.form.y, width: realProbe.form.w, height: realProbe.form.h }

  codex = createCodexNativeBackend({ regions })
  const codexFixture = liveFixture('gui-motor-live-codex', codexElements(), bounds)
  console.log(`[live] codex-native up; running ${String(LIVE_ITERATIONS)} iterations on the input desktop...`)
  const codexResult = await timed('codex-native', () => runBackend(codex!, codexFixture, { iterations: LIVE_ITERATIONS }))

  const nwProbePath = join(directory, 'probe-nw.json')
  nativewin = createNativeWinBackend({
    screenWidth: realProbe.screen.w,
    screenHeight: realProbe.screen.h,
    windowRect: bounds,
    regions,
  })
  if (!nativewin.launch(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -ProbePath "${nwProbePath}"`)) {
    throw new Error('gui-motor: NativeWin engine refused the target launch.')
  }
  await waitForProbe(nwProbePath, 30_000)
  const nwFixture = liveFixture('gui-motor-live-nativewin', nativeWinElements(), bounds)
  console.log(`[live] nativewin up on ${nativewin.desktopName}; running ${String(LIVE_ITERATIONS)} iterations...`)
  const nwResult = await timed('nativewin', () => runBackend(nativewin!, nwFixture, { iterations: LIVE_ITERATIONS }))

  const results: BackendResult[] = [codexResult, nwResult]
  const verdict = decideBest(results, DEFAULT_WEIGHTS)
  const comparison: BenchmarkComparison = {
    fixtureId: 'gui-motor-live-target',
    iterations: LIVE_ITERATIONS,
    results,
    verdict,
  }
  console.log(formatComparison(comparison))
  console.log('')
  console.log(JSON.stringify(comparison, null, 2))
} finally {
  try {
    await nativewin?.close()
  } catch (error) {
    console.error('[live] nativewin close failed:', String(error))
  }
  try {
    await codex?.client.close()
  } catch (error) {
    console.error('[live] codex close failed:', String(error))
  }
  if (target !== undefined && target.pid !== undefined) {
    try {
      process.kill(target.pid)
    } catch {
      // target may already be gone
    }
  }
  await delay(500)
  rmSync(directory, { recursive: true, force: true })
}

/** Spawn the real-desktop target and wait for its geometry probe. */
async function waitForProbeFile(child: ChildProcess, probePath: string): Promise<LiveProbe> {
  target = child
  return waitForProbe(probePath, 20_000)
}

/** Log one backend's wall time so the report can explain slow legs. */
async function timed(label: string, run: () => Promise<BackendResult>): Promise<BackendResult> {
  const started = Date.now()
  const result = await run()
  console.log(`[live] ${label} finished in ${String(Math.round((Date.now() - started) / 1000))}s`)
  return result
}
