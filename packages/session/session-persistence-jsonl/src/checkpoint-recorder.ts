/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-checkpoint: the recorder
 * that bridges {@link CheckpointJournal} to a tool lifecycle. It subscribes two
 * taps (before/after dispatch), captures the pre-image of every path a writing
 * call is about to touch, and records one journal step per writing call — so
 * `rewindPlan` finally has something real to chew on.
 *
 * The taps are DUCK-TYPED on purpose: this package stays free of a
 * `@deepseek-ai/dsh-core-tools` dependency, and any runtime whose lifecycle
 * exposes subscribe/unsubscribe (the `tools/pre-execute` /
 * `tools/post-execute` waterfalls, a hook bus, a test fake) can drive the
 * recorder. Integrating the live runtime is one adapter call at the agent
 * boundary.
 *
 * Failure isolation mirrors the house observer rule: a recorder mistake is
 * WARNED through `onError` and never thrown into the tool call — a broken
 * checkpoint is cheaper than a failed edit.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/checkpoint-recorder
 */
import type { CheckpointInput, CheckpointJournal, CheckpointKind } from './checkpoint.ts'

/** One tool call the taps describe; enough identity for journal labels. */
export interface CheckpointToolCall {
  /** Runtime call id (stable within the session). */
  readonly callId: string
  /** Tool name (`write`, `edit`, `run_shell_command`, …). */
  readonly name: string
}

/** The two lifecycle taps a recorder needs; unsubscribe with the returned disposer. */
export interface CheckpointToolTaps {
  /** Subscribe to the before-dispatch tap. */
  pre(listener: (call: CheckpointToolCall) => void): () => void
  /** Subscribe to the after-dispatch tap (`ok` is the call's settlement). */
  post(listener: (call: CheckpointToolCall, ok: boolean) => void): () => void
}

/**
 * The capture policy the recorder consults: WHICH paths a call touches and what
 * they currently hold. The policy owns tool-argument knowledge (which argument
 * is a path); the recorder owns the journal mechanics.
 */
export interface CheckpointCapturePlan {
  /**
   * Paths a writing call is about to MODIFY; `null` when the call writes
   * nothing (the recorder then skips it entirely).
   */
  paths(call: CheckpointToolCall): readonly string[] | null
  /** Paths the call is about to CREATE (no pre-image; removed on rewind). */
  creates(call: CheckpointToolCall): readonly string[]
  /** Current content of one path; `undefined` when the file is not there. */
  read(path: string): string | undefined
}

/** Recorder knobs. */
export interface CheckpointRecorderOptions {
  /** The step kind stamped on entries; defaults to `edit`. */
  kind?: CheckpointKind
  /** Called when recording itself fails; the tool call is never affected. */
  onError?: (error: unknown) => void
}

/**
 * Bridge one journal to one tool lifecycle: record one step per writing call
 * BEFORE it runs (the pre-image window), and keep the in-flight bookkeeping
 * honest on the after tap.
 * @param taps - the lifecycle taps to subscribe.
 * @param journal - the journal that receives the steps.
 * @param plan - the capture policy (which paths, and their content).
 * @param options - step kind and the isolated error sink.
 * @returns a disposer removing both subscriptions.
 */
export function attachCheckpointRecorder(
  taps: CheckpointToolTaps,
  journal: CheckpointJournal,
  plan: CheckpointCapturePlan,
  options: CheckpointRecorderOptions = {},
): () => void {
  const kind = options.kind ?? 'edit'
  const fail = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // A failing error sink must not reach the tool call either.
    }
  }
  const inFlight = new Set<string>()

  const offPre = taps.pre((call) => {
    try {
      const paths = plan.paths(call)
      const created = plan.creates(call)
      if ((paths === null || paths.length === 0) && created.length === 0) return
      const captured: { path: string; content: string }[] = []
      for (const path of paths ?? []) {
        // A path with no content is not a pre-image — it is a birth, and the
        // plan's "born in the window is removed" rule already covers it.
        const content = plan.read(path)
        if (typeof content === 'string') captured.push({ path, content })
      }
      const input: CheckpointInput = {
        kind,
        label: `${call.name}#${call.callId}`,
        captured,
        created: [...created],
      }
      journal.record(input)
      inFlight.add(call.callId)
    } catch (error) {
      fail(error)
    }
  })

  const offPost = taps.post((call) => {
    // Post tap keeps the in-flight bookkeeping truthful; the journal itself is
    // pre-image shaped and needs no outcome rewrite.
    inFlight.delete(call.callId)
  })

  return () => {
    offPre()
    offPost()
  }
}