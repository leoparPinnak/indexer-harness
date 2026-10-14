---
description: "Web GUI 的压缩控制：带每会话触发点的上下文占用环、立即压缩动作与每会话压缩设置；供压缩体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-context-control

[English](README.md) | 中文

## 概述

composer 上下文控制：带每会话压缩触发点的上下文占用环、`Sıkıştır`（立即压缩）动作，以及每会话压缩模式设置（策略、摘要模型、预算、上限）。它占据 ui-conversation 的 `conversation.input.context` 座位，且不自行安排模型请求。

每个数值都带有范围标记——绿色表示仅本会话的设置，蓝色表示部署全局的设置。压缩上限的默认值可通过本包在 General 设置页的 `settings.general.item` 行（`compaction-basic.maxTokens`）编辑。

占用量与触发点来自 `contextPressure` 与 `compactionPolicy` Session 投影；在请求记录自身路由容量之前，计量环以模型目录的 `contextWindow` 计量，因此全新会话显示为零而不是隐藏。设置经 `session.setCompactionMode` 保存，压缩动作经 `remote.commands` 提交 `/compact`。文案位于 zh/en/tr 语言词典中。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 由本控件调度的压缩摘要

#### 模型看到什么

本包不直接向模型呈现任何内容：它渲染 Session 投影值并提交持久意图。专用策略设置把后续压缩摘要路由到所选提供方/模型，压缩动作则立即运行 `/compact`；两者产生的提示词固定在 `@deepseek-ai/dsh-compaction-basic` 的模型体验中。

#### Token 影响

自身为零。每会话预算与触发点改变自动压缩从何处开始、以及占用环把多少占用量报告为已满，因此也改变 `@deepseek-ai/dsh-compaction-basic` 何时支付其摘要成本。

#### KV Cache 影响

自身为零。压缩的前缀缓存行为归 `@deepseek-ai/dsh-compaction-basic` 的模型体验所有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前的压缩控制。它们是当前包约束，不是任务积压。

- 专用摘要器选择器通过 `session.modelCatalog` 提供可路由的模型目录；仅在提供方自身列表中已知的模型，可在相同字段中自由填写。
- 数值型预算与触发点字段只接受原始 token 数。带单位的简写输入（300k）已延期，直到各设置表单共用同一个解析器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口；本包只注册呈现，除其读取的投影与 remote 外不拥有独立的运行时关系。
