/**
 * plan08 — the ref path. A woven snapshot reference (`role|name|ordinal`,
 * disambiguated with `#n`) is resolved to a LIVE element in three bounded
 * protocol steps: a fresh `DOM.getDocument`, the weaver's own ref rules to
 * map ref → nodeId, and `DOM.resolveNode` + `Runtime.callFunctionOn` to read
 * the element's geometry at ACTION TIME. Nothing here trusts a rect stored by
 * an earlier snapshot, so a re-render between snapshot and action surfaces as
 * a `stale-ref` failure instead of a click at the wrong coordinates.
 *
 * The ref index is built from `weaveSnapshot` itself — the exact function
 * `cdp_snapshot` uses — so the ref a model reads and the ref this module
 * resolves can never drift: one weaver, one ref scheme.
 *
 * plan08-fix-ref-rename: a ref is a NAME (`role|name|ordinal`), so an element
 * that renames itself loses its ref while its DOM node stays put. `stale-ref`
 * is the answer for a node that is GONE, never for a node that was renamed:
 * resolution re-matches the remembered node id first, delivers the action to
 * it, and reports `ref-target-renamed` — see {@link renameNote}.
 *
 * @module @deepseek-ai/dsh-cdp/refs
 */
import { weaveSnapshot, type CdpDomNode, type CdpWovenNode } from './snapshot.ts'
import type {
  ActionabilityReport,
  ExpectOutcome,
  LocatorCandidate,
  LocatorReply,
  LocatorRun,
  ResolvedTarget,
  TextOutcome,
} from './locator.ts'

/** Protocol node type of an element; the only nodes a ref can address. */
const ELEMENT_NODE = 1

/**
 * plan08: every refusal this module raises starts with this prefix, so
 * `stale-ref` is greppable in tool reasons, REST payloads, and logs alike.
 */
export const REF_STALE_PREFIX = 'stale-ref'

/** plan08: internal weave limits so the ref index is NOT cut at the display caps. */
const REF_INDEX_LIMITS = {
  maxNodes: 2_000_000,
  maxTextLength: 1_000_000,
  maxBytes: 1_000_000_000,
} as const

/** One indexed reference: the woven ref plus where its element lives. */
export interface RefIndexEntry {
  /** Full woven reference, byte-identical to `cdp_snapshot`'s `nodes[].ref`. */
  readonly ref: string
  /** Protocol node id inside the document this index was built from. */
  readonly nodeId: number
  /**
   * plan08-fix-ref-rename: the node's backend id — the identity that survives a
   * re-query of the SAME document, so a renamed element can still be matched
   * to the ref the model was given. Absent when the reply omitted it.
   */
  readonly backendNodeId?: number
  /** Woven role (AX-first when the snapshot carried AX data, DOM fallback otherwise). */
  readonly role: string
  /** Woven accessible name as the snapshot reported it. */
  readonly name: string
}

/**
 * plan08-fix-ref-rename: one element's protocol identity — the pair CDP keeps
 * stable for a node that stays in the document while the page edits around it.
 */
export interface RefNodeIdentity {
  /** Protocol node id, unique inside one document. */
  readonly nodeId: number
  /** Backend node id, stable across `DOM.getDocument` calls; `0` when unreported. */
  readonly backendNodeId: number
}

/**
 * Collect every element's protocol identity in the weaver's exact traversal
 * order (depth-first, parents before children, `node.children` only — the
 * same walk `visit()` performs in `snapshot.ts`).
 * @param root - root node of one `DOM.getDocument` reply.
 * @returns element identities in document order.
 */
