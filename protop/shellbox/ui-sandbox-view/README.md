---
description: "The right Sidebar's sandbox tab type for the dsh web client: a live view of the private Windows desktop a host helper publishes over WebSocket frame messages, with the pane's pixel size reported back to that helper, captured pointer and keyboard input forwarded to it, and its window list and unreviewed-change badge beside the stream."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sandbox-view

English | [中文](README.zh.md)

## Summary

The right Sidebar's sandbox tab type: the live Windows desktop a host helper publishes, drawn as one image scaled to the pane from one WebSocket message per JPEG. It is a page type reached from the guide and claims no address; it reports the pane's pixel size to the helper so the desktop composites at the panel's own shape. Its input control turns the same pane into a control surface, forwarding captured pointer, wheel, and keyboard events, and it lists the desktop's windows beside the stream. Nothing in `ui-sidebar-right` knows this package.

## Table of Contents

- [What it registers](#what-it-registers)
- [The stream](#the-stream)
- [Input and windows](#input-and-windows)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `sandbox`, id `@deepseek-ai/dsh-client-ui-sandbox-view`, band `extension`, no address patterns, and no guide entry.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: one `<img>` painted from the host's `/api/server/sandbox/ws` frame messages (one object URL per JPEG), fitted with `object-fit: contain`, a toolbar carrying the target picker, the input control, the change badge, the frame-rate badge, and the refresh and stop actions, the live-process overlay, and a one-line notice in the image's place when the socket cannot connect.
- **The chip title** — the keyed `sidebar.right.pane.tab.title` seat under that id: a monitor glyph at 16px before the type's label.

Source files under `src/client/`: `definition.ts` (the type), `SandboxBody.tsx` (the stream, the size report, and the input capture), `SandboxTitle.tsx` (the chip title), `inputCapture.ts` (frame-pixel conversion and the event batch), `LiveProcessesWidget.tsx` (the window list), plus `locales.ts` (what it says) and `index.ts` (the wiring).

<a id="the-stream"></a>
## The stream

The host route starts the sandbox helper when needed and delivers each frame as one binary WebSocket message, which the browser paints into the image through an object URL; this package never reads a byte of it. The helper, its desktop, and every route are the frozen contract in `packages/bundle/deamon/sandbox/PROTOCOL.md`.

A frame socket can close or go silent, so the body watches the one-second `/api/server/sandbox/status` poll: once the measured frame rate has been zero for four seconds it builds a fresh socket, backing off from one second to fifteen, and a recovered stream resets the ladder. A socket that errors or closes outright is retried three times two seconds apart before the load notice appears.

A `ResizeObserver` on the body reports the pane's rounded CSS-pixel size through a debounced `POST /api/server/sandbox/size` with `{"width": <n>, "height": <n>}`, clamped to 320x240 through 3840x2160 and skipped when it repeats the size last observed, so dragging the pane lands as one request. The observer and any pending timer are released on unmount. A refused report is swallowed: the helper keeps its previous viewport and the next resize asks again, so there is nothing to show the reader.

<a id="input-and-windows"></a>
## Input and windows

The pane's input control starts off. Turning it on focuses the stream image, so pointer, wheel, and keyboard events reach the desktop instead of the page: the pane scales each position from the rendered image into the frame's own pixels, clamps it to 0..5120, and posts one JSON batch to `POST /api/server/sandbox/input`, which the host spools as commands for the helper. Pointer moves coalesce into one trailing position every 40 milliseconds and a batch is delivered at 60 events; wheel steps arrive as pixels (a line or page delta is expanded first) after a synthetic move, and keyboard input forwards `keydown`/`keyup` key codes, dropping any code outside 1..254. Composed IME text becomes one `char` event per UTF-16 code unit. Losing focus, unmounting, or switching instance releases every held key and button through the same route, so nothing stays pressed on the desktop. A refusal is drawn as a status line, and the host refuses input aimed at the real desktop.

The live-process overlay polls `GET /api/server/sandbox/windows` every three seconds and lists each visible window with its title, executable, and process id, offering the focus and close actions that post the same instance scope plus the window handle to `/api/server/sandbox/windows/focus` and `/api/server/sandbox/windows/close`. The change badge reads `GET /api/server/sandbox/changes` with `since=0&limit=1` for the ring cursor and compares it with the cursor this browser already reviewed, held per session under a `localStorage` key; clicking it records the current cursor. That read advances no cursor of the model's, so the badge is a browser-local fact only.

<a id="model-experience"></a>
## Model Experience

None, as this package draws a live sandbox stream in the browser and registers nothing model-facing.

#### KV Cache effect

None; the pane-size report travels over the Web host's own route and assembles no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Windows helper only.** The stream needs the private-desktop helper the Web host starts on Windows; on any other host the route is absent and the body shows its load notice.
- **Input is posted messages, not synthetic system input.** The control reaches a window's message queue through the helper's own desktop; a program that reads the hardware state directly sees nothing, and a secure-desktop prompt cannot be answered.
- **The real desktop stays read-only.** The host refuses every input route aimed at the host's own desktop, whatever the pane sends.
- **Reachability follows registration.** Whether the tab exists at all is decided by the profile that mounts this package; the shipped bundles do not mount it.
- **No hardware GPU acceleration.** The isolated Win32 desktop has no physical display adapter attached and does not support hardware GPU acceleration (OpenGL/Vulkan/Direct3D swapchains). 3D applications and emulators must use software rendering (e.g. SwiftShader) or headless mode.
- **A silent open socket is not detected.** A socket that closes or errors reconnects on its own; one that stays open without delivering frames while the helper still serves other viewers keeps the measured rate above zero, so nothing reconnects until the refresh button asks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The body's runtime state is the pane size last observed, the reconnect bookkeeping, the input toggle with its batches, and the reviewed change cursor, all owned by the mounted component and released with its observer, timers, and listener; there is no second observation of them to compare against.
