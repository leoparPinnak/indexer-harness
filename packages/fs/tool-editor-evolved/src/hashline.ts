/**
 * Hashline patch syntax: the file header, numbered-line evidence, display-prefix
 * stripping, and the parser that turns a patch string into a {@link HashlinePatch}.
 * @module @deepseek-ai/dsh-tool-editor-evolved/hashline
 */

import { createHash } from 'node:crypto'

/** One body line of an Update hunk: context, removal (both numbered), or insertion. */
export type HashlineLine =
  | { kind: 'context'; line: number; text: string }
  | { kind: 'delete'; line: number; text: string }
  | { kind: 'insert'; text: string }

/** An `@@ <line>` Update hunk with its body, in source order. */
export interface HashlineHunk {
  /** 1-indexed line of the current file where the hunk's old block sits. */
  startLine: number
  lines: HashlineLine[]
}

/** A parsed hashline patch: one header plus at least one Update hunk. */
export interface HashlinePatch {
  path: string
  fileHash: string
  hunks: HashlineHunk[]
}

/** `<path>:<16 hex>` header line; the greedy path keeps drive-colon paths intact. */
const HEADER_PATTERN = /^(.+):([0-9a-f]{16})$/i
/** `@@ <line>` hunk opener. */
const HUNK_PATTERN = /^@@ (\d+)$/
/** Context/removal body line: marker, optional `#`, line number, `|`, optional single space. */
const NUMBERED_PATTERN = /^([- ])#?(\d+)\| ?(.*)$/
/** Insertion body line. */
const INSERT_PATTERN = /^\+(.*)$/
/** Display prefix a numbered read view leaves behind: `12| `, `#12: `, `12:`. */
const DISPLAY_PREFIX_PATTERN = /^ *#?\d+[|:] ?/

/**
 * Fold text to the canonical form every hashline operation sees: drop a leading
 * BOM and fold CRLF/CR to LF. Hashing, matching, and the patched result all use
 * this form, so a CRLF file and its LF twin carry the same header hash.
 * @param text - any raw file content or patch source.
 * @returns LF-normalized, BOM-free text.
 */
export function normalizeHashlineText(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return body.replace(/\r\n?/g, '\n')
}

/**
 * The hash a patch header carries: SHA-256 of the normalized content, first 16 hex digits.
 * @param content - file content in any line-ending style.
 * @returns a 16-character lowercase hex digest.
 */
export function hashlineFileHash(content: string): string {
  return createHash('sha256').update(normalizeHashlineText(content), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Format the required first line of a patch.
 * @param path - the target path exactly as the patch should name it.
 * @param fileHash - a digest produced by {@link hashlineFileHash}.
 * @returns `<path>:<fileHash>`.
 */
export function hashlineFormatHeader(path: string, fileHash: string): string {
  return `${path}:${fileHash}`
}

/**
 * Format numbered context lines: the display form a patch body uses and a read view shows.
 * @param startLine - 1-indexed line number of `lines[0]`.
 * @param lines - file text, one entry per line; an empty line yields `<n>| `.
 * @returns body lines of the shape `<n>| <text>` with the leading context marker.
 */
export function hashlineFormatNumberedLines(startLine: number, lines: readonly string[]): string[] {
  return lines.map((line, index) => ` ${startLine + index}| ${line}`)
}

/**
 * Remove display prefixes (`12| `, `#12: `) from every line of model-supplied insert text.
 * Applied once per line and only to inserted lines: numbered context and removal lines already
 * lose their prefix during parsing, so stripping twice would eat real file text.
 * @param text - text destined for the file.
 * @returns the text with one leading display prefix per line removed.
 */
export function hashlineStripPrefixes(text: string): string {
  return normalizeHashlineText(text)
    .split('\n')
    .map(line => line.replace(DISPLAY_PREFIX_PATTERN, ''))
    .join('\n')
}

/**
 * Whether an input should be routed to the hashline path instead of literal string replacement.
 * Requires both a well-formed header and at least one `@@ <line>` hunk, so ordinary
 * `old_string` values that merely end in `:0123456789abcdef` still take the literal path.
 * @param source - candidate patch text.
 * @returns true only when the input parses as a hashline patch header plus hunk opener.
 */
export function isHashlinePatch(source: string): boolean {
  const lines = normalizeHashlineText(source).split('\n')
  const header = lines[0] ?? ''
  if (!HEADER_PATTERN.test(header)) return false
  return lines.some(line => HUNK_PATTERN.test(line))
}

/**
 * Parse a hashline patch. All shape violations raise `Error` here, before any
 * filesystem access: a malformed header, a body line without a marker or without
 * `<n>|` evidence, a body line before the first `@@`, no hunks at all, or a hunk
 * that carries no `-`/`+` line.
 * @param source - the raw patch text; CRLF and a trailing newline are tolerated.
 * @returns the structured patch.
 */
export function parseHashlinePatch(source: string): HashlinePatch {
  const lines = normalizeHashlineText(source).split('\n')
  if (lines.at(-1) === '') lines.pop()
  const header = lines.shift() ?? ''
  const headerMatch = HEADER_PATTERN.exec(header)
  if (headerMatch === null) {
    throw new Error(
      `hashline patch: the first line must be the file header \`<path>:<16 hex hash>\`, got ${JSON.stringify(header)}`,
    )
  }
  const hunks: HashlineHunk[] = []
  for (const line of lines) {
    const hunkMatch = HUNK_PATTERN.exec(line)
    if (hunkMatch !== null) {
      hunks.push({ startLine: Number(hunkMatch[1]), lines: [] })
      continue
    }
    const current = hunks.at(-1)
    if (current === undefined) {
      throw new Error(`hashline patch: ${JSON.stringify(line)} appears before any \`@@ <line>\` hunk`)
    }
    const numbered = NUMBERED_PATTERN.exec(line)
    if (numbered !== null) {
      current.lines.push({
        kind: numbered[1] === '-' ? 'delete' : 'context',
        line: Number(numbered[2]),
        text: numbered[3] ?? '',
      })
      continue
    }
    const insert = INSERT_PATTERN.exec(line)
    if (insert !== null) {
      current.lines.push({ kind: 'insert', text: insert[1] ?? '' })
      continue
    }
    throw new Error(
      `hashline patch: ${JSON.stringify(line)} must be a \`@@ <line>\` opener, a \` <n>| <text>\`/\`-<n>| <text>\` evidence line, or a \`+<text>\` insert line`,
    )
  }
  if (hunks.length === 0) {
    throw new Error('hashline patch: the patch carries no `@@ <line>` hunk')
  }
  for (const hunk of hunks) {
    const changed = hunk.lines.some(line => line.kind !== 'context')
    if (!changed) {
      throw new Error(`hashline patch: hunk at line ${hunk.startLine} has no -/+ lines`)
    }
  }
  const match = HEADER_PATTERN.exec(header)
  return { path: match?.[1] ?? header, fileHash: (match?.[2] ?? '').toLowerCase(), hunks }
}
