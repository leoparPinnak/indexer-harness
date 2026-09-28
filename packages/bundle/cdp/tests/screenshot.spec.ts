/**
 * Plan 06 screenshot tests: `ScreenshotCapture` over a fake CDP context
 * (file-based assertions — header parse + byte counts), clip/fullPage/selector
 * behaviour, the inline budget, argument normalization, the pure legend math,
 * and the `cdp_screenshot` tool envelope through a real tool registration.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  CdpScreenshotError,
  CdpScreenshotSelectorError,
  CdpScreenshotTooLargeError,
  MAX_SCREENSHOT_RECTS,
  ScreenshotCapture,
  buildLegend,
  normalizeScreenshotRequest,
  readImageSize,
  type CaptureContext,
  type ViewportObservation,
} from '../src/capture.ts'
import { registerCdpTools } from '../src/tools.ts'
import type { CdpService } from '../src/service.ts'
import { cleanupTempDirs, makeJpeg, makePng, makeTempDir } from './plan06-fixtures.ts'

type Handler = (params?: Record<string, unknown>) => unknown

interface CaptureFixture {
  readonly ctx: CaptureContext
  readonly sent: Array<{ method: string, params?: Record<string, unknown>, sessionId?: string | undefined }>
  observed: ViewportObservation | undefined
}

interface FixtureOptions {
  readonly handlers?: Record<string, Handler>
  readonly selectorReply?: unknown
  readonly snapshotNodes?: Array<{ ref: string, role: string, name: string, box?: { x: number, y: number, width: number, height: number } }>
}

const DEFAULT_LAYOUT: Handler = () => ({
  cssVisualViewport: { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
  contentSize: { width: 492, height: 4000 },
})

/** A `CaptureContext` that records every CDP call and routes evaluate replies by expression. */
function makeFixture(options: FixtureOptions = {}): CaptureFixture {
  const sent: CaptureFixture['sent'] = []
  const fixture: CaptureFixture = {
    sent,
    observed: undefined,
    ctx: {
      send: async (method, params, sessionId) => {
        sent.push({ method, ...(params !== undefined ? { params } : {}), sessionId })
        if (method === 'Runtime.evaluate') {
          const expression = String(params?.expression ?? '')
          if (expression.includes('getBoundingClientRect')) {
            return { result: { value: options.selectorReply ?? { found: false } } }
          }
          return { result: { value: { sx: 0, sy: 0 } } }
        }
        const handler = options.handlers?.[method] ?? (method === 'Page.getLayoutMetrics' ? DEFAULT_LAYOUT : undefined)
        if (handler !== undefined) return handler(params)
        return {}
      },
      getPageSession: async () => ({ sessionId: 'sess-1' }),
      isViewportOverrideActive: () => false,
      onViewportObserved: (observation) => { fixture.observed = observation },
      snapshot: async () => ({
        title: 'Stub',
        url: 'https://example.com',
        viewport: { width: 492, height: 780 },
        nodes: (options.snapshotNodes ?? []).map(node => ({
          ref: node.ref,
          role: node.role,
          name: node.name,
          interactive: false,
          visible: true,
          ...(node.box !== undefined ? { box: node.box } : {}),
        })),
        counts: { totalNodes: 0, returnedNodes: 0, interactiveNodes: 0, visibleNodes: 0 },
        truncated: false,
        nodeLimitTruncated: false,
        textLimitTruncated: false,
        sizeLimitTruncated: false,
      } as never),
    },
  }
  return fixture
}

function capCall(fixture: CaptureFixture): { method: string, params?: Record<string, unknown> } | undefined {
  return fixture.sent.find(entry => entry.method === 'Page.captureScreenshot')
}

async function capture(
  fixture: CaptureFixture,
  raw: Record<string, unknown>,
): ReturnType<ScreenshotCapture['capture']> {
  const request = normalizeScreenshotRequest(raw)
  return await new ScreenshotCapture(fixture.ctx).capture(request)
}

afterEach(async () => {
  await cleanupTempDirs()
})

