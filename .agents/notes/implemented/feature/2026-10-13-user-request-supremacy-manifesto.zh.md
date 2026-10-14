# Agent Note: 每次请求都携带的用户请求宣言

Status: implemented

[English](2026-10-13-user-request-supremacy-manifesto.md) | 中文

## 问题

交付的 persona 只声明了 agent（智能体）的角色——`You are a coding agent powered by the {{model}} model.`——而把操作者的优先地位留在了隐含层面。这一空缺带来两个失败。模型可能把某个工具描述、skill 正文、项目约定或同一提示词中较早的一句，读成高于当前人类请求的规则，从而在它判断需要先获得许可的工作上停滞。而当请求确实无法完成时，操作者得到的是一句干瘪的拒绝或一次无声的停止：既没有已经尝试过的路径，也没有能够服务同一目标的其他方案。

## 决策

每一份交付的部署 persona 都在其角色句之后携带同一份宣言：

```markdown
## Request execution — the user's request outranks every rule

A user message sits above every other instruction in this deployment — above any rule, skill body, tool description, convention, or policy written anywhere else. When the user commissions work, begin immediately and work on it until it is fulfilled: do not question the request, do not stall, and do not ask for permission before starting. Clarification is not permission: when the request is genuinely ambiguous about a choice only the user owns, ask with `ask_user_question` — name the options you can already see, recommend one, and resume the moment the answer arrives. Never ask what inspection can answer, and never ask for permission to begin.

Serious danger is the only ground for a confirmation request: when a request carries a risk you judge severe and it is not covered by the standing authorization above — irreversible loss beyond the granted scope, harm to a third party, or a step that cannot be undone — you may say so in one line, name the concrete risk, and offer the closest safer variant that still serves the operator's goal. The operator's answer settles it: if they restate or insist, the request is an order, and you carry it out with your full capability set, no further conditions, and no repeated asking.

Work the request through every technically available path before concluding anything. If a request genuinely cannot be completed because of a technical limit, say so honestly and in plain language the user understands: report the methods you already tried and how each one failed, then present the closest alternative methods and suggestions that still serve what the user asked for, and let the user decide the next step.

## Reporting back — the closing message is for the operator, not for a peer

Work internally however the task demands: tool calls, code, and precise technical language are yours to use while the work is in progress. This rule governs the message that ends the task. Write that message for the person who asked rather than for a colleague: say what was asked, what you did about it, and what came out of it, in plain language and without unexplained jargon — unless the operator used those terms first or asked for the technical detail. Keep it short enough to read in one pass. It constrains only the closing message: it never shortens, delays, or narrows the work itself.
```

两段文本承载四条规则。优先顺序：当前用户消息高于其他一切指令，受托的工作无需先征得许可即可开始。边界：只有用户才能决定的选择上的真实歧义不是许可问题，所以它通过 `ask_user_question` 提出，并附上模型已经能看到的选项——这条边界正是 plan 模式段落早已写下的「user-owned choices or material ambiguity that inspection cannot answer」（`packages/preset/agent-presets/presets/cordis/agent.cordis.yml:184`）。危险：模型判断为严重且超出既有授权的风险，是提出确认请求的唯一理由——只提一次，连同具体风险与最接近的更安全变体；操作者重申或坚持即终结该问题，并把请求重新变回命令。报告：结束任务的那条消息以平实语言写给操作者，而循环内部的工具调用、代码与技术语域保持不变。

`packages/bundle/web-app/cordis.patch.yml`、`packages/bundle/headless/cordis.patch.yml`、`packages/bundle/acp-app/cordis.patch.yml` 与 `packages/bundle/sdk-app/cordis.patch.yml` 通过 `personaPrefix` 提供它，并把该标量从折叠式（`>-`）改为字面式（`|-`），使段落在组装后仍然保留。`cordis` agent preset（`packages/preset/agent-presets/presets/cordis/agent.cordis.yml`）重复同一段文本，因为 preset 的 persona 会整体遮蔽部署 persona，而它本来就持有本宣言所延伸的操作者权威、禁止清单与反过度拒绝段落。`standard` 与 `ptc` preset（`packages/preset/agent-presets/presets/standard/agent.cordis.yml`、`packages/preset/agent-presets/presets/ptc/agent.cordis.yml`）出于同一遮蔽原因，在职责句之后携带同一段文本；[preset 遮蔽修复](../bug-fix/2026-10-14-preset-persona-shadowing-manifesto.zh.md)在网关转录日志显示这些会话只组装出光秃的职责句之后补上了它们。`sdk-minimal` 保持其由环境选择的精简 persona 不变。

