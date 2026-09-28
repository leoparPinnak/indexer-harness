/**
 * @deepseek-ai/dsh-cdp — the DOM weaver. `weaveSnapshot` reduces a
 * `DOM.getDocument` tree, optional box models, and an optional accessibility
 * tree into one bounded page model: the viewport, the title, the URL, an
 * ordered element list whose references survive unrelated DOM changes, and the
 * counts and flags of every bound the weaving applied. It reads plain data
 * only — no socket, no browser call, no clock — so one input always yields one
 * output.
 * @module @deepseek-ai/dsh-cdp/snapshot
 */

/** Protocol node type of an element; only these nodes produce a woven entry. */
const ELEMENT_NODE = 1

/** Protocol node type of a text node; its `nodeValue` feeds an element's fallback name. */
const TEXT_NODE = 3

/** Default cap on the entries of one woven model. */
export const DEFAULT_MAX_NODES = 400

/** Default cap on the characters of one entry's name or value. */
export const DEFAULT_MAX_TEXT_LENGTH = 160

/** Default cap on the UTF-8 bytes of the serialized woven model. */
export const DEFAULT_MAX_BYTES = 65_536

/**
 * Roles retained without a box model: a hidden dialog, menu, or alert still
 * tells the model the page has one, while an unmeasured generic wrapper does not.
 */
const IMPORTANT_HIDDEN_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'alertdialog',
  'dialog',
  'listbox',
  'menu',
  'status',
  'tooltip',
])

/** Roles the weaver reports as directly operable. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
])

/** Implicit roles of the elements a navigation surface, a form, or a table is built from. */
const IMPLICIT_ROLES: Readonly<Record<string, string>> = {
  article: 'article',
  aside: 'complementary',
  body: 'generic',
  button: 'button',
  caption: 'caption',
  dd: 'definition',
  div: 'generic',
  dl: 'list',
  dt: 'term',
  fieldset: 'group',
  figcaption: 'caption',
  figure: 'figure',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  img: 'img',
  input: 'textbox',
  legend: 'legend',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  p: 'paragraph',
  section: 'region',
  select: 'combobox',
  span: 'generic',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  th: 'columnheader',
  thead: 'rowgroup',
  tr: 'row',
  ul: 'list',
}

/** Implicit roles of the `input` types that differ from the `textbox` default. */
const INPUT_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  checkbox: 'checkbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
}

/** Viewport a snapshot was taken in, in CSS pixels. */
export interface CdpViewport {
  /** Viewport width in CSS pixels. */
  readonly width: number
  /** Viewport height in CSS pixels. */
  readonly height: number
}

/** One node of the `DOM.getDocument` tree as the protocol returns it. */
export interface CdpDomNode {
  /** Protocol node id, unique within this document. Never used as a reference. */
  readonly nodeId: number
  /**
   * Backend node id as `DOM.getDocument` reports it. Not part of a woven ref,
   * but it is the identity that survives a re-query of the same document, so
   * plan08-fix-ref-rename uses it to re-match a renamed element by NODE.
   */
  readonly backendNodeId?: number
  /** Protocol node id of the parent node; absent on the document root. */
  readonly parentId?: number
  /** Protocol node type; only `1` (element) produces a woven entry. */
  readonly nodeType: number
  /** Uppercased tag name for an element, `#text` / `#document` otherwise. */
  readonly nodeName: string
  /** Text content of a text node, as the protocol returns it. */
  readonly nodeValue?: string
  /** Flat name/value attribute pairs, exactly as the protocol returns them. */
  readonly attributes?: readonly string[]
  /** Child nodes in document order. */
  readonly children?: readonly CdpDomNode[]
}

/** One element's border box in viewport coordinates, in CSS pixels. */
export interface CdpBoxModel {
  /** Left edge in viewport coordinates. */
  readonly x: number
  /** Top edge in viewport coordinates. */
  readonly y: number
  /** Border-box width; `0` means the element occupies no space. */
  readonly width: number
  /** Border-box height; `0` means the element occupies no space. */
  readonly height: number
}

