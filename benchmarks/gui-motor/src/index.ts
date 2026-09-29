/**
 * gui-motor: comparative A/B benchmark harness for GUI-automation backends.
 * Public surface for the harness — the `GuiBackend` seam, fixture, runner,
 * scoring, mocks, and the adapter stubs the real backends plug into.
 */

export type {
  Bounds,
  CaptureFrame,
  CaptureTarget,
  GuiBackend,
  GuiCapabilities,
  InputOp,
  InputReceipt,
  MouseButton,
  UiaElement,
  UiaSelector,
  UiaTreeSnapshot,
} from './backend.ts'
export { CAPTURE_BLACK } from './backend.ts'

export type { FixtureElement, FixtureRegion, FixtureWindow, GuiFixture } from './fixture.ts'
export { GUI_MOTOR_FIXTURE, fixtureElements, fixtureWindow, inputScenarioOps } from './fixture.ts'

export type { BackendResult, BenchmarkComparison, LatencyStats, RunnerOptions } from './runner.ts'
export { median, p95, runBackend, runComparison } from './runner.ts'

export type { MetricName, MetricScore, ScoreWeights, Verdict } from './scoring.ts'
export { DEFAULT_WEIGHTS, METRIC_NAMES, decideBest } from './scoring.ts'

export { formatComparison } from './report.ts'

export type { LatencyRange, MockHooks, MockProfile } from './mocks/mock-backend.ts'
export {
  CODEX_NATIVE_MOCK_PROFILE,
  KOFFI_MOCK_PROFILE,
  createCodexNativeMockBackend,
  createKoffiMockBackend,
  createMockGuiBackend,
} from './mocks/mock-backend.ts'

export type { VirtualClock, Wait } from './mocks/clock.ts'
export { createVirtualClock, realTimerWait } from './mocks/clock.ts'

export type { NativeWinBackend, NativeWinBackendOptions, NativeWinRegionSample } from './adapters/native-win.adapter.ts'
export { NATIVE_WIN_CAPABILITIES, NATIVE_WIN_IDENTITY, createNativeWinBackend } from './adapters/native-win.adapter.ts'
export type { CodexNativeBackendHandle } from './adapters/codex-native.adapter.ts'
export { createCodexNativeBackend } from './adapters/codex-native.adapter.ts'

export type { LiveProbe } from './live-target.ts'
export { LIVE_WINDOW_TITLE } from './live-target.ts'
