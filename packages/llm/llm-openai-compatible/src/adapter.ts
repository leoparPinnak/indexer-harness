/**
 * `OpenAiCompatibleAdapter`: fetch + SSE against any OpenAI-compatible
 * chat-completions endpoint, emitting harness `StreamChunks`. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * `prepareCall` generation and the bearer token through a per-request
 * resolver, so the registering plugin owns validation, layering, and
 * credential policy. One adapter call is exactly one provider attempt.
 *
 * @module dsh-llm-openai-compatible/adapter
 */

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
  SystemPromptUpdate,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { IdleWatchdog } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** Capability-owned code stamped onto the idle watchdog's timeout reason. */
const IDLE_TIMEOUT_CODE = 'TIMEOUT'

/** One optional model entry advertised by the binder. */
export interface OpenAiCompatibleCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the route's maxTokens. */
  maxTokens?: number
  /**
   * `'in-history'` declares that the endpoint reads the latest `system`
   * message at any position as the complete effective system prompt.
   */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * Validated connection facts for one route and operation. The plugin's
 * resolve step is the one explicit step producing this shape; the adapter
 * trusts it and reads it per operation, which is what makes a configuration
 * change reach the next request without re-registration.
 */
export interface OpenAiCompatibleConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call. */
  defaults: RequestDefaults
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly OpenAiCompatibleCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
}

/** Everything one `prepareCall` generation pins down before dispatch. */
export interface OpenAiCompatibleAdapterOptions {
  /** Provider route id owned by this instance. */
  provider: string
  /** Resolve the current connection facts; called once per operation. */
  resolveAdapterOptions: () => OpenAiCompatibleConnectionOptions | Promise<OpenAiCompatibleConnectionOptions>
  /** Resolve the current bearer secret; called once per request. */
  resolveApiKey: (ref: CredentialRef) => Promise<string>
  /** Retry policy captured at route registration. */
  retryPolicy?: ResolvedRetryPolicy
}

/** Map a failed provider response body to the provider-neutral failure shape. */
function failureFromBody(body: WireError | undefined, status: number): { message: string; code: string; status: number } {
  const message = body?.error?.message ?? `provider returned HTTP ${status}`
  return { message, code: `HTTP_${status}`, status }
}

/**
 * Drive one async iterator through the idle watchdog: every demand is armed,
 * transport activity that yields no value rearms via `pulse()`.
 */
async function* guardedPayloads(source: AsyncIterator<string>, watch: IdleWatchdog): AsyncGenerator<string> {
  for (let entry = await watch.next(source); !entry.done; entry = await watch.next(source)) {
    yield entry.value
  }
}

/** Translate the idle-guarded payload stream, normalizing parse failures. */
async function* guardedTranslate(
  payloads: AsyncGenerator<string>,
  watch: IdleWatchdog,
): AsyncGenerator<StreamChunk> {
  try {
    yield* translate(guardedPayloads(payloads[Symbol.asyncIterator](), watch))
  } catch (error) {
    if (error instanceof LlmError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'MALFORMED_RESPONSE') throw new LlmError(message, 'MALFORMED_RESPONSE')
    if (timeoutOf(watch.signal, IDLE_TIMEOUT_CODE)) {
      throw new LlmError('provider stream went idle', IDLE_TIMEOUT_CODE)
    }
    throw error
  }
}

/** The one shared wire call: POST `{baseURL}/chat/completions`, SSE back. */
async function streamOnce(
  facts: OpenAiCompatibleConnectionOptions,
  apiKey: string,
  options: GenerateOptions,
  model: string,
): Promise<AsyncGenerator<StreamChunk>> {
  const body = serializeRequest(options, model, facts.defaults)
  let response: Response
  try {
    response = await fetch(`${facts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (timeoutOf(options.signal ?? {}, IDLE_TIMEOUT_CODE)) throw new LlmError('provider stream went idle', IDLE_TIMEOUT_CODE)
    throw error
  }
  if (response.body === null) throw new LlmError('provider returned an empty body', 'STREAM_CLOSED')
  if (!response.ok) {
    let wire: WireError | undefined
    try {
      wire = JSON.parse(await response.text()) as WireError
    } catch {
      wire = undefined
    }
    const failure = failureFromBody(wire, response.status)
    if (isContextWindowExceededError(failure.message)) {
      throw new LlmError(failure.message, CONTEXT_WINDOW_EXCEEDED_CODE, { status: failure.status })
    }
    if (isQuotaExceededError(failure.message)) {
      throw new LlmError(failure.message, QUOTA_EXCEEDED_CODE, { status: failure.status })
    }
    throw new LlmError(failure.message, failure.code, { status: failure.status })
  }

  const watch = idleWatchdog(options.signal, facts.streamIdleTimeoutMs, IDLE_TIMEOUT_CODE)
  const payloads = parseSse(response.body, () => watch.pulse())
  return guardedTranslate(payloads, watch)
}

/**
 * Adapter for one or more OpenAI-compatible provider routes. Implements only
 * `stream()` plus the dynamic-generation override (`prepareCall`) so a
 * settings change cannot mix one generation's endpoint with another's
 * capabilities.
 */
export class OpenAiCompatibleAdapter extends LlmAdapter {
  constructor(private readonly spec: OpenAiCompatibleAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.spec.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.resolveCatalog().then(models => models.map(entry => toModelInfo(provider, entry)))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = (await this.resolveCatalog()).find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {},
      ...entry?.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {},
    }
  }

  /** Pin one connection generation and bind its dispatch to exactly one model. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const facts = await this.spec.resolveAdapterOptions()
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: options => this.dispatch(facts, options, model),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return {
      [Symbol.asyncIterator]: async function* (this: OpenAiCompatibleAdapter) {
        const facts = await this.spec.resolveAdapterOptions()
        yield* this.dispatch(facts, options, options.model)
      }.bind(this),
    }
  }

  private async *dispatch(
    facts: OpenAiCompatibleConnectionOptions,
    options: GenerateOptions,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = await this.spec.resolveApiKey(facts.apiKeyEnv)
    yield* await streamOnce(facts, apiKey, options, model)
  }

  private async resolveCatalog(): Promise<readonly OpenAiCompatibleCatalogModel[]> {
    return (await this.spec.resolveAdapterOptions()).models
  }
}

/** Map a catalog entry to detached discovery metadata. */
function toModelInfo(provider: string, entry: OpenAiCompatibleCatalogModel): LlmModelInfo {
  return {
    provider,
    id: entry.id,
    name: entry.name ?? entry.id,
    ...entry.description !== undefined ? { description: entry.description } : {},
    ...entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {},
    ...entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {},
  }
}
