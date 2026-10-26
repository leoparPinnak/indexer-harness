# Agent Note：MCP 服务器状态面与其设置页面

Status: implemented

[English](2026-10-17-mcp-connection-status-plane.md) | 中文

## 问题

设置界面此前只把 MCP 服务器显示为 Cordis Loader 行——那是对已组装树的只读投影，没有连接状态、没有工具数量，也没有开关。操作者无法判断某个服务器是否已连接、注册了什么，也无法看出正是 `mcp-rea` 这样带 207 个工具的行在顶到提供方的工具数量上限；而要停用它，只能盲改 `cordis.patch.yml`。

第二个问题恰好就藏在手工编辑里：补丁列表按行**声明**的 id 定位该行（`mcp-rea`），而 Loader 报告的是带树前缀的路径（`include:mcp-rea`）。两者看起来可以互换，其实不能——用 Loader 路径写出的定向停用行匹配不到任何东西，只在 loader 日志里警告一次，服务器照旧运行。

## 决策

- **`packages/mcp/mcp-client/src/status.ts`** 拥有一个进程范围内的 `McpStatusRegistry`：按 `(scope, serverName)` 记录最近一次生命周期转换（`connecting` / `connected` / `reconnecting` / `failed` / `stopped`）、每次 `connected` 时的工具数量与公开工具名，以及重试或放弃背后的错误文本。`connection.ts` 在监管者的每个决策点写入记录。JSONL 历史严格按需开启，由新的 `statusLogPath` 配置控制：以 Harness home 为默认值曾把测试写入泄漏进真实 home，因此除非部署明确要求，`resolveStatusLogPath` 一律解析为 `undefined`。
- **`packages/host/plugin-inventory/src/patch.ts`** 在 `$DSH_HOME/cordis.patch.yml` 中拥有一个带写入者标记的受管区块。该文件是 home 用户层，最后合成——在所有 bundle 层以及 profile 自身的 `cordis.patch.yml` 之后（`apps/cli/src/profile-boot.ts`）——并被实时监听，因此受管的停用总是胜过引入该服务器的 `insert` 行，无论那行位于何处。切换只重写被分隔的区块；用户带 `!!js` 的 YAML 从不被往返序列化，重新启用也只移除受管行。
- **`PluginInventoryGateway`** 新增 `@Remote('mcpServers')` 与 `@Remote('setMcpServerEnabled')`。服务器行即带有已配置 `serverName` 的 `@deepseek-ai/dsh-mcp-client` Loader 行，与状态注册表中同名条目连接。
- **行的身份是补丁地址，而非 Loader 路径。** `mcpServers()` 报告 `entry.options.id`——补丁列表所索引的 id——因为那是 `setMcpServerEnabled` 唯一能写入的键。真实部署把该行报告为 Loader 路径 `include:mcp-rea`，而它的补丁列表称其为 `mcp-rea`。
- **设置界面是既有「插件」区块中的第二个标签页**（`packages/client/ui-settings-plugin-inventory`，注册项 `id: 'all'` order 10 与 `id: 'mcp'` order 20）。它列出每个已配置服务器的有效状态、工具数量、已记录错误，以及驱动 `setMcpServerEnabled` 的启用开关；进行中的切换会锁住自己的开关，被拒绝的写入会自行报告，同时不丢弃屏幕上已有的行。

## 备选方案

**新建 `packages/client/ui-settings-mcp` 包。** 已否决：MCP 页面读取同一个 Remote 命名空间（`pluginInventory`），并占据与相邻标签页相同的插槽（`settings.plugins.tab`），因此单独建包只会多出清单、bundle 行、README 配对与项目引用，而不会多出归属者。

**新增顶层设置导航区块。** 已否决：`ui-settings-plugins` 声明唯一的「插件」导航行，正是为了让功能插件贡献页面而「不与设置导航行竞争」；为单个标签页再加一个导航项会浪费该接缝的全部意义。

**把停用行写入 profile 自身的 `cordis.patch.yml`。** 已否决：那是操作者的文件，且已经放着切换绝不能打扰的 `insert` 行；受管区块只有在写入者完全拥有的文件里才安全。home 层就是这样的文件，而且最后合成。

**按 Loader 行 id（`include:mcp-rea`）切换。** 已否决：`applyEntryPatches` 索引的是补丁列表自身数据中声明的 id，因此带树前缀的行匹配不到任何东西，切换会静默失效。

**默认把状态历史记录到 Harness home。** 在观察到之后已否决：每个 DSH 会话都会导出 `DSH_HOME`，于是该默认值把测试流量写进了操作者的真实 home。现在记录是部署选择。

**在网关中缓存 Loader 投影。** 已否决：Cordis 本身已维护 `Entry.fiber` 与 `Fiber.state`，再加一层缓存只会多出一份需要同步的生命周期真相，读性能却毫无收益。

## 后果

- `@deepseek-ai/dsh-mcp-client` 多出一个可选配置字段（`statusLogPath`），它开启的 JSONL 流是观测手段而非传输通道：写入被拒绝会降级为仅有注册表的状态，绝不使连接失败。
- 切换无需重启即可生效：`patchReload: live` 会依据编辑重新合成，而 home 层监听器会在一个此前并不存在的补丁文件**被创建**时触发。
- `setMcpServerEnabled` 需要 `$DSH_HOME`，缺失时大声失败并指出缺失的变量：把补丁文件写到 Loader 从不读取的地方，比拒绝更糟。
- 跨 scope 复用同一个 `serverName` 的两个服务器会合并为一条注册表条目，与它们本就共享的单一公开工具名命名空间一致。
- 该标签页只报告 Host 状态。从未到达 Host 监管者的会话面服务器不会显示任何转换，读作「尚未连接」，而不是编造一个状态。
- `packages/host/plugin-inventory/tests/patch.spec.ts`、`mcp-servers.spec.ts`、`packages/mcp/mcp-client/tests/status.spec.ts` 与 `packages/client/ui-settings-plugin-inventory/tests/` 下的 jsdom 套件以每文件 100% 覆盖率为该平面提供保障；身份规则用注入的带树前缀 id 固定，因为裸 Loader 测试装置没有可合成该前缀的外层 include 树。
- **管理块语法升级（实况之后）：** 第一个真实部署写出了一行以树前缀路径（`include:mcp-rea`）为 id 的 disable 行——补丁列表无法匹配的地址——于是之后的每次「开启」切换都弹回原状，服务器一直处于关闭状态。该块现在每行渲染一条 flow-JSON（既是本写入器精确的 `JSON.parse` 文法，又是 Loader 解析器的合法 YAML），每次 disable 写入都会清扫任何以 `:<entryId>` 结尾的 id，而旧文本行作为升级路径被解码。
- **添加服务器写入 `insert` 行（实况之后）：** 添加曾是这一平面要关闭的手改领地。`pluginInventory/addMcpServer` 校验请求（serverName 模式、传输字段、名称与 id 唯一性），把 `{insert:[{id:"mcp-<名称>",name:"@deepseek-ai/dsh-mcp-client",config:{…}}]}` 写入同一个管理块，活动的补丁重载即可挂载该服务器——Settings 标签页拥有这个表单。
