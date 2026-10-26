/**
 * Managed block for user patch files: id-targeted `disabled` rows and
 * complete `insert` server rows live in a delimited region this writer owns,
 * so a toggle or an add-server submit never round-trips (and cannot corrupt)
 * the user's `!!js`-bearing YAML.
 *
 * Every managed row renders as ONE `JSON.stringify` line, so the block body
 * is simultaneously this module's exact grammar (strip `- `, `JSON.parse`)
 * and valid YAML for the loader's parser: a `- {…}` line is a flow-mapping
 * list item, JSON is a YAML subset, and `js-yaml` reads every escape JSON
 * can emit. Legacy text rows (`- id:` + `  disabled: true`) decode too and
 * upgrade to the uniform shape on the first write after this module lands.
 *
 * The loader's patch semantics do the rest: an `insert` item pushes its rows
 * into the entry list, a later id-targeted `{ id, disabled: true }` item
 * composes to "inserted but disabled", and `patchReload: live` recomposes the
 * tree when the file changes.
 *
 * @module @deepseek-ai/dsh-host-plugin-inventory/patch
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Marker lines delimiting the writer-owned region of the patch file. */
const BLOCK_BEGIN = '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---'
const BLOCK_END = '# --- end dsh-mcp-toggle ---'

/** One writer-owned patch row: an id-targeted disable of one loader entry. */
export interface DisableRow {
  /** Loader entry id, exactly as a patch list addresses it, e.g. `mcp-rea`. */
  readonly id: string
  /** The disable marker the managed block renders. */
  readonly disabled: true
}

/** One writer-owned patch row: a complete MCP server insert behind one id. */
export interface InsertRow {
  /** Loader entry id the server mounts under, e.g. `mcp-github`. */
  readonly id: string
  /** The bridge module the row mounts. */
  readonly name: string
  /** The resolved transport config the mcp-client plugin reads. */
  readonly config: Readonly<Record<string, unknown>>
}

/** Any writer-owned row: an id-keyed disable or a server-insert patch item. */
export type ManagedRow = DisableRow | { readonly insert: readonly InsertRow[] }

/**
 * Rewrites the managed block so `entryId` is disabled or re-enabled, leaving
 * every byte outside the block untouched. The file need not exist yet: an
 * absent file becomes a patch list holding only the managed block.
 *
 * A disable row whose id merely ends with `:` + the declared id
 * (`include:mcp-rea` — the Loader-tree path, never a patch address) is stale
 * poison from an older writer: a re-enable that removed only the exact id
 * would leave it keeping the server off forever. Every delete sweeps those
 * alongside the exact row; a disable that is already present is a no-op
 * write of identical content.
 *
 * @param patchPath - Absolute path of the profile `cordis.patch.yml`.
 * @param entryId - Loader entry id to toggle.
 * @param enabled - `false` appends the disable row, `true` removes it.
 * @returns The rows the managed block holds after the rewrite.
 */
export function toggleEntryDisabled(patchPath: string, entryId: string, enabled: boolean): readonly ManagedRow[] {
  const rows = readManagedRows(patchPath)
  // Rewriting through the sweep means a disable normalizes its own stale
  // spellings away: the exact id row lands last (patch semantics apply
  // inserts first), and any `:<entryId>` tail row the older writer left is
  // dropped in the same write.
  const kept = rows.filter(row => !isDisableOf(row, entryId))
  const removed = rows.length - kept.length
  const hasExact = rows.some(row => isDisableRow(row) && row.id === entryId)
  const alreadyExact = hasExact && removed === 1
  const next: readonly ManagedRow[] = enabled
    ? kept
    : alreadyExact
      ? rows
      : [...kept, { id: entryId, disabled: true as const }]
  // Identical content (including an absent block that nothing disabled) is a
  // no-op: no write, no empty block grown.
  if (sameRows(rows, next)) return next
  writeBlock(patchPath, next)
  return next
}

/**
 * Appends one complete server `insert` row to the managed block, leaving the
 * file's other bytes untouched. The caller owns validation; this writer owns
 * the file and the row shape.
 *
 * @param patchPath - Absolute path of the profile `cordis.patch.yml`.
 * @param row - The insert row to append.
 * @returns The rows the managed block holds after the rewrite.
 */
export function addServerRow(patchPath: string, row: InsertRow): readonly ManagedRow[] {
  const rows = readManagedRows(patchPath)
  const next: ManagedRow[] = [...rows, { insert: [row] }]
  writeBlock(patchPath, next)
  return next
}

/**
 * Ids of the rows the managed block currently holds, including insert rows.
 *
 * @param patchPath - Absolute path of the profile `cordis.patch.yml`.
 * @returns The declared ids, for cheap duplicate detection.
 */
export function readDeclaredIds(patchPath: string): Set<string> {
  return new Set(readManagedRows(patchPath)
    .map(row => isDisableRow(row) ? row.id : row.insert[0]?.id ?? '')
    .filter(id => id !== ''))
}

/**
 * Reads the rows the managed block currently holds.
 *
 * @param patchPath - Absolute path of the profile `cordis.patch.yml`.
 * @returns Rows for every entry the writer currently disables or inserts.
 */
export function readManagedRows(patchPath: string): readonly ManagedRow[] {
  const text = readPatchText(patchPath)
  if (text === '') return []
  const body = isolateBlock(text).body
  return body.length === 0 ? [] : decodeBlock(body)
}

