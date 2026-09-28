/**
 * plan11-fix-scan-rect: a `scan` box has to be a box an agent can CLICK.
 *
 * The live test agent measured this bug twice, bit-for-bit identical:
 *
 * ```
 * viewport İÇİ adaylar  → DOĞRU   #v6 158.46 ✓   #v8-frame 880.26 ✓
 * viewport ALTı adaylar → YANLIŞ  #v9 416 vs gerçek 1117
 *                                  #v11 544 vs gerçek 1639
 *                                  .v11-submit 788 vs gerçek 1882
 * ```
 *
 * The classification (`hit=not-in-viewport`) was RIGHT; the NUMBER was wrong,
 * and an agent aiming at those three boxes clicked a different element 3 times
 * out of 3. Root cause: `getBoundingClientRect` is a VIEWPORT (client)
 * coordinate and `elementFromPoint` wants a viewport coordinate too, but the
 * probe scroll was undone BEFORE the hit test and the rect handed to the agent
 * was the one measured WHILE scrolled — two axes, one silent wrong box.
 *
 * This file runs the real `CAPTCHA_SCAN_EXPRESSION` in a `node:vm` sandbox
 * against a fake DOM that actually scrolls (the plan11-captcha-page.spec
 * pattern, extended with document coordinates + a real scroll model), so the
 * published rect is compared against where the element genuinely IS once the
 * scan is done. Three grounds:
 *   - scrollable        — the reported box must match the element's real
 *                         position, and aiming at it must hit the element;
 *   - non-scrolling     — the existing page script behaviour must not shift;
 *   - restore refused   — `scrollRestored:false` + a render warning, never a
 *                         confident box.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_SCAN_EXPRESSION,
  CAPTCHA_VERIFY_EXPRESSION,
  classifyCandidates,
  collectSolutionSignals,
  parseScanReply,
  parseSliderRow,
  parseVerifyReply,
  renderCaptcha,
  type CaptchaCandidate,
  type CaptchaScanRecord,
} from '../src/captcha.ts'

// ---------------------------------------------------------------------------
// A fake DOM with DOCUMENT coordinates — the page-side script's boxes are
// client coordinates, so a fixture that never moves its boxes can never catch
// a scroll-axis bug. `scrollIntoView` here really moves the view.
// ---------------------------------------------------------------------------

interface FakeBox {
  x: number
  y: number
  width: number
  height: number
  /** A real DOMRect always carries the four edges; the scan reads bottom/right. */
  left?: number
  top?: number
  right?: number
  bottom?: number
}

interface FakeOptions {
  tag?: string
  id?: string
  cls?: string
  /** Document-space box (NOT viewport space). */
  box: FakeBox
  style?: Record<string, string>
  attrs?: Record<string, string>
  text?: string
  children?: FakeElement[]
  /** What sits on top of this element at its centre. */
  coveredBy?: FakeElement | null
}

interface ScrollView {
  innerWidth: number
  innerHeight: number
  scrollX: number
  scrollY: number
  maxScrollY: number
  /** false ⇒ the ground never scrolls (the pre-existing fixture's shape). */
  scrollIntoViewWorks: boolean
  /** false ⇒ the page refuses `scrollTo` (the restore cannot be undone). */
  scrollToWorks: boolean
  scrollTo: (x: number, y: number) => void
  getComputedStyle: (node: FakeElement) => Record<string, string>
}

interface FakeElement {
  localName: string
  nodeType: number
  id: string
  className: string
  box: FakeBox
  style: Record<string, string>
  attrs: Record<string, string>
  text: string
  innerText: string
  children: FakeElement[]
  parentElement: FakeElement | null
  ownerDocument: FakeDocument | null
  coveredBy: FakeElement | null
  view: ScrollView | null
  scrollCalls: number
  getBoundingClientRect: () => FakeBox
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
  contains: (node: FakeElement | null) => boolean
  closest: (selector: string) => FakeElement | null
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector: string) => FakeElement[]
  scrollIntoView: () => void
}

