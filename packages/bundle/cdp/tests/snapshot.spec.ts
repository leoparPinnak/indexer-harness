/**
 * `weaveSnapshot` over the recorded checkout page and over small hand-built
 * documents: the woven node list, the stable references, the documented
 * exclusions, the DOM fallbacks, and the three bounds at exact and one-past
 * boundaries. The fixture is plain data only, so every case is deterministic.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  CdpAccessibilityNode,
  CdpBoxModel,
  CdpSnapshot,
  CdpSnapshotInput,
  CdpSnapshotLimits,
  CdpViewport,
} from '../src/snapshot.ts'
import { weaveSnapshot } from '../src/snapshot.ts'

/** Mutable copy of a recorded node, so a case can insert or remove a child. */
interface DomNode {
  nodeId: number
  parentId?: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  attributes?: string[]
  children?: DomNode[]
}

/** The recorded checkout page as the fixture stores it, before it becomes a weaver input. */
interface RecordedPage {
  title: string
  url: string
  viewport: CdpViewport
  boxes: Record<string, CdpBoxModel>
  accessibility: CdpAccessibilityNode[]
  document: DomNode
}

const RECORDED = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-page.json', import.meta.url), 'utf8'),
) as RecordedPage

/** A fresh deep copy of the fixture, so one case never leaks into the next. */
function recordedPage(): RecordedPage {
  return structuredClone(RECORDED)
}

/** Find one node of a recorded document by protocol node id. */
function findNode(node: DomNode, nodeId: number): DomNode | undefined {
  if (node.nodeId === nodeId) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, nodeId)
    if (found !== undefined) return found
  }
  return undefined
}

/** Protocol node id to box model, as `weaveSnapshot` takes it. */
function boxMap(boxes: Record<string, CdpBoxModel>): Map<number, CdpBoxModel> {
  return new Map(Object.entries(boxes).map(([id, box]): [number, CdpBoxModel] => [Number(id), box]))
}

/** Weave one recorded page, with optional ceilings. */
function weavePage(page: RecordedPage, limits?: CdpSnapshotLimits): CdpSnapshot {
  const input: CdpSnapshotInput = {
    document: page.document,
    viewport: page.viewport,
    title: page.title,
    url: page.url,
    boxes: boxMap(page.boxes),
    accessibility: page.accessibility,
    ...limits === undefined ? {} : { limits },
  }
  return weaveSnapshot(input)
}

/** Weave a hand-built document with the recorded viewport and page facts. */
function weaveCustom(input: {
  document: DomNode
  boxes?: Record<string, CdpBoxModel>
  accessibility?: CdpAccessibilityNode[]
  limits?: CdpSnapshotLimits
}): CdpSnapshot {
  return weaveSnapshot({
    document: input.document,
    viewport: RECORDED.viewport,
    title: 'Custom',
    url: 'https://fixture.shop/custom',
    ...input.boxes === undefined ? {} : { boxes: boxMap(input.boxes) },
    ...input.accessibility === undefined ? {} : { accessibility: input.accessibility },
    ...input.limits === undefined ? {} : { limits: input.limits },
  })
}

/** One woven entry by reference; a missing reference fails the assertion that asked for it. */
function entry(snapshot: CdpSnapshot, ref: string) {
  const found = snapshot.nodes.find(node => node.ref === ref)
  expect(found, `no woven entry for ${ref}`).toBeDefined()
  return found!
}

/** UTF-8 bytes of one serialized snapshot, the measure `maxBytes` applies to. */
function size(snapshot: CdpSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}