function readPatchText(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch (error: unknown) {
    // An absent patch file is a valid empty composition; anything else is loud.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return ''
    throw error
  }
}

/** Splits the text into pre / block body / post regions around the managed markers. */
function isolateBlock(text: string): { pre: string; body: readonly string[]; post: string } {
  const lines = text.split('\n')
  // The writer owns exactly one live block: the LAST begin marker. A stale
  // unterminated marker left by a hand edit must not swallow the real block.
  const begin = lines.lastIndexOf(BLOCK_BEGIN)
  if (begin === -1) return { pre: text, body: [], post: '' }
  const end = lines.indexOf(BLOCK_END, begin)
  if (end === -1) return { pre: text, body: [], post: '' }
  return {
    pre: lines.slice(0, begin).join('\n'),
    body: lines.slice(begin + 1, end).filter(line => line.trim() !== ''),
    post: lines.slice(end + 1).join('\n'),
  }
}

/**
 * Decode the managed block into row data: one flow-JSON item per line, plus
 * the legacy text rows the older writer left. Anything else fails loud.
 */
function decodeBlock(body: readonly string[]): readonly ManagedRow[] {
  const rows: ManagedRow[] = []
  for (const line of body) {
    // The legacy text rows the older writer emitted (checked first: their
    // `- id:` prefix would otherwise walk into the flow-JSON decode and
    // crash on JSON.parse).
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) {
      rows.push(...legacyDisableRow(body, body.indexOf(line), idMatch[1] ?? ''))
      continue
    }
    if (/^\s*disabled:\s*true\s*$/.test(line)) continue
    if (line.startsWith('- ')) {
      rows.push(decodeManagedItem(line.slice(2)))
      continue
    }
    throw new Error(`dsh-mcp-toggle: unrecognized managed line: ${line}`)
  }
  return rows
}

/**
 * Decode one flow-JSON row item, or fail loud naming the shape that broke.
 */
function decodeManagedItem(json: string): ManagedRow {
  const decoded: unknown = JSON.parse(json)
  if (isRecord(decoded) && typeof decoded.id === 'string'
    && decoded.disabled === true
    && !('name' in decoded)) {
    return decoded as unknown as DisableRow
  }
  if (isRecord(decoded) && Array.isArray(decoded.insert)) {
    return { insert: decoded.insert.map(decodeInsertRow) }
  }
  throw new Error(`dsh-mcp-toggle: unrecognized managed row: - ${json}`)
}

/** Accept one decoded insert row or fail loud naming the shape that broke. */
function decodeInsertRow(row: unknown): InsertRow {
  if (isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'
    && isRecord(row.config)) {
    return { id: row.id, name: row.name, config: row.config }
  }
  throw new Error(`dsh-mcp-toggle: malformed managed insert row: ${JSON.stringify(row)}`)
}

/** The legacy text row's `disabled: true` companion, at most one line later. */
function legacyDisableRow(body: readonly string[], index: number, id: string): readonly ManagedRow[] {
  const companion = body[index + 1]
  if (companion === undefined || !/^\s*disabled:\s*true\s*$/.test(companion)) {
    throw new Error(`dsh-mcp-toggle: legacy id row at "${id}" has no disabled companion`)
  }
  return [{ id, disabled: true }]
}

/** Whether one row is the disable row for `entryId` — exact id or stale tree-path tail. */
function isDisableOf(row: ManagedRow, entryId: string): boolean {
  return isDisableRow(row)
    && (row.id === entryId
      // A tree-qualified id (`include:mcp-rea`) is the Loader's own path for
      // the row its patch list calls `mcp-rea`: stale poison an older writer
      // left, still naming this row, still keeping it off a re-enable.
      || row.id.endsWith(`:${entryId}`))
}

function isDisableRow(row: ManagedRow): row is DisableRow {
  return !('insert' in row)
}

/** Render the block contents: one flow-JSON row per line. */
function renderBlock(rows: readonly ManagedRow[]): readonly string[] {
  return rows.map(row => `- ${JSON.stringify(isDisableRow(row) ? { ...row, disabled: true as const } : row)}`)
}

/** Rewrite only the managed region; an absent block appends at the end. */
function writeBlock(patchPath: string, rows: readonly ManagedRow[]): void {
  const text = readPatchText(patchPath)
  const { pre, post } = isolateBlock(text)
  const block = [BLOCK_BEGIN, ...renderBlock(rows), BLOCK_END].join('\n')
  const head = pre.trim() === '' ? [] : [pre.replace(/\n+$/, '')]
  const tail = post.trim() === '' ? [] : [post.replace(/^\n+/, '')]
  const rebuilt = [...head, block, ...tail].join('\n\n') + '\n'
  atomicWrite(patchPath, rebuilt)
}

/** Writes the patch file through a same-directory rename so the reload watcher sees one replace. */
function atomicWrite(patchPath: string, content: string): void {
  mkdirSync(path.dirname(patchPath), { recursive: true })
  const temporary = path.join(path.dirname(patchPath), `.${path.basename(patchPath)}.dsh-mcp-toggle.tmp`)
  writeFileSync(temporary, content)
  renameSync(temporary, patchPath)
}

/** Whether every own member is a plain object (JSON.parse output shaping). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Value equality on decoded rows; identical content skips the file write. */
function sameRows(left: readonly ManagedRow[], right: readonly ManagedRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
