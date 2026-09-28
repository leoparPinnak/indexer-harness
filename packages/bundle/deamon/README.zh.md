---
description: "dsh 的 Shellbox 桌面功能：一台隔离的私有 Windows 桌面，以独立 profile 层安装，实时串流进 Web GUI，模型可在其上启动应用、检视变更并发送输入，由内置 skill 提供模型侧使用手册。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-deamon

[English](README.md) | 中文

## 概述

把 Daemon 桌面作为独立的 profile 层安装：一台使用 Win32 API 创建的隔离私有桌面，实时串流到 dsh Web GUI 右侧边栏的 Daemon 标签页，模型通过 `shellbox_launch`、`shellbox_state` 与 `shellbox_input` 工具在它上面启动应用、检视桌面变更并发送输入，并由内置的 `shellbox` skill 提供完整使用手册。该组合包由一个补丁（`deamon` 宿主行与 `ui-sandbox-view` 浏览器行）和一个运行时插件（帧路由、WebSocket 传输、辅助进程守护、工具、skill、prompt 段）组成。用 `dsh plugin --profile <name> add <package>` 把它交给另一台机器的 profile；它需要一个已经挂载 Web 服务器层（`dsh-web-app`）的 profile。

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
dsh plugin --profile web add @deepseek-ai/dsh-deamon
dsh --profile web
```

随附的 `web` profile 模板已经列出该组合包，因此新建 profile 无需 add 步骤；已有 profile 使用上面的 `dsh plugin` 命令（tarball 与 git 包说明同样可用——参见 [publish.md](../../../docs/user/develop/basic/publish.zh.md)）。用 `dsh --profile web --dump-config` 验证该层存在：输出中会出现 `# == @deepseek-ai/dsh-deamon` 段。

### 配置

只有一个字段——多数用户无需设置：

| Field | Default | Meaning |
|---|---|---|
| `surfaceContext` | `true` | 注册模型可见的 `app:shellbox-surface` 与 `app:shellbox-changes` prompt 段 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-deamon)是每个可接受字段及其 JSDoc 的穷尽来源。

### 挂载内容

- `/api/server/sandbox/*` 下的路由，加上 `GET /api/server/sandbox/ws` WebSocket 帧传输，全部位于 Connection 的 Host/Origin + cookie 围栏之后。
- 一个仅绑定回环的共享辅助守护进程（默认端口 4005，`DEAMON_PORT` 可固定），按桌面执行 `sandbox/sandbox-host.ps1`。
- 模型工具 `shellbox_launch`、`shellbox_state` 与 `shellbox_input`、内置 `shellbox` skill，以及 `app:shellbox-surface` 与 `app:shellbox-changes` prompt 段。
- `ui-sandbox-view` 浏览器行：右侧边栏的 Daemon 标签页。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

该组合包由一个补丁加一个运行时插件组成。补丁插入两行；插件注入 `webServer` 挂载路由面，随后把 skill 注册推迟到 `skills`、prompt 段推迟到 `systemPrompt`，因此缺少这些注册表的 profile 仍能得到桌面路由。`shellbox_launch` 工具同样以推迟方式在 `tools` 上注册；`shellbox_state` 与 `shellbox_input` 也注册在那里，驱动等待中的 `agent/pre-step` 变更拉取，并把桌面变更折叠进 `sessionProjections` 上的 `shellbox` 投影。

### 串流路径

串流请求经 `DeamonManager.ensureRunning` 到达守护进程：优先从发现文件重新附着，否则重新拉起；守护进程独占采集，同时服务遗留 multipart 面与按会话的帧端点。WebSocket 路由把每个 multipart 部分重组后，每张 JPEG 作为一条二进制消息发送。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `deamon` 插件：路由挂载、skill provider、prompt 段、配置门 |
| [`src/sandbox.ts`](src/sandbox.ts) | 路由面、WebSocket 传输、会话/实例管理器、`shellbox_launch` 工具 |
| [`src/shellbox-changes.ts`](src/shellbox-changes.ts) | 变更拉取接缝、`shellbox` 投影、`shellbox_state` + `shellbox_input` 工具 |
| [`src/deamon.ts`](src/deamon.ts) | 独立的回环采集守护进程 |
| [`src/deamon-manager.ts`](src/deamon-manager.ts) | 每进程一个共享守护：启动、重新附着、转发 |
| [`src/skill.ts`](src/skill.ts) | 内置 `shellbox` skill provider |
| [`sandbox/sandbox-host.ps1`](sandbox/sandbox-host.ps1) | PowerShell 采集辅助脚本（随 `lib/` 一同发布） |
| [`sandbox/PROTOCOL.md`](sandbox/PROTOCOL.md) | 冻结的辅助进程与 HTTP/WS 线格式 |
| [`cordis.patch.yml`](cordis.patch.yml) | 该层：`deamon` 宿主行与 `ui-sandbox-view` 浏览器行 |
| — | 不发布运行时 invariant 伴随件：每项注册（路由、工具、skill provider、prompt 段）都随 fiber 由注册表释放，各注册表所属包承载该关系的 invariant；插件自身没有需要审计的可变状态。 |
| [`tests/sandbox-routes.spec.ts`](tests/sandbox-routes.spec.ts) | 路由面、WebSocket 传输、守护转发 |
| [`tests/deamon.spec.ts`](tests/deamon.spec.ts) | 守护生命周期与管理器转发 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 补丁经真实 Loader 树启动 |
| [`tests/skill.spec.ts`](tests/skill.spec.ts) | skill 候选项与正文加载 |
| [`tests/shellbox-state.spec.ts`](tests/shellbox-state.spec.ts) | 变更感知拉取、投影、prompt 提示行与工具契约 |

