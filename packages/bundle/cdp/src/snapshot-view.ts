/**
 * @deepseek-ai/dsh-cdp — the snapshot lens. Pure projections over one woven
 * model (`snapshot.ts`): `filterInteractive` keeps only operable entries,
 * `compactNode` shortens names/values, and `diffSnapshots` reduces two models
 * to their delta keyed by `ref`. Plain data only — no socket, no browser call,
 * no clock — so one input always yields one output.
 *
 * Diff semantics (honest by construction): a changed accessible name produces a
 * NEW woven ref (the ref carries role|name|ordinal), so a rename shows up as
 * `removed` + `added`; `changed` covers the same ref whose value moved.
 * @module @deepseek-ai/dsh-cdp/snapshot-view
 */
import type { CdpWovenNode } from './snapshot.ts'

/** Character cap of the compact lens over one entry's name and value. */
export const COMPACT_TEXT_LIMIT = 80

/** The delta between two woven models, keyed by `ref`. */
export interface SnapshotDelta {
  readonly added: readonly CdpWovenNode[]
  readonly removed: readonly CdpWovenNode[]
  /** Same ref, new content: `was` holds the previous name (or value). */
  readonly changed: readonly { readonly ref: string; readonly role: string; readonly name: string; readonly was: string }[]
  readonly unchangedCount: number
}

/**
 * Keep only entries whose role the weaver marked directly operable.
 * @param nodes - one woven model's entries.
 * @returns the operable subset, in document order.
 */
export function filterInteractive(nodes: readonly CdpWovenNode[]): CdpWovenNode[] {
  return nodes.filter(node => node.interactive)
}

/**
 * One entry with its name and value clipped to {@link COMPACT_TEXT_LIMIT}.
 * @param node - one woven entry.
 * @param limit - clip size in characters.
 * @returns the entry with clipped text; short text survives untouched.
 */
export function compactNode(node: CdpWovenNode, limit: number = COMPACT_TEXT_LIMIT): CdpWovenNode {
  const clip = (text: string): string => (
    text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
  )
  return {
    ...node,
    name: clip(node.name),
    ...(node.value !== undefined ? { value: clip(node.value) } : {}),
  }
}

/**
 * {@link compactNode} over a whole model.
 * @param nodes - one woven model's entries.
 * @param limit - clip size in characters.
 * @returns every entry with clipped text.
 */
export function compactView(nodes: readonly CdpWovenNode[], limit: number = COMPACT_TEXT_LIMIT): CdpWovenNode[] {
  return nodes.map(node => compactNode(node, limit))
}

/**
 * Reduce two woven models to their delta. `previous` is the base (often the
 * previous `cdp_snapshot` of the same target key); `current` is fresh.
 * @param previous - the base woven model.
 * @param current - the fresh woven model.
 * @returns the delta keyed by `ref`.
 */
export function diffSnapshots(
  previous: readonly CdpWovenNode[],
  current: readonly CdpWovenNode[],
): SnapshotDelta {
  const prevByRef = new Map<string, CdpWovenNode>(previous.map(node => [node.ref, node]))
  const currRefs = new Set<string>(current.map(node => node.ref))
  const added = current.filter(node => !prevByRef.has(node.ref))
  const removed = previous.filter(node => !currRefs.has(node.ref))
  const changed: { ref: string; role: string; name: string; was: string }[] = []
  let unchangedCount = 0
  for (const node of current) {
    const prev = prevByRef.get(node.ref)
    if (prev === undefined) continue
    if (prev.name === node.name && prev.value === node.value) {
      unchangedCount += 1
      continue
    }
    changed.push({
      ref: node.ref,
      role: node.role,
      name: node.name,
      was: prev.name !== node.name ? prev.name : prev.value ?? '',
    })
  }
  return { added, removed, changed, unchangedCount }
}