/**
 * plan11-fix-scan-cap: the 16 KiB scan-reply cap.
 *
 * The live failure: `cdp_captcha({action:'scan'})` answered
 *   "scan reply is not JSON (Expected ':' after property name in JSON at
 *    position 16384)"
 * on a page carrying a large inline `<style>` + `<script>`. The host cuts every
 * evaluation reply at `MAX_EVALUATE_CHARS`, so a reply over that size is cut
 * mid-object — and a cut JSON string is not a partial answer, it is an
 * UNPARSEABLE one. The whole scan was lost: no candidates, no overlays, no
 * third-party verdict, nothing to read.
 *
 * Measured on the T7 fixture: 19 candidates produced 15,009 chars — one more
 * form field and the scan was gone. This file pins the three properties that
 * replace that:
 *   1. the page budgets its OWN evidence (compacted records + a byte budget
 *      that spends on signal first), so the reply fits;
 *   2. when the budget bites, the cut is REPORTED — `truncated` plus a warning
 *      that names how many of how many were dropped;
 *   3. when even that cannot fit, the envelope answers `ok:false` with the
 *      recovery instruction — never a cut JSON string.
 *
 * The page script is RUN here in a `node:vm` sandbox against a stub DOM, the
 * same pattern as `plan11-captcha-page.spec.ts`, so the expression is verified
 * rather than trusted.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_SCAN_BUDGET_REASON,
  CAPTCHA_SCAN_EXPRESSION,
  CAPTCHA_SCAN_HARD_BUDGET_CHARS,
  CAPTCHA_SCAN_OVERLAY_BUDGET_CHARS,
  CAPTCHA_SCAN_RECORD_BUDGET_CHARS,
  normalizeScanRecord,
  parseScanReply,
} from '../src/captcha.ts'
import { MAX_EVALUATE_CHARS } from '../src/page.ts'
import { CdpService } from '../src/service.ts'

// ---------------------------------------------------------------------------
// A minimal fake DOM — only the seams the scan expression actually touches
// ---------------------------------------------------------------------------

interface FakeBox {
  x: number
  y: number
  width: number
  height: number
}

interface FakeElement {
  localName: string
  nodeType: 1
  id: string
  className: string
  attrs: Record<string, string>
  style: Record<string, string>
  box: FakeBox
  text: string
  /** The individual selectors this element answers to (NOT a joined list). */
  selectors: string[]
  parentElement: FakeElement | null
  children: FakeElement[]
  ownerDocument: FakeDocument | null
  contentDocument: FakeDocument | null
  coveredBy: FakeElement | null
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
  all: FakeElement[]
  defaultView: Record<string, unknown>
  querySelectorAll: (selector: string) => FakeElement[]
  querySelector: (selector: string) => FakeElement | null
  elementFromPoint: (x: number, y: number) => FakeElement | null
}

interface ElOptions {
  tag?: string
  id?: string
  cls?: string
  box?: FakeBox
  style?: Record<string, string>
  attrs?: Record<string, string>
  text?: string
  selectors?: string[]
  children?: FakeElement[]
  coveredBy?: FakeElement | null
  contentDocument?: FakeDocument | null
}

/** camelCase alias for every kebab key, like a real getComputedStyle. */
function computedStyleOf(node: FakeElement): Record<string, string> {
  const style: Record<string, string> = { ...node.style }
  for (const key of Object.keys(node.style)) {
    const alias = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    if (alias !== key && style[alias] === undefined) style[alias] = node.style[key] ?? ''
  }
  return style
}

/** Every selector part (the scan passes comma-joined lists). */
function parts(selector: string): string[] {
  return String(selector).split(',').map(part => part.trim()).filter(Boolean)
}