interface FakeDocument {
  querySelectorAll: (selector: string) => FakeElement[]
  querySelector: (selector: string) => FakeElement | null
  elementFromPoint: (x: number, y: number) => FakeElement | null
  defaultView: ScrollView
  all: FakeElement[]
  scrollCalls: () => number
}

/** A real `getComputedStyle` exposes both spellings; the scan reads camelCase. */
function computedStyleOf(node: FakeElement): Record<string, string> {
  const camel = (kebab: string): string => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  const style: Record<string, string> = { ...node.style }
  for (const key of Object.keys(node.style)) {
    const alias = camel(key)
    if (alias !== key && style[alias] === undefined) style[alias] = node.style[key] ?? ''
  }
  return style
}

/** Build one fake element whose rect is the document box MINUS the view scroll. */
function el(options: FakeOptions): FakeElement {
  const node = {
    localName: options.tag ?? 'div',
    nodeType: 1,
    id: options.id ?? '',
    className: options.cls ?? '',
    box: options.box,
    style: {
      position: 'static',
      opacity: '1',
      'pointer-events': 'auto',
      'z-index': 'auto',
      visibility: 'visible',
      display: 'block',
      ...options.style,
    },
    attrs: options.attrs ?? {},
    text: options.text ?? '',
    children: options.children ?? [],
    parentElement: null as FakeElement | null,
    ownerDocument: null as FakeDocument | null,
    coveredBy: options.coveredBy ?? null,
    view: null as ScrollView | null,
    scrollCalls: 0,
  } as unknown as FakeElement
  node.innerText = node.text
  Object.defineProperty(node, 'textContent', { get: () => node.text, configurable: true })
  node.getBoundingClientRect = function getBoundingClientRect(): FakeBox {
    const view = this.view
    const ox = view === null ? 0 : view.scrollX
    const oy = view === null ? 0 : view.scrollY
    return {
      x: this.box.x - ox,
      y: this.box.y - oy,
      width: this.box.width,
      height: this.box.height,
      left: this.box.x - ox,
      top: this.box.y - oy,
      right: this.box.x - ox + this.box.width,
      bottom: this.box.y - oy + this.box.height,
    }
  }
  node.getAttribute = (name: string): string | null => {
    if (name === 'id') return node.id === '' ? null : node.id
    if (name === 'class') return node.className === '' ? null : node.className
    return Object.prototype.hasOwnProperty.call(node.attrs, name) ? String(node.attrs[name]) : null
  }
  node.hasAttribute = (name: string): boolean => node.getAttribute(name) !== null
  node.contains = (other: FakeElement | null): boolean => {
    if (other === null) return false
    let cursor: FakeElement | null = other
    while (cursor !== null) {
      if (cursor === node) return true
      cursor = cursor.parentElement
    }
    return false
  }
  node.closest = (selector: string): FakeElement | null => {
    let cursor: FakeElement | null = node
    while (cursor !== null) {
      if (matches(cursor, selector)) return cursor
      cursor = cursor.parentElement
    }
    return null
  }
  node.querySelectorAll = (selector: string): FakeElement[] =>
    flatten(node.children).filter(child => matches(child, selector))
  node.querySelector = (selector: string): FakeElement | null =>
    node.querySelectorAll(selector)[0] ?? null
  // A real scrollIntoView({block:'center'}) puts the element's middle at the
  // viewport's middle. That is the whole point of the fixture: the probe moves
  // the page, so a box measured before/after the move differs by the offset.
  node.scrollIntoView = (): void => {
    node.scrollCalls += 1
    const view = node.view
    if (view === null || !view.scrollIntoViewWorks) return
    const centered = node.box.y + node.box.height / 2 - view.innerHeight / 2
    view.scrollY = Math.max(0, Math.min(Math.round(centered), view.maxScrollY))
  }
  for (const child of node.children) child.parentElement = node
  return node
}

/** Walk the tree depth-first, parents before children. */
function walk(node: FakeElement, out: FakeElement[] = []): FakeElement[] {
  out.push(node)
  for (const child of node.children) walk(child, out)
  return out
}

