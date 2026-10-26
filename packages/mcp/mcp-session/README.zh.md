# @deepseek-ai/dsh-mcp-session

按会话的 MCP 服务器可见性：每个会话持有一份持久化的停用清单，并以工具限制的形式作用于该会话的 Agent 作用域。

## 它拥有什么

MCP 桥接（`@deepseek-ai/dsh-mcp-client`）把某个服务器的工具注册到整个 Host 的 `ctx.tools` 上。因此"本会话不使用该服务器"不是一个挂载问题，而是 ToolRuntime 本就建模过的*可见性*问题——`agent.ctx.tools.restrict({ deny })` 只把继承来的工具从某一个 Agent 的作用域中移除，既不触碰全局注册表，也不影响其他会话。

本包是这一决定的归属者。它持有：

- **`mcp/session-servers`**——仅进入日志的 Session 事件，携带被停用的服务器名。最后一个事件生效，因此状态是每会话一份持久清单，且永不进入模型对话记录。
- **`mcpServers` Session 投影**——把该清单读回来的折叠单元。没有任何单元观察的会话读作"全部服务器可见"。
- **`McpSessionService`**（`ctx.mcpSession`）——由输入栏控件驱动的 Remote 接口：
  - `list({ sessionId })` → 本 Host 已知的每个 MCP 服务器，附带其已注册工具数量与该会话的有效可见性。
  - `setServerEnabled({ sessionId, serverName, enabled })` → 追加该决定、重新施加 Agent 作用域限制，并返回刷新后的行。
- **Agent 作用域接线**——服务在 `agent/created` 时施加限制，在 `tools/change`（重连的服务器发布新工具代）时重新施加，并在 `agent/disposed` 时清除自己的簿记。

## 为什么用限制而不是挂载

卸载服务器会为所有会话断开它，并在每次切换时重新拉起它的进程。限制保留同一个连接与同一份工具代，只改变某一个 Agent 的下一次请求所看到的内容——这也正是为什么切换在**下一次请求**生效，而不是等到下一次进程启动。

## 挂载位置

`packages/bundle/base/cordis.patch.yml` 为每个界面挂载它。在没有 MCP 桥接的 Host 上，它列不出服务器，也不施加任何限制。浏览器半边是 [`@deepseek-ai/dsh-client-ui-mcp-session`](../../client/ui-mcp-session/README.zh.md)，它把开关放进输入栏的工具行。

## 名册的来源

一旦某个服务器的桥接在 `@deepseek-ai/dsh-mcp-client` 的状态注册表中记录了任意一次生命周期转换，**或** Loader 组合出一个点名该服务器的桥接行，该服务器即被视为已知；因此一个已配置但从未连接过的服务器——以及一个 Host 级停用的服务器——都会列出来而不是消失。它的工具数量就是此刻已注册的 `mcp__<serverName>__` 工具数，`hostEnabled` 报告配置它的 Loader 行的有效启用状态：本会话可以扣留一台已连接的服务器，但 Host 级停用的服务器无论如何都不会暴露工具——输入栏面板对这类行渲染为无开关。在没有 Loader 的上下文（test kit、隔离作用域）中，名册仅由状态注册表支撑，与 Loader 行加入之前一致。

## 已知限制与推迟的工作

- **限制只遮蔽全局层的工具。** `tools.restrict()` 不会隐藏注册在 preset 作用域内的工具（“scoped registrations remain visible”），因此由某个会话自己的 preset 组合挂载的 MCP 服务器无法通过这一平面切换。随附的 preset 不挂载 MCP 行；确实这么做的自定义 preset 接受它的行已经做出的可见性决定。
- **Host 级停用的服务器需要 Host 半边来恢复。** 重新启用它是 Settings 标签页的工作（`setMcpServerEnabled`），而不是会话开关——对这类行，本面板刻意保持只读。
