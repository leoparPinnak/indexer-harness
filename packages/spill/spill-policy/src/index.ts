/**
 * The spill-policy PLUGIN: a `tools/post-execute` result transformer that keeps
 * oversized plain-text tool results out of the model's context. When a final
 * result's UTF-8 size exceeds the budget that applies to its tool — the global
 * `maxInlineBytes`, or the tool's `toolLimits` row — it saves the FULL text to a
 * session-scoped spill artifact (`ctx.spillStore`) and replaces the model-facing
 * result with an envelope: a `spill: { … }` totals receipt, a bounded head/tail
 * preview separated by the deterministic truncation marker, and the
 * `[budget notice]` that carries the backend's locator and retrieval guidance.
 *
 * It registers NO service and owns NO storage or preview mechanics: preview is
 * `@deepseek-ai/dsh-output-retention` (`TextRetainer`), storage is `ctx.spillStore`.
 * The policy only decides WHEN and AT WHAT BUDGET to spill, and composes the
 * envelope and the notice.
 *
 * A second arm applies the same per-tool budget to the durable log: the
 * `tools/ptc-dispatch-log` waterfall bounds the `tool/ptc-dispatch` event's copy
 * of an oversized `run_code` sub-call result (the program's value is untouched;
 * UIs and replay read the full text through the spill artifact).
 *
 * ## Deliberately narrow
 *
 * - Omitted `maxInlineBytes` ⇒ the plugin registers nothing (a true no-op).
 *   `toolLimits` refines an enabled policy; it never enables one.
 * - Plain-text results only: a result carrying any non-text block is left
 *   untouched (the policy knows only the final formatted text, not tool
 *   internals).
 * - Nested composite calls skip the MODEL-facing arm; their durable log copy
 *   is bounded by the dispatch-log arm instead.
 * - Accepted value replacements pass through for registry revalidation and
 *   rendering; this presentation policy cannot also replace content in the
 *   same mutually exclusive decision.
 * - `toolLimits.read = 'skip'` — a DEFAULT row, so the documented
 *   `read → spill → read again` loop guard is data rather than a hard-coded
 *   name check — skips the model-facing arm for `read`. The dispatch-log arm
 *   bounds `read` sub-calls too: a log copy is not model context, and `read`
 *   is precisely the tool that produces huge logs, so a `skip` row never
 *   disables log bounding (only a numeric row retunes it).
 * - Best-effort: no session owner, no `ctx.spillStore` backend, a save
 *   failure, or an OPEN circuit breaker ⇒ log and return the original result.
 *   A spill failure must NEVER turn a successful tool call into an `isError`
 *   or hide the inline result.
 *
 * ## Budget durability
 *
 * Every persistence attempt feeds two pure state machines (`./resilience.ts`):
 * a thrash detector that reports one artifact being spilled again and again
 * (three in a row), and a circuit breaker that OPENS after three consecutive
 * `saveText` failures and then keeps results inline — one clear error instead
 * of one failing write per oversized result for the rest of the session.
 *
 * It COMPOSES with other post-execute listeners: its prepended listener
 * delegates via `next()` and bounds the resulting content projection, so
 * tool-owned asynchronous projection runs before generic bounding, a hook that
 * replaced content still has its replacement bounded, and value replacements
 * and `block` decisions pass through unchanged.
 *
 * @module @deepseek-ai/dsh-spill-policy
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { Omitted } from '@deepseek-ai/dsh-output-retention'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SpillPolicyExec } from './types.ts'
import { formatSpillNotice } from './notice.ts'
import { formatSpillReceipt, formatTruncationMarker, renderSpillEnvelope } from './envelope.ts'
import type { SpillEnvelopeTotals } from './envelope.ts'
import { PersistCircuitBreaker, SpillThrashDetector } from './resilience.ts'

export type { SpillPolicyExec } from './types.ts'

/**
 * Per-tool retain policy: a UTF-8 byte budget for that tool's model-facing
 * result, or `'skip'` to keep it inline without spilling.
 */
export type ToolRetainLimit = number | 'skip'

/**
 * Shipped per-tool retain rows. `read` keeps its loop guard as data: every
 * other tool falls back to the global `maxInlineBytes`. Configured `toolLimits`
 * rows merge over these, so a deployment can retune any row — including giving
 * `read` a budget, or skipping a chatty tool — without new code.
 */
export const DEFAULT_TOOL_RETAIN_LIMITS: Readonly<Record<string, ToolRetainLimit>> = { read: 'skip' }

