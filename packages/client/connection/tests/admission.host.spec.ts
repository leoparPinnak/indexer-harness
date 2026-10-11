/** Unconditional browser admission behind the Host/Origin fence. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { admissionRejection } from '../src/admission.ts'
import { apply, inject, type ConnectionConfig, type ConnectionIndexResponse, type HostConnectionHandle } from '../src/index.ts'

async function mounted(config?: ConnectionConfig): Promise<{
  readonly connection: HostConnectionHandle
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
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

/** Index-response recorder that proves whether admission wrote anything. */
function indexResponse(): {
  response: ConnectionIndexResponse
  state: { status?: number; headers?: Readonly<Record<string, string>>; body?: string }
} {
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

describe('connection admission', () => {
  it('never rejects on the auth axis; only the Host/Origin fence refuses', async () => {
    const { connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    expect(connection.requestRejection({ headers: { host: '127.0.0.1:4005' } })).toBeUndefined()
    expect(connection.requestRejection({ headers: { host: 'localhost:4005' } })).toBeUndefined()
    expect(connection.requestRejection({ headers: { host: 'harness.example' } })).toBeUndefined()
    // The fence itself is unchanged: a Host the deployment never declared,
    // even a LAN IP literal, is refused with 403 before admission runs.
    expect(connection.requestRejection({ headers: { host: '192.168.1.5:4005' } })).toBe(403)
    expect(connection.requestRejection({ headers: { host: 'other.example' } })).toBe(403)
    await dispose()
  })

  it('admits a credential-free index request without writing a response', async () => {
    const { connection, dispose } = await mounted()
    const requests = [
      { method: 'GET', url: '/', headers: { host: '127.0.0.1:4005' } },
      { method: 'GET', url: '/?token=stale-token', headers: { host: '127.0.0.1:4005' } },
      { method: 'HEAD', url: '/index.html', headers: { host: '127.0.0.1:4005' } },
      { headers: { host: '127.0.0.1:4005' } },
      { headers: { host: '127.0.0.1:4005', cookie: 'dsh-auth-forged=value' } },
    ]
    for (const request of requests) {
      const recorded = indexResponse()
      expect(connection.authorizeIndex(request, recorded.response)).toBe(true)
      expect(recorded.state).toEqual({})
    }
    await dispose()
  })

  it('returns the clean root URL with no token query', async () => {
    const { connection, dispose } = await mounted()
    expect(connection.authenticatedUrl('http://127.0.0.1:4005')).toBe('http://127.0.0.1:4005/')
    expect(connection.authenticatedUrl('http://127.0.0.1:4005/app?token=stale#frag')).toBe('http://127.0.0.1:4005/')
    const lan = new URL(connection.authenticatedUrl('http://192.168.1.5:4005'))
    expect(lan.search).toBe('')
    expect(lan.searchParams.has('token')).toBe(false)
    await dispose()
  })

  it('leaves the admission seam undecided for every request shape', () => {
    expect(admissionRejection({ headers: { host: '127.0.0.1:4005' } })).toBeUndefined()
    expect(admissionRejection({
      headers: new Headers({ host: 'harness.example', cookie: 'dsh-auth-forged=value' }),
    })).toBeUndefined()
  })
})