const H = 'RootWebArea|Checkout — Fixture Shop|0'
const BODY = `${H}>generic||0`
const HEADER = `${BODY}>banner||0`
const H1 = `${HEADER}>heading|Fixture Shop|0`
const NAV = `${HEADER}>navigation|Main|0`
const HOME = `${NAV}>link|Home|0`
const CART = `${NAV}>link|Cart|0`
const ACCOUNT = `${NAV}>link|Account|0`
const MAIN = `${BODY}>main||0`
const SUMMARY = `${MAIN}>region|Order summary|0`
const SUMMARY_HEADING = `${SUMMARY}>heading|Order summary|0`
const SUMMARY_TEXT = `${SUMMARY}>paragraph|Two items|0`
const EDIT_CART = `${SUMMARY}>link|Edit cart|0`
const FORM = `${MAIN}>form|Checkout|0`
const GROUP = `${FORM}>group|Contact|0`
const EMAIL = `${GROUP}>textbox|you@example.com|0`
const FULL_NAME = `${GROUP}>textbox|Full name|0`
const COUNTRY = `${GROUP}>combobox|Country|0`
const OPTION_TR = `${COUNTRY}>option|Türkiye|0`
const OPTION_DE = `${COUNTRY}>option|Germany|0`
const OPTION_US = `${COUNTRY}>option|United States|0`
const ADDRESS = `${GROUP}>textbox|Address|0`
const POSTAL = `${GROUP}>textbox|Postal code|0`
const TERMS = `${GROUP}>checkbox|Accept terms|0`
const SUBMIT = `${GROUP}>button|Place order|0`
const TABLE = `${MAIN}>table|Items|0`
const CAPTION = `${TABLE}>caption|Items|0`
const HEAD_ROW = `${TABLE}>row||0`
const BODY_ROW = `${TABLE}>row||1`
const FOOT_ROW = `${TABLE}>row||2`
const HEAD_CELL = `${HEAD_ROW}>columnheader|Item|0`
const QTY_CELL = `${HEAD_ROW}>columnheader|Quantity|0`
const PRICE_CELL = `${HEAD_ROW}>columnheader|Price|0`
const ITEM_CELL = `${BODY_ROW}>cell|Desk lamp|0`
const ONE_CELL = `${BODY_ROW}>cell|1|0`
const AMOUNT_CELL = `${BODY_ROW}>cell|₺1.299|0`
const TOTAL_CELL = `${FOOT_ROW}>cell|Total|0`
const SUM_CELL = `${FOOT_ROW}>cell|₺1.539|0`
const DIALOG = `${BODY}>dialog||0`

const EXPECTED_REFS = [
  H, BODY, HEADER, H1, NAV, HOME, CART, ACCOUNT, MAIN, SUMMARY, SUMMARY_HEADING, SUMMARY_TEXT, EDIT_CART,
  FORM, GROUP, EMAIL, FULL_NAME, COUNTRY, OPTION_TR, OPTION_DE, OPTION_US, ADDRESS, POSTAL, TERMS,
  SUBMIT, TABLE, CAPTION, HEAD_ROW, HEAD_CELL, QTY_CELL, PRICE_CELL, BODY_ROW, ITEM_CELL, ONE_CELL,
  AMOUNT_CELL, FOOT_ROW, TOTAL_CELL, SUM_CELL, DIALOG,
]