/** One node of the accessibility tree as the protocol returns it. */
export interface CdpAccessibilityNode {
  /** Protocol accessibility node id, the key `childIds` refers to. */
  readonly nodeId: string
  /**
   * Node id in the woven `DOM.getDocument` tree that this access node
   * describes; a caller maps the protocol's `backendDOMNodeId` onto it.
   */
  readonly documentNodeId: number
  /** Accessible role; absent or whitespace-only falls back to the DOM. */
  readonly role?: string
  /** Accessible name; absent or whitespace-only falls back to the DOM. */
  readonly name?: string
  /** Accessible value; absent or whitespace-only falls back to the DOM. */
  readonly value?: string
  /** True when the protocol excludes this node from the accessibility tree. */
  readonly ignored?: boolean
  /** Accessibility node ids of this node's children. */
  readonly childIds?: readonly string[]
}

/** Operator-supplied ceilings for one woven model. Non-negative integers. */
export interface CdpSnapshotLimits {
  /** Maximum woven entries; defaults to `DEFAULT_MAX_NODES`. */
  readonly maxNodes?: number
  /** Maximum characters of one entry's name or value; defaults to `DEFAULT_MAX_TEXT_LENGTH`. */
  readonly maxTextLength?: number
  /** Maximum UTF-8 bytes of the serialized model; defaults to `DEFAULT_MAX_BYTES`. */
  readonly maxBytes?: number
}

/** One page's facts and protocol reads, everything a snapshot needs. */
export interface CdpSnapshotInput {
  /** Root of the `DOM.getDocument` tree, normally the `#document` node. */
  readonly document: CdpDomNode
  /** Viewport the page was measured in. */
  readonly viewport: CdpViewport
  /** Page title. */
  readonly title: string
  /** Page URL. */
  readonly url: string
  /** Box models keyed by protocol node id; absent when the page was not measured. */
  readonly boxes?: ReadonlyMap<number, CdpBoxModel>
  /** Flat accessibility nodes; absent when the page exposes no accessibility tree. */
  readonly accessibility?: readonly CdpAccessibilityNode[]
  /** Ceilings this weaving applies; each defaults to its `DEFAULT_*` constant. */
  readonly limits?: CdpSnapshotLimits
}

/** Border box of one woven entry, in viewport coordinates. */
export interface CdpWovenBox {
  /** Left edge in viewport coordinates. */
  readonly x: number
  /** Top edge in viewport coordinates. */
  readonly y: number
  /** Border-box width. */
  readonly width: number
  /** Border-box height. */
  readonly height: number
}

/** One element of the woven page model. */
export interface CdpWovenNode {
  /** Stable element reference; its derivation is documented on `weaveSnapshot`. */
  readonly ref: string
  /** Accessible role, from the accessibility tree or the DOM fallback. */
  readonly role: string
  /** Accessible name, from the accessibility tree or the DOM fallback; possibly empty. */
  readonly name: string
  /** Accessible value when the node has one. */
  readonly value?: string
  /** Border box in viewport coordinates when the page was measured for this node. */
  readonly box?: CdpWovenBox
  /** True when the role is one the weaver reports as directly operable. */
  readonly interactive: boolean
  /** True when the node is rendered with a non-empty box, or was not measured. */
  readonly visible: boolean
}

/** Counts over one woven model. */
export interface CdpWovenCounts {
  /** Entries the document yielded before any bound applied. */
  readonly totalNodes: number
  /** Entries the model carries after every bound applied. */
  readonly returnedNodes: number
  /** Returned entries whose role is interactive. */
  readonly interactiveNodes: number
  /** Returned entries that are visible. */
  readonly visibleNodes: number
}

