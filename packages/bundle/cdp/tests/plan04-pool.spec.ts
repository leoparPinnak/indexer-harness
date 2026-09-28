/**
 * plan04: the endpoint connection pool, loopback endpoint discovery, and the
 * automatic reattach driver.
 *
 * Three layers:
 *  1. pool unit tests — keying/id derivation, idempotent adopt, forget vs
 *     detach, the entry cap, and `probeEndpoint`/`discoverEndpoints` against
 *     injected fetches,
 *  2. REAL `ws` endpoints proving the headline behaviors: `connect()` is
 *     idempotent, switching endpoints PARKS the old one (its socket stays
 *     open), `disconnect()` detaches only the active entry, and an intentional
 *     close never schedules a reconnect,
 *  3. the reconnect path itself — a server-side socket drop, exponential
 *     backoff, `Target.setDiscoverTargets` re-armed on the new socket
 *     generation, stale sessions invalidated, and the active target restored —
 *     plus endpoint inventory and isolated-context lifecycle on the wire.
 */

import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebSocket, { WebSocketServer } from 'ws'
import { CdpService } from '../src/service.ts'
import {
  ConnectionPool,
  CdpPoolFullError,
  connectionIdOf,
  discoverEndpoints,
  normalizeEndpoint,
  parseEndpoint,
  probeEndpoint,
} from '../src/connection-pool.ts'
import { CdpConnection } from '../src/connection.ts'

const contexts: Context[] = []
const services: CdpService[] = []
const endpoints: Array<{ server: WebSocketServer, sockets: WebSocket[] }> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(services.splice(0).map(service => service.stop().catch(() => {})))
  for (const endpoint of endpoints.splice(0)) {
    for (const socket of endpoint.sockets) socket.terminate()
    await new Promise<void>((resolve) => { endpoint.server.close(() => { resolve() }) })
  }
})

// ---------------------------------------------------------------------------
// Wire harness: a real CDP-speaking ws endpoint with per-method replies.
// ---------------------------------------------------------------------------

interface Wire {
  readonly url: string
  readonly port: number
  readonly frames: Array<Record<string, unknown>>
  readonly sockets: WebSocket[]
  broadcast(payload: Record<string, unknown>): void
  setReply(method: string, result: Record<string, unknown>): void
}

/** A `ws` endpoint that auto-replies to every CDP request frame. */
async function startWire(
  targetInfos: Array<Record<string, unknown>>,
  replies: Record<string, Record<string, unknown>> = {},
): Promise<Wire> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets: WebSocket[] = []
  const frames: Array<Record<string, unknown>> = []
  const mutable = { replies }
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      frames.push(frame)
      const method = typeof frame.method === 'string' ? frame.method : ''
      const override = mutable.replies[method]
      const result = override ?? (method === 'Target.getTargets'
        ? { targetInfos }
        : method === 'Target.attachToTarget'
          ? { sessionId: 'sess-1' }
          : {})
      socket.send(JSON.stringify({ id: frame.id, result }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('wire did not bind a port')
  const wire: Wire = {
    url: `ws://127.0.0.1:${String(address.port)}`,
    port: address.port,
    frames,
    sockets,
    broadcast: (payload) => {
      const text = JSON.stringify(payload)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text)
      }
    },
    setReply: (method, result) => { mutable.replies[method] = result },
  }
  endpoints.push({ server, sockets })
  return wire
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the deadline')
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

const tabRows = (): Array<Record<string, unknown>> => [
  { targetId: 'tab-1', type: 'page', title: 'Migros', url: 'https://migros.test/', attached: false },
  { targetId: 'tab-2', type: 'page', title: 'LiteLLM', url: 'http://localhost:4000/ui/login', attached: false },
]

const discoverFramesOf = (wire: Wire): Array<Record<string, unknown>> =>
  wire.frames.filter(frame => frame.method === 'Target.setDiscoverTargets')

// ---------------------------------------------------------------------------
// 1. Pool unit: keying, adopt/forget, cap, discovery probes.
// ---------------------------------------------------------------------------

