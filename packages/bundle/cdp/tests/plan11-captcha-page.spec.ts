/**
 * plan11: the PAGE-SIDE scripts, executed for real in a `node:vm` sandbox
 * against a stubbed DOM (the plan07-stealth.spec pattern).
 *
 * T6's detection phase worked, but it worked through hand-written
 * `cdp_exec` scripts — which is exactly what this tool is meant to replace. A
 * page-side script that is only ever a string in a TypeScript file is
 * unverified code: the first failure mode would surface live, mid-captcha. So
 * this file RUNS `CAPTCHA_SCAN_EXPRESSION`, `CAPTCHA_VERIFY_EXPRESSION`, and
 * `buildDragMeasureExpression` here, against a fake DOM that reproduces the T6
 * and T7 shapes (sticky header, cover, chain track, visible honeypot, decoy,
 * in-frame checkbox, a third-party iframe).
 *
 * The third-party frame is exercised as REPORTING: the sandbox page below
 * carries a reCAPTCHA frame, and the assertion is that the scan reports it —
 * never that anything was read out of it.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_SCAN_EXPRESSION,
  CAPTCHA_VERIFY_EXPRESSION,
  buildDragMeasureExpression,
  classifyCandidates,
  classifyHoneypots,
  classifyOverlays,
  classifyRecord,
  collectSolutionSignals,
  parseDragMeasureReply,
  parseScanReply,
  parseSliderRow,
  parseVerifyReply,
  thirdPartyVerdict,
  type CaptchaScanRecord,
} from '../src/captcha.ts'

// ---------------------------------------------------------------------------
// A tiny fake DOM — only what the scan expression actually touches
// ---------------------------------------------------------------------------

interface FakeBox {
  x: number
  y: number
  width: number
  height: number
  left?: number
  top?: number
  right?: number
  bottom?: number
}

interface FakeOptions {
  tag?: string
  id?: string
  cls?: string
  box: FakeBox
  style?: Record<string, string>
  attrs?: Record<string, string>
  text?: string
  children?: FakeElement[]
  /** What `elementFromPoint` reports at this element's centre. */
  coveredBy?: FakeElement | null
  /** Same-origin document behind an iframe; `null` for a cross-origin frame. */
  contentDocument?: FakeDocument | null
}

interface FakeElement {
  localName: string
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
  contentDocument: FakeDocument | null
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

/**
 * A real `getComputedStyle` exposes BOTH spellings (`style.zIndex` and
 * `getPropertyValue('z-index')`). The scan reads the camelCase ones, so the
 * fake has to carry them too — otherwise the sandbox would silently skip
 * elements a real page would measure.
 */
function computedStyleOf(node: FakeElement): Record<string, string> {
  const camel = (kebab: string): string => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  const style: Record<string, string> = { ...node.style }
  for (const key of Object.keys(node.style)) {
    const alias = camel(key)
    if (alias !== key && style[alias] === undefined) style[alias] = node.style[key] ?? ''
  }
  return style
}

/** Build one fake element with the defaults the expression relies on. */
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
    contentDocument: options.contentDocument ?? null,
    scrollCalls: 0,
  } as unknown as FakeElement
  node.innerText = node.text
  Object.defineProperty(node, 'textContent', { get: () => node.text, configurable: true })
  // A real DOMRect always carries the four edges; the scan reads bottom/right.
  node.getBoundingClientRect = function getBoundingClientRect(): FakeBox {
    return {
      x: this.box.x,
      y: this.box.y,
      width: this.box.width,
      height: this.box.height,
      left: this.box.x,
      top: this.box.y,
      right: this.box.x + this.box.width,
      bottom: this.box.y + this.box.height,
    }
  }
  // A real DOM keeps `el.id` and `getAttribute('id')` in lockstep; the scan
  // reads both, so the fake must too.
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
  node.scrollIntoView = (): void => { node.scrollCalls += 1 }
  for (const child of node.children) child.parentElement = node
  return node
}