describe('plan06: ScreenshotCapture', () => {
  it('captures a viewport png to disk and reports header-parsed dimensions', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'shot.png')
    const fixture = makeFixture({ handlers: { 'Page.captureScreenshot': () => ({ data: makePng(4, 2).toString('base64') }) } })

    const result = await capture(fixture, { saveTo })

    expect(result.ok).toBe(true)
    expect(result.path).toBe(saveTo)
    const bytes = await readFile(saveTo)
    expect(bytes.length).toBe(result.byteSize)
    expect(readImageSize(bytes, 'png')).toEqual({ width: 4, height: 2 })
    expect(result.width).toBe(4)
    expect(result.height).toBe(2)
    expect(result.viewport).toEqual({ width: 492, height: 780 })
    expect(result.deviceScaleFactor).toBe(2)
    expect(result.cssWidth).toBe(492)
    expect(result.cssHeight).toBe(780)
    expect(fixture.observed?.source).toBe('live-window')

    const call = capCall(fixture)
    expect(call).toBeDefined()
    expect(call?.params?.format).toBe('png')
    expect(call?.params?.fromSurface).toBe(true)
    expect(call?.params?.clip).toBeUndefined()
    expect(fixture.sent.find(entry => entry.method === 'Page.captureScreenshot')?.sessionId).toBe('sess-1')
  })

  it('fullPage sends captureBeyondViewport with the measured contentSize clip', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'full.png')
    const fixture = makeFixture({
      handlers: {
        'Page.getLayoutMetrics': () => ({
          cssVisualViewport: { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
          contentSize: { width: 1920, height: 2000 },
        }),
        'Page.captureScreenshot': () => ({ data: makePng(8, 4).toString('base64') }),
      },
    })

    const result = await capture(fixture, { saveTo, fullPage: true })
    expect(result.fullPage).toBe(true)
    expect(result.cssWidth).toBe(1920)
    expect(result.cssHeight).toBe(2000)

    const call = capCall(fixture)
    expect(call?.params?.captureBeyondViewport).toBe(true)
    expect(call?.params?.clip).toEqual({ x: 0, y: 0, width: 1920, height: 2000, scale: 1 })
  })

  it('rejects an oversized fullPage before Page.captureScreenshot is ever sent', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'huge.png')
    const fixture = makeFixture({
      handlers: {
        'Page.getLayoutMetrics': () => ({
          cssVisualViewport: { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
          contentSize: { width: 4000, height: 9000 },
        }),
      },
    })

    await expect(capture(fixture, { saveTo, fullPage: true })).rejects.toBeInstanceOf(CdpScreenshotTooLargeError)
    expect(capCall(fixture)).toBeUndefined()
  })

  it('captures jpeg with the requested quality and parses the SOF dimensions', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'shot.jpg')
    const fixture = makeFixture({
      handlers: { 'Page.captureScreenshot': () => ({ data: makeJpeg(1600, 900).toString('base64') }) },
    })

    const result = await capture(fixture, { saveTo, format: 'jpeg', quality: 35 })
    expect(result.path).toBe(saveTo)
    expect(result.format).toBe('jpeg')
    expect(result.width).toBe(1600)
    expect(result.height).toBe(900)

    const call = capCall(fixture)
    expect(call?.params?.format).toBe('jpeg')
    expect(call?.params?.quality).toBe(35)
    const bytes = await readFile(saveTo)
    expect(readImageSize(bytes, 'jpeg')).toEqual({ width: 1600, height: 900 })
  })

  it('honours the inline budget: default fits, inlineMaxBytes:0 omits', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const png = makePng(4, 2)
    const fixture = makeFixture({
      handlers: { 'Page.captureScreenshot': () => ({ data: png.toString('base64') }) },
    })

    const withInline = await capture(fixture, { saveTo: join(dir, 'a.png'), inline: true })
    expect(withInline.inline).toBe(png.toString('base64'))
    expect(withInline.inlineOmitted).toBe(false)

    const omitted = await capture(fixture, { saveTo: join(dir, 'b.png'), inline: true, inlineMaxBytes: 0 })
    expect(omitted.inline).toBeUndefined()
    expect(omitted.inlineOmitted).toBe(true)
    expect(omitted.path).toBe(join(dir, 'b.png'))
  })

  it('captures a resolved selector clip in document coordinates', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'sel.png')
    const fixture = makeFixture({
      handlers: { 'Page.captureScreenshot': () => ({ data: makePng(4, 2).toString('base64') }) },
      selectorReply: { found: true, x: 10, y: 20, width: 100, height: 50 },
    })

    const result = await capture(fixture, { saveTo, selector: '#go' })
    expect(result.selector).toBe('#go')
    const call = capCall(fixture)
    expect(call?.params?.clip).toEqual({ x: 10, y: 20, width: 100, height: 50, scale: 1 })
    expect(call?.params?.captureBeyondViewport).toBe(true)
    expect(result.cssWidth).toBe(100)
    expect(result.cssHeight).toBe(50)
  })

  it('rejects a selector with no match before any capture call', async () => {
    const fixture = makeFixture({ selectorReply: { found: false } })
    await expect(capture(fixture, { saveTo: 'never.png', selector: '.missing' }))
      .rejects.toBeInstanceOf(CdpScreenshotSelectorError)
    expect(capCall(fixture)).toBeUndefined()
  })

  it('builds a rect legend from snapshot boxes and keeps evaluate read-only', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'rects.png')
    const fixture = makeFixture({
      handlers: { 'Page.captureScreenshot': () => ({ data: makePng(4, 2).toString('base64') }) },
      snapshotNodes: [
        { ref: 'btn|page|1', role: 'button', name: 'OK', box: { x: 100, y: 200, width: 50, height: 60 } },
        { ref: 'div|page|2', role: 'generic', name: 'Plain' },
      ],
    })

    const result = await capture(fixture, { saveTo, rects: true })
    expect(result.rects).toHaveLength(1)
    expect(result.rectsTruncated).toBe(false)
    expect(result.coordinateSpace).toBe('viewport')

    const evaluateCalls = fixture.sent.filter(entry => entry.method === 'Runtime.evaluate')
    expect(evaluateCalls.length).toBeGreaterThan(0)
    for (const call of evaluateCalls) {
      const expression = String(call.params?.expression ?? '')
      expect(expression).not.toMatch(/innerHTML|appendChild|insertBefore|document\.write|setAttribute|\.value\s*=/)
    }
  })

  it('annotate rewrites the saved png in place and keeps it parseable', async () => {
    const dir = await makeTempDir('dsh-plan06-')
    const saveTo = join(dir, 'ann.png')
    const original = makePng(6, 6)
    const fixture = makeFixture({
      handlers: { 'Page.captureScreenshot': () => ({ data: original.toString('base64') }) },
      snapshotNodes: [
        { ref: 'btn|page|1', role: 'button', name: 'OK', box: { x: 1, y: 1, width: 3, height: 3 } },
      ],
    })

    const result = await capture(fixture, { saveTo, rects: true, annotate: true })
    expect(result.path).toBe(saveTo)
    const rewritten = await readFile(saveTo)
    expect(rewritten.equals(original)).toBe(false)
    expect(readImageSize(rewritten, 'png')).toEqual({ width: 6, height: 6 })
  })
})

