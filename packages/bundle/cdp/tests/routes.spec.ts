/**
 * Unit tests for CDP REST routes registered on webServer:
 * method routing (405 with Allow header), malformed body rejection (400),
 * and successful handler responses with mock service.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CDP_CLOSE_ROUTE,
  CDP_EVAL_ROUTE,
  CDP_EXEC_ROUTE,
  CDP_NAVIGATE_ROUTE,
  CDP_OPEN_ROUTE,
  CDP_SNAPSHOT_ROUTE,
  CDP_STATUS_ROUTE,
  CDP_TABS_ROUTE,
  registerCdpRoutes,
} from '../src/routes.ts'
import { buildEvalFailureOutcome, buildEvalOutcome } from '../src/exec.ts'
import type { ExecOptions } from '../src/exec.ts'
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
  const req = Object.assign(Readable.from([content]), {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
  return req
}

describe('CDP REST Routes', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  function setupRoutes(serviceOverrides?: Partial<CdpService>) {
    const ctx = new Context()
    contexts.push(ctx)
    const routes = new Map<string, RouteHandler>()
    ctx.provide('webServer', {
      register: (reg: { kind: string; path: string; handler: RouteHandler }) => {
        routes.set(reg.path, reg.handler)
        return () => { routes.delete(reg.path) }
      },
    })

    const mockService = {
      status: () => ({ ok: true as const, version: '0.1.5', targets: 2, proxy: { active: false } }),
      // plan01: the status handler awaits statusLive(); the sync status() stays
      // mocked too so both layers can be asserted independently.
      statusLive: () => Promise.resolve({
        ok: true as const,
        version: '0.1.5',
        targets: 2,
        proxy: { active: false },
        connectionState: 'connected' as const,
        openTabs: [],
        endpoint: 'ws://127.0.0.1:9222',
        activeTargetId: 't1',
      }),
      targets: [
        { targetId: 't1', type: 'page', title: 'Example', url: 'https://example.com' },
      ],
      open: () => Promise.resolve({ endpoint: 'ws://127.0.0.1:9222', targets: 1 }),
      navigate: () => Promise.resolve({ frameId: 'f1', loaderId: 'l1' }),
      snapshot: () => Promise.resolve({
        title: 'Snap',
        url: 'https://example.com',
        viewport: { width: 1280, height: 800 },
        counts: { candidates: 1, kept: 1, totalNodes: 1, unmeasured: 0 },
        flags: { truncated: false, nodeLimitTruncated: false, textLimitTruncated: false, sizeLimitTruncated: false },
        nodes: [{ ref: 'root|page|0', role: 'document', name: 'Snap', boundsHit: [] }],
      }),
      evaluate: () => Promise.resolve({ value: '42', truncated: false, exception: undefined }),
      // plan01: the eval handler envelopes through evalWithMeta + buildEvalOutcome.
      evalWithMeta: () => Promise.resolve({
        targetId: 't1',
        url: 'https://example.com',
        evaluation: { value: '42', truncated: false, exception: undefined, hasValue: true, valueType: 'number' },
      }),
      buildEvalOutcome: (
        evaluation: Parameters<typeof buildEvalOutcome>[0],
        targetId?: string,
        url?: string,
      ) => buildEvalOutcome(evaluation, targetId, url),
      buildEvalFailure: (
        error: Parameters<typeof buildEvalFailureOutcome>[0],
        expression: string,
        targetId?: string,
      ) => buildEvalFailureOutcome(error, expression, targetId),
      // plan01: the exec route answers with service.exec's envelope verbatim.
      exec: (options: Record<string, unknown>) => Promise.resolve({
        ok: true,
        didAct: true,
        result: '1',
        truncated: false,
        valueType: 'number',
        targetId: 't1',
        url: 'https://example.com',
        durationMs: 1,
        expression: options.expression,
      }),
      closeTarget: () => Promise.resolve(),
      ...serviceOverrides,
    } as unknown as CdpService

    registerCdpRoutes(ctx, mockService)
    return { routes, mockService }
  }

  it('serves GET /api/server/cdp/status with compatible payload and 405 on POST', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_STATUS_ROUTE)
    expect(handler).toBeDefined()

    // 405 Method Not Allowed
    const cap405 = captureResponse()
    await handler!(makeRequest('POST', CDP_STATUS_ROUTE), cap405.res)
    expect(cap405.status()).toBe(405)
    expect(cap405.header('allow')).toBe('GET')

    // 200 OK
    const cap200 = captureResponse()
    await handler!(makeRequest('GET', CDP_STATUS_ROUTE), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; version: string; targets: number }
    expect(json.ok).toBe(true)
    expect(json.version).toBe('0.1.5')
    expect(json.targets).toBe(2)
  })

  it('serves POST /api/server/cdp/open and rejects GET with 405', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_OPEN_ROUTE)
    expect(handler).toBeDefined()

    const cap405 = captureResponse()
    await handler!(makeRequest('GET', CDP_OPEN_ROUTE), cap405.res)
    expect(cap405.status()).toBe(405)
    expect(cap405.header('allow')).toBe('POST')

    const cap200 = captureResponse()
    await handler!(makeRequest('POST', CDP_OPEN_ROUTE, { port: 9222 }), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; endpoint: string; targets: number }
    expect(json.ok).toBe(true)
    expect(json.endpoint).toBe('ws://127.0.0.1:9222')
  })

  it('serves POST /api/server/cdp/navigate and validates url', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_NAVIGATE_ROUTE)
    expect(handler).toBeDefined()

    // Missing url -> 400
    const cap400 = captureResponse()
    await handler!(makeRequest('POST', CDP_NAVIGATE_ROUTE, {}), cap400.res)
    expect(cap400.status()).toBe(400)

    // Valid url -> 200
    const cap200 = captureResponse()
    await handler!(makeRequest('POST', CDP_NAVIGATE_ROUTE, { url: 'https://example.com' }), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; url: string; frameId: string }
    expect(json.ok).toBe(true)
    expect(json.url).toBe('https://example.com')
  })

  it('serves GET /api/server/cdp/tabs', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_TABS_ROUTE)
    expect(handler).toBeDefined()

    const cap200 = captureResponse()
    await handler!(makeRequest('GET', CDP_TABS_ROUTE), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; tabs: Array<{ targetId: string }> }
    expect(json.ok).toBe(true)
    expect(json.tabs.length).toBe(1)
    expect(json.tabs[0]?.targetId).toBe('t1')
  })

  it('serves GET /api/server/cdp/snapshot', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_SNAPSHOT_ROUTE)
    expect(handler).toBeDefined()

    const cap200 = captureResponse()
    await handler!(makeRequest('GET', `${CDP_SNAPSHOT_ROUTE}?targetId=t1`), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; snapshot: { title: string } }
    expect(json.ok).toBe(true)
    expect(json.snapshot.title).toBe('Snap')
  })

  it('serves POST /api/server/cdp/eval', async () => {
    const { routes } = setupRoutes()
    const handler = routes.get(CDP_EVAL_ROUTE)
    expect(handler).toBeDefined()

    // Missing expression -> 400
    const cap400 = captureResponse()
    await handler!(makeRequest('POST', CDP_EVAL_ROUTE, {}), cap400.res)
    expect(cap400.status()).toBe(400)

    // Valid expression -> 200
    const cap200 = captureResponse()
    await handler!(makeRequest('POST', CDP_EVAL_ROUTE, { expression: '1 + 1' }), cap200.res)
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; result: string }
    expect(json.ok).toBe(true)
    expect(json.result).toBe('42')
  })

  it('serves POST /api/server/cdp/eval with 200 + ok:false on a page-level failure', async () => {
    const { routes } = setupRoutes({
      evalWithMeta: () => Promise.resolve({
        targetId: 't1',
        url: 'https://example.com',
        evaluation: {
          value: '',
          truncated: false,
          exception: 'TypeError: boom',
          hasValue: false,
          valueType: 'undefined',
          error: { kind: 'exception' as const, name: 'TypeError', message: 'boom' },
        },
      }),
    } as Partial<CdpService>)
    const handler = routes.get(CDP_EVAL_ROUTE)

    const cap = captureResponse()
    await handler!(makeRequest('POST', CDP_EVAL_ROUTE, { expression: 'null.x' }), cap.res)
    expect(cap.status()).toBe(200)
    const json = JSON.parse(cap.body()) as {
      ok: boolean
      result: string
      exception?: string
      error?: { kind?: string; name?: string }
    }
    expect(json.ok).toBe(false)
    expect(json.result).toBe('')
    expect(json.exception).toBe('TypeError: boom')
    expect(json.error?.kind).toBe('exception')
    expect(json.error?.name).toBe('TypeError')
  })

  it('serves POST /api/server/cdp/exec: 400, 405, and the 200 envelope', async () => {
    const seen: Array<Record<string, unknown>> = []
    const { routes } = setupRoutes({
      exec: (options: ExecOptions) => {
        seen.push({ ...options })
        return Promise.resolve({
          ok: false,
          didAct: false,
          result: '',
          truncated: false,
          valueType: 'undefined',
          targetId: 't1',
          url: 'https://example.com',
          durationMs: 2,
          postCondition: { requested: true, passed: false, value: 'false' },
          error: { kind: 'postCondition' as const, message: 'expected truthy, got "false"' },
        })
      },
    } as Partial<CdpService>)
    const handler = routes.get(CDP_EXEC_ROUTE)
    expect(handler).toBeDefined()

    // Missing expression -> 400
    const cap400 = captureResponse()
    await handler!(makeRequest('POST', CDP_EXEC_ROUTE, {}), cap400.res)
    expect(cap400.status()).toBe(400)

    // Wrong method -> 405 with Allow
    const cap405 = captureResponse()
    await handler!(makeRequest('GET', CDP_EXEC_ROUTE), cap405.res)
    expect(cap405.status()).toBe(405)
    expect(cap405.header('allow')).toBe('POST')

    // Valid body -> 200 with the service's envelope verbatim, options forwarded
    const cap200 = captureResponse()
    await handler!(
      makeRequest('POST', CDP_EXEC_ROUTE, {
        expression: '1',
        targetId: 't9',
        awaitPromise: true,
        postCondition: 'false',
        timeoutMs: 2500,
      }),
      cap200.res,
    )
    expect(cap200.status()).toBe(200)
    const json = JSON.parse(cap200.body()) as { ok: boolean; didAct: boolean; error?: { kind?: string } }
    expect(json.ok).toBe(false)
    expect(json.didAct).toBe(false)
    expect(json.error?.kind).toBe('postCondition')
    expect(seen[0]).toMatchObject({
      expression: '1',
      targetId: 't9',
      awaitPromise: true,
      postCondition: 'false',
      timeoutMs: 2500,
    })
  })

  it('serves POST /api/server/cdp/close', async () => {
    let closedId: string | undefined
    const { routes } = setupRoutes({
      closeTarget: (targetId) => {
        closedId = targetId
        return Promise.resolve()
      },
    })
    const handler = routes.get(CDP_CLOSE_ROUTE)
    expect(handler).toBeDefined()

    const cap200 = captureResponse()
    await handler!(makeRequest('POST', CDP_CLOSE_ROUTE, { targetId: 't1' }), cap200.res)
    expect(cap200.status()).toBe(200)
    expect(closedId).toBe('t1')
  })
})
