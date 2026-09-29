/**
 * Two-phase hashline application: every Update hunk is located and validated against
 * the current content first, and only then is the patched string produced, so a
 * rejection never leaves a partially applied result.
 * @module @deepseek-ai/dsh-tool-editor-evolved/patch
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { HashlinePatch } from './hashline.ts'
import { hashlineFileHash, hashlineStripPrefixes, normalizeHashlineText } from './hashline.ts'

/** The patched content plus how many Update hunks it applied. */
export interface HashlineApplyResult {
  /** Patched text in the same normalized (LF, BOM-free) form the hash was taken over. */
  content: string
  /** Number of hunks applied — one per `@@` block. */
  replacements: number
}

/** One located hunk: a closed `[start, end)` range of the old content and its replacement. */
interface LocatedHunk {
  start: number
  end: number
  text: string
}

/** 1-indexed line number containing `offset`. */
function lineNumberAt(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index++) {
    if (content.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * Start offset of a 1-indexed line. `line` may be one past the last line (append
 * position), anything further is an anchor the file cannot satisfy.
 * @param content - normalized file content.
 * @param line - 1-indexed anchor line.
 * @returns the offset at which that line begins.
 */
function lineStartOffset(content: string, line: number): number {
  const lines = content.split('\n')
  const count = content.endsWith('\n') ? lines.length - 1 : lines.length
  if (line < 1 || line > count + 1) {
    throw new FsError(
      `The hashline hunk anchors at line ${line}, but the file has ${count} lines. Re-read the file and try again.`,
      'FS_EDIT_NOT_FOUND',
    )
  }
  if (line === count + 1) return content.length
  let offset = 0
  for (let index = 1; index < line; index++) {
    offset = content.indexOf('\n', offset) + 1
  }
  return offset
}

/**
 * Every line-aligned offset where `needle` occurs. Alignment matters: a block that would
 * match in the middle of a line is not the hunk's context.
 * @param content - normalized file content.
 * @param needle - the hunk's old block, lines joined with LF.
 * @returns matching offsets in ascending order.
 */
function matchLineOffsets(content: string, needle: string): number[] {
  const offsets: number[] = []
  let from = 0
  while (from <= content.length - needle.length) {
    const at = content.indexOf(needle, from)
    if (at < 0) break
    const after = at + needle.length
    const lineAligned = (at === 0 || content.charCodeAt(at - 1) === 10)
      && (after === content.length || content.charCodeAt(after) === 10)
    if (lineAligned) offsets.push(at)
    from = at + 1
  }
  return offsets
}

/**
 * Apply a parsed hashline patch to one file's content.
 *
 * Phase one validates everything: the header hash against the content, each hunk's old
 * block (unique match, or the match the numbered evidence picks out of several), and
 * that no two located hunks overlap. Phase two splices all hunks in one pass over an
 * in-memory string, so callers only ever see "everything valid" or a thrown error.
 * @param content - the file content that was read for this patch.
 * @param patch - the parsed patch, whose header hash must match `content`.
 * @returns the patched content and the number of applied hunks.
 * @throws FsError `FS_STALE_VERSION` when the header hash does not match the content.
 * @throws FsError `FS_EDIT_NOT_FOUND` when no hunk context matches, or an insert-only
 *   hunk anchors outside the file.
 * @throws FsError `FS_AMBIGUOUS_EDIT` when a hunk matches several times and its line
 *   evidence cannot pick one.
 * @throws Error when located hunks overlap.
 */
export function applyHashlinePatch(content: string, patch: HashlinePatch): HashlineApplyResult {
  const before = normalizeHashlineText(content)
  const actualHash = hashlineFileHash(before)
  if (actualHash !== patch.fileHash) {
    throw new FsError(
      `The file ${patch.path} changed since it was read (hashline header carries ${patch.fileHash}, the file now hashes to ${actualHash}). Re-read the file and try again.`,
      'FS_STALE_VERSION',
    )
  }

  const located: LocatedHunk[] = []
  for (const hunk of patch.hunks) {
    // Replacement = kept context + inserts; the deleted lines leave the file.
    const newText = hunk.lines
      .filter(line => line.kind !== 'delete')
      .map(line => line.kind === 'insert' ? hashlineStripPrefixes(line.text) : line.text)
      .join('\n')
    const block: string[] = []
    for (const line of hunk.lines) {
      if (line.kind !== 'insert') block.push(line.text)
    }

    if (block.length === 0) {
      // Insert-only hunk: the declared line is the anchor instead of a text match.
      const anchor = lineStartOffset(before, hunk.startLine)
      let text = newText
      if (text.length > 0 && anchor < before.length && !text.endsWith('\n')) text += '\n'
      if (text.length > 0 && anchor === before.length && before.length > 0 && !before.endsWith('\n')) text = `\n${text}`
      located.push({ start: anchor, end: anchor, text })
      continue
    }

    const needle = block.join('\n')
    const offsets = matchLineOffsets(before, needle)
    if (offsets.length === 0) {
      throw new FsError(
        `The hashline hunk at line ${hunk.startLine} does not match the current content of ${patch.path}. Re-read the file and try again.`,
        'FS_EDIT_NOT_FOUND',
      )
    }
    // Several occurrences: the numbered evidence may still pin down the intended one.
    const aligned = offsets.length === 1
      ? offsets
      : offsets.filter(offset => lineNumberAt(before, offset) === hunk.startLine)
    if (aligned.length !== 1) {
      throw new FsError(
        `No replacement was performed. Multiple occurrences of the hashline hunk in lines [${offsets.map(offset => lineNumberAt(before, offset)).join(', ')}]. Please ensure it is unique`,
        'FS_AMBIGUOUS_EDIT',
      )
    }
    located.push({ start: aligned[0]!, end: aligned[0]! + needle.length, text: newText })
  }

  located.sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < located.length; index++) {
    const previous = located[index - 1]!
    const current = located[index]!
    if (current.start < previous.end) {
      throw new Error(
        `hashline patch: hunks overlap at line ${lineNumberAt(before, current.start)} of ${patch.path}`,
      )
    }
  }

  let patched = before
  for (let index = located.length - 1; index >= 0; index--) {
    const hunk = located[index]!
    patched = patched.slice(0, hunk.start) + hunk.text + patched.slice(hunk.end)
  }
  return { content: patched, replacements: located.length }
}