describe('plan06: normalizeScreenshotRequest validation', () => {
  it('rejects a negative clip before any CDP call', () => {
    expect(() => normalizeScreenshotRequest({ clip: { x: -5, y: 0, width: 100, height: 100 } }))
      .toThrowError(CdpScreenshotError)
    try {
      normalizeScreenshotRequest({ clip: { x: -5, y: 0, width: 100, height: 100 } })
      expect.unreachable('the clip must have been rejected')
    } catch (err) {
      expect((err as Error).name).toBe('CdpScreenshotError')
    }
  })

  it('rejects annotate with jpeg and unknown formats', () => {
    expect(() => normalizeScreenshotRequest({ format: 'jpeg', annotate: true }))
      .toThrowError(/annotate requires png/)
    expect(() => normalizeScreenshotRequest({ format: 'gif' }))
      .toThrowError(/format must be/)
    expect(() => normalizeScreenshotRequest({ clip: { x: 0, y: 0, width: 0, height: 10 } }))
      .toThrowError(/positive width/)
  })

  it('applies the documented defaults', () => {
    const request = normalizeScreenshotRequest({})
    expect(request.format).toBe('png')
    expect(request.quality).toBe(80)
    expect(request.inline).toBe(false)
    expect(request.fullPage).toBe(false)
    expect(request.rects).toBe(false)
    expect(request.annotate).toBe(false)
  })
})