function flatten(roots: FakeElement[]): FakeElement[] {
  const out: FakeElement[] = []
  for (const root of roots) walk(root, out)
  return out
}

/** Split a selector list on top-level commas. */
function parts(selector: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of selector) {
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
    if (char === ',' && depth === 0) { out.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

function matchesOne(node: FakeElement, selector: string): boolean {
  if (selector === 'body *') return node.localName !== 'body'
  for (const [prefix, value] of [...selector.matchAll(/([#.])([\w-]+)/g)].map(m => [m[1]!, m[2]!] as const)) {
    const ok = prefix === '#'
      ? node.id === value
      : node.className.toLowerCase().split(/\s+/).includes(value.toLowerCase())
    if (!ok) return false
  }
  const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1]
  if (tag !== undefined && node.localName !== tag.toLowerCase()) return false
  const rest = selector.slice(tag?.length ?? 0)
  for (const part of rest.matchAll(/\[([\w-]+)(?:([~^$*]?=)"?([^"\]]*)"?\s*(i)?)?\]/g)) {
    const [, name, operator, value, flag] = part
    if (name === undefined) continue
    if (operator === undefined) {
      if (!node.hasAttribute(name)) return false
      continue
    }
    if (name === 'class' && operator === '*=') {
      const needle = (value ?? '').toLowerCase()
      if (!node.className.toLowerCase().includes(needle)) return false
      continue
    }
    if (name === 'style' && operator === '*=') {
      if (!String(node.attrs.style ?? '').includes(value ?? '')) return false
      continue
    }
    const actual = node.getAttribute(name) ?? ''
    const equal = flag === 'i' ? actual.toLowerCase() === String(value ?? '').toLowerCase() : actual === value
    if (operator === '=' && !equal) return false
  }
  return true
}

function matches(node: FakeElement, selector: string): boolean {
  return parts(selector).some(part => matchesOne(node, part))
}

interface GroundOptions {
  /** false ⇒ the page cannot be scrolled at all (the old fixture's shape). */
  scrollable?: boolean
  /** false ⇒ `scrollTo` is ignored, so the scan cannot undo its own probe. */
  restorable?: boolean
  width?: number
  height?: number
  docHeight?: number
}

/** Compose a document over a set of root elements, with a real scroll model. */
function makeDocument(roots: FakeElement[], options: GroundOptions = {}): FakeDocument {
  const width = options.width ?? 754
  const height = options.height ?? 480
  const all = flatten(roots)
  const view: ScrollView = {
    innerWidth: width,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    maxScrollY: Math.max(0, (options.docHeight ?? 0) - height),
    scrollIntoViewWorks: options.scrollable !== false,
    scrollToWorks: options.restorable !== false,
    scrollTo: () => {},
    getComputedStyle: (node: FakeElement) => computedStyleOf(node),
  }
  view.scrollTo = (x: number, y: number): void => {
    if (!view.scrollToWorks) return
    view.scrollX = Math.max(0, Math.min(Math.round(x), view.maxScrollY))
    view.scrollY = Math.max(0, Math.min(Math.round(y), view.maxScrollY))
  }
  const doc: FakeDocument = {
    all,
    defaultView: view,
    querySelectorAll: (selector: string) => doc.all.filter(node => matches(node, selector)),
    querySelector: (selector: string) => doc.all.find(node => matches(node, selector)) ?? null,
    // A real elementFromPoint returns the TOPMOST box under the point. `all` is
    // parents-before-children, so the last hit is the deepest one.
    elementFromPoint: (x: number, y: number): FakeElement | null => {
      let found: FakeElement | null = null
      for (const node of doc.all) {
        const box = node.getBoundingClientRect()
        if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) found = node
      }
      return found === null ? null : (found.coveredBy ?? found)
    },
    scrollCalls: () => doc.all.reduce((total, node) => total + node.scrollCalls, 0),
  }
  for (const node of all) { node.ownerDocument = doc; node.view = view }
  return doc
}

/** Run an expression in a fresh sandbox wired to `doc`. */
function runScript(expression: string, doc: FakeDocument): unknown {
  const sandbox: Record<string, unknown> = {
    document: doc,
    location: { href: 'https://fixture.test/kaydirilabilir.html', hostname: 'fixture.test' },
    window: doc.defaultView,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Boolean,
    RegExp,
    Set,
    Infinity,
    NaN,
  }
  sandbox.globalThis = sandbox
  return runInContext(expression, createContext(sandbox))
}

// ---------------------------------------------------------------------------
// The scrollable challenge page — 3x the viewport, two candidates below the fold
// ---------------------------------------------------------------------------

const VIEWPORT_HEIGHT = 480

/** The T-shaped page the live agent measured, rebuilt with document coordinates. */
function scrollablePage(options: GroundOptions = {}): { doc: FakeDocument, byId: Record<string, FakeElement> } {
  // A plain headline that owns the Y where a scrolled probe would publish a
  // box. It carries no candidate signature, so it is only ever a CLICK TARGET.
  const headline = el({
    tag: 'h2', id: 'wrong-target', box: { x: 40, y: 180, width: 400, height: 60 },
    text: 'Reklam başlığı',
  })
  const above = el({
    id: 'v6-real', box: { x: 82, y: 60, width: 657, height: 56 },
    attrs: { role: 'checkbox', 'aria-checked': 'false', tabindex: '0' },
    text: 'Onay kutusu',
  })
  // 1117 / 1639 / 1882 are the REAL positions the live run measured.
  const belowOne = el({
    id: 'v9', box: { x: 66, y: 1117, width: 664, height: 56 },
    attrs: { role: 'checkbox', 'aria-checked': 'false', tabindex: '0' },
    text: 'İkinci onay',
  })
  const belowTwo = el({
    id: 'v11', cls: 'v11-track', box: { x: 66, y: 1639, width: 664, height: 40 },
    attrs: { 'data-target': '72' },
  })
  const cover = el({
    id: 'v11-cover', cls: 'v5-cover', box: { x: 60, y: 1876, width: 664, height: 60 },
    style: { position: 'absolute', 'z-index': '150' },
  })
  const submit = el({
    tag: 'button', cls: 'v11-submit', id: 'v11-btn', box: { x: 80, y: 1882, width: 120, height: 30 },
    attrs: { type: 'submit' }, text: 'Onayla', coveredBy: cover,
  })
  const body = el({
    tag: 'body', box: { x: 0, y: 0, width: 754, height: 1440 },
    children: [above, headline, belowOne, belowTwo, cover, submit],
  })
  const doc = makeDocument([body], { docHeight: 1440, ...options })
  return { doc, byId: { above, headline, belowOne, belowTwo, cover, submit, 'v6-real': above, v9: belowOne, v11: belowTwo, 'v11-btn': submit } }
}

/** Read the scan reply and run it through the host-side pure engine. */
function scan(doc: FakeDocument): {
  parsed: ReturnType<typeof parseScanReply>
  records: CaptchaScanRecord[]
  candidates: CaptchaCandidate[]
} {
  const parsed = parseScanReply(runScript(CAPTCHA_SCAN_EXPRESSION, doc) as string)
  return { parsed, records: [...parsed.records], candidates: classifyCandidates(parsed.records) }
}

/** The candidate row the envelope publishes for one element. */
function candidateOf(candidates: readonly CaptchaCandidate[], id: string): CaptchaCandidate {
  const found = candidates.find(candidate => candidate.id === id)
  expect(found, `candidate ${id} must be in the scan`).toBeDefined()
  return found!
}

/** Render a scan envelope the way the tool hands it to the model. */
function renderScan(candidates: readonly CaptchaCandidate[]): string {
  return renderCaptcha({
    ok: true,
    action: 'scan',
    found: candidates.length,
    targetId: 'tab-1',
    url: 'https://fixture.test/kaydirilabilir.html',
    warnings: [],
    candidates,
    overlays: [],
    honeypots: [],
    thirdParty: { verdict: 'first-party', iframes: [], providers: [] },
  }).map(part => part.text).join('\n')
}

// ---------------------------------------------------------------------------
// Ground 1 — a page that really scrolls (the live bug)
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-rect: a page that scrolls', () => {
  it('publishes the box the element ACTUALLY occupies, not the probe position', () => {
    const { doc, byId } = scrollablePage()
    const { candidates } = scan(doc)
    // The scan must have scrolled to probe the below-the-fold candidates…
    expect(doc.scrollCalls()).toBeGreaterThan(0)
    // …and put the page back where it found it.
    expect(doc.defaultView.scrollY).toBe(0)
    for (const id of ['v6-real', 'v9', 'v11', 'v11-btn']) {
      const published = candidateOf(candidates, id).rect
      const truth = byId[id]!.getBoundingClientRect()
      // The published box is compared against a FRESH measurement taken after
      // the scan, i.e. the position a click at that box would resolve against.
      expect(published.x, `${id} x`).toBeCloseTo(truth.x, 5)
      expect(published.y, `${id} y`).toBeCloseTo(truth.y, 5)
      expect(published.width, `${id} w`).toBeCloseTo(truth.width, 5)
      expect(published.height, `${id} h`).toBeCloseTo(truth.height, 5)
    }
    // The exact live numbers: 1117 / 1639 / 1882 — never the 416 / 544 / 788
    // a centred probe used to publish.
    expect(candidateOf(candidates, 'v9').rect.y).toBe(1117)
    expect(candidateOf(candidates, 'v11').rect.y).toBe(1639)
    expect(candidateOf(candidates, 'v11-btn').rect.y).toBe(1882)
  })

  it('lands an aim at the published box on the element itself', () => {
    const { doc, byId } = scrollablePage()
    const { candidates } = scan(doc)
    for (const id of ['v6-real', 'v9', 'v11']) {
      const rect = candidateOf(candidates, id).rect
      const aimed = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      expect(aimed?.id, `aiming at ${id}'s published box`).toBe(id)
    }
    // The live symptom, pinned: a centred probe published #v9 at the viewport
    // middle, which is the headline's box once the page is back at scrollY=0.
    // The headline must be reachable ONLY through that wrong number, never
    // through a box the tool published.
    const probeY = VIEWPORT_HEIGHT / 2 - byId.v9!.box.height / 2
    expect(doc.elementFromPoint(byId.v9!.box.x + byId.v9!.box.width / 2, probeY)?.id).toBe('wrong-target')
  })

  it('keeps the classification honest and never fabricates an occluder', () => {
    const { doc } = scrollablePage()
    const { candidates } = scan(doc)
    // Off-screen stays off-screen — the verdict was already right.
    expect(candidateOf(candidates, 'v9').hitTest).toBe('not-in-viewport')
    expect(candidateOf(candidates, 'v9').inViewport).toBe(false)
    // The in-viewport candidate is unaffected.
    expect(candidateOf(candidates, 'v6-real').hitTest).toBe('pass')
    // A hit test taken while the page was scrolled describes a DIFFERENT
    // position than the box published beside it, so no `blockedBy` is invented
    // for it — not even where the probe really did find an occluder.
    expect(candidateOf(candidates, 'v11-btn').blockedBy).toBe('')
    expect(candidateOf(candidates, 'v9').blockedBy).toBe('')
    expect(renderScan(candidates)).not.toContain('covered by')
  })

  it('carries the scroll offset the box is valid at, and the restore verdict', () => {
    const { doc } = scrollablePage()
    const { candidates } = scan(doc)
    for (const id of ['v6-real', 'v9', 'v11', 'v11-btn']) {
      const candidate = candidateOf(candidates, id)
      expect(candidate.measuredAtScrollY, `${id} measuredAtScrollY`).toBe(0)
      expect(candidate.scrollRestored, `${id} scrollRestored`).toBe(true)
    }
  })

  it('warns on the box itself that an off-screen rect must be re-measured', () => {
    const { doc } = scrollablePage()
    const { candidates } = scan(doc)
    const rendered = renderScan(candidates)
    // The warning rides the off-viewport rows, naming the offset it is valid at.
    const warned = rendered.split('\n').filter(line => line.includes('RE-MEASURE before clicking'))
    const offScreen = candidates.filter(candidate => !candidate.inViewport)
    expect(offScreen.length).toBeGreaterThan(1)
    expect(warned).toHaveLength(offScreen.length)
    expect(warned.every(line => line.includes('scrollY=0'))).toBe(true)
    // The in-viewport candidate gets no warning — it is clickable as printed.
    const live = rendered.split('\n').findIndex(line => line.includes('div#v6-real'))
    expect(rendered.split('\n').slice(live, live + 2).join('\n')).not.toContain('RE-MEASURE')
  })
})

// ---------------------------------------------------------------------------
// Ground 2 — a page that cannot scroll (regression: existing behaviour)
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-rect: a page that does not scroll', () => {
  it('leaves an in-viewport candidate byte-identical and clickable', () => {
    const { doc, byId } = scrollablePage({ scrollable: false })
    const { parsed, candidates } = scan(doc)
    expect(parsed.ok).toBe(true)
    const above = candidateOf(candidates, 'v6-real')
    expect(above.rect).toEqual({ x: 82, y: 60, width: 657, height: 56 })
    expect(above.hitTest).toBe('pass')
    expect(above.hitIsTarget).toBe(true)
    expect(above.blockedBy).toBe('')
    expect(above.driftPx).toBe(0)
    expect(above.measuredAtScrollY).toBe(0)
    expect(above.scrollRestored).toBe(true)
    // …and the page never moved while proving it.
    expect(doc.defaultView.scrollY).toBe(0)
    expect(byId.above!.getBoundingClientRect().y).toBe(60)
    const aimed = doc.elementFromPoint(82 + 657 / 2, 60 + 56 / 2)
    expect(aimed?.id).toBe('v6-real')
  })

  it('reports the below-the-fold boxes at their own position, not a clamped probe', () => {
    const { doc } = scrollablePage({ scrollable: false })
    const { candidates } = scan(doc)
    // Nothing moved, so the rect is the one the page actually has — and the
    // classification still says the box is off-screen.
    expect(candidateOf(candidates, 'v9').rect).toEqual({ x: 66, y: 1117, width: 664, height: 56 })
    expect(candidateOf(candidates, 'v9').hitTest).toBe('not-in-viewport')
    // The page never moved, so the box is valid where the page is.
    expect(candidateOf(candidates, 'v9').measuredAtScrollY).toBe(0)
    expect(candidateOf(candidates, 'v9').scrollRestored).toBe(true)
  })

  it('names the occluder of an IN-VIEWPORT covered candidate (unchanged)', () => {
    const cover = el({ id: 'live-cover', cls: 'cover', box: { x: 40, y: 200, width: 300, height: 40 }, style: { position: 'absolute', 'z-index': '150' } })
    const button = el({
      tag: 'button', id: 'live-btn', box: { x: 60, y: 210, width: 120, height: 30 },
      attrs: { type: 'submit' }, text: 'Gönder', coveredBy: cover,
    })
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 400 }, children: [cover, button] })
    const { candidates } = scan(makeDocument([body], { docHeight: 400, scrollable: false }))
    const covered = candidateOf(candidates, 'live-btn')
    expect(covered.hitTest).toBe('covered')
    expect(covered.blockedBy).toContain('live-cover')
    expect(renderScan(candidates)).toContain('covered by')
    // An in-viewport row is clickable as printed: no re-measure warning.
    expect(renderScan(candidates)).not.toContain('RE-MEASURE')
  })
})

