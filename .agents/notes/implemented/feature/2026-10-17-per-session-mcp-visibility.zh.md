# Agent Note：按会话的 MCP 服务器可见性

Status: implemented

[English](2026-10-17-per-session-mcp-visibility.md) | 中文

## 问题

MCP 服务器的工具属于 Host，而不属于某个会话。桥接在挂载时就把每个服务器的工具注册到 `ctx.tools`，因此唯一的开关就是 Loader 行本身——一次进程级的停用，它同时会断开连接、影响所有会话，而且要到该行下次启动才生效。

操作者想要的是输入栏权限选择器旁边的一个会话级开关：列出 MCP 服务器、切换其中一个，并让该会话的**下一条消息**就使用新的工具集——就像会话的权限预设已经被注入那样，也像 Agent 预设会在会话开始时装载工具那样，只是更小。

## 决策

- **`@deepseek-ai/dsh-mcp-session`**（`packages/mcp/mcp-session`）拥有该决定。它的状态是一个仅进入日志的 Session 事件 `mcp/session-servers`——最后一个事件生效，因此每个会话持有一份持久的停用清单——由 `mcpServers` Session 投影折叠。
- **机制是工具限制，而不是改动挂载。** `agent.ctx.tools.restrict({ deny })` 只把指定工具从某一个 Agent 的作用域中移除，既不改动全局注册表与连接，也不影响其他任何会话。拒绝集始终由**此刻**已注册的工具推导，绝不使用保存下来的名字，因为 `restrict()` 会拒绝注册表不认识的名字。
- **`McpSessionService`** 通过 Typert Remote 暴露 `list({ sessionId })` 与 `setServerEnabled({ sessionId, serverName, enabled })`。写入会追加事件、重新施加限制并返回刷新后的行；读取会报告本 Host 已知的每个服务器及其实时工具数量与该会话的可见性。
- **三个施加点**让限制保持诚实：`agent/created` 施加已保存的清单，`tools/change` 在重连的服务器发布新工具代时重新施加，`agent/disposed` 清除簿记（Agent 作用域的展开本身已经解除了效果）。重入由"在调用 `restrict()` **之前**记录已施加的拒绝签名"处理，因为该调用自身会发出 `tools/change`。
- **`@deepseek-ai/dsh-client-ui-mcp-session`**（`packages/client/ui-mcp-session`）在输入栏左侧工具行（`conversation.input.left`）注册一个条目，就在权限选择器旁边：一个带保留/总数计数的触发器，以及一个基于 `remote.mcpSession` 的开关面板。
- 两半都由组合包挂载——Host 面在 `dsh-base`，控件在 `dsh-web-app`——因此没有 MCP 的 Host 列不出服务器，而没有该服务的 Host 不会渲染触发器。

## 备选方案

**按会话卸载 Loader 行。** 已否决：会话级挂载会为每个会话各拉起一个 MCP 服务器进程，为所有其他会话断开共享的那一个，并使切换在下一次挂载才生效，而不是下一次请求。

**把 MCP 服务器做成预设的一个维度。** 已否决，因为那正是操作者明确说不要的更大的概念：把 MCP 行搬进 Agent 预设，会让"本会话使用哪些服务器"变成所选预设的属性，而不是会话自身开关的属性。

**依赖 plugin-inventory 的 Remote 获取名册。** 已否决：输入栏控件将不得不读取设置面的命名空间来绘制控件。会话面从 MCP 状态注册表与自己本就需要的已注册 `mcp__<serverName>__` 名字推导名册。

**把停用清单存进设置命名空间（Host 级默认值）。** 已否决：要求的作用域是会话。部署默认值会是另一个决定，并带有自己的默认值解析语义。

**只用 `/mcp <server> on|off` 命令作为写入路径**（`/permission` 的先例）。此处已否决：开关面板需要当前的行，而命令的对话记录行是一次对话行为，切换自己的工具集则不是。

## 后果

- 全局注册的服务器现在可以在一个会话中不可见、在另一个会话中可见；`mcp__<serverName>__` 名字仍全局唯一，因此无需改动命名。
- 从未表达过选择的会话读作"全部可见"——包括没有任何投影单元观察的会话，此时 `stateOf` 返回空值而不是报错。
- 开关按会话持久：事件随会话日志走，因此被恢复的会话会在下一次 `agent/created` 时重新施加自己的清单。
- 重连后工具变少的服务器不会留下过期的拒绝名：拒绝集由当前注册表重新计算，消失的名字自然不再被拒绝。
- **名册读取 Loader（实况之后）：** 最初的名册仅来自状态注册表，而注册表是进程本地的——Host 重启后，一台尚未连接的已配置服务器、以及一台被操作者在 Host 级停用的服务器，都不会出现，输入栏面板因此无事可切。名册现在把状态注册表的名字与 `@deepseek-ai/dsh-mcp-client` 的 Loader 行合并（经共享的 `serverNameOfLoaderEntry` 助手分类），每行携带 `hostEnabled`——配置它的 Loader 行的有效启用状态。Host 级停用的行渲染为无开关（`ui-mcp-session` 的输入栏半边），Host 级恢复启用仍是 Settings 标签页的工作。
- `packages/mcp/mcp-session/tests/mcp-session.spec.ts` 以每文件 100% 覆盖率固定了隔离性（一个会话被排除，另一个会话与全局视图不受影响）、后发布的工具代重新施加、未观察会话的回退、Loader 支撑的名册（已配置行列出；停用的行报告 `hostEnabled: false`）以及生命周期接线；`packages/client/ui-mcp-session/tests/` 固定了触发器、面板、关闭行为、Host 停用行与两种写入结果。