interface FakeDocument {
  querySelectorAll: (selector: string) => FakeElement[]
  querySelector: (selector: string) => FakeElement | null
  elementFromPoint: (x: number, y: number) => FakeElement | null
  defaultView: unknown
  title: string
  all: FakeElement[]
  scrollCalls: () => number
}

/** Walk the tree depth-first, parents before children. */
function walk(node: FakeElement, out: FakeElement[] = []): FakeElement[] {
  out.push(node)
  for (const child of node.children) walk(child, out)
  return out
}

/** Flatten a tree to a list. */
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

/**
 * Whether one simple selector matches one element. The scan sends compound
 * lists (`[role=checkbox],[data-target],input[type=range],…`), so the list is
 * split first and each simple selector is evaluated on its own.
 */
function matchesOne(node: FakeElement, selector: string): boolean {
  if (selector === 'body *') return node.localName !== 'body'
  // `#id` and `.class` are real selector syntax the measure expression uses.
  for (const [prefix, value] of [...selector.matchAll(/([#.])([\w-]+)/g)].map(m => [m[1]!, m[2]!] as const)) {
    const ok = prefix === '#'
      ? node.id === value
      : node.className.toLowerCase().split(/\s+/).includes(value.toLowerCase())
    if (!ok) return false
  }
  const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1]
  if (tag !== undefined && node.localName !== tag.toLowerCase()) return false
  const rest = selector.slice(tag?.length ?? 0)
  for (const part of rest.matchAll(/\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?\s*(i)?)?\]/g)) {
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
    const equal = flag === 'i' ? actual.toLowerCase() === String(value).toLowerCase() : actual === value
    if (operator === '=' && !equal) return false
  }
  return true
}

/** Whether a (possibly compound) selector list matches one element. */
function matches(node: FakeElement, selector: string): boolean {
  return parts(selector).some(part => matchesOne(node, part))
}

/** Every element whose centre has another element stacked on top. */
function topAt(all: FakeElement[], x: number, y: number): FakeElement | null {
  for (const node of all) {
    const box = node.getBoundingClientRect()
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
      if (node.coveredBy !== null) return node.coveredBy
    }
  }
  return null
}

/** Compose a document over a set of root elements. */
function makeDocument(options: { roots: FakeElement[], title?: string, width?: number, height?: number }): FakeDocument {
  const width = options.width ?? 754
  const height = options.height ?? 480
  const all = flatten(options.roots)
  const view = {
    innerWidth: width,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    scrollTo: () => {},
    getComputedStyle: (node: FakeElement) => computedStyleOf(node),
  }
  const doc: FakeDocument = {
    title: options.title ?? 'Fixture',
    all,
    defaultView: view,
    // Read `doc.all` through the object, not a captured const, so a test can
    // mutate the tree and see the change.
    querySelectorAll: (selector: string) => doc.all.filter(node => matches(node, selector)),
    querySelector: (selector: string) => doc.all.find(node => matches(node, selector)) ?? null,
    elementFromPoint: (x: number, y: number) => topAt(doc.all, x, y),
    scrollCalls: () => doc.all.reduce((total, node) => total + node.scrollCalls, 0),
  }
  for (const node of all) node.ownerDocument = doc
  return doc
}

/** Run an expression in a fresh sandbox wired to `doc` + `window`. */
function runScript(expression: string, doc: FakeDocument, extra: Record<string, unknown> = {}): unknown {
  const view = doc.defaultView as Record<string, unknown>
  const sandbox: Record<string, unknown> = {
    document: doc,
    location: { href: 'https://fixture.test/dogrulama.html', hostname: 'fixture.test' },
    // A page-shaped `window`: the scan falls back to it for detached nodes, so
    // it carries the same seams the document's view does.
    window: { innerWidth: 754, innerHeight: 480, scrollX: 0, scrollY: 0, scrollTo: () => {}, getComputedStyle: view.getComputedStyle, ...extra },
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Boolean,
    RegExp,
    Infinity,
    NaN,
  }
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  return runInContext(expression, context)
}

