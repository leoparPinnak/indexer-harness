# gui-motor — comparative A/B benchmark for GUI-automation backends

English | [中文](README.zh.md)

This harness is the decision mechanism for "hangisi en iyi → varsayılan": it measures candidate GUI-automation backends on speed and native fidelity, scores every metric with a weight, and prints a default-vs-fallback verdict. Two backends compete: the koffi FFI + PowerShell P/Invoke backend (`NativeWin`, wired to the deamon engine) and the native COM UIA + SendInput backend (`CodexNative`, wired to `packages/experimental/cua-native`). Whichever tests best becomes the default; the other becomes the fallback.

Two phases: the MOCK phase (clearly labeled `MOCK` in every result, table row, and JSON document) runs anywhere with no live desktop, and the REAL phase drives real Win32 windows behind desktop gates on a live workstation.

## Layout

- `src/backend.ts` — the pluggable `GuiBackend` interface: `sendInput(op)`, `readUia(selector)`, `capture(target)`, plus the `GuiCapabilities` descriptor (`nativeInjection`, `comUia`, `capturesWinRt`).
- `src/fixture.ts` — `GUI_MOTOR_FIXTURE`: three target windows (normal, drops-posted-messages, elevated), ten ground-truth elements, five expected capture regions; plus helpers the runner derives scenarios from.
- `src/mocks/` — the two MOCK backends (`createKoffiMockBackend`, `createCodexNativeMockBackend`) plus the virtual clock used for deterministic measurement.
- `src/runner.ts` — N-iteration runner: per-operation median/p95 latency and four fidelity ratios against ground truth.
- `src/scoring.ts` — weighted composite and the `decideBest` verdict (default, fallback, per-criterion rationale).
- `src/report.ts` — the printed result table; the comparison document also serializes to JSON unchanged.
- `src/adapters/` — the REAL backend adapters: `native-win.adapter.ts` drives the deamon engine's local routes (`handleSandboxInputLocal` in `send` mode, `handleSandboxUiaLocal`, one-shot `-CaptureOnce` frames sampled through `png-region.ts`); `codex-native.adapter.ts` delegates to `createCodexNativeBackend` from `@deepseek-ai/dsh-experimental-cua-native`.
- `src/live-target.ts` — the deterministic WinForms target (known colors/text), its device-pixel geometry probe, and spawn helpers for both desktops.
- `src/png-region.ts` — minimal PNG decode + region sampling for the NativeWin capture path.
- `run.ts` — the mock-phase comparison: `pnpm exec tsx protop/shellbox/gui-motor/run.ts`.
- `run-real.ts` — the desktop-gated real comparison: `DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts`.
- `tests/` — unit proofs: `pnpm exec vitest run gui-bench`.

## Running

- `pnpm exec tsx protop/shellbox/gui-motor/run.ts` — scores both MOCK backends, prints the result table followed by the JSON comparison document, and ends with `verdict: <x> = default, <y> = fallback`.
- `pnpm exec vitest run gui-bench` — runs the unit proofs (virtual clock, so they finish instantly and stay inside the 15s testTimeout belt), including conformance construction of both REAL adapters.
- `DSH_D8_DESKTOP=1 DSH_CUA_DESKTOP=1 pnpm exec tsx protop/shellbox/gui-motor/run-real.ts` — the real A/B on a live Win32 desktop. It refuses to run (exit 2) without both gates; it moves the physical cursor and composes a private shellbox desktop, so run it on an interactive workstation, not a headless CI lane.

## What is measured

Latency is the wall-clock round trip of one call, sampled for every iteration of every operation class and reported as median + p95 (nearest rank):

- `sendInput` — synthesize a mouse move/click/key against the target window(s).
- `readUia` — walk the window's element subtree.
- `capture` — grab one frame of the target.

Fidelity is pooled across all iterations as 0..1 ratios against fixture ground truth:

- `inputReach` — delivered input attempts ÷ attempts (does synthesized input actually land, including on windows that drop posted messages or are elevated).
- `uiaCompleteness` — found ground-truth elements ÷ ground-truth elements.
- `uiaPropertyAccuracy` — correct name/value/bounds observations ÷ compared observations over the elements that were found.
- `captureFidelity` — regions matching their expected color ÷ expected regions (a missed region reports the black sentinel).

## Scoring and the decision procedure

Every metric carries a weight in `DEFAULT_WEIGHTS` (speed 0.35, native fidelity 0.65; the seven weights sum to 1 and are normalized defensively; `inputReach` is the top single weight because SendInput reach on ignore-posted/elevated windows is the primary native differentiator):

| metric | weight | raw value | score |
| --- | --- | --- | --- |
| `sendInputLatency` | 0.10 | p95 ms | `best p95 / p95` |
| `readUiaLatency` | 0.15 | p95 ms | `best p95 / p95` |
| `captureLatency` | 0.10 | p95 ms | `best p95 / p95` |
| `inputReach` | 0.25 | 0..1 ratio | raw |
| `uiaCompleteness` | 0.15 | 0..1 ratio | raw |
| `uiaPropertyAccuracy` | 0.10 | 0..1 ratio | raw |
| `captureFidelity` | 0.15 | 0..1 ratio | raw |

