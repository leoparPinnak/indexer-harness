# Agent Note: 压缩以 provider 锚定的压力值为门

Status: implemented

[English](2026-10-15-provider-anchored-compaction-gating.md) | 中文

## 问题

provider 以 `input token count exceeds the maximum number of tokens allowed 1048576` 拒绝请求，而应用内每个数字都远低于该上限：上下文计量环显示约 600K token，压缩记录的 `giren 63803` 对着同一路由的 1M 上限。两个测量事实制造了这个缺口。

固定的每 token 4 字符启发式规则系统性地低报 JSON 工具 schema、代码与非拉丁文本——token-meter 自己的投影注释把这一点记为刻意的、仅供显示的取舍（"面向用户的参考值，不是计费或门槛输入"）。而且每个会话只保留一个 provider 锚点：请求 envelope 一变——比如模型切换，这类会话频繁发生——锚点就被丢弃，整个测量回退到启发式，provider 的真实计数被悄悄丢掉。随后压缩拿这个测量值去和真实单位的阈值比较（已路由模型声明容量乘 `thresholdRatio`），摘要器又用同一套启发式为回放窗口定尺寸，于是触发点和摘要请求都可能冲过 provider 的硬上限。没有声明容量的摘要器路由更糟：窗口预算变成无限，一次调用携带全部内容。

## 决策

- token meter 每个请求 envelope 保留一个 provider 锚点（至多四个，最旧优先淘汰）。切换模型不再丢失锚点：每条路由自己上报的计数一直保留到该路由自己的下一次调用替换它；没有已捕获锚点的 envelope 照旧走启发式。
- `compaction-basic` 通过新的策略字段 `estimateSafetyFactor`（默认 `1.5`，校验 `>= 1`）把门。处于 provider 用量基线上的测量（`baseline.kind === 'usage'`）就是 provider 的计数，按原样参与判断；启发式测量在碰到真实单位阈值之前先乘以该系数。
- 摘要器在从 `contextWindow − maxTokens` 中扣除工具 schema、系统头、指令与打包消息之前，都按同一系数计价；未声明上下文容量的摘要器路由以 `TargetPressureConfigError`（指名该路由）拒绝压缩，而不是发送一个无限窗口。

## 曾考虑的替代方案

**把显示数字也一起修正（改估计器的密度）。** 投影把启发式记录为仅供显示的参考值；只给门槛路径计价可以让显示及其已录制快照侧车保持稳定，而门槛保持保守。密度感知的估计器是更深层的修正，需要一次录制会话的补录。

**用固定余量而不是系数。** 固定余量无法知道启发式离这个 tokenizer 的真实计数有多远；系数随实际被计价的内容缩放。

**每次请求前用 provider 数 token。** 适配器没有计数端点，预检往返会让请求延迟翻倍；上一次调用 provider 自己上报的用量就是已经拿得到的精确数字。

## 后果

- 启发式测量上的自动压缩更早触发（当 `估计 × 系数` 越过阈值），这正是想要的方向：会越过真实上限的那次请求发生在压缩之后而不是之前。provider 锚定的测量判断方式不变。
- 按路由的锚点让每个会话多一张有界映射，fold 仍保持 O(表面)。
- `SummaryConfig` 携带该系数，使 fallback 摘要器路由与主路由计价一致。
- 厧缩行的 `giren`/`çıkan` 数字保持录制值不变——它们随会话事件存储，不参与重新计算——因此不需要移动任何已录制会话侧车。

## 相关

- [token-meter README](../../../../packages/llm/token-meter/README.zh.md) 拥有锚点语义；[compaction-basic README](../../../../packages/compaction/compaction-basic/README.zh.md) 拥有策略字段与容量缺失时的失败规则。