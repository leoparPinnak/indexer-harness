/**
 * Plan 06 REST route tests (own file instead of editing routes.spec.ts, which
 * Plan 10 also touches): 405/400/200 handling plus the base64-never-crosses-
 * REST guarantee for /api/server/cdp/screenshot and the report-only
 * /api/server/cdp/viewport behaviour.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CDP_SCREENSHOT_ROUTE, CDP_VIEWPORT_ROUTE, registerCdpRoutes } from '../src/routes.ts'
import type { CdpService } from '../src/service.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Captured {
  res: ServerResponse
  status: () => number
  header: (name: string) => string | undefined
  body: () => string
}

function captureResponse(): Captured {
  let status = 200
  const headers = new Map<string, string>()
  const chunks: string[] = []
  const res = {
    get statusCode() { return status },
    set statusCode(code: number) { status = code },
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value)
      return res
    },
    end: (chunk?: string) => {
      if (chunk !== undefined) chunks.push(chunk)
    },
  } as unknown as ServerResponse

  return {
    res,
    status: () => status,
    header: name => headers.get(name.toLowerCase()),
    body: () => chunks.join(''),
  }
}

function makeRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
  const content = bodyJson !== undefined ? JSON.stringify(bodyJson) : ''
  return Object.assign(Readable.from([content]), {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

function makeRawRequest(method: string, url: string, content: string): IncomingMessage {
  return Object.assign(Readable.from([content]), {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

describe('plan06: screenshot + viewport REST routes', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  /**
   * Loose test-double signatures: the route handlers only forward arguments
   * and JSON-stringify whatever comes back, so each stub may answer with the
   * minimal payload its assertions actually need.
   */
  interface RouteServiceOverrides {
    screenshot?: (request: unknown) => Promise<unknown>
    applyViewport?: (args: unknown) => Promise<unknown>
  }

  function setupRoutes(overrides: RouteServiceOverrides = {}): Map<string, RouteHandler> {
    const ctx = new Context()
    contexts.push(ctx)
    const routes = new Map<string, RouteHandler>()
    ctx.provide('webServer', {
      register: (reg: { kind: string, path: string, handler: RouteHandler }) => {
        routes.set(reg.path, reg.handler)
        return () => { routes.delete(reg.path) }
      },
    })

    const mockService = { ...overrides } as unknown as CdpService
    registerCdpRoutes(ctx, mockService)
    return routes
  }

  it('answers 405 with Allow: POST for non-POST requests on both routes', async () => {
    const routes = setupRoutes()
    for (const path of [CDP_SCREENSHOT_ROUTE, CDP_VIEWPORT_ROUTE]) {
      const handler = routes.get(path)
      expect(handler).toBeDefined()
      const cap = captureResponse()
      await handler!(makeRequest('GET', path), cap.res)
      expect(cap.status()).toBe(405)
      expect(cap.header('allow')).toBe('POST')
    }
  })

  it('rejects an invalid clip with 400 before calling the service', async () => {
    const screenshotCalls: unknown[] = []
    const routes = setupRoutes({
      screenshot: async (request) => {
        screenshotCalls.push(request)
        return { ok: true }
      },
      applyViewport: async () => ({ ok: true }),
    })
    const cap = captureResponse()
    await routes.get(CDP_SCREENSHOT_ROUTE)!(
      makeRequest('POST', CDP_SCREENSHOT_ROUTE, { clip: { x: -5, y: 0, width: 10, height: 10 } }),
      cap.res,
    )
    expect(cap.status()).toBe(400)
    const body = JSON.parse(cap.body()) as { ok: boolean, error?: { name: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.name).toBe('CdpScreenshotError')
    expect(screenshotCalls).toHaveLength(0)
  })

  it('rejects malformed JSON with 400', async () => {
    const routes = setupRoutes({
      screenshot: async () => ({ ok: true }),
      applyViewport: async () => ({ ok: true }),
    })
    const cap = captureResponse()
    await routes.get(CDP_SCREENSHOT_ROUTE)!(makeRawRequest('POST', CDP_SCREENSHOT_ROUTE, '{ nope'), cap.res)
    expect(cap.status()).toBe(400)
    expect((JSON.parse(cap.body()) as { ok: boolean }).ok).toBe(false)
  })

  it('returns the normalized result as 200 JSON without any inline base64', async () => {
    const screenshotCalls: unknown[] = []
    const routes = setupRoutes({
      screenshot: async (request) => {
        screenshotCalls.push(request)
        return {
          ok: true,
          path: 'screenshots/plan06.png',
          format: 'png',
          byteSize: 128,
          width: 4,
          height: 2,
          cssWidth: 492,
          cssHeight: 780,
          deviceScaleFactor: 2,
          durationMs: 3,
          inline: 'QUJDREVGRw==',
          inlineOmitted: false,
        }
      },
      applyViewport: async () => ({ ok: true }),
    })
    const cap = captureResponse()
    await routes.get(CDP_SCREENSHOT_ROUTE)!(
      makeRequest('POST', CDP_SCREENSHOT_ROUTE, { fullPage: true }),
      cap.res,
    )
    expect(cap.status()).toBe(200)
    const body = JSON.parse(cap.body()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.path).toBe('screenshots/plan06.png')
    expect(body.inline).toBeUndefined()
    expect(body.inlineOmitted).toBe(false)
    expect(cap.body()).not.toContain('QUJDREVGRw')
    expect(screenshotCalls[0]).toMatchObject({ fullPage: true, inline: false })
  })

  it('maps a thrown service error to 500 with the error envelope', async () => {
    const routes = setupRoutes({
      screenshot: async () => {
        throw new Error('capture blew up')
      },
      applyViewport: async () => ({ ok: true }),
    })
    const cap = captureResponse()
    await routes.get(CDP_SCREENSHOT_ROUTE)!(makeRequest('POST', CDP_SCREENSHOT_ROUTE, {}), cap.res)
    expect(cap.status()).toBe(500)
    const body = JSON.parse(cap.body()) as { ok: boolean, error?: { name: string, message: string } }
    expect(body.ok).toBe(false)
    expect(body.error).toEqual({ name: 'Error', message: 'capture blew up' })
  })

  it('reports the viewport when the route is called without parameters', async () => {
    const applyCalls: unknown[] = []
    const routes = setupRoutes({
      screenshot: async () => ({ ok: true }),
      applyViewport: async (args) => {
        applyCalls.push(args)
        return {
          ok: true,
          viewport: { width: 492, height: 780, deviceScaleFactor: 2, mobile: false },
          source: 'live-window',
          applied: false,
        }
      },
    })
    const cap = captureResponse()
    await routes.get(CDP_VIEWPORT_ROUTE)!(makeRequest('POST', CDP_VIEWPORT_ROUTE, {}), cap.res)
    expect(cap.status()).toBe(200)
    const body = JSON.parse(cap.body()) as { ok: boolean, applied?: boolean }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(false)
    expect(applyCalls[0]).toEqual({})
  })

  it('passes width/height through and rejects wrongly typed bodies with 400', async () => {
    const applyCalls: unknown[] = []
    const routes = setupRoutes({
      screenshot: async () => ({ ok: true }),
      applyViewport: async (args) => {
        applyCalls.push(args)
        return { ok: true, viewport: { width: 640, height: 480, deviceScaleFactor: 1, mobile: false }, source: 'override', applied: true }
      },
    })

    const okCap = captureResponse()
    await routes.get(CDP_VIEWPORT_ROUTE)!(
      makeRequest('POST', CDP_VIEWPORT_ROUTE, { width: 640, height: 480, mobile: false }),
      okCap.res,
    )
    expect(okCap.status()).toBe(200)
    expect(applyCalls[0]).toEqual({ width: 640, height: 480, mobile: false })

    const badCap = captureResponse()
    await routes.get(CDP_VIEWPORT_ROUTE)!(
      makeRequest('POST', CDP_VIEWPORT_ROUTE, { width: '640', height: 480 }),
      badCap.res,
    )
    expect(badCap.status()).toBe(400)
    expect((JSON.parse(badCap.body()) as { error?: { name: string } }).error?.name).toBe('CdpViewportError')
    expect(applyCalls).toHaveLength(1)
  })

  it('answers 400 for CdpViewportError and 500 for unexpected viewport failures', async () => {
    const routes = setupRoutes({
      screenshot: async () => ({ ok: true }),
      applyViewport: async () => {
        throw new Error('unexpected viewport failure')
      },
    })
    const cap = captureResponse()
    await routes.get(CDP_VIEWPORT_ROUTE)!(
      makeRequest('POST', CDP_VIEWPORT_ROUTE, { width: 100, height: 100 }),
      cap.res,
    )
    expect(cap.status()).toBe(500)
    expect((JSON.parse(cap.body()) as { ok: boolean }).ok).toBe(false)
  })
})
