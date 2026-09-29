/**
 * plan08 — the pure query engine behind `cdp_find`. Candidates are woven
 * entries from ONE fresh document index (the same `buildRefIndex` the ref
 * path resolves with), so every match this module returns is byte-identical
 * to a `cdp_snapshot` ref. Matching itself never talks to the protocol:
 * role/name/text/aria-label run against the weave, while `selector`/`scope`
 * arrive from the caller as protocol node-id sets (`DOM.querySelectorAll`).
 *
 * Honesty rules live here too (plan §4.2/§4.4): a query with no match yields
 * an empty list the tool turns into `ok:false + warnings` (never silent
 * success), display normalization hides bidi controls on BOTH sides of a
 * text match, and `nth` is applied by the caller so the full `matched`
 * count always reaches the output.
 *
 * @module @deepseek-ai/dsh-cdp/find
 */
import { lookupRefIndex, type RefIndexEntry } from './refs.ts'

/** Bidi embedding/override marks (U+202A–U+202E, U+2066–U+2069) — display-only. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g

/**
 * Whitespace-collapsed text; mirrors the weaver's `normalizeText` so a
 * needle typed into `text` compares equal to the name in the weave.
 * @param value - raw text, possibly with runs of whitespace.
 * @returns the text with every whitespace run collapsed to one space, trimmed.
 */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * plan08 §4.4: display-normalized text — bidi controls hidden, whitespace
 * collapsed. Used for BOTH sides of a `text` match so an embedded
 * `Gönder\u202A(Ctrl-Enter)\u202C` needle matches the raw woven name.
 * @param value - raw text (never the ref itself).
 * @returns display-safe comparable text.
 */
export function displayNormalize(value: string): string {
  return normalizeText(value.replace(BIDI_CONTROLS, ''))
}

/** One `cdp_find` query as the tool parsed it (at least one key set). */
export interface FindQuery {
  /** Exact woven reference. */
  readonly ref?: string
  /** CSS selector (scoped when `scope` is set; delivered as a node-id set). */
  readonly selector?: string
  /** Exact accessible-name/aria-label match (weaver name is aria-first). */
  readonly ariaLabel?: string
  /** Exact woven role match. */
  readonly role?: string
  /** Accessible-name substring match (display-normalized). */
  readonly text?: string
  /** CSS selector limiting the search to one subtree (node-id set). */
  readonly scope?: string
}

/**
 * True when the query carries at least one searchable key — the guard the
 * tool uses to reject an empty `cdp_find` call before matching runs.
 * @param query - the parsed query; `scope` alone does not count as searchable.
 * @returns whether any of ref/selector/ariaLabel/role/text is set.
 */
export function hasFindQuery(query: FindQuery): boolean {
  return query.ref !== undefined
    || query.selector !== undefined
    || query.ariaLabel !== undefined
    || query.role !== undefined
    || query.text !== undefined
}

/**
 * plan08: human-readable query summary for `no element matched …` lines —
 * one `key=value` pair per set key, so the failure line echoes exactly what
 * the caller asked for.
 * @param query - the parsed query to summarize.
 * @returns the space-joined pairs, or `(no query)` when nothing is set.
 */
export function querySummary(query: FindQuery): string {
  const parts: string[] = []
  if (query.ref !== undefined) parts.push(`ref=${JSON.stringify(query.ref)}`)
  if (query.selector !== undefined) parts.push(`selector=${JSON.stringify(query.selector)}`)
  if (query.ariaLabel !== undefined) parts.push(`ariaLabel=${JSON.stringify(query.ariaLabel)}`)
  if (query.role !== undefined) parts.push(`role=${JSON.stringify(query.role)}`)
  if (query.text !== undefined) parts.push(`text=${JSON.stringify(query.text)}`)
  if (query.scope !== undefined) parts.push(`scope=${JSON.stringify(query.scope)}`)
  return parts.length > 0 ? parts.join(' ') : '(no query)'
}

/** One matched candidate: ref + where it lives in the fresh document. */
export interface FindMatch {
  /** Woven reference, byte-identical to `cdp_snapshot`. */
  readonly ref: string
  /** Protocol node id inside the fresh document. */
  readonly nodeId: number
  /** Woven role. */
  readonly role: string
  /** Woven accessible name. */
  readonly name: string
}

/**
 * Match a query against one fresh document index.
 *
 * Resolution order (plan §5.7): `ref` → `selector` → `ariaLabel` →
 * `role` (+`text`) → `text` alone. `selector` and `scope` are supplied by
 * the caller as node-id sets because CSS evaluation is a protocol concern;
 * everything else runs purely against the weave.
 *
 * @param index - ref index of one fresh `DOM.getDocument` reply.
 * @param query - the parsed query.
 * @param options - `scopeIds` restricts every host-side path; `selectorIds`
 *   is the result of `DOM.querySelectorAll` for the `selector` path.
 * @returns matches in document order; empty means "nothing matched".
 */
export function matchFindCandidates(
  index: ReadonlyMap<string, RefIndexEntry>,
  query: FindQuery,
  options: {
    /** Node ids under the resolved `scope` subtree, when a scope was given. */
    readonly scopeIds?: ReadonlySet<number> | undefined
    /** Node ids `DOM.querySelectorAll(scope?, selector)` returned. */
    readonly selectorIds?: readonly number[] | undefined
  } = {},
): FindMatch[] {
  const inScope = (nodeId: number): boolean => options.scopeIds === undefined || options.scopeIds.has(nodeId)
  const matches: FindMatch[] = []

  if (query.ref !== undefined) {
    // plan08-fix: ONE lookup rule with the resolver — canonical path first,
    // bare `role|name|ordinal` step as secondary (first document-order match),
    // leading '@' render decoration normalized away.
    const entry = lookupRefIndex(index, query.ref)
    if (entry !== undefined && inScope(entry.nodeId)) {
      matches.push({ ref: entry.ref, nodeId: entry.nodeId, role: entry.role, name: entry.name })
    }
    return matches
  }

  if (query.selector !== undefined) {
    // Document order: walk the index, keep the selector's node ids.
    for (const entry of index.values()) {
      if (options.selectorIds !== undefined && !options.selectorIds.includes(entry.nodeId)) continue
      if (!inScope(entry.nodeId)) continue
      matches.push({ ref: entry.ref, nodeId: entry.nodeId, role: entry.role, name: entry.name })
    }
    return matches
  }

  const needleName = query.ariaLabel !== undefined ? normalizeText(query.ariaLabel) : undefined
  const needleText = query.text !== undefined ? displayNormalize(query.text) : undefined
  // Nothing searchable left: never let a bare scope (or empty query) mean
  // "match everything" — an empty list is the honest answer.
  if (needleName === undefined && needleText === undefined && query.role === undefined) return []
  for (const entry of index.values()) {
    if (!inScope(entry.nodeId)) continue
    if (needleName !== undefined && entry.name !== needleName) continue
    if (query.role !== undefined && entry.role !== query.role) continue
    if (needleText !== undefined && !displayNormalize(entry.name).includes(needleText)) continue
    matches.push({ ref: entry.ref, nodeId: entry.nodeId, role: entry.role, name: entry.name })
  }
  return matches
}
