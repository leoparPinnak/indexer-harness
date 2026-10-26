# @deepseek-ai/dsh-client-ui-mcp-session

Per-session MCP server switches in the composer tool row.

## What it owns

One entry in the composer's left tool row (`conversation.input.left`), next to the permission selector: a compact `MCP` trigger showing how many of the known servers this session keeps, and a panel of switches that writes that session's own choice. The switch reaches the model on the next request — see [`@deepseek-ai/dsh-mcp-session`](../../mcp/mcp-session/README.md) for the Host decision it drives.

- **Read** — `remote.mcpSession.list({ sessionId })` on every open, so the panel always shows the rows the Host currently holds. Configured-but-never-connected servers list alongside connected ones; a row whose Loader enablement is off (`hostEnabled: false`) renders the Host-disabled note instead of a switch — the session cannot expose tools the Host keeps stopped, and re-enabling it is the Settings tab's job.
- **Write** — `remote.mcpSession.setServerEnabled({ sessionId, serverName, enabled })`, whose returned rows replace the panel's list. A switch in flight locks itself; a refused write reports itself and keeps the rows already on screen.
- **Dismissal** — an outside pointerdown or Escape closes the panel; the trigger carries `aria-expanded` and the panel is a labelled `dialog`.

## Where it is mounted

`packages/bundle/web-app/cordis.patch.yml` mounts it for the Web surface. It declares only `slots`, `locale`, `remote`, and `remote.mcpSession`, and registers a single slot entry (`id: mcp-session`), so a deployment without the Host half renders no trigger at all.
