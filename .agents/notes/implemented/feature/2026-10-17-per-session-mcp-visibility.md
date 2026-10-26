# Agent Note: Per-session MCP server visibility

Status: implemented

English | [中文](2026-10-17-per-session-mcp-visibility.zh.md)

## Problem

An MCP server's tools belonged to the Host, not to a session. The bridge registered every server's tools on `ctx.tools` at mount, so the only on/off control was the loader row itself — a process-wide disable that also tears the connection down and affects every session, and that only takes effect at the next start of the row.

What the operator asked for is a session-level switch beside the composer's permission selector: list the MCP servers, flip one, and have the toolset change for the *next message* of that session — the way a session's permission preset is already injected, and the way an agent preset loads tools at session start, only smaller.

## Decision

- **`@deepseek-ai/dsh-mcp-session`** (`packages/mcp/mcp-session`) owns the decision. Its state is one log-only Session event, `mcp/session-servers` — the last event wins, so a session holds a single durable disable list — folded by the `mcpServers` Session projection.
- **The mechanism is a tool restriction, not a mount change.** `agent.ctx.tools.restrict({ deny })` removes the named tools from one Agent's scope while leaving the global registry, the connection, and every other session untouched. The deny set is always derived from the tools registered *right now*, never from stored names, because `restrict()` refuses a name the registry does not know.
- **`McpSessionService`** exposes `list({ sessionId })` and `setServerEnabled({ sessionId, serverName, enabled })` over Typert Remote. The write appends the event, re-applies the restriction, and returns the refreshed rows; the read reports every server this Host knows about with its live tool count and this session's visibility.
- **Three application points** keep the restriction honest: `agent/created` applies the stored list, `tools/change` re-applies it when a reconnected server publishes a new tool generation, and `agent/disposed` drops the bookkeeping (the Agent's scope unwind already lifted the effect). Re-entrancy is handled by recording the applied deny signature *before* calling `restrict()`, since that call itself emits `tools/change`.
- **`@deepseek-ai/dsh-client-ui-mcp-session`** (`packages/client/ui-mcp-session`) registers one entry in the composer's left tool row (`conversation.input.left`), next to the permission selector: a trigger carrying the kept/total count and a panel of switches over `remote.mcpSession`.
- Both halves are mounted by bundles — the host plane in `dsh-base`, the control in `dsh-web-app` — so an MCP-less Host lists no servers, and a Host without the service renders no trigger.

## Alternatives considered

**Unmounting the loader row per session.** Rejected: a session-scoped mount would spawn its own MCP server process per session, disconnect the shared one for every other session, and make a toggle take effect at the next mount rather than the next request.

**Making MCP servers a preset dimension.** Rejected as the larger concept the operator explicitly did not want: moving MCP rows into Agent presets would make "which servers this session uses" a property of a chosen preset, not of the session's own switches.

**Depending on the plugin-inventory Remote for the roster.** Rejected: the composer would have to read a Settings-plane namespace to draw a composer control. The session plane derives its own roster from the MCP status registry and the registered `mcp__<serverName>__` names it already has to compute.

**Storing the disable list in a settings namespace (a Host-wide default).** Rejected: the requested scope is the session. A deployment default would be a second, different decision with its own default-resolution semantics.

**A `/mcp <server> on|off` command as the only write path** (the `/permission` precedent). Rejected for this control: a switch panel needs the current rows, and a command's transcript row is a conversation act, while toggling one's toolset is not.

## Consequences

- A server registered globally can now be invisible in one session and visible in another; `mcp__<serverName>__` names stay globally unique, so no naming change was needed.
- A session that has never expressed a choice reads as "all visible" — including a session no projection unit watches, where `stateOf` returns nothing rather than an error.
- The switch is durable per session: the event rides the session log, so a resumed session re-applies its own list on the next `agent/created`.
- A server that reconnects with fewer tools cannot leave a stale deny name behind: the deny set is recomputed from the current registry, and a name that vanished simply stops being denied.
- **The roster reads the Loader (post-observation):** the original roster came from the status registry alone, which is process-local — after a Host restart a configured server that had not yet connected, and one the operator had disabled at the Host level, did not appear at all, leaving the composer's panel with nothing to switch. The roster now unions status-registry names with `@deepseek-ai/dsh-mcp-client` Loader rows (classified through the shared `serverNameOfLoaderEntry` helper), and each row carries `hostEnabled` — the Loader row's effective enablement. A Host-disabled row renders without a switch (the composer half of `ui-mcp-session`), and Host-level re-enable stays the Settings tab's job.
- `packages/mcp/mcp-session/tests/mcp-session.spec.ts` pins the isolation (one session withheld, another and the global view untouched), the late-generation re-application, the unwatched-session fallback, the Loader-backed roster (configured rows list; a disabled row reports `hostEnabled: false`), and the lifecycle wiring at per-file 100% coverage; `packages/client/ui-mcp-session/tests/` pins the trigger, panel, dismissal, the Host-disabled row, and both write outcomes.