/** The bounded page model `weaveSnapshot` returns. */
export interface CdpSnapshot {
  /** Page title, unchanged by every bound. */
  readonly title: string
  /** Page URL, unchanged by every bound. */
  readonly url: string
  /** Viewport the page was measured in. */
  readonly viewport: CdpViewport
  /** Woven entries in document order. */
  readonly nodes: readonly CdpWovenNode[]
  /** Counts over the woven entries. */
  readonly counts: CdpWovenCounts
  /** True when any of the three bounds applied. */
  readonly truncated: boolean
  /** True when the node limit dropped entries; `counts.totalNodes` still counts them. */
  readonly nodeLimitTruncated: boolean
  /** True when the per-node text limit shortened a name or a value. */
  readonly textLimitTruncated: boolean
  /** True when the untruncated model exceeded the size limit, so the returned entries are one of its prefixes. */
  readonly sizeLimitTruncated: boolean
}

/** The three truncation facts one model build carries, so its byte count matches the finalized model. */
interface SnapshotFlags {
  readonly nodeLimitTruncated: boolean
  readonly textLimitTruncated: boolean
  readonly sizeLimitTruncated: boolean
}

/** State one collection pass accumulates. */
interface Collection {
  readonly boxes: ReadonlyMap<number, CdpBoxModel> | undefined
  readonly access: ReadonlyMap<number, CdpAccessibilityNode>
  readonly entries: CdpWovenNode[]
  /** Next ordinal per parent reference and per `role|name` step. */
  readonly ordinals: Map<string, Map<string, number>>
}

/** Whitespace-collapsed text; empty means no accessible text. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Value of one attribute in the protocol's flat name/value pair list. */
function attributeValue(node: CdpDomNode, name: string): string | undefined {
  const attributes = node.attributes
  if (attributes === undefined) return undefined
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1]
  }
  return undefined
}

/** Concatenated text of this node's direct text children, whitespace-collapsed. */
function directText(node: CdpDomNode): string {
  let text = ''
  for (const child of node.children ?? []) {
    if (child.nodeType === TEXT_NODE) text += child.nodeValue ?? ''
  }
  return normalizeText(text)
}

/** Role from the element itself: an explicit `role` attribute, then a tag table, then the lowercased tag. */
function domRole(node: CdpDomNode): string {
  const explicit = normalizeText(attributeValue(node, 'role') ?? '')
  if (explicit !== '') return explicit
  const tag = node.nodeName.toLowerCase()
  if (tag === 'input') {
    const type = (attributeValue(node, 'type') ?? 'text').toLowerCase()
    return INPUT_ROLES[type] ?? 'textbox'
  }
  if (tag === 'a') return attributeValue(node, 'href') === undefined ? 'generic' : 'link'
  return IMPLICIT_ROLES[tag] ?? tag
}

/** Document-derived accessible name: `aria-label`, `alt`, `title`, `placeholder`, then direct text. */
function domName(node: CdpDomNode): string {
  for (const attribute of ['aria-label', 'alt', 'title', 'placeholder']) {
    const value = normalizeText(attributeValue(node, attribute) ?? '')
    if (value !== '') return value
  }
  return directText(node)
}

/** True when the box occupies space; an unmeasured node counts as visible. */
function isVisible(box: CdpBoxModel | undefined, measured: boolean): boolean {
  if (box === undefined) return !measured
  return box.width > 0 && box.height > 0
}

/** Next ordinal for one `role|name` step under one parent reference. */
function nextOrdinal(collection: Collection, parentRef: string, role: string, name: string): number {
  let counters = collection.ordinals.get(parentRef)
  if (counters === undefined) {
    counters = new Map()
    collection.ordinals.set(parentRef, counters)
  }
  const key = `${role}|${name}`
  const ordinal = counters.get(key) ?? 0
  counters.set(key, ordinal + 1)
  return ordinal
}

