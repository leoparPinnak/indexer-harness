/**
 * plan15-viewport (defect 1): `cdp_viewport` verified a viewport change with a
 * METRICS READ ALONE and reported success. A change the browser accepted but
 * never told the page about therefore answered `applied` — the exact case
 * observed live, where a 1037 -> 900 -> 700 sequence fired the page's resize
 * handler 0 times while the tool kept saying it had. Worse, the agent asking
 * for a "freshly measured" rect was handed a number the page had never
 * reflowed to, so a target could slide under the crosshair between the
 * measurement and the click (v7pos 56 -> 52 was observed doing exactly that).
 *
 * Three things are proved here, each with the evidence the tool now reports:
 *  1. the page's OWN resize handler ran — a page-side counter brackets the
 *     Emulation call, and a counter that stayed at zero is an honest ok:false;
 *  2. `appliedViewport` is the viewport measured at DISPATCH time, so the
 *     non-atomic `reset` (and any parallel agent moving the shared window) is
 *     visible instead of hidden;
 *  3. an unreadable counter is `unverified` — never `delivered`, never
 *     `not-delivered`: absence of evidence is not evidence of a broken resize.
 *
 * The two page-side expressions are executed for real against a fake `window`
 * here, so the counter semantics (arm, reuse one listener, count, report) are
 * tested rather than asserted as text.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpService } from '../src/service.ts'
import {
  parseResizeProbeAnswer,
  renderViewportOutcomeText,
  RESIZE_PROBE_ARM_EXPRESSION,
  RESIZE_PROBE_READ_EXPRESSION,
  resizeNotDeliveredReason,
  type ViewportApplyOutcome,
  type ViewportApplySuccess,
} from '../src/capture.ts'
import { apply, DEFAULT_PROXY_LISTEN_PORT, DEFAULT_REMOTE_DEBUGGING_PORT } from '../src/index.ts'
import type { Config as CdpConfig } from '../src/index.ts'

/** The exact sentence the not-delivered failure has to carry. */
const NOT_DELIVERED = 'page resize event not delivered (visibilityState=visible, document.hidden=false); re-measure after a real window resize'

type Handler = (params?: Record<string, unknown>) => unknown

interface SentEntry {
  readonly method: string
  readonly params?: Record<string, unknown>
  readonly sessionId?: string | undefined
}

interface FakeSender {
  readonly sender: {
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>
  }
  readonly sent: SentEntry[]
}

/** A sender whose handlers can throw to force a probe step to fail. */
function fakeSender(handlers: Record<string, Handler>): FakeSender {
  const sent: SentEntry[] = []
  return {
    sender: {
      send: (method, params, sessionId) => {
        sent.push({ method, ...(params !== undefined ? { params } : {}), sessionId })
        const handler = handlers[method]
        if (handler === undefined) return Promise.resolve({})
        try {
          return Promise.resolve(handler(params))
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)))
        }
      },
    },
    sent,
  }
}

/**
 * A CdpService whose connection/session seams point at a fake sender, so the
 * real applyViewport path (arm, measure, dispatch, verify) runs without one.
 */
function wireService(handlers: Record<string, Handler>): { service: CdpService, sent: SentEntry[] } {
  const { sender, sent } = fakeSender(handlers)
  const service = new CdpService()
  const seams = service as unknown as {
    connection: unknown
    getPageSession: (targetId?: string) => Promise<unknown>
  }
  seams.connection = {
    connected: true,
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => sender.send(method, params, sessionId),
  }
  seams.getPageSession = async () => ({
    sessionId: 'sess-1',
    title: async () => 'Live page',
    url: async () => 'https://example.com/live',
  })
  return { service, sent }
}

/** Narrow one outcome to its success half, failing loudly otherwise. */
function success(outcome: ViewportApplyOutcome): ViewportApplySuccess {
  if (outcome.ok !== true) throw new Error(`expected an applied outcome, got: ${JSON.stringify(outcome)}`)
  return outcome
}

