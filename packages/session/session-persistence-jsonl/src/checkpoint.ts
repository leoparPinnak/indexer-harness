/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-checkpoint: the FILE-level
 * shadow journal (the Gemini shadow-git pattern, git-free core). A writing step
 * records the pre-image of the files it is about to touch plus the paths it
 * creates; a rewind then computes a RESTORE PLAN — which blob rewrites which
 * path (earliest pre-image wins), which post-step creations are removed, and
 * which journal steps are invalidated — so undoing work costs a plan, not a
 * prayer. The consumer that applies the plan (a tool hook, a rewind UI) lives
 * outside this core; conversation-seq dropping belongs to the session half and
 * rides on {@link RewindPlan.dropSteps} only as step ids here.
 *
 * Durability convention: `CheckpointIo.file` writes blobs BEFORE the journal
 * line that names them, so a crash mid-record leaves harmless unnamed blobs
 * rather than a journal pointing at nothing.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/checkpoint
 */

/** The kind of writing step one entry covers. */
export type CheckpointKind = 'edit' | 'write' | 'delete' | 'other'

/** One file pre-image: `path` is workspace-relative, `blob` names stored content. */
export interface CheckpointCapture {
  readonly path: string
  readonly blob: string
}

/** One recorded step: pre-images taken BEFORE it ran, paths it created. */
export interface CheckpointStep {
  /** Journal sequence; assigned by {@link CheckpointJournal.record}, starts at 1. */
  readonly seq: number
  readonly kind: CheckpointKind
  readonly label: string
  /** Pre-image of every file the step was about to modify. */
  readonly captured: readonly CheckpointCapture[]
  /** Workspace-relative paths the step created (removed on rewind, never restored). */
  readonly created: readonly string[]
}

/** Input of one record call: content carried in, blob names assigned by the journal. */
export interface CheckpointInput {
  readonly kind: CheckpointKind
  readonly label: string
  /** Path + CURRENT content (the pre-image, captured before the step runs). */
  readonly captured: readonly { readonly path: string; readonly content: string }[]
  readonly created: readonly string[]
}

/** The rewind plan: pure data — applying it is somebody else's job. */
export interface RewindPlan {
  /** The plan restores the state as it stood BEFORE step `toSeq` ran. */
  readonly toSeq: number
  /** Blob → path writes restoring touched files (earliest pre-image per path wins). */
  readonly restore: readonly { readonly path: string; readonly blob: string }[]
  /** Creations from the dropped steps that no restore rewrites — delete these. */
  readonly remove: readonly string[]
  /** Journal steps invalidated (their effects are undone and their calls re-offered). */
  readonly dropSteps: readonly number[]
}

/** Injectable persistence seam: journal lines plus blob storage. */
export interface CheckpointIo {
  /** Append one journal line (already serialized). */
  appendLine(line: string): void
  /** All journal lines in order. */
  readLines(): string[]
  /** Store one blob's content. */
  writeBlob(name: string, content: string): void
  /** Read one blob's content; undefined when absent. */
  readBlob(name: string): string | undefined
}

/**
 * The file-level checkpoint journal over one {@link CheckpointIo}.
 * Sequence numbers are assigned here and never reused: a fresh journal over an
 * existing store continues where the stored lines left off.
 */
export class CheckpointJournal {
  readonly #io: CheckpointIo
  readonly #steps: CheckpointStep[] = []

  /**
   * @param io - persistence seam; stored lines are replayed for `steps()` and the next seq.
   */
  constructor(io: CheckpointIo) {
    this.#io = io
    for (const [index, line] of io.readLines().entries()) {
      if (line.trim() === '') continue
      const parsed = parseStepLine(line)
      if (parsed === undefined) {
        throw new Error(`checkpoint: journal line ${String(index + 1)} is not a recognizable step`)
      }
      this.#steps.push(parsed)
    }
  }

