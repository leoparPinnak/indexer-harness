---
description: "工具结果 spill 策略：部署如何用预览和可检索的 spill 文件把过大的纯文本工具结果挡在模型上下文之外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

[English](README.md) | 中文

## 概述

当过大的纯文本工具结果不应进入模型上下文时，挂载本包。超过适用预算——默认是 `maxInlineBytes`，除非 `toolLimits` 的逐工具行另有规定——的结果会变成总计数收据、有界的首尾预览与 `[budget notice]`；完整文本仍可通过已配置的 spill 后端访问。spill 失败时原始结果仍然可见，省略 `maxInlineBytes` 则会禁用该策略。同一预算也约束 `run_code` 子调用的持久日志副本，但不会改变程序收到的值。

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

把策略与 spill 后端一起挂载，以限制模型看到的工具纯文本结果大小。上限作用于工具运行后的最终结果；策略放过的结果仍会原样通过。

### 最小配置

以 UTF-8 字节计的 `maxInlineBytes` 预算加载策略，并同时挂载 spill 后端：

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInlineBytes` | 省略 | 纯文本结果面向模型的默认上下文上限（UTF-8 字节）；省略时完全禁用该策略 |
| `toolLimits` | `{ read: 'skip' }` | 覆盖在内置默认之上的逐工具保留行：非负字节预算，或 `'skip'` 表示该工具的面向模型结果保持内联 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-spill-policy)是每个受支持字段的穷尽式真源。负数或小数的上限或行会让插件加载失败，而不是破坏每次调用的行为。

### 模型看到什么

过大的纯文本结果会在同一预算内被替换为信封（envelope）加通知，因此整个替换内容永远不会超过适用预算：

```text
spill: { chars: 1600, bytes: 1600 }
<retained head>
[truncated after 200 bytes]
<retained tail>