/** One page-side counter answer, as the real `returnByValue` payload. */
function probeReply(payload: Record<string, unknown>): Handler {
  return () => ({ result: { type: 'object', value: JSON.stringify(payload) } })
}

/**
 * Handlers for a mutating viewport call whose page-side counter reports
 * `events` resize events (0 = the page never heard about the change).
 */
function resizeHandlers(
  events: number,
  live: { width: number, height: number, dpr: number },
  options: { readonly arm?: 'ok' | 'unavailable'; readonly metricsBefore?: { width: number, height: number, dpr: number } } = {},
): Record<string, Handler> {
  let overridden = false
  const before = options.metricsBefore ?? live
  return {
    'Page.getLayoutMetrics': () => {
      const box = overridden ? live : before
      return { cssVisualViewport: { cssWidth: box.width, cssHeight: box.height, deviceScaleFactor: box.dpr } }
    },
    'Emulation.setDeviceMetricsOverride': (params) => {
      overridden = true
      expect(params).toMatchObject({ width: live.width, height: live.height })
      return {}
    },
    'Emulation.clearDeviceMetricsOverride': () => {
      overridden = false
      return {}
    },
    'Runtime.evaluate': params => {
      const expression = typeof params?.expression === 'string' ? params.expression : ''
      if (expression.includes('addEventListener')) {
        if (options.arm === 'unavailable') return probeReply({ ok: false, why: 'no-window' })()
        return probeReply({ ok: true, n: 0, w: before.width, h: before.height, state: 'visible', hidden: false })()
      }
      return probeReply({ ok: true, n: events, w: live.width, h: live.height, state: 'visible', hidden: false, liveW: live.width, liveH: live.height })()
    },
  }
}

// ── the page-side probe itself, executed for real ───────────────────────────

interface FakeWindow {
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
  __dshResizeProbe?: Record<string, unknown>
  __resizeProbe?: unknown
  addEventListener: (type: string, listener: () => void, capture?: boolean) => void
  removeEventListener: (type: string, listener: () => void, capture?: boolean) => void
  readonly listeners: Array<{ type: string, listener: () => void }>
}

interface FakePage {
  readonly window: FakeWindow
  readonly document: { readonly visibilityState: string, readonly hidden: boolean }
}

