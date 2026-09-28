/**
 * Compaction vocabulary: the result type and the `compaction/*` session events.
 * Those declaration-merged events record the lock and summary inputs without entering the surface, so they are not
 * surface events; a separate replacement `user/message` carries the summary.
 * Backend packages own configuration and retention policy; see
 * `.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md`.
 * @module @deepseek-ai/dsh-compaction/types
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
// Type-only: resolves the projection type outlet so the namespace merge below
// binds to the loaded module (the permission-presets precedent).
import type {} from '@deepseek-ai/dsh-session-projection'
import type { CompactionId } from './brand.ts'

export type { CompactionId }

/** Policy fields shared by every summarizer route choice in {@link CompactionSessionMode}. */
interface CompactionSessionModePolicy {
  /**
   * Per-session context budget in tokens: the capacity automatic compaction
   * policy prices against instead of the adapter-declared model window.
   * Absent means the routed model's declared capacity applies.
   */
  contextBudgetTokens?: number
  /**
   * Absolute automatic-compaction trigger point in tokens. Absent derives the
   * trigger from the effective budget and the backend's configured threshold
   * ratio.
   */
  thresholdTokens?: number
  /**
   * Summarization output cap in tokens for this session's summary calls.
   * Absent applies the backend's configured `maxTokens`.
   */
  maxTokens?: number
}

/**
 * One session's compaction mode — whole-value replace: every `compaction/mode`
 * event carries the complete value, so the last such event is the session's
 * mode. The summarizer route choice names WHO writes summaries; the windowed
 * summarization safety net applies underneath either choice.
 */
export type CompactionSessionMode = CompactionSessionModePolicy & (
  | {
    /** Summaries are written by the session's routed conversation model. */
    summarizer: 'conversation'
  }
  | {
    /** Summaries are written by a dedicated, larger-window model. */
    summarizer: 'dedicated'
    /** Registered provider route of the dedicated summarizer. */
    provider: string
    /** Provider-owned model id of the dedicated summarizer. */
    model: string
  }
)

/**
 * One intermediate summarizer call inside a windowed compaction: a per-window
 * map pass or an intermediate merge that produced a summary later calls
 * consumed. Logged so every summary request — whose input includes these
 * outputs — is reconstructable from log and code.
 */
export interface CompactionSummaryCall {
  /** Pipeline stage this call ran. */
  stage: 'window' | 'merge'
  /** Complete provider output before the text-only summary projection. */
  rawOutput: ContentBlock[]
  /** The provider route that wrote this intermediate summary. */
  provider: string
  /** The model that wrote this intermediate summary. */
  model: string
  /** The generation cap this call sent, when one applied. */
  maxTokens?: number
  /** Provider-reported token usage for this call, when emitted. */
  usage?: TokenUsage
}

/**
 * Folded host state of the `compactionPolicy` session projection: the stored
 * mode plus the routed capacity facts, before any backend resolution.
 */
export interface CompactionPolicyState {
  /** The session's stored mode, or null when the session runs backend defaults. */
  mode: CompactionSessionMode | null
  /** Latest routed provider/model, or null before any request context. */
  route: { provider: string; model: string } | null
  /** Latest routed model capacity in tokens; null when the route advertises none. */
  modelCapacity: number | null
}

/**
 * Client value of the `compactionPolicy` session projection: the stored mode
 * with the effective policy figures resolved by the backend (per-route policy
 * overrides included).
 */
export interface CompactionPolicyView {
  /** The session's stored mode, or null when the session runs backend defaults. */
  mode: CompactionSessionMode | null
  /** Latest routed model capacity in tokens, or null before any request context. */
  modelCapacity: number | null
  /** Effective context budget: the mode override or the routed capacity; null when neither is known. */
  contextBudgetTokens: number | null
  /** Effective automatic-compaction trigger point in tokens; null when the budget is unknown. */
  thresholdTokens: number | null
  /** Effective summarization output cap: the session's override or the backend's configured `maxTokens`. */
  maxTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded compaction policy facts for one session. */
    compactionPolicy: CompactionPolicyState
  }
  interface SessionProjectionMap {
    /** Effective compaction policy figures for one session. */
    compactionPolicy: CompactionPolicyView
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
    /**
     * The windowed summarization pipeline committed to its map phase —
     * log-only, inside the `compaction/start`/`compaction/end` bracket. It
     * exists so an observer can see the multi-call mechanism running before
     * the first window call starts; `windows` is the planned map-pass count.
     */
    'compaction/windows': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      /** Number of message windows the summarizer split the shadowed span into. */
      windows: number
    }
    /**
     * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by the immediately following `user/message` event that
     * shadows the compacted range. That adjacency is contractual — the
     * shadowed pricing fields are the replacement's shadow price, so a
     * consumer may pair a replacement with the metering event directly
     * before it (`compaction/prune` documents the shared protocol).
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      shadowedSeqs: SessionSeq[]
      shadowedTokenCount: number
      /** The provider route that wrote the summary. */
      provider: string
      /**
       * The model that wrote the summary — the summarize call's envelope,
       * reported by the backend that made the call, logged so the one-shot
       * request is reconstructable from log + code and "which model wrote
       * this summary" has a durable answer (the reconstructability Agent Note).
       */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
      /** Provider-reported token usage for the summarization request, when emitted. */
      usage?: TokenUsage
      /**
       * Map and intermediate-merge calls whose outputs the final call
       * consolidated, in call order. Absent on a one-shot summary; the final
       * call's own envelope and output stay in the fields above and in the
       * single-call arm below.
       */
      intermediateCalls?: CompactionSummaryCall[]
    } & (
      | {
        /** Complete provider output before the backend's safe summary projection. */
        rawOutput: ContentBlock[]
        /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
        llmStreamCall: true
      }
      | {
        /** Optional complete output from an unmarked template, remote, or other summarizer. */
        rawOutput?: ContentBlock[]
        /** An unmarked summary does not identify a call through this context's LLM seam. */
        llmStreamCall?: never
      }
    )
    /**
     * Marks the end of a compaction — log-only, releases the lock. Its owner
     * matches `compaction/start`; `error` records an unsuccessful attempt.
     */
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
    /**
     * Shadow price of one model-free prune replacement — log-only, no
     * surfaceOp. The shared shadow-price protocol: a surface `replace` event
     * is priced by the metering event immediately before it (`compaction/summary`
     * for a summarizing compaction, this event for a prune), which states the
     * heuristic token price of the exact replaced range so a pure consumer
     * can subtract it without retaining per-node prices. The replacement MUST
     * be appended synchronously right after this event.
     */
    'compaction/prune': {
      /** The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}). */
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      /** The seqs of all shadowed surface nodes, in surface order. */
      shadowedSeqs: SessionSeq[]
      /** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
      shadowedTokenCount: number
    }
    /**
     * The session's compaction mode was switched — log-only whole-value
     * replace: the LAST such event is the session's mode, folded by
     * {@link readCompactionMode}. Survives resume and fork by replay; absent
     * means the backend defaults apply.
     */
    'compaction/mode': CompactionSessionMode
  }
}

/** Result of a successful compaction operation. */
export interface CompactionResult {
  /** Stable identity shared by this compaction's complete durable lifecycle. */
  compactionId: CompactionId
  /** Human command that initiated this compaction, when it was manual. */
  sourceCommandId?: CommandId
  /** The seq of the appended `compaction/start` event. */
  startSeq: SessionSeq
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: SessionSeq
  /** The seq of the appended `compaction/end` event. */
  endSeq: SessionSeq
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
