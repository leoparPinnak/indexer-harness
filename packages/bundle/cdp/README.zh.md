---
description: "dsh 的 CDP 浏览器控制扩展：一个可安装的补丁层——宿主侧组合包发布扩展状态并通过 Chrome DevTools Protocol 驱动 Chromium 浏览器，另加右侧边栏的 CDP 标签页。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-cdp

[English](README.md) | 中文

## 概述

把 CDP 扩展作为独立的 profile 层安装：宿主组合包通过 `GET /api/server/cdp/status` 发布扩展状态，提供 `cdp_status` 模型工具，并以 `app:cdp-status` prompt 段为模型提供定位说明；Web GUI 右侧边栏则新增 `CDP` 标签页。该组合包由一个补丁（`cdp` 宿主行与 `ui-cdp-view` 浏览器行）和一个运行时插件组成。用 `dsh plugin --profile <name> add <package>` 把它交给另一台机器的 profile；它需要一个已经挂载 Web 服务器层（`dsh-web-app`）的 profile。

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

把该层加入 web profile 并启动：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-cdp
dsh --profile web
```

用 `dsh --profile web --dump-config` 验证该层存在：输出中会出现 `# == @deepseek-ai/dsh-cdp` 段。

### 配置

| Field | Default | Meaning |
|---|---|---|
| `remoteDebuggingPort` | `9222` | 浏览器远程调试端点的 TCP 端口；连接阶段附着到它 |
| `proxyListenPort` | `9333` | 扩展 HTTP 代理监听器绑定的回环端口；与 `remoteDebuggingPort` 相等的值会在加载时被拒绝 |
| `guideAssetsDir` | `''` | 存放指南 Web 的目录；留空则解析为组合包随附的 `assets/` 目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的穷尽来源。

### 挂载内容

- `GET /api/server/cdp/status`，位于 Connection 的 Host/Origin fence 之后。
- 模型工具 `cdp_status`，前提是 profile 挂载了 `tools` 注册表。
- `app:cdp-status` prompt 段，前提是 profile 挂载了 `systemPrompt`。
- `ui-cdp-view` 浏览器行：右侧边栏的 CDP 标签页。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

该组合包由一个补丁加一个运行时插件组成。补丁插入两行；插件注入 `webServer` 挂载状态路由，随后把工具推迟到 `tools`、prompt 段推迟到 `systemPrompt`，因此缺少这些注册表的 profile 仍能得到路由。`readCdpStatus` 是路由与工具共同应答的唯一本地读取；后续阶段会在它旁边为进程外状态加上镜像。

### 状态读取

`GET /api/server/cdp/status` 以 `200` 应答 `{ "ok": true, "version": "<已安装版本>", "targets": 0, "proxy": { "active": false } }`，并对其余方法以 `405` 及 `allow: GET` 应答。上报的版本来自本包清单，因此不会与实际安装的版本漂移。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `cdp` 插件：配置校验、路由与工具挂载、prompt 段 |
| [`src/status.ts`](src/status.ts) | 本地状态读取、状态路由与 `cdp_status` 工具 |
| [`src/types.ts`](src/types.ts) | 状态响应类型 |
| [`cordis.patch.yml`](cordis.patch.yml) | 该层：`cdp` 宿主行与 `ui-cdp-view` 浏览器行 |
| — | 不发布运行时 invariant 伴随件：每项注册都随 fiber 由注册表释放，各注册表所属包承载该关系的 invariant。 |
| [`tests/status.spec.ts`](tests/status.spec.ts) | 路由、工具、prompt 段、配置校验、释放 |
| [`tests/loading-composition.spec.ts`](tests/loading-composition.spec.ts) | 补丁经真实 Loader 树启动 |

### 不变式归属

不发布 invariant 伴随件，因为每一项贡献——状态路由、`cdp_status` 工具与 prompt 段——都随 fiber 由注册表释放，而每个拥有该关系的注册表包都承载它的 invariant。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

想深入了解共享内核或浏览器表面时阅读这些页面。

- [Bundle package map](../README.zh.md)——构建于同一内核之上的各个可安装补丁层。
- [dsh-web-app](../web-app/README.zh.md)——本行所挂载的浏览器层。
- [dsh-tools](../../core/tools/README.zh.md)——工具注册表与 `defineTool`。
- [dsh-host-webserver](../../host/webserver/README.zh.md)——状态路由所用的路由注册。

-----

<a id="model-experience"></a>
## 模型体验

### `app:cdp-status` prompt 段

#### 模型看到什么

当 profile 挂载 `systemPrompt` 时，该段以 `app:cdp-status` 注册在 `WEB_SURFACE` 顺序加 7 处，紧随 `app:shellbox-surface` 之后。它让模型了解该扩展、`cdp_status` 读取，以及只有启用远程调试启动的浏览器端点才可达这一要求。

##### `app:cdp-status` 原文

```markdown
DSH CDP Guidance:
- The CDP extension drives Chromium-based browsers over the Chrome DevTools Protocol through the `cdp_*` tools.
- Call `cdp_status` for the installed version, the live target count, and the proxy state; the CDP tab in the right sidebar shows the same state.
- A browser endpoint is only reachable while it was launched with remote debugging enabled.
```

#### Token 影响

只要挂载了 `systemPrompt` 注册表，就存在一个三行短 prompt 段；未挂载的 profile 不付出任何代价。每进程恒定。

#### KV Cache 影响

该段以固定顺序紧随 Web 表面各段之后，因此同一组合下的会话前缀保持稳定；供应商缓存复用不被保证。

### `cdp_status` 工具

#### 模型看到什么

存在 `tools` 注册表时，该工具以无参数注册，并返回与路由相同的读取结果：已安装版本、活动目标数与代理状态。结果渲染为一行，例如 ``CDP 0.1.5-rc.2: 0 target(s), proxy active: false.``

#### Token 影响

注册表挂载期间，每次请求的工具列表多一项，每次调用多一行短结果。每进程恒定。

#### KV Cache 影响

工具名、描述与空参数列表固定，因此已可复用的请求前缀保持稳定；调用只在那个前缀之后追加结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本阶段的预期行为。它们是当前的包约束，不是任务清单。

- **状态读取报告的是骨架而非发现结果**——在连接与代理阶段落地前，`targets` 恒为 `0`、`proxy.active` 恒为 `false`；两者都还不是实时探测。
- **两个配置字段尚无读取方**——`remoteDebuggingPort` 与 `proxyListenPort` 目前只支撑加载时的端口冲突检查，`guideAssetsDir` 已校验但在指南 Web 落地前未被读取。
- **CDP 标签页需要自己的包**——`ui-cdp-view` 行解析 `@deepseek-ai/dsh-client-ui-cdp-view`，它必须与本组合包一同安装。
- **需要 Web 服务器层**——该行注入 `webServer`；没有 `dsh-web-app` 的 profile 会让该层保持未挂载。
- **工具需要 tools 注册表**——没有 `tools` 的 profile 仍保留状态路由，但不挂载 `cdp_status` 工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`/api/server/cdp/status` 及其载荷是与 `ui-cdp-view` 共享的冻结线面；改动任一者都必须在同一次变更中带上客户端面板。`readCdpStatus` 刻意作为两个入口共同调用的唯一本地读取，这样后续阶段的守护镜像只需替换一处调用而不是两处。

</details>
