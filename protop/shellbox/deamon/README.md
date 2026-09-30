---
description: "The Shellbox desktop feature for dsh: an isolated private Windows desktop streamed live into the Web GUI, launched, reviewed, and driven from the model and documented by a bundled skill."
kind: "package-bundle"
---

# @deepseek-ai/dsh-deamon

English | [中文](README.zh.md)

## Summary

Install the Daemon desktop as its own profile layer: an isolated private Win32 desktop streamed live into the dsh Web GUI's right-sidebar Daemon tab, launched, reviewed, and driven from the model through the `shellbox_launch`, `shellbox_state`, and `shellbox_input` tools, and documented for the model by a bundled `shellbox` skill. The bundle is one patch (the `deamon` host row plus the `ui-sandbox-view` browser row) and one runtime plugin (frame routes, WebSocket feed, helper daemon, tools, skill, prompt sections). Hand it to another machine's profile with `dsh plugin --profile <name> add <package>`; it needs a profile that already mounts the web-server layer (`dsh-web-app`).

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

Add the layer to a web profile and start it:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-deamon
dsh --profile web
```

No shipped template names the bundle (the feature retired on 2026-09-30 — see [the retirement note](../../../.agents/notes/implemented/simplification/2026-09-30-shellbox-retired-to-protop.md)), so every profile takes the `dsh plugin` command above (tarball and git package specs work the same way — see [publish.md](../../../docs/user/develop/basic/publish.md)). Verify the layer with `dsh --profile web --dump-config`, which prints a `# == @deepseek-ai/dsh-deamon` section.

### Configuration

The one field — most users never set it:

| Field | Default | Meaning |
|---|---|---|
| `surfaceContext` | `true` | Register the model-visible `app:shellbox-surface` and `app:shellbox-changes` prompt sections |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-deamon) is the exhaustive source for every accepted field and its JSDoc.

### What gets mounted

- Routes under `/api/server/sandbox/*` plus the `GET /api/server/sandbox/ws` WebSocket frame feed, all behind Connection's Host/Origin fence.
- One shared helper daemon on loopback (default port 4005, `DEAMON_PORT` to pin) spawning `sandbox/sandbox-host.ps1` per desktop.
- The model tools `shellbox_launch`, `shellbox_state`, and `shellbox_input`, the bundled `shellbox` skill, and the `app:shellbox-surface` and `app:shellbox-changes` prompt sections.
- The `ui-sandbox-view` browser row: the right-sidebar Daemon tab.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch plus one runtime plugin. The patch inserts two rows; the plugin injects `webServer`, mounts the route surface, then defers the skill registration on `skills` and the prompt section on `systemPrompt`, so profiles lacking those registries still get the desktop routes. The `shellbox_launch` tool registers the same deferred way on `tools`; `shellbox_state` and `shellbox_input` register there too, drive an awaited `agent/pre-step` change pull, and fold desktop changes into the `shellbox` projection on `sessionProjections`.

### Stream path

A stream request reaches the daemon through `DeamonManager.ensureRunning`, which re-attaches from the discovery file or spawns fresh; the daemon owns capture and serves both the legacy multipart face and per-session frame endpoints. The WebSocket route reassembles each multipart part and sends one binary message per JPEG.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `deamon` plugin: route mount, skill provider, prompt section, config gate |
| [`src/sandbox.ts`](src/sandbox.ts) | Route surface, WebSocket feed, session/instance managers, `shellbox_launch` tool |
| [`src/shellbox-changes.ts`](src/shellbox-changes.ts) | Change pull seam, `shellbox` projection, `shellbox_state` + `shellbox_input` tools |
| [`src/deamon.ts`](src/deamon.ts) | The standalone loopback capture daemon |
| [`src/deamon-manager.ts`](src/deamon-manager.ts) | One shared daemon per process: start, re-attach, forward |
| [`src/skill.ts`](src/skill.ts) | The bundled `shellbox` skill provider |
| [`sandbox/sandbox-host.ps1`](sandbox/sandbox-host.ps1) | The PowerShell capture helper (published beside `lib/`) |
| [`sandbox/PROTOCOL.md`](sandbox/PROTOCOL.md) | The frozen helper and HTTP/WS wire format |
| [`cordis.patch.yml`](cordis.patch.yml) | The layer: `deamon` host row plus `ui-sandbox-view` browser row |
| — | No runtime invariant companion is published; every registration (routes, tools, skill provider, prompt sections) is registry-disposed with the fiber, and each owning registry's package carries that relation's invariant; the plugin itself keeps no mutable state of its own to audit. |
| [`tests/sandbox-routes.spec.ts`](tests/sandbox-routes.spec.ts) | Route surface, WebSocket feed, daemon forwarding |
| [`tests/deamon.spec.ts`](tests/deamon.spec.ts) | Daemon lifecycle and manager forwarding |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | The patch boots through a real Loader tree |
| [`tests/skill.spec.ts`](tests/skill.spec.ts) | Skill candidate and body load |
| [`tests/shellbox-state.spec.ts`](tests/shellbox-state.spec.ts) | Change-awareness pull, projection, prompt line, and tool contracts |
| [`tests/nativewin.spec.ts`](tests/nativewin.spec.ts) | Input-mode grammar and caps, `uia` clamping, frozen-protocol edits, compiled SendInput layout and input-desktop gate |
| [`tests/d8-desktop.spec.ts`](tests/d8-desktop.spec.ts) | Gated live-desktop harness for the `uia` walk and the composite (`DSH_D8_DESKTOP=1`) |

