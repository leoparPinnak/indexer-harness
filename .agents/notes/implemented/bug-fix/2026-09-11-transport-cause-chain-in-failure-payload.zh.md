# Agent Note: Render transport cause chains in the durable LLM failure payload

Status: implemented

[English](2026-09-11-transport-cause-chain-in-failure-payload.md) | 中文

## Problem

一次被重试的模型请求只告诉读者 `DeepSeek API request to https://api.deepseek.com failed: fetch failed`。`fetch failed` 是 undici 对每一次传输层拒绝——连接被拒、连接重置、TLS 失败、超时——都固定使用的包装文本，因此其背后的原因恰在读者最需要它的时刻被隐去。

这种遮蔽是持久的。`normalizeLlmFailure` 会把抛出的值转成 `LlmFailure`，而该载荷会进入 `llm/retry` 会话事件与主界面；于是包装文本就是这条轮内失败记录此后向每一位读者呈现的内容。

已归档的[因果链诊断笔记](../../archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md)决定：每个诊断边界都渲染 `errorChain` 而不是 `error.message`。本载荷落在了该决定之外：它不是渲染抛出值的边界，而是一条结构化、可序列化的记录；其适配器路径会直接短路到适配器自身错误已经携带的 `failure` 快照。

## Decision

`normalizeLlmFailure` 在两个条件同时成立时才通过 `errorChain` 渲染消息，且仅在这时成立：

- 抛出的值携带一个 `Error` 型 `cause`，即确实存在可遍历的链条；并且
- 校验后的载荷不携带提供方 `status`，即没有任何提供方响应被概括进该消息。

响应前的传输失败同时满足两者：它的包装只点出端点，其 cause 是 undici 的 `TypeError`，因此渲染出的消息为 `DeepSeek API request to <baseURL> failed: fetch failed: <reason>`。

DeepSeek 适配器响应前的包装只点出配置的端点，并把拒绝留在 `cause` 上；它原先携带的 `: ${error.message}` 后缀被移除，因为该边界现在会遍历链条，而消息中重复的 cause 会被渲染两次。

已作答的提供方不满足第二个条件：`LlmError` 已经持有该响应自己的消息，其 status 也在载荷上，因此响应体仍留在 `cause` 供渲染抛出值的边界使用，而不进入持久消息。

## Alternatives considered

**在适配器处把链条写进包装自身的消息。** 被[因果链诊断笔记](../../archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md)否决，该笔记实测了后果：每个同样遍历 `cause` 的消费者都会把链条渲染两次（`… fetch failed: bad port: fetch failed: bad port`）。

**对每一个 `Error` 型 cause 都遍历链条。** 经实测后否决：DeepSeek 的 HTTP 路径把原始响应体包进 `cause` 上的一个 `Error`，因此遍历每个 cause 会把完整的提供方响应体复制进面向用户的消息。

**在错误自身上标记某个 cause 是诊断还是载荷，而不是读取 `status`。** 作为为同一结果而引入的更宽契约变更被否决：提供方 status 本身已经意味着其响应被概括进了消息，而新的标记还必须与之保持同步。

## Consequences

- 传输失败在重试提示、持久 `llm/retry` 事件与界面中读作 `DeepSeek API request to <baseURL> failed: fetch failed: connect ECONNRESET …`。诊断字符串会因链条长度而变长。
- 已作答的提供方不受影响：读者仍看到该提供方发出的消息。
- 对每一种抛出值，载荷都保持非空消息，包括恶意的 message 访问器与渲染为空的取值。
- 没有 cause 的错误与以往渲染完全一致，因此其脚本错误不携带 cause 的录制会话重放结果不变。

## Testing

`packages/llm/llm/tests/adapter-failure.spec.ts` 固定了传输失败的链条、已作答提供方消息保持不变、随链条消息一同存活的携带事实，以及非空回退。`packages/llm/llm-deepseek/tests/adapter.spec.ts` 通过真实适配器端到端固定了端点不可达与流被突然关闭两种情况下的渲染消息。