  /** Every recorded step, in journal order.
   * @returns a copy — the journal is never consumed by planning.
   */
  steps(): CheckpointStep[] {
    return [...this.#steps]
  }

  /**
   * Record one step: blobs are written first, then the journal line (crash =
   * dangling blobs, never a line naming a missing blob).
   * @param input - the step's kind/label, pre-image contents, and creations.
   * @returns the recorded step with its assigned seq and blob names.
   */
  record(input: CheckpointInput): CheckpointStep {
    const seq = (this.#steps[this.#steps.length - 1]?.seq ?? 0) + 1
    const captured: CheckpointCapture[] = input.captured.map((capture, index) => {
      const blob = `b${String(seq)}-${String(index)}.txt`
      this.#io.writeBlob(blob, capture.content)
      return { path: capture.path, blob }
    })
    const step: CheckpointStep = {
      seq,
      kind: input.kind,
      label: input.label,
      captured,
      created: [...input.created],
    }
    this.#io.appendLine(JSON.stringify(step))
    this.#steps.push(step)
    return step
  }

  /**
   * Compute the rewind plan that restores the state BEFORE `toSeq` ran: the
   * step's own effects and everything after it are undone, and their calls are
   * re-offered (via `dropSteps`).
   * @param toSeq - the step whose pre-images become the restored state.
   * @returns the pure plan.
   * @throws Error naming the valid range when `toSeq` is not in the journal.
   */
  rewindPlan(toSeq: number): RewindPlan {
    const index = this.#steps.findIndex(step => step.seq === toSeq)
    if (index === -1) {
      const last = this.#steps[this.#steps.length - 1]?.seq ?? 0
      throw new Error(`checkpoint: unknown step ${String(toSeq)}; journal holds 1..${String(last)}`)
    }
    const affected = this.#steps.slice(index)
    // Everything born INSIDE the dropped window is gone at the target state —
    // even when later steps carried a pre-image of it (that image is
    // post-creation noise and would resurrect a file that never existed before
    // `toSeq`). Deletion therefore wins outright for created paths.
    const created = new Set<string>()
    for (const step of affected) for (const path of step.created) created.add(path)
    // Earliest pre-image wins among the PRE-EXISTING paths: it is the one
    // closest to the state being restored.
    const restore = new Map<string, string>()
    for (const step of affected) {
      for (const capture of step.captured) {
        if (created.has(capture.path)) continue
        if (!restore.has(capture.path)) restore.set(capture.path, capture.blob)
      }
    }
    const remove = [...created].sort(compareText)
    return {
      toSeq,
      restore: [...restore.entries()]
        .map(([path, blob]) => ({ path, blob }))
        .sort((a, b) => compareText(a.path, b.path)),
      remove,
      dropSteps: affected.map(step => step.seq),
    }
  }
}

/**
 * The on-disk seam: `journal.jsonl` plus blob files in one directory. Blobs are
 * written before their journal line so a crash can only strand unnamed blobs.
 * @param dir - directory owning the journal and its blobs (created on demand).
 * @returns a journal/io pair ready for {@link CheckpointJournal}.
 */
export function fileCheckpointIo(dir: string): CheckpointIo {
  const journalPath = join(dir, 'journal.jsonl')
  return {
    appendLine: (line) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(journalPath, `${line}\n`, { encoding: 'utf8', flag: 'a' })
    },
    readLines: () => (existsSync(journalPath) ? readFileSync(journalPath, 'utf8').split('\n').filter(each => each.trim() !== '') : []),
    writeBlob: (name, content) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), content, 'utf8')
    },
    readBlob: (name) => {
      const path = join(dir, name)
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    },
  }
}

/**
 * Parse one journal line; malformed lines answer undefined rather than
 * throwing at replay (the caller names the line and stops).
 * @param line - one serialized {@link CheckpointStep}.
 * @returns the step, or undefined when the line is not one.
 */
function parseStepLine(line: string): CheckpointStep | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<CheckpointStep>
    if (typeof parsed.seq !== 'number' || typeof parsed.label !== 'string') return undefined
    if (!Array.isArray(parsed.captured) || !Array.isArray(parsed.created)) return undefined
    return {
      seq: parsed.seq,
      kind: typeof parsed.kind === 'string' ? parsed.kind : 'other',
      label: parsed.label,
      captured: parsed.captured as CheckpointCapture[],
      created: [...parsed.created as string[]],
    }
  } catch {
    return undefined
  }
}

/** Code-unit text order — the house deterministic tie-break (see the catalog). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'