/** Deferred-login seam contract: a denying gate rejects both Connection carriers. */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, type ConnectionIndexResponse, type HostConnectionHandle } from '../src/index.ts'

// The seam is the single mount point for a future login gate: this suite
// installs a denying gate and observes both carriers, while every other suite
// runs against the real, currently unconditional seam.
const gate = vi.hoisted(() => ({ rejection: undefined as 401 | undefined }))
vi.mock('../src/admission.ts', () => ({
  admissionRejection: () => gate.rejection,
}))

async function mounted(): Promise<{
  readonly connection: HostConnectionHandle
  readonly routes: WebRoute[]
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', {
    register(route: WebRoute) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  } as unknown as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionHandle,
    routes,
    dispose: () => fiber.dispose(),
  }
}

/** Bodyless GET shaped like node:http input for a registered route. */
function fakeRequest(headers: Record<string, string>, url = '/api/session.list'): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** Response recorder capturing the carrier-owned status, headers, and body. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; headers?: Record<string, string>; body?: string } } {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {}
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers !== undefined) state.headers = headers
      return this
    },
    end(body?: string) {
      if (body !== undefined) state.body = body
      return this
    },
  }
  return { response: response as unknown as ServerResponse, state }
}

/** Index-response recorder for the frontend delegation seam. */
function indexResponse(): { response: ConnectionIndexResponse; state: { status?: number; headers?: Readonly<Record<string, string>>; body?: string } } {
  const state: { status?: number; headers?: Readonly<Record<string, string>>; body?: string } = {}
  return {
    response: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

beforeEach(() => {
  gate.rejection = undefined
})

describe('admission seam denial', () => {
  it('rejects API requests with 401 while the Host/Origin fence still answers first', async () => {
    const { connection, dispose } = await mounted()
    expect(connection.requestRejection({ headers: { host: '127.0.0.1:4005' } })).toBeUndefined()

    gate.rejection = 401
    expect(connection.requestRejection({ headers: { host: '127.0.0.1:4005' } })).toBe(401)
    expect(connection.requestRejection({ headers: new Headers({ host: 'localhost:4005' }) })).toBe(401)
    // The fence runs before the gate: an untrusted Host is still 403.
    expect(connection.requestRejection({ headers: { host: 'other.example' } })).toBe(403)
    await dispose()
  })

  it('answers a denied index request through the response it owns', async () => {
    const { connection, dispose } = await mounted()
    const open = indexResponse()
    expect(connection.authorizeIndex({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4005' } }, open.response)).toBe(true)
    expect(open.state).toEqual({})

    gate.rejection = 401
    const denied = indexResponse()
    expect(connection.authorizeIndex({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4005' } }, denied.response)).toBe(false)
    expect(denied.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store' },
      body: 'unauthorized\n',
    })
    await dispose()
  })

  it('applies the Host/Origin fence to the index surface (forged Host is 403)', async () => {
    const { connection, dispose } = await mounted()
    // F1 regression: the fence runs before the admission seam on the index too,
    // so a Host the deployment never declared is refused 403 even though the
    // admission seam would have allowed it (clean entry stays 200/true).
    const denied = indexResponse()
    expect(connection.authorizeIndex({ method: 'GET', url: '/', headers: { host: 'other.example' } }, denied.response)).toBe(false)
    expect(denied.state).toEqual({
      status: 403,
      headers: { 'cache-control': 'no-store' },
      body: 'forbidden\n',
    })
    await dispose()
  })

  it('carries the denial onto the registered /api route', async () => {
    const { routes, dispose } = await mounted()
    gate.rejection = 401
    const denied = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:4005' }), denied.response)
    expect(denied.state).toMatchObject({ status: 401, body: 'unauthorized' })
    await dispose()
  })

  it('carries the denial onto a dedicated RPC channel route', async () => {
    const { connection, routes, dispose } = await mounted()
    const remove = connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }))
    const route = routes.find(candidate => candidate.path === '/rpc')
    if (route === undefined) throw new Error('dedicated RPC route was not registered')

    gate.rejection = 401
    const denied = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:4005' }, '/rpc/goals/create'), denied.response)
    expect(denied.state).toMatchObject({ status: 401, body: 'unauthorized' })
    await remove()
    await dispose()
  })
})