function el(options: ElOptions = {}): FakeElement {
  const node = {
    localName: options.tag ?? 'div',
    nodeType: 1 as const,
    id: options.id ?? '',
    className: options.cls ?? '',
    attrs: options.attrs ?? {},
    style: { position: 'static', opacity: '1', 'pointer-events': 'auto', ...options.style },
    box: options.box ?? { x: 0, y: 0, width: 100, height: 30 },
    text: options.text ?? '',
    selectors: options.selectors ?? [],
    children: options.children ?? [],
    parentElement: null,
    ownerDocument: null,
    contentDocument: options.contentDocument ?? null,
    coveredBy: options.coveredBy ?? null,
    scrollCalls: 0,
    getAttribute(name: string): string | null {
      if (name === 'id') return node.id === '' ? null : node.id
      if (name === 'class') return node.className === '' ? null : node.className
      if (name === 'style') {
        const style: Record<string, string> = node.style
        const inline = Object.keys(style).map(key => `${key}: ${style[key] ?? ''}`).join('; ')
        return inline === '' ? null : inline
      }
      return node.attrs[name] ?? null
    },
    hasAttribute(name: string): boolean {
      return node.getAttribute(name) !== null
    },
    getBoundingClientRect(): FakeBox {
      const box = node.box
      return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height } as FakeBox
    },
    contains(other: FakeElement | null): boolean {
      if (other === null) return false
      let cursor: FakeElement | null = other
      while (cursor !== null) {
        if (cursor === node) return true
        cursor = cursor.parentElement
      }
      return false
    },
    closest(selector: string): FakeElement | null {
      const wanted = parts(selector)
      let cursor: FakeElement | null = node
      while (cursor !== null) {
        if (cursor.selectors.some(one => wanted.includes(one))) return cursor
        cursor = cursor.parentElement
      }
      return null
    },
    querySelectorAll(selector: string): FakeElement[] {
      const wanted = parts(selector)
      const found: FakeElement[] = []
      const walk = (parent: FakeElement): void => {
        for (const child of parent.children) {
          if (wanted.includes('*') || child.selectors.some(one => wanted.includes(one))) found.push(child)
          walk(child)
        }
      }
      for (const child of node.children) walk(child)
      return found
    },
    querySelector(selector: string): FakeElement | null {
      return node.querySelectorAll(selector)[0] ?? null
    },
    scrollIntoView(): void {
      node.scrollCalls += 1
    },
  }
  for (const child of node.children) child.parentElement = node
  return node
}

function makeDocument(roots: FakeElement[], locationHref = 'https://fixture.test/dogrulama.html'): FakeDocument {
  const all: FakeElement[] = []
  const collect = (node: FakeElement): void => {
    all.push(node)
    for (const child of node.children) collect(child)
  }
  for (const root of roots) collect(root)
  const doc = {
    all,
    defaultView: {} as Record<string, unknown>,
    querySelectorAll(selector: string): FakeElement[] {
      const wanted = parts(selector)
      if (wanted.includes('body *')) return all
      return all.filter(node => node.selectors.some(one => wanted.includes(one)))
    },
    querySelector(selector: string): FakeElement | null {
      return doc.querySelectorAll(selector)[0] ?? null
    },
    elementFromPoint(x: number, y: number): FakeElement | null {
      for (const node of all) {
        const box = node.box
        if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
          return node.coveredBy ?? node
        }
      }
      return null
    },
  } as FakeDocument
  const view = {
    innerWidth: 754,
    innerHeight: 900,
    scrollX: 0,
    scrollY: 0,
    scrollTo: () => {},
    getComputedStyle: (node: FakeElement) => computedStyleOf(node),
  }
  doc.defaultView = view
  for (const node of all) {
    node.ownerDocument = doc
    // A same-origin frame's own document is already built by its fixture; the
    // scan only reads it through `contentDocument`, so nothing else to wire.
    void node.contentDocument
  }
  const href = locationHref
  return Object.assign(doc, { location: { href, hostname: 'fixture.test' } }) as FakeDocument
}