// ---------------------------------------------------------------------------
// The fixture page — the T6 + T7 shapes
// ---------------------------------------------------------------------------

/** The T6/T7 fixture: sticky header, checkbox, chain slider, cover, decoy, visible honeypot, in-frame box, reCAPTCHA. */
function challengePage(): { doc: FakeDocument, byId: Record<string, FakeElement> } {
  const header = el({
    tag: 'header', box: { x: 0, y: 0, width: 754, height: 52 },
    style: { position: 'sticky', 'z-index': '200' },
  })
  const checkbox = el({
    id: 'v1-box', box: { x: 82, y: 228, width: 657, height: 56 },
    style: { position: 'relative' },
    attrs: { role: 'checkbox', 'aria-checked': 'false', tabindex: '0' },
    text: 'Onay kutusu',
  })
  const thumb = el({ id: 'v2-thumb', cls: 'v2-thumb', box: { x: 69, y: 303, width: 34, height: 34 } })
  const track = el({
    id: 'v2-track', cls: 'v2-track', box: { x: 66, y: 300, width: 664, height: 40 },
    attrs: { 'data-target': '72' }, children: [thumb],
  })
  const cover = el({
    id: 'v5-cover', cls: 'v5-cover', box: { x: 66, y: 380, width: 664, height: 60 },
    style: { position: 'absolute' },
  })
  const delayedButton = el({
    tag: 'button', id: 'v5-btn', box: { x: 80, y: 395, width: 120, height: 30 },
    attrs: { type: 'submit' }, text: 'Onayla', coveredBy: cover,
  })
  const decoy = el({
    id: 'v10-decoy', box: { x: 60, y: 700, width: 600, height: 60 },
    attrs: { 'data-decoy': '1' }, text: 'Ben robot değilim (SAHTE)',
  })
  const honeypot = el({
    tag: 'input', id: 'v11-url', box: { x: 60, y: 820, width: 600, height: 38 },
    style: { position: 'static', opacity: '0.01' },
    attrs: { name: 'url', tabindex: '0', type: 'text' },
  })
  const name = el({ tag: 'input', id: 'v11-name', box: { x: 60, y: 760, width: 600, height: 38 }, attrs: { name: 'name', type: 'text' } })
  const form = el({ tag: 'form', id: 'v11-form', box: { x: 40, y: 740, width: 640, height: 180 }, attrs: { 'data-solved': '0' }, children: [name, honeypot] })
  const step = el({
    id: 'v6-s1', cls: 'step', box: { x: 60, y: 60, width: 640, height: 60 },
    attrs: { 'data-done': '0' }, children: [el({ id: 'v6-track', box: { x: 66, y: 66, width: 600, height: 40 }, attrs: { 'data-target': '68' } })],
  })
  const frameBody = el({
    id: 'inner-box', box: { x: 20, y: 20, width: 400, height: 40 },
    attrs: { role: 'checkbox', 'aria-checked': 'false' },
  })
  const innerDoc = makeDocument({ roots: [frameBody], title: 'inner' })
  const frame = el({ tag: 'iframe', id: 'v8-frame', box: { x: 60, y: 900, width: 600, height: 190 }, attrs: { title: 'iç doğrulama', src: 'https://fixture.test/v8' } })
  frame.contentDocument = innerDoc
  const recaptcha = el({
    tag: 'iframe', id: 'rc', box: { x: 60, y: 1100, width: 300, height: 80 },
    attrs: { src: 'https://www.google.com/recaptcha/api2/anchor' },
  })

  const body = el({
    tag: 'body', box: { x: 0, y: 0, width: 754, height: 2000 },
    children: [header, step, checkbox, track, cover, delayedButton, decoy, form, frame, recaptcha],
  })
  const doc = makeDocument({ roots: [body] })
  return { doc, byId: { checkbox, track, thumb, cover, honeypot, decoy, header, frameBody } }
}

