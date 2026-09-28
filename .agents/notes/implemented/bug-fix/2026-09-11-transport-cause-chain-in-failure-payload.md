# Agent Note: Render transport cause chains in the durable LLM failure payload

Status: implemented

English | [中文](2026-09-11-transport-cause-chain-in-failure-payload.zh.md)

## Problem

A retried model request told the reader only `DeepSeek API request to https://api.deepseek.com failed: fetch failed`. `fetch failed` is undici's fixed wrapper text for every transport rejection — refused connection, reset, TLS, timeout — so the reason behind it stayed invisible at the moment the reader needed it.

The masking is durable. `normalizeLlmFailure` turns the thrown value into the `LlmFailure` that reaches the `llm/retry` session event and the primary UI, so the wrapper's text is what the one in-turn failure record carries to every later reader.

The archived [cause-chain diagnostics note](../../archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md) decided that every diagnostic boundary renders `errorChain` instead of `error.message`. This payload sat outside that decision: it is not a boundary that renders a thrown value, it is a structured serializable record, and its adapter path short-circuits to the `failure` snapshot the adapter's own error already carries.

## Decision

`normalizeLlmFailure` renders its message through `errorChain` when both conditions hold, and only then:

- the thrown value carries an `Error` cause, so there is a chain to walk; and
- the validated payload carries no provider `status`, so no provider response was summarized into that message.

A pre-response transport failure satisfies both. Its wrapper names the endpoint and nothing else, and its cause is undici's `TypeError`, so the rendered message reads `DeepSeek API request to <baseURL> failed: fetch failed: <reason>`.

The DeepSeek adapter's pre-response wrapper names only the configured endpoint and leaves the rejection on `cause`; the `: ${error.message}` suffix it carried is removed, because the boundary now walks the chain and a cause repeated in the message would render twice.

An answered provider fails the second condition. `LlmError` already holds that response's own message, and its status is on the payload, so its response body stays on `cause` for the boundaries that render thrown values and does not enter the durable message.

## Alternatives considered

**Bake the chain into the wrapper's own message at the adapter.** Rejected by the [cause-chain diagnostics note](../../archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md), which measured the outcome: every consumer that also walks `cause` renders the chain twice (`… fetch failed: bad port: fetch failed: bad port`).

**Walk the chain for every `Error` cause.** Rejected after measurement: the DeepSeek HTTP path wraps the raw response body in an `Error` on `cause`, so chaining every cause copied the complete provider body into the user-visible message.

**Mark whether a cause is a diagnosis or a payload on the error itself, rather than reading `status`.** Rejected as a wider contract change for the same outcome: a provider status already implies its response was summarized into the message, and a new marker would have to be kept in step with it.

## Consequences

- A transport failure reads `DeepSeek API request to <baseURL> failed: fetch failed: connect ECONNRESET …` in the retry notice, the durable `llm/retry` event, and the UI. Diagnostic strings grow by the length of the chain.
- A provider that answered is unaffected: the reader still sees the message that provider sent.
- The payload keeps a non-empty message for every thrown value, including a hostile message accessor and a value that renders to nothing.
- An error with no cause renders exactly as before, so recorded sessions whose scripted errors carry none replay unchanged.

## Testing

`packages/llm/llm/tests/adapter-failure.spec.ts` pins the chain for a transport failure, the untouched message for an answered provider, carried provider facts surviving beside the chained message, and the non-empty fallback. `packages/llm/llm-deepseek/tests/adapter.spec.ts` pins the rendered message end to end through the real adapter for an unreachable endpoint and for an abruptly closed stream.