/** Run the real page-side expression against `doc`. */
function runScan(doc: FakeDocument): string {
  const view = doc.defaultView
  const sandbox: Record<string, unknown> = {
    document: doc,
    location: (doc as unknown as { location: unknown }).location,
    window: { ...view },
    JSON, Math, String, Number, Object, Array, Boolean, RegExp, Set, Infinity, NaN,
  }
  sandbox.globalThis = sandbox
  return runInContext(CAPTCHA_SCAN_EXPRESSION, createContext(sandbox)) as string
}

/**
 * The reported ground: a busy form (60 fields) plus the shapes that carry
 * signal, on a page whose inline `<style>`/`<script>` weight is what pushed the
 * live reply over the cut in the first place.
 */
function denseGround(): { doc: FakeDocument, expectedCandidates: number } {
  const fields: FakeElement[] = []
  for (let index = 1; index <= 60; index += 1) {
    fields.push(el({
      tag: 'input',
      id: `f${String(index)}`,
      box: { x: 20, y: 40 + index * 12, width: 300, height: 28 },
      attrs: { type: 'text', name: `f${String(index)}` },
      selectors: ['input[type="text"]'],
    }))
  }
  const form = el({ tag: 'form', id: 'big', box: { x: 10, y: 30, width: 700, height: 800 }, selectors: ['form'], children: fields })
  const slider = el({
    id: 'real-track',
    cls: 'v2-track',
    box: { x: 20, y: 800, width: 640, height: 40 },
    attrs: { role: 'slider', 'aria-valuenow': '0', 'data-target': '72', 'data-done': '0' },
    selectors: ['[role="slider"]', '[aria-valuenow]', '[data-target]', '[data-done]'],
  })
  const thumb = el({
    id: 'real-thumb', cls: 'v2-thumb', box: { x: 22, y: 803, width: 34, height: 34 },
    selectors: ['[role="slider"]'],
  })
  const checkbox = el({
    id: 'real-box',
    box: { x: 20, y: 850, width: 400, height: 40 },
    attrs: { role: 'checkbox', 'aria-checked': 'false', 'data-solved': '' },
    text: 'Onay kutusu',
    selectors: ['[role="checkbox"]', '[aria-checked]', '[data-solved]'],
  })
  const decoy = el({
    id: 'real-decoy',
    box: { x: 20, y: 890, width: 400, height: 30 },
    attrs: { 'data-decoy': '1' },
    text: 'Ben robot degilim (SAHTE)',
    selectors: ['[data-decoy]'],
  })
  const header = el({
    tag: 'header', box: { x: 0, y: 0, width: 754, height: 40 },
    style: { position: 'sticky', 'z-index': '200' },
    selectors: [],
  })
  // The page weight the live report named: a large inline <style>/<script> pair.
  // It matches no candidate, so it costs the scan nothing — which is exactly the
  // point: the reply's size was never about the page's bytes, it was about the
  // per-record evidence the scan chose to carry.
  const styleBlock = el({ tag: 'style', text: `.a{color:#010101}\n`.repeat(400), selectors: [] })
  const scriptBlock = el({ tag: 'script', text: `var a=1;\n`.repeat(500), selectors: [] })
  const body = el({
    tag: 'body',
    box: { x: 0, y: 0, width: 754, height: 2000 },
    children: [header, styleBlock, scriptBlock, form, slider, thumb, checkbox, decoy],
  })
  return { doc: makeDocument([body]), expectedCandidates: 60 + 4 }
}