// ---------------------------------------------------------------------------
// Ground 3 — the page refuses the restore (the loud failure, not a quiet one)
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-rect: a page that refuses the restore', () => {
  it('says the scroll was not restored instead of printing a confident box', () => {
    const { doc } = scrollablePage({ restorable: false })
    const { candidates } = scan(doc)
    const below = candidateOf(candidates, 'v9')
    const node = doc.all.find(entry => entry.id === 'v9')!
    // The probe really moved the page and the page really ignored scrollTo.
    expect(doc.defaultView.scrollY).toBeGreaterThan(0)
    expect(below.scrollRestored).toBe(false)
    // The box still describes a real position — and the offset it belongs to
    // is published beside it, so "where is this" has an answer either way.
    expect(below.measuredAtScrollY).toBeGreaterThan(0)
    expect(below.rect.y).toBeCloseTo(node.box.y - below.measuredAtScrollY!, 5)
    const rendered = renderScan(candidates)
    expect(rendered).toContain('could NOT restore the page scroll')
    expect(rendered).toContain('RE-MEASURE before clicking')
  })
})

// ---------------------------------------------------------------------------
// plan11-fix-derived — the `derived` slider channel could not read a moved thumb
// ---------------------------------------------------------------------------

describe('plan11-fix-derived: the thumb-box reconstruction', () => {
  const TRACK_X = 60
  const TRACK_WIDTH = 300
  const THUMB_WIDTH = 30
  const TRAVEL = TRACK_WIDTH - THUMB_WIDTH

  /** A `[data-target]` track whose thumb sits `pct` of the travel from rest. */
  function thumbAt(pct: number): FakeDocument {
    const thumb = el({
      id: 't-thumb', cls: 't-thumb', box: { x: TRACK_X + (pct / 100) * TRAVEL, y: 206, width: THUMB_WIDTH, height: 28 },
    })
    const track = el({
      id: 't-track', cls: 't-track', box: { x: TRACK_X, y: 200, width: TRACK_WIDTH, height: 40 },
      attrs: { 'data-target': '72' }, children: [thumb],
    })
    return makeDocument([el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 1200 }, children: [track] })], { scrollable: false })
  }

  /** Run the real page-side verify probe and parse the slider row it reports. */
  function rowAt(pct: number): string {
    const parsed = parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, thumbAt(pct)) as string)
    expect(parsed.ok, parsed.reason).toBe(true)
    return parsed.record.sliders[0]!
  }

  it('reads a TRAVELLED thumb as the position it is actually at', () => {
    // The live T9 measurement: `drag` delivered 67.93% while `verify` reported
    // 0. The old formula clamped that same offset into an inset and subtracted
    // it, so a thumb on the right half produced (d - travel/2) over a usable of
    // 0 — the channel could not answer anything but 0 or nothing.
    const parsed = parseSliderRow(rowAt(67.93))!
    expect(parsed.source).toBe('derived')
    expect(parsed.value).toBeCloseTo(67.93, 1)
    expect(parsed.value).not.toBe(0)
    // The warning that source label feeds is live code now, not dead.
    const signals = collectSolutionSignals(parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, thumbAt(67.93)) as string).record)
    expect(signals.warnings.join(' ')).toContain('reconstructed from the thumb')
  })

  it('still reads a thumb AT REST as zero, and never as unavailable', () => {
    const parsed = parseSliderRow(rowAt(0))!
    expect(parsed.source).toBe('derived')
    expect(parsed.value).toBe(0)
    expect(parsed.target).toBe(72)
  })

  it('reports the source as a channel name, with the value in its own field', () => {
    // plan11-fix-derived: the source used to arrive as 'derived:0', which
    // matched no member of SliderValueSource.
    const row = rowAt(50)
    expect(row).toBe('#t-track=derived:50(72)')
    expect(parseSliderRow(row)?.source).toBe('derived')
    expect(parseSliderRow(row)?.value).toBe(50)
  })

  it('keeps the older id=value(target) row readable instead of guessing a channel', () => {
    expect(parseSliderRow('#v2-track=72(72)')).toEqual({ id: '#v2-track', source: 'unknown', value: 72, target: 72 })
    expect(parseSliderRow('#t-track=unavailable:null(72)')?.value).toBeUndefined()
  })
})