describe('weaving the recorded checkout page', () => {
  it('weaves the expected ordered node list, counts, and page facts', () => {
    const snapshot = weavePage(recordedPage())
    expect(snapshot.nodes.map(node => node.ref)).toEqual(EXPECTED_REFS)
    expect(snapshot.title).toBe('Checkout — Fixture Shop')
    expect(snapshot.url).toBe('https://fixture.shop/checkout')
    expect(snapshot.viewport).toEqual({ width: 1280, height: 800 })
    expect(snapshot.counts).toEqual({
      totalNodes: 39,
      returnedNodes: 39,
      interactiveNodes: 14,
      visibleNodes: 37,
    })
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.nodeLimitTruncated).toBe(false)
    expect(snapshot.textLimitTruncated).toBe(false)
    expect(snapshot.sizeLimitTruncated).toBe(false)
  })

  it('takes role, name, and value from the accessibility tree first', () => {
    const snapshot = weavePage(recordedPage())
    expect(entry(snapshot, NAV)).toMatchObject({ role: 'navigation', name: 'Main' })
    expect(entry(snapshot, NAV).value).toBeUndefined()
    expect(entry(snapshot, COUNTRY)).toMatchObject({ role: 'combobox', name: 'Country', value: 'Türkiye' })
    expect(entry(snapshot, CAPTION)).toMatchObject({ role: 'caption', name: 'Items' })
    expect(entry(snapshot, DIALOG)).toMatchObject({ role: 'dialog', name: '' })
  })

  it('falls back to DOM attributes and direct text for role, name, and value', () => {
    const snapshot = weavePage(recordedPage())
    // Tag and input type: an anchor with href, an email input, a checkbox, an option.
    expect(entry(snapshot, EDIT_CART)).toMatchObject({ role: 'link', name: 'Edit cart' })
    expect(entry(snapshot, EMAIL)).toMatchObject({ role: 'textbox', name: 'you@example.com' })
    expect(entry(snapshot, TERMS)).toMatchObject({ role: 'checkbox', name: 'Accept terms' })
    expect(entry(snapshot, OPTION_DE)).toMatchObject({ role: 'option', name: 'Germany', value: 'de' })
    // aria-label before the text fallback.
    expect(entry(snapshot, FULL_NAME)).toMatchObject({ role: 'textbox', name: 'Full name' })
    // An explicit role attribute alone selects the dialog.
    expect(entry(snapshot, DIALOG).role).toBe('dialog')
  })

  it('prefers an accessibility name over aria-label and aria-label over direct text', () => {
    const document: DomNode = {
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        { nodeId: 2, nodeType: 1, nodeName: 'INPUT', attributes: ['aria-label', 'Attribute name'], children: [
          { nodeId: 3, nodeType: 3, nodeName: '#text', nodeValue: 'Text name' },
        ] },
        { nodeId: 4, nodeType: 1, nodeName: 'INPUT', attributes: ['aria-label', 'Attribute name'], children: [
          { nodeId: 5, nodeType: 3, nodeName: '#text', nodeValue: 'Text name' },
        ] },
        { nodeId: 6, nodeType: 1, nodeName: 'SPAN', children: [
          { nodeId: 7, nodeType: 3, nodeName: '#text', nodeValue: '  Text   name  ' },
        ] },
      ],
    }
    const snapshot = weaveCustom({
      document,
      boxes: {
        '2': { x: 0, y: 0, width: 10, height: 10 },
        '4': { x: 0, y: 20, width: 10, height: 10 },
        '6': { x: 0, y: 40, width: 10, height: 10 },
      },
      accessibility: [
        { nodeId: 'ax2', documentNodeId: 2, role: 'textbox', name: 'Accessible name' },
      ],
    })
    expect(snapshot.nodes.map(node => node.name)).toEqual(['Accessible name', 'Attribute name', 'Text name'])
    expect(snapshot.nodes.map(node => node.role)).toEqual(['textbox', 'textbox', 'generic'])
  })

  it('reports viewport boxes and marks a zero-area node invisible', () => {
    const snapshot = weavePage(recordedPage())
    expect(entry(snapshot, EMAIL).box).toEqual({ x: 24, y: 392, width: 552, height: 32 })
    expect(entry(snapshot, EMAIL)).toMatchObject({ interactive: true, visible: true })
    expect(entry(snapshot, ADDRESS)).toMatchObject({ visible: false, interactive: true })
    expect(entry(snapshot, ADDRESS).box).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    // A retained hidden dialog carries no box and is not visible.
    expect(entry(snapshot, DIALOG).box).toBeUndefined()
    expect(entry(snapshot, DIALOG)).toMatchObject({ visible: false, interactive: false })
    expect(entry(snapshot, SUMMARY_HEADING).interactive).toBe(false)
  })

  it('skips ignored and non-rendered nodes while keeping their woven descendants', () => {
    const snapshot = weavePage(recordedPage())
    const refs = snapshot.nodes.map(node => node.ref)
    for (const role of ['label|', 'legend|', 'rowgroup|', 'title|']) {
      expect(refs.some(ref => ref.includes(role)), role).toBe(false)
    }
    expect(refs).toContain(HEAD_ROW)
    expect(refs).toContain(BODY_ROW)
    expect(refs).toContain(FOOT_ROW)
    // The hidden dialog is retained, but its unmeasured children are not.
    expect(refs).toContain(DIALOG)
    expect(refs.some(ref => ref.includes('paragraph|Delete this order?'))).toBe(false)
    expect(refs.some(ref => ref.includes('button|Cancel'))).toBe(false)
  })

  it('retains only the documented roles without a box model', () => {
    const document: DomNode = {
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        { nodeId: 2, nodeType: 1, nodeName: 'DIV' },
        { nodeId: 3, nodeType: 1, nodeName: 'DIV' },
        { nodeId: 4, nodeType: 1, nodeName: 'DIV' },
        { nodeId: 5, nodeType: 1, nodeName: 'DIV' },
        { nodeId: 6, nodeType: 1, nodeName: 'DIV' },
      ],
    }
    const snapshot = weaveCustom({
      document,
      boxes: { '2': { x: 0, y: 0, width: 10, height: 10 } },
      accessibility: [
        { nodeId: 'ax2', documentNodeId: 2, role: 'generic', name: 'wrapper' },
        { nodeId: 'ax3', documentNodeId: 3, role: 'generic', name: 'hidden wrapper' },
        { nodeId: 'ax4', documentNodeId: 4, role: 'status', name: 'saving' },
        { nodeId: 'ax5', documentNodeId: 5, role: 'dialog', name: 'confirm' },
        { nodeId: 'ax6', documentNodeId: 6, role: 'tooltip', name: 'hint' },
      ],
    })
    expect(snapshot.nodes.map(node => node.name)).toEqual(['wrapper', 'saving', 'confirm', 'hint'])
    expect(snapshot.nodes.map(node => node.visible)).toEqual([true, false, false, false])
  })

  it('treats every element as rendered when the page carries no measurements', () => {
    const page = recordedPage()
    const unmeasured = weaveSnapshot({
      document: page.document,
      viewport: page.viewport,
      title: page.title,
      url: page.url,
      accessibility: page.accessibility,
    })
    // Eight ignored accessibility nodes drop out of the 51 recorded elements.
    expect(unmeasured.counts.totalNodes).toBe(43)
    expect(unmeasured.nodes.every(node => node.visible)).toBe(true)
    expect(unmeasured.nodes.every(node => node.box === undefined)).toBe(true)
    // Unmeasured content inside the dialog survives.
    expect(unmeasured.nodes.some(node => node.name === 'Cancel')).toBe(true)
  })
})

