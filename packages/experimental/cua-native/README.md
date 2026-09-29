---
description: "Spawns the prebuilt cua-helper.exe over stdio NDJSON to drive native COM UIA reads, SendInput synthesis, and Windows.Graphics.Capture frames for the gui-motor A/B benchmark."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua-native

English | [中文](README.zh.md)

## Summary

This package is the CodexNative GUI backend: a TypeScript client that spawns the prebuilt `cua-helper.exe` and speaks Codex's stdio NDJSON protocol to read live windows through native COM UIA, synthesize input with SendInput, and grab frames through Windows.Graphics.Capture. It exports the `GuiBackend` factory the gui-motor A/B benchmark loads, plus the raw `CuaHelperClient` surface (`get_window_state`, clicks, keys, secondary actions, capture). The helper builds offline from `native/cua/build.cmd`; consumers use the prebuilt binary and never compile. The package is Windows-only and experimental, with no stability guarantee.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Reach for this package when code must drive a real Win32 desktop the way Codex's computer-use helper does — comparative measurement in `benchmarks/gui-motor`, or a future GUI tool that needs live window state and real input. It is one of the two competing backends; the koffi/PInvoke alternative lives in `packages/bundle/deamon`.

### Entry point

```ts
import { createCodexNativeBackend } from '@deepseek-ai/dsh-experimental-cua-native'

const backend = createCodexNativeBackend() // spawns the helper once
const receipt = await backend.sendInput({ kind: 'mouseClick', windowId: 'main', x: 400, y: 300, button: 'left' })
await backend.client.close()
```

Success is a `{ delivered, detail }` receipt that reports what the OS actually accepted, a `readUia` snapshot whose element paths are stable across runs, and a `capture` frame whose region colors come from real pixels. Failure is loud: a missing helper binary names `native/cua/build.cmd`, an unknown `windowId` rejects with `CodexNative backend has no window`, and a crashed helper rejects every pending request with its exit code and stderr tail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Faithful replica.** The helper reproduces Codex's measured mechanism: native COM `IUIAutomation` raw-vtable walks in `uiautomationcore.dll`, `SendInput` synthesis (never posted messages), and `Windows.Graphics.Capture` frames through `Direct3D11CaptureFramePool` + `IGraphicsCaptureItemInterop`. GDI exists only as the documented fallback mode.
- **Prebuilt, standalone, offline.** `native/cua/build.cmd` compiles the helper with MSVC against system import libs only — no network, no cargo (none is installed), no `build.ts` involvement, nothing for consumers to compile.
- **One spawn, steady-state round trips.** The client spawns the helper at construction and stamps every request with `meta["x-oai-cua-request-budget-ms"]`, mirroring Codex's `helper_transport.js` (launch_app 15s, other methods 10s).

### Source map

| File | Role |
| --- | --- |
| [`src/adapter.ts`](src/adapter.ts) | `createCodexNativeBackend`: the `GuiBackend` factory with the capability descriptor |
| [`src/client.ts`](src/client.ts) | spawn + NDJSON request/response, typed errors, approval resend |
| [`src/protocol.ts`](src/protocol.ts) | encode/decode, per-method timeouts, `NdjsonDecoder` |
| [`native/cua/src`](../../../native/cua/src) | helper sources: COM UIA walk, SendInput, WGC + GDI fallback |

### Mechanisms and measured behavior

- **Reads** walk the Control View tree through `IUIAutomationTreeWalker`, assign `element_index` + a stable path (`AutomationId` else name-slug else index), and honor `disableDiff` for the never-diffed full subtree the benchmark scores.
- **Input** lands through `SendInput`; receipts report queued-event counts, the cursor position after a move, and whether the foreground actually transferred — focus transfer is polled through the target's message pump because activation completes a pump cycle after injection.
- **Capture** uses WGC window frames for window-space samples and the WGC monitor frame for desktop-space samples. On this build a fully occluded window yields no window-item frames, so the helper negative-caches that window and falls back to the PrintWindow blit for window pixels while desktop samples keep coming from the WGC monitor frame (`mode` + `desktopSource` report the split; an explicitly forced `gdi` request reports the `#000000` miss sentinel for desktop regions).
- **Build:** `cmd /c native/cua/build.cmd` → `native/cua/bin/cua-helper.exe`, copied to this package's `bin/` for `resolveHelperPath()`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [gui-motor benchmark](../../../benchmarks/gui-motor/README.md) — the A/B harness this backend plugs into and the scoring weights it must satisfy.
- [`native/cua`](../../../native/cua) — the helper's offline MSVC build and its three subsystems.
- Codex's `helper_transport.js` (measured by CodexGuiSpy) — the original wire protocol this package mirrors.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package registers no prompt, tool schema, or result text; consumers that surface GUI state to a model own every model-visible line.

#### KV Cache effect

No effect: nothing this package contributes enters a request prefix; KV-cache behavior belongs to the consumer that assembles prompts.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Current package constraints, not a comparison with other backends:

- **Windows-only, desktop-gated.** The real integration suite needs a live interactive desktop (`DSH_CUA_DESKTOP=1` on win32 with a built helper); the ungated lane covers protocol, spawn lifecycle, path resolution, and the capability descriptor only.
- **Occluded-window WGC is suppressed on this build.** Window-item frames arrive only while the window is visible on top (measured31–78ms foreground, never when occluded); the negative cache plus GDI window fallback keeps captures working, and desktop samples keep their WGC source.
- **The GDI fallback mode has no desktop pixels.** A window blit cannot see the taskbar or foreign overlays; those samples report the `#000000` miss sentinel by design.
- **Launch approval is protocol-only.** The helper can pause `launch_app` with an `approvalRequest` (armed by `CUA_REQUIRE_LAUNCH_APPROVAL=1`); the client surfaces a typed error — actual user-approval UX belongs to the approval slice.
- **`list_apps` lists running apps** (from live top-level windows), not an installed-app catalog; `launch_app` launches executables/paths/protocols, not Store AppUserModelIDs.
- **The helper binary is not committed.** It builds offline from source; CI or a developer must run `native/cua/build.cmd` before the desktop-gated suite.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Toolchain choice: no `cargo` exists on this machine, so the helper is C++/MSVC COM — the same raw-vtable `IUIAutomation` path windows-rs would generate. Rebuild with `cmd /c native/cua/build.cmd`; run the gated suite with `DSH_CUA_DESKTOP=1 pnpm exec vitest run desktop.integration`. After editing either README side: `pnpm run verify-translation-pairing --write packages/experimental/cua-native/README.md`.

</details>
