/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionPolicyState, CompactionResult, CompactionStreamFrame, CompactionTrigger,
} from '@deepseek-ai/dsh-compaction'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
// Type-only: the optional settings service face used for the live section.
import type {} from '@deepseek-ai/dsh-settings'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { compactionPolicyProjection } from './policy-projection.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummarizerLiveSink, SummaryConfig, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
  onWindows?: (windows: number) => void,
  live?: SummarizerLiveSink,
) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Report a still-open compaction bracket as busy, before any range decision.
 * A prior attempt that appended `compaction/start` without reaching its
 * `compaction/end` owns the session until a seed boundary makes it stale.
 * @param session - session whose durable log holds the open bracket, if any.
 * @throws ManualCompactionError with code `busy` while one is open.
 */
function assertNoOpenManualCompaction(session: Session): void {
  // Existing Session history read; migration deferred — this reads the durable
  // bracket state, which no projection currently folds.
  // oxlint-disable-next-line typescript/no-deprecated
  const events = session.snapshotEvents()
  let open = false
  for (const event of events) {
    if (event.type === 'compaction/start') open = true
    else if (event.type === 'compaction/end' || event.type === 'session/end-seed') open = false
  }
  if (open) {
    throw new ManualCompactionError('busy', 'manual compaction: compaction lock is already active')
  }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/**
 * Classify a summarizer failure as eligible for the fallback target chain:
 * quota/payment exhaustion, context overflow, degenerate empty responses,
 * and provider streams that closed before completion.
 * @param error - the thrown summarizer failure.
 * @returns true only for failures another provider/model route could plausibly survive.
 */
function isFallbackSummaryFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const pattern = new RegExp(
    '429|402|quota|RESOURCE_EXHAUSTED|rate.?limit|CONTEXT_WINDOW_EXCEEDED|EMPTY_RESPONSE|stream closed|stream disconnected|payment',
    'i',
  )
  return pattern.test(message)
}

