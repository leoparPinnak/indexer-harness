import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  gatewayCoordinates,
  GatewayAlreadyRunningError,
  GatewayAuthError,
  GatewayPayloadTooLargeError,
  GatewayTimeoutError,
  encodeFrame,
  FrameReader,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PipeGatewayClient,
  PROTOCOL_VERSION,
  startPipeGateway,
  type DecodedFrame,
  type GatewayMessage,
  type PipeGateway,
  type StartPipeGatewayOptions,
} from '../src/index.ts'

/** Live gateways closed after each case, newest first. */
const mounted: PipeGateway[] = []

/** Every spec-created gateway key lives in a temp home, never the live one. */
let savedHome: string | undefined
let specHome: string

beforeEach(() => {
  savedHome = process.env.DSH_HOME
  specHome = mkdtempSync(join(tmpdir(), 'dsh-ipc-pipe-home-'))
  process.env.DSH_HOME = specHome
})

afterEach(async () => {
  for (const gateway of mounted.splice(0)) await gateway.close()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  savedHome = undefined
  rmSync(specHome, { recursive: true, force: true })
})

/**
 * Mount a gateway on its own seed so no case touches another's endpoint.
 * @param handler - handler under test.
 * @param extra - further mount options such as log or budgets.
 * @returns the mounted gateway and the seed naming it.
 */
async function mount(
  handler: StartPipeGatewayOptions['handler'],
  extra: Partial<StartPipeGatewayOptions> = {},
): Promise<{ gateway: PipeGateway; seed: string }> {
  const seed = randomUUID()
  const gateway = await startPipeGateway({ seed, handler, ...extra })
  mounted.push(gateway)
  return { gateway, seed }
}

/**
 * Wait for a duration without holding a callback open longer than needed.
 * @param ms - milliseconds to wait.
 * @returns a promise resolving once the time passed.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** One raw socket speaking the frame grammar, for the cases the client hides. */
class RawPeer {
  /** Frames received so far, in arrival order. */
  readonly frames: DecodedFrame[] = []
  /** Callbacks waiting for a frame that has not arrived yet. */
  readonly #waiters: Array<{ predicate: (frame: DecodedFrame) => boolean; resolve: (frame: DecodedFrame) => void }> = []

  private constructor(readonly socket: Socket) {
    const reader = new FrameReader()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        this.frames.push(frame)
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.#waiters[index]
          if (waiter === undefined || !waiter.predicate(frame)) continue
          this.#waiters.splice(index, 1)
          waiter.resolve(frame)
        }
      }
    })
  }

  /**
   * Open a socket to an endpoint.
   * @param path - endpoint to dial.
   * @returns the connected peer.
   */
  static async open(path: string): Promise<RawPeer> {
    const socket = connect(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new RawPeer(socket)
  }

  /**
   * Send one frame.
   * @param message - envelope to send.
   * @param body - optional raw payload.
   */
  send(message: GatewayMessage, body?: Buffer): void {
    this.socket.write(encodeFrame(message, body))
  }

  /**
   * Wait for a frame matching a predicate.
   * @param predicate - what counts as the wanted frame.
   * @param timeoutMs - how long to wait.
   * @returns the first matching frame.
   */
  async waitFor(predicate: (frame: DecodedFrame) => boolean, timeoutMs = 3000): Promise<DecodedFrame> {
    const seen = this.frames.find(predicate)
    if (seen !== undefined) return seen
    return await new Promise<DecodedFrame>((resolve, reject) => {
      const waiter = { predicate, resolve }
      this.#waiters.push(waiter)
      setTimeout(() => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(new Error(`no matching frame within ${String(timeoutMs)}ms`))
      }, timeoutMs).unref()
    })
  }

  /** Half-close: send the FIN while still able to read the answer. */
  halfClose(): void {
    this.socket.end()
  }

  /** Drop the connection outright. */
  destroy(): void {
    this.socket.destroy()
  }
}

/**
 * Authenticate a raw peer against a mounted gateway.
 * @param path - endpoint to dial.
 * @param digest - digest proving the peer holds the gateway key.
 * @returns the authenticated peer.
 */
async function handshake(path: string, digest: string): Promise<RawPeer> {
  const peer = await RawPeer.open(path)
  peer.send({ t: 'hello', v: PROTOCOL_VERSION, digest })
  await peer.waitFor(frame => frame.message.t === 'welcome')
  return peer
}

