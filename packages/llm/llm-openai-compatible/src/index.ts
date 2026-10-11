/**
 * Register one {@link OpenAiCompatibleAdapter} per configured route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-openai-compatible` user-settings section (`ctx.settings`) and resolves
 * each route's API key through the optional credential seam (`ctx.credentials`),
 * so a changed base URL, catalog, or key reaches the very next request without
 * restarting anything, while an in-flight stream keeps the facts it started
 * with. The one registration-captured fact — the retry policy — re-registers
 * the route in place when it changes.
 * @module @deepseek-ai/dsh-llm-openai-compatible
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { OpenAiCompatibleAdapter } from './adapter.ts'
import type {
  OpenAiCompatibleCatalogModel,
  OpenAiCompatibleConnectionOptions,
} from './adapter.ts'
import type { RequestDefaults } from './serialize.ts'

export { OpenAiCompatibleAdapter } from './adapter.ts'
export type {
  OpenAiCompatibleAdapterOptions,
  OpenAiCompatibleCatalogModel,
  OpenAiCompatibleConnectionOptions,
} from './adapter.ts'
export { serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'
export { DONE, parseSse } from './sse.ts'
export { mapFinishReason, mapUsage, translate } from './translate.ts'
export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'llm-openai-compatible'
/** Services required to register routes and resolve credentials. */
export const inject = ['llm']

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_TOKENS = 32_000
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Defaults applied to every call of one route (from plugin config). */
interface RouteDefaultsConfig {
  temperature?: number
  topP?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/** One OpenAI-compatible endpoint binding: exactly what "adding a model" is. */
export interface RouteConfig {
  /** Provider route id registered on `ctx.llm` (prefix `openai:` by convention). */
  provider: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Credential reference (environment-variable name) resolved per request. */
  apiKeyEnv?: string
  /** Request defaults applied to every call of this route. */
  defaults?: RouteDefaultsConfig
  /** Default per-request output cap; a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; requests remain unrestricted. */
  models?: OpenAiCompatibleCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses the normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Set `false` to register no route. Defaults to `true`. */
  enabled?: boolean
  /** Endpoint bindings; each becomes its own provider route. */
  routes?: RouteConfig[]
}

const catalogModel: z<OpenAiCompatibleCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  systemPromptUpdate: z.const('in-history'),
})

const routeConfig: z<RouteConfig> = z.object({
  provider: z.string().required(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref'),
  defaults: z.object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    reasoningEffort: z.union(['low', 'medium', 'high']),
  }),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  defaultContextWindow: z.number().step(1).min(1),
  models: z.array(catalogModel),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  retryPolicy: RetryPolicySchema,
})

/** Validated plugin-entry configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  routes: z.array(routeConfig).default([]),
})

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — fail loud at load and at each
 * settings snapshot's first use.
 * @param route - raw route config or a resolved settings entry.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveRouteOptions(route: RouteConfig): OpenAiCompatibleConnectionOptions & { provider: string } {
  if (route.provider.length === 0) throw new Error('llm-openai-compatible: route provider must be non-empty')
  if (route.baseURL.length === 0) {
    throw new Error(`llm-openai-compatible: route "${route.provider}" needs a non-empty baseURL`)
  }
  const streamIdleTimeoutMs = route.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-openai-compatible: route "${route.provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxTokens = route.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`llm-openai-compatible: route "${route.provider}" maxTokens must be a positive safe integer`)
  }
  const defaultContextWindow = route.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(
      `llm-openai-compatible: route "${route.provider}" defaultContextWindow must be a positive integer`,
    )
  }
  const defaults: RequestDefaults = {
    maxTokens,
    ...route.defaults?.temperature !== undefined ? { temperature: route.defaults.temperature } : {},
    ...route.defaults?.topP !== undefined ? { topP: route.defaults.topP } : {},
    ...route.defaults?.reasoningEffort !== undefined
      ? { reasoningEffort: route.defaults.reasoningEffort }
      : {},
  }
  return {
    provider: route.provider,
    apiKeyEnv: credentialRef(route.apiKeyEnv ?? 'OPENAI_API_KEY'),
    baseURL: route.baseURL,
    defaults,
    models: resolveModels(route.provider, route.models),
    streamIdleTimeoutMs,
  }
}

/** Resolve, validate, and detach one route's advisory model catalog. */
function resolveModels(
  provider: string,
  models: readonly OpenAiCompatibleCatalogModel[] | undefined,
): OpenAiCompatibleCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) {
      throw new Error(`llm-openai-compatible: route "${provider}" catalog model ids must be non-empty`)
    }
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-openai-compatible: route "${provider}" catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-openai-compatible: route "${provider}" catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-openai-compatible: route "${provider}" catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    // Widened: a dynamic config update can reach this check without schema validation.
    const systemPromptUpdate: string | undefined = model.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new Error(
        `llm-openai-compatible: route "${provider}" catalog model "${model.id}" systemPromptUpdate must be "in-history" when present`,
      )
    }
    if (seen.has(model.id)) {
      throw new Error(`llm-openai-compatible: route "${provider}" duplicate catalog model "${model.id}"`)
    }
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: model.systemPromptUpdate },
    }
  })
}

/** Register every configured route; returns the disposer releasing them all. */
export function apply(ctx: Context, config: Config): () => void {
  const disposers: Array<() => void> = []
  if (config.enabled !== false) {
    const llm = ctx.llm
    for (const route of config.routes ?? []) {
      const resolved = resolveRouteOptions(route)
      const retryPolicy = resolveRetryPolicy(route.retryPolicy, `llm-openai-compatible: route "${route.provider}" retryPolicy`)
      const adapter = new OpenAiCompatibleAdapter({
        provider: resolved.provider,
        resolveAdapterOptions: () => resolveRouteOptions(route),
        resolveApiKey: async (ref) => {
          const credentials = ctx.credentials
          if (credentials === undefined) {
            throw new LlmError('the credential seam is unavailable', 'MISSING_CREDENTIAL')
          }
          const resolved = await credentials.resolve(ref)
          if (resolved === undefined) {
            throw new LlmError('no secret is configured for this route key', 'MISSING_CREDENTIAL')
          }
          return resolved.value
        },
        retryPolicy,
      })
      const handle = llm.registerAdapter([resolved.provider], adapter)
      disposers.push(() => handle())
    }
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

export default apply