The composite is the weight-sum of the per-metric scores. Decision procedure: the higher composite wins the `default` slot, the runner-up is the `fallback`, an exact composite tie is broken by total fidelity, and a tie that survives the tie-break throws (rerun with more iterations or review the weights). The rationale names the winner of every criterion, so "backend X wins on <criteria>" is part of the verdict.

To reweight the rubric, pass a `ScoreWeights` object to `runComparison` or `decideBest`; non-positive or non-finite weights fail loud.

## The real backends (wired)

Both adapters are connected to their engines; the harness, runner, scoring, and report are identical across phases:

- **CodexNative** — `createCodexNativeBackend(options?)` returns the `@deepseek-ai/dsh-experimental-cua-native` backend: SendInput synthesis (receipts carry real landing plus the focus fact), `get_window_state` with `disableDiff` mapped to `readUia` (`element_index` → `UiaElement.path`), WGC region sampling for `capture`. The helper spawns once at construction; spawn + pipe setup is excluded from per-op samples (steady-state round trips only), and the caller owns `backend.client.close()`.
- **NativeWin** — `createNativeWinBackend(options?)` drives the deamon engine over a bench-local session (`persistencePath: false`, desktop `dsh-sb-guibench`): input batches through the engine's own route in opt-in `send` mode (real `SendInput` on the private desktop), accessibility through the engine's `uia` sidecar walk + `parseUiaResult` clamp (managed .NET UIA), capture through the helper's one-shot `-CaptureOnce` PNG path (spawn-inclusive; the engine's streaming frame path is JPEG and is not sampled), windows resolved through the engine's `.state` snapshot. `launch()` starts the helper and places the target on the private desktop; `close()` stops it.

Capability descriptors under test: CodexNative `true/true/true` (SendInput, raw COM UIA vtable, WGC Direct3D11CaptureFramePool); NativeWin `true/false/false` (SendInput opt-in, managed .NET UIA rather than the raw COM vtable, GDI ladder rather than WGC).

## Measured result (this workstation, 2026-09-29, live gates)

6 iterations per operation, both backends against the same live target (`gui-motor-live-target`; CodexNative on the input desktop, NativeWin on its private desktop):

| backend | sendInput med/p95 | readUia med/p95 | capture med/p95 | reach | tree | props | frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CodexNative (COM UIA + SendInput + WGC) | 1.2/21.4ms | 44.4/71.7ms | 475.9/504.1ms | 1.00 | 1.00 | 1.00 | 1.00 |
| NativeWin (SendInput + managed UIA + GDI) | 1.4/5.4ms | 35.3/156.9ms | 683.9/710.8ms | 1.00 | 1.00 | 0.89 | 1.00 |

Verdict: **codex-native = default, nativewin = fallback** (composite 0.93 vs 0.88). CodexNative wins readUia latency (p95), capture latency, and property accuracy (NativeWin's managed walk omits the textbox value); NativeWin wins sendInput p95; reach, completeness, and capture fidelity tie at 1.00 on both.

Measurement disclosures for this run: NativeWin `inputReach` is the engine's own contract (batch staged to the helper in `send` mode) while CodexNative reports confirmed input-queue landing plus focus transfer; NativeWin `capture` includes the one-shot PowerShell spawn; NativeWin completeness is scoped to the seven content controls (its managed walk does not enumerate non-client titlebar chrome, which CodexNative's truth includes); element bounds are pinned to each backend's observed coordinate space (the managed helper reports root-relative bounds). Every fidelity metric and every latency sample above required the live desktop; the mock phase reproduces the mechanism contrast without one.

## Plugging in or changing a backend

1. The contract is `GuiBackend` (`src/backend.ts`); a backend implements the three methods and declares a truthful `GuiCapabilities` descriptor + `mock: false`.
2. Adapters live in `src/adapters/` — that is the only file that changes when an engine's call surface moves; the harness, runner, scoring, and report never do.
3. Run both phases: the mock verdict any time, the real verdict under the two desktop gates; `runComparison([...], fixture, { iterations })` and `decideBest(results, weights)` compose into any other harness.

## Notes

- The MOCK profiles encode the measured real-world expectation: the koffi/PowerShell interop path is slower per-op (FFI/marshaling on every call) and lossy (message injection misses ignore-posted/elevated windows, GDI frames black out taskbar/foreign regions), while the native helper is faster per-op with full reach, completeness, and capture fidelity. They are reviewed synthetic constants, replaced by measurement the moment a real backend plugs in; weight sensitivity itself is proven by the scoring unit test.
- The runner runs backends sequentially on purpose: concurrent backends would contend and corrupt latency samples.
- Per the benchmarks AGENTS.md, keep scenario support inside `gui-motor/` until a second benchmark directory needs it.