### Invariant ownership

No invariant companion is published because every contribution — the routes, the tools, the skill provider, and the prompt sections — is registry-disposed with the fiber, and each owning registry package carries that relation's invariant.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the browser surface, or the skill system.

- [Bundle package map](../../../packages/bundle/README.md) — the surfaces built on the same core.
- [dsh-web-app](../../../packages/bundle/web-app/README.md) — the browser layer this row mounts on.
- [skill](../../../packages/skill/skill/README.md) — how bundled skills reach the model catalog.
- [ui-sandbox-view](../ui-sandbox-view/README.md) — the browser pane this layer seats.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-deamon) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Shellbox surface context, tools, and skill

#### What the model sees

When `surfaceContext` is true, two sections register: `app:shellbox-surface` (order 10105, directly after `app:web-surface`) orients the model to the Shellbox tab, the `shellbox_launch` tool, the full-authority desktop (window inspection and control plus win32 mouse/keyboard input; host-desktop input is refused), the no-GPU and console-window rules, and points at the `shellbox` skill for the full manual; `app:shellbox-changes` (order 10106) adds one line while the session log holds unreviewed desktop changes and disappears once a complete `shellbox_state` read acknowledges them. When the `tools` registry is present the three schemas register like any other tool: `shellbox_launch` (command, sessionId, instanceId), `shellbox_state` (sessionId, instanceId, since, limit), and `shellbox_input` (sessionId, instanceId, steps); an awaited `agent/pre-step` pull commits desktop changes to the session log before the prompt line is derived, so the warning and the tool read come from the same cursor. When the profile mounts a skill catalog loader, the `shellbox` skill appears as one `<available_skills>` line and its body loads on demand through the `skill` tool — or by the user typing `/shellbox`. When `surfaceContext` is false, neither section is registered; the tools and skill are unaffected.

#### Token effect

Two short prompt sections plus three tool schemas when tools are registered; the `app:shellbox-changes` line appears only while the session log holds unreviewed changes, so clean sessions pay one empty section. The skill contributes one catalog line until loaded. Constant per process.

#### KV Cache effect

The sections follow `app:web-surface` in a fixed order, so the preceding prefix stays stable across sessions with the same tools and configuration; the changes line appears only when unreviewed entries exist, and provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you what to expect in unusual setups. They are current package constraints, not a task backlog.

- **Windows-only capture** — the helper is a PowerShell/Win32 component; the routes mount everywhere but a stream only exists on Windows.
- **Needs the web-server layer** — the row injects `webServer`; a profile without `dsh-web-app` leaves the layer unmounted.
- **The skill needs a catalog loader** — presets without `tool-skill` (e.g. `minimal`) never show the `shellbox` line, so the manual is only reachable as `/shellbox` in a profile that mounts the user-invocable loader.
- **Foreground is capture-order** — the helper fits the currently top window into the viewport and never calls `SetForegroundWindow`; which window appears depends on the desktop's z-order at pick time.
- **Instance records persist** — `$DSH_HOME/sandbox-instances.json` survives restarts and can list stale instances; desktop names truncate at 16 characters, so long session ids rely on a collision suffix.
- **The desktop never idles out** — after every viewer leaves, capture keeps running; only `POST /api/server/sandbox/stop`, an instance terminate, or a server shutdown ends it.
- **Change awareness needs `sessionProjections`** — a profile without the projection registry never logs desktop changes, and `shellbox_state` fails with an explicit message instead of guessing.
- **Input needs a running desktop helper** — `shellbox_input` reports the no-helper message until a win32 shellbox desktop is up; host-desktop input is always refused.
- **Send-mode input is gated, and delivery stops at the focus wall** — a `mode:"send"` batch injects only when the session's input desktop *is* the sandbox desktop (measured refusal on a normal session, so nothing can ever reach the user's real desktop), and even in that branch the OS focus policy keeps end-to-end delivery on the `post` path; `POST /api/server/sandbox/uia` answers a bounded accessibility read. Measurements live in `sandbox/PROTOCOL.md`.
- **Desktop profiles add it on demand** — the shipped desktop profile lists `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` only; run `dsh plugin --profile <desktop-profile> add @deepseek-ai/dsh-deamon` to mount this bundle there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature lived in `dsh-web-app` (`src/sandbox.ts` and friends) until it moved here as one distributable layer. The `/api/server/sandbox/*` paths and the `shellbox_launch` schema are frozen wire surface shared with `ui-sandbox-view`; changing either needs the client pane and `sandbox/PROTOCOL.md` in the same change.

</details>
