/**
 * Behavioral coverage for the raw CDP connection: reply correlation, event
 * fan-out, the error-reply and timeout contracts, deterministic close, reconnect,
 * and the documented malformed-frame policy. Every case owns a real `ws` server
 * on an ephemeral loopback port and tears it down with the test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpConnectionOptions, CdpEvent } from '../src/connection.ts'
import {
  CDP_CONNECTED_EVENT,
  CDP_DISCONNECTED_EVENT,
  CdpConnection,
  CdpConnectionClosedError,
  CdpError,
  CdpTimeoutError,
} from '../src/connection.ts'
import WebSocket, { WebSocketServer } from 'ws'

/** One real `ws` server bound to an ephemeral loopback port. */
interface Endpoint {
  /** The listening server, closed with the test. */
  readonly server: WebSocketServer
  /** Client URL of the listening server. */
  readonly url: string
  /** Accepted server-side sockets, oldest first. */
  readonly sockets: WebSocket[]
  /** Request frames the server has parsed, in arrival order. */
  readonly frames: Array<Record<string, unknown>>
  /** Register a handler for every request frame the server parses. */
  onFrame(handler: (frame: Record<string, unknown>, socket: WebSocket) => void): void
}

const endpoints: Endpoint[] = []
const connections: CdpConnection[] = []

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (connection) => { await connection.close() }))
  await Promise.all(endpoints.splice(0).map(stopEndpoint))
})

/** Bind a fresh server to port 0 on loopback and expose what it receives. */
async function startEndpoint(): Promise<Endpoint> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets: WebSocket[] = []
  const frames: Array<Record<string, unknown>> = []
  const handlers: Array<(frame: Record<string, unknown>, socket: WebSocket) => void> = []
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(decodeFrame(data)) as Record<string, unknown>
      frames.push(frame)
      for (const handler of handlers) handler(frame, socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('endpoint did not bind a TCP port')
  const endpoint: Endpoint = {
    server,
    url: `ws://127.0.0.1:${String(address.port)}`,
    sockets,
    frames,
    onFrame: (handler) => { handlers.push(handler) },
  }
  endpoints.push(endpoint)
  return endpoint
}

