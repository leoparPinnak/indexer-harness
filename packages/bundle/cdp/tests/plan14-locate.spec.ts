/**
 * plan14: cdp_locate — "what is AT this point?".
 *
 * Four layers, all plain data + fakes (no browser needed):
 *  1. the pure engine: the page-side probe expression (read-only, embeds the
 *     point), the reply parser (an untrusted page answer is never repaired
 *     with invented fields), the shared `hitTestFailures` wording, the label
 *     and the render;
 *  2. `service.locate()` over a fake session: an empty point is DATA
 *     (ok:false + `no element at (x,y)` + `nearest`), an off-viewport point
 *     answers ok:true with a warning, a covered node names its occluder, and
 *     a non-finite point is refused WITHOUT touching the protocol;
 *  3. the tool envelope under `additionalProperties:false` (both branches),
 *     the negative undeclared-key case, and the render;
 *  4. the two-stage contract: locate NEVER clicks.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpService } from '../src/service.ts'
import { registerCdpTools } from '../src/tools.ts'
import {
  LOCATE_MAX_ANCESTRY,
  LOCATE_MAX_NEAREST_SCAN,
  buildLocateExpression,
  hitTestFailures,
  locateLabel,
  parseLocateReply,
  renderLocate,
} from '../src/locate.ts'
import type { PageEvaluation } from '../src/page.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A page that answered a hit test on `<button#save>`. */
const BUTTON_REPLY = {
  ok: true,
  url: 'https://example.com/',
  viewport: { width: 1280, height: 800 },
  node: {
    selector: 'button#save.primary',
    tag: 'button',
    id: 'save',
    classes: ['primary'],
    role: 'button',
    ariaLabel: '',
    text: 'Kaydet',
    rect: { x: 392, y: 270, width: 90, height: 36 },
    interactive: true,
    inViewport: true,
    zIndex: '',
    position: '',
    ancestry: ['div#toolbar', 'button#save.primary'],
    byBox: false,
  },
  nearest: null,
  warnings: [],
} as const

/** Nothing at the point — the aim correction the model needs. */
const EMPTY_REPLY = {
  ok: true,
  url: 'https://example.com/',
  viewport: { width: 1280, height: 800 },
  node: null,
  nearest: {
    selector: 'button#save.primary',
    tag: 'button',
    id: 'save',
    distance: 48.5,
    rect: { x: 392, y: 270, width: 90, height: 36 },
  },
  warnings: [],
} as const

/** A cookie banner sitting on top of the aimed point. */
const COVERED_REPLY = {
  ...BUTTON_REPLY,
  node: { ...BUTTON_REPLY.node, coveredBy: 'div#cookie-banner' },
} as const

/** The point is below the fold: identified by its box, never by a hit test. */
const OFFSCREEN_REPLY = {
  ...BUTTON_REPLY,
  node: { ...BUTTON_REPLY.node, inViewport: false, byBox: true, rect: { x: 392, y: 1180, width: 90, height: 36 } },
  warnings: ['no hit test at this point: the element was identified by its box, so scroll it into view before clicking'],
} as const

interface BootOptions {
  /** The JSON string the fake page returns. */
  reply?: unknown
  /** A verbatim (possibly malformed) value string from the page. */
  raw?: string
  /** A protocol-level evaluation failure. */
  error?: PageEvaluation['error']
  /** No value at all. */
  empty?: boolean
}

/** Boot a CdpService whose only capability is one page evaluation. */
function bootService(options: BootOptions = {}): { service: CdpService, calls: string[] } {
  const calls: string[] = []
  const evaluation = (): PageEvaluation => {
    if (options.error !== undefined) {
      return { value: '', truncated: false, exception: undefined, hasValue: false, valueType: 'undefined', error: options.error }
    }
    if (options.empty === true) {
      return { value: '', truncated: false, exception: undefined, hasValue: false, valueType: 'undefined' }
    }
    const raw = options.raw ?? JSON.stringify(options.reply ?? BUTTON_REPLY)
    return { value: raw, truncated: false, exception: undefined, hasValue: true, valueType: 'string' }
  }
  const service = Object.create(CdpService.prototype) as CdpService
  Object.assign(service, {
    registry: { active: () => ({ targetId: 'tab-1' }) },
    getPageSession: async () => ({
      sessionId: 's-1',
      evaluate: async (expression: string) => {
        calls.push(expression)
        return evaluation()
      },
    }),
  })
  return { service, calls }
}

