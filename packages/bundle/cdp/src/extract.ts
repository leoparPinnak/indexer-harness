/**
 * plan08 — the pure projection engine behind `cdp_extract` (plan §4.3/§5.7).
 * A JSON projection spec (`{"kind":"page|list|field", …}`) is parsed and
 * validated HERE: unknown kinds, unknown field sources, and broken regexes
 * become in-band `ok:false + error` answers before any protocol call runs.
 *
 * The engine never talks to the protocol. Candidate selection reuses the
 * find matcher over one fresh document index; field projection consumes the
 * per-candidate fresh evidence (`RefEvidence`, including requested extra
 * attributes) the service resolves at action time. Honesty is structural:
 * `data` is ALWAYS an array (empty when nothing matched — never `undefined`),
 * `complete` is false whenever `missing`, `truncatedFields`, or a limit cut
 * the answer, and every cut has a line in `missing`/`warnings`.
 *
 * @module @deepseek-ai/dsh-cdp/extract
 */
import { displayNormalize, matchFindCandidates, type FindMatch } from './find.ts'
import type { RefEvidence, RefIndexEntry } from './refs.ts'

/** plan08: default projection cap; specs may raise it up to the hard cap. */
export const EXTRACT_DEFAULT_LIMIT = 50

/** plan08: hard projection cap — a spec asking for more is clamped + warned. */
export const EXTRACT_MAX_LIMIT = 200

/** plan08: any projected name/value longer than this is cut + reported. */
export const EXTRACT_TEXT_LIMIT = 160

/** The three projection shapes a spec may take (plan §4.3). */
export type ExtractKind = 'page' | 'list' | 'field'

/** Page-level fields `kind:"page"` may request. */
export const PAGE_FIELDS = ['title', 'url', 'h1', 'lang', 'description', 'openDialog'] as const

/** Node-level sources `kind:"list"/"field"` may project (plus `attr:<name>`). */
export const FIELD_SOURCES = ['name', 'role', 'value', 'text', 'href', 'checked', 'box', 'count'] as const

/** Result of {@link parseExtractSpec}: either a parsed spec or an error line. */
export type ParsedExtractSpec =
  | { readonly ok: true, readonly spec: ExtractSpec }
  | { readonly ok: false, readonly error: string }

/** `spec.from` — the candidate set (plan §4.3). */
export interface ExtractFrom {
  /** Exact woven role match. */
  readonly role?: string
  /** Only candidates under an ancestor with this role (ref-path parse). */
  readonly withinRole?: string
  /** CSS selector (node-id set resolved by the service). */
  readonly selector?: string
  /** Exact accessible-name match. */
  readonly ariaLabel?: string
}

/** `spec.where` — the host-side filter applied before projection. */
export interface ExtractWhere {
  /** RegExp source tested against display-normalized names. */
  readonly nameMatches?: string
  /** Keep only candidates whose FRESH measurement is visible. */
  readonly visibleOnly?: boolean
}

/** One parsed projection spec. */
export interface ExtractSpec {
  /** Projection shape. */
  readonly kind: ExtractKind
  /** Candidate set (ignored for `kind:"page"`). */
  readonly from?: ExtractFrom
  /** Pre-projection filter (ignored for `kind:"page"`). */
  readonly where?: ExtractWhere
  /**
   * Field projection: object map (row key → source) or array (key = source)
   * for `list`; field-name array for `page`. Absent → a sensible default.
   */
  readonly fields?: Readonly<Record<string, string>> | readonly string[]
  /** The single source for `kind:"field"`. */
  readonly field?: string
  /** Row cap; clamped into 1..{@link EXTRACT_MAX_LIMIT}. */
  readonly limit: number
}

/**
 * True when `value` is a whitelisted page-level field.
 * @param value - candidate field name from a parsed spec.
 * @returns type guard narrowing to a member of {@link PAGE_FIELDS}.
 */
export function isPageField(value: string): value is typeof PAGE_FIELDS[number] {
  return (PAGE_FIELDS as readonly string[]).includes(value)
}

/**
 * True when `value` is a whitelisted node-level source or `attr:<name>`.
 * @param value - candidate source name from a field map.
 * @returns true for a {@link FIELD_SOURCES} member or a well-formed `attr:` reference.
 */