### 不变式归属

不发布 invariant 伴随件，因为每一项贡献——路由、工具、skill provider 与 prompt 段——都随 fiber 由注册表释放，而每个拥有该关系的注册表包都承载它的 invariant。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

想深入了解共享内核、浏览器表面或 skill 系统时阅读这些页面。

- [Bundle package map](../README.zh.md)——构建于同一内核之上的各个表面。
- [dsh-web-app](../web-app/README.zh.md)——本行所挂载的浏览器层。
- [skill](../../skill/skill/README.zh.md)——内置 skill 如何进入模型目录。
- [ui-sandbox-view](../../client/ui-sandbox-view/README.zh.md)——本层安放的浏览器面板。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-deamon)——每个可接受配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Shellbox 表面语境、工具与 skill

#### 模型看到什么

`surfaceContext` 为真时注册两段：`app:shellbox-surface`（顺序 10105，紧随 `app:web-surface` 之后）让模型了解 Shellbox 标签页、`shellbox_launch` 工具、完全授权的桌面（窗口可检视并控制、可向 win32 桌面发送鼠标与键盘输入；宿主桌面的输入一律被拒绝）、无 GPU 与控制台窗口规则，并指向 `shellbox` skill 获取完整手册；`app:shellbox-changes`（顺序 10106）在会话日志存在未检视的桌面变更时追加一行，一旦 `shellbox_state` 完整读取确认后即消失。存在 `tools` 注册表时，三份 schema 与其他工具一样注册：`shellbox_launch`（command、sessionId、instanceId）、`shellbox_state`（sessionId、instanceId、since、limit）与 `shellbox_input`（sessionId、instanceId、steps）；等待中的 `agent/pre-step` 拉取先把桌面变更写入会话日志，再推导提示行，因此告警与工具读取来自同一游标。当 profile 挂载了 skill 目录加载器时，`shellbox` skill 以一行 `<available_skills>` 出现，正文按需经 `skill` 工具加载——用户也可输入 `/shellbox` 阅读。`surfaceContext` 为假时两段都不注册；工具与 skill 不受影响。

#### Token 影响

工具注册时两段简短 prompt 加三份 schema；`app:shellbox-changes` 行仅在会话日志存在未检视变更时出现，因此干净会话只付出一个空段。skill 在加载前只贡献一行目录。每进程恒定。

#### KV Cache 影响

各段以固定顺序跟随 `app:web-surface`，因此工具与配置相同的会话前缀保持稳定；变更行仅在存在未检视条目时出现，供应商缓存复用不被保证。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明非常规环境下的预期行为。它们是当前的包约束，不是任务清单。

- **采集仅限 Windows**——辅助进程是 PowerShell/Win32 组件；路由处处挂载，但串流只在 Windows 上存在。
- **需要 Web 服务器层**——该行注入 `webServer`；没有 `dsh-web-app` 的 profile 会让该层保持未挂载。
- **skill 需要目录加载器**——没有 `tool-skill` 的 preset（如 `minimal`）永远看不到 `shellbox` 目录行，手册只能在挂载了用户可调用加载器的 profile 中以 `/shellbox` 触达。
- **前景取决于采集顺序**——辅助进程把当时最顶层的窗口装入视口，从不调用 `SetForegroundWindow`；出现哪个窗口取决于拾取瞬间的 z 序。
- **实例记录持久化**——`$DSH_HOME/sandbox-instances.json` 在重启后保留，可能列出过期实例；桌面名在 16 字符处截断，长会话 id 依赖冲突后缀区分。
- **桌面不会空闲退出**——所有查看者离开后采集仍持续运行；只有 `POST /api/server/sandbox/stop`、实例终止或服务端关闭才会结束它。
- **变更感知需要 `sessionProjections`**——没有投影注册表的 profile 从不记录桌面变更，`shellbox_state` 会以明确报错拒绝，而不是凭空猜测。
- **输入需要运行中的桌面辅助进程**——在 win32 shellbox 桌面就绪前，`shellbox_input` 返回无辅助进程消息；宿主桌面的输入始终被拒绝。
- **桌面 profile 按需添加**——随附的桌面 profile 只列出 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`；运行 `dsh plugin --profile <desktop-profile> add @deepseek-ai/dsh-deamon` 即可在其中挂载本组合包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

该功能原先位于 `dsh-web-app`（`src/sandbox.ts` 及其同僚），此后作为一层可分发的组合包迁到此处。`/api/server/sandbox/*` 路径与 `shellbox_launch` 模式是与 `ui-sandbox-view` 共享的冻结线面；改动任一者都必须在同一次变更中带上客户端面板与 `sandbox/PROTOCOL.md`。

</details>
