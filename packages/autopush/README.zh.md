---
description: "autopush 组地图：每会话一个门控发布功能，包含已记录开关、/autopush 命令、push_changes 工具，以及输入框仪表盘读取的投影。"
kind: "package-group"
---

# packages/autopush

[English](README.md) | 中文

## 概述

autopush 组拥有按会话生效的门控发布：一个已记录的开关、`/autopush` 命令、按土耳其语说明提交工作区并推送的 `push_changes` 工具，以及输入框仪表盘读取的 `autopush` 投影。门控关闭时不会发布。本组组合现有 seam，而不是自建新的 seam：系统提示词段落、由投影单元折叠的已记录事件，以及命令注册表。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`autopush`](autopush/README.zh.md) | 已记录开关、策略段落、`/autopush` 命令、`push_changes` 工具与 `autopush` 投影 | `ctx.autoPush` |

-----

<a id="related-documentation"></a>
## 相关文档

- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)——在门控打开时渲染 `autopush:policy` 文本的段落注册表。
- [人类命令子系统](../../docs/subsystems/commands.zh.md)——`/autopush` 命令注册进的注册表。
- [会话投影子系统](../../docs/subsystems/session-projection.zh.md)——`autopush` 单元折叠已记录开关与推送所经由的投影 seam。
- [会话持久化子系统](../../docs/subsystems/persistence.zh.md)——`autopush/mode` 与 `autopush/push` 事件如何持久化。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-autopush)——`dsh-autopush` 受支持的配置字段。
- [双语文档政策](../../docs/i18n/README.zh.md)——本组每份文档遵循的配对规则。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