describe('gateway handshake', () => {
  it('answers a peer that proves the key and refuses one that does not', async () => {
    const warnings: string[] = []
    const { gateway, seed } = await mount(
      (req, res) => { res.end(JSON.stringify({ url: req.url })) },
      { log: { info: () => {}, warn: (message: string) => { warnings.push(message) }, error: () => {} } },
    )

    const client = await PipeGatewayClient.connect({ seed })
    const answered = await client.request({ method: 'GET', url: '/health' })
    expect(answered.status).toBe(200)
    expect(JSON.parse(answered.body.toString())).toEqual({ url: '/health' })
    client.close()

    await expect(PipeGatewayClient.connect({ seed, key: 'not-the-home-key' }))
      .rejects.toBeInstanceOf(GatewayAuthError)
    expect(warnings.some(line => line.includes('digest'))).toBe(true)

    // The refused connection never reached the handler, and the gateway still serves.
    const stillServing = await PipeGatewayClient.connect({ seed })
    expect((await stillServing.request({ method: 'GET', url: '/health' })).status).toBe(200)
    stillServing.close()
    expect(gateway.path).toContain('dsh-gateway-')
  })
})

describe('gateway size caps', () => {
  it('refuses a request past the 64 KiB cap with an explicit error', async () => {
    const { seed } = await mount((_req, res) => { res.end('{}') })
    const client = await PipeGatewayClient.connect({ seed })
    try {
      await expect(
        client.request({ method: 'POST', url: '/big', body: Buffer.alloc(MAX_REQUEST_BYTES + 1) }),
      ).rejects.toBeInstanceOf(GatewayPayloadTooLargeError)
    } finally {
      client.close()
    }
  })

  it('refuses a response past the 512 KiB cap with an explicit error', async () => {
    const { seed } = await mount((_req, res) => { res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1)) })
    const client = await PipeGatewayClient.connect({ seed })
    try {
      await expect(client.request({ method: 'GET', url: '/huge' }))
        .rejects.toBeInstanceOf(GatewayPayloadTooLargeError)
      // The refusal is per-request: the connection stays usable afterwards.
      expect(client.connected).toBe(true)
    } finally {
      client.close()
    }
  })

  it('refuses an in-band body the header pushes over the cap, sparing the connection', async () => {
    // The body alone fits the cap; the `res` envelope (45 bytes) rides along,
    // so the frame on the wire does not. Measuring only the body would let this
    // answer through, and the peer's reader would then kill the connection —
    // taking innocent in-flight requests with it.
    const { seed } = await mount((req, res) => {
      if (req.url === '/borderline') res.end(Buffer.alloc(MAX_RESPONSE_BYTES - 16))
      else res.end('ok')
    })
    const client = await PipeGatewayClient.connect({ seed })
    try {
      const borderline = client.request({ method: 'GET', url: '/borderline' })
      borderline.catch(() => { /* awaited below once the in-flight answer settles */ })
      const normal = await client.request({ method: 'GET', url: '/health' })
      expect(normal.status).toBe(200)
      await expect(borderline).rejects.toBeInstanceOf(GatewayPayloadTooLargeError)
      // The refusal stays per-request: the peer never sees an illegal frame.
      expect(client.connected).toBe(true)
      expect((await client.request({ method: 'GET', url: '/health' })).status).toBe(200)
    } finally {
      client.close()
    }
  })
})

describe('gateway budgets', () => {
  it('fails a request that never answers inside its budget', async () => {
    const { seed } = await mount(() => { /* never answers */ })
    const client = await PipeGatewayClient.connect({ seed })
    try {
      await expect(client.request({ method: 'GET', url: '/slow' }, 150))
        .rejects.toBeInstanceOf(GatewayTimeoutError)
    } finally {
      client.close()
    }
  })

  it('arms the same budget on the server when the caller sends one', async () => {
    const { gateway, seed } = await mount(() => { /* never answers */ })
    const peer = await handshake(gateway.path, gatewayCoordinates({ seed }).digest)
    peer.send({ t: 'req', id: 1, method: 'GET', url: '/slow', timeoutMs: 150 })
    const failure = await peer.waitFor(frame => frame.message.t === 'error')
    expect(failure.message).toMatchObject({ id: 1, code: 'TIMEOUT' })
    peer.destroy()
  })

  it('answers ping without involving the handler', async () => {
    const { seed } = await mount(() => { throw new Error('the handler must not run for ping') })
    const client = await PipeGatewayClient.connect({ seed })
    try {
      await expect(client.ping()).resolves.toBe(true)
    } finally {
      client.close()
    }
  })
})

