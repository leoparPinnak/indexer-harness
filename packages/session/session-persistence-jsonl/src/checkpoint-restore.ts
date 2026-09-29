/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-checkpoint: the rewind
 * APPLIER. `CheckpointJournal.rewindPlan` computes WHERE the workspace should
 * stand before one step; this module PUTS it there — blob → path restores
 * (verified by read-back), birth removals (idempotent on absence), and an
 * honest per-path failure list instead of a half-applied mystery.
 *
 * The applier touches NOTHING outside the plan: no globbing, no directory
 * wipes, no "while we are here" cleanup. Verification is part of success — a
 * write that does not read back as the blob bytes is `failed`, never
 * `restored`. The conversation half of a rewind (dropping `dropSteps` from the
 * session) stays with its owner; this module echoes the ids so the caller can
 * close that half.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/checkpoint-restore
 */
import type { CheckpointIo, RewindPlan } from './checkpoint.ts'

/** One path the applier could not bring to the planned state, with the reason. */
export interface RewindApplyFailure {
  readonly path: string
  readonly reason: string
}

/** The applied-rewind report: what is now true, and what is honestly not. */
export interface RewindApplyResult {
  /** Paths restored and READ-BACK VERIFIED against their blobs. */
  readonly restored: readonly string[]
  /** Creations removed (or already absent). */
  readonly removed: readonly string[]
  /** Per-path failures; the workspace may be partially rewound — this says where. */
  readonly failed: readonly RewindApplyFailure[]
  /** Echo of the plan's dropped step ids, for the session half. */
  readonly dropSteps: readonly number[]
}

/** The workspace side of a rewind: three honest verbs, no more. */
export interface RewindWorkspaceIo {
  /** Write (create or overwrite) one workspace file. */
  write(path: string, content: string): void
  /** Read one workspace file; undefined when absent. Used to VERIFY restores. */
  read(path: string): string | undefined
  /** Delete one workspace file; deleting an absent file succeeds. */
  remove(path: string): void
}

/**
 * Apply one rewind plan over one workspace.
 * @param plan - the plan from {@link CheckpointJournal.rewindPlan}.
 * @param journalIo - the journal's blob store (the restore source).
 * @param workspace - the workspace verbs (write/read/remove).
 * @returns the honest report: restored (verified), removed, failed, dropSteps.
 */
export function applyRewindPlan(
  plan: RewindPlan,
  journalIo: Pick<CheckpointIo, 'readBlob'>,
  workspace: RewindWorkspaceIo,
): RewindApplyResult {
  const restored: string[] = []
  const removed: string[] = []
  const failed: RewindApplyFailure[] = []

  for (const entry of plan.restore) {
    const content = journalIo.readBlob(entry.blob)
    if (content === undefined) {
      failed.push({ path: entry.path, reason: `restore source missing: ${entry.blob}` })
      continue
    }
    try {
      workspace.write(entry.path, content)
    } catch (error) {
      failed.push({ path: entry.path, reason: `write failed: ${message(error)}` })
      continue
    }
    // Verification is part of success: a write that does not read back as the
    // blob bytes is a failure, never a silent partial.
    if (workspace.read(entry.path) !== content) {
      failed.push({ path: entry.path, reason: 'verify mismatch after restore' })
      continue
    }
    restored.push(entry.path)
  }

  for (const path of plan.remove) {
    try {
      workspace.remove(path)
      removed.push(path)
    } catch (error) {
      failed.push({ path, reason: `remove failed: ${message(error)}` })
    }
  }

  return { restored, removed, failed, dropSteps: [...plan.dropSteps] }
}

/** Error text for the failure rows. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}