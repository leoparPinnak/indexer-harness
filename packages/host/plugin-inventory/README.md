---
description: "Projection of the current Cordis Loader plugin state with each agent preset's composition beside it, plus the MCP-server read/toggle/add plane: the pluginInventory service and its Remote for web GUI host clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-inventory

English | [中文](README.zh.md)

## Summary

Clients can call `pluginInventory/list` to display the host’s current plugins in load order, including each entry’s identifier, module specifier, effective enablement, and live phase. Deployments with an agent-preset roster also report each preset’s metadata, health, and flattened plugin composition; without a roster, preset data is absent. The MCP-server plane lists every configured `@deepseek-ai/dsh-mcp-client` row joined with its connection status, toggles its Loader enablement, and adds new servers — all through the id-targeted managed patch block in `$DSH_HOME/cordis.patch.yml` that `patchReload: live` recomposes.

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

Call `pluginInventory/list` when a client or settings page needs to show what is currently composed in the host — which plugins are loaded, enabled, and alive, and what each agent preset would give a session. The Remote is the only entry point: the service is Remote-only and deliberately declares no same-process Cordis `Context` merge.

### What a snapshot contains

Each row is one non-group Loader entry: its entry id, the exact module specifier, the effective enablement (including disabled ancestor groups), and the current root Fiber phase. `pending` means the entry waits to load, `loading` that it is being read, `active` that it is running, `failed` that its fiber rejected, and `unloading` that it is being torn down; `null` means no live root Fiber exists at all. Structural group rows are skipped.

### Per-preset compositions

With a roster composed, `agentPresets` carries one group per preset in roster order: its id, whether the deployment ships it or the user owns it (`trust`, which clients use to localize shipped names), published display name, whether a session naming no preset composes it, and flattened plugin rows — entry id (null when the file row declares none), module specifier, effective enablement, the row's own `!!js` disabled expression when it carries one, and a root-fiber phase when the composition is live. A preset some session already composed answers from its newest standing generation — even when its file has since broken, because the mount is what those sessions run; one never composed since boot answers from its composition file with disabled gates evaluated against the Loader context, and reading never mounts a preset. `conditional` enablement marks a gate the Host could not evaluate, and a broken preset nothing composed stays listed with its reason and no rows. Without a roster the field is absent.

### What you can and cannot do with it

The inventory rows remain a snapshot for display and diagnostics: clients render the roster, flag failed entries, and detect changes only by comparing snapshots. The MCP plane is the deliberate exception — `pluginInventory/mcpServers` reports each configured bridge row joined with its supervisor's latest transition, `pluginInventory/setMcpServerEnabled` toggles one row by writing a managed disable row into the home patch, and `pluginInventory/addMcpServer` appends a complete server `insert` row there. A toggle or an add needs `$DSH_HOME` (it fails loud without one), becomes visible to the session composer through the Loader's live patch reload, and leaves every byte outside the managed block untouched. Everything else carries no history and removes nothing.

### The managed patch block

The writer owns one delimited region, keyed by id rows (`{"id":"mcp-rea","disabled":true}`) and server `insert` rows, all rendered as one flow-JSON line apiece — simultaneously this writer's exact `JSON.parse` grammar and valid YAML for the Loader's parser, so no user YAML is round-tripped. A re-enable sweeps every disable spelling of the entry it toggles, including the stale tree-qualified id (`include:mcp-rea`) an older writer could leave: an unswept stale row kept the server off forever after an "on" toggle. A disable of an already-listed address writes nothing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInventoryGateway`: the `pluginInventory` Remote service, the Loader projection, and the MCP-server plane |
| [`src/patch.ts`](src/patch.ts) | The managed patch block: disable rows, server `insert` rows, stale-path sweeping, atomic writes |
| [`src/types.ts`](src/types.ts) | Public payload types: `PluginInventoryEntry`, `PluginInventorySnapshot`, `PluginFiberPhase`, `McpServerView`, `AddMcpServerRequest` |
| — | No runtime invariant companion is published; every snapshot is projected directly from Loader-owned state. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The gateway is a direct projection with no second lifecycle truth: every `list()` call reads `ctx.loader.entries()` and maps each non-group entry to its public row. Cordis's internal `plugin/status` events already maintain `Entry.fiber` and `Fiber.state`, so a cache would only add another lifecycle truth to keep synchronized. The agent-preset roster is an optional peer resolved per call through `ctx.get('agentPresets')`: its `compositionInventory()` owns every preset read, and this package only maps root-fiber states onto the public phase vocabulary. `mcpServers()` and `setMcpServerEnabled` join the same Loader walk with `@deepseek-ai/dsh-mcp-client`'s status registry — the classification (`serverNameOfLoaderEntry`) lives in the package the rows mount, and patch writes are filesystem effects owned by `patch.ts`.

### The phase mapping

Fiber states map onto the public phase vocabulary, with `disposed` folding into `null` — an entry whose fiber is gone has no live root to report. The phase therefore never distinguishes why no live root exists: the entry may never have started, or its fiber may already have been disposed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the inventory contract is not enough: how the Remote reaches clients, then the Loader it projects and the surface that renders it.

- [Remote assembly](../../api/remotes/README.md) — how clients consume `pluginInventory/list` without importing the Host implementation.
- [Cordis plugin loader](../../../vendor/loader/README.md) — the Loader whose entries this package projects.
- [Plugin inventory settings surface](../../client/ui-settings-plugin-inventory/README.md) — the browser-side projection that renders the inventory and drives the MCP plane.
- [MCP client bridge](../../mcp/mcp-client/README.md) — the rows `mcpServers()` projects and the status registry it joins.
- [Per-session MCP visibility](../../mcp/mcp-session/README.md) — the composer half that consumes this plane's Loader read.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side read-only Loader projection registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what a point-in-time inventory cannot tell a client. They are current package constraints, not a task backlog.

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **No provenance** — the service does not identify which bundle, profile, or override introduced an entry.
- **The managed block serves the MCP plane only** — a toggle and an add write id rows and bridge `insert` rows; arbitrary plugin rows in that block stay hand-edit territory.
- **Presets appear only with a roster** — a deployment without `dsh-agent-presets` serves Loader entries alone; the `agentPresets` field is absent rather than empty.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