describe('gateway single-instance lock', () => {
  it('refuses a second mount while the holder lives and admits one after close', async () => {
    const { gateway, seed } = await mount(() => {})
    await expect(startPipeGateway({ seed, handler: () => {} })).rejects.toBeInstanceOf(GatewayAlreadyRunningError)
    await gateway.close()
    mounted.splice(mounted.indexOf(gateway), 1)

    const replacement = await startPipeGateway({ seed, handler: () => {} })
    mounted.push(replacement)
    expect(replacement.path).toBe(gateway.path)
    const client = await PipeGatewayClient.connect({ seed })
    expect(client.connected).toBe(true)
    client.close()
  })
})

describe('gateway half-close tolerance', () => {
  // win32 cannot deliver an answer to a peer that half-closed: the write side
  // takes EPIPE (libuv/OS semantics — reproduced in plain Node, not an
  // ipc-pipe bug; POSIX unix-socket behavior is unverified here), so the frame
  // never reaches the peer. Known limitation in the README; peers should sign
  // off with the protocol's `bye` message instead of a raw FIN.
  it.skipIf(process.platform === 'win32')('keeps answering a peer that half-closed while the answer was cooking', async () => {
    const warnings: string[] = []
    let closedAt = 0
    const { gateway, seed } = await mount(
      (_req, res) => {
        res.on('close', () => { closedAt = performance.now() })
        setTimeout(() => { res.end('late but delivered') }, 250)
      },
      { log: { info: () => {}, warn: (message: string) => { warnings.push(message) }, error: () => {} } },
    )
    const peer = await handshake(gateway.path, gatewayCoordinates({ seed }).digest)
    peer.send({ t: 'req', id: 7, method: 'GET', url: '/late' })
    peer.halfClose()
    const finAt = performance.now()

    // Inside the tolerance window a silent peer is not a dead connection:
    // the answer keeps cooking and nothing is dropped or logged.
    await delay(150)
    expect(closedAt).toBe(0)
    expect(warnings.some(line => line.includes('dropped a half-closed connection'))).toBe(false)

    // The answer still lands: the buffered `res` frame reaches the
    // half-closed peer with the late body inside it.
    const answer = await peer.waitFor(frame => frame.message.t === 'res')
    expect(answer.body.toString()).toBe('late but delivered')
    for (let attempt = 0; closedAt === 0 && attempt < 100; attempt += 1) await delay(20)
    expect(closedAt).toBeGreaterThan(0)
    expect(closedAt - finAt).toBeGreaterThan(100)
    peer.destroy()
  })

  it('drops a half-closed peer once the tolerance window passes with an answer outstanding', async () => {
    const warnings: string[] = []
    const { gateway, seed } = await mount(() => { /* never answers */ }, {
      halfCloseToleranceMs: 80,
      timeoutMs: 5000,
      log: { info: () => {}, warn: (message: string) => { warnings.push(message) }, error: () => {} },
    })
    const peer = await handshake(gateway.path, gatewayCoordinates({ seed }).digest)
    peer.send({ t: 'req', id: 1, method: 'GET', url: '/never', timeoutMs: 5000 })
    peer.halfClose()

    for (let attempt = 0; attempt < 100 && !warnings.some(line => line.includes('dropped a half-closed connection')); attempt += 1) {
      await delay(20)
    }
    expect(warnings.some(line => line.includes('dropped a half-closed connection after 80ms'))).toBe(true)
    peer.destroy()
  })
})

describe('gateway streams', () => {
  it('delivers chunks in order and releases the producer when the reader leaves', async () => {
    let released = false
    let ticks = 0
    let requestedUrl = ''
    const { seed } = await mount((req, res) => {
      requestedUrl = req.url
      res.setHeader('content-type', 'text/plain')
      res.flushHeaders()
      res.on('close', () => { released = true })
      const timer = setInterval(() => {
        ticks += 1
        if (released || !res.write(`frame-${String(ticks)};`)) clearInterval(timer)
      }, 10)
      timer.unref()
    })

    const client = await PipeGatewayClient.connect({ seed })
    try {
      const stream = await client.openStream({ method: 'GET', url: '/feed' })
      expect(stream.statusCode).toBe(200)
      expect(requestedUrl).toBe('/feed')
      const first = await new Promise<Buffer>((resolve) => { stream.once('data', (piece: Buffer) => { resolve(piece) }) })
      expect(first.toString()).toMatch(/^frame-\d+;/)

      // The reader walks away; the producer must observe the release.
      stream.destroy()
      for (let attempt = 0; !released && attempt < 100; attempt += 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
      }
      expect(released).toBe(true)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      client.close()
    }
  })
})