export function collectElementIdentities(root: CdpDomNode): RefNodeIdentity[] {
  const identities: RefNodeIdentity[] = []
  const walk = (node: CdpDomNode): void => {
    if (node.nodeType === ELEMENT_NODE) {
      identities.push({
        nodeId: node.nodeId,
        backendNodeId: typeof node.backendNodeId === 'number' && Number.isFinite(node.backendNodeId)
          ? node.backendNodeId
          : 0,
      })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return identities
}

/**
 * Collect every element's protocol node id in the weaver's exact traversal
 * order (depth-first, parents before children, `node.children` only — the
 * same walk `visit()` performs in `snapshot.ts`).
 * @param root - root node of one `DOM.getDocument` reply.
 * @returns element node ids in document order.
 */
export function collectElementIds(root: CdpDomNode): number[] {
  return collectElementIdentities(root).map(identity => identity.nodeId)
}

/**
 * plan08: build ref → element index for one fresh document. The snapshot the
 * model reads is capped (400 nodes), but this weave runs with raised limits
 * so a ref past the display cap still resolves. Both weaves are skip-free
 * (no boxes, no AX fed), so entries and element ids align 1:1 in order.
 * @param root - root node of one fresh `DOM.getDocument {depth:-1, pierce:true}` reply.
 * @returns every ref of this document with its node id and woven role/name.
 */
export function buildRefIndex(root: CdpDomNode): Map<string, RefIndexEntry> {
  const input = {
    document: root,
    viewport: { width: 0, height: 0 },
    title: '',
    url: '',
    limits: REF_INDEX_LIMITS,
  }
  const nodes: readonly CdpWovenNode[] = weaveSnapshot(input).nodes
  // plan08-fix-ref-rename: identities instead of bare ids, so an entry can be
  // matched back to the SAME DOM node after its accessible name changed.
  const identities = collectElementIdentities(root)
  const index = new Map<string, RefIndexEntry>()
  const count = Math.min(nodes.length, identities.length)
  for (let i = 0; i < count; i++) {
    const node = nodes[i]
    const identity = identities[i]
    if (node === undefined || identity === undefined) continue
    index.set(node.ref, {
      ref: node.ref,
      nodeId: identity.nodeId,
      ...(identity.backendNodeId > 0 ? { backendNodeId: identity.backendNodeId } : {}),
      role: node.role,
      name: node.name,
    })
  }
  return index
}

/** plan08: viewport-relative box in CSS pixels, exactly as `cdp_click(x, y)` expects. */
export interface RefRect {
  /** Left edge in viewport CSS pixels. */
  readonly x: number
  /** Top edge in viewport CSS pixels. */
  readonly y: number
  /** Width in CSS pixels. */
  readonly width: number
  /** Height in CSS pixels. */
  readonly height: number
}

/**
 * plan08: one fresh element read — geometry and actionability measured at
 * action time by the browser, never by a stored snapshot rect.
 */
export interface RefEvidence {
  /** The reference this evidence resolves. */
  readonly ref: string
  /** Woven role from the ref index. */
  readonly role: string
  /** Woven name from the ref index. */
  readonly name: string
  /** Lowercase tag name read page-side. */
  readonly tag: string
  /** Element id attribute, page-side. */
  readonly id: string
  /** Fresh viewport rect (CSS pixels). */
  readonly rect: RefRect
  /** Raw aria-label attribute, page-side (for candidate display parity). */
  readonly ariaLabel: string
  /** Whether the element currently occupies visible space. */
  readonly visible: boolean
  /** Whether the element is not disabled. */
  readonly enabled: boolean
  /** Whether the rect intersects the viewport. */
  readonly inViewport: boolean
  /** Whether the element (or a descendant) is the topmost node at its center. */
  readonly hitTarget: boolean
  /** What sits at the center instead; absent when the hit target passed. */
  readonly coveredBy?: string
  /** Visible text, page-side capped at 4000 characters. */
  readonly text: string
  /** Uncapped text length before the page-side cut. */
  readonly textLength: number
  /** Form value for input/textarea/select. */
  readonly value?: string
  /** True when the element lives in a frame: its rect is frame-local, not top-viewport. */
  readonly frameLocal: boolean
  /** Page URL at resolution time. */
  readonly url: string
  /** Requested extra attributes (plan08 §4.3 `attr:<name>` sources); `null` = absent. */
  readonly attrs?: Record<string, string | null>
  /** Checked state for checkbox/radio inputs; `null` elsewhere. */
  readonly checked?: boolean | null
  /**
   * plan08-fix-ref-rename: present ONLY when this ref did not match by name
   * but its node survived — the element is the same one, wearing a different
   * accessible name. Consumers deliver the action and report
   * {@link renameNote} instead of a false `stale-ref`.
   */
  readonly renamed?: RefRename
  /** Resolved tab the evidence belongs to (filled by the service). */
  readonly targetId?: string
}

/**
 * plan08: a ref that failed to resolve. Messages start with `stale-ref:` when
 * a well-formed reference is genuinely gone, or with `unresolved-ref:` when
 * the input was never a reference at all (plan08-fix, T3 F2) — tools derive
 * their `staleRef` flag from that prefix, never from the error class.
 */
export class RefStaleError extends Error {
  /** The ref that failed to resolve. */
  readonly ref: string

  /**
   * @param ref - the unresolvable reference.
   * @param detail - the failure line; starts with `stale-ref:` or `unresolved-ref:`.
   */
  constructor(ref: string, detail: string) {
    super(detail)
    this.name = 'RefStaleError'
    this.ref = ref
  }
}

/**
 * True when one error is a plan08 stale-ref refusal.
 * @param error - the thrown value to identify.
 * @returns true when `error is RefStaleError`, narrowing it to {@link RefStaleError}.
 */
export function isRefStaleError(error: unknown): error is RefStaleError {
  return error instanceof RefStaleError
}

/**
 * plan08: the read-only page-side description run against the resolved
 * element (`this`). Function declaration form for `Runtime.callFunctionOn`,
 * evaluated in the element's OWN frame context, so a frame-local rect is
 * measured where it belongs. No HTML sinks, no Trusted Types surface.
 */
export const REF_DESCRIBE_FUNCTION = `function (attrNames) {
  const el = this
  const out = {
    ok: true,
    tag: '',
    id: '',
    ariaLabel: '',
    text: '',
    textLength: 0,
    rect: null,
    visible: false,
    enabled: true,
    inViewport: false,
    hitTarget: false,
    frameLocal: false,
    url: String(location.href),
    checked: null,
    attrs: {},
  }
  try {
    out.frameLocal = window !== window.top
    out.tag = String(el.localName || el.tagName || '').toLowerCase()
    out.id = String(el.id || '')
    out.ariaLabel = String(el.getAttribute('aria-label') || '')
    const rect = el.getBoundingClientRect()
    out.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window
    const style = view.getComputedStyle(el)
    out.visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    out.enabled = el.disabled !== true
    out.inViewport = rect.bottom > 0 && rect.right > 0
      && rect.top < (view.innerHeight || 0) && rect.left < (view.innerWidth || 0)
    if (out.visible) {
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max((view.innerWidth || 1) - 1, 0))
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max((view.innerHeight || 1) - 1, 0))
      const top = view.document.elementFromPoint(cx, cy)
      out.hitTarget = !!top && (top === el || el.contains(top))
      if (!out.hitTarget && top) {
        const topId = top.id ? '#' + top.id : ''
        out.coveredBy = String(top.localName || top.tagName || 'unknown') + topId
      }
    }
    const raw = typeof el.innerText === 'string' ? el.innerText : String(el.textContent || '')
    out.textLength = raw.length
    out.text = raw.length > 4000 ? raw.slice(0, 4000) : raw
    if (out.tag === 'input' || out.tag === 'textarea' || out.tag === 'select') {
      out.value = String(el.value === undefined || el.value === null ? '' : el.value)
    }
    if (typeof el.checked === 'boolean') out.checked = el.checked
    if (Array.isArray(attrNames)) {
      for (const name of attrNames.slice(0, 32)) {
        if (typeof name !== 'string' || name === '') continue
        out.attrs[name] = el.hasAttribute(name) ? String(el.getAttribute(name) ?? '') : null
      }
    }
  } catch (error) {
    out.ok = false
    out.error = String(error)
  }
  return out
}`

/** The subset of a CDP connection the ref path reads. */
export interface RefConnection {
  /**
   * Send one CDP command on one flattened session.
   * @param method - CDP method name.
   * @param params - protocol parameters.
   * @param sessionId - flattened session to route through.
   * @returns the reply's `result` object.
   */
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

/** @param value - candidate reply. @returns it as a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** @param error - any thrown value. @returns its message line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** @param value - candidate number. @returns it when finite, else the fallback. */
function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * plan08: normalize the page-side `attrs` bag (`{name: string | null}`).
 * @param record - the attrs object from the describe reply.
 * @returns a plain name → value record (`null` = attribute absent).
 */
function normalizeAttrs(record: Record<string, unknown>): Record<string, string | null> {
  const attrs: Record<string, string | null> = {}
  for (const [name, entry] of Object.entries(record)) {
    attrs[name] = typeof entry === 'string' ? entry : null
  }
  return attrs
}

/**
 * plan08-fix (T3 F2): shape check for a woven reference — the final step must
 * end with `|<ordinal>`, optionally `#n`-disambiguated. Used ONLY to choose
 * which honest message an unresolved ref earns: a malformed string answers
 * `unresolved-ref:` (a format/copy mistake, not staleness), a well-formed one
 * keeps `stale-ref:` (the document really changed).
 * @param ref - candidate reference, after the leading-`@` normalization.
 * @returns true when the string has a reference's shape.
 */
function looksLikeRef(ref: string): boolean {
  return /\|\d+(#\d+)?$/.test(ref)
}

/**
 * plan08-fix (T3 F2 / T6 §3.5): the ONE ref lookup rule every consumer now
 * shares — `cdp_find`'s ref query and `resolveRefOn` resolve through this
 * function, so production and resolution can never diverge again.
 *
 * Three inputs map onto the canonical woven path `cdp_snapshot` prints:
 *  1. the canonical full path — exact key hit;
 *  2. a bare `role|name|ordinal` final step (the form the guides document) —
 *     accepted as SECONDARY: the first document-order entry whose path ends
 *     with that step, so guide-written and payload-written refs agree instead
 *     of silently missing;
 *  3. a leading `@` (our own historic render decoration) — normalized away
 *     before either lookup, because models copy render text verbatim.
 *
 * @param index - ref index of one fresh document (`buildRefIndex`).
 * @param ref - canonical path, bare final step, or `@`-decorated of either.
 * @returns the indexed entry, or undefined when nothing carries the ref.
 */
export function lookupRefIndex(
  index: ReadonlyMap<string, RefIndexEntry>,
  ref: string,
): RefIndexEntry | undefined {
  const key = ref.startsWith('@') ? ref.slice(1) : ref
  const direct = index.get(key)
  if (direct !== undefined) return direct
  // A full path that is not carried has no secondary form to try: shorter
  // guesses would be lying about which element was meant.
  if (key.includes('>')) return undefined
  for (const entry of index.values()) {
    if (entry.ref === key || entry.ref.endsWith(`>${key}`)) return entry
  }
  return undefined
}

/* plan08-fix-ref-rename — a NAME change is not a NODE change.
 *
 * A woven ref is a path of `<role>|<name>|<ordinal>` steps, so an element that
 * renames itself ("Onayla" → "Onayla ✓") loses its ref even though the very
 * same DOM node is still there. Reporting that as `stale-ref` is the most
 * expensive lie this package can tell: the model reads "the page re-rendered",
 * re-snapshots, gets the SAME text under a NEW ref, and loops forever.
 *
 * The honest discriminator is node identity. When a snapshot/find hands a ref
 * to the model, the node that ref pointed at is remembered per target
 * ({@link recordRefOrigins}). On a name miss, resolution re-matches that node
 * inside the FRESH document ({@link lookupRefByIdentity}): found ⇒ the element
 * is still there, so the action is DELIVERED and reported as `ref-target-renamed`;
 * not found ⇒ the node really is gone, and `stale-ref` is the correct refusal. */

/**
 * plan08-fix-ref-rename: where one ref pointed when a snapshot or find handed
 * it out — the node identity that survives a rename of that node.
 */
export interface RefOrigin {
  /** The ref exactly as it was published. */
  readonly ref: string
  /** Protocol node id of the element at publish time. */
  readonly nodeId: number
  /** Backend node id at publish time; absent when the reply omitted it. */
  readonly backendNodeId?: number
  /** Woven role at publish time. */
  readonly role: string
  /** Woven accessible name at publish time. */
  readonly name: string
  /** Page URL at publish time; `''` when unknown. */
  readonly url: string
}

/** plan08-fix-ref-rename: bounded per-target origins, so a long session cannot grow without limit. */
const REF_ORIGIN_TARGET_LIMIT = 8
const REF_ORIGIN_REF_LIMIT = 4_000

const refOrigins = new Map<string, Map<string, RefOrigin>>()

/**
 * plan08-fix-ref-rename: remember the node every published ref pointed at, for
 * one target. Called where refs are produced (`snapshot`, `find`) — the only
 * moment the publish-time document is still in hand. Publication order is
 * document order, so the map is simply truncated at the cap; older targets are
 * evicted first.
 * @param targetKey - resolved target id (`''` when unknown).
 * @param index - ref index of the document the refs were published from.
 * @param url - page URL at publish time; guards the fallback against a navigation.
 */
export function recordRefOrigins(
  targetKey: string,
  index: ReadonlyMap<string, RefIndexEntry>,
  url: string,
): void {
  const origins = new Map<string, RefOrigin>()
  let count = 0
  for (const entry of index.values()) {
    if (count >= REF_ORIGIN_REF_LIMIT) break
    origins.set(entry.ref, {
      ref: entry.ref,
      nodeId: entry.nodeId,
      ...(entry.backendNodeId !== undefined ? { backendNodeId: entry.backendNodeId } : {}),
      role: entry.role,
      name: entry.name,
      url,
    })
    count += 1
  }
  // Re-insert so the freshest target is last (oldest are evicted first).
  refOrigins.delete(targetKey)
  refOrigins.set(targetKey, origins)
  while (refOrigins.size > REF_ORIGIN_TARGET_LIMIT) {
    const oldest = refOrigins.keys().next()
    if (oldest.done === true) break
    refOrigins.delete(oldest.value)
  }
}

/**
 * plan08-fix-ref-rename: the remembered origin of one ref, or undefined when
 * this target never published it (or evicted it). Accepts the same input forms
 * as {@link lookupRefIndex}, so `@`-decoration and bare final steps behave
 * identically on both paths.
 * @param targetKey - resolved target id.
 * @param ref - the ref the model is using now.
 * @returns the origin recorded when that ref was published.
 */
export function lookupRefOrigin(targetKey: string, ref: string): RefOrigin | undefined {
  const origins = refOrigins.get(targetKey)
  if (origins === undefined) return undefined
  const key = ref.startsWith('@') ? ref.slice(1) : ref
  const direct = origins.get(key)
  if (direct !== undefined) return direct
  if (key.includes('>')) return undefined
  for (const origin of origins.values()) {
    if (origin.ref === key || origin.ref.endsWith(`>${key}`)) return origin
  }
  return undefined
}

/**
 * plan08-fix-ref-rename: forget every remembered origin (or one target's).
 * Exposed so tab teardown and tests can drop state instead of leaking it.
 * @param targetKey - target to forget; every target when omitted.
 */
export function clearRefOrigins(targetKey?: string): void {
  if (targetKey === undefined) refOrigins.clear()
  else refOrigins.delete(targetKey)
}

/**
 * plan08-fix-ref-rename: find the FRESH entry that stands on the node a
 * published ref pointed at. Backend node id wins (it is the id CDP keeps for
 * a node across re-queries); the protocol node id is the documented fallback
 * for replies that omit it. Both are unique per node, so a hit is unambiguous.
 * @param index - ref index of the FRESH document.
 * @param origin - the remembered publish-time identity.
 * @returns the fresh entry carrying that node, or undefined when it is gone.
 */
export function lookupRefByIdentity(
  index: ReadonlyMap<string, RefIndexEntry>,
  origin: RefOrigin,
): RefIndexEntry | undefined {
  if (origin.backendNodeId !== undefined) {
    for (const entry of index.values()) {
      if (entry.backendNodeId === origin.backendNodeId) return entry
    }
  }
  for (const entry of index.values()) {
    if (entry.nodeId === origin.nodeId) return entry
  }
  return undefined
}

/**
 * plan08-fix-ref-rename: the honest one-line reason for a ref that resolved
 * through node identity instead of through its name.
 */
export const REF_RENAMED_PREFIX = 'ref-target-renamed'

/** plan08-fix-ref-rename: the before/after of a ref whose element is the same node. */
export interface RefRename {
  /** The ref the model used. */
  readonly fromRef: string
  /** Woven role when the ref was published. */
  readonly fromRole: string
  /** Woven accessible name when the ref was published. */
  readonly fromName: string
  /** The ref that element carries now. */
  readonly toRef: string
  /** Woven role now. */
  readonly toRole: string
  /** Woven accessible name now. */
  readonly toName: string
  /** Protocol node id that answered both times (the identity proof). */
  readonly nodeId: number
}

/**
 * plan08-fix-ref-rename: the reason line a rename earns. It says what actually
 * happened — the element is still there, only its name/ref changed, and the
 * action reached it — instead of the false "the page re-rendered" that sends
 * the model into a snapshot loop.
 * @param rename - the recorded before/after.
 * @returns the `ref-target-renamed:` reason line.
 */
export function renameNote(rename: RefRename): string {
  const changed = rename.fromRole !== rename.toRole || rename.fromName !== rename.toName
  const what = changed
    ? `its accessible name changed (${JSON.stringify(rename.fromName)} → ${JSON.stringify(rename.toName)})`
    : `its ref changed (${JSON.stringify(rename.fromRef)} → ${JSON.stringify(rename.toRef)}); a sibling with the same role and name was added or removed`
  return `${REF_RENAMED_PREFIX}: the element is still there — ${what}. `
    + `The same DOM node (nodeId ${String(rename.nodeId)}) answered, so the action was delivered to it; `
    + 'call cdp_snapshot again only if you need its new ref'
}

/**
 * True when a reason is a rename note (never a staleness claim).
 * @param reason - the verdict reason to test, when present.
 * @returns true when `reason` carries the `ref-target-renamed:` prefix.
 */
export function isRefRenamedReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(`${REF_RENAMED_PREFIX}:`)
}

/**
 * Resolve one ref against a fresh document: index it with the weaver's own
 * rules, resolve its node to a runtime object, and read its geometry,
 * visibility, and hit-test at action time.
 * @param connection - connection to send on.
 * @param sessionId - flattened session of the owning tab.
 * @param ref - the woven reference from `cdp_snapshot` (canonical full path,
 *   or a bare `role|name|ordinal` step accepted as secondary — see
 *   {@link lookupRefIndex}).
 * @param root - root of a FRESH `DOM.getDocument` reply for that tab.
 * @param options - `attributes` asks the page-side describe for extra
 *   attributes (`cdp_extract`'s `attr:<name>` / `href` sources); `index`
 *   reuses a prebuilt ref index when one call resolves many refs off the
 *   same fresh document (find/extract loops); `origin` carries the node this
 *   ref pointed at when it was published (plan08-fix-ref-rename) so a renamed
 *   element is re-matched by IDENTITY instead of being refused as stale.
 * @returns fresh evidence for the element; `evidence.ref` is always the
 *   canonical full path that actually resolved, and `evidence.renamed` is
 *   present only when that path differs from the ref asked for because the
 *   same node now wears a different name.
 * @throws RefStaleError with a `stale-ref:` prefix when a well-formed ref
 *   is gone (or any protocol read fails), or with `unresolved-ref:` when the
 *   string was never a snapshot reference at all.
 */
export async function resolveRefOn(
  connection: RefConnection,
  sessionId: string,
  ref: string,
  root: CdpDomNode,
  options?: {
    readonly attributes?: readonly string[]
    readonly index?: ReadonlyMap<string, RefIndexEntry>
    readonly origin?: RefOrigin
  },
): Promise<RefEvidence> {
  // plan08-fix (T3 F2 / T6 §3.5): production and resolution meet at ONE seam
  // and ONE lookup rule (lookupRefIndex above). Anything that still misses
  // gets an honest classification instead of the page being blamed for a
  // format mistake.
  const key = ref.startsWith('@') ? ref.slice(1) : ref
  const index = options?.index ?? buildRefIndex(root)
  let entry = lookupRefIndex(index, ref)
  // plan08-fix-ref-rename: a name miss is not yet a node miss. Re-match the
  // remembered node FIRST; only a node miss may claim the page re-rendered.
  let rename: RefRename | undefined
  if (entry === undefined && options?.origin !== undefined) {
    const survivor = lookupRefByIdentity(index, options.origin)
    if (survivor !== undefined) {
      entry = survivor
      rename = {
        fromRef: options.origin.ref,
        fromRole: options.origin.role,
        fromName: options.origin.name,
        toRef: survivor.ref,
        toRole: survivor.role,
        toName: survivor.name,
        nodeId: survivor.nodeId,
      }
    }
  }
  if (entry === undefined) {
    if (!looksLikeRef(key)) {
      throw new RefStaleError(
        ref,
        `unresolved-ref: ${JSON.stringify(ref)} is not a snapshot reference `
        + '(expected \'<role>|<name>|<ordinal>\' steps joined by \'>\'); '
        + 'copy the ref exactly from cdp_snapshot or cdp_find',
      )
    }
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: no element carries this reference in the current document `
      + '(the page re-rendered or navigated; call cdp_snapshot again)',
    )
  }

  let objectId: string
  try {
    const resolved = asRecord(await connection.send('DOM.resolveNode', { nodeId: entry.nodeId }, sessionId))
    const remote = asRecord(resolved?.object)
    const id = remote?.objectId
    if (typeof id !== 'string' || id === '') throw new Error('reply carried no objectId')
    objectId = id
  } catch (error) {
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: DOM.resolveNode refused node ${String(entry.nodeId)} `
      + `(${messageOf(error)}); the document changed under this ref`,
    )
  }

  let described: Record<string, unknown> | undefined
  try {
    const reply = asRecord(await connection.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: REF_DESCRIBE_FUNCTION,
      arguments: [{ value: [...(options?.attributes ?? [])] }],
      returnByValue: true,
      awaitPromise: true,
    }, sessionId))
    const result = asRecord(reply?.result)
    described = asRecord(result?.value)
  } catch (error) {
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: describing the resolved element failed (${messageOf(error)})`,
    )
  }
  if (described === undefined) {
    throw new RefStaleError(ref, `${REF_STALE_PREFIX}: the element description returned no value`)
  }
  if (described.ok !== true) {
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: page-side description failed (${String(described.error ?? 'unknown error')})`,
    )
  }

  const rectRaw = asRecord(described.rect)
  if (rectRaw === undefined) {
    throw new RefStaleError(ref, `${REF_STALE_PREFIX}: the element reported no bounding rect`)
  }
  const rect: RefRect = {
    x: asFiniteNumber(rectRaw.x, 0),
    y: asFiniteNumber(rectRaw.y, 0),
    width: asFiniteNumber(rectRaw.width, 0),
    height: asFiniteNumber(rectRaw.height, 0),
  }
  const text = typeof described.text === 'string' ? described.text : ''
  const attrsRaw = asRecord(described.attrs)
  const evidence: RefEvidence = {
    ref: entry.ref, // canonical full path, even when input was '@'-decorated or bare
    role: entry.role,
    name: entry.name,
    tag: typeof described.tag === 'string' ? described.tag : '',
    id: typeof described.id === 'string' ? described.id : '',
    ariaLabel: typeof described.ariaLabel === 'string' ? described.ariaLabel : '',
    rect,
    visible: described.visible === true,
    enabled: described.enabled !== false,
    inViewport: described.inViewport === true,
    hitTarget: described.hitTarget === true,
    ...(typeof described.coveredBy === 'string' && described.coveredBy !== ''
      ? { coveredBy: described.coveredBy }
      : {}),
    text,
    textLength: asFiniteNumber(described.textLength, text.length),
    ...(typeof described.value === 'string' ? { value: described.value } : {}),
    frameLocal: described.frameLocal === true,
    url: typeof described.url === 'string' ? described.url : '',
    ...(attrsRaw !== undefined ? { attrs: normalizeAttrs(attrsRaw) } : {}),
    ...(typeof described.checked === 'boolean' || described.checked === null
      ? { checked: described.checked }
      : {}),
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: the element has an empty bounding box `
      + `(${entry.role} "${entry.name}" is detached or display:none; re-snapshot and pick a visible ref)`,
    )
  }
  // plan08-fix-ref-rename: the identity match is only evidence of "same node"
  // while the page is still the page the ref was published on. A different
  // document may hand out a recycled id, so the navigation is checked and the
  // honest `stale-ref` wins — never a click at a wrong node's coordinates.
  if (rename !== undefined && options?.origin?.url !== undefined && options.origin.url !== ''
    && evidence.url !== '' && evidence.url !== options.origin.url) {
    throw new RefStaleError(
      ref,
      `${REF_STALE_PREFIX}: the page navigated since this ref was issued `
      + `(${options.origin.url} → ${evidence.url}), so node identity proves nothing here; `
      + 'call cdp_snapshot again',
    )
  }
  // Same node, new name: DELIVER the action and say what actually changed.
  if (rename !== undefined && rename.fromRef !== rename.toRef) {
    return { ...evidence, renamed: rename }
  }
  return evidence
}

/**
 * plan08: viewport center of one resolved element, clamped into the viewport.
 * @param rect - frame-local rect of the resolved element.
 * @param viewportWidth - width to clamp against, when given; omitted falls
 *   back to an effectively unbounded 1,000,000 px ceiling.
 * @param viewportHeight - height to clamp against, when given (same default).
 * @returns the rounded `{ x, y }` center, clamped to `[0, width-1]` and
 *   `[0, height-1]`.
 */
export function centerOf(rect: RefRect, viewportWidth?: number, viewportHeight?: number): { x: number; y: number } {
  const maxX = (viewportWidth ?? 1_000_000) - 1
  const maxY = (viewportHeight ?? 1_000_000) - 1
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), Math.max(max, 0))
  return {
    x: Math.round(clamp(rect.x + rect.width / 2, maxX)),
    y: Math.round(clamp(rect.y + rect.height / 2, maxY)),
  }
}

/**
 * plan08: wrap fresh evidence in the locator reply shape so `evaluateText`
 * and `evaluateExpect` consume a ref resolution exactly like a css/aria
 * resolution — same verdicts, same candidates, same renderers.
 * @param evidence - fresh element evidence.
 * @param targetId - resolved tab the evidence ran on.
 * @returns a successful single-candidate `strategy:'ref'` run.
 */
export function refLocatorRun(evidence: RefEvidence, targetId: string): LocatorRun {
  const failures: string[] = []
  if (!evidence.visible) failures.push('not visible')
  if (!evidence.enabled) failures.push('disabled')
  if (!evidence.inViewport) failures.push('outside the viewport')
  if (evidence.visible && !evidence.hitTarget) {
    failures.push(`covered by ${evidence.coveredBy ?? 'another element'}`)
  }
  const candidate: LocatorCandidate = {
    index: 0,
    tag: evidence.tag,
    role: evidence.role,
    name: evidence.name,
    ariaLabel: evidence.ariaLabel,
    id: evidence.id,
    rect: evidence.rect,
    visible: evidence.visible,
    enabled: evidence.enabled,
    inViewport: evidence.inViewport,
  }
  const target: ResolvedTarget = {
    ...candidate,
    text: evidence.text,
    textLength: evidence.textLength,
    ...(evidence.value !== undefined ? { value: evidence.value } : {}),
  }
  const actionability: ActionabilityReport = {
    attached: true,
    visible: evidence.visible,
    // Single measurement at action time: a stability twin-read is a plan02
    // page-side concern; the ref path reports the axis it actually measured.
    stable: true,
    enabled: evidence.enabled,
    inViewport: evidence.inViewport,
    hitTarget: evidence.hitTarget,
    failures,
  }
  const reply: LocatorReply = {
    ok: true,
    found: true,
    matched: 1,
    strategy: 'ref',
    candidates: [candidate],
    url: evidence.url,
    target,
    actionability,
    // plan08-fix-ref-rename: a read/assert through a renamed ref succeeds and
    // carries the honest note — the `warning` channel the locator replies
    // already use for "resolved, but read this before trusting it".
    ...(evidence.renamed !== undefined ? { warning: renameNote(evidence.renamed) } : {}),
  }
  return { targetId, reply }
}

/**
 * plan08: one failed ref resolution as locator data (never an exception), so
 * the read/expect poll loops can wait for a late-appearing ref exactly as
 * they wait for a late-appearing selector.
 * @param ref - the ref that failed to resolve.
 * @param targetId - resolved tab (best-effort, may be empty).
 * @param reason - failure line, `stale-ref:` prefixed for stale cases.
 * @returns a failed `strategy:'ref'` run carrying the reason.
 */
export function refFailureRun(ref: string, targetId: string, reason: string): LocatorRun {
  void ref
  const reply: LocatorReply = {
    ok: false,
    found: false,
    matched: 0,
    strategy: 'ref',
    candidates: [],
    url: '',
    reason,
  }
  return { targetId, reply }
}

/**
 * True when a verdict reason is a plan08 stale-ref refusal (for tool outputs).
 * @param reason - the verdict reason to test, when present.
 * @returns true when `reason` carries the `stale-ref:` prefix.
 */
export function isStaleRefReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(`${REF_STALE_PREFIX}:`)
}

/**
 * plan08: `TextOutcome` plus ref provenance — `ref` echoes the reference the
 * read ran against, `staleRef` distinguishes a stale-ref refusal from a
 * merely not-yet-visible element.
 */
export interface RefTextOutcome extends TextOutcome {
  /** The woven reference this read resolved (always present on the ref path). */
  ref?: string
  /** True when the failure was a `stale-ref:` refusal. */
  staleRef?: boolean
}

/** plan08: `ExpectOutcome` plus the same ref provenance as {@link RefTextOutcome}. */
export interface RefExpectOutcome extends ExpectOutcome {
  /** The woven reference this assertion resolved (always present on the ref path). */
  ref?: string
  /** True when the failure was a `stale-ref:` refusal. */
  staleRef?: boolean
}
