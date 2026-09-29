/**
 * The stateful hashline entry point: parse, hash-check, apply, compare-and-swap write,
 * then read the file back and verify it byte for byte.
 * @module @deepseek-ai/dsh-tool-editor-evolved/run
 */

import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { parseHashlinePatch } from './hashline.ts'
import { applyHashlinePatch } from './patch.ts'
import { verifyPatchedBytes } from './verify.ts'

/**
 * The filesystem seam the caller already owns. Keeping it an interface means this package
 * stays pure TypeScript — no `ctx`, no provider import — while the CAS basis and the
 * guarded write still come from the harness' existing `replaceIfVersion` policy.
 */
export interface HashlineEditIO {
  /** Path shown to the model in errors. */
  displayPath: string
  /** CAS basis for the write: the observation policy's `replaceIfVersion` intent. */
  casBasis: () => Promise<FsWriteIntent | undefined>
  /** Current file content (the harness `readText`). */
  read: () => Promise<string>
  /** Guarded write; implementations should record the observed version they observe. */
  write: (content: string, expected: FsWriteIntent | undefined) => Promise<void>
}

/** What one hashline edit did, for the model-facing result and the diff presentation. */
export interface HashlineEditResult {
  path: string
  before: string
  after: string
  replacements: number
}

/**
 * Run one hashline edit end to end.
 *
 * Order is deliberate: the patch string is parsed first, so malformed input fails before
 * any filesystem access (and before the read-before-edit requirement can fire for a call
 * that would have been refused anyway); the CAS basis is taken before the read so a
 * concurrent writer between read and write is rejected rather than silently preserved;
 * the read-back verification closes the loop by checking what actually reached the disk.
 * @param io - the caller's filesystem seam.
 * @param source - the raw hashline patch text.
 * @returns the before/after content and the applied hunk count.
 */
export async function runHashlineEdit(io: HashlineEditIO, source: string): Promise<HashlineEditResult> {
  const patch = parseHashlinePatch(source)
  const expected = await io.casBasis()
  const before = await io.read()
  const { content: after, replacements } = applyHashlinePatch(before, patch)
  // Re-surface CRLF when the source used it: the patch pipeline normalizes to LF, so a
  // CRLF source must land on disk as CRLF (matching fs-local's literal-edit arm).
  const normalized = before.includes('\r\n') && !after.includes('\r\n') ? after.replace(/\n/gu, '\r\n') : after
  await io.write(normalized, expected)
  const persisted = await io.read()
  verifyPatchedBytes(io.displayPath, normalized, persisted)
  return { path: io.displayPath, before, after: normalized, replacements }
}
