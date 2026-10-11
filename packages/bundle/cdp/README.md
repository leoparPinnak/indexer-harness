---
description: "The CDP browser-control extension for dsh: one installable patch layer with a host bundle that reports extension state and drives Chromium browsers over the Chrome DevTools Protocol, plus the right-sidebar CDP tab."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cdp

English | [中文](README.zh.md)

## Summary

Install the CDP extension as its own profile layer: a host bundle that publishes the extension's state on `GET /api/server/cdp/status`, exposes the `cdp_status` model tool, and orients the model with the `app:cdp-status` prompt section, plus the `CDP` tab in the Web GUI's right sidebar. The bundle is one patch (the `cdp` host row plus the `ui-cdp-view` browser row) and one runtime plugin. Hand it to another machine's profile with `dsh plugin --profile <name> add <package>`; it needs a profile that already mounts the web-server layer (`dsh-web-app`).

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
dsh plugin --profile web add @deepseek-ai/dsh-cdp
dsh --profile web
```

Verify the layer is present with `dsh --profile web --dump-config`, which prints a `# == @deepseek-ai/dsh-cdp` section.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `remoteDebuggingPort` | `9222` | TCP port of the browser's remote-debugging endpoint; the connection phase attaches to it |
| `proxyListenPort` | `9333` | Loopback port the extension's HTTP proxy listener binds; a value equal to `remoteDebuggingPort` is refused at load |
| `guideAssetsDir` | `''` | Directory holding the guide web; empty resolves the bundle's published `assets/` directory |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What gets mounted

- `GET /api/server/cdp/status`, behind Connection's Host/Origin + cookie fence.
- The model tool `cdp_status`, when the profile mounts the `tools` registry.
- The `app:cdp-status` prompt section, when the profile mounts `systemPrompt`.
- The `ui-cdp-view` browser row: the right-sidebar CDP tab.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch plus one runtime plugin. The patch inserts two rows; the plugin injects `webServer`, mounts the status route, and defers the tool on `tools` and the prompt section on `systemPrompt`, so profiles lacking those registries still get the route. `readCdpStatus` is the single local read the route and the tool both answer with; a later phase adds the mirror for a state that lives in a separate process beside it.

### Status read

`GET /api/server/cdp/status` answers `200` with `{ "ok": true, "version": "<installed version>", "targets": 0, "proxy": { "active": false } }`, and `405` with `allow: GET` for any other method. The reported version comes from this package's manifest, so it cannot drift from what is installed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `cdp` plugin: config validation, route and tool mount, prompt section |
| [`src/status.ts`](src/status.ts) | The local status read, the status route, and the `cdp_status` tool |
| [`src/types.ts`](src/types.ts) | The status response types |
| [`cordis.patch.yml`](cordis.patch.yml) | The layer: `cdp` host row plus `ui-cdp-view` browser row |
| — | No runtime invariant companion is published; every registration is registry-disposed with the fiber, and each owning registry's package carries that relation's invariant. |
| [`tests/status.spec.ts`](tests/status.spec.ts) | Route, tool, prompt section, config validation, disposal |
| [`tests/loading-composition.spec.ts`](tests/loading-composition.spec.ts) | The patch boots through a real Loader tree |

### Invariant ownership

No invariant companion is published because every contribution — the status route, the `cdp_status` tool, and the prompt section — is registry-disposed with the fiber, and each owning registry package carries that relation's invariant.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core or the browser surface.

- [Bundle package map](../README.md) — the installable patch layers built on the same core.
- [dsh-web-app](../web-app/README.md) — the browser layer this row mounts on.
- [dsh-tools](../../core/tools/README.md) — the tool registry and `defineTool`.
- [dsh-host-webserver](../../host/webserver/README.md) — the route registration the status route uses.

-----

<a id="model-experience"></a>
## Model Experience

### The `app:cdp-status` prompt section

#### What the model sees

The section registers as `app:cdp-status` at the `WEB_SURFACE` order plus 7 whenever the profile mounts `systemPrompt`. It orients the model to the extension, the `cdp_status` read, and the requirement that a browser endpoint is only reachable while remote debugging is enabled.

##### Verbatim `app:cdp-status` text

```markdown
DSH CDP Guidance:
- The CDP extension drives Chromium-based browsers over the Chrome DevTools Protocol through the `cdp_*` tools.
- Call `cdp_status` for the installed version, the live target count, and the proxy state; the CDP tab in the right sidebar shows the same state.
- A browser endpoint is only reachable while it was launched with remote debugging enabled.
```

#### Token effect

One section of three short lines is present exactly while the `systemPrompt` registry is mounted; a profile without it pays nothing. Constant per process.

#### KV Cache effect

The section keeps a fixed order directly after the Web-surface sections, so the preceding prefix stays stable across sessions under the same composition; provider cache reuse is not guaranteed.

### The `cdp_status` tool

#### What the model sees

When the `tools` registry is present, the tool registers with no parameters and returns the same read as the route: the installed version, the live target count, and the proxy state. The result renders as one line, for example ``CDP 0.1.5-rc.2: 0 target(s), proxy active: false.``

#### Token effect

One tool entry joins every request's tool list while the registry is mounted, and one short result line per call. Constant per process.

#### KV Cache effect

The tool name, description, and empty parameter list are fixed, so an already-reusable request prefix stays stable; a call appends its result after that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you what to expect in this phase. They are current package constraints, not a task backlog.

- **The status read reports the skeleton, not discovery** — `targets` is `0` and `proxy.active` is `false` by construction until the connection and proxy phases land; neither field is a live probe yet.
- **Two config fields have no reader yet** — `remoteDebuggingPort` and `proxyListenPort` currently back the load-time collision check only, and `guideAssetsDir` is validated but unread until the guide web lands.
- **The CDP tab needs its own package** — the `ui-cdp-view` row resolves `@deepseek-ai/dsh-client-ui-cdp-view`, which must be installed beside this bundle.
- **Needs the web-server layer** — the row injects `webServer`; a profile without `dsh-web-app` leaves the layer unmounted.
- **The tool needs the tools registry** — a profile without `tools` keeps the status route but mounts no `cdp_status` tool.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`/api/server/cdp/status` and its payload are the frozen wire surface shared with `ui-cdp-view`; changing either needs the client pane in the same change. `readCdpStatus` is deliberately the one local read both entry points call, so a daemon mirror of a later phase replaces one call rather than two.

</details>