/** A page whose window records listeners and can fire them, like a real one. */
function fakePage(visibilityState = 'visible', hidden = false): FakePage {
  const listeners: Array<{ type: string, listener: () => void }> = []
  const win: FakeWindow = {
    innerWidth: 1037,
    innerHeight: 800,
    devicePixelRatio: 2,
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: (type, listener) => {
      const at = listeners.findIndex(entry => entry.type === type && entry.listener === listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    listeners,
  }
  return { window: win, document: { visibilityState, hidden } }
}

/** Run one page expression exactly as `Runtime.evaluate` would, in the page. */
function runInPage(expression: string, page: FakePage): unknown {
  const factory = new Function('window', 'document', 'JSON', `return ${expression}`) as (
    w: unknown, d: unknown, j: unknown,
  ) => unknown
  return factory(page.window, page.document, JSON)
}

/** Parse one page expression's JSON answer. */
function readPageAnswer(expression: string, page: FakePage): Record<string, unknown> {
  const answer = runInPage(expression, page)
  expect(typeof answer).toBe('string')
  return JSON.parse(String(answer)) as Record<string, unknown>
}

describe('plan15-viewport: the page-side counter, executed', () => {
  it('the arm installs exactly one resize listener and publishes the named probe', () => {
    const page = fakePage()
    const answer = readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    expect(answer.ok).toBe(true)
    expect(answer.n).toBe(0)
    expect(page.window.listeners.filter(entry => entry.type === 'resize')).toHaveLength(1)
    // The contract name the bug report named, mirrored from the namespaced one.
    expect(page.window.__resizeProbe).toBe(page.window.__dshResizeProbe)
  })

  it('re-arming reuses the listener instead of stacking a second one', () => {
    const page = fakePage()
    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    expect(page.window.listeners.filter(entry => entry.type === 'resize')).toHaveLength(1)
  })

  it('counts the resize events the page really receives, and zeroes between arms', () => {
    const page = fakePage()
    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    for (const entry of [...page.window.listeners]) entry.listener()
    page.window.innerWidth = 700
    for (const entry of [...page.window.listeners]) entry.listener()
    let reading = readPageAnswer(RESIZE_PROBE_READ_EXPRESSION, page)
    expect(reading.n).toBe(2)
    expect(reading.w).toBe(700)
    expect(reading.liveW).toBe(700)
    expect(reading.state).toBe('visible')
    expect(reading.hidden).toBe(false)

    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    reading = readPageAnswer(RESIZE_PROBE_READ_EXPRESSION, page)
    expect(reading.n).toBe(0)
  })

  it('reports the page-side state the honest failure reason quotes', () => {
    const page = fakePage('hidden', true)
    readPageAnswer(RESIZE_PROBE_ARM_EXPRESSION, page)
    const reading = readPageAnswer(RESIZE_PROBE_READ_EXPRESSION, page)
    expect(reading.state).toBe('hidden')
    expect(reading.hidden).toBe(true)
  })

  it('a page with no window answers ok:false instead of throwing', () => {
    const page = fakePage()
    // A target with no window: the arm's own guard is what answers.
    const bare = new Function('window', 'document', 'JSON', `return ${RESIZE_PROBE_ARM_EXPRESSION}`) as (
      w: unknown, d: unknown, j: unknown,
    ) => unknown
    const answer = JSON.parse(String(bare(undefined, page.document, JSON))) as Record<string, unknown>
    expect(answer.ok).toBe(false)
    expect(answer.why).toBe('no-window')
  })

  it('an unarmed read answers ok:false rather than inventing a zero', () => {
    const page = fakePage()
    const answer = readPageAnswer(RESIZE_PROBE_READ_EXPRESSION, page)
    expect(answer.ok).toBe(false)
    expect(answer.why).toBe('not-armed')
    expect(answer.n).toBeUndefined()
  })

  it('neither expression carries a backtick, and both read the signals by name', () => {
    for (const expression of [RESIZE_PROBE_ARM_EXPRESSION, RESIZE_PROBE_READ_EXPRESSION]) {
      // A backtick inside a template literal would close it and lock the tests.
      expect(expression).not.toContain('`')
      expect(expression).toContain('document.visibilityState')
      expect(expression).toContain('document.hidden')
    }
    expect(RESIZE_PROBE_ARM_EXPRESSION).toContain("window.addEventListener('resize'")
  })
})

// ── parseResizeProbeAnswer ─────────────────────────────────────────────────

describe('plan15-viewport: parseResizeProbeAnswer', () => {
  it('reads a JSON string answer and an already-parsed record alike', () => {
    const record = { ok: true, n: 3, w: 700, h: 900, state: 'visible', hidden: false }
    expect(parseResizeProbeAnswer(JSON.stringify(record))).toEqual({
      events: 3,
      observedWidth: 700,
      observedHeight: 900,
      visibilityState: 'visible',
      documentHidden: false,
    })
    expect(parseResizeProbeAnswer(record)).toEqual(parseResizeProbeAnswer(JSON.stringify(record)))
  })

  it('never turns an unusable answer into a zero', () => {
    for (const bad of ['', 'not json', '{"ok":false}', '{}', '[1,2]', null, undefined, 7, { ok: true }, { ok: true, n: 'two' }, { ok: true, n: Number.NaN }]) {
      expect(parseResizeProbeAnswer(bad)).toBeUndefined()
    }
  })

  it('omits the page-side evidence the page did not report', () => {
    const reading = parseResizeProbeAnswer({ ok: true, n: 1 })
    expect(reading).toEqual({ events: 1, observedWidth: 0, observedHeight: 0 })
    expect(reading?.visibilityState).toBeUndefined()
    expect(reading?.documentHidden).toBeUndefined()
  })
})

// ── applyViewport ──────────────────────────────────────────────────────────

describe('plan15-viewport: a change the page never heard about', () => {
  it('answers ok:false with the exact honest reason instead of "applied"', async () => {
    const { service } = wireService(resizeHandlers(0, { width: 700, height: 900, dpr: 1 }, {
      metricsBefore: { width: 1037, height: 800, dpr: 1 },
    }))
    const outcome = await service.applyViewport({ width: 700, height: 900, deviceScaleFactor: 1 })

    expect(outcome.ok).toBe(false)
    if (outcome.ok === true) throw new Error('unreachable')
    expect(outcome.reason).toBe(NOT_DELIVERED)
    expect(outcome.resizeEvent).toEqual({
      delivered: 'not-delivered',
      events: 0,
      visibilityState: 'visible',
      documentHidden: false,
    })
    // The measured numbers are still reported: the caller needs to know where
    // the page ended up and what this call acted on.
    expect(outcome.viewport).toEqual({ width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
    expect(outcome.appliedViewport).toEqual({ width: 1037, height: 800, deviceScaleFactor: 1, mobile: false })
  })

  it('still reports the numbers, but only when the page really resized', async () => {
    const { service } = wireService(resizeHandlers(1, { width: 700, height: 900, dpr: 1 }, {
      metricsBefore: { width: 1037, height: 800, dpr: 1 },
    }))
    const outcome = success(await service.applyViewport({ width: 700, height: 900, deviceScaleFactor: 1 }))
    expect(outcome.applied).toBe(true)
    expect(outcome.source).toBe('override')
    expect(outcome.viewport).toEqual({ width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
    expect(outcome.resizeEvent?.delivered).toBe('delivered')
    expect(outcome.resizeEvent?.events).toBe(1)
  })

  it('arms the counter BEFORE the Emulation call and reads it back after', async () => {
    const { service, sent } = wireService(resizeHandlers(2, { width: 700, height: 900, dpr: 1 }))
    await service.applyViewport({ width: 700, height: 900, deviceScaleFactor: 1 })

    const evaluateIndexes = sent
      .map((entry, index) => ({ entry, index }))
      .filter(row => row.entry.method === 'Runtime.evaluate')
      .map(row => row.index)
    const isArm = (index: number): boolean =>
      String(sent[index]?.params?.expression).includes('addEventListener')
    const set = sent.findIndex(entry => entry.method === 'Emulation.setDeviceMetricsOverride')

    expect(evaluateIndexes.length).toBeGreaterThanOrEqual(2)
    expect(evaluateIndexes.some(isArm)).toBe(true)
    // The arm precedes the dispatch, and the counter read follows it: that
    // ordering is what makes the page-side evidence a proof rather than a hope.
    expect(Math.max(...evaluateIndexes.filter(isArm))).toBeLessThan(set)
    expect(evaluateIndexes.filter(index => !isArm(index) && index > set)).toHaveLength(1)
  })
})

describe('plan15-viewport: appliedViewport witnesses the non-atomic reset', () => {
  it('reports the acted-on size and the verified size separately on reset', async () => {
    // The shared window is 1280x1024 while the override is active, and the
    // live window underneath is 492x780: an agent that only read the
    // post-state could never see that a parallel caller moved the window.
    let metricsCalls = 0
    const { service, sent } = wireService({
      ...resizeHandlers(1, { width: 1280, height: 1024, dpr: 1 }),
      'Page.getLayoutMetrics': () => (metricsCalls++ === 0)
        ? { cssVisualViewport: { cssWidth: 1280, cssHeight: 1024, deviceScaleFactor: 1 } }
        : { cssVisualViewport: { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 } },
    })

    const outcome = success(await service.applyViewport({ reset: true }))
    expect(outcome.applied).toBe(true)
    expect(outcome.source).toBe('live-window')
    expect(outcome.appliedViewport).toEqual({ width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false })
    expect(outcome.viewport).toEqual({ width: 492, height: 780, deviceScaleFactor: 2, mobile: false })
    expect(sent.some(entry => entry.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
  })

  it('a counter the page could not install is unverified, never a failure', async () => {
    const { service } = wireService(resizeHandlers(0, { width: 700, height: 900, dpr: 1 }, { arm: 'unavailable' }))
    const outcome = success(await service.applyViewport({ width: 700, height: 900, deviceScaleFactor: 1 }))
    expect(outcome.applied).toBe(true)
    expect(outcome.resizeEvent).toEqual({ delivered: 'unverified' })
  })

  it('a counter armed but unreadable is unverified too — absence is not zero', async () => {
    const { service } = wireService({
      ...resizeHandlers(1, { width: 700, height: 900, dpr: 1 }),
      'Runtime.evaluate': (params) => {
        const expression = typeof params?.expression === 'string' ? params.expression : ''
        if (expression.includes('addEventListener')) return probeReply({ ok: true, n: 0 })()
        return probeReply({ ok: false, why: 'read-threw' })()
      },
    })
    const outcome = success(await service.applyViewport({ width: 700, height: 900, deviceScaleFactor: 1 }))
    expect(outcome.applied).toBe(true)
    expect(outcome.resizeEvent).toEqual({ delivered: 'unverified' })
  })

  it('a report-only call changes nothing and therefore probes nothing', async () => {
    const { service, sent } = wireService(resizeHandlers(1, { width: 1037, height: 800, dpr: 2 }))
    const outcome = success(await service.applyViewport({}))
    expect(outcome.applied).toBe(false)
    expect(outcome.appliedViewport).toBeUndefined()
    expect(outcome.resizeEvent).toBeUndefined()
    expect(sent.some(entry => entry.method.startsWith('Emulation.'))).toBe(false)
    expect(sent.some(entry => entry.method === 'Runtime.evaluate')).toBe(false)
  })
})

// ── the honest reason, and how it reads ────────────────────────────────────

describe('plan15-viewport: the reason text', () => {
  it('quotes the page-side state, and "unknown" when it could not be read', () => {
    expect(resizeNotDeliveredReason({
      delivered: 'not-delivered',
      events: 0,
      visibilityState: 'visible',
      documentHidden: false,
    })).toBe(NOT_DELIVERED)
    expect(resizeNotDeliveredReason({ delivered: 'not-delivered' }))
      .toBe('page resize event not delivered (visibilityState=unknown, document.hidden=unknown); re-measure after a real window resize')
    expect(resizeNotDeliveredReason(undefined)).toContain('visibilityState=unknown')
  })

  it('renders the reason — not the pre-fix "unknown error" — for a failure', () => {
    const text = renderViewportOutcomeText({
      ok: false,
      reason: NOT_DELIVERED,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1 },
      appliedViewport: { width: 1037, height: 800, deviceScaleFactor: 1 },
      resizeEvent: { delivered: 'not-delivered', events: 0 },
    })
    expect(text).toContain('Viewport FAILED')
    expect(text).toContain(NOT_DELIVERED)
    expect(text).toContain('measured 700x900')
    expect(text).toContain('acted on 1037x800')
    expect(text).toContain('page resize NOT delivered')
    expect(text).not.toContain('unknown error')
  })

  it('keeps rendering a thrown envelope exactly as before', () => {
    expect(renderViewportOutcomeText({ ok: false, error: { name: 'CdpViewportError', message: 'width and height must be provided together' } }))
      .toBe('Viewport call failed: CdpViewportError: width and height must be provided together')
  })

  it('a success names the delivery; an unverified one is never read as delivered', () => {
    expect(renderViewportOutcomeText({
      ok: true,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: false },
      source: 'override',
      applied: true,
      appliedViewport: { width: 1037, height: 800, deviceScaleFactor: 1 },
      resizeEvent: { delivered: 'delivered', events: 1 },
    })).toBe('Viewport applied: 700x900 css @dpr1 [override]. [acted on 1037x800 css @dpr1] page resize delivered (1 event(s)).')

    const unverified = renderViewportOutcomeText({
      ok: true,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: false },
      source: 'override',
      applied: true,
      resizeEvent: { delivered: 'unverified' },
    })
    expect(unverified).toContain('page resize unverified')
    expect(unverified).not.toContain('page resize delivered')
  })

  it('renders without throwing on a value that carries no fields at all', () => {
    expect(renderViewportOutcomeText({})).toContain('Viewport call failed')
    expect(renderViewportOutcomeText({ ok: true })).toContain('Viewport (report only)')
  })
})

// ── the shipped tool contract ──────────────────────────────────────────────

const CONFIG: CdpConfig = {
  remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
  proxyListenPort: DEFAULT_PROXY_LISTEN_PORT,
  guideAssetsDir: '',
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the plugin and return its registered tools. */
async function registeredTools(): Promise<Map<string, ToolDefinition>> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('webServer', { host: '127.0.0.1', port: 4567, register: () => () => {} })
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  })
  apply(ctx, CONFIG)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return tools
}

describe('plan15-viewport: cdp_viewport output contract', () => {
  it('accepts the not-delivered envelope, acted-on viewport included', async () => {
    const tools = await registeredTools()
    const viewport = tools.get('cdp_viewport')
    expect(viewport, 'cdp_viewport must be registered').toBeDefined()

    const value = {
      ok: false,
      reason: NOT_DELIVERED,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: false },
      appliedViewport: { width: 1037, height: 800, deviceScaleFactor: 2, mobile: false },
      resizeEvent: { delivered: 'not-delivered', events: 0, visibilityState: 'visible', documentHidden: false },
    }
    expect(validateJsonSchemaValue(viewport?.output.schema as never, value)).toEqual([])
  })

  it('accepts the applied envelope with the delivery evidence', async () => {
    const tools = await registeredTools()
    const viewport = tools.get('cdp_viewport')
    const value = {
      ok: true,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: true },
      source: 'override',
      applied: true,
      appliedViewport: { width: 1037, height: 800, deviceScaleFactor: 2, mobile: false },
      resizeEvent: { delivered: 'delivered', events: 2, visibilityState: 'visible', documentHidden: false },
    }
    expect(validateJsonSchemaValue(viewport?.output.schema as never, value)).toEqual([])
  })

  it('keeps the schema strict: an undeclared key is still rejected', async () => {
    const tools = await registeredTools()
    const viewport = tools.get('cdp_viewport')
    const violations = validateJsonSchemaValue(viewport?.output.schema as never, {
      ok: true,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: false },
      source: 'override',
      applied: true,
      resizeEvent: { delivered: 'delivered', events: 1, unexpected: 'field' },
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unexpected')
  })

  it('rejects a delivery verdict outside the declared three', async () => {
    const tools = await registeredTools()
    const viewport = tools.get('cdp_viewport')
    const violations = validateJsonSchemaValue(viewport?.output.schema as never, {
      ok: true,
      viewport: { width: 700, height: 900, deviceScaleFactor: 1, mobile: false },
      source: 'override',
      applied: true,
      resizeEvent: { delivered: 'probably' },
    })
    expect(violations).toHaveLength(1)
  })

  it('renders the honest failure through the tool own render function', async () => {
    const tools = await registeredTools()
    const viewport = tools.get('cdp_viewport')
    const output = viewport?.output as unknown as {
      render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
    }
    const text = output.render({}, {
      ok: false,
      reason: NOT_DELIVERED,
      resizeEvent: { delivered: 'not-delivered', events: 0 },
    }).map(part => part.text).join('\n')
    expect(text).toContain(NOT_DELIVERED)
  })
})