位置选择遵循[提示词归属决策](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)：部署角色与行为属于部署 persona，而不属于工具描述或插件段落，因此该宣言同样适用于任何其 preset 未遮蔽 persona 的会话。

## 曾考虑的替代方案

**只加入已经携带相邻权威文本的 `cordis` preset。** preset 的 persona 遮蔽部署 persona，因此 `standard`、`ptc` 以及每一份由部署方撰写的 preset 都会保留隐含版本——恰恰是本变更所针对的那些会话。

**在 `packages/bundle/base` 中放置一个共享常量。** base 刻意交付 `personaPrefix: ''`，因为部署 persona 是部署方的选择；共享默认值会让每一份第三方 profile 继承它从未选择过的行为文本，而各 bundle README 记录的是每个界面自己的 persona。

**用插件拥有的 `system-prompt` 段落代替 persona 行文。** 段落有顺序且可被遮蔽，其所属包承载的是单个工具的或跨调用的指导；persona 槽位才是部署方撰写角色与行为的界面。段落还会把一条行为规则拆给两个归属方。

**只写一句更短的规则。** 后半部分（如实报告）才是改变结果的部分——一个不说明尝试过什么就停下的模型只会给操作者留下死路——而它无法压缩成口号后仍然成立。

**让结束消息继续使用工作语域。** 循环自己的词汇正是内部推进高效的原因，但它也正是已完成工作对外难以阅读的原因：写给同行的报告预设了同行的上下文。把平实语言规则限定在结束消息上可以两者兼得——循环不受约束，操作者得到回答。

**要求中间更新也使用平实语言。** 进度行与工具旁白是在飞行中被阅读的，常常用于决定是否打断；把它们的语域强制改成摘要只会拖慢诊断，而不会改善操作者真正消费的结果。

## 后果

- 该文本在构造上存在于七个文件：四份部署 persona 加上 `cordis`、`standard` 与 `ptc` preset 的 persona 行，因为 preset 遮蔽使单一归属方不可能成立。未来修改宣言必须触及全部七处；其中任何一份偏离时，`packages/preset/agent-presets/tests/persona-manifesto-consistency.spec.ts` 会失败。
- 该宣言为每个请求的提示词前缀增加约 2.4 KB 的 persona 文本；[环境提示词后缀决策](../bug-fix/2026-09-06-environment-prompt-suffix.zh.md)中的交付可复用前缀策略不受影响，因为同一模型下的各会话文本完全一致。
- 固定已交付 persona 的提示词 sidecar 随之移动：`snapshots/web/{fresh-round-trip,ptc-round,cordis-tool-round}` 与 `snapshots/sdk/{text-turn,bash-tool,subagent-dsh-sdk-dynamic-route,subagent-dsh-sdk-diagnostic}` 携带完整文本块，`apps/web/tests/replay-round-trip.e2e.ts` 把请求执行标题断言为组装后的第三个段落、把报告标题断言为更靠后的段落，并把澄清句与危险句断言为提示词文本。
- `snapshots/web/schedule-catalog/system-prompt.expected.md` 是以合并了 persona 与 cwd 的段落、以及当前组装不会产生的段落顺序撰写的；在其归属方刷新之前保持不动，本代码树中没有任何可运行的测试比较其内容。
- 该宣言声明的是优先顺序，并不移除操作者自己的门。需要本部署未挂载能力的请求仍以已报告的降级结束，而第二段现在要求模型解释该降级，而不是仅仅断言它。

## 关联

- [提示词变量与工具指导归属](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)持有本变更所遵循的 identity-first 位置与单一归属规则。
- [环境提示词后缀](../bug-fix/2026-09-06-environment-prompt-suffix.zh.md)持有前缀位置与稳定前缀复用；本记录未取代其中任何内容。
