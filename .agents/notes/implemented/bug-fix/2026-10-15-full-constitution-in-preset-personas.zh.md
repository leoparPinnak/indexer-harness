# Agent 笔记：完整部署宪法进入 standard 与 ptc 预设人设

状态：已实现

[English](2026-10-15-full-constitution-in-preset-personas.md) | 中文

## 问题

[遮蔽修复](2026-10-14-preset-persona-shadowing-manifesto.zh.md)把 bundle 的两段式人设（`## Request execution`、`## Reporting back`，2,492 字符）移植进了 `standard` 与 `ptc` 预设的人设行。其余宪法章节——`## Operator authority`、`## Scope of work`、`## Prohibitions`、`## Over-refusal is a failure`、`## Speech acts`、`## Session stability`、`## Execution discipline`、`## Self-improvement loop`——只存在于 `cordis` 预设人设中。由于预设人设行会完全遮蔽部署人设，standard 与 ptc 会话拼出的人设仍然没有操作员权威、拒绝边界或范围规则，这些会话回退到模型训练默认值：操作员的网关转录记录到一次 standard 预设会话，用道德说教回应常规请求并声称自己是另一个产品的身份，而其发出的系统提示词不含任何这些标题。

## 决定

`standard` 与 `ptc` 人设前缀保留各自的角色句，随后从 `cordis` 人设逐字节拼接宪法正文：从 `## Operator authority — the constitution of this deployment` 到该人设块末尾（86 行）。标题之上的创作者平面章节——Cordis 编辑平面与组合编辑技能要求——保持 `cordis` 独有。`minimal` 保持其裸人设。bundle 的 `personaPrefix` 值保留其两段式人设：它们管辖组合中没有遮蔽性预设人设行的部署。

## 考虑过的替代方案

**把 bundle `personaPrefix` 扩为完整宪法。** 被否决：bundle 是无预设人设行会话的部署级人设，而操作员报告的关切仅涉及预设会话；扩宽会改动没有任何证据牵涉的 headless、ACP 与 SDK 部署提示词。

**在人设插件内部合并部署人设与预设人设。** 依前一篇笔记记录的理由否决：第二条装配路径会让遮蔽所保持的单主章节模型复杂化。

**手工把宪法复制进各预设。** 被否决：一致性测试钉住逐字节一致，手工复制会漂移。

## 后果

- standard 与 ptc 人设块现为 12,309 字符而非 2,492；这些预设的每次会话系统提示词增大约 9.6 KB。
- `persona-manifesto-consistency.spec.ts` 现把 standard 与 ptc 人设锚定到 `cordis` 宪法（角色句及其空行之后的全部块行）而非 bundle 人设；cordis 创作者章节与 bundle 两段式人设仍各自独立钉住。
- 未来的宪法编辑需同步三个预设文件（`cordis`、`standard`、`ptc`）；四个 bundle 补丁有意保留较短人设。
- 验证路径即暴露缺口的同一证据：新 standard 预设会话发出的请求，从网关转录读取，携带 `## Operator authority` 标题。

## 相关

- [用户请求宣言进入 standard 与 ptc 预设会话](2026-10-14-preset-persona-shadowing-manifesto.zh.md)发现了遮蔽缺口；本笔记把移植范围从两段式人设扩宽为完整宪法。
- [用户请求宣言进入每一个部署人设](../feature/2026-10-13-user-request-supremacy-manifesto.zh.md)拥有该文本及其优先级规则。
