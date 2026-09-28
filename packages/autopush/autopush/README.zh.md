---
description: "面向单个会话的门控自动推送：由输入框停靠区与 /autopush 命令写入的已记录开关、带土耳其语说明提交并推送的 push_changes 工具，以及其仪表盘读取的 autopush 投影。"
kind: "package-reference"
---

# @deepseek-ai/dsh-autopush

[English](README.md) | 中文

## 概述

自动推送是按会话生效的门控。`/autopush on|off` 命令与输入框按钮写入同一个仅记日志的整值开关；开关打开时，本包贡献 `autopush:policy` 系统提示词段落并接受 `push_changes`，后者按调用方给出的土耳其语说明提交会话工作区，并推送到配置的远端与分支。`autopush` 会话投影把开关与每一次已记录的推送折叠为 `{ enabled, count, lastAt, history }`，供输入框仪表盘读取。门控关闭时不会推送，无事可发布的一次调用不记录任何推送。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

配置好 `remote` 与 `branch` 后挂载本插件。每个会话都从门控关闭开始，开关读取自会话日志而不是 Host 内存，因此恢复或 fork 的会话会还原它原先的状态。

### 最小配置

两个字段都必填，任何其他键都会在加载时失败。

```yaml
- name: '@deepseek-ai/dsh-autopush'
  config:
    remote: origin
    branch: master
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `remote` | 必填 | 推送前往的远端 |
| `branch` | 必填 | 推送前往的分支 |

`remote` 或 `branch` 为空时会在加载时失败，错误为点名该字段的 `AutoPushConfig` 错误；存在多余键时失败，错误为 `AutoPushConfig has unknown key(s) <keys> — config is { remote, branch }`。

### 开关门控

输入 `/autopush`、`/autopush on` 或 `/autopush off`；不带参数的 `/autopush` 表示开启，其他参数返回 `Use /autopush, /autopush on, or /autopush off.`。命令成功的文本为 `Oto-push açık. İstek tamamlandığında push_changes çağrılacak.`、`Oto-push zaten açık.`、`Oto-push kapalı.` 或 `Oto-push zaten kapalı.`。状态变更会立即追加 `autopush/mode`；与已记录值相同的请求返回 `noop`，不追加事件。

[`dsh-client-ui-autopush`](../../client/ui-autopush/README.zh.md) 里的浏览器按钮运行的就是这两条命令，因此已记录的开关只有一个写入方。

### 一次推送做什么

`push_changes({ message })` 在会话工作区运行 `git status --porcelain`。自动推送开启时，模型根据推送决策指南评估工作是否达到可推送水平，在交付回答后向用户提出推送提议，并在获得确认后调用 `push_changes`。工作区有改动时，它依次运行 `git add --all`、`git commit -m <message>`、`git push <remote> <branch>`，成功后记录 `autopush/push`。工作区干净时，它只推送远端尚未拥有的已提交内容：`git rev-list --count HEAD ^<remote>/<branch>` 非零时执行一次 `git push`，为 `0` 时返回 `Pushlanacak değişiklik yok.` 且不记录任何内容。

某一步失败会让调用以 git 的 stderr 失败。提交已完成而推送失败时，报告 `commit oluştu ama push başarısız (HEAD: <sha>): <stderr>. Sorunu giderdikten sonra push_changes çağrısını tekrar deneyin.` 并保留该提交，后续调用可将其发布。空说明在任何 git 命令之前被拒绝，错误为 `push_changes needs a non-empty Turkish description`；门控关闭时的调用被拒绝，错误为 `push_changes is refused while auto-push is off; the user turns it on from the composer`。没有 `cwd` 的会话失败，错误为 `push_changes needs a session workspace, and this session has no cwd`。

### 仪表盘投影

`autopush` 投影 key 携带 `{ enabled, count, lastAt, history }`。`count` 统计日志中的每一次推送，`lastAt` 是最新推送时间或 `null`，`history` 按最新在前排列，最多 50 条记录；日志保留每一次推送。能力缺失表现为该 key 缺失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

自动推送是产品包而不是能力 seam：状态、策略文本、命令、工具与投影都在同一个插件里。持久化方案是两条仅记日志的事件，`autopush/mode`（整值替换）与 `autopush/push`（仅追加），因此模型读到的指令与读者点击的开关是同一个从日志回放出来的值。

控制器注入 `systemPrompt`、`sessionProjections` 与 `tools`。命令子插件只在 `ctx.inject(['commands'])` 下激活，因此没有命令注册表的组合仍会注册提示词段落、投影与工具。门控关闭时工具被拒绝；`push()` 先检查说明、再检查门控与工作区，因此空参数作为调用方的错误失败。

git 访问经由 `src/git.ts` 中可注入的 `GitRunner`；生产路径使用 `execFile` 而不是 shell，因此土耳其语提交说明会作为一个参数到达 git。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`resolveConfig`、`pushWorkspace`、`ctx.autoPush` 服务、`autopush:policy` 段落、`/autopush` 命令、`push_changes` 工具 |
| [`src/types.ts`](src/types.ts) | 两个 `SessionEventMap` 成员与 `autopush` 投影声明 |
| [`src/git-status.ts`](src/git-status.ts) | 工作区 Git 初始化与远端存在性检测 |
| [`src/git.ts`](src/git.ts) | 可注入的 `GitRunner` 与 `execFile` 实现 |
| [`src/client.ts`](src/client.ts) | types 出口的客户端命名空间再导出 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-client-ui-autopush](../../client/ui-autopush/README.zh.md)——读取本包投影并派发其命令的输入框按钮与仪表盘。
- [session projection](../../session/session-projection/README.zh.md)——把两条已记录事件折叠为协议视图的注册表。

-----

<a id="model-experience"></a>
## 模型体验

### 自动推送策略系统提示词

#### 模型看到什么

会话门控打开时，模型会在 first-party 提示词顺序 510 处看到本包的原样策略文本；门控关闭时 `autopush:policy` 段落不贡献任何文本，没有 agent 的请求同样不贡献。

##### 策略文本

```markdown
Auto-push is ON for this session. When you have actually finished the request and its checks pass, call `push_changes` once with a short TURKISH description of what changed. Do not push mid-conversation, while still investigating, or on a half-finished change: the counter and history must mean "the user agreed to publish this". If there is nothing new to publish, the tool says so and changes nothing.
```

#### Token 影响

该段落在每次组装中都会注册，但门控关闭时渲染为空，因此不产生 token；门控打开时，它把这段固定文本加入每个请求。

#### KV Cache 影响

门控保持打开期间文本稳定；打开或关闭会从 first-party 顺序 510 起改变系统提示词。

### 推送工具

#### 模型看到什么

`push_changes` 在两种状态下都已注册。它的参数是一个必填字符串 `message`，描述为用作提交说明的简短土耳其语文本；结果是 `{ pushed, sha, files, detail }`。门控关闭时工具被拒绝，错误为 `push_changes is refused while auto-push is off; the user turns it on from the composer`，因此关闭状态下的调用结果是错误而不是一次推送。

#### Token 影响

工具 schema 在组装工具时进入请求目录；每次调用会在对话历史中增加一次工具调用与一条结果。

#### KV Cache 影响

切换门控不改变 schema，因此前缀中的工具目录保持稳定；调用与结果在前缀之后扩展对话。

### 人类命令

#### 模型看到什么

`/autopush on` 与 `/autopush off` 留在模型历史之外。命令追加 `autopush/mode`，并把终端文本返回给读者；它不贡献用户消息，也不贡献模型上下文。

#### Token 影响

该命令不为任何请求增加 token。

#### KV Cache 影响

切换门控会从 first-party 顺序 510 起改变 `autopush:policy` 段落，从而改变请求前缀；命令文本本身从不进入请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **门控按会话生效**——每个会话折叠自己的 `autopush/mode`，在一个会话中打开不会影响其他会话。
- **协议历史上限为 50 条**——日志保留每一次已记录的推送，但投影的 `history` 只携带最新的 50 条记录。
- **推送失败会保留其提交**——提交留在工作区中，下一次调用会发布它；工具报告失败而不是回滚。
- **推送目标是部署固定的**——`remote` 与 `branch` 来自插件配置，不能按会话或按调用更改。
- **缺少工作区会使调用失败**——没有 `cwd` 的会话无法发布，工具会报告这一点而不是发布到别处。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。持久事实是那两条已记录事件；投影折叠由 `SessionProjectionRegistry` 驱动，git 结果由注入的 `GitRunner` 固定。
