---
description: "dsh Web 客户端的输入框停靠区自动推送条目：一个通过 /autopush 开关会话门控的按钮，显示推送次数与上次推送时间，以及列出该会话推送历史的仪表盘。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-autopush

[English](README.md) | 中文

## 概述

自动推送的浏览器一半：输入框 `conversation.composer.dock` 座位（输入栏下方那一行）中的一个条目。按钮通过 `ctx.remote.commands.execute` 运行 `/autopush on` 或 `/autopush off`，而不是自己写状态；它显示会话的推送次数与最新推送时间 `ss:dd`，并打开一个以完整本地 `gg.aa.yyyy ss:dd` 时间戳列出该会话推送历史的仪表盘。它读取 Host 的 `autopush` 投影，因此读者看到的状态就是模型被给予的状态。开关、`autopush:policy` 提示词段落与 `push_changes` 工具属于 [`dsh-autopush`](../../autopush/autopush/README.zh.md)；本包不注册任何面向模型的内容。

## 目录

- [注册了什么](#what-it-registers)
- [按钮与仪表盘](#the-chip-and-the-dashboard)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **停靠区条目**：`ctx.slots.inject('conversation.composer.dock', ...)`，以 id `autopush`、order 10、locale 命名空间 `autopush` 注册 `PushDock`。
- **词典**：`autopush` 命名空间及其 `zh`、`en`、`tr` 三份文案。
- **注入动词**：`setEnabled(enabled)`，在会话上执行 `/autopush on` 或 `/autopush off`，并把被拒绝的执行映射为一行内联错误。

Host 一半（[`src/index.ts`](src/index.ts)）不注册任何内容；全部界面位于 [`src/client/index.ts`](src/client/index.ts)、[`src/client/PushDock.tsx`](src/client/PushDock.tsx) 与 [`src/client/locales.ts`](src/client/locales.ts)。

<a id="the-chip-and-the-dashboard"></a>
### 按钮与仪表盘

投影缺失的会话不渲染任何内容。否则按钮显示 `⚡ Auto-push`，门控打开时呈按下状态，旁边是推送次数与最新推送时间 `ss:dd`，尚未记录任何推送时显示该命名空间的“尚未推送”一行。点击按钮请求相反的状态，并在 Host 确认变更前保持显示投影的值；被拒绝的执行会内联显示其消息，而不会移动按钮。

仪表盘从次数控件以对话框形式打开，列出会话状态、次数以及完整本地 `gg.aa.yyyy ss:dd` 的最新推送，随后按最新在前列出历史，每条记录包含完整时间戳、土耳其语说明、短提交 id、文件数与 `<remote>/<branch>`。按 Escape 或关闭控件都会关闭它。面板除自身是否打开外不持有状态：它列出的一切都来自 `autopush` 投影。

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-autopush](../../autopush/autopush/README.zh.md)——拥有已记录的开关、策略段落与推送工具。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 `conversation.composer.dock` 座位。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过按钮派发的 `/autopush on` 或 `/autopush off` 命令行：`dsh-autopush` 拥有面向模型的 `autopush:policy` 段落与 `push_changes` 工具。

#### KV Cache 影响

打开或关闭门控会改变 `autopush:policy` 段落是否从 first-party 顺序 510 起贡献文本，从而改变请求前缀；按钮本身不增加任何提示词内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **状态来自 Host**——按钮从不持有本地开关；它显示已记录的开关，并等待投影确认每一次变更。
- **仪表盘只列出会话内有上限的历史**——它渲染投影按最新在前排列的记录，最多 50 条，从不直接读取日志。
- **文案使用单个命名空间**——按钮与仪表盘渲染自己的 `autopush` 命名空间，不复用对话外壳的字符串。
- **挂载决定可见性**——停靠区条目只在挂载本包的 profile 中存在；Host 侧的开关与工具没有它也能工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。停靠区唯一的状态是面板是否打开；开关、次数与历史都是 Host 投影折叠出的值。
