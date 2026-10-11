/**
 * Serialize harness messages into OpenAI-compatible chat-completions requests.
 *
 * Harness `Message` rolleri yalnızca system|user|assistant'tır: araç SONUÇLARI
 * `user` mesajındaki `tool-result` blokları olarak yaşar ve tekelleşmiş
 * `role:'tool'` mesajlarına açılır (blok sırası korunur). Araç argümanları ham
 * JSON string olarak geçer. Girdi yalnızca metindir; `image`/`file` blokları
 * bu bağlayıcıda desteklenmez (`UNSUPPORTED_CONTENT`, gaps raporlanır).
 *
 * @module dsh-llm-openai-compatible/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type {
  WireAssistantMessage,
  WireMessage,
  WireRequest,
  WireTool,
  WireToolCall,
  WireToolMessage,
} from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  /** Fallback per-request output cap when the request carries none. */
  maxTokens?: number | undefined
  temperature?: number | undefined
  topP?: number | undefined
  /** Sent as `reasoning_effort` for endpoints that accept it; omitted otherwise. */
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined
}

/** Join the text blocks of a block list. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Collect the tool calls of one assistant message as raw-JSON wire calls. */
function assistantToolCalls(blocks: readonly ContentBlock[]): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    calls.push({
      id: block.id as string,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    })
  }
  return calls
}

/** Flatten one user message: tool-result blocks become tool messages, text collects. */
function splitUserMessage(message: Message): WireMessage[] {
  const out: WireMessage[] = []
  const texts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        texts.push(block.text)
        continue
      case 'tool-result': {
        const body = flattenText(block.content)
        const wire: WireToolMessage = {
          role: 'tool',
          tool_call_id: block.toolCallId as string,
          content: block.isError === true ? `${body}\n(hata ile sonuçlandı)` : body,
        }
        out.push(wire)
        continue
      }
      case 'reasoning':
        // Kullanıcı mesajı reasoning taşımaz; tarihsel reasoning yeniden oynatma
        // adapter-private replayState üzerinden yürür (adaptor sözleşmesi).
        continue
      default:
        throw new LlmError(
          'the generic binder supports text and tool-result blocks only (image/file unsupported)',
          'UNSUPPORTED_CONTENT',
        )
    }
  }
  const joined = texts.join('')
  if (joined.length > 0) out.push({ role: 'user', content: joined })
  return out
}

/** Map one harness tool definition to the wire function schema. */
function wireTool(tool: NonNullable<GenerateOptions['tools']>[number]): WireTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters as WireTool['function']['parameters'],
    },
  }
}

/**
 * Serialize one model request.
 * @param options - the harness generation request.
 * @param model - wire model id of the selected catalog entry or free-form id.
 * @param defaults - adapter-level request defaults layered under explicit options.
 * @returns the request body sent to `{baseURL}/chat/completions`.
 */
export function serializeRequest(
  options: GenerateOptions,
  model: string,
  defaults: RequestDefaults,
): WireRequest {
  const messages: WireMessage[] = []
  for (const message of options.messages) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: flattenText(message.content) })
        continue
      case 'user':
        messages.push(...splitUserMessage(message))
        continue
      case 'assistant': {
        for (const block of message.content) {
          if (block.type === 'image' || block.type === 'file') {
            throw new LlmError('image/file history is unsupported by the generic binder', 'UNSUPPORTED_CONTENT')
          }
        }
        const toolCalls = assistantToolCalls(message.content)
        const text = flattenText(message.content)
        const wire: WireAssistantMessage = {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
        }
        messages.push(wire)
        continue
      }
    }
  }

  const maxTokens = options.maxTokens ?? defaults.maxTokens
  return {
    model,
    messages,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: options.tools.map(wireTool) }
      : {},
    ...maxTokens !== undefined ? { max_tokens: maxTokens } : {},
    ...defaults.temperature !== undefined ? { temperature: defaults.temperature } : {},
    ...defaults.topP !== undefined ? { top_p: defaults.topP } : {},
    ...defaults.reasoningEffort !== undefined ? { reasoning_effort: defaults.reasoningEffort } : {},
    stream: true,
    stream_options: { include_usage: true },
  }
}