/** Plugin config. */
export interface Config {
  /**
   * The default model-facing context cap for a plain-text tool result, in UTF-8
   * bytes. Omitted disables the policy entirely (no-op). When set, a result
   * larger than the applicable budget is spilled and replaced with an envelope
   * derived from that same budget.
   */
  maxInlineBytes?: number
  /**
   * Per-tool retain budgets keyed by tool name: a non-negative byte budget, or
   * `'skip'` to never spill that tool's model-facing result. Rows merge over
   * {@link DEFAULT_TOOL_RETAIN_LIMITS}; an unlisted tool uses `maxInlineBytes`.
   * Numeric rows also retune the durable log copy; `'skip'` rows do not.
   */
  toolLimits?: Record<string, ToolRetainLimit>
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spill-policy'

/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
  toolLimits: z.dict(z.union([z.number(), 'skip'])),
})

/** All-text content flattened to one UTF-8 string, or `undefined` if any block is non-text. */
function flattenPlainText(content: ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

/** The owning session id, or `undefined` for a call with no agent (a direct/test call). */
function ownerSessionId(exec: ToolExecution): SessionId | undefined {
  return (exec as SpillPolicyExec).agent?.session.header.id
}

/**
 * Split `text` into a bounded head and tail of `budget` bytes, preserving the
 * exact UTF-8 omission the two cuts report. Both ends come from their own
 * retainer so the envelope can place the truncation marker between them; the
 * retained bytes never exceed the budget, so the counts re-add to the total.
 */
function preview(text: string, budget: number, totalBytes: number): { head: string; tail: string; omitted: Omitted } {
  const headRetainer = new TextRetainer({ kind: 'head', maxBytes: Math.ceil(budget / 2) })
  headRetainer.push(text)
  const tailRetainer = new TextRetainer({ kind: 'tail', maxBytes: Math.floor(budget / 2) })
  tailRetainer.push(text)
  const head = headRetainer.finish()
  const tail = tailRetainer.finish()
  const keptBytes = Buffer.byteLength(head.text, 'utf8') + Buffer.byteLength(tail.text, 'utf8')
  const omittedBytes = totalBytes - keptBytes
  return {
    head: head.text,
    tail: tail.text,
    omitted: omittedBytes > 0 ? { kind: 'exact', count: omittedBytes } : { kind: 'none' },
  }
}

export function apply(ctx: Context, config: Config): void {
  const maxInlineBytes = config.maxInlineBytes
  // Validate at LOAD, not per call: a negative/fractional cap would reach
  // TextRetainer's assertBudget and throw, turning every oversized-result call
  // into an isError. A bad config must fail the deployment, not the tool.
  if (maxInlineBytes !== undefined && (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0)) {
    throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`)
  }
  // Per-tool rows: same load-time contract, same reason.
  const limits: Record<string, ToolRetainLimit> = { ...DEFAULT_TOOL_RETAIN_LIMITS, ...config.toolLimits }
  for (const [toolName, limit] of Object.entries(limits)) {
    if (limit !== 'skip' && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error(`spill-policy: toolLimits.${toolName} must be a non-negative integer or 'skip' (got ${String(limit)})`)
    }
  }
  // Omitted ⇒ no automatic spill policy: register nothing at all.
  if (maxInlineBytes === undefined) return
  // Narrowed once for the nested arms (closure narrowing does not survive awaits).
  const cap: number = maxInlineBytes

  // Budget durability, one pair per plugin instance: the breaker opens after
  // three consecutive save failures and stays open (this session's backend is
  // failing — one clear error beats one failing write per oversized result);
  // the detector reports one artifact spilled three times in a row.
  const breaker = new PersistCircuitBreaker()
  const thrash = new SpillThrashDetector()

  /**
   * Spill `text` under `limit` and build the bounded replacement (envelope +
   * notice), or return `undefined` when the policy must keep the original (the
   * breaker is open, no session owner, no backend, storage failure, or no
   * within-cap replacement). Shared verbatim by the model-facing post-execute
   * arm and the durable dispatch-log arm so both produce byte-identical
   * projections.
   */
  async function spillReplacement(
    text: string,
    totalBytes: number,
    limit: number,
    sessionId: SessionId | undefined,
    toolName: string,
    callId: ToolCallId,
    label: 'result' | 'dispatch',
  ): Promise<string | undefined> {
    // The breaker already fired this session: keep the inline content instead
    // of burning one more failing save on every oversized result.
    if (breaker.open) return undefined
    if (sessionId === undefined) {
      ctx.logger.warn(`spill-policy: no session owner for ${toolName} ${label}; keeping the inline content`)
      return undefined
    }
    const spillStore = ctx.get('spillStore')
    if (!spillStore) {
      ctx.logger.warn('spill-policy: no ctx.spillStore backend loaded; keeping the inline content')
      return undefined
    }
    const save: SaveTextSpill = {
      owner: { sessionId },
      source: { kind: 'tool', toolName, callId, label },
      suggestedName: `${toolName}.txt`,
      content: text,
    }
    let ref: SpillRef
    try {
      ref = await spillStore.saveText(save)
    } catch (error: unknown) {
      // Best-effort: a storage failure (permissions, ENOSPC, backend down) must
      // never fail the call or hide the content — keep the original inline.
      ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`)
      const trip = breaker.recordFailure()
      if (trip !== undefined) ctx.logger.error(`spill-policy: ${trip}`)
      return undefined
    }
    breaker.recordSuccess()
    // Same artifact again and again (owner + tool + content) is a spill loop:
    // report it once when the streak reaches the threshold.
    const artifactKey = `${String(sessionId)}:${toolName}:${createHash('sha256').update(text).digest('hex')}`
    const thrashWarning = thrash.record(artifactKey)
    if (thrashWarning !== undefined) ctx.logger.warn(`spill-policy: ${thrashWarning}`)

    // Reserve the envelope rows' and the notice's byte cost INSIDE limit so the
    // replacement (receipt + preview + marker + blank line + notice) never
    // exceeds the applicable budget — a naive preview that spent the whole
    // budget first would break the cap once the rows were appended. The rows
    // are exact (the totals are known before the preview); the notice is
    // priced at the worst-case omission count (the full byte total): its digit
    // count bounds the real count's, so the reserved size is a safe upper bound
    // and the final notice is never longer than what we reserved. The `+ 5` is
    // the fixed row joins: receipt, head, marker, tail, and the blank line
    // before the notice.
    const totals: SpillEnvelopeTotals = { chars: text.length, bytes: totalBytes, limit }
    const rowsBytes = Buffer.byteLength(formatSpillReceipt(totals), 'utf8')
      + Buffer.byteLength(formatTruncationMarker(limit), 'utf8') + 5
    const noticeWorstBytes = Buffer.byteLength(formatSpillNotice({ kind: 'exact', count: totalBytes }, ref), 'utf8')
    const previewBudget = Math.max(0, limit - rowsBytes - noticeWorstBytes)
    const { head, tail, omitted } = preview(text, previewBudget, totalBytes)
    const envelope = renderSpillEnvelope({ totals, head, tail })
    const replacedText = `${envelope}\n\n${formatSpillNotice(omitted, ref)}`
    // Invariant: the policy NEVER emits a replacement larger than the cap. When
    // the rows + notice alone exceed the budget (a tiny budget or a long spill
    // root), there is no within-cap replacement, so keep the inline content —
    // spilling would break the advertised cap. (A within-cap replacement is
    // always smaller than the original, which is > limit by the entry
    // condition, so this one check subsumes "not smaller than the original"
    // too. The spill file already written is a harmless orphan; cleanup is
    // deferred.)
    if (Buffer.byteLength(replacedText, 'utf8') > limit) {
      ctx.logger.warn(`spill-policy: spill envelope for ${toolName} exceeds its budget; keeping the inline content`)
      return undefined
    }
    return replacedText
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip nested composite calls: only an outer result becomes model context
    // through this arm.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.parent !== undefined) return decision
    // The per-tool row decides: `skip` (default for `read`, the documented
    // read → spill → read-again loop guard) keeps the result inline.
    const row = limits[exec.name]
    if (row === 'skip') return decision
    const limit = row ?? cap

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= limit) return decision

    const replacedText = await spillReplacement(
      text, totalBytes, limit, ownerSessionId(exec), exec.name, exec.callId, 'result')
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })

  // The durable-log arm: bound the `tool/ptc-dispatch` event's copy of an
  // oversized sub-call result the same way the model-facing arm bounds an outer
  // result. The program's returned value is untouched (it already crossed the
  // worker boundary whole); only the session log's copy shrinks to envelope +
  // locator, so replay and UIs read the full text through the spill artifact
  // exactly as they do for spilled native results. `skip` rows never disable
  // this arm — a log copy is not model context — but a numeric row retunes it
  // so both projections of one tool agree on its budget.
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next): Promise<ContentBlock[]> => {
    const content = await next()
    const row = limits[dispatch.name]
    const limit = typeof row === 'number' ? row : cap
    // `read` sub-calls spill too: the log copy is not model context, so the
    // read → spill → read-again loop the post-execute arm avoids cannot happen
    // here, and read is precisely the tool that produces huge logs.
    const text = flattenPlainText(content)
    if (text === undefined) return content
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= limit) return content

    const replacedText = await spillReplacement(
      text, totalBytes, limit, ownerSessionId(dispatch.exec), dispatch.name, dispatch.subCallId, 'dispatch')
    if (replacedText === undefined) return content
    return [{ type: 'text', text: replacedText }]
  }, { prepend: true })
}
