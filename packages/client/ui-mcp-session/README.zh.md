# @deepseek-ai/dsh-client-ui-mcp-session

输入栏工具行中，按会话开关 MCP 服务器。

## 它拥有什么

输入栏左侧工具行（`conversation.input.left`）上的一个条目，就在权限选择器旁边：一个紧凑的 `MCP` 触发器，显示本会话保留了已知服务器中的几个；以及一个开关面板，写入该会话自己的选择。开关在下一次请求即对模型生效——它所驱动的 Host 决定见 [`@deepseek-ai/dsh-mcp-session`](../../mcp/mcp-session/README.zh.md)。

- **读取**——每次打开时调用 `remote.mcpSession.list({ sessionId })`，因此面板始终显示 Host 此刻持有的行。已配置但从未连接的服务器与已连接的一同列出；Loader 启用状态为关闭的行（`hostEnabled: false`）渲染为 Host 停用提示而不是开关——会话无法暴露 Host 保持停止的服务器工具，重新启用它是 Settings 标签页的工作。
- **写入**——`remote.mcpSession.setServerEnabled({ sessionId, serverName, enabled })`，其返回的行会替换面板的列表。进行中的开关会锁住自己；被拒绝的写入会自行报告，并保留屏幕上已有的行。
- **关闭**——面板外的指针按下或 Escape 会关闭面板；触发器带有 `aria-expanded`，面板是一个具名的 `dialog`。

## 挂载位置

`packages/bundle/web-app/cordis.patch.yml` 为 Web 界面挂载它。它只声明 `slots`、`locale`、`remote` 与 `remote.mcpSession`，并且只注册一个插槽条目（`id: mcp-session`），因此缺少 Host 半边的部署根本不会渲染触发器。