export function isFieldSource(value: string): boolean {
  return (FIELD_SOURCES as readonly string[]).includes(value) || /^attr:[A-Za-z_][\w-]*$/.test(value)
}

/** @param value - candidate limit. @returns it clamped into the legal range. */
function clampLimit(value: unknown): number {
  const fallback = EXTRACT_DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), EXTRACT_MAX_LIMIT)
}

/**
 * Parse and validate one spec string. Everything that can be rejected
 * without a browser is rejected here (plan §4.3: bozuk spec → `ok:false` +
 * `error`; boş output yasak).
 * @param raw - the `spec` parameter exactly as the caller sent it.
 * @returns the parsed spec, or the error line for the tool envelope.
 */
export function parseExtractSpec(raw: string): ParsedExtractSpec {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'cdp_extract: spec is required (a JSON object like {"kind":"page"})' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    return { ok: false, error: `cdp_extract: spec is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'cdp_extract: spec must be a JSON object like {"kind":"list",…}' }
  }
  const spec = parsed as Record<string, unknown>
  const kind = spec.kind
  if (kind !== 'page' && kind !== 'list' && kind !== 'field') {
    return { ok: false, error: `cdp_extract: unknown kind '${String(kind)}' (expected page|list|field)` }
  }

  const limit = clampLimit(spec.limit)

  if (kind === 'page') {
    const fields = spec.fields === undefined ? [...PAGE_FIELDS] : spec.fields
    if (!Array.isArray(fields) || fields.length === 0 || fields.some(f => typeof f !== 'string')) {
      return { ok: false, error: 'cdp_extract: kind "page" takes fields as a non-empty array of names' }
    }
    for (const field of fields as string[]) {
      if (!isPageField(field)) {
        return { ok: false, error: `cdp_extract: unknown page field '${field}' (expected ${PAGE_FIELDS.join('|')})` }
      }
    }
    return { ok: true, spec: { kind, fields: fields as string[], limit } }
  }

  if (kind === 'field') {
    const field = spec.field
    if (typeof field !== 'string' || !isFieldSource(field)) {
      return { ok: false, error: `cdp_extract: kind "field" requires a valid field source (got ${JSON.stringify(field)})` }
    }
    const from = parseFrom(spec.from)
    if (!from.ok) return from
    const where = parseWhere(spec.where)
    if (!where.ok) return where
    return {
      ok: true,
      spec: {
        kind, field, limit,
        ...(from.from !== undefined ? { from: from.from } : {}),
        ...(where.where !== undefined ? { where: where.where } : {}),
      },
    }
  }

  // kind: list — fields as a map or an array.
  let fields: Readonly<Record<string, string>> | readonly string[] | undefined
  if (spec.fields !== undefined && Array.isArray(spec.fields)) {
    if (spec.fields.length === 0 || spec.fields.some(f => typeof f !== 'string')) {
      return { ok: false, error: 'cdp_extract: fields array must be a non-empty list of source names' }
    }
    fields = spec.fields as string[]
    for (const source of fields) {
      if (!isFieldSource(source)) {
        return { ok: false, error: `cdp_extract: unknown field source '${source}'` }
      }
    }
  } else if (spec.fields !== undefined && typeof spec.fields === 'object' && spec.fields !== null) {
    const map: Record<string, string> = {}
    for (const [key, source] of Object.entries(spec.fields as Record<string, unknown>)) {
      if (typeof source !== 'string' || !isFieldSource(source)) {
        return { ok: false, error: `cdp_extract: field '${key}' has unknown source '${String(source)}'` }
      }
      map[key] = source
    }
    if (Object.keys(map).length === 0) {
      return { ok: false, error: 'cdp_extract: fields map must not be empty' }
    }
    fields = map
  } else {
    fields = { name: 'name', role: 'role', value: 'value' }
  }
  const from = parseFrom(spec.from)
  if (!from.ok) return from
  const where = parseWhere(spec.where)
  if (!where.ok) return where
  return {
    ok: true,
    spec: {
      kind, fields, limit,
      ...(from.from !== undefined ? { from: from.from } : {}),
      ...(where.where !== undefined ? { where: where.where } : {}),
    },
  }
}

/** @param raw - `spec.from`. @returns ok with `from`, or an error line. */
function parseFrom(raw: unknown): { ok: true, from?: ExtractFrom } | { ok: false, error: string } {
  if (raw === undefined) return { ok: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'cdp_extract: from must be an object like {"role":"link"}' }
  }
  const from = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of ['role', 'withinRole', 'selector', 'ariaLabel']) {
    const value = from[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value === '') {
        return { ok: false, error: `cdp_extract: from.${key} must be a non-empty string` }
      }
      out[key] = value
    }
  }
  for (const key of Object.keys(from)) {
    if (!['role', 'withinRole', 'selector', 'ariaLabel'].includes(key)) {
      return { ok: false, error: `cdp_extract: unknown from.${key}` }
    }
  }
  return Object.keys(out).length > 0
    ? { ok: true, from: out as ExtractFrom }
    : { ok: true }
}

/** @param raw - `spec.where`. @returns ok with `where`, or an error line. */
function parseWhere(raw: unknown): { ok: true, where?: ExtractWhere } | { ok: false, error: string } {
  if (raw === undefined) return { ok: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'cdp_extract: where must be an object like {"visibleOnly":true}' }
  }
  const where = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (where.nameMatches !== undefined) {
    if (typeof where.nameMatches !== 'string' || where.nameMatches === '') {
      return { ok: false, error: 'cdp_extract: where.nameMatches must be a non-empty regex source' }
    }
    try {
      new RegExp(displayNormalize(where.nameMatches))
    } catch (error) {
      return { ok: false, error: `cdp_extract: where.nameMatches is not a valid regex (${error instanceof Error ? error.message : String(error)})` }
    }
    out.nameMatches = where.nameMatches
  }
  if (where.visibleOnly !== undefined) {
    if (typeof where.visibleOnly !== 'boolean') {
      return { ok: false, error: 'cdp_extract: where.visibleOnly must be a boolean' }
    }
    out.visibleOnly = where.visibleOnly
  }
  for (const key of Object.keys(where)) {
    if (!['nameMatches', 'visibleOnly'].includes(key)) {
      return { ok: false, error: `cdp_extract: unknown where.${key}` }
    }
  }
  return Object.keys(out).length > 0
    ? { ok: true, where: out as ExtractWhere }
    : { ok: true }
}

/**
 * `parseExtractSpec` returns error-line branches; merge them back for `ok:false`.
 * @param parsed - the `ok:false` branch of {@link parseExtractSpec}.
 * @returns the error line carried by that branch.
 */
export function extractSpecError(parsed: ParsedExtractSpec & { ok: false }): string {
  return parsed.error
}

/** One candidate with its optional fresh measurement. */
export interface ExtractCandidate {
  /** Woven match (ref/role/name/nodeId). */
  readonly match: FindMatch
  /** Fresh evidence when the service resolved it; absent on resolution failure. */
  readonly evidence?: RefEvidence
  /** Fresh-evidence failure line when resolution failed. */
  readonly resolveError?: string
}

/** Everything the pure projection needs about the document. */
export interface ExtractSources {
  /** Fresh document index (candidates + woven role/name). */
  readonly index: ReadonlyMap<string, RefIndexEntry>
  /** Resolved candidates in document order — at most `spec.limit` of the matches. */
  readonly matches: readonly FindMatch[]
  /** ref → fresh resolution outcome (service-filled; absent rows report missing). */
  readonly resolved?: ReadonlyMap<string, ResolvedCandidate> | undefined
  /** Host-matched candidates BEFORE the limit (drives `limitApplied` + `count`). */
  readonly totalMatched: number
  /** Total nodes in the fresh document (for `source.totalNodes`). */
  readonly totalNodes: number
  /** Candidates resolved fresh (for `source.nodes`). */
  readonly resolvedNodes: number
}

/** One candidate's fresh outcome: evidence when resolved, else the failure line. */
export interface ResolvedCandidate {
  /** Fresh evidence. */
  readonly evidence?: RefEvidence
  /** Failure line when the node could not be resolved fresh. */
  readonly resolveError?: string
}

/** The mandatory honesty envelope fields (plan §4.3). */
export interface ExtractHonesty {
  /** True only when nothing was cut, limited, or unresolved. */
  readonly complete: boolean
  /** Human lines for every field the sources could not answer. */
  readonly missing: string[]
  /** Row keys cut at {@link EXTRACT_TEXT_LIMIT}. */
  readonly truncatedFields: string[]
  /** Extra caution lines (`limit applied`, `visibleOnly removed N`, …). */
  readonly warnings: string[]
  /** Where the data came from. */
  readonly source: { readonly nodes: number, readonly totalNodes: number }
}

/** Default row-key → source map when a list spec omits `fields`. */
const DEFAULT_LIST_FIELDS: Readonly<Record<string, string>> = { name: 'name', role: 'role', value: 'value' }

/**
 * plan08: one page-side probe for every `kind:"page"` field (JSON string).
 * Evaluated once via `session.evaluate`; a failed/truncated evaluation
 * degrades into `missing`/`warnings`, never into invented values.
 *
 * plan09-fix: the probe used to collapse "the backing node does not exist" into
 * `''` (e.g. `(document.querySelector('h1') || { innerText: '' }).innerText || ''`),
 * so a page with no `<h1>`, no `meta[description]`, or no `lang` attribute
 * answered `""` — and the row was reported **complete**. That is a silent hole:
 * a caller reading the row cannot tell "present but empty" from "never there",
 * and `complete:true` says the collection succeeded. Each optional field now
 * answers `null` when its backing node is ABSENT, and the plain string when the
 * node EXISTS (an existing-but-empty `<h1></h1>` is a value, not a hole).
 * `projectExtract` already turns a `null` page field into a `missing` line and
 * `complete:false`, so the fix only has to stop lying here.
 */
export const PAGE_FIELDS_EXPRESSION =
  'JSON.stringify({'
  + ' title: document.querySelector("title") ? document.title : null,'
  + ' url: String(location.href),'
  + " h1: (function(){var h = document.querySelector('h1'); return h ? (h.innerText || '') : null;})(),"
  + " lang: document.documentElement.hasAttribute('lang') ? document.documentElement.lang : null,"
  + " description: (function(){var m = document.querySelector('meta[name=\"description\"]'); return m ? (m.getAttribute('content') ?? '') : null;})(),"
  + " openDialog: !!document.querySelector('dialog[open],[role=\"dialog\"]')"
  + '})'

/**
 * Resolve the row-key → source pairs a parsed spec projects: a `field` spec
 * yields its single pair, an array `fields` maps each source onto itself as
 * the key, and an object map (or the default list fields) supplies key → source.
 * @param spec - a parsed spec (kind list/field).
 * @returns the row-key → source pairs to project.
 */
export function extractFieldPairs(
  spec: ExtractSpec,
): Array<[string, string]> {
  if (spec.kind === 'field') return [[spec.field ?? 'value', spec.field ?? 'value']]
  if (Array.isArray(spec.fields)) return (spec.fields as readonly string[]).map(source => [source, source])
  const map = (spec.fields ?? DEFAULT_LIST_FIELDS) as Readonly<Record<string, string>>
  return Object.entries(map)
}

/**
 * Select candidates for a parsed spec: build the host query from `spec.from`,
 * apply the pure `nameMatches` filter, and (for `withinRole`) the ref-path
 * ancestor check. `visibleOnly` is returned as a flag — visibility needs a
 * FRESH measurement, so the service applies it after resolving each node.
 * @param index - fresh document index.
 * @param spec - parsed spec.
 * @param selectorIds - node ids from `DOM.querySelectorAll`, when `from.selector` set.
 * @returns matches in document order plus the deferred visible filter.
 */
export function matchExtractCandidates(
  index: ReadonlyMap<string, RefIndexEntry>,
  spec: ExtractSpec,
  selectorIds?: readonly number[],
): { matches: FindMatch[], visibleOnly: boolean } {
  const visibleOnly = spec.where?.visibleOnly === true
  if (spec.kind === 'page') return { matches: [], visibleOnly }
  const matches = matchFindCandidates(index, {
    ...(spec.from?.selector !== undefined ? { selector: spec.from.selector } : {}),
    ...(spec.from?.role !== undefined ? { role: spec.from.role } : {}),
    ...(spec.from?.ariaLabel !== undefined ? { ariaLabel: spec.from.ariaLabel } : {}),
  }, selectorIds !== undefined ? { selectorIds } : {})
  const within = spec.from?.withinRole
  const pattern = spec.where?.nameMatches
    ? new RegExp(displayNormalize(spec.where.nameMatches))
    : undefined
  const kept = matches.filter((match) => {
    if (within !== undefined && !refPathHasRole(match.ref, within)) return false
    if (pattern !== undefined && !pattern.test(displayNormalize(match.name))) return false
    return true
  })
  return { matches: kept, visibleOnly }
}

/**
 * True when one woven ref has an ancestor step with `role`.
 * Ref shape: `role|name|ordinal(>#…)?(>role|name|ordinal)*` — `#n` only ever
 * lands on the final step (plan §2.1), so ancestor steps are always clean.
 * @param ref - woven reference.
 * @param role -ancestor role to look for.
 * @returns true when any ancestor step carries the role.
 */
export function refPathHasRole(ref: string, role: string): boolean {
  const steps = ref.split('>')
  for (const step of steps.slice(0, -1)) {
    if (step.split('|')[0] === role) return true
  }
  return false
}

/**
 * Lossless JSON value — a structural mirror of `@deepseek-ai/dsh-util-values`'
 * `JsonValue`, so projected rows type-check into the tool schema's inferred
 * `Record<string, JsonValue>[]` WITHOUT adding a package dependency to the
 * bundle. Every projected value (string/number/boolean/null/box literal) is
 * lossless by construction.
 */
export type LosslessJsonValue =
  | null
  | boolean
  | number
  | string
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue }

/** Projected row as dynamic keys — schema stays an open object on purpose. */
export type ExtractRow = Record<string, LosslessJsonValue>

/** Projection outcome for one candidate set. */
export interface ExtractProjection {
  /** Row objects; ALWAYS an array, empty when nothing matched. */
  readonly data: ExtractRow[]
  /** Rows actually emitted (after `limit`). */
  readonly count: number
  /** Honesty fields (plan §4.3). */
  readonly honesty: ExtractHonesty
}

/**
 * Project candidates into rows. `page` rows come from `pageFields` (one
 * page-side evaluation); `list`/`field` rows consume fresh evidence per
 * candidate. A source that cannot answer adds a `missing` line — the row
 * simply lacks that key rather than inventing a value.
 * @param spec - parsed spec.
 * @param sources - fresh index + resolved candidates.
 * @param pageFields - page-side field values for `kind:"page"`.
 * @returns rows plus the mandatory honesty envelope.
 */
export function projectExtract(
  spec: ExtractSpec,
  sources: ExtractSources,
  pageFields: Readonly<Record<string, LosslessJsonValue>> = {},
): ExtractProjection {
  const missing: string[] = []
  const truncatedFields = new Set<string>()
  const warnings: string[] = []
  const data: ExtractRow[] = []

  if (spec.kind === 'page') {
    const requested = Array.isArray(spec.fields) ? spec.fields as string[] : [...PAGE_FIELDS]
    const row: ExtractRow = {}
    for (const field of requested) {
      const value = pageFields[field]
      if (value === undefined || value === null) {
        missing.push(`field '${field}': no source on this page`)
        continue
      }
      row[field] = projectScalar(field, value, truncatedFields, missing)
    }
    data.push(row)
    return {
      data,
      count: 1,
      honesty: {
        complete: missing.length === 0 && truncatedFields.size === 0,
        missing,
        truncatedFields: [...truncatedFields],
        warnings,
        source: { nodes: sources.resolvedNodes, totalNodes: sources.totalNodes },
      },
    }
  }

  const pairs = extractFieldPairs(spec)
  const totalMatched = sources.totalMatched
  const resolvedOf = (ref: string): ResolvedCandidate =>
    sources.resolved?.get(ref) ?? { resolveError: 'node was not resolved' }
  let candidates = sources.matches.map(match => ({ match, ...resolvedOf(match.ref) }))
  // The service resolves at most `spec.limit` nodes; the host match count is
  // what tells the truth about a cut (honest numbers, plan §4.3).
  const limitApplied = sources.totalMatched > sources.matches.length
    || candidates.length > spec.limit
  if (limitApplied) {
    warnings.push(`limit ${String(spec.limit)} applied: ${String(sources.totalMatched)} candidates matched`)
  }
  if (spec.where?.visibleOnly === true) {
    const visible = candidates.filter(candidate => candidate.evidence?.visible === true)
    if (visible.length < candidates.length) {
      warnings.push(`visibleOnly removed ${String(candidates.length - visible.length)} of ${String(candidates.length)} resolved candidates`)
    }
    candidates = visible
  }
  const limited = candidates.slice(0, spec.limit)

  for (const candidate of limited) {
    const row: ExtractRow = {}
    if (candidate.resolveError !== undefined) {
      missing.push(`node ${candidate.match.ref}: ${candidate.resolveError}`)
      continue
    }
    for (const [key, source] of pairs) {
      if (source === 'count') {
        row[key] = totalMatched
        continue
      }
      if (source === 'name') {
        row[key] = projectScalar(key, candidate.match.name, truncatedFields, missing)
        continue
      }
      if (source === 'role') {
        row[key] = candidate.match.role
        continue
      }
      const evidence = candidate.evidence
      if (evidence === undefined) {
        missing.push(`field '${key}': node could not be resolved fresh`)
        continue
      }
      if (source === 'value') {
        // plan09-fix: this used to be `row[key] = evidence.value ?? null`, which
        // wrote a bare `null` for a node that simply has no form value (a
        // `<div>`, a heading, a `section`) and still answered `complete:true` —
        // indistinguishable from a control that really is empty. `value` is
        // optional on RefEvidence, so `undefined` means "this node does not
        // carry a value" and must surface as a `missing` line, exactly like an
        // unresolvable node does. An EMPTY value on a real control stays `""`.
        if (evidence.value === undefined) {
          missing.push(`field '${key}': node has no value (not an input, textarea, or select)`)
          continue
        }
        row[key] = evidence.value
        continue
      }
      if (source === 'text') {
        row[key] = projectScalar(key, evidence.text, truncatedFields, missing)
        continue
      }
      if (source === 'checked') {
        row[key] = evidence.checked ?? null
        continue
      }
      if (source === 'box') {
        row[key] = { ...evidence.rect }
        continue
      }
      if (source === 'href' || source.startsWith('attr:')) {
        const attrName = source === 'href' ? 'href' : source.slice('attr:'.length)
        const attrs = evidence.attrs ?? {}
        // hasOwnProperty cannot narrow an index read (noUncheckedIndexedAccess),
        // so coalesce the possible undefined right here — absent attribute → null.
        row[key] = Object.prototype.hasOwnProperty.call(attrs, attrName) ? (attrs[attrName] ?? null) : null
        continue
      }
      missing.push(`field '${key}': unknown source '${source}'`)
    }
    data.push(row)
  }

  // Honesty: an empty projection is never silently "complete".
  if (data.length === 0 && missing.length === 0) {
    missing.push(
      sources.totalMatched === 0
        ? 'no node matched from/where'
        : 'no candidate survived where.visibleOnly after fresh measurement',
    )
  }

  const complete = missing.length === 0 && truncatedFields.size === 0 && !limitApplied
  return {
    data,
    count: data.length,
    honesty: {
      complete,
      missing,
      truncatedFields: [...truncatedFields],
      warnings,
      source: { nodes: sources.resolvedNodes, totalNodes: sources.totalNodes },
    },
  }
}

/** @param key - row key. @param value - projected scalar. @returns the (possibly cut) scalar. */
function projectScalar(
  key: string,
  value: LosslessJsonValue | undefined,
  truncatedFields: Set<string>,
  missing: string[],
): LosslessJsonValue {
  if (typeof value !== 'string') {
    if (value === undefined) {
      missing.push(`field '${key}': no source`)
      return null
    }
    return value
  }
  if (value.length > EXTRACT_TEXT_LIMIT) {
    truncatedFields.add(key)
    return value.slice(0, EXTRACT_TEXT_LIMIT)
  }
  return value
}