/** Read the scan reply and re-run it through the host-side pure engine. */
function scan(page: ReturnType<typeof challengePage>): {
  parsed: ReturnType<typeof parseScanReply>,
  records: CaptchaScanRecord[],
  candidates: ReturnType<typeof classifyCandidates>,
} {
  const raw = runScript(CAPTCHA_SCAN_EXPRESSION, page.doc) as string
  const parsed = parseScanReply(raw)
  return {
    parsed,
    records: [...parsed.records],
    candidates: classifyCandidates(parsed.records),
  }
}

/** The same sweep over an arbitrary document (the negative-precision grounds). */
function scanOn(doc: FakeDocument): ReturnType<typeof scan> {
  const raw = runScript(CAPTCHA_SCAN_EXPRESSION, doc) as string
  const parsed = parseScanReply(raw)
  return { parsed, records: [...parsed.records], candidates: classifyCandidates(parsed.records) }
}

/**
 * The CAPTCHA-less ground, rebuilt from the live 127.0.0.1:5177 measurement that
 * produced five false-positive `multi-step` candidates: a fixed progress bar, a
 * fixed nav header, and animated `span.line` headline fragments that carry
 * transforms. None of it is a challenge, and the scan must say so.
 */
function marketingPage(): FakeDocument {
  const line = el({
    tag: 'span', cls: 'line', box: { x: 40, y: 200, width: 320, height: 18 },
    style: { position: 'relative', transform: 'translateY(8px)', transition: 'transform 0.4s' },
  })
  const title = el({
    tag: 'h2', cls: 'cta__title', box: { x: 40, y: 180, width: 400, height: 60 },
    children: [line],
  })
  const progress = el({
    cls: 'progress', box: { x: 0, y: 0, width: 754, height: 4 },
    style: { position: 'fixed', 'z-index': '120' },
  })
  const nav = el({
    tag: 'header', id: 'nav', box: { x: 0, y: 0, width: 754, height: 56 },
    style: { position: 'fixed', 'z-index': '100' },
  })
  const body = el({
    tag: 'body', box: { x: 0, y: 0, width: 754, height: 2000 },
    children: [nav, progress, title],
  })
  return makeDocument({ roots: [body] })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan11 page script: the scan sweep', () => {
  it('runs in a bare sandbox and returns a parseable reply', () => {
    const page = challengePage()
    const { parsed } = scan(page)
    expect(parsed.ok).toBe(true)
    expect(parsed.reason).toBe('')
    expect(parsed.url).toBe('https://fixture.test/dogrulama.html')
    expect(parsed.host).toBe('fixture.test')
    expect(parsed.records.length).toBeGreaterThan(0)
  })

  it('finds the T6 sticky header through the COMPUTED overlay pass', () => {
    const { parsed } = scan(challengePage())
    const overlays = classifyOverlays(parsed.overlays)
    // The sticky header carries no overlay class — only the computed-style
    // pass can name it. That is T6's 52px header finding.
    const header = overlays.find(overlay => overlay.position === 'sticky')
    expect(header).toBeDefined()
    expect(header?.source).toBe('computed')
    expect(header?.zIndex).toBe('200')
    expect(header?.rect.height).toBe(52)
    expect(overlays.some(overlay => overlay.source === 'signature')).toBe(true)
  })

  it('finds the T6 cover by its class signature and flags it as blocking', () => {
    const { parsed } = scan(challengePage())
    const overlays = classifyOverlays(parsed.overlays)
    const cover = overlays.find(overlay => overlay.id === 'v5-cover')
    expect(cover).toBeDefined()
    expect(cover?.source).toBe('signature')
    expect(cover?.blocking).toBe(true)
  })

  it('classifies the whole T6/T7 challenge set from the real page script', () => {
    const { candidates } = scan(challengePage())
    const kindOf = (id: string): string | undefined =>
      candidates.find(candidate => candidate.id === id)?.kind
    expect(kindOf('v1-box')).toBe('checkbox')
    expect(kindOf('v2-track')).toBe('slider')
    expect(kindOf('v5-cover')).toBe('delayed-confirm')
    expect(kindOf('v6-s1')).toBe('multi-step')
    expect(kindOf('v6-track')).toBe('slider')
    expect(kindOf('v10-decoy')).toBe('decoy')
    expect(kindOf('v11-url')).toBe('visible-honeypot')
    expect(kindOf('v11-name')).toBe('form-field')
  })

  it('reports the in-frame checkbox as iframe-internal, not a top-level checkbox', () => {
    const { candidates } = scan(challengePage())
    const inner = candidates.find(candidate => candidate.id === 'inner-box')
    expect(inner?.kind).toBe('iframe-internal')
    expect(inner?.frame).toBe('frame:iç doğrulama')
  })

  it('names the occluder on a covered candidate (the K3 hit test)', () => {
    const { candidates } = scan(challengePage())
    const covered = candidates.find(candidate => candidate.id === 'v5-btn')
    expect(covered?.hitIsTarget).toBe(false)
    expect(covered?.hitTest).toBe('covered')
    expect(covered?.blockedBy).toContain('v5-cover')
  })

  it('runs the K2 scroll → re-measure round trip and restores the scroll', () => {
    const page = challengePage()
    expect(page.doc.scrollCalls()).toBe(0)
    scan(page)
    // The frame and the reCAPTCHA rows sit far below the fold, so the scan
    // scrolled something into view — and then put the scroll back.
    expect(page.doc.scrollCalls()).toBeGreaterThan(0)
  })

  it('inventories the VISIBLE honeypot the naive invisible-input scan misses', () => {
    const { parsed } = scan(challengePage())
    const traps = classifyHoneypots(parsed.records)
    const visible = traps.find(trap => trap.id === 'v11-url')
    expect(visible?.kind).toBe('visible-honeypot')
    expect(visible?.focusable).toBe(true)
    // A normal form field next to it is NOT a trap.
    expect(traps.find(trap => trap.id === 'v11-name')).toBeUndefined()
  })

  it('reports a third-party frame and never walks into it', () => {
    const { parsed } = scan(challengePage())
    const verdict = thirdPartyVerdict(parsed.frames, parsed.host)
    expect(verdict.verdict).toBe('third-party-present')
    expect(verdict.providers).toContain('recaptcha')
    expect(verdict.reason).toContain('reported alongside the candidates')
    // The scan must NOT have produced a candidate from inside the provider.
    const { candidates } = scan(challengePage())
    expect(candidates.some(candidate => candidate.frame.includes('rc'))).toBe(false)
  })

  it('reads no token/attribute out of the third-party frame', () => {
    const { parsed } = scan(challengePage())
    const rc = parsed.frames.find(frame => frame.id === 'rc')
    expect(rc?.accessible).toBe(false)
    // Only provenance is reported: src, id, title, and whether it was readable.
    expect(Object.keys(rc ?? {}).sort()).toEqual(['accessible', 'id', 'src', 'title'])
  })

  it('PRECISION: a page with NO challenge yields zero candidates, not a page full of guesses', () => {
    // A live T7 run against a CAPTCHA-less SPA reported five 'multi-step'
    // candidates — animated `span.line` headline fragments and a `div.progress`
    // bar. A missing challenge must read as MISSING (the service turns found:0
    // into candidates: [] + a reason), never dressed up as five findings.
    const { parsed } = scanOn(marketingPage())
    const candidates = classifyCandidates(parsed.records)
    expect(candidates).toEqual([])
    expect(parsed.records.filter(row => row.chainStep)).toEqual([])
    // The overlay inventory still reports the layout it saw — that is data, not
    // a false positive.
    const overlays = classifyOverlays(parsed.overlays)
    expect(overlays.some(overlay => overlay.position === 'fixed')).toBe(true)
  })

  it('PRECISION: a lone data-done step is not a chain on its own', () => {
    const step = el({
      id: 'only-step', cls: 'step', box: { x: 0, y: 0, width: 400, height: 40 },
      attrs: { 'data-done': '0' },
    })
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 400 }, children: [step] })
    const { parsed } = scanOn(makeDocument({ roots: [body] }))
    const stepRecord = parsed.records.find(row => row.id === 'only-step')
    expect(stepRecord).toBeDefined()
    // One step, no sibling, no challenge inside ⇒ not a chain.
    expect(stepRecord?.chainStep).toBe(false)
    expect(classifyRecord(stepRecord!).kind).not.toBe('multi-step')
  })

  it('names the T7 V7 dynamic target from its LAYOUT, not from a class name', () => {
    // The live V7 element carries no data-* at all: position:absolute, an inline
    // left in PERCENT (getComputedStyle().left is always px), a `transition: left`
    // rule, inside a relative parent.
    const marker = el({
      id: 'v7-target', cls: 'v7-target', box: { x: 103, y: 100, width: 44, height: 44 },
      style: { position: 'absolute', 'left': '16%', transition: 'left 0.3s' },
      attrs: { style: 'left: 16%' },
    })
    const card = el({
      id: 'v7', tag: 'section', cls: 'card', box: { x: 60, y: 60, width: 600, height: 200 },
      style: { position: 'relative' },
      attrs: { 'data-variant': 'dynamic-target' },
      children: [marker],
    })
    const doc = makeDocument({ roots: [el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 400 }, children: [card] })] })
    const { parsed } = scanOn(doc)
    const cardRecord = parsed.records.find(row => row.id === 'v7')
    expect(cardRecord?.dynamicTarget).toBe(true)
    // The host inherits the signal; the moving child itself carries no challenge
    // signature and must not become a candidate of its own.
    expect(classifyRecord(cardRecord!).kind).toBe('dynamic-target')
    expect(parsed.records.find(row => row.id === 'v7-target')).toBeUndefined()
  })

  it('keeps a first-party page first-party', () => {
    const page = challengePage()
    // Drop the provider frame from the tree.
    const rc = page.doc.all.find(node => node.id === 'rc')!
    rc.parentElement!.children = rc.parentElement!.children.filter(child => child !== rc)
    const body = page.doc.all.find(node => node.localName === 'body')!
    page.doc.all = flatten([body])
    const { parsed } = scan(page)
    const verdict = thirdPartyVerdict(parsed.frames, parsed.host)
    expect(verdict.verdict).toBe('first-party')
    expect(verdict.reason).toBeUndefined()
  })
})