/** Weave one element node, or return undefined when a rule skips it. */
function weaveElement(
  node: CdpDomNode,
  parentRef: string,
  collection: Collection,
): CdpWovenNode | undefined {
  const access = collection.access.get(node.nodeId)
  if (access?.ignored === true) return undefined
  const role = normalizeText(access?.role ?? '') || domRole(node)
  const accessName = normalizeText(access?.name ?? '')
  const name = accessName !== '' ? accessName : domName(node)
  const box = collection.boxes?.get(node.nodeId)
  if (collection.boxes !== undefined && box === undefined && !IMPORTANT_HIDDEN_ROLES.has(role)) return undefined
  const accessValue = normalizeText(access?.value ?? '')
  const value = accessValue !== '' ? accessValue : normalizeText(attributeValue(node, 'value') ?? '')
  const step = `${role}|${name}|${String(nextOrdinal(collection, parentRef, role, name))}`
  return {
    ref: parentRef === '' ? step : `${parentRef}>${step}`,
    role,
    name,
    ...value === '' ? {} : { value },
    ...box === undefined
      ? {}
      : { box: { x: box.x, y: box.y, width: box.width, height: box.height } },
    interactive: INTERACTIVE_ROLES.has(role),
    visible: isVisible(box, collection.boxes !== undefined),
  }
}

/**
 * Visit one node depth-first in document order, parents before children.
 * @param node - node to visit.
 * @param parentRef - reference of the nearest woven ancestor, `''` at the document root.
 * @param collection - state the pass accumulates.
 */
function visit(node: CdpDomNode, parentRef: string, collection: Collection): void {
  let childRef = parentRef
  if (node.nodeType === ELEMENT_NODE) {
    const entry = weaveElement(node, parentRef, collection)
    if (entry !== undefined) {
      collection.entries.push(entry)
      childRef = entry.ref
    }
  }
  for (const child of node.children ?? []) visit(child, childRef, collection)
}

/** Every element the rules retain, in document order, before any bound applies. */
function collectEntries(input: CdpSnapshotInput): CdpWovenNode[] {
  const access = new Map<number, CdpAccessibilityNode>()
  for (const node of input.accessibility ?? []) {
    if (!access.has(node.documentNodeId)) access.set(node.documentNodeId, node)
  }
  const collection: Collection = { boxes: input.boxes, access, entries: [], ordinals: new Map() }
  visit(input.document, '', collection)
  return collection.entries
}

/** Suffix later duplicates of one reference with `#<n>` in document order. */
function disambiguate(entries: readonly CdpWovenNode[]): CdpWovenNode[] {
  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const count = seen.get(entry.ref) ?? 0
    seen.set(entry.ref, count + 1)
    return count === 0 ? entry : { ...entry, ref: `${entry.ref}#${String(count + 1)}` }
  })
}

/** Shorten every name and value to the text limit, reporting whether any changed. */
function applyTextLimit(
  entries: readonly CdpWovenNode[],
  maxTextLength: number,
): { entries: CdpWovenNode[]; truncated: boolean } {
  let truncated = false
  const limited = entries.map((entry) => {
    const name = entry.name.length > maxTextLength ? entry.name.slice(0, maxTextLength) : entry.name
    const value = entry.value === undefined || entry.value.length <= maxTextLength
      ? entry.value
      : entry.value.slice(0, maxTextLength)
    const shortened = name !== entry.name || value !== entry.value
    truncated = truncated || shortened
    if (!shortened) return entry
    return { ...entry, name, ...value === undefined ? {} : { value } }
  })
  return { entries: limited, truncated }
}

/** One complete model build; every candidate carries the final flags so its byte count is exact. */
function buildModel(
  input: CdpSnapshotInput,
  totalNodes: number,
  entries: readonly CdpWovenNode[],
  flags: SnapshotFlags,
): CdpSnapshot {
  return {
    title: input.title,
    url: input.url,
    viewport: { width: input.viewport.width, height: input.viewport.height },
    nodes: [...entries],
    counts: {
      totalNodes,
      returnedNodes: entries.length,
      interactiveNodes: entries.reduce((count, entry) => entry.interactive ? count + 1 : count, 0),
      visibleNodes: entries.reduce((count, entry) => entry.visible ? count + 1 : count, 0),
    },
    truncated: flags.nodeLimitTruncated || flags.textLimitTruncated || flags.sizeLimitTruncated,
    nodeLimitTruncated: flags.nodeLimitTruncated,
    textLimitTruncated: flags.textLimitTruncated,
    sizeLimitTruncated: flags.sizeLimitTruncated,
  }
}

