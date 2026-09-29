/**
 * Categorized HARD/SOFT/ALLOW gating for `tools/pre-execute`. A configured
 * rule assigns a call to a taxonomy id (see `./taxonomy.ts` for the salvaged
 * 66 categories and their mandatory ALLOW exceptions), and this plugin routes
 * the call: HARD denies fail-closed through the monotonic `tools.guard()`
 * stage, SOFT asks through the approval seam's `ApprovalPolicy`/`decide()`
 * path, an ALLOW exception permits, and a call no rule matches keeps the
 * legacy 3-state waterfall default unchanged.
 * @module @deepseek-ai/dsh-guard-taxonomy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { GUARD_POLICY_IDS, GUARD_TAXONOMY, type GuardPolicyId, type GuardVerdict } from './taxonomy.ts'

export * from './taxonomy.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'guard-taxonomy'

/** The tool registry this plugin gates (`tools/pre-execute` plus `tools.guard()`). */
export const inject = ['tools']

/**
 * One rule assigning matching calls to one taxonomy id. A call may match
 * several rules; the verdict resolves HARD first (no exception clears a hard
 * block), then a mandatory ALLOW exception (it clears soft blocks), then SOFT.
 */
export interface GuardRule {
  /** Taxonomy id the matched call is gated by. */
  category: GuardPolicyId
  /** Exact tool names this rule categorises (e.g. `bash`). */
  tools?: string[]
  /**
   * RegExp source matched against the call's string `command` argument (the
   * `bash`/`pwsh` shell tools); calls without one never match this clause.
   */
  command?: string
}

/**
 * Plugin config. Defaults to no rules: with an empty rule list every call is
 * uncategorised and behaves exactly as before the taxonomy was mounted.
 */
export interface Config {
  /**
   * Rules evaluated in order against each pending call; first match per
   * class wins and the class precedence is hard > allow > soft.
   */
  rules?: GuardRule[]
}

/** Schemastery schema for {@link Config}; an unknown `category` fails load. */
export const Config: z<Config> = z.object({
  // Schemastery expresses optionality as "not required": only `category` is
  // `.required()`; an omitted `tools`/`command` key simply stays absent.
  rules: z.array(z.object({
    category: z.union(GUARD_POLICY_IDS).required(),
    tools: z.array(z.string()),
    command: z.string(),
  })).default([]),
})

/** One rule compiled at load: static name table lookup plus one prebuilt pattern. */
interface CompiledRule {
  readonly category: GuardPolicyId
  /** Exact tool names mapped to `true`; present only when the rule names any. */
  readonly tools?: Readonly<Record<string, true>>
  readonly command?: RegExp
}

/**
 * Compile one configured rule, failing loud at load: a rule that can never
 * match is a misconfiguration, and an invalid pattern must not silently drop
 * a category the deployment meant to enforce.
 * @param rule - the raw configured rule.
 * @returns the compiled rule.
 */
function compileRule(rule: GuardRule): CompiledRule {
  // The schema materializes an omitted `tools` as `[]`, so "matches nothing"
  // is an empty name table AND no command pattern — not a missing key.
  const tools = rule.tools ?? []
  if (tools.length === 0 && rule.command === undefined) {
    throw new Error(`guard-taxonomy: rule for "${rule.category}" matches nothing — give it \`tools\` or \`command\``)
  }
  let command: RegExp | undefined
  if (rule.command !== undefined) {
    try {
      command = new RegExp(rule.command)
    } catch (error: unknown) {
      throw new Error(
        `guard-taxonomy: rule for "${rule.category}" has an invalid \`command\` pattern: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    category: rule.category,
    ...tools.length === 0
      ? {}
      : { tools: Object.fromEntries(tools.map(toolName => [toolName, true] as const)) },
    ...command === undefined ? {} : { command },
  }
}

/**
 * Whether one compiled rule categorises the pending call.
 * @param rule - the compiled rule.
 * @param exec - the pending call (tool name and parsed arguments).
 * @returns whether the rule matches.
 */
function matches(rule: CompiledRule, exec: ToolExecution): boolean {
  // `=== true` (not truthiness): the table inherits Object.prototype, so a tool
  // named `toString` must not match by accident.
  if (rule.tools !== undefined && rule.tools[exec.name] === true) return true
  if (rule.command === undefined) return false
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return false
  const command = 'command' in args ? args.command : undefined
  return typeof command === 'string' && rule.command.test(command)
}

/**
 * The denial reason for one HARD verdict. Both enforcement points — the
 * prepended `tools/pre-execute` listener and the monotonic guard behind it —
 * call this so an overridden listener denial and the guard denial that
 * replaces it carry byte-identical text.
 * @param category - the hard-deny category the call matched.
 * @returns the model-facing denial reason.
 */
function hardDenyReason(category: GuardPolicyId): string {
  return `hard-deny category "${category}" blocks this call unconditionally (no ALLOW exception applies); have the user run this step directly`
}

/**
 * The ask reason for one SOFT verdict; it names the category so the approval
 * prompt says which rule flagged the call.
 * @param category - the soft-deny category the call matched.
 * @returns the model-facing ask reason.
 */
function softDenyReason(category: GuardPolicyId): string {
  return `soft-deny category "${category}" requires approval`
}

/**
 * Mount the taxonomy gate over the existing waterfall.
 *
 * The `tools/pre-execute` listener is prepended so it decides after every
 * other policy listener has run (side-effect listeners still observe every
 * call), and the hard-deny backstop registers as a monotonic `tools.guard()`,
 * so no listener ordering can turn a HARD block back into permission. A call
 * no rule matches returns the inner decision untouched.
 * @param ctx - the host context (requires the `tools` registry).
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const compiled = (config.rules ?? []).map(compileRule)

  const verdictOf = (exec: ToolExecution): GuardVerdict | undefined => {
    let soft: GuardPolicyId | undefined
    let allow: GuardPolicyId | undefined
    for (const rule of compiled) {
      if (!matches(rule, exec)) continue
      const cls = GUARD_TAXONOMY[rule.category]
      if (cls === 'hard') return { class: 'hard', category: rule.category }
      if (cls === 'allow') allow ??= rule.category
      else soft ??= rule.category
    }
    if (allow !== undefined) return { class: 'allow', category: allow }
    if (soft !== undefined) return { class: 'soft', category: soft }
    return undefined
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    const verdict = verdictOf(exec)
    if (verdict === undefined) return decision
    if (verdict.class === 'hard') return { kind: 'deny', reason: hardDenyReason(verdict.category) }
    // An existing denial from another policy plane is a floor this taxonomy
    // does not lift: exceptions clear the taxonomy's own soft/ask path only.
    if (decision.kind === 'deny') return decision
    if (verdict.class === 'allow') return { kind: 'allow' }
    return { kind: 'ask', reason: softDenyReason(verdict.category) }
  }, { prepend: true })

  // The monotonic guard is the fail-closed rail for HARD: it runs after every
  // pre-execute listener and after ask resolution, so a listener registered
  // later cannot re-allow a hard-deny block.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const verdict = verdictOf(exec)
    return verdict !== undefined && verdict.class === 'hard' ? hardDenyReason(verdict.category) : undefined
  }), 'guard-taxonomy: hard-deny guard')
}

export default apply