describe('plan04: pool keying and adoption', () => {
  it('parses the browser GUID and port out of a debugger URL', () => {
    expect(parseEndpoint('ws://127.0.0.1:9333/devtools/browser/abc-123-def'))
      .toEqual({ browserId: 'abc-123-def', port: 9333 })
    expect(parseEndpoint('ws://127.0.0.1:9222').browserId).toBe('')
    expect(parseEndpoint('not a url')).toEqual({ browserId: '', port: undefined })
    expect(normalizeEndpoint('ws://127.0.0.1:9222/')).toBe('ws://127.0.0.1:9222')
    // The port outranks the GUID so ids stay readable: ep-9333, not ep-abc-123.
    expect(connectionIdOf('ws://127.0.0.1:9333/devtools/browser/abc-123-def')).toBe('ep-9333')
    expect(connectionIdOf('ws://127.0.0.1:9333')).toBe('ep-9333')
  })

  it('adopt is idempotent per endpoint; forget removes and disarms', () => {
    const pool = new ConnectionPool({ hooks: { onReconnected: async () => {} } })
    const conn = new CdpConnection('ws://127.0.0.1:9333')
    const entry = pool.adopt('ws://127.0.0.1:9333/', conn)
    expect(pool.adopt('ws://127.0.0.1:9333', conn)).toBe(entry)
    expect(pool.get('ws://127.0.0.1:9333')).toBe(entry)
    expect(pool.byConnectionId('ep-9333')).toBe(entry)
    expect(entry.connectionId).toBe('ep-9333')
    expect(entry.state).toBe('degraded') // never dialed → not connected at adopt time

    pool.forget(entry)
    expect(pool.get('ws://127.0.0.1:9333')).toBeUndefined()
    expect(pool.byConnectionId('ep-9333')).toBeUndefined()
    expect(pool.size).toBe(0)
  })

  it('refuses to exceed the entry cap when nothing is evictable', () => {
    const pool = new ConnectionPool({ maxEntries: 1, hooks: { onReconnected: async () => {} } })
    pool.adopt('ws://127.0.0.1:9222', new CdpConnection('ws://127.0.0.1:9222'))
    let thrown: unknown
    try {
      pool.adopt('ws://127.0.0.1:9333', new CdpConnection('ws://127.0.0.1:9333'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CdpPoolFullError)
    expect((thrown as CdpPoolFullError).size).toBe(1)
    expect((thrown as CdpPoolFullError).max).toBe(1)
    expect(String((thrown as CdpPoolFullError).message)).toContain('pool is full')
  })
})

describe('plan04: endpoint discovery probes', () => {
  it('probeEndpoint reads the ws URL, Browser header, and GUID', async () => {
    const fetchOk = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/guid-9',
        Browser: 'Chrome/131.0.0.0',
      }),
    })) as unknown as typeof globalThis.fetch
    const probe = await probeEndpoint(9222, fetchOk, 50)
    expect(probe).toEqual({
      port: 9222,
      reachable: true,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/guid-9',
      browser: 'Chrome/131.0.0.0',
      browserId: 'guid-9',
    })
  })

  it('probeEndpoint degrades without throwing for HTTP errors, non-browser answers, and refusals', async () => {
    const httpError = await probeEndpoint(1, ((async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof globalThis.fetch), 50)
    expect(httpError.reachable).toBe(false)
    expect(httpError.error).toBe('HTTP 500')

    const notABrowser = await probeEndpoint(2, ((async () => ({
      ok: true,
      status: 200,
      json: async () => ({ some: 'json' }),
    })) as unknown as typeof globalThis.fetch), 50)
    expect(notABrowser.reachable).toBe(true)
    expect(notABrowser.webSocketDebuggerUrl).toBeUndefined()
    expect(notABrowser.error).toContain('webSocketDebuggerUrl')

    const refused = await probeEndpoint(3, (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3')
    }) as unknown as typeof globalThis.fetch, 50)
    expect(refused.reachable).toBe(false)
    expect(refused.error).toContain('ECONNREFUSED')
  })

  it('discoverEndpoints preserves input order and probes every port', async () => {
    const seen: number[] = []
    const fetchByPort = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const port = Number(url.split(':')[2]?.split('/')[0])
      seen.push(port)
      return {
        ok: true,
        status: 200,
        json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}` }),
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const rows = await discoverEndpoints([9225, 9222, 9444], fetchByPort, 50)
    expect(rows.map(row => row.port)).toEqual([9225, 9222, 9444])
    expect(rows.every(row => row.reachable)).toBe(true)
    expect(seen).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 2. Real endpoints: idempotent attach, park/activate, detach semantics.
// ---------------------------------------------------------------------------

describe('plan04: pooled connect behavior on a real endpoint', () => {
  it('connect() is idempotent for the same endpoint (one socket, no re-dial)', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)
    await service.connect(wire.url)
    await service.connect(wire.url)
    expect(wire.sockets).toHaveLength(1)
    expect(service.status().connectionState).toBe('connected')
    expect(service.connections()).toHaveLength(1)
    expect(service.activeConnectionId()).toBe(`ep-${String(wire.port)}`)
  }, 15_000)

  it('switching endpoints parks the old one — both sockets stay open', async () => {
    const wireA = await startWire(tabRows())
    const wireB = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)

    await service.connect(wireA.url)
    await service.connect(wireB.url)
    expect(service.status().endpoint).toBe(wireB.url)
    // A was PARKED, not disconnected: its socket is still open.
    expect(wireA.sockets).toHaveLength(1)
    expect(wireA.sockets[0]!.readyState).toBe(WebSocket.OPEN)

    // Re-activating A parks B — B survives too (the old code dropped it).
    await service.connect(wireA.url)
    expect(service.status().endpoint).toBe(wireA.url)
    expect(wireB.sockets[0]!.readyState).toBe(WebSocket.OPEN)

    const connections = service.connections()
    expect(connections).toHaveLength(2)
    const active = connections.filter(row => row.active)
    expect(active).toHaveLength(1)
    expect(active[0]!.connectionId).toBe(`ep-${String(wireA.port)}`)
    expect(active[0]!.endpoint).toBe(wireA.url)
  }, 15_000)

  it('disconnect() detaches only the active endpoint; the parked sibling stays attached', async () => {
    const wireA = await startWire(tabRows())
    const wireB = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wireA.url)
    await service.connect(wireB.url)

    await service.disconnect()
    expect(service.status().connectionState).toBe('disconnected')
    // B (the active one) died; A keeps its pooled socket.
    expect(wireB.sockets[0]!.readyState).not.toBe(WebSocket.OPEN)
    expect(wireA.sockets[0]!.readyState).toBe(WebSocket.OPEN)
    const connections = service.connections()
    expect(connections).toHaveLength(1)
    expect(connections[0]!.endpoint).toBe(wireA.url)
    expect(connections[0]!.active).toBe(false)
    expect(service.activeConnectionId()).toBeUndefined()
  }, 15_000)

  it('an intentional disconnect never schedules a reconnect', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)
    await service.disconnect()

    const framesAtClose = wire.frames.length
    await sleep(900) // 250ms base backoff would have fired a retry by now
    expect(wire.sockets).toHaveLength(1) // no second dial arrived
    expect(wire.frames.length).toBe(framesAtClose)
    expect(service.connections()).toHaveLength(0)
  }, 15_000)

  it('open() reports the pool id and reused verdict for an already-attached endpoint', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    const first = await service.open({ endpoint: wire.url })
    expect(first.reused).toBe(false)
    expect(first.connectionId).toBe(`ep-${String(wire.port)}`)

    const second = await service.open({ endpoint: wire.url })
    expect(second.reused).toBe(true)
    expect(second.connectionId).toBe(first.connectionId)
    expect(second.endpoint).toBe(wire.url)
    expect(wire.sockets).toHaveLength(1) // the reuse really skipped the dial
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 3. Reattach: backoff reconnect, re-armed discovery, restored session state.
// ---------------------------------------------------------------------------

describe('plan04: automatic reattachment after a socket drop', () => {
  it('reconnects with backoff, re-arms setDiscoverTargets, and restores the active tab', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)

    // The browser focuses tab-2 before the drop; the rebuilt registry must
    // remember it.
    wire.broadcast({ method: 'Target.targetActivated', params: { targetId: 'tab-2' } })
    await waitFor(() => service.status().activeTargetId === 'tab-2')
    const staleSession = await service.getPageSession()
    expect(staleSession.sessionId).toBe('sess-1')
    expect(discoverFramesOf(wire)).toHaveLength(1)

    // Server-side drop (no close frame) → the driver must recover on its own.
    wire.sockets[0]!.terminate()
    // The wait includes rebuild completion: the pool flips the entry back to
    // `connected` only after handleReconnected() resolved (discovery re-armed,
    // registry swapped, active tab restored).
    await waitFor(() => {
      const rows = service.connections()
      return wire.sockets.length >= 2
        && discoverFramesOf(wire).length >= 2
        && rows.length === 1
        && rows[0]!.reconnects >= 1
        && rows[0]!.state === 'connected'
        && service.status().connectionState === 'connected'
        && service.status().activeTargetId === 'tab-2'
    })

    // Discovery re-armed on the NEW socket generation (registry rebuild proof).
    expect(discoverFramesOf(wire).length).toBeGreaterThanOrEqual(2)
    // Exactly one reconnect: no duplicate backoff loops fired.
    expect(wire.sockets).toHaveLength(2)

    // Active tab restored and the stale flattened session invalidated.
    expect(service.status().activeTargetId).toBe('tab-2')
    expect(service.status().pages).toBe(2)
    const freshSession = await service.getPageSession()
    expect(freshSession).not.toBe(staleSession)
    expect(freshSession.sessionId).toBe('sess-1')

    const rows = service.connections()
    expect(rows[0]!.reconnects).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.state).toBe('connected')
    expect(rows[0]!.lastError).toBeUndefined()
    expect(rows[0]!.activeTargetId).toBe('tab-2')

    // Settle: a healthy entry must not keep re-dialing.
    const frameCount = wire.frames.length
    await sleep(1200)
    expect(wire.sockets).toHaveLength(2)
    expect(wire.frames.length).toBe(frameCount)
  }, 20_000)

  it('a parked endpoint reconnects in the background while another is active', async () => {
    const wireA = await startWire(tabRows())
    const wireB = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wireA.url)
    await service.connect(wireB.url) // A parked, B active

    wireA.sockets[0]!.terminate() // parked A's socket dies
    await waitFor(() => {
      const row = service.connections().find(row => row.endpoint === wireA.url)
      return row !== undefined && row.reconnects >= 1 && row.state === 'connected'
    })
    // B was never disturbed and A came back on its own.
    expect(service.status().endpoint).toBe(wireB.url)
    expect(wireA.sockets).toHaveLength(2)
    expect(wireB.sockets).toHaveLength(1)
    const rowA = service.connections().find(row => row.endpoint === wireA.url)
    expect(rowA!.active).toBe(false)
    // The parked entry's registry was rebuilt too: discovery re-armed on its
    // new socket generation (briefs never expose the registry object itself).
    expect(discoverFramesOf(wireA).length).toBeGreaterThanOrEqual(2)
    expect(rowA!.targets).toBe(2)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 4. Inventory and isolated contexts on the wire.
// ---------------------------------------------------------------------------

describe('plan04: endpoint inventory', () => {
  it('merges probed ports with the pool and reports unreachable ports honestly', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)

    const fetchProbe = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`http://127.0.0.1:${String(wire.port)}/`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ webSocketDebuggerUrl: wire.url, Browser: 'Chrome/test' }),
        } as unknown as Response
      }
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    const rows = await service.endpointInventory({ ports: [wire.port, 9999], fetch: fetchProbe })
    expect(rows).toHaveLength(2)

    const attached = rows.find(row => row.port === wire.port)!
    expect(attached).toMatchObject({
      port: wire.port,
      reachable: true,
      attached: true,
      active: true,
      state: 'connected',
      endpoint: wire.url,
      browser: 'Chrome/test',
      browserId: '',
      connectionId: `ep-${String(wire.port)}`,
      targets: 2,
      error: '',
    })

    const dead = rows.find(row => row.port === 9999)!
    expect(dead.reachable).toBe(false)
    expect(dead.attached).toBe(false)
    expect(dead.state).toBe('unreachable')
    expect(dead.connectionId).toBe('')
    expect(dead.error).not.toBe('')

    // Pool-only row: the attached endpoint is reported even when its port was
    // not part of this probe round.
    const poolOnly = await service.endpointInventory({ ports: [9999], fetch: fetchProbe })
    const pooled = poolOnly.find(row => row.endpoint === wire.url)!
    expect(pooled).toBeDefined()
    expect(pooled.attached).toBe(true)
    expect(pooled.active).toBe(true)
    expect(pooled.targets).toBe(2)
    expect(pooled.browser).toBe('')
  }, 15_000)
})

