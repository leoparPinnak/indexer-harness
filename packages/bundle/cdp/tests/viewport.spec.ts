/**
 * Plan 06 viewport tests: `probeViewport`'s fallback chain, the live viewport
 * `service.snapshot()` reports (the old hardcoded constant is gone), the
 * `status().viewport` cache, and `applyViewport` (cdp_viewport) behaviour —
 * report-only, set+verify, reset, and argument rejection.
 */

import { describe, expect, it } from 'vitest'
import { CdpService } from '../src/service.ts'
import {
  CdpViewportError,
  UNAVAILABLE_VIEWPORT,
  probeViewport,
  type CdpMethodSender,
  type ViewportApplyOutcome,
  type ViewportApplySuccess,
} from '../src/capture.ts'

/**
 * plan15-viewport: `applyViewport` now answers a discriminated union (the
 * honest not-delivered failure joined the success shape), so a test that
 * expects a success narrows through here instead of a bare `ok` assertion.
 */
function success(outcome: ViewportApplyOutcome): ViewportApplySuccess {
  if (outcome.ok !== true) throw new Error(`expected an applied outcome, got: ${JSON.stringify(outcome)}`)
  return outcome
}

type Handler = (params?: Record<string, unknown>) => unknown

interface FakeSender {
  readonly sender: CdpMethodSender
  readonly sent: Array<{ method: string, params?: Record<string, unknown>, sessionId?: string | undefined }>
}

/** A sender whose handlers can throw to force each probe step to fail. */
function fakeSender(handlers: Record<string, Handler>): FakeSender {
  const sent: FakeSender['sent'] = []
  const sender: CdpMethodSender = {
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
  }
  return { sender, sent }
}

/**
 * A CdpService whose connection/session seams point at a fake sender so the
 * real snapshot/viewport code paths run without a browser.
 */
