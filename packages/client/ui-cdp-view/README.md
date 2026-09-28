---
description: "The right Sidebar's CDP tab type for the dsh web client: the Chrome DevTools Protocol extension's host status route rendered as availability, version, live target count, and proxy state, with loading, failure, and retry states."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cdp-view

English | [中文](README.zh.md)

## Summary

The right Sidebar's CDP tab type, labeled **CDP**: one pane over the status route the Chrome DevTools Protocol extension registers on the web host. It reads `GET /api/server/cdp/status` with plain `fetch` and draws what the host reports — whether the extension answers, the installed bundle version, how many browser targets it currently controls, and whether its local proxy listener is active. Nothing in `ui-sidebar-right` knows this package.

## Table of Contents

- [What it registers](#what-it-registers)
- [The status route](#the-status-route)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `cdp`, id `@deepseek-ai/dsh-client-ui-cdp-view`, band `extension`, and no address patterns. One guide entry offers it on the "add tab" page under the label `CDP`.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: an availability dot and line, a version/targets/proxy field panel, and the loading, failure, and retry states.

Source files under `src/client/`: `definition.ts` (the type), `CdpBody.tsx` (the status read, its validation, and its states), plus `locales.ts` (what it says) and `index.ts` (the wiring).

<a id="the-status-route"></a>
## The status route

The host bundle owns the route and the payload; this pane only reads it. `GET /api/server/cdp/status` answers `{"ok": true, "version": "<bundle version>", "targets": <n>, "proxy": {"active": <bool>}}`, the same fields the `cdp_status` model tool reports.

The pane re-declares those four fields rather than importing the host bundle's type, and validates each one after `fetch` resolves: a response that is refused, fails in transport, is not JSON, or does not carry the declared field types settles into the failure line with its retry control, which re-runs the read. The version string and the target count are shown verbatim; the availability line pairs a state-colored dot with a text label, so color is never the only channel.

<a id="further-exploration"></a>
## Further Exploration

- [cdp](../../bundle/cdp/README.md) — the host bundle that registers the status route, the `cdp_status` tool, and the payload this pane reads.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — owns the right Sidebar's tab registry, the keyed body seat, and the "add tab" guide page.
- [Web UI style reference](../../../docs/web-styling.md) — the token and elevation rules this pane's stylesheet follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only reads a host status route in the browser and registers nothing model-facing.

#### KV Cache effect

None; the status read travels over the web host's own route and assembles no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Registration decides visibility.** Whether the tab exists at all is decided by the profile that mounts this package; becoming a shipped row is a separate registration step.
- **The payload is mirrored, not shared.** The pane re-declares the four status fields instead of importing the host bundle's `CdpStatusResponse`, because a browser package does not depend on a host bundle; a field the host adds or renames needs the pane's parser updated beside it.
- **Reads happen when the tab mounts.** The pane reads the route once per mount and on each retry; it does not poll, so a target count that changes while the tab stays open is not refreshed until the reader retries or reopens it.
- **Only the status surface is drawn.** Live target detail, the last snapshot, and the request log are not part of this pane.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The pane's only runtime state is the load state and its retry counter, both owned by the mounted component and replaced on every read; there is no second observation of them to compare against.