describe('stable element references', () => {
  it('keeps every other reference when an unrelated sibling is inserted', () => {
    const before = weavePage(recordedPage())
    const page = recordedPage()
    const nav = findNode(page.document, 10)!
    nav.children!.splice(2, 0, {
      nodeId: 900,
      parentId: 10,
      nodeType: 1,
      nodeName: 'A',
      attributes: ['href', '/help'],
      children: [{ nodeId: 901, parentId: 900, nodeType: 3, nodeName: '#text', nodeValue: 'Help' }],
    })
    page.boxes['900'] = { x: 1064, y: 24, width: 48, height: 24 }
    const after = weavePage(page)

    const insertedRef = `${NAV}>link|Help|0`
    expect(after.nodes.map(node => node.ref)).toContain(insertedRef)
    expect(after.nodes).toHaveLength(before.nodes.length + 1)
    // Dropping the inserted entry leaves the earlier snapshot's references untouched.
    expect(after.nodes.filter(node => node.ref !== insertedRef).map(node => node.ref))
      .toEqual(before.nodes.map(node => node.ref))
  })

  it('keeps every other reference when a node is removed', () => {
    const before = weavePage(recordedPage())
    const page = recordedPage()
    const row = findNode(page.document, 63)!
    row.children!.splice(1, 1)
    const after = weavePage(page)

    expect(after.nodes.map(node => node.ref))
      .toEqual(before.nodes.map(node => node.ref).filter(ref => ref !== ONE_CELL))
  })

  it('suffixes the later of two entries whose paths encode identically', () => {
    // Role and name are joined with `|` and steps with `>`, so a name may
    // reproduce another node's whole path. The later node in document order
    // takes the `#2` suffix and every other reference is unchanged.
    const snapshot = weaveCustom({
      document: {
        nodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            nodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            children: [
              { nodeId: 3, nodeType: 1, nodeName: 'DIV', children: [
                { nodeId: 4, nodeType: 1, nodeName: 'SPAN' },
              ] },
              { nodeId: 5, nodeType: 1, nodeName: 'SPAN' },
            ],
          },
        ],
      },
      boxes: {
        '2': { x: 0, y: 0, width: 100, height: 100 },
        '3': { x: 0, y: 0, width: 50, height: 50 },
        '4': { x: 0, y: 0, width: 10, height: 10 },
        '5': { x: 50, y: 0, width: 10, height: 10 },
      },
      accessibility: [
        { nodeId: 'ax2', documentNodeId: 2, role: 'r', name: 'n' },
        { nodeId: 'ax3', documentNodeId: 3, role: 'r', name: 'n' },
        { nodeId: 'ax4', documentNodeId: 4, role: 'x', name: 'y' },
        { nodeId: 'ax5', documentNodeId: 5, role: 'r', name: 'n|0>x|y' },
      ],
    })
    expect(snapshot.nodes.map(node => node.ref)).toEqual([
      'r|n|0',
      'r|n|0>r|n|0',
      'r|n|0>r|n|0>x|y|0',
      'r|n|0>r|n|0>x|y|0#2',
    ])
  })
})

