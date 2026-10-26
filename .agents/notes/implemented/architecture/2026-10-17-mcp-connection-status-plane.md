# Agent Note: MCP server status plane and its Settings page

Status: implemented

English | [中文](2026-10-17-mcp-connection-status-plane.zh.md)

## Problem

Settings showed MCP servers only as Cordis Loader rows — a read-only projection of the assembled tree with no connection state, no tool count, and no on/off control. An operator could not tell whether a server had connected, what it had registered, or that a 207-tool server such as `mcp-rea` was the row straining provider tool-count caps, and disabling one meant hand-editing `cordis.patch.yml` blind.

Hand-editing is exactly where the second problem lives: a patch list addresses a row by the id that row *declares* (`mcp-rea`), while the Loader reports the tree-qualified path (`include:mcp-rea`). The two look interchangeable and are not — an id-targeted disable written with the Loader path matches nothing, warns once in the loader log, and leaves the server running.

## Decision

- **`packages/mcp/mcp-client/src/status.ts`** owns a process-wide `McpStatusRegistry`: one entry per `(scope, serverName)` recording the last lifecycle transition (`connecting` / `connected` / `reconnecting` / `failed` / `stopped`), the tool count and public tool names at each `connected`, and the error text behind a retry or give-up. `connection.ts` records at every supervisor decision. JSONL history is strictly opt-in through the new `statusLogPath` config: a Harness-home default leaked test writes into the real home, so `resolveStatusLogPath` resolves to `undefined` unless a deployment asks.
- **`packages/host/plugin-inventory/src/patch.ts`** owns a writer-marked managed block in `$DSH_HOME/cordis.patch.yml`. That file is the home user layer, composed last — after every bundle layer and after the profile's own `cordis.patch.yml` (`apps/cli/src/profile-boot.ts`) — and watched live, so a managed disable always wins over the `insert` row that introduced the server, wherever that row lives. A toggle rewrites only the delimited block; the user's `!!js`-bearing YAML is never round-tripped, and a re-enable removes the managed row alone.
- **`PluginInventoryGateway`** gains `@Remote('mcpServers')` and `@Remote('setMcpServerEnabled')`. A server row is an `@deepseek-ai/dsh-mcp-client` Loader entry carrying a configured `serverName`, joined with the status registry's entry for that name.
- **Row identity is the patch address, not the Loader path.** `mcpServers()` reports `entry.options.id` — the id a patch list indexes — because that is the only key `setMcpServerEnabled` can write. The live deployment reports `include:mcp-rea` as the Loader path for the row its patch list calls `mcp-rea`.
- **The Settings surface is a second tab in the existing Plugins section** (`packages/client/ui-settings-plugin-inventory`, registrations `id: 'all'` at order 10 and `id: 'mcp'` at order 20). It lists every configured server with its effective status, tool count, recorded error, and an enablement switch that drives `setMcpServerEnabled`; a toggle in flight locks its own switch, and a refused write reports itself without discarding the rows already on screen.

## Alternatives considered

**A new `packages/client/ui-settings-mcp` package.** Rejected: the MCP page reads the same Remote namespace (`pluginInventory`) and occupies the same slot (`settings.plugins.tab`) as the tab it sits beside, so a separate package would add a manifest, a bundle row, a README pair, and a project reference without adding an owner.

**A new top-level Settings navigation section.** Rejected: `ui-settings-plugins` declares the one Plugins nav row precisely so that feature plugins contribute pages "without competing for Settings nav rows"; a second nav entry for one tab would spend that seam's whole point.

**Writing the disable row into the profile's own `cordis.patch.yml`.** Rejected: that file is the operator's, it already holds the `insert` row a toggle must not disturb, and a managed block is only safe in a file the writer owns outright. The home layer is that file and composes last.

**Toggling by the Loader entry id (`include:mcp-rea`).** Rejected: `applyEntryPatches` indexes the declared ids of the patch list's own data, so a tree-qualified row matches nothing and the toggle would silently do nothing.

**Logging status history to the Harness home by default.** Rejected after observing it: every DSH session exports `DSH_HOME`, so the default wrote test traffic into the operator's real home. Logging is now a deployment choice.

**Caching the Loader projection in the gateway.** Rejected: Cordis already maintains `Entry.fiber` and `Fiber.state`, so a second cache would add a second lifecycle truth to keep synchronized for no read win.

## Consequences

- `@deepseek-ai/dsh-mcp-client` gains one optional config field (`statusLogPath`), and the JSONL stream it enables is observability, never transport: a refused write degrades to registry-only status and never fails a connection.
- A toggle takes effect without a restart: `patchReload: live` recomposes from the edit, and the home-layer watcher fires on the *creation* of a patch file that did not exist before.
- `setMcpServerEnabled` requires `$DSH_HOME` and fails loud without it, naming the missing variable: writing a patch file somewhere the Loader never reads is worse than refusing.
- Two servers reusing one `serverName` across scopes collapse into one registry entry, matching the single public tool-name namespace they already share.
- The tab reports Host state only. A session-plane server that never reached the Host supervisor shows no transition and reads as "not connected yet" rather than inventing a state.
- `packages/host/plugin-inventory/tests/patch.spec.ts`, `mcp-servers.spec.ts`, `packages/mcp/mcp-client/tests/status.spec.ts`, and the jsdom suites under `packages/client/ui-settings-plugin-inventory/tests/` pin the plane at per-file 100% coverage; the identity rule is pinned with an injected tree-qualified id, because a bare Loader harness has no enclosing include tree to compose it.
- **Managed-block grammar upgrade (post-observation):** the first live deployment wrote a disable row whose id was a tree-qualified path (`include:mcp-rea`) — an address no patch list can match — so every later "on" toggle flapped back and the server stayed off forever. The block now renders one flow-JSON row per line (both `JSON.parse`-exact and valid YAML for the Loader's parser), every disable write sweeps any id ending `:<entryId>`, and legacy text rows decode as an upgrade path.
- **Add-server writes an `insert` row (post-observation):** adding was the hand-edit territory this plane exists to close. `pluginInventory/addMcpServer` validates the request (serverName pattern, transport fields, name/id uniqueness), writes `{insert:[{id:"mcp-<name>",name:"@deepseek-ai/dsh-mcp-client",config:{…}}]}` into the same managed block, and the live patch reload mounts the server — the Settings tab owns the form.
