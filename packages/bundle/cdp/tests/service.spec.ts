/**
 * Unit tests for CdpService: connection adapters, loopback discovery,
 * session orchestration, and resource teardown.
 */

import { describe, expect, it } from 'vitest'
import {
  CdpService,
  createInputConnectionAdapter,
  createPageConnectionAdapter,
  createTargetConnectionAdapter,
} from '../src/service.ts'
import type { CdpConnection, CdpEvent } from '../src/connection.ts'

function createMockCdpConnection() {
  const sent: Array<{
    method: string
    params?: Record<string, unknown> | undefined
    sessionId?: string | undefined
  }> = []
  const listeners = new Map<string, (event: CdpEvent) => void>()

  const mock = {
    connected: true,
    endpoint: 'ws://127.0.0.1:9222/test',
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      sent.push({ method, params, sessionId })
      if (method === 'Target.setDiscoverTargets') return Promise.resolve({})
      if (method === 'Target.getTargets') {
        return Promise.resolve({
          targetInfos: [
            { targetId: 'tab-1', type: 'page', title: 'Home', url: 'https://example.com' },
          ],
        })
      }
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'session-123' })
      if (method === 'Page.navigate') return Promise.resolve({ frameId: 'frame-1' })
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 'test-value' } })
      if (method === 'DOM.getDocument') {
        return Promise.resolve({
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: 9,
            nodeName: '#document',
            localName: '',
            nodeValue: '',
          },
        })
      }
      return Promise.resolve({})
    },
    on: (event: string, listener: (event: CdpEvent) => void) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  } as unknown as CdpConnection

  return { mock, sent, listeners }
}