// ---------------------------------------------------------------------------
// Layer 1 — the pure engine
// ---------------------------------------------------------------------------

describe('plan14: the locate probe expression', () => {
  it('embeds the point verbatim and reads it back through elementFromPoint', () => {
    const expression = buildLocateExpression(412.5, 288)
    expect(expression).toContain('412.5')
    expect(expression).toContain('288')
    expect(expression).toContain('elementFromPoint')
    // Two independent hit tests: the identification, plus the fresh read
    // cdp_click performs at action time (that is what makes coveredBy real).
    expect(expression.match(/elementFromPoint/g)?.length).toBe(2)
  })

  it('is read-only: no attribute write, no innerHTML, no window slot', () => {
    const expression = buildLocateExpression(10, 20)
    expect(expression).not.toContain('.setAttribute(')
    expect(expression).not.toContain('innerHTML')
    expect(expression).not.toContain('outerHTML')
    expect(expression).not.toContain('window.__dsh')
    expect(expression).not.toContain('.click()')
    expect(expression).not.toContain('.dispatchEvent(')
  })

  it('bounds the fallback sweep instead of walking an unbounded document', () => {
    expect(buildLocateExpression(1, 1)).toContain(`MAX_SCAN = ${String(LOCATE_MAX_NEAREST_SCAN)}`)
  })
})

describe('plan14: parseLocateReply', () => {
  it('reads a hit node with every field the contract promises', () => {
    const parsed = parseLocateReply(JSON.stringify(BUTTON_REPLY))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.node).toMatchObject({
      tag: 'button',
      id: 'save',
      role: 'button',
      interactive: true,
      inViewport: true,
      text: 'Kaydet',
    })
    expect(parsed.record.node?.rect).toEqual({ x: 392, y: 270, width: 90, height: 36 })
    expect(parsed.record.node?.ancestry).toEqual(['div#toolbar', 'button#save.primary'])
    expect(parsed.record.node?.coveredBy).toBeUndefined()
  })

  it('keeps coveredBy only when the page measured one', () => {
    const parsed = parseLocateReply(JSON.stringify(COVERED_REPLY))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.node?.coveredBy).toBe('div#cookie-banner')
  })

  it('an empty point stays an empty record — never a fabricated node', () => {
    const parsed = parseLocateReply(JSON.stringify(EMPTY_REPLY))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.node).toBeNull()
    expect(parsed.record.nearest?.distance).toBe(48.5)
    expect(parsed.record.nearest?.selector).toBe('button#save.primary')
  })

  it('refuses unparseable data and a failed probe instead of guessing', () => {
    const broken = parseLocateReply('{not json')
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.reason).toContain('unparseable')

    const failed = parseLocateReply(JSON.stringify({ ok: false, error: 'boom' }))
    expect(failed.ok).toBe(false)
    if (failed.ok) return
    expect(failed.reason).toContain('boom')
  })

  it('caps ancestry and class lists at the documented bounds', () => {
    const parsed = parseLocateReply(JSON.stringify({
      ...BUTTON_REPLY,
      node: {
        ...BUTTON_REPLY.node,
        classes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
        ancestry: ['1', '2', '3', '4', '5', '6', '7'],
      },
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.node?.classes.length).toBeLessThanOrEqual(8)
    expect(parsed.record.node?.ancestry.length).toBeLessThanOrEqual(LOCATE_MAX_ANCESTRY)
  })
})