describe('plan06: buildLegend math (plan §8.2)', () => {
  it('maps CSS rects onto image pixels by the image/css ratio (dpr absorbed)', () => {
    const outcome = buildLegend(
      [{ ref: 'b', x: 100, y: 200, width: 50, height: 60 }],
      { x: 0, y: 0, width: 492, height: 780 },
      984,
      1560,
    )
    expect(outcome.truncated).toBe(false)
    expect(outcome.rects[0]).toEqual({ ref: 'b', x: 200, y: 400, width: 100, height: 120 })
  })

  it('shifts by the clip origin and truncates past 200 entries', () => {
    const offset = buildLegend(
      [{ ref: 'a', x: 110, y: 210, width: 50, height: 60 }],
      { x: 10, y: 10, width: 492, height: 780 },
      492,
      780,
    )
    expect(offset.rects[0]).toMatchObject({ x: 100, y: 200, width: 50, height: 60 })

    const many = Array.from({ length: MAX_SCREENSHOT_RECTS + 5 }, (_, index) => ({
      ref: `n${String(index)}`,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }))
    const capped = buildLegend(many, { x: 0, y: 0, width: 100, height: 100 }, 100, 100)
    expect(capped.rects).toHaveLength(MAX_SCREENSHOT_RECTS)
    expect(capped.truncated).toBe(true)
  })
})

describe('plan06: cdp_screenshot tool registration', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  function bootTools(service: unknown): Map<string, ToolDefinition> {
    const ctx = new Context()
    contexts.push(ctx)
    const tools = new Map<string, ToolDefinition>()
    ctx.provide('tools', {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
      guard: () => () => {},
    } as never)
    registerCdpTools(ctx, service as CdpService)
    return tools
  }

  it('registers cdp_screenshot and cdp_viewport alongside the original tools', async () => {
    const tools = bootTools({})
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect([...tools.keys()]).toContain('cdp_screenshot')
    expect([...tools.keys()]).toContain('cdp_viewport')
    for (const legacy of ['cdp_status', 'cdp_open', 'cdp_tabs', 'cdp_navigate', 'cdp_snapshot', 'cdp_eval', 'cdp_click', 'cdp_type', 'cdp_wait', 'net_capture', 'net_export']) {
      expect([...tools.keys()]).toContain(legacy)
    }
  })

  it('returns the error envelope for an invalid clip without calling the service', async () => {
    let called = false
    const tools = bootTools({
      screenshot: () => {
        called = true
        return Promise.resolve({ ok: true })
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_screenshot')
    expect(definition).toBeDefined()

    const outcome = await definition!.execute!(
      { clip: { x: -5, y: 0, width: 100, height: 100 } },
      {} as never,
    ) as { ok: boolean, error?: { name: string, message: string } }
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.name).toBe('CdpScreenshotError')
    expect(called).toBe(false)
  })

  it('passes a normalized request through to the service on success', async () => {
    let received: unknown
    const tools = bootTools({
      screenshot: (request: unknown) => {
        received = request
        return Promise.resolve({ ok: true, path: 'x.png', format: 'png', durationMs: 1 })
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const outcome = await tools.get('cdp_screenshot')!.execute!({ format: 'png', fullPage: true }, {} as never) as { ok: boolean }
    expect(outcome.ok).toBe(true)
    expect(received).toMatchObject({ fullPage: true, format: 'png', inline: false })
  })
})