// ---------------------------------------------------------------------------
// 1. The reply fits, and it fits because of the page's own budget
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-cap: the reply fits the host cut', () => {
  it('keeps a dense page parseable and inside MAX_EVALUATE_CHARS', () => {
    const { doc } = denseGround()
    const raw = runScan(doc)
    expect(raw.length).toBeLessThanOrEqual(MAX_EVALUATE_CHARS)
    // The whole point: JSON.parse must not throw. Before the fix, this reply was
    // cut at 16384 and read "Expected ':' after property name …".
    expect(() => { JSON.parse(raw) }).not.toThrow()
    const parsed = parseScanReply(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.reason).toBe('')
  })

  it('reports the cut instead of hiding it: truncated + a warning that names it', () => {
    const { doc, expectedCandidates } = denseGround()
    const parsed = parseScanReply(runScan(doc))
    const raw = JSON.parse(runScan(doc)) as { truncated: boolean, warnings: string[] }
    expect(raw.truncated).toBe(true)
    expect(parsed.records.length).toBeLessThan(expectedCandidates)
    const cut = parsed.warnings.find(line => line.includes('candidate inventory was cut'))
    expect(cut, `warnings were ${JSON.stringify(parsed.warnings)}`).toBeDefined()
    expect(cut).toMatch(/the candidate inventory was cut: \d+ of \d+ candidates/)
    expect(cut).toContain('16 KiB')
  })

  it('spends the budget on the candidates that carry signal', () => {
    const { doc, expectedCandidates } = denseGround()
    const parsed = parseScanReply(runScan(doc))
    const ids = parsed.records.map(record => record.id)
    expect(ids).toContain('real-track')
    expect(ids).toContain('real-box')
    expect(ids).toContain('real-decoy')
    // …and the plain form fields are what got dropped.
    expect(parsed.records.length).toBeLessThan(expectedCandidates)
  })

  it('leaves a small page completely alone — no cut, no warning', () => {
    const slider = el({
      id: 'only-track', box: { x: 20, y: 100, width: 640, height: 40 },
      attrs: { role: 'slider', 'aria-valuenow': '0', 'data-target': '72' },
      selectors: ['[role="slider"]', '[aria-valuenow]', '[data-target]'],
    })
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 900 }, children: [slider] })
    const parsed = parseScanReply(runScan(makeDocument([body])))
    expect(parsed.ok).toBe(true)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Compaction: the page stops paying for values that say nothing
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-cap: a record costs what it says', () => {
  it('omits empty/false/0 fields page-side and the host rebuilds them identically', () => {
    const field = el({
      tag: 'input', id: 'plain', box: { x: 20, y: 40, width: 300, height: 28 },
      attrs: { type: 'text', name: 'plain' },
      selectors: ['input[type="text"]'],
    })
    const form = el({ tag: 'form', id: 'f', box: { x: 10, y: 30, width: 700, height: 200 }, selectors: ['form'], children: [field] })
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 900 }, children: [form] })
    const raw = runScan(makeDocument([body]))
    const page = JSON.parse(raw) as { records: Array<Record<string, unknown>> }
    const compact = page.records.find(record => record.id === 'plain')!
    // Nothing that says "no" is on the wire…
    expect(compact).not.toHaveProperty('decoy')
    expect(compact).not.toHaveProperty('dynamicTarget')
    expect(compact).not.toHaveProperty('checkboxInput')
    expect(compact).not.toHaveProperty('ariaChecked')
    expect(compact).not.toHaveProperty('tabIndex')
    // …but the two the trap rules COMPARE against are, because a default would
    // change their meaning rather than restate it.
    expect(compact.position).toBe('static')
    expect(compact.pointerEvents).toBe('auto')
    // …and the scan-rect contract is still reported rather than implied.
    expect(compact).toHaveProperty('measuredAtScrollY', 0)
    expect(compact.scrollRestored).toBe(true)

    // The host fills the omitted fields back in with exactly the values the page
    // would have written, so nothing downstream can tell the difference.
    const normalized = normalizeScanRecord(compact)
    expect(normalized.decoy).toBe(false)
    expect(normalized.dynamicTarget).toBe(false)
    expect(normalized.checkboxInput).toBe(false)
    expect(normalized.rangeInput).toBe(false)
    expect(normalized.ariaChecked).toBe('')
    expect(normalized.tabIndex).toBe(0)
    expect(normalized.covers).toBe(0)
    expect(normalized.trapHits).toBe(0)
    expect(normalized.trapRuleIds).toEqual([])
    expect(normalized.measuredAtScrollY).toBe(0)
    expect(normalized.scrollRestored).toBe(true)
  })

  it('the budgets it enforces are ordered so the reply always fits the hard cap', () => {
    expect(CAPTCHA_SCAN_RECORD_BUDGET_CHARS + CAPTCHA_SCAN_OVERLAY_BUDGET_CHARS)
      .toBeLessThan(CAPTCHA_SCAN_HARD_BUDGET_CHARS)
    expect(CAPTCHA_SCAN_HARD_BUDGET_CHARS).toBeLessThanOrEqual(MAX_EVALUATE_CHARS)
  })
})