describe('plan11 page script: the verify sweep', () => {
  it('reads a solved page with its counters in one call', () => {
    const doc = makeDocument({
      roots: [el({
        tag: 'body', box: { x: 0, y: 0, width: 754, height: 1200 },
        children: [
          el({ id: 'v1-box', box: { x: 10, y: 20, width: 100, height: 30 }, attrs: { role: 'checkbox', 'aria-checked': 'true' } }),
          el({ tag: 'form', id: 'v11-form', box: { x: 0, y: 100, width: 200, height: 80 }, attrs: { 'data-solved': '1' } }),
          el({ id: 'v6-badge', cls: 'badge', box: { x: 0, y: 0, width: 90, height: 20 }, text: 'V6 · çözüldü' }),
        ],
      })],
    })
    const raw = runScript(CAPTCHA_VERIFY_EXPRESSION, doc, {
      __t6: { checkbox: true, wrongClicks: 0, honeypotHit: false, resolved: { checkbox: 1790360184445 } },
    }) as string
    const parsed = parseVerifyReply(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.record.ariaChecked).toEqual(['#v1-box=true'])
    expect(parsed.record.dataSolved).toEqual(['#v11-form=1'])
    expect(parsed.record.badges).toContain('V6 · çözüldü')
    expect(parsed.record.counters).toMatchObject({ checkbox: true, wrongClicks: 0, honeypotHit: false })
  })

  it('returns null counters on a page that publishes none — never a zero', () => {
    const doc = makeDocument({ roots: [el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 200 } })] })
    const raw = runScript(CAPTCHA_VERIFY_EXPRESSION, doc) as string
    const parsed = parseVerifyReply(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.record.counters).toBeNull()
  })
})

