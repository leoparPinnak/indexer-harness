/**
 * plan04: REST twins for the pool surface — `GET /cdp/endpoints`,
 * `GET /cdp/connections`, `POST /cdp/contexts`, `POST /cdp/disconnect`:
 * registration, 405 method guards with the right Allow header, query/body
 * parsing, 400s for bad actions, and the 200 envelopes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CDP_CONNECTIONS_ROUTE,
  CDP_CONTEXTS_ROUTE,
  CDP_DISCONNECT_ROUTE,
  CDP_ENDPOINTS_ROUTE,
  CDP_STATUS_ROUTE,
  registerCdpRoutes,
} from '../src/routes.ts'
import type { CdpService } from '../src/service.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Captured {
  res: ServerResponse
  status: () => number
  body: () => string
  json: () => any
}

function captureResponse(): Captured {
  let status = 200
  const headers = new Map<string, string>()
  const chunks: string[] = []
  const res = {
    get statusCode() { return status },
    set statusCode(code: number) { status = code },
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), String(value))
      return res
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: (chunk?: string) => {
      if (chunk !== undefined) chunks.push(chunk)
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    body: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')) as any,
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

const headerOf = (cap: Captured, name: string): unknown =>
  (cap.res as unknown as { getHeader: (n: string) => unknown }).getHeader(name)

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function setupRoutes(overrides: Record<string, unknown>): Map<string, RouteHandler> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, RouteHandler>()
  ctx.provide('webServer', {
    register: (registration: { kind: string, path: string, handler: RouteHandler }) => {
      routes.set(registration.path, registration.handler)
      return () => { routes.delete(registration.path) }
    },
  })
  registerCdpRoutes(ctx, overrides as unknown as CdpService)
  return routes
}

const endpointRow = () => ({
  port: 9222,
  reachable: true,
  attached: true,
  active: true,
  state: 'connected',
  endpoint: 'ws://127.0.0.1:9222',
  browser: 'Chrome/test',
  browserId: 'g-1',
  connectionId: 'ep-9222',
  targets: 2,
  error: '',
})

describe('plan04: REST route registration', () => {
  it('registers the four pool routes next to the existing set', () => {
    const routes = setupRoutes({})
    for (const path of [CDP_ENDPOINTS_ROUTE, CDP_CONNECTIONS_ROUTE, CDP_CONTEXTS_ROUTE, CDP_DISCONNECT_ROUTE, CDP_STATUS_ROUTE]) {
      expect(routes.has(path)).toBe(true)
    }
  })

  it('answers 405 with the right Allow header on method mismatches', async () => {
    const routes = setupRoutes({})

    for (const path of [CDP_ENDPOINTS_ROUTE, CDP_CONNECTIONS_ROUTE]) {
      const cap = captureResponse()
      await routes.get(path)!(makeRequest('POST', path, {}), cap.res)
      expect(cap.status()).toBe(405)
      expect(headerOf(cap, 'allow')).toBe('GET')
    }
    for (const path of [CDP_CONTEXTS_ROUTE, CDP_DISCONNECT_ROUTE]) {
      const cap = captureResponse()
      await routes.get(path)!(makeRequest('GET', path), cap.res)
      expect(cap.status()).toBe(405)
      expect(headerOf(cap, 'allow')).toBe('POST')
    }
  })
})

describe('plan04: GET /cdp/endpoints', () => {
  it('parses the ports CSV and timeoutMs query, answers 200 with rows', async () => {
    const seen: Array<Record<string, unknown>> = []
    const routes = setupRoutes({
      endpointInventory: async (options: Record<string, unknown> = {}) => {
        seen.push(options)
        return [endpointRow()]
      },
    })
    const cap = captureResponse()
    await routes.get(CDP_ENDPOINTS_ROUTE)!(
      makeRequest('GET', `${CDP_ENDPOINTS_ROUTE}?ports=9222,%209333,abc&timeoutMs=750`),
      cap.res,
    )
    expect(cap.status()).toBe(200)
    expect(cap.json()).toEqual({ ok: true, endpoints: [endpointRow()] })
    expect(seen[0]).toMatchObject({ ports: [9222, 9333], timeoutMs: 750 })
  })

  it('omits the overrides entirely when the query carries none', async () => {
    const seen: Array<Record<string, unknown>> = []
    const routes = setupRoutes({
      endpointInventory: async (options: Record<string, unknown> = {}) => {
        seen.push(options)
        return []
      },
    })
    const cap = captureResponse()
    await routes.get(CDP_ENDPOINTS_ROUTE)!(makeRequest('GET', CDP_ENDPOINTS_ROUTE), cap.res)
    expect(cap.status()).toBe(200)
    expect(cap.json()).toEqual({ ok: true, endpoints: [] })
    expect(seen[0]).toEqual({})
  })
})

describe('plan04: GET /cdp/connections', () => {
  it('answers with the pool briefs and the active connection id', async () => {
    const routes = setupRoutes({
      connections: () => [{ connectionId: 'ep-9222', active: true, state: 'connected' }],
      activeConnectionId: () => 'ep-9222',
    })
    const cap = captureResponse()
    await routes.get(CDP_CONNECTIONS_ROUTE)!(makeRequest('GET', CDP_CONNECTIONS_ROUTE), cap.res)
    expect(cap.status()).toBe(200)
    expect(cap.json()).toEqual({
      ok: true,
      connections: [{ connectionId: 'ep-9222', active: true, state: 'connected' }],
      activeConnectionId: 'ep-9222',
    })
  })

  it('omits activeConnectionId when nothing is attached', async () => {
    const routes = setupRoutes({
      connections: () => [],
      activeConnectionId: () => undefined,
    })
    const cap = captureResponse()
    await routes.get(CDP_CONNECTIONS_ROUTE)!(makeRequest('GET', CDP_CONNECTIONS_ROUTE), cap.res)
    expect(cap.status()).toBe(200)
    const body = cap.json()
    expect(body.connections).toEqual([])
    expect('activeConnectionId' in body).toBe(false)
  })
})

describe('plan04: POST /cdp/contexts', () => {
  it('lists contexts with the default row first', async () => {
    const routes = setupRoutes({
      listContexts: async () => [
        { contextId: '', isDefault: true, targets: 2 },
        { contextId: 'ctx-1', isDefault: false, targets: 1 },
      ],
    })
    const cap = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(makeRequest('POST', CDP_CONTEXTS_ROUTE, {}), cap.res)
    expect(cap.status()).toBe(200)
    expect(cap.json()).toEqual({
      ok: true,
      action: 'list',
      contexts: [
        { contextId: '', isDefault: true, targets: 2 },
        { contextId: 'ctx-1', isDefault: false, targets: 1 },
      ],
    })
  })

  it('creates and disposes with the reported extras', async () => {
    const seen: string[] = []
    const routes = setupRoutes({
      createContext: async () => ({ contextId: 'ctx-9' }),
      listContexts: async () => [{ contextId: 'ctx-9', isDefault: false, targets: 0 }],
      disposeContext: async (contextId: string) => { seen.push(contextId); return { closed: 3 } },
    })

    const created = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(
      makeRequest('POST', CDP_CONTEXTS_ROUTE, { action: 'create' }),
      created.res,
    )
    expect(created.status()).toBe(200)
    expect(created.json().contextId).toBe('ctx-9')

    const disposed = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(
      makeRequest('POST', CDP_CONTEXTS_ROUTE, { action: 'dispose', contextId: 'ctx-9' }),
      disposed.res,
    )
    expect(disposed.status()).toBe(200)
    expect(disposed.json().closed).toBe(3)
    expect(seen).toEqual(['ctx-9'])
  })

  it('opens a tab into a context, forwarding contextId and url', async () => {
    const seen: Array<Record<string, unknown>> = []
    const routes = setupRoutes({
      openContextTab: async (contextId: string, url: string) => {
        seen.push({ contextId, url })
        return { targetId: 'tab-9' }
      },
      listContexts: async () => [{ contextId: 'ctx-7', isDefault: false, targets: 1 }],
    })
    const cap = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(
      makeRequest('POST', CDP_CONTEXTS_ROUTE, { action: 'open', contextId: 'ctx-7', url: 'https://iso.test/' }),
      cap.res,
    )
    expect(cap.status()).toBe(200)
    expect(cap.json()).toMatchObject({ ok: true, action: 'open', targetId: 'tab-9' })
    expect(seen).toEqual([{ contextId: 'ctx-7', url: 'https://iso.test/' }])
  })

  it('rejects unknown actions and url-less opens with 400', async () => {
    const routes = setupRoutes({})

    const badAction = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(
      makeRequest('POST', CDP_CONTEXTS_ROUTE, { action: 'teleport' }),
      badAction.res,
    )
    expect(badAction.status()).toBe(400)
    expect(badAction.json().error.code).toBe('BAD_ACTION')
    expect(badAction.json().error.message).toContain('list|create|open|dispose')

    const noUrl = captureResponse()
    await routes.get(CDP_CONTEXTS_ROUTE)!(
      makeRequest('POST', CDP_CONTEXTS_ROUTE, { action: 'open', contextId: 'ctx-7' }),
      noUrl.res,
    )
    expect(noUrl.status()).toBe(400)
    expect(noUrl.json().error.code).toBe('BAD_REQUEST')
    expect(noUrl.json().error.message).toContain('requires url')
  })
})

describe('plan04: POST /cdp/disconnect', () => {
  it('detaches the active endpoint and answers 200', async () => {
    let calls = 0
    const routes = setupRoutes({
      disconnect: async () => { calls += 1 },
    })
    const cap = captureResponse()
    await routes.get(CDP_DISCONNECT_ROUTE)!(makeRequest('POST', CDP_DISCONNECT_ROUTE, {}), cap.res)
    expect(cap.status()).toBe(200)
    expect(cap.json()).toEqual({ ok: true })
    expect(calls).toBe(1)
  })
})
