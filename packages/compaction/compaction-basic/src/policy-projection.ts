/**
 * The `compactionPolicy` session projection: the read side of the per-session
 * compaction mode. The pure fold keeps the stored mode and the routed
 * capacity facts; the wire view resolves the effective budget and trigger
 * point through the backend's per-route policy.
 *
 * @module @deepseek-ai/dsh-compaction-basic/policy-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  CompactionPolicyState,
  CompactionPolicyView,
  CompactionSessionMode,
} from '@deepseek-ai/dsh-compaction'
import { resolveTargetPolicy, thresholdTokensFor } from './config.ts'
import type { ResolvedConfig } from './types.ts'

const tokenFigure = zod.number().int().positive()

// zod `.optional()` types a key `number | undefined` while the vocabulary says
// `?: number`; on the JSON wire the two serialize identically (absent), so the
// casts record exactly that exactOptionalPropertyTypes widening (the
// permission-presets projection precedent).
const modeSchema = zod.union([
  zod.object({
    summarizer: zod.literal('conversation'),
    contextBudgetTokens: tokenFigure.optional(),
    thresholdTokens: tokenFigure.optional(),
    maxTokens: tokenFigure.optional(),
  }),
  zod.object({
    summarizer: zod.literal('dedicated'),
    provider: zod.string().min(1),
    model: zod.string().min(1),
    contextBudgetTokens: tokenFigure.optional(),
    thresholdTokens: tokenFigure.optional(),
    maxTokens: tokenFigure.optional(),
  }),
]) as unknown as ZodType<CompactionSessionMode>

const stateSchema: ZodType<CompactionPolicyState> = zod.object({
  mode: modeSchema.nullable(),
  route: zod.object({ provider: zod.string(), model: zod.string() }).nullable(),
  modelCapacity: tokenFigure.nullable(),
}) as unknown as ZodType<CompactionPolicyState>

const viewSchema: ZodType<CompactionPolicyView> = zod.object({
  mode: modeSchema.nullable(),
  modelCapacity: tokenFigure.nullable(),
  contextBudgetTokens: tokenFigure.nullable(),
  thresholdTokens: tokenFigure.nullable(),
  maxTokens: tokenFigure,
}) as unknown as ZodType<CompactionPolicyView>

/**
 * One-event compaction-policy transition (the projection unit's `apply`).
 * Unrelated events return the same reference — the registry's change gate.
 * @param state - folded mode and routed capacity facts before `event`.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is unrelated.
 */
function applyCompactionPolicy(
  state: CompactionPolicyState,
  event: SessionEvent,
): CompactionPolicyState {
  switch (event.type) {
    case 'compaction/mode':
      return { ...state, mode: event.data }
    case 'request/context':
      return {
        ...state,
        route: { provider: event.data.provider, model: event.data.model },
        modelCapacity: event.data.contextWindow ?? null,
      }
    default:
      return state
  }
}

/**
 * Resolve one folded state's effective policy figures for display.
 * @param config - validated service configuration owning the threshold ratios.
 * @param state - folded mode and routed capacity facts.
 * @returns the session's mode with its effective budget and trigger point.
 */
function viewOf(config: ResolvedConfig, state: CompactionPolicyState): CompactionPolicyView {
  const thresholdRatio = state.route === null
    ? config.thresholdRatio
    : resolveTargetPolicy(config, state.route).thresholdRatio
  const budget = state.mode?.contextBudgetTokens ?? state.modelCapacity
  return {
    mode: state.mode,
    modelCapacity: state.modelCapacity,
    contextBudgetTokens: budget,
    thresholdTokens: budget === null
      ? null
      : thresholdTokensFor({ thresholdRatio }, budget, state.mode?.thresholdTokens),
    maxTokens: state.mode?.maxTokens ?? config.maxTokens,
  }
}

/**
 * Build the `compactionPolicy` projection unit: the pure fold over
 * `compaction/mode` and `request/context`, with the wire view resolving the
 * effective figures through the backend's per-route policy.
 * @param configSource - reads the engine's current resolved configuration on
 *   every view computation, so a committed settings write reaches the
 *   displayed default without a restart.
 * @returns the unit definition to register on `ctx.sessionProjections`.
 */
export function compactionPolicyProjection(
  configSource: () => ResolvedConfig,
): Omit<ProjectionDefinition<'compactionPolicy', CompactionPolicyState>, 'wire'> & {
  wire: {
    viewSchema: ZodType<CompactionPolicyView>
    view(state: CompactionPolicyState): CompactionPolicyView
  }
} {
  return {
    key: 'compactionPolicy',
    stateVersion: 1,
    stateSchema,
    init: () => ({ mode: null, route: null, modelCapacity: null }),
    apply: applyCompactionPolicy,
    wire: {
      viewSchema,
      view: state => viewOf(configSource(), state),
    },
  }
}
