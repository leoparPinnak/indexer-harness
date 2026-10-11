/**
 * Translate OpenAI-compatible chat-completions SSE payloads into the harness
 * `StreamChunk` protocol, with one stateful harness block per content,
 * reasoning, or tool-call index. An empty initial reasoning delta does not
 * open a block. Finish reason and the latest usage are deferred until
 * `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while guaranteeing no chunk follows `finish`.
 *
 * @module dsh-llm-openai-compatible/translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only, absent until a delta carries a non-empty value. */
  callId?: string | undefined
  name?: string | undefined
}

/**
 * Map the wire `finish_reason` vocabulary to the harness `FinishReason`.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (`content_filter`, …) become
 *   `{kind:'error'}` carrying the uppercased wire value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields into the harness's DISJOINT token convention. OpenAI-compatible
 * endpoints report `prompt_tokens_details.cached_tokens` (cache reads) inside
 * `prompt_tokens`; some carry cache hits as a top-level `prompt_cache_hit_tokens`
 * instead — both are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; an exact total only when the aggregate
 *   prompt/completion counters are valid and agree with any wire total.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const combined = usage.prompt_tokens + usage.completion_tokens
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens)
    && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.completion_tokens)
    && usage.completion_tokens >= 0
    && Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Accept one streamed identity field for a tool call. `id` and `name` are
 * identity, not accumulation: the wire sends each once, on the call's first
 * delta. A continuation delta that re-sends the field empty — or `null`, which
 * some OpenAI-compatible gateways fill in — means "no update", never "clear".
 * @param current - the identity established by an earlier delta of this call.
 * @param incoming - the field as parsed from this delta.
 * @returns the identity in force after this delta.
 */
function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: brandString<ToolCallId>(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield `StreamChunk`s.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all
 *   deferred to the `[DONE]` sentinel. A `stop` (or absent) finish with no
 *   opened blocks is a degenerate completion and maps to an `EMPTY_RESPONSE`
 *   error finish instead of a successful empty message.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new Error('MALFORMED_RESPONSE')
    }
    const choice = chunk.choices?.[0]
    if (choice?.delta?.reasoning_content) {
      const text = choice.delta.reasoning_content
      if (reasoningBlock === undefined && text.length === 0) continue
      reasoningBlock ??= open('reasoning')
      if (reasoningBlock !== textBlock) textBlock ??= undefined
      reasoningBlock.text += text
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text }
      continue
    }
    if (choice?.delta?.content) {
      textBlock ??= open('text')
      textBlock.text += choice.delta.content
      yield { type: 'text-delta', index: textBlock.index, text: choice.delta.content }
      continue
    }
    const deltaCall = choice?.delta?.tool_calls?.[0]
    if (deltaCall) {
      const slot = deltaCall.index ?? 0
      let block = toolBlocks.get(slot)
      if (block === undefined) {
        block = open('tool-call')
        toolBlocks.set(slot, block)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      block.callId = acceptIdentity(block.callId, deltaCall.id)
      block.name = acceptIdentity(block.name, deltaCall.function?.name)
      const args = deltaCall.function?.arguments
      if (typeof args === 'string' && args.length > 0) {
        block.text += args
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: brandString<ToolCallId>(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: args,
        }
      }
      continue
    }
    if (choice?.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason)
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
}
