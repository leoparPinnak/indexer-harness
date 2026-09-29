/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-recall: SEARCH over one
 * session's stored events, v1. The measurement said transcripts have no recall
 * surface at all (`stat`/`list` expose metadata; handles expose raw slices),
 * so this module adds the primitive the resume story needs: match-centered
 * snippets with an ANCHORED window (the Hermes `get_anchored_view` shape —
 * one call carries the hit and its neighbourhood, the goal-and-solution pair
 * a resume actually reads).
 *
 * v1 is honestly LINEAR: one session's event lines, regex over their text.
 * No index, no ranking — sized for single-session recall. The measured Hermes
 * stack (unicode FTS → trigram → LIKE with fail-open) is the documented next
 * rung; build it when volume demands, not before (the calibration lesson of
 * rounds 12–14).
 * @module @deepseek-ai/dsh-session-persistence-jsonl/search-sessions
 */

/** One matched event with its neighbourhood. */
export interface SessionSearchHit {
  /** Session sequence of the matched event. */
  readonly seq: number
  /** The stored event's kind (`user/message`, `tool/result`, …). */
  readonly kind: string
  /** The speaking role when the event carries one (`user`, `assistant`, …). */
  readonly role?: string
  /** Match-centred snippet (±snippetChars), `…`-clipped at both ends. */
  readonly snippet: string
  /** Match count inside this event's text. */
  readonly matches: number
  /** Neighbouring events around the hit — the anchored window a resume reads. */
  readonly context: readonly { readonly seq: number; readonly text: string }[]
}

/** Options of one search. */
export interface SessionSearchOptions {
  /** Events kept before the hit for the anchored window. Default 1. */
  readonly before?: number
  /** Events kept after the hit. Default 2. */
  readonly after?: number
  /** Snippet radius in characters around the first match. Default 120. */
  readonly snippetChars?: number
  /** Result cap. Default 50. */
  readonly limit?: number
}

/**
 * Gather the searchable text of one stored event: message text blocks plus
 * tool identity. Structured noise (ids, hashes) is left out — recall matches
 * what a human would have written.
 * @param event - the parsed event row (`{ type, data }`-shaped).
 * @returns the concatenated searchable text.
 */
export function searchTextOf(event: unknown): string {
  const record = (typeof event === 'object' && event !== null ? event : {}) as {
    type?: unknown
    data?: { message?: { content?: unknown }, content?: unknown, name?: unknown, toolName?: unknown }
  }
  const parts: string[] = []
  if (typeof record.type === 'string') parts.push(record.type)
  const blocks = record.data?.message?.content ?? record.data?.content
  const take = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) for (const each of value) take(each)
    else if (typeof value === 'object' && value !== null) {
      const block = value as { type?: unknown, text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  take(blocks)
  if (typeof record.data?.name === 'string') parts.push(record.data.name)
  if (typeof record.data?.toolName === 'string') parts.push(record.data.toolName)
  return parts.join('\n')
}

/**
 * Search one session's event lines for `query`, hit by hit with its anchored
 * window. Pure over the lines — the file/decoder layer above owns reading.
 * @param lines - the session's stored event lines, in order.
 * @param query - the match; use a non-global RegExp (flags are managed here).
 * @param options - window, snippet radius, and result cap.
 * @returns bounded hits, in session order.
 */
export function searchEventLines(
  lines: Iterable<string>,
  query: RegExp,
  options: SessionSearchOptions = {},
): SessionSearchHit[] {
  const before = options.before ?? 1
  const after = options.after ?? 2
  const snippetChars = options.snippetChars ?? 120
  const limit = options.limit ?? 50
  const rows: { seq: number, kind: string, role?: string, text: string }[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // an unparsable row is not a recall candidate; the admission layer owns tearing
    }
    const record = parsed as { seq?: unknown, type?: unknown, data?: { role?: unknown } }
    const seq = typeof record.seq === 'number' ? record.seq : rows.length
    const kind = typeof record.type === 'string' ? record.type : 'unknown'
    const role = typeof record.data?.role === 'string' ? record.data.role : undefined
    rows.push({ seq, kind, ...(role !== undefined ? { role } : {}), text: searchTextOf(parsed) })
  }
  const matcher = new RegExp(query.source, query.flags.replace(/[gy]/g, ''))
  const hits: SessionSearchHit[] = []
  for (const [index, row] of rows.entries()) {
    const found = row.text.match(new RegExp(matcher.source, `${matcher.flags}g`))
    const count = found?.length ?? 0
    if (count === 0) continue
    hits.push({
      seq: row.seq,
      kind: row.kind,
      ...(row.role !== undefined ? { role: row.role } : {}),
      snippet: buildSnippet(row.text, matcher, snippetChars),
      matches: count,
      context: [
        ...rows.slice(Math.max(0, index - before), index),
        ...rows.slice(index + 1, index + 1 + after),
      ].map(neighbour => ({ seq: neighbour.seq, text: clip(neighbour.text, snippetChars) })),
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** The match-centred snippet: `…` marks every cut. */
function buildSnippet(text: string, matcher: RegExp, radius: number): string {
  const at = text.search(matcher)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** One-sided clip for window neighbours. */
function clip(text: string, radius: number): string {
  return text.length <= radius ? text : `${text.slice(0, radius)}…`
}