describe('plan04: isolated browser contexts', () => {
  it('creates, lists, opens into, and disposes contexts through the wire', async () => {
    const wire = await startWire([
      { targetId: 'tab-1', type: 'page', title: 'Migros', url: 'https://migros.test/', attached: false },
      { targetId: 'tab-2', type: 'page', title: 'LiteLLM', url: 'http://localhost:4000/ui/login', attached: false },
      { targetId: 'tab-3', type: 'page', title: 'Isolated', url: 'https://iso.test/', attached: false, browserContextId: 'ctx-7' },
    ], {
      'Target.createBrowserContext': { browserContextId: 'ctx-7' },
      'Target.getBrowserContexts': { browserContextIds: ['ctx-7'] },
      'Target.createTarget': { targetId: 'tab-9' },
      'Target.disposeBrowserContext': {},
    })
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)

    const created = await service.createContext()
    expect(created).toEqual({ contextId: 'ctx-7' })
    expect(wire.frames.some(frame => frame.method === 'Target.createBrowserContext')).toBe(true)

    const listed = await service.listContexts()
    expect(listed).toEqual([
      { contextId: '', isDefault: true, targets: 2 },
      { contextId: 'ctx-7', isDefault: false, targets: 1 },
    ])

    const opened = await service.openContextTab('ctx-7', 'https://iso.test/new')
    expect(opened).toEqual({ targetId: 'tab-9' })
    const createFrame = wire.frames.find(frame => frame.method === 'Target.createTarget')
    expect((createFrame!.params as { browserContextId?: unknown }).browserContextId).toBe('ctx-7')

    await service.openContextTab('', 'about:blank')
    const defaultFrame = [...wire.frames].reverse().find(frame => frame.method === 'Target.createTarget')
    expect('browserContextId' in (defaultFrame!.params as Record<string, unknown>)).toBe(false)

    // The default context cannot be disposed; an isolated one reports its tabs.
    await expect(service.disposeContext('')).rejects.toThrow('default context cannot be disposed')
    const disposed = await service.disposeContext('ctx-7')
    expect(disposed).toEqual({ closed: 1 })
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 4. FAZ7 + F6: capture-proxy lifecycle, the keep-the-session open() rules,
//    and the successor envelope for ids that stayed on a parked endpoint.
// ---------------------------------------------------------------------------

describe('plan04-FAZ7: capture proxy lifecycle', () => {
  it('ensureProxy binds the configured port, is idempotent, and dies with stop()', async () => {
    const service = new CdpService({ proxyListenPort: 0 })
    services.push(service)
    const first = await service.ensureProxy()
    expect(first.active).toBe(true)
    expect(first.port).toBeGreaterThan(0)
    expect(service.status().proxy.active).toBe(true)

    const second = await service.ensureProxy()
    expect(second.active).toBe(true)
    expect(second.port).toBe(first.port) // already listening — no second bind

    await service.stop()
    expect(service.status().proxy.active).toBe(false)
  }, 15_000)

  it('skips a busy configured port and binds the next idle one', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = blocker.address()
    const busyPort = typeof address === 'object' && address !== null ? address.port : 0
    const service = new CdpService({ proxyListenPort: busyPort })
    services.push(service)
    try {
      const state = await service.ensureProxy()
      expect(state.active).toBe(true)
      // First port refused (the blocker) → the scan took a later candidate.
      expect(state.port).toBeGreaterThan(busyPort)
      expect((state.port ?? 0) - busyPort).toBeLessThanOrEqual(7)
      expect(service.status().proxy.active).toBe(true)
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => { resolve() }) })
    }
  }, 15_000)

  it('reports an unreachable bind as {active:false} instead of throwing', async () => {
    // plan04-fix2: 65535 leaves the scan window with this ONE candidate, so
    // blocking it makes every try fail deterministically.
    const blocker = createServer()
    await new Promise<void>((resolve) => {
      // Already busy counts too — the port stays occupied either way.
      blocker.once('error', () => { resolve() })
      blocker.listen(65535, '127.0.0.1', () => { resolve() })
    })
    const service = new CdpService({ proxyListenPort: 65535 })
    services.push(service)
    try {
      const state = await service.ensureProxy()
      expect(state.active).toBe(false)
      expect(String(state.error)).toContain('EADDRINUSE')
      expect(service.status().proxy.active).toBe(false)
    } finally {
      blocker.close(() => { /* a non-listening close answers with an err arg */ })
    }
  }, 15_000)
})