[budget notice] (Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

收据行保留预览无法展示的总计数，截断标记说明截断结果的预算，`[budget notice]` 前缀表明这是预算决策而非工具失败。当没有预览字节能容纳时（预算极小或定位信息很长），只返回收据与通知；如果连这也会超过预算，策略会保留原始内联结果——预算内的替换内容总比原始结果小。完整文本仍保留在 spill 文件中，成功的替换只改变面向模型的副本，绝不改变规范的程序化结果。

### 逐工具保留行

`toolLimits` 按工具细化全局上限：数值行对该工具的面向模型结果取代 `maxInlineBytes`，`'skip'` 则保持内联而不 spill。内置默认携带 `read: 'skip'`，因此有文档记载的 read → spill → read 循环保护是数据而非硬编码的名称检查。行本身绝不会单独启用策略——省略 `maxInlineBytes` 仍会禁用一切——数值行还会细化该工具的持久日志副本，而 `'skip'` 行不会（日志副本不是模型上下文，日志分支保持设界）。

### 预算耐久性

每次持久化尝试都会驱动两台状态机。thrash（颠簸）检测器报告同一产物被连续 spill 三次——这是文件或工具输出对上下文窗口过大的 spill 侧信号——并给出建议：分块读取，或开启新会话。断路器在连续三次 `saveText` 失败后打开，记录一条清晰错误，随后在本次会话内保持结果内联：故障后端只付出一条消息，而不是每次超大结果一次失败写入。两者都按尽力而为降级，因此 spill 问题绝不会改变工具调用的结果。

### 哪些结果会受影响

策略只作用于最终、已接受且纯文本的结果。不超过适用预算的结果、包含任何非文本块的结果、嵌套复合调用、行声明为 `'skip'` 的结果（默认为 `read`）、被阻止的决策与已接受的值替换都会原样通过。此前已经发生的提供方级截断（例如 `web-fetch-http.maxBodyChars`）无法在此恢复——spill 文件保存的是工具实际返回的内容。

### 尽力而为的故障行为

缺少会话所有者、缺少 `ctx.spillStore` 后端或 `saveText` 拒绝时，会记录警告并返回原始结果。连续三次拒绝会打开断路器，它记录一条清晰错误，随后不再尝试保存并保持结果内联。spill 失败绝不会把成功的调用变成错误，也绝不会隐藏内联结果。

### 持久日志副本

同一逐工具预算也约束每个 `run_code` 子调用结果的会话日志副本：程序仍会收到完整值，只有日志副本被替换为信封与定位信息。过大的 `read` 子调用结果在此同样设界，因为日志副本不是模型上下文——`'skip'` 行只约束模型看到的内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该策略背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该策略刻意保持狭窄：它只决定**何时**、按**什么预算** spill，并组合信封与通知。它不注册服务、不负责存储、也不负责预览机制——`dsh-output-retention` 的 `TextRetainer` 负责构建首尾预览。两个不变式塑造了代码：面向模型的替换永远不会超过适用预算（先为信封行与通知预留字节成本），且 spill 失败永远不会改变工具调用的结果。

### 两条分支

`tools/post-execute` waterfall（瀑布式事件）监听器（以 `prepend` 注册、通过 `next()` 委托）约束面向模型的结果；`tools/ptc-dispatch-log` 监听器约束每个 `run_code` 子调用的持久日志副本。两者共享同一个替换辅助函数，因此两个投影字节一致。post-execute 分支查询逐工具行——内置的 `read: 'skip'` 行避免 read → spill → read 循环；dispatch-log 分支约束 `read` 子调用，因为日志副本不是模型上下文。

<a id="shared-notice-ownership"></a>
### 共享通知的所有权

浏览器安全入口 `@deepseek-ai/dsh-spill-policy/notice` 同时负责生产方使用的 `formatSpillNotice(omitted, ref)` 和展示消费方使用的 `hasSpillNotice(text)`。格式化与识别共用通知分隔符；省略信息通过现有的 `describeOmitted` 格式化函数校验，而非复制一套文案。识别支持预览之后或单独出现的完整末尾通知，既支持带标记的 `[budget notice] (…)` 拼写，也支持早期版本记录的不带标记的拼写，因此标记出现之前持久化的会话保持原有呈现。它只读取已记录的文本，不改写文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 校验、逐工具行解析、两个 waterfall 监听器、共享替换辅助函数 |
| [`src/notice.ts`](src/notice.ts) | 浏览器安全的通知格式化与识别，以 `./notice` 发布 |
| [`src/envelope.ts`](src/envelope.ts) | 首尾信封行：总计数收据与截断标记，以 `./envelope` 发布 |
| [`src/resilience.ts`](src/resilience.ts) | thrash 检测器与持久化断路器状态机 |
| [`src/types.ts`](src/types.ts) | `SpillPolicyExec`：策略读取所属会话 id 所需的最小结构化工具执行视图 |
| — | 不发布运行时不变式伴生入口；除在所属 seam 处强制执行的约定外，本包不公开独立的事件序列或可变数据关系。 |

### 故障模式

两条分支都适用尽力而为降级：没有会话所有者、没有后端、保存被拒绝、断路器已打开或没有预算内的替换时，记录警告并保留原始内容。加载时校验会拒绝负数或小数的 `maxInlineBytes`，以及既非非负整数也非 `'skip'` 的 `toolLimits` 行，让错误配置失败在部署阶段，而不是让每次超大调用都失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [spill 存储服务](../spill/README.zh.md)——策略替换背后的 `saveText` 约定。
- [dsh-spill-local](../spill-local/README.zh.md)——保存 spill 文本的本地后端。
- [dsh-output-retention](../../util/output-retention/README.zh.md)——策略组合的预览机制（`TextRetainer`）。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

### 过大的纯文本结果

#### 模型看到什么

不超过适用预算的结果、嵌套结果、行声明为 `'skip'` 的结果（默认为 `read`）、被阻止的决策与包含非文本块的结果保持不变。过大的纯文本面向模型结果会变成信封——`spill: { chars, bytes }` 收据、保留的首部、`[truncated after <budget> bytes]` 标记与保留的尾部——后面附加 `[budget notice] (Omitted <bytes> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`；存储或归属失败、或断路器已打开时，原始结果仍然可见。

#### Token 影响

成功的替换最多为适用预算的 UTF-8 字节数，并保留在历史中直到压缩（compaction）；完整 spill 文本不会重新发送给模型。同一产物的重复 spill 或连续三次保存失败通过宿主警告报告，而不是通过结果文本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略在哪些情况下无法提供帮助。它们是当前的包约束。

- **文本识别无法认证输出来源**——工具也能打印相同的通知文本；`hasSpillNotice` 识别的是文本约定，不能证明策略保存过结果。
- **只能对最终纯文本结果执行 spill**——混合内容结果、阻止反馈与行声明为 `'skip'` 的结果（默认为 `read`）会原样通过；此前已经发生的提供方截断或工具自有保留无法在此恢复。
- **信封有下限**——收据行、截断标记与通知都必须装进预算，低于该下限的预算（或很长的定位信息）会让过大的原始结果留在内联位置，而后端已经保存了无引用的 spill。
- **断路器是粘性的且带外报告**——一旦打开，它在插件重新加载前保持结果内联；thrash 检测通过宿主警告报告，而不是结果文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性。

#### 未来：更早的 spill

该策略只能看到最终格式化文本，因此已被提供方截断或只以运行时产物形式存在的内容（例如 bash 流或 subagent 展开）仍在触达范围之外；通过 `ctx.spillStore` 实现的工具自有早期 spill 仍然延期。

</details>