describe('bounds of the woven model', () => {
  it('enforces the node limit at the exact and one-past boundary', () => {
    const page = recordedPage()
    const exact = weavePage(page, { maxNodes: 39 })
    expect(exact).toEqual(weavePage(page))
    const over = weavePage(page, { maxNodes: 38 })
    expect(over.nodeLimitTruncated).toBe(true)
    expect(over.truncated).toBe(true)
    expect(over.counts).toMatchObject({ totalNodes: 39, returnedNodes: 38 })
    expect(over.nodes.map(node => node.ref)).toEqual(EXPECTED_REFS.slice(0, 38))
    expect(over.sizeLimitTruncated).toBe(false)
  })

  it('enforces the per-node text limit at the exact and one-past boundary', () => {
    const page = recordedPage()
    const exact = weavePage(page, { maxTextLength: 23 })
    expect(exact.textLimitTruncated).toBe(false)
    expect(entry(exact, H).name).toBe('Checkout — Fixture Shop')
    const over = weavePage(page, { maxTextLength: 22 })
    expect(over.textLimitTruncated).toBe(true)
    expect(over.truncated).toBe(true)
    // The reference keeps the full name; only the reported text is cut.
    expect(entry(over, H).name).toBe('Checkout — Fixture Sho')
  })

  it('enforces the text limit on values too', () => {
    const snapshot = weaveCustom({
      document: {
        nodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        children: [{ nodeId: 2, nodeType: 1, nodeName: 'INPUT', attributes: ['value', 'abcdefghij'] }],
      },
      boxes: { '2': { x: 0, y: 0, width: 10, height: 10 } },
      limits: { maxTextLength: 4 },
    })
    expect(snapshot.nodes[0]!.value).toBe('abcd')
    expect(snapshot.textLimitTruncated).toBe(true)
  })

  it('enforces the total-size limit at the exact and one-past byte boundary', () => {
    const page = recordedPage()
    const complete = weavePage(page, { maxBytes: 10_000_000 })
    const completeBytes = size(complete)

    // Exactly the complete model's size: nothing is dropped and no flag is set.
    const exact = weavePage(page, { maxBytes: completeBytes })
    expect(exact).toEqual(complete)
    expect(exact.sizeLimitTruncated).toBe(false)

    // One byte less: the ceiling bites, but the same entries still fit because
    // the truncation flags are shorter than the untruncated ones.
    const flagged = weavePage(page, { maxBytes: completeBytes - 1 })
    expect(flagged.sizeLimitTruncated).toBe(true)
    expect(flagged.truncated).toBe(true)
    expect(flagged.nodes).toHaveLength(complete.nodes.length)

    // One byte below the flagged model: trailing entries drop and the returned
    // model fits its ceiling.
    const flaggedBytes = size(flagged)
    const dropped = weavePage(page, { maxBytes: flaggedBytes - 1 })
    expect(dropped.sizeLimitTruncated).toBe(true)
    expect(dropped.nodeLimitTruncated).toBe(false)
    expect(dropped.counts).toMatchObject({ totalNodes: 39 })
    expect(dropped.nodes.length).toBeLessThan(complete.nodes.length)
    expect(dropped.nodes.map(node => node.ref))
      .toEqual(complete.nodes.slice(0, dropped.nodes.length).map(node => node.ref))
    expect(size(dropped)).toBeLessThanOrEqual(flaggedBytes - 1)
  })

  it('retains the page facts and reports the flag when no entry fits', () => {
    const over = weavePage(recordedPage(), { maxBytes: 8 })
    expect(over.nodes).toEqual([])
    expect(over.sizeLimitTruncated).toBe(true)
    expect(over.counts).toMatchObject({ totalNodes: 39, returnedNodes: 0, interactiveNodes: 0, visibleNodes: 0 })
    expect(over.title).toBe('Checkout — Fixture Shop')
    expect(over.url).toBe('https://fixture.shop/checkout')
    expect(over.viewport).toEqual({ width: 1280, height: 800 })
  })

  it('measures the size bound in UTF-8 bytes, not characters', () => {
    const page = recordedPage()
    const model = weavePage(page, { maxBytes: 10_000_000 })
    const text = JSON.stringify(model)
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(bytes).toBeGreaterThan(text.length)
    // A character-counted budget is already too small once bytes are counted.
    expect(weavePage(page, { maxBytes: text.length }).sizeLimitTruncated).toBe(true)
    expect(weavePage(page, { maxBytes: bytes }).sizeLimitTruncated).toBe(false)
  })
})

describe('determinism', () => {
  it('returns an identical model for the same input', () => {
    const first = weavePage(recordedPage())
    const second = weavePage(recordedPage())
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