describe('plan04-F6: cdp_open keeps the live session', () => {
  // plan13-profile: a bare `open()` now DISCOVERS the configured ports first
  // and answers `needsChoice` (attaching nothing) when a live browser turns
  // up. These specs pin an empty port set so the F6 keep-the-session contract
  // is judged on its own, not on whether the developer has a debug browser up.
  it('a bare re-open returns the active endpoint without dialing or relaunching', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService({ discoveryPorts: [] })
    services.push(service)
    const first = await service.open({ endpoint: wire.url })
    expect(first.reused).toBe(false)
    const framesBefore = wire.frames.length

    const again = await service.open()
    expect(again.reused).toBe(true)
    expect(again.endpoint).toBe(wire.url)
    expect(again.connectionId).toBe(first.connectionId)
    expect(again.note).toBeUndefined() // same config → clean no-op
    expect(wire.frames.length).toBe(framesBefore) // no CDP traffic at all
    expect(wire.sockets).toHaveLength(1)
  }, 15_000)

  it('a differing port keeps the session and explains the verdict', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService({ discoveryPorts: [] })
    services.push(service)
    await service.open({ endpoint: wire.url })

    const elsewhere = await service.open({
      port: 9555,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/elsewhere' }),
      })) as unknown as typeof globalThis.fetch,
    })
    expect(elsewhere.reused).toBe(true)
    expect(elsewhere.endpoint).toBe(wire.url) // the live session won
    expect(String(elsewhere.note)).toContain('9555')
    expect(String(elsewhere.note)).toContain('resolves to')
    expect(wire.sockets).toHaveLength(1)
  }, 15_000)

  it('a silent port keeps the session with the discovery note', async () => {
    const wire = await startWire(tabRows())
    const service = new CdpService({ discoveryPorts: [] })
    services.push(service)
    await service.open({ endpoint: wire.url })

    const silent = await service.open({
      port: 9333,
      fetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof globalThis.fetch,
    })
    expect(silent.reused).toBe(true)
    expect(silent.endpoint).toBe(wire.url)
    expect(String(silent.note)).toContain('did not answer discovery')
    expect(wire.sockets).toHaveLength(1)
  }, 15_000)

  it('an explicit endpoint still switches — the pool parks the previous one', async () => {
    const wireA = await startWire(tabRows())
    const wireB = await startWire(tabRows())
    const service = new CdpService()
    services.push(service)
    await service.open({ endpoint: wireA.url })
    const switched = await service.open({ endpoint: wireB.url })
    expect(switched.reused).toBe(false)
    expect(switched.endpoint).toBe(wireB.url)
    expect(switched.connectionId).toBe(`ep-${String(wireB.port)}`)
    expect(wireA.sockets).toHaveLength(1) // parked, still open
    expect(wireB.sockets).toHaveLength(1)
  }, 15_000)
})

describe('plan04-F6: ids that stayed behind get a successor envelope', () => {
  it('names the same-URL successor on the active endpoint', async () => {
    const wireA = await startWire([
      { targetId: 'old-1', type: 'page', title: 'Same page', url: 'https://same.test/app', attached: false },
    ])
    const wireB = await startWire([
      { targetId: 'new-7', type: 'page', title: 'Same page', url: 'https://same.test/app', attached: false },
    ])
    const service = new CdpService()
    services.push(service)
    await service.connect(wireA.url)
    await service.connect(wireB.url) // A parks with its registry intact

    const error = await service.getPageSession('old-1').then(
      () => new Error('expected the refusal'),
      (reason: unknown) => reason as Error,
    )
    expect(error.message).toContain('is not tracked') // plan03 base, unchanged
    expect(error.message).toContain('stayed on parked endpoint')
    expect(error.message).toContain(`ep-${String(wireA.port)}`)
    expect(error.message).toContain('https://same.test/app')
    expect(error.message).toContain('same-URL successor on the active endpoint: new-7')
  }, 15_000)
})