describe('plan14: locateLabel / hitTestFailures', () => {
  it('labels a node the same way everywhere: tag#id.class', () => {
    expect(locateLabel('button', 'save', ['primary'])).toBe('button#save.primary')
    expect(locateLabel('div', '', ['toolbar', 'sticky'])).toBe('div.toolbar.sticky')
    expect(locateLabel('span', '')).toBe('span')
    expect(locateLabel('', '')).toBe('?')
  })

  it('the shared wording names the occluder, never a vague "blocked"', () => {
    expect(hitTestFailures({ visible: true, inViewport: true, hitTarget: false, coveredBy: 'div#banner' }))
      .toEqual(['covered by div#banner'])
    expect(hitTestFailures({ visible: true, inViewport: false, hitTarget: true }))
      .toEqual(['outside the viewport'])
    expect(hitTestFailures({ visible: true, inViewport: true, coveredBy: 'div#banner' }))
      .toEqual(['covered by div#banner'])
    expect(hitTestFailures({ visible: false, inViewport: true }))
      .toEqual(['not visible'])
    expect(hitTestFailures({ visible: true, inViewport: true, hitTarget: true })).toEqual([])
  })
})

describe('plan14: renderLocate', () => {
  it('prints the identity, the aim, and the component it sits in', () => {
    const parsed = parseLocateReply(JSON.stringify(BUTTON_REPLY))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const text = renderLocate({
      ok: true,
      x: 412,
      y: 288,
      warnings: parsed.record.warnings,
      ...(parsed.record.node !== null ? { node: parsed.record.node } : {}),
    })
    expect(text).toContain('<button#save.primary "Kaydet">')
    expect(text).toContain('role=button')
    expect(text).toContain('tıklanabilir')
    expect(text).toContain('(412,288)')
    expect(text).toContain('kapsam: div#toolbar > button#save.primary')
  })

  it('an empty point renders the nearest element and its distance', () => {
    const parsed = parseLocateReply(JSON.stringify(EMPTY_REPLY))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const text = renderLocate({
      ok: false,
      x: 412,
      y: 288,
      reason: 'no element at (412,288)',
      warnings: [],
      ...(parsed.record.nearest !== null ? { nearest: parsed.record.nearest } : {}),
    })
    expect(text).toContain('Boş nokta (412,288)')
    expect(text).toContain('no element at (412,288)')
    expect(text).toContain('button#save.primary')
    expect(text).toContain('48.5px uzakta')
  })

  it('surfaces warnings verbatim instead of burying them', () => {
    const text = renderLocate({
      ok: true,
      x: 1,
      y: 2,
      warnings: ['covered by div#banner'],
      node: {
        selector: 'button#save.primary',
        tag: 'button',
        id: 'save',
        classes: ['primary'],
        role: 'button',
        ariaLabel: '',
        text: 'Kaydet',
        rect: { x: 0, y: 0, width: 10, height: 10 },
        interactive: true,
        inViewport: true,
        coveredBy: 'div#banner',
        zIndex: '',
        position: '',
        ancestry: ['button#save.primary'],
        byBox: false,
      },
    })
    expect(text).toContain('Uyarılar:')
    expect(text).toContain('- covered by div#banner')
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — service.locate honesty
// ---------------------------------------------------------------------------

describe('plan14: service.locate honesty', () => {
  it('a non-finite point is refused in-band WITHOUT touching the protocol', async () => {
    const { service, calls } = bootService()
    const outcome = await service.locate({ x: Number.NaN, y: 10 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('finite x and y')
    expect(outcome.node).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('an empty point is ok:false + "no element at (x,y)" + nearest — never {}', async () => {
    const { service } = bootService({ reply: EMPTY_REPLY })
    const outcome = await service.locate({ x: 412, y: 288 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no element at (412,288)')
    expect(outcome.node).toBeUndefined()
    expect(outcome.nearest?.selector).toBe('button#save.primary')
    expect(outcome.nearest?.distance).toBe(48.5)
    expect(outcome.url).toBe('https://example.com/')
    // the aim is echoed so a render can never leave it implicit
    expect([outcome.x, outcome.y]).toEqual([412, 288])
  })

  it('a point on a button answers the full identity, ok:true', async () => {
    const { service } = bootService()
    const outcome = await service.locate({ x: 412, y: 288 })
    expect(outcome.ok).toBe(true)
    expect(outcome.node?.tag).toBe('button')
    expect(outcome.node?.id).toBe('save')
    expect(outcome.node?.role).toBe('button')
    expect(outcome.node?.interactive).toBe(true)
    expect(outcome.node?.inViewport).toBe(true)
    expect(outcome.node?.rect).toEqual({ x: 392, y: 270, width: 90, height: 36 })
    expect(outcome.node?.text).toBe('Kaydet')
    expect(outcome.node?.ancestry).toContain('div#toolbar')
    expect(outcome.viewport).toEqual({ width: 1280, height: 800 })
    expect(outcome.warnings).toEqual([])
  })

  it('a covered point names the occluder AND warns that a click would miss', async () => {
    const { service } = bootService({ reply: COVERED_REPLY })
    const outcome = await service.locate({ x: 412, y: 288 })
    expect(outcome.ok).toBe(true)
    expect(outcome.node?.coveredBy).toBe('div#cookie-banner')
    expect(outcome.warnings.some(line => line.includes('covered by div#cookie-banner'))).toBe(true)
  })

  it('an off-viewport point answers ok:true with inViewport:false and a warning', async () => {
    const { service } = bootService({ reply: OFFSCREEN_REPLY })
    const outcome = await service.locate({ x: 412, y: 1200 })
    expect(outcome.ok).toBe(true)
    expect(outcome.node?.inViewport).toBe(false)
    expect(outcome.node?.byBox).toBe(true)
    expect(outcome.warnings.some(line => line.includes('outside the viewport'))).toBe(true)
  })

  it('a page that cannot answer is ok:false + reason, never a thrown probe', async () => {
    const failed = await bootService({
      error: { kind: 'exception', exception: 'boom', expression: 'x' } as never,
    }).service.locate({ x: 1, y: 2 })
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('page-side probe failed')

    const empty = await bootService({ empty: true }).service.locate({ x: 1, y: 2 })
    expect(empty.ok).toBe(false)
    expect(empty.reason).toContain('no value')

    const garbage = await bootService({ raw: '{oops' }).service.locate({ x: 1, y: 2 })
    expect(garbage.ok).toBe(false)
    expect(garbage.reason).toContain('unparseable')
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — the tool envelope
// ---------------------------------------------------------------------------

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bootTools(service: unknown): Promise<Map<string, ToolDefinition>> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  })
  registerCdpTools(ctx, service as CdpService)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  if (tools.size === 0) throw new Error('plan14: registerCdpTools registered zero tools')
  return tools
}

const fakeService = (locate: (options: { x: number, y: number, targetId?: string }) => Promise<unknown>): unknown => ({
  status: async () => ({ ok: true, version: '0.0.0' }),
  locate,
})

const nodeOf = (reply: typeof BUTTON_REPLY) => JSON.parse(JSON.stringify(reply.node)) as Record<string, unknown>
const locateOutcome = (reply: unknown) => {
  const parsed = parseLocateReply(JSON.stringify(reply))
  if (!parsed.ok) throw new Error('fixture is not a valid reply')
  return parsed.record
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const violationsOf = (definition: ToolDefinition | undefined, value: unknown): unknown[] =>
  validateJsonSchemaValue(definition!.output.schema as never, value as never)

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

describe('plan14: cdp_locate tool envelope', () => {
  it('is registered and describes the two-stage look→verify→click contract', async () => {
    const tools = await bootTools(fakeService(async () => ({ ok: false, x: 0, y: 0, targetId: '', url: '', warnings: [] })))
    const definition = tools.get('cdp_locate')
    expect(definition).toBeDefined()
    expect(definition?.description).toContain('cdp_screenshot')
    expect(definition?.description).toContain('cdp_locate')
    expect(definition?.description).toContain('cdp_click')
    expect(definition?.description).toContain('PROBE')
  })

  it('forwards the point (and the target) to the service', async () => {
    const seen: Array<{ x: number, y: number, targetId?: string }> = []
    const tools = await bootTools(fakeService(async (options) => {
      seen.push(options)
      return { ok: false, x: options.x, y: options.y, targetId: '', url: '', warnings: [] }
    }))
    await execute(tools.get('cdp_locate'), { x: 412, y: 288, targetId: 'tab-9' })
    expect(seen).toEqual([{ x: 412, y: 288, targetId: 'tab-9' }])
  })

  it('validates the ok branch under additionalProperties:false', async () => {
    const record = locateOutcome(COVERED_REPLY)
    const tools = await bootTools(fakeService(async () => ({
      ok: true,
      x: 412,
      y: 288,
      targetId: 'tab-1',
      url: record.url,
      warnings: ['covered by div#cookie-banner'],
      node: record.node,
      viewport: record.viewport,
    })))
    const value = await execute(tools.get('cdp_locate'), { x: 412, y: 288 })
    expect(violationsOf(tools.get('cdp_locate'), value)).toEqual([])
  })

  it('validates the empty branch (nearest + reason, no node)', async () => {
    const record = locateOutcome(EMPTY_REPLY)
    const tools = await bootTools(fakeService(async () => ({
      ok: false,
      x: 412,
      y: 288,
      targetId: 'tab-1',
      url: record.url,
      warnings: [],
      reason: 'no element at (412,288)',
      nearest: record.nearest,
    })))
    const value = await execute(tools.get('cdp_locate'), { x: 412, y: 288 })
    expect(violationsOf(tools.get('cdp_locate'), value)).toEqual([])
  })

  it('still rejects an undeclared key, keeping the schema strict', async () => {
    const tools = await bootTools(fakeService(async () => ({
      ok: true,
      x: 1,
      y: 2,
      targetId: 'tab-1',
      url: 'https://example.com/',
      warnings: [],
      node: { ...nodeOf(BUTTON_REPLY), unexpected: 'field' },
      viewport: { width: 800, height: 600 },
    })))
    const value = await execute(tools.get('cdp_locate'), { x: 1, y: 2 })
    const violations = violationsOf(tools.get('cdp_locate'), value)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unexpected')
  })

  it('renders the readable identity line and the warnings/nearest rows', async () => {
    const tools = await bootTools(fakeService(async () => ({
      ok: true,
      x: 412,
      y: 288,
      targetId: 'tab-1',
      url: 'https://example.com/',
      warnings: ['the point is outside the viewport: scroll it into view first'],
      node: nodeOf(BUTTON_REPLY),
      viewport: { width: 1280, height: 800 },
    })))
    const value = await execute(tools.get('cdp_locate'), { x: 412, y: 288 })
    const text = renderOf(tools.get('cdp_locate'), { x: 412, y: 288 }, value)
    expect(text).toContain('<button#save.primary "Kaydet">')
    expect(text).toContain('tıklanabilir')
    expect(text).toContain('kapsam: div#toolbar > button#save.primary')
    expect(text).toContain('Uyarılar:')

    const emptyTools = await bootTools(fakeService(async () => ({
      ok: false,
      x: 412,
      y: 288,
      targetId: 'tab-1',
      url: 'https://example.com/',
      warnings: [],
      reason: 'no element at (412,288)',
      nearest: locateOutcome(EMPTY_REPLY).nearest,
    })))
    const emptyValue = await execute(emptyTools.get('cdp_locate'), { x: 412, y: 288 })
    const emptyText = renderOf(emptyTools.get('cdp_locate'), { x: 412, y: 288 }, emptyValue)
    expect(emptyText).toContain('Boş nokta (412,288)')
    expect(emptyText).toContain('button#save.primary')
  })
})