/** Terminate the server's sockets, then close the listener. */
async function stopEndpoint(endpoint: Endpoint): Promise<void> {
  for (const socket of endpoint.sockets) socket.terminate()
  await new Promise<void>((resolve, reject) => {
    endpoint.server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Open a connection to the endpoint and register it for teardown. */
async function connected(endpoint: Endpoint, options?: CdpConnectionOptions): Promise<CdpConnection> {
  const connection = new CdpConnection(endpoint.url, options)
  connections.push(connection)
  await connection.connect()
  return connection
}

/** Observe a rejection without racing an unhandled-rejection report. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (reason: unknown) => reason)
}

/** Poll until the condition holds, failing the test after the deadline. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the deadline')
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

/** Decode a `ws` payload to UTF-8 text. */
function decodeFrame(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

/** Send one JSON frame from a server socket. */
function push(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame))
}

describe('CdpConnection', () => {
  it('correlates two in-flight sends answered out of order', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    const replies: Array<() => void> = []
    endpoint.onFrame((frame, socket) => {
      const id = frame['id']
      if (frame['method'] === 'Page.navigate') {
        replies.push(() => { push(socket, { id, result: { frame: 'nav' } }) })
      } else {
        replies.push(() => { push(socket, { id, result: { value: 42 } }) })
      }
    })

    const navigation = connection.send('Page.navigate', { url: 'https://example.test' })
    const evaluation = connection.send('Runtime.evaluate', { expression: '6 * 7' }, 'session-A')
    await waitFor(() => replies.length === 2)

    replies[1]!()
    replies[0]!()

    await expect(navigation).resolves.toEqual({ frame: 'nav' })
    await expect(evaluation).resolves.toEqual({ value: 42 })
    expect(endpoint.frames[0]).toMatchObject({ method: 'Page.navigate', params: { url: 'https://example.test' } })
    expect(endpoint.frames[1]).toMatchObject({
      method: 'Runtime.evaluate',
      params: { expression: '6 * 7' },
      sessionId: 'session-A',
    })
  })

  it('delivers events and filters listeners scoped to one session', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    const all: CdpEvent[] = []
    const scoped: CdpEvent[] = []
    connection.on('Page.loadEventFired', (event) => { all.push(event) })
    const offScoped = connection.on('Page.loadEventFired', (event) => { scoped.push(event) }, 'session-A')
    await waitFor(() => endpoint.sockets.length === 1)
    const socket = endpoint.sockets[0]!

    push(socket, { method: 'Page.loadEventFired', params: { timestamp: 1 } })
    push(socket, { method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'session-A' })
    push(socket, { method: 'Page.loadEventFired', params: { timestamp: 3 }, sessionId: 'session-B' })
    await waitFor(() => all.length === 3)

    expect(all.map(event => event.params['timestamp'])).toEqual([1, 2, 3])
    expect(all[0]!.sessionId).toBeUndefined()
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ sessionId: 'session-A', params: { timestamp: 2 } })

    offScoped()
    push(socket, { method: 'Page.loadEventFired', params: { timestamp: 4 } })
    await waitFor(() => all.length === 4)
    expect(scoped).toHaveLength(1)
  })

  it('rejects only the failing send for a protocol error reply', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    endpoint.onFrame((frame, socket) => {
      if (frame['method'] === 'Runtime.evaluate') {
        push(socket, {
          id: frame['id'],
          error: { code: -32601, message: 'method not found', data: { detail: 'unsupported' } },
          sessionId: 'session-A',
        })
      } else {
        push(socket, { id: frame['id'], result: { ok: true } })
      }
    })

    const failure = await rejection(connection.send('Runtime.evaluate', {}, 'session-A'))
    expect(failure).toBeInstanceOf(CdpError)
    expect((failure as CdpError).code).toBe(-32601)
    expect((failure as CdpError).message).toBe('method not found')
    expect((failure as CdpError).method).toBe('Runtime.evaluate')
    expect((failure as CdpError).sessionId).toBe('session-A')
    expect((failure as CdpError).data).toEqual({ detail: 'unsupported' })

    await expect(connection.send('Target.getTargets')).resolves.toEqual({ ok: true })
    expect(connection.connected).toBe(true)
  })

  it('rejects a send whose reply misses both the default and the per-send timeout', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint, { timeoutMs: 40 })

    const byDefault = await rejection(connection.send('Page.enable'))
    expect(byDefault).toBeInstanceOf(CdpTimeoutError)
    expect((byDefault as CdpTimeoutError).method).toBe('Page.enable')
    expect((byDefault as CdpTimeoutError).timeoutMs).toBe(40)

    const overridden = await rejection(connection.send('Page.enable', {}, undefined, 25))
    expect(overridden).toBeInstanceOf(CdpTimeoutError)
    expect((overridden as CdpTimeoutError).timeoutMs).toBe(25)
    expect(connection.connected).toBe(true)
  })

  it('rejects every in-flight send when the connection closes', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    const pending = rejection(connection.send('Page.enable', {}, undefined, 10_000))
    await waitFor(() => endpoint.frames.length === 1)

    await connection.close()

    const failure = await pending
    expect(failure).toBeInstanceOf(CdpConnectionClosedError)
    expect((failure as CdpConnectionClosedError).method).toBe('Page.enable')
    expect(connection.connected).toBe(false)
    await expect(connection.send('Page.enable')).rejects.toBeInstanceOf(CdpConnectionClosedError)
    await expect(connection.close()).resolves.toBeUndefined()
  })

  it('reconnect opens a new socket and re-emits the connected event', async () => {
    const endpoint = await startEndpoint()
    const connection = new CdpConnection(endpoint.url)
    connections.push(connection)
    const connectedEvents: number[] = []
    const disconnected: CdpEvent[] = []
    connection.on(CDP_CONNECTED_EVENT, () => { connectedEvents.push(endpoint.sockets.length) })
    connection.on(CDP_DISCONNECTED_EVENT, (event) => { disconnected.push(event) })

    await connection.connect()
    expect(connectedEvents).toEqual([1])

    endpoint.onFrame((frame, socket) => {
      push(socket, { id: frame['id'], result: { socketCount: endpoint.sockets.length } })
    })
    await connection.reconnect()

    expect(connectedEvents).toEqual([1, 2])
    expect(disconnected).toHaveLength(1)
    expect(disconnected[0]!.params['code']).toBe(1000)
    expect(endpoint.sockets).toHaveLength(2)
    await expect(connection.send('Target.getTargets')).resolves.toEqual({ socketCount: 2 })
  })

  it('ignores non-JSON frames and replies that match no in-flight send', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    endpoint.onFrame((frame, socket) => {
      push(socket, { id: frame['id'], result: { echoed: frame['method'] } })
    })
    const socket = endpoint.sockets[0]!
    socket.send('this is not json')
    socket.send(Buffer.from('binary payload'), { binary: true })
    push(socket, { id: 9999, result: { stray: true } })
    socket.send(JSON.stringify([1, 2, 3]))

    await expect(connection.send('First.probe')).resolves.toEqual({ echoed: 'First.probe' })
    await expect(connection.send('Second.probe')).resolves.toEqual({ echoed: 'Second.probe' })
    expect(connection.connected).toBe(true)
  })

  it('closes the connection when a reply arrives without an id', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    const disconnected: CdpEvent[] = []
    connection.on(CDP_DISCONNECTED_EVENT, (event) => { disconnected.push(event) })
    const pending = rejection(connection.send('Page.enable', {}, undefined, 10_000))
    await waitFor(() => endpoint.frames.length === 1)

    push(endpoint.sockets[0]!, { result: { uncorrelated: true } })
    await waitFor(() => disconnected.length === 1)

    expect(disconnected[0]!.params['code']).toBe(1002)
    expect(await pending).toBeInstanceOf(CdpConnectionClosedError)
    expect(connection.connected).toBe(false)
    await expect(connection.send('Page.enable')).rejects.toBeInstanceOf(CdpConnectionClosedError)
  })

  it('keeps delivering an event to the listeners after one of them throws', async () => {
    const endpoint = await startEndpoint()
    const connection = await connected(endpoint)
    const received: CdpEvent[] = []
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      connection.on('Runtime.consoleAPICalled', () => { throw new Error('listener failed') })
      connection.on('Runtime.consoleAPICalled', (event) => { received.push(event) })
      push(endpoint.sockets[0]!, { method: 'Runtime.consoleAPICalled', params: { type: 'log' } })
      await waitFor(() => received.length === 1)
      expect(reported).toHaveBeenCalled()
    } finally {
      reported.mockRestore()
    }
  })

  it('exposes its lifecycle through the public state getter (plan01)', async () => {
    const endpoint = await startEndpoint()
    const connection = new CdpConnection(endpoint.url)
    connections.push(connection)
    expect(connection.state).toBe('idle')
    await connection.connect()
    expect(connection.state).toBe('open')
    expect(connection.connected).toBe(true)
    await connection.close()
    expect(connection.state).toBe('closed')
    expect(connection.connected).toBe(false)
  })
})