describe('plan11 page script: the slider measurement', () => {
  it('measures the T6 track/thumb and reads the declared data-target', () => {
    const { doc } = challengePage()
    const raw = runScript(buildDragMeasureExpression({ trackSelector: '#v2-track' }), doc) as string
    const geometry = parseDragMeasureReply(raw)
    expect(geometry?.track.width).toBe(664)
    expect(geometry?.thumb.width).toBe(34)
    expect(geometry?.viewport).toEqual({ width: 754, height: 480 })
    expect(geometry?.currentPct).toBeCloseTo(0, 5)
  })

  it('falls back to the first slider in document order when no hint is given', () => {
    const { doc } = challengePage()
    // The V6 chain track comes first in the tree, so it is what a bare call finds.
    const geometry = parseDragMeasureReply(runScript(buildDragMeasureExpression(), doc) as string)
    expect(geometry?.track.width).toBe(600)
  })

  it('honours an explicit track selector over the heuristics', () => {
    const { doc } = challengePage()
    const raw = runScript(buildDragMeasureExpression({ trackSelector: '#v2-track' }), doc) as string
    const geometry = parseDragMeasureReply(raw)
    expect(geometry?.track.width).toBe(664)
  })

  it('refuses with an honest reason when the page has no slider at all', () => {
    const doc = makeDocument({ roots: [el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 200 } })] })
    const raw = runScript(buildDragMeasureExpression(), doc) as string
    const parsed = JSON.parse(raw) as { ok: boolean, reason: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain('no slider track found')
    expect(parseDragMeasureReply(raw)).toBeNull()
  })

  it('picks the slider NEAR the box the locator resolved', () => {
    const { doc } = challengePage()
    // The near box sits on the V6 chain track, not on the V2 slider.
    const raw = runScript(buildDragMeasureExpression({
      near: { x: 60, y: 60, width: 640, height: 60 },
    }), doc) as string
    const geometry = parseDragMeasureReply(raw)
    expect(geometry?.track.width).toBe(600)
  })
})