/** Settings namespace for the deployment compaction defaults (General settings). */
const COMPACTION_SETTINGS_NAMESPACE = 'compaction-basic'

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const estimateSafetyFactorSchema = z.number().min(1)
const fallbackTarget: z<{ provider: string; model: string }> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})
const fallbackTargetsSchema = z.array(fallbackTarget)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  estimateSafetyFactor: estimateSafetyFactorSchema,
  fallbackTargets: fallbackTargetsSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    estimateSafetyFactor: estimateSafetyFactorSchema,
    fallbackTargets: fallbackTargetsSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /**
   * Effective configuration for policy resolution and display: the durable
   * settings section layered over the composition entry, re-resolved when the
   * section commits so a settings write reaches the next policy read without
   * a restart. Defaults to the composition entry until `settings` is composed.
   */
  get config(): ResolvedConfig {
    const raw = this.settingsSource()
    if (raw !== this.settingsResolvedRaw || this.settingsResolved === undefined) {
      this.settingsResolvedRaw = raw
      this.settingsResolved = resolveConfig(raw)
    }
    return this.settingsResolved
  }

  /** Reads the durable settings section once its plugin is composed. */
  private settingsSource: () => BasicCompactionConfig
  /** Last raw config the getter saw, with its resolved cache. */
  private settingsResolvedRaw: BasicCompactionConfig | undefined
  private settingsResolved: ResolvedConfig | undefined

  private readonly warnedPressureConfigTargets = new Set<string>()
  /** Live compaction transactions by identity, for operator cancellation. */
  private readonly activeCompactions = new Map<CompactionId, AbortController>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    // Composition validation stays first so a bad cordis.yml fails at load
    // before any registration runs.
    const composition = resolveConfig(config)
    this.settingsResolved = composition
    this.settingsResolvedRaw = config
    this.settingsSource = () => config
    ctx.effect(
      () => ctx.sessionProjections.register(compactionPolicyProjection(() => this.config)),
      'compaction-basic: compactionPolicy projection',
    )
    // The General-page "Sıkıştırma tavanı" row writes this namespace; the
    // section is the live source behind the config getter above.
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, COMPACTION_SETTINGS_NAMESPACE, BasicCompactionEngine.Config, config, {
        validate: (value) => {
          const resolved = resolveConfig(value)
          if (resolved.auto !== composition.auto) {
            throw new Error('BasicCompactionConfig: auto applies at plugin load; restart the host to change it')
          }
        },
        setSource: (source) => {
          this.settingsSource = source
        },
        // Every consumer reads through the config getter; no derived state.
        onChange: () => {},
      })
    })
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          // Operator stop of an automatic run is neutral: no warning, no retry.
          if (error instanceof ManualCompactionError && error.code === 'cancelled') return next()
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through `ctx.llm.stream()`
   * calls whose prefix reuses the conversation's own system prompt, tools,
   * and messages so the provider's KV cache is not invalidated. A span larger
   * than the summarizer's window runs as windowed map-reduce. Override this
   * sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system head, tools, and region messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param onWindows - optional map-phase notice forwarded to the summarizer.
   * @param live - optional per-call live-update sink forwarded to the summarizer.
   * @returns safe text summary blocks, the exact final call envelope and
   *   output, and intermediate calls when the windowed pipeline ran.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
    onWindows?: (windows: number) => void,
    live?: SummarizerLiveSink,
  ): Promise<SummaryResult> {
    const chain = [this.summarizerConfig(agent), ...this.fallbackSummaryConfigs(agent)]
    let lastError: unknown
    for (const [index, config] of chain.entries()) {
      try {
        return await summarizeWithLlm(this.ctx, config, input, agent, signal, onWindows, live)
      } catch (error) {
        lastError = error
        const finalAttempt = index === chain.length - 1
        // İptal zincir dışında kalır; zincirle ilgili olmayan arızalar da aynen
        // yükselir. Yalnız kota/taşma/boş yanıt/kırpılmış akış sınıfı bir sonraki
        // hedefi hak eder.
        if (finalAttempt || (signal?.aborted ?? false) || !isFallbackSummaryFailure(error)) {
          throw error
        }
      }
    }
    throw lastError
  }

  /**
   * Build one `SummaryConfig` per configured fallback route, inheriting the
   * merged policy's generation cap so fallbacks price identically.
   * @param agent - agent whose merged policy carries the fallback chain.
   * @returns detached configs, primary excluded.
   */
  private fallbackSummaryConfigs(agent: Agent): SummaryConfig[] {
    const target = conversationTarget(agent)
    const policy = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return policy.fallbackTargets.map(fallback => ({
      summarizationProvider: fallback.provider,
      summarizationModel: fallback.model,
      maxTokens: policy.maxTokens,
      estimateSafetyFactor: policy.estimateSafetyFactor,
    }))
  }

  /**
   * Resolve the effective summarizer policy for this agent. The same object
   * feeds the real summarize call and the route announced on `compaction/start`,
   * so a live row can never name a model different from the one that answers.
   * @param agent - agent whose routed target and stored mode select the policy.
   * @returns the effective summarization config.
   */
  private summarizerConfig(agent: Agent): SummaryConfig {
    const target = conversationTarget(agent)
    const policy = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    const mode = this.policyState(agent.session).mode
    return {
      ...policy,
      ...mode !== null && mode.summarizer === 'dedicated'
        ? { summarizationProvider: mode.provider, summarizationModel: mode.model }
        : {},
      ...mode?.maxTokens === undefined ? {} : { maxTokens: mode.maxTokens },
    }
  }

  /**
   * Name the route a live `compaction/start` row shows while the summarizer
   * runs. A dedicated mode names its own model; otherwise the route is resolved
   * exactly as `summarizeWithLlm` resolves an inherited conversation target.
   * @param agent - agent whose mode and routed target choose the summarizer.
   * @returns the announced provider/model pair, or an empty object when no
   *   route is resolvable yet.
   */
  protected announcedSummarizerRoute(agent: Agent): { summarizerProvider?: string; summarizerModel?: string } {
    const config = this.summarizerConfig(agent)
    // Empty strings mean "inherit", not "named": the shipped defaults are blank
    // so an unconfigured deployment resolves the conversation target instead.
    if (config.summarizationProvider !== '' && config.summarizationModel !== '') {
      return { summarizerProvider: config.summarizationProvider, summarizerModel: config.summarizationModel }
    }
    const target = conversationTarget(agent)
    if (target === undefined) return {}
    return { summarizerProvider: target.provider, summarizerModel: target.model }
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegionQuiet(range.start, range.end, agent, signal)
    }

    const mode = this.policyState(agent.session).mode
    const capacity = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    const contextWindow = mode?.contextBudgetTokens ?? capacity
    if (contextWindow === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model or set a session context budget',
      )
    }
    const spec = resolveCompactSpec(policy, contextWindow, mode?.thresholdTokens)
    // A provider-anchored measurement is the provider's own count and gates as
    // it stands; a heuristic one underprices dense content, so it is trusted at
    // the policy's safety factor before meeting a real-unit threshold.
    const gateTokens = (measured: TokenMeasurement): number => (
      measured.baseline.kind === 'usage'
        ? measured.totalTokens
        : Math.ceil(measured.totalTokens * policy.estimateSafetyFactor)
    )
    if (gateTokens(measurement) < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (gateTokens(measurement) < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegionQuiet(range.start, range.end, agent, signal)
      if (result === null) return null
      measurement = meter.measure(agent.session)
      if (gateTokens(measurement) < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${gateTokens(measurement)} gated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return this.runCancellable(signal, (composed, hooks) => compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        ...this.announcedSummarizerRoute(agent),
        onOpen: hooks.onOpen,
        live: hooks.live,
      },
      composed,
    ))
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          // A live unmatched `compaction/start` is reported BEFORE range
          // selection. Once selection can legitimately return null (a surface
          // holding only checkpoints is nothing to compact), a caller must not
          // see a silent `null` where the honest answer is "a compaction is
          // still open on this session".
          assertNoOpenManualCompaction(agent.session)
          // retainTokens = 0 makes the backward walk stop at the last node, so
          // the range is "everything except the newest item" and the tool-pairing
          // walk then finds the largest balanced span. That span is the real
          // conversation, not the lone previous checkpoint: on a 718K session
          // this is what turns one /compact into 169053 -> 1489 tokens.
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await this.runCancellable(operationSignal, (signal, hooks) => compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              ...this.announcedSummarizerRoute(agent),
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
              onOpen: hooks.onOpen,
              live: hooks.live,
            },
            signal,
          ))
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort, onWindows, live) => this.summarize(input, owner, abort, onWindows, live),
    }
  }

  /**
   * Run one region transaction with an operator-cancellable abort composition:
   * the caller's signal and the per-transaction stop controller are joined, the
   * minted identity is registered for {@link CompactionEngine.cancelCompaction},
   * and live frames are published as transient `compaction/stream` events. The
   * stop controller aborts with its own `ManualCompactionError('cancelled')`
   * reason, so every downstream `throwIfAborted()` surfaces the NEUTRAL
   * cancelled outcome and never a failure.
   * @param signal - caller-owned cancellation composed with the stop controller.
   * @param run - transaction body receiving the composed signal and the two hooks.
   * @returns the transaction result.
   */
  private async runCancellable<T>(
    signal: AbortSignal | undefined,
    run: (
      signal: AbortSignal,
      hooks: {
        onOpen: (compactionId: CompactionId) => void
        live: (frame: CompactionStreamFrame) => void
      },
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const composed = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal])
    let opened: CompactionId | undefined
    const hooks = {
      onOpen: (compactionId: CompactionId): void => {
        opened = compactionId
        this.activeCompactions.set(compactionId, controller)
      },
      live: (frame: CompactionStreamFrame): void => {
        this.ctx.emit('compaction/stream', frame)
      },
    }
    try {
      return await run(composed, hooks)
    } finally {
      if (opened !== undefined && this.activeCompactions.get(opened) === controller) {
        this.activeCompactions.delete(opened)
      }
    }
  }

  /**
   * Stop the running compaction under `compactionId`: abort the composed signal
   * (its reason is the neutral `ManualCompactionError('cancelled')`), tear down
   * the in-flight summarizer request at the provider transport, and let the
   * transaction close its bracket with the `cancelled` marker.
   * @param compactionId - transaction identity from `compaction/start`.
   * @returns whether a live compaction was cancelled.
   */
  override cancelCompaction(compactionId: CompactionId): boolean {
    const controller = this.activeCompactions.get(compactionId)
    if (controller === undefined) return false
    controller.abort(new ManualCompactionError('cancelled', 'compaction stopped by the operator'))
    return true
  }

  /** Automatic-region wrapper: an operator stop is a neutral no-op, not a failure. */
  private async compactRegionQuiet(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    try {
      return await this.compactRegion(start, end, agent, signal)
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError && error.code === 'cancelled') return null
      throw error
    }
  }

  /**
   * Read the session's folded compaction policy facts.
   * @param session - session whose mode is read.
   * @returns the folded mode and routed-capacity state.
   */
  private policyState(session: Session): CompactionPolicyState {
    const state = this.ctx.sessionProjections.stateOf(session, 'compactionPolicy')
    if (state === undefined) {
      throw new Error('compaction-basic: compactionPolicy session projection is not registered')
    }
    return state
  }
}

export default BasicCompactionEngine
