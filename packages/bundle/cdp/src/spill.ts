/**
 * @deepseek-ai/dsh-cdp — plan16-spill: the overflow escape hatch (cursor's
 * "large responses are saved to files" muadili). When one tool's payload blows
 * past {@link SPILL_THRESHOLD_CHARS}, the FULL content is written to a spill
 * file under the temp dir and the answer keeps a head+tail envelope plus a
 * `spill` receipt pointing at the file — so a big page costs a paragraph of
 * context instead of the whole payload, and nothing is lost: the model reads
 * focused sections with `cdp_files`. Pure clip/name/envelope maths are
 * separated from the one writer, which takes injectable IO for tests.
 * @module @deepseek-ai/dsh-cdp/spill
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Payload budget; over this the content spills and the field keeps an envelope. */
export const SPILL_THRESHOLD_CHARS = 12_000
/** Characters of the head kept in the envelope. */
export const SPILL_HEAD_CHARS = 800
/** Characters of the tail kept in the envelope (the bookend). */
export const SPILL_TAIL_CHARS = 200
/** Rows kept at the front of a spilled row set. */
export const SPILL_ROWS_HEAD = 3
/** Rows kept at the tail of a spilled row set. */
export const SPILL_ROWS_TAIL = 1

/** The receipt the answer carries whenever a payload spilled. */
export interface SpillReceipt {
  /** Absolute path of the spill file. */
  readonly path: string
  /** Total characters written (the FULL payload). */
  readonly chars: number
  /** Row tools only: the total rows before head+tail clipping. */
  readonly rows?: number
}

/** Injection seam of the one writer. */
export type SpillWriter = (fileName: string, content: string) => { path: string; chars: number }

/**
 * The spill directory: `tmpdir()/dsh-cdp-spill`. One bucket per machine, named
 * files inside it — the receipt's path is the addressing, no index is kept.
 * @returns the absolute spill directory.
 */
export function spillDir(): string {
  return join(tmpdir(), 'dsh-cdp-spill')
}

/**
 * The spill file name: `spill-<stamp>-<label>.<ext>`. Pure — the writer passes
 * the clock in, so this naming is testable and deterministic.
 * @param stamp - millisecond stamp the writer read.
 * @param label - tool label (`cdp_text`, `cdp_exec`, `cdp_extract`).
 * @param ext - `txt` for text payloads, `json` for row sets.
 * @returns the file name (no directory).
 */
export function spillFileName(stamp: number, label: string, ext: 'txt' | 'json'): string {
  const safe = label.replace(/[^a-z0-9_-]/gi, '-')
  return `spill-${String(stamp)}-${safe}.${ext}`
}

/**
 * The head+tail envelope that replaces a spilled string payload. The bookends
 * keep orientation ("what did this start/end like?") while the receipt points
 * at the whole content.
 * @param content - the FULL payload (already written to disk).
 * @param path - the spill file path.
 * @returns the envelope text.
 */
export function buildSpillEnvelope(content: string, path: string): string {
  const head = content.slice(0, SPILL_HEAD_CHARS)
  const tail = content.slice(Math.max(0, content.length - SPILL_TAIL_CHARS))
  return `[spilled ${String(content.length)} chars → ${path}; full content on disk — read focused sections with cdp_files]\n`
    + head
    + (content.length > SPILL_HEAD_CHARS + SPILL_TAIL_CHARS ? '\n…\n' : '')
    + (content.length > SPILL_HEAD_CHARS + SPILL_TAIL_CHARS ? tail : '')
}

/**
 * The one render line for a `spill` receipt; `''` when nothing spilled.
 * @param receipt - the receipt carried on the answer (optional).
 * @returns the note line, or the empty string.
 */
export function spillNote(receipt: SpillReceipt | undefined): string {
  if (receipt === undefined) return ''
  const rows = receipt.rows !== undefined ? `, ${String(receipt.rows)} rows` : ''
  return `SPILLED: ${receipt.path} (${String(receipt.chars)} chars${rows}) — full content on disk; read focused sections with cdp_files.`
}

/**
 * The one writer: mkdirs the spill bucket and writes the full payload.
 * @param fileName - name from {@link spillFileName}.
 * @param content - the full payload.
 * @returns the receipt half (path + chars).
 */
export const writeSpillFile: SpillWriter = (fileName, content) => {
  const dir = spillDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName)
  writeFileSync(path, content, 'utf8')
  return { path, chars: content.length }
}

/**
 * Spill one STRING field of a tool result: over the budget the full text goes
 * to disk, the field keeps the envelope, and `spill` rides along. Under the
 * budget the value comes back UNTOUCHED — no receipt, no field rewrite.
 * @param label - tool label for the file name.
 * @param field - the string field to police.
 * @param value - the tool result.
 * @param write - writer seam (tests inject).
 * @returns the (possibly augmented) result.
 */
export function spillTextField<T extends object>(
  label: string,
  field: string,
  value: T,
  write: SpillWriter = writeSpillFile,
): T {
  const raw = (value as Record<string, unknown>)[field]
  if (typeof raw !== 'string' || raw.length <= SPILL_THRESHOLD_CHARS) return value
  const saved = write(spillFileName(Date.now(), label, 'txt'), raw)
  return { ...value, [field]: buildSpillEnvelope(raw, saved.path), spill: { path: saved.path, chars: saved.chars } } as T
}

/**
 * Spill one ARRAY field of a tool result: the FULL set goes to disk as JSON,
 * the field keeps the first {@link SPILL_ROWS_HEAD} and last
 * {@link SPILL_ROWS_TAIL} rows as orientation, and `spill` reports the total.
 * @param label - tool label for the file name.
 * @param field - the array field to police.
 * @param value - the tool result.
 * @param write - writer seam (tests inject).
 * @returns the (possibly augmented) result.
 */
export function spillRowsField<T extends object>(
  label: string,
  field: string,
  value: T,
  write: SpillWriter = writeSpillFile,
): T {
  const raw = (value as Record<string, unknown>)[field]
  if (!Array.isArray(raw) || raw.length <= SPILL_ROWS_HEAD + SPILL_ROWS_TAIL) return value
  const json = JSON.stringify(raw, null, 2)
  if (json.length <= SPILL_THRESHOLD_CHARS) return value
  const saved = write(spillFileName(Date.now(), label, 'json'), json)
  const rows = [...raw.slice(0, SPILL_ROWS_HEAD), ...raw.slice(raw.length - SPILL_ROWS_TAIL)]
  return {
    ...value,
    [field]: rows,
    spill: { path: saved.path, chars: saved.chars, rows: raw.length },
  } as T
}