describe('CdpService & Adapters', () => {
  it('bridges CdpConnection to TargetConnection adapter correctly', () => {
    const { mock, sent, listeners } = createMockCdpConnection()
    const adapter = createTargetConnectionAdapter(mock)

    void adapter.send('Target.testMethod', { key: 'val' })
    expect(sent.length).toBe(1)
    expect(sent[0]?.method).toBe('Target.testMethod')

    let receivedParams: unknown
    adapter.on('Target.targetCreated', (params) => {
      receivedParams = params
    })

    const listener = listeners.get('Target.targetCreated')
    expect(listener).toBeDefined()
    listener!({ method: 'Target.targetCreated', params: { targetId: 'new-1' }, sessionId: undefined })
    expect(receivedParams).toEqual({ targetId: 'new-1' })
  })

  it('bridges CdpConnection to PageConnection adapter with session fan-out', () => {
    const { mock, sent, listeners } = createMockCdpConnection()
    const adapter = createPageConnectionAdapter(mock)

    void adapter.send('Page.navigate', { url: 'https://test.com' }, 'session-abc')
    expect(sent.length).toBe(1)
    expect(sent[0]?.sessionId).toBe('session-abc')

    let capturedSessionId: string | undefined
    adapter.on('Page.loadEventFired', (_params, sessId) => {
      capturedSessionId = sessId
    })

    const listener = listeners.get('Page.loadEventFired')
    expect(listener).toBeDefined()
    listener!({ method: 'Page.loadEventFired', params: { timestamp: 123 }, sessionId: 'session-xyz' })
    expect(capturedSessionId).toBe('session-xyz')
  })

  it('bridges CdpConnection to InputConnection adapter', () => {
    const { mock, sent } = createMockCdpConnection()
    const adapter = createInputConnectionAdapter(mock)

    void adapter.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }, 'sess-1')
    expect(sent.length).toBe(1)
    expect(sent[0]?.method).toBe('Input.dispatchMouseEvent')
    expect(sent[0]?.sessionId).toBe('sess-1')
  })

  it('discovers WebSocket URL via loopback /json/version', async () => {
    const service = new CdpService()
    const mockFetch = (() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    })) as unknown as typeof globalThis.fetch

    const url = await service.discoverEndpoint(9222, mockFetch)
    expect(url).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
  })

  it('fails loud when discovery endpoint is unreachable', async () => {
    const service = new CdpService()
    const failingFetch = (() => Promise.resolve({
      ok: false,
      status: 503,
    })) as unknown as typeof globalThis.fetch

    await expect(service.discoverEndpoint(9222, failingFetch)).rejects.toThrow(
      'cdp discovery failed: http://127.0.0.1:9222/json/version returned HTTP 503',
    )
  })

  it('reports status correctly before and after connecting', async () => {
    const service = new CdpService()
    const status = service.status()
    expect(status.ok).toBe(true)
    expect(typeof status.version).toBe('string')
    expect(status.targets).toBe(0)
    expect(status.proxy).toEqual({ active: false })

    service.setProxyActive(true)
    expect(service.status().proxy.active).toBe(true)

    await service.stop()
  })

  // plan01 (Adım 5): exec orchestration against a poked session — the public
  // method's evidence, clamp, and post-condition semantics without a socket.
  interface FakeSession {
    sessionId: string
    url: () => Promise<string>
    evaluate: (expression: string, options?: { timeoutMs?: number; awaitPromise?: boolean }) => Promise<Record<string, unknown>>
  }

  /** Wire a fake connection/registry/session into a fresh service instance. */
  function pokedService(session: FakeSession): { service: CdpService; sent: string[] } {
    const sent: string[] = []
    const page = { targetId: 'tab-1', type: 'page', title: 'Home', url: 'https://example.com' }
    const service = new CdpService()
    const poked = service as unknown as {
      connection: unknown
      registry: Record<string, unknown>
      sessions: Map<string, unknown>
    }
    poked.connection = {
      endpoint: 'ws://127.0.0.1:9222/test',
      state: 'open',
      send: (method: string) => {
        sent.push(method)
        return Promise.resolve({})
      },
    }
    poked.registry = {
      targets: () => [page],
      active: () => page,
      attachedSession: () => session.sessionId,
      attach: async () => session.sessionId,
      setActive: () => {},
      list: async () => {},
      dispose: () => {},
    }
    poked.sessions = new Map([[session.sessionId, session]])
    return { service, sent }
  }

  it('exec reports success with evidence and clamps the timeout (plan01)', async () => {
    const calls: Array<{ expression: string; options?: { timeoutMs?: number } | undefined }> = []
    const session: FakeSession = {
      sessionId: 'sess-1',
      url: () => Promise.resolve('https://example.com'),
      evaluate: (expression, options) => {
        calls.push({ expression, options })
        return Promise.resolve({ value: '42', truncated: false, exception: undefined, hasValue: true, valueType: 'number' })
      },
    }
    const { service } = pokedService(session)
    const outcome = await service.exec({ expression: '1 + 1', timeoutMs: 50 })
    expect(outcome.ok).toBe(true)
    expect(outcome.didAct).toBe(true)
    expect(outcome.result).toBe('42')
    expect(outcome.valueType).toBe('number')
    expect(outcome.targetId).toBe('tab-1')
    expect(outcome.url).toBe('https://example.com')
    expect(outcome.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    // timeoutMs 50 was clamped up to the 100ms floor before reaching the wire.
    expect(calls[0]?.options?.timeoutMs).toBe(100)
  })

  it('exec folds a script exception into the envelope and skips the post-condition (plan01)', async () => {
    const calls: string[] = []
    const session: FakeSession = {
      sessionId: 'sess-1',
      url: () => Promise.resolve('https://example.com'),
      evaluate: (expression) => {
        calls.push(expression)
        return Promise.resolve({
          value: '',
          truncated: false,
          exception: 'TypeError: x',
          hasValue: false,
          valueType: 'undefined',
          error: { kind: 'exception', name: 'TypeError', message: 'x' },
        })
      },
    }
    const { service } = pokedService(session)
    const outcome = await service.exec({ expression: 'null.x', postCondition: 'Boolean(1)' })
    expect(outcome.ok).toBe(false)
    expect(outcome.didAct).toBe(false)
    expect(outcome.result).toBe('')
    const error = outcome.error as { kind?: string; phase?: string; expression?: string }
    expect(error.kind).toBe('exception')
    expect(error.phase).toBe('script')
    expect(error.expression).toBe('null.x')
    // E13: a thrown script ends the run — the post-condition never evaluates.
    expect(calls).toHaveLength(1)
  })

  it('exec marks a falsy post-condition as postCondition failure (plan01)', async () => {
    const calls: string[] = []
    let scriptCalls = 0
    const session: FakeSession = {
      sessionId: 'sess-1',
      url: () => Promise.resolve('https://example.com'),
      evaluate: (expression) => {
        calls.push(expression)
        scriptCalls += 1
        if (scriptCalls === 1) {
          return Promise.resolve({ value: 'done', truncated: false, exception: undefined, hasValue: true, valueType: 'string' })
        }
        return Promise.resolve({
          value: JSON.stringify({ passed: false, value: 'false' }),
          truncated: false,
          exception: undefined,
          hasValue: true,
          valueType: 'string',
        })
      },
    }
    const { service } = pokedService(session)
    const outcome = await service.exec({ expression: '1', postCondition: 'return "false"' })
    expect(outcome.ok).toBe(false)
    expect(outcome.didAct).toBe(false)
    const error = outcome.error as { kind?: string; phase?: string }
    expect(error.kind).toBe('postCondition')
    expect(error.phase).toBe('postCondition')
    expect(outcome.postCondition).toEqual({ requested: true, passed: false, value: 'false' })
    // Both phases ran, and the wrapper carried the user's condition text.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('return "false"')
  })

  it('exec envelopes a missing connection instead of throwing (plan01 E15)', async () => {
    const service = new CdpService()
    const outcome = await service.exec({ expression: '1' })
    expect(outcome.ok).toBe(false)
    expect(outcome.didAct).toBe(false)
    const error = outcome.error as { kind?: string; message?: string }
    expect(error.kind).toBe('connection')
    expect(error.message).toContain('no active browser connection')
    expect(outcome.targetId).toBe('')
    expect(outcome.url).toBe('')
  })
})