// ---------------------------------------------------------------------------
/* plan11-fix-verify — the `view is not defined` regression.

   Three live agents hit the same live failure:
     Captcha verify failed: the page-side verify failed (view is not defined)
   The `verify` page-side script read a COMPUTED style through a bare `view`
   that the IIFE never declared, so a `[data-target]` track holding a NARROW
   non-thumb child threw and the whole report collapsed. It stayed invisible
   twice over: the geometry is code-path dependent (a track whose only child is
   the thumb `continue`s before the read, which is why the existing fixtures
   never reached it), and the catch erased the cause behind a generic refusal.

   These run the REAL expressions in the same `node:vm` sandbox, so a
   reintroduced `view` fails here, not mid-captcha on someone's page. */
describe('plan11-fix-verify: the verify fill-width pass', () => {
  /** A `[data-target]` track of 300px holding the given children. */
  function sliderPage(children: FakeElement[]): FakeDocument {
    const track = el({
      id: 't9-track', cls: 't9-track', box: { x: 60, y: 200, width: 300, height: 40 },
      attrs: { 'data-target': '72' }, children,
    })
    return makeDocument({
      roots: [el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 1200 }, children: [track] })],
    })
  }

  it('survives a track that holds a NARROW non-thumb child (the line that threw)', () => {
    // The label is narrower than the track, so the fill-width pass reads its
    // computed style — `view.getComputedStyle(child)`, the line that threw. It
    // is neither named fill/progress/bar nor sized in a percent, so the channel
    // itself rejects it and moves on to the thumb.
    const label = el({ id: 't9-rail', cls: 't9-hint', box: { x: 66, y: 206, width: 40, height: 28 } })
    const thumb = el({ id: 't9-thumb', cls: 't9-thumb', box: { x: 74, y: 206, width: 30, height: 28 } })
    const raw = runScript(CAPTCHA_VERIFY_EXPRESSION, sliderPage([label, thumb])) as string
    expect(raw).not.toContain('view is not defined')
    const parsed = parseVerifyReply(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.reason).toBe('')
    // A thumb-box reconstruction, reported AS one — the number itself is the
    // page-side formula's business, the source label is the honest contract.
    const row = parsed.record.sliders[0]!
    expect(row).toMatch(/^#t9-track=derived:-?[\d.]+\(72\)$/)
    expect(parseSliderRow(row)?.value).toBeTypeOf('number')
    expect(collectSolutionSignals(parsed.record).signals.sliders).toEqual(parsed.record.sliders)
    // The 72px target is nowhere near this thumb, so nothing claims it solved.
    expect(collectSolutionSignals(parsed.record).solved).toBe(false)
  })

  it('still reads the FILL WIDTH through the same style read', () => {
    // Neutral name, percent-sized: the channel can only be satisfied by the
    // computed style the old script could not resolve.
    const rail = el({ id: 't9-rail', cls: 't9-hint', box: { x: 60, y: 200, width: 120, height: 40 }, style: { width: '40%' } })
    const parsed = parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, sliderPage([rail])) as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.record.sliders).toEqual(['#t9-track=fill-width:40(72)'])
    // A published channel: no "reconstructed" hand-wave, and it reads as 40% of
    // a 300px track, not as a zero.
    expect(collectSolutionSignals(parsed.record).warnings.join(' ')).not.toContain('reconstructed')
  })

  it('reports an unreadable slider as unavailable — never as zero', () => {
    // Same narrow child, no thumb and no published channel: nothing is invented.
    const label = el({ id: 't9-rail', cls: 't9-hint', box: { x: 66, y: 206, width: 40, height: 28 } })
    const parsed = parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, sliderPage([label])) as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.record.sliders).toEqual(['#t9-track=unavailable:null(72)'])
    const read = collectSolutionSignals(parsed.record)
    expect(read.solved).toBe(false)
    expect(read.warnings.join(' ')).toContain('publishes no readable value channel')
    expect(read.warnings.join(' ')).toContain('unavailable, not zero')
  })

  it('carries the page-side error text into the envelope, not a generic refusal', () => {
    const doc = sliderPage([])
    doc.querySelectorAll = () => { throw new Error('t9 fixture: querySelectorAll exploded') }
    const parsed = parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, doc) as string)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('cdp_captcha: the page-side verify failed (t9 fixture: querySelectorAll exploded)')
    expect(parsed.reason).not.toBe('cdp_captcha: the page-side verify failed')
    expect(parsed.record.counters).toBeNull()
  })

  it('still answers when the thrown error refuses to describe itself', () => {
    // A page that throws an object whose `message` getter explodes used to take
    // the catch down with it — the one path that produced a bare "produced no
    // value" with no diagnosis at all.
    const hostile: Record<string, unknown> = { [Symbol.toStringTag]: 'PageSideBoom' }
    Object.defineProperty(hostile, 'message', { get() { throw new TypeError('message getter exploded') } })
    const doc = sliderPage([])
    doc.querySelectorAll = () => { throw hostile }
    const parsed = parseVerifyReply(runScript(CAPTCHA_VERIFY_EXPRESSION, doc) as string)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('cdp_captcha: the page-side verify failed (unreadable error ([object PageSideBoom]))')
  })

  it('gives the scan the same envelope discipline', () => {
    const doc = sliderPage([])
    doc.querySelectorAll = () => { throw new Error('t6 fixture: querySelectorAll exploded') }
    const parsed = parseScanReply(runScript(CAPTCHA_SCAN_EXPRESSION, doc) as string)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('cdp_captcha: the page-side scan failed (t6 fixture: querySelectorAll exploded)')
    expect(parsed.records).toEqual([])
    const hostile: Record<string, unknown> = { [Symbol.toStringTag]: 'PageSideBoom' }
    Object.defineProperty(hostile, 'message', { get() { throw new TypeError('message getter exploded') } })
    doc.querySelectorAll = () => { throw hostile }
    const again = parseScanReply(runScript(CAPTCHA_SCAN_EXPRESSION, doc) as string)
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('cdp_captcha: the page-side scan failed (unreadable error ([object PageSideBoom]))')
  })
})