/** UTF-8 bytes of one serialized model. */
function modelBytes(model: CdpSnapshot): number {
  return Buffer.byteLength(JSON.stringify(model), 'utf8')
}

/**
 * Weave one page model from protocol reads.
 *
 * The rules, fixed here because element references and consumer tool output
 * depend on them:
 *
 * - Only element nodes (type `1`) produce an entry; text nodes and the document
 *   node are skipped and their children are still visited.
 * - Entries are ordered depth-first in document order, parents before children.
 * - A node whose accessibility entry is `ignored` is skipped and its children
 *   are still visited.
 * - When the input carries a box-model map and has no entry for a node, that
 *   node is skipped unless its resolved role is `alert`, `alertdialog`,
 *   `dialog`, `listbox`, `menu`, `status`, or `tooltip`. A snapshot without
 *   measurements treats every element as rendered.
 * - A role comes from the accessibility tree, then an explicit `role`
 *   attribute, then a tag and input-type table, then the lowercased tag. A name
 *   comes from the accessibility tree, then `aria-label`, `alt`, `title`,
 *   `placeholder`, then the direct text children. A value comes from the
 *   accessibility tree, then the `value` attribute. Every text is
 *   whitespace-collapsed.
 * - A reference is a `>`-joined path of steps from the root element to the
 *   node; each step is `<role>|<name>|<ordinal>`, where the ordinal counts the
 *   preceding woven nodes with the same nearest woven ancestor and the same
 *   role and name. CDP node ids never enter a reference, so inserting or
 *   removing an unrelated sibling leaves every other reference unchanged, while
 *   renaming a node or changing its role changes its reference. A skipped node
 *   adds no step, so its woven children attach to their nearest woven ancestor,
 *   and the role and name in a reference are the full normalized values, before
 *   the text limit. Two entries whose paths encode identically — possible only
 *   when a name contains `>` or `|` — are told apart by a `#<n>` suffix in
 *   document order.
 * - The node limit keeps the first `maxNodes` entries of the complete list. The
 *   text limit cuts each name and value to `maxTextLength` characters. The
 *   total-size limit finds the longest prefix of entries whose serialized
 *   model, including title, URL, viewport, counts, and flags, fits `maxBytes`;
 *   the page facts and every truncation flag are retained even when no entry
 *   fits.
 *
 * @param input - the document tree, optional measurements and accessibility tree, the page facts, and the ceilings.
 * @returns the bounded page model, with a flag for every bound that applied.
 */
export function weaveSnapshot(input: CdpSnapshotInput): CdpSnapshot {
  const maxNodes = input.limits?.maxNodes ?? DEFAULT_MAX_NODES
  const maxTextLength = input.limits?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
  const maxBytes = input.limits?.maxBytes ?? DEFAULT_MAX_BYTES

  const all = disambiguate(collectEntries(input))
  const totalNodes = all.length
  const nodeLimitTruncated = totalNodes > maxNodes
  const limited = applyTextLimit(all.slice(0, maxNodes), maxTextLength)
  const flags = { nodeLimitTruncated, textLimitTruncated: limited.truncated }

  const complete = buildModel(input, totalNodes, limited.entries, { ...flags, sizeLimitTruncated: false })
  if (modelBytes(complete) <= maxBytes) return complete

  // The size bound drops trailing entries; the flag is already true, so every
  // candidate measures exactly the model this call would return.
  let low = 0
  let high = limited.entries.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = buildModel(
      input,
      totalNodes,
      limited.entries.slice(0, middle),
      { ...flags, sizeLimitTruncated: true },
    )
    if (modelBytes(candidate) <= maxBytes) low = middle
    else high = middle - 1
  }
  return buildModel(input, totalNodes, limited.entries.slice(0, low), { ...flags, sizeLimitTruncated: true })
}
