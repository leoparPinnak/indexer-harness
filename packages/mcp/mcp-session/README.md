# @deepseek-ai/dsh-mcp-session

Per-session MCP server visibility: one durable disable list per session, applied as a tool restriction inside that session's Agent scope.

## What it owns

The MCP bridge (`@deepseek-ai/dsh-mcp-client`) registers a server's tools on `ctx.tools` for the whole Host. "This session does not use that server" is therefore not a mount question: it is a *visibility* question the ToolRuntime already models — `agent.ctx.tools.restrict({ deny })` removes inherited tools from one Agent's scope without touching the global registry or any other session.

This package is that decision's owner. It holds:

- **`mcp/session-servers`** — a log-only Session event carrying the disabled server names. The last event wins, so the state is one durable list per session and never enters the model transcript.
- **The `mcpServers` Session projection** — the fold that reads that list back. A session no unit watches reads as "every server visible".
- **`McpSessionService`** (`ctx.mcpSession`) — the Remote face a composer control drives:
  - `list({ sessionId })` → every MCP server this Host knows about, with its registered tool count and this session's effective visibility.
  - `setServerEnabled({ sessionId, serverName, enabled })` → appends the decision, re-applies the Agent-scope restriction, and returns the refreshed rows.
- **Agent-scope wiring** — the service applies the restriction on `agent/created`, re-applies it on `tools/change` (a reconnected server publishing a new tool generation), and drops its bookkeeping on `agent/disposed`.

## Why a restriction, not a mount

Unmounting the server would disconnect it for every session and re-spawn its process on every toggle. The restriction keeps one connection and one tool generation, and changes only what one Agent's next request sees — which is also why a switch reaches the model on the next request instead of at the next process start.

## Where it is mounted

`packages/bundle/base/cordis.patch.yml` mounts it for every surface. On a Host with no MCP bridge it lists no servers and restricts nothing. The browser half is [`@deepseek-ai/dsh-client-ui-mcp-session`](../../client/ui-mcp-session/README.md), which puts the switches in the composer tool row.

## Reading the roster

A server is known once its bridge recorded any lifecycle transition in `@deepseek-ai/dsh-mcp-client`'s status registry **or** the Loader composes a bridge row naming it, so a server that is configured but never connected — and a Host-disabled one — lists rather than disappearing. Its tool count is how many `mcp__<serverName>__` tools are registered right now, and `hostEnabled` reports the Loader row's effective enablement: a session can withhold a connected server, but a Host-disabled one exposes no tools regardless of this session's switch, which is why the composer panel renders such a row without a switch. On a context without a Loader (test kits, isolated scopes), the status registry alone backs the roster, as it did before Loader rows joined.

## Known Limitations and Deferred Work

- **The restriction masks global-layer tools only.** `tools.restrict()` never hides a tool registered inside a preset scope (`Scoped registrations remain visible`), so an MCP server mounted by a session's own preset composition is not switchable from this plane. The shipped presets mount no MCP rows; a custom preset that does accepts the visibility decision its rows already made.
- **A Host-disabled server needs the Host half to toggle.** Re-enabling it is the Settings tab's job (`setMcpServerEnabled`), not a session switch — that panel row is deliberately read-only for such servers.
