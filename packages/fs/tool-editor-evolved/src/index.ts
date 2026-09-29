/**
 * Public surface of the hashline patch core: format primitives, parsing, two-phase
 * application, the compare-and-swap write runner, and post-write byte verification.
 * @module @deepseek-ai/dsh-tool-editor-evolved
 */

export {
  hashlineFileHash,
  hashlineFormatHeader,
  hashlineFormatNumberedLines,
  hashlineStripPrefixes,
  isHashlinePatch,
  normalizeHashlineText,
  parseHashlinePatch,
} from './hashline.ts'
export type { HashlineHunk, HashlineLine, HashlinePatch } from './hashline.ts'

export { applyHashlinePatch } from './patch.ts'
export type { HashlineApplyResult } from './patch.ts'

export { runHashlineEdit } from './run.ts'
export type { HashlineEditIO, HashlineEditResult } from './run.ts'

export { verifyPatchedBytes } from './verify.ts'
