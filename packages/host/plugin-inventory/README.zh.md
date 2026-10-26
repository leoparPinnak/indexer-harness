---
description: "当前 Cordis Loader 插件状态的投影，附带每个 agent preset（智能体预设）的组合与 MCP 服务器的读取／切换／添加平面：面向 web GUI 宿主客户端的 pluginInventory 服务及其 Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-inventory

[English](README.md) | 中文

## 概述

客户端可以调用 `pluginInventory/list`，按加载顺序展示宿主的当前插件，包括每个条目的标识符、模块标识、有效启用状态与存活阶段。部署组合了 agent preset roster 时，还会报告各预设的元数据、健康状态与压平后的插件组合；没有 roster 时，预设数据缺席。MCP 服务器平面列出每一条已配置的 `@deepseek-ai/dsh-mcp-client` 行（并入其连接状态），切换它的 Loader 启用状态，并添加新服务器——全部经 `patchReload: live` 会重新组合的、`$DSH_HOME/cordis.patch.yml` 内以 id 为键的托管补丁块完成。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当客户端或设置页需要展示宿主当前组合了什么——哪些插件已加载、已启用、是否存活，以及每个 agent preset 会给会话什么——时调用 `pluginInventory/list`。Remote 是唯一入口：该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` 合并。

### 快照包含什么

每一行是一个非组 Loader 条目：其条目 id、精确模块标识、有效启用状态（含被禁用的祖先组）与当前根 Fiber 阶段。`pending` 表示条目等待加载，`loading` 表示正在读取，`active` 表示正在运行，`failed` 表示其 fiber 被拒绝，`unloading` 表示正在拆除；`null` 表示完全不存在存活的根 Fiber。结构性的 group 行会被跳过。

### 每个预设的组合

组合了 roster 时，`agentPresets` 按 roster 顺序携带每个预设一组：其 id、随部署内置还是用户自建（`trust`，客户端据此本地化内置预设名）、发布的显示名、未指名预设的会话是否组合它，以及压平后的插件行——条目 id（文件行未声明时为 null）、模块标识、有效启用状态、行自带的 `!!js` disabled 表达式（如有），以及组合存活时的根 Fiber 阶段。已有会话组合过的预设由其最新仍存续的世代作答——即使其文件事后损坏也是如此，因为挂载才是这些会话实际运行的组合；开机以来从未被组合的预设由其组合文件作答，disabled 门用 Loader 上下文求值，且读取从不挂载预设。`conditional` 表示宿主无法求值的门；无人组合的坏预设保留在列表中，携带原因且没有行。没有 roster 时该字段缺席。

### 你能用它做什么、不能做什么

清单行仍然是供展示与诊断的快照：客户端渲染名单、标出失败条目，并且只能通过比较快照检测变化。MCP 平面是刻意保留的例外——`pluginInventory/mcpServers` 报告每条已配置的桥接行并入监督者的最新转换，`pluginInventory/setMcpServerEnabled` 通过向 home patch 写一行托管 disable 行切换一行，`pluginInventory/addMcpServer` 则在管理块内追加一条完整的服务器 `insert` 行。切换与添加都需要 `$DSH_HOME`（缺失时高声失败），经由 Loader 的活补丁重载对会话输入栏可见，并保持托管块之外的每个字节原样。其余内容不携带历史、不移除任何东西。

### 托管补丁块

写入器拥有一个有界区域，按 id 行（`{"id":"mcp-rea","disabled":true}`）与服务器 `insert` 行构成，每行渲染一条 flow-JSON——既是本写入器精确的 `JSON.parse` 文法，又是 Loader 解析器的合法 YAML，因此不回环往返任何用户 YAML。重新启用会清扫它所切换条目的每一个 disable 写法，包括旧写入器可能留下的带树前缀 id（`include:mcp-rea`）：未清扫的过期行让服务器在"开启"切换之后永远保持关闭。对已列出的地址执行 disable 时什么都不写。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

网关是一层没有第二个生命周期真源的直接投影：每次 `list()` 调用都读取 `ctx.loader.entries()`，并把每个非组条目映射为公共行。Cordis 内部的 `plugin/status` 事件已经维护了 `Entry.fiber` 与 `Fiber.state`，因此再加缓存只会多出一个需要同步的生命周期真源。agent preset roster 是每次调用经 `ctx.get('agentPresets')` 解析的可选伙伴：所有预设读取都由它的 `compositionInventory()` 负责，本包只把根 Fiber 状态映射到公共阶段词汇。`mcpServers()` 与 `setMcpServerEnabled` 把同一轮 Loader 遍历与 `@deepseek-ai/dsh-mcp-client` 的状态注册表合并——分类（`serverNameOfLoaderEntry`）位于行所挂载的那个包内，补丁写入是 `patch.ts` 自己的文件系统副作用。

### 阶段映射

Fiber 状态映射到公共阶段词汇，其中 `disposed` 折叠为 `null`——fiber 已消失的条目没有可报告的存活根。因此阶段从不区分为什么没有存活根：条目可能从未启动，也可能其 fiber 已被释放。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInventoryGateway`：`pluginInventory` Remote 服务、Loader 投影与 MCP 服务器平面 |
| [`src/patch.ts`](src/patch.ts) | 托管补丁块：disable 行、服务器 `insert` 行、过期路径清扫、原子写入 |
| [`src/types.ts`](src/types.ts) | 公共 payload 类型：`PluginInventoryEntry`、`PluginInventorySnapshot`、`PluginFiberPhase`、`McpServerView`、`AddMcpServerRequest` |
| — | 不发布运行时不变式配套项；每个快照都投影 Loader 持有的状态。 |

Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当清单约定不够用时阅读以下内容：先看 Remote 如何到达客户端，再看它所投影的 Loader 与渲染它的界面。

- [Remote 组合](../../api/remotes/README.zh.md)——客户端如何在不导入 Host 实现的情况下消费 `pluginInventory/list`。
- [Cordis 插件 loader](../../../vendor/loader/README.md)——本包所投影条目的那个 Loader。
- [插件清单设置界面](../../client/ui-settings-plugin-inventory/README.zh.md)——渲染该清单并驱动 MCP 平面的浏览器侧投影。
- [MCP 客户端桥接](../../mcp/mcp-client/README.zh.md)——`mcpServers()` 所投影的行与它并入的状态注册表。
- [按会话的 MCP 可见性](../../mcp/mcp-session/README.zh.md)——消费本平面 Loader 读取的输入栏半边。

-----

<a id="model-experience"></a>
## 模型体验

无。这个仅限 Host 的只读 Loader 投影不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明即时清单无法向客户端提供哪些信息。它们是当前包约束，不是任务积压。

- **仅表示调用当下**——结果不包含持久的失败历史或订阅；只要不存在存活的根 Fiber，就会报告 `null`，而不区分其原因。
- **无来源**——服务不识别条目由哪个 bundle、profile 或 override 引入。
- **托管块只服务 MCP 平面**——切换与添加只写 id 行与桥接 `insert` 行；该块中的任意插件行仍是手改领域。
- **预设仅随 roster 出现**——未装 `dsh-agent-presets` 的部署只提供 Loader 条目；`agentPresets` 字段缺席而非为空。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