function wireService(handlers: Record<string, Handler>): { service: CdpService, sent: FakeSender['sent'] } {
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

const LAYOUT_OK: Handler = () => ({
  cssVisualViewport: { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
  contentSize: { width: 492, height: 4000 },
})

describe('plan06: live viewport probing', () => {
  it('reads Page.getLayoutMetrics without falling back to Runtime.evaluate', async () => {
    const { sender, sent } = fakeSender({ 'Page.getLayoutMetrics': LAYOUT_OK })
    const observation = await probeViewport(sender, 'sess-1')
    expect(observation).toEqual({
      width: 492,
      height: 780,
      deviceScaleFactor: 2,
      mobile: false,
      source: 'live-window',
    })
    expect(sent.map(entry => entry.method)).toEqual(['Page.getLayoutMetrics'])
    expect(sent[0]?.sessionId).toBe('sess-1')
  })

  it('falls back to Runtime.evaluate when the layout metrics reply is empty', async () => {
    const { sender, sent } = fakeSender({
      'Page.getLayoutMetrics': () => ({}),
      'Runtime.evaluate': () => ({
        result: { value: { w: 492, h: 780, dpr: 2, coarse: false } },
      }),
    })
    const observation = await probeViewport(sender, 'sess-1')
    expect(observation.width).toBe(492)
    expect(observation.height).toBe(780)
    expect(observation.deviceScaleFactor).toBe(2)
    expect(observation.source).toBe('live-window')
    expect(sent.map(entry => entry.method)).toEqual(['Page.getLayoutMetrics', 'Runtime.evaluate'])
  })

  it('reports source unavailable and never the old default when every step fails', async () => {
    const { sender } = fakeSender({
      'Page.getLayoutMetrics': () => { throw new Error('no metrics') },
      'Runtime.evaluate': () => { throw new Error('no evaluate') },
    })
    const observation = await probeViewport(sender, 'sess-1')
    expect(observation.source).toBe('unavailable')
    expect(observation.width).toBe(0)
    expect(observation.height).toBe(0)
    expect(observation).toEqual(UNAVAILABLE_VIEWPORT)
    expect(observation.width).not.toBe(1280)
    expect(observation.height).not.toBe(800)
  })

  it('marks an observation as override when this process holds the device metrics override', async () => {
    const { sender } = fakeSender({ 'Page.getLayoutMetrics': LAYOUT_OK })
    const observation = await probeViewport(sender, 'sess-1', { overrideActive: true })
    expect(observation.source).toBe('override')
  })

  it('service.snapshot() reports the probed viewport and refreshes status().viewport', async () => {
    const { service, sent } = wireService({
      'Page.getLayoutMetrics': LAYOUT_OK,
      'DOM.getDocument': () => ({}),
    })
    expect(service.status().viewport).toBeUndefined()

    const snapshot = await service.snapshot()
    expect(snapshot.viewport).toEqual({ width: 492, height: 780 })
    expect(service.status().viewport).toEqual({
      width: 492,
      height: 780,
      deviceScaleFactor: 2,
      source: 'live-window',
    })
    expect(sent.some(entry => entry.method === 'Page.getLayoutMetrics')).toBe(true)
  })

  it('refreshViewport() probes when no browser is reachable without throwing', async () => {
    const service = new CdpService()
    const refreshed = await service.refreshViewport()
    expect(refreshed).toBeUndefined()
    expect(service.status().viewport).toBeUndefined()
  })
})

describe('plan06: applyViewport (cdp_viewport)', () => {
  it('reports only when called without parameters: no Emulation message is sent', async () => {
    const { service, sent } = wireService({ 'Page.getLayoutMetrics': LAYOUT_OK })
    const outcome = success(await service.applyViewport({}))
    expect(outcome.ok).toBe(true)
    expect(outcome.applied).toBe(false)
    expect(outcome.viewport).toEqual({ width: 492, height: 780, deviceScaleFactor: 2, mobile: false })
    expect(sent.some(entry => entry.method.startsWith('Emulation.'))).toBe(false)
  })

  it('sets the device metrics override and verifies it with a live probe', async () => {
    let overridden = false
    const { service, sent } = wireService({
      'Page.getLayoutMetrics': () => ({
        cssVisualViewport: overridden
          ? { cssWidth: 1280, cssHeight: 1024, deviceScaleFactor: 1 }
          : { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
      }),
      'Emulation.setDeviceMetricsOverride': () => {
        overridden = true
        return {}
      },
    })

    const outcome = success(await service.applyViewport({ width: 1280, height: 1024, deviceScaleFactor: 1 }))
    expect(outcome.applied).toBe(true)
    expect(outcome.source).toBe('override')
    expect(outcome.viewport).toEqual({ width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false })

    const setCall = sent.find(entry => entry.method === 'Emulation.setDeviceMetricsOverride')
    expect(setCall).toBeDefined()
    expect(setCall?.sessionId).toBe('sess-1')
    expect(setCall?.params).toEqual({ width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false })
  })

  it('reset clears the override and reports the live window again', async () => {
    let overridden = true
    const { service, sent } = wireService({
      'Page.getLayoutMetrics': () => ({
        cssVisualViewport: overridden
          ? { cssWidth: 1280, cssHeight: 1024, deviceScaleFactor: 1 }
          : { cssWidth: 492, cssHeight: 780, deviceScaleFactor: 2 },
      }),
      'Emulation.clearDeviceMetricsOverride': () => {
        overridden = false
        return {}
      },
    })

    const outcome = success(await service.applyViewport({ reset: true }))
    expect(outcome.applied).toBe(true)
    expect(outcome.source).toBe('live-window')
    expect(outcome.viewport.width).toBe(492)
    expect(sent.some(entry => entry.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    expect(sent.some(entry => entry.method === 'Emulation.setDeviceMetricsOverride')).toBe(false)
  })

  it('rejects out-of-range or partial dimensions with CdpViewportError before any CDP call', async () => {
    const { service, sent } = wireService({ 'Page.getLayoutMetrics': LAYOUT_OK })
    await expect(service.applyViewport({ width: 50_000, height: 1024 })).rejects.toBeInstanceOf(CdpViewportError)
    await expect(service.applyViewport({ width: 100 })).rejects.toBeInstanceOf(CdpViewportError)
    await expect(service.applyViewport({ width: 100.5, height: 100 })).rejects.toBeInstanceOf(CdpViewportError)
    expect(sent.some(entry => entry.method.startsWith('Emulation.'))).toBe(false)
  })
})