// ---------------------------------------------------------------------------
// 3. The backstop: a reply that still cannot fit answers, it does not truncate
// ---------------------------------------------------------------------------

describe('plan11-fix-scan-cap: never a cut JSON string', () => {
  it('answers ok:false with the recovery reason when even a bare envelope is too big', () => {
    // Fat frame srcs: the one inventory the budget deliberately does NOT trim,
    // because the frame list is what the third-party verdict is made of. When it
    // alone blows the budget the page must ANSWER, not overflow.
    const frames: FakeElement[] = []
    for (let index = 0; index < 40; index += 1) {
      frames.push(el({
        tag: 'iframe', id: `fr${String(index)}`, box: { x: 0, y: 0, width: 300, height: 50 },
        attrs: { src: `https://provider.test/frame/${String(index)}?state=${'C'.repeat(600)}` },
        selectors: ['iframe'],
      }))
    }
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 900 }, children: frames })
    const raw = runScan(makeDocument([body]))
    expect(raw.length).toBeLessThanOrEqual(MAX_EVALUATE_CHARS)
    expect(() => { JSON.parse(raw) }).not.toThrow()
    const parsed = parseScanReply(raw)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe(CAPTCHA_SCAN_BUDGET_REASON)
    expect(parsed.reason).toContain('scan result exceeds the 16 KiB budget; narrow the scan or use a clip/scope')
  })

  it('cuts an oversized URL instead of losing the whole scan when the rest fits', () => {
    const long = `https://fixture.test/?p=${'B'.repeat(16_000)}`
    const slider = el({
      id: 'only-track', box: { x: 20, y: 100, width: 640, height: 40 },
      attrs: { role: 'slider', 'aria-valuenow': '0', 'data-target': '72' },
      selectors: ['[role="slider"]', '[aria-valuenow]', '[data-target]'],
    })
    const body = el({ tag: 'body', box: { x: 0, y: 0, width: 754, height: 900 }, children: [slider] })
    const raw = runScan(makeDocument([body], long))
    expect(raw.length).toBeLessThanOrEqual(MAX_EVALUATE_CHARS)
    const parsed = parseScanReply(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.url.length).toBeLessThanOrEqual(512)
    expect(parsed.warnings.join(' ')).toContain('page URL itself was longer than the 16 KiB budget')
  })

  it('the host answers the same way when its own cut is what happened', async () => {
    // The host cut the reply at 16 KiB: the parse cannot be trusted, so the
    // envelope says so and names the recovery — it does not ship a half object.
    const service = Object.create(CdpService.prototype) as CdpService
    Object.assign(service, {
      registry: { active: () => ({ targetId: 'tab-1' }) },
      getPageSession: async () => ({
        sessionId: 's-1',
        url: async () => 'https://fixture.test/dogrulama.html',
        evaluate: async () => ({ hasValue: true, truncated: true, value: '{"ok":true,"records":[' }),
      }),
    })
    const outcome = await service.captcha({ action: 'scan' })
    expect(outcome.ok).toBe(false)
    if (outcome.action !== 'scan') throw new Error(`expected a scan envelope, got ${outcome.action}`)
    expect(outcome.reason).toBe(CAPTCHA_SCAN_BUDGET_REASON)
    expect(outcome.found).toBe(0)
    expect(outcome.candidates).toEqual([])
    expect(outcome.warnings.join(' ')).toContain('cut at the 16 KiB evaluate limit')
  })
})
