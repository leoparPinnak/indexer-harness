---
description: "Host 与 Client 工作区控制：修改工作区导航并跟随其完整投影。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，从 Workspace 导航中归档 Session，在收藏文档中为 Session 加星与取消加星，以及跟随完整的 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定 `workspace/*` 或 `directory-picker/*` 错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order` 和 `archived` 增量。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、已归档 Session id、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。

Session 收藏是一个 JSON 文档（`{"sessionIds": [...]}`，按加星顺序），其绝对路径来自必填的 `favoritesFile` 配置字段；Web bundle 把它指向部署 `$DSH_HOME` 内的 `sessions/favorites.json`。`listFavorites` 读取它，`setFavorite` 通过原子写重写它，并串行化以免两次切换相互交错。文档缺失时读作空，文档损坏时错误信息中带有路径，Client 模型把得到的顺序与归档集放在同一份快照里。收藏只记录 Session：打开其中一项即导航到该 Session，文档永远不会被复制进 Session 日志。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织与 Session 收藏属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。
- 收藏文档属于整个部署，且不在 Workspace 流的跟踪范围内：另一个 Client 的加星只会在此处下次启动或载体重连时出现，而某个 Session 被删除后其 id 仍留在列表中（UI 会跳过缺少 Session 的行）。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Workspace 注册表负责持久化，每次流生成都是完整投影。
