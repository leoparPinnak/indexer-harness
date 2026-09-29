/**
 * The pipe gateway client: connects to a mounted gateway, authenticates in
 * the first handshake, then exchanges framed request/response messages.
 *
 * Every request carries its own budget (default {@link DEFAULT_TIMEOUT_MS}) in
 * both directions, so a slow handler answers with an explicit `error` frame
 * instead of a hung socket. A stream request resolves as soon as the status
 * header lands and then reads `chunk` frames until `end`, which is what lets
 * the daemon's multipart frame feed cross the pipe unchanged.
 *
 * @module @deepseek-ai/dsh-ipc-pipe/client
 */

import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { gatewayCoordinates, type GatewayCoordinateOptions } from './coords.ts'
import {
  GatewayAuthError,
  GatewayClosedError,
  GatewayError,
  GatewayPayloadTooLargeError,
  GatewayProtocolError,
  GatewayTimeoutError,
} from './errors.ts'
import { DEFAULT_TIMEOUT_MS, encodeFrame, FrameReader, PROTOCOL_VERSION, type GatewayMessage } from './protocol.ts'

/** One request to send. */
export interface GatewayRequestInit {
  /** Upper-case HTTP method. */
  readonly method: string
  /** Request target including its query string. */
  readonly url: string
  /** Header fields to carry. */
  readonly headers?: Record<string, string> | undefined
  /** Raw request body. */
  readonly body?: string | Buffer | undefined
  /** Declare a long-lived stream so the handler knows the peer reads chunks. */
  readonly stream?: boolean | undefined
}

/** A complete buffered response. */
export interface GatewayResponsePayload {
  /** Status line the handler set. */
  readonly status: number
  /** Response headers the handler set. */
  readonly headers: Record<string, string>
  /** The whole body. */
  readonly body: Buffer
}

/**
 * A response arriving as a stream: the status header resolves the promise,
 * then body bytes push until the server ends it. Destroying the stream early
 * tells the server to stop producing, which is how a viewer that went away
 * releases the producer.
 */
export class GatewayStream extends Readable {
  /** Status line the handler set. */
  readonly statusCode: number
  /** Response headers the handler set. */
  readonly headers: Record<string, string>
  /** Body bytes decoded so far, exposed for a caller that buffers. */
  readonly chunks: Buffer[] = []
  /** True once the server ended the stream. */
  ended = false

  /**
   * @param statusCode - status line of the stream.
   * @param headers - response headers of the stream.
   */
  constructor(statusCode: number, headers: Record<string, string>) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }

  /** Pull-driven body: bytes are pushed by the client as frames arrive. */
  override _read(): void {
    /* Push-side delivery; consumer demand does not gate the socket. */
  }
}

/** Connection options: coordinates plus the budgets the handshake uses. */
export interface GatewayClientOptions extends GatewayCoordinateOptions {
  /** Budget for connect plus handshake, in milliseconds. */
  connectTimeoutMs?: number | undefined
}

/** Bookkeeping for one in-flight message. */
interface Pending {
  /** Whether the caller reads the answer as one buffer or as a stream. */
  mode: 'buffered' | 'stream'
  /** Deliver a complete response. */
  resolve: (value: unknown) => void
  /** Deliver the refusal. */
  reject: (error: Error) => void
  /** Budget timer; the status header clears it. */
  timer: NodeJS.Timeout | undefined
  /** Status line once the `res` frame landed. */
  status: number
  /** Response headers once the `res` frame landed. */
  headers: Record<string, string>
  /** Body pieces collected before the stream resolved. */
  chunks: Buffer[]
  /** The stream handed to the caller, once it resolved. */
  stream: GatewayStream | undefined
  /** True once the status header landed. */
  responded: boolean
}

/**
 * Map a peer's error code onto the typed vocabulary.
 * @param code - the peer's stable code.
 * @param message - the peer's description.
 * @returns the typed failure.
 */
function errorFrom(code: string, message: string): GatewayError {
  if (code === 'AUTH_FAILED') return new GatewayAuthError(message)
  if (code === 'TIMEOUT') return new GatewayTimeoutError(message)
  if (code === 'PAYLOAD_TOO_LARGE') return new GatewayPayloadTooLargeError(message)
  if (code === 'PROTOCOL') return new GatewayProtocolError(message)
  if (code === 'CLOSED') return new GatewayClosedError(message)
  return new GatewayError(code, message)
}

/** A live gateway connection. */
export class PipeGatewayClient extends EventEmitter {
  /** Endpoint this client speaks to. */
  readonly path: string
  /** The socket, while it is open. */
  #socket: Socket | undefined
  /** Incrementing request id space of this connection. */
  #nextId = 1
  /** In-flight messages keyed by request id. */
  readonly #pending = new Map<number, Pending>()
  /** Frame decoder for the read side. */
  readonly #reader = new FrameReader()
  /** In-flight handshake, while `connect` still waits for `welcome`. */
  #handshake: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined
  /** Digest of the key this client proved itself with. */
  readonly #digest: string

  /**
   * Connect and complete the handshake.
   * @param options - coordinates and budgets.
   * @returns the authenticated client.
   * @throws GatewayAuthError when the digest is refused.
   * @throws GatewayTimeoutError when the peer never answers the handshake.
   * @throws GatewayClosedError when the connection cannot be established.
   */
  static async connect(options: GatewayClientOptions = {}): Promise<PipeGatewayClient> {
    const coords = gatewayCoordinates(options)
    const budget = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const socket = connect(coords.path)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new GatewayTimeoutError(`gateway at ${coords.path} did not accept a connection within ${String(budget)}ms`))
      }, budget)
      timer.unref()
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new GatewayClosedError(`gateway at ${coords.path} is unreachable: ${error.message}`))
      })
    })
    const client = new PipeGatewayClient(socket, coords.path, coords.digest)
    await client.#handshakeOnce(budget)
    return client
  }

  /**
   * @param socket - the connected socket.
   * @param path - endpoint path, kept for log lines.
   * @param digest - digest proving this client holds the key.
   */
  private constructor(socket: Socket, path: string, digest: string) {
    super()
    this.path = path
    this.#digest = digest
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => { this.#onData(chunk) })
    socket.on('error', (error: Error) => { this.#onGone(`gateway connection failed: ${error.message}`) })
    socket.on('close', () => { this.#onGone('gateway connection closed') })
  }

  /** True while the connection can still carry a request. */
  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed
  }

  /**
   * Send one request and wait for its complete buffered answer.
   * @param init - method, target, headers, and body.
   * @param timeoutMs - budget for this request; defaults to {@link DEFAULT_TIMEOUT_MS}.
   * @returns the status, headers, and whole body.
   */
  async request(init: GatewayRequestInit, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<GatewayResponsePayload> {
    return await this.#send(init, 'buffered', timeoutMs) as GatewayResponsePayload
  }

  /**
   * Send one request and take its answer as a stream.
   * @param init - method, target, headers, and body.
   * @param timeoutMs - budget for the status header; defaults to {@link DEFAULT_TIMEOUT_MS}.
   * @returns the stream, resolved as soon as the status header lands.
   */
  async openStream(init: GatewayRequestInit, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<GatewayStream> {
    return await this.#send({ ...init, stream: true }, 'stream', timeoutMs) as GatewayStream
  }

  /**
   * Probe the peer without involving the handler.
   * @param timeoutMs - budget for the round trip.
   * @returns true when the peer answered `pong`.
   */
  async ping(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    const socket = this.#socket
    if (socket === undefined) return false
    const id = this.#nextId++
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve(false)
      }, timeoutMs)
      timer.unref()
      this.#pending.set(id, {
        mode: 'buffered',
        resolve: () => { clearTimeout(timer); resolve(true) },
        reject: () => { clearTimeout(timer); resolve(false) },
        timer,
        status: 0,
        headers: {},
        chunks: [],
        stream: undefined,
        responded: true,
      })
      socket.write(encodeFrame({ t: 'ping', id }))
    })
  }

  /**
   * Close the connection politely: pending callers fail, the peer sees `bye`.
   */
  close(): void {
    const socket = this.#socket
    if (socket === undefined) return
    if (!socket.writableEnded) socket.write(encodeFrame({ t: 'bye' }))
    this.#onGone('gateway client closed')
    socket.end()
  }

  /**
   * Send one request and route its answer to the caller.
   * @param init - request to send.
   * @param mode - how the caller reads the answer.
   * @param timeoutMs - budget carried to both sides.
   * @returns the buffered payload or the resolved stream.
   */
  async #send(init: GatewayRequestInit, mode: 'buffered' | 'stream', timeoutMs: number): Promise<unknown> {
    const socket = this.#socket
    if (socket === undefined) throw new GatewayClosedError(`gateway at ${this.path} is closed`)
    const id = this.#nextId++
    const body = init.body === undefined ? Buffer.alloc(0) : typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : init.body
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new GatewayTimeoutError(`${init.method} ${init.url} exceeded ${String(timeoutMs)}ms on ${this.path}`))
      }, timeoutMs)
      timer.unref()
      this.#pending.set(id, {
        mode,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        status: 0,
        headers: {},
        chunks: [],
        stream: undefined,
        responded: false,
      })
      const message: GatewayMessage = {
        t: 'req',
        id,
        method: init.method,
        url: init.url,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.stream === undefined ? {} : { stream: init.stream }),
        timeoutMs,
      }
      socket.write(encodeFrame(message, body))
    })
  }

  /**
   * Prove the key, waiting for `welcome`.
   * @param budget - milliseconds the peer gets to answer.
   * @throws GatewayAuthError when the digest is refused.
   * @throws GatewayTimeoutError when `welcome` never arrives.
   */
  async #handshakeOnce(budget: number): Promise<void> {
    const socket = this.#socket
    if (socket === undefined) throw new GatewayClosedError(`gateway at ${this.path} is closed`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#handshake = undefined
        reject(new GatewayTimeoutError(`gateway at ${this.path} did not complete the handshake within ${String(budget)}ms`))
        socket.destroy()
      }, budget)
      timer.unref()
      this.#handshake = { resolve, reject, timer }
      socket.write(encodeFrame({ t: 'hello', v: PROTOCOL_VERSION, digest: this.#digest }))
    })
  }

  /**
   * Decode one socket chunk.
   * @param chunk - bytes off the wire.
   */
  #onData(chunk: Buffer): void {
    let frames
    try {
      frames = this.#reader.push(chunk)
    } catch (error: unknown) {
      const failure = error instanceof GatewayError ? error : new GatewayProtocolError(String(error))
      const socket = this.#socket
      this.#onGone(failure.message, failure)
      socket?.destroy()
      return
    }
    for (const frame of frames) {
      const message = frame.message
      if (message.t === 'welcome') {
        if (this.#handshake !== undefined) {
          clearTimeout(this.#handshake.timer)
          this.#handshake.resolve()
          this.#handshake = undefined
        }
        continue
      }
      if (message.t === 'error') {
        const failure = errorFrom(message.code, message.message)
        if (message.id === undefined) {
          const handshake = this.#handshake
          if (handshake !== undefined) {
            clearTimeout(handshake.timer)
            handshake.reject(failure)
            this.#handshake = undefined
          }
          // A connection-level refusal (size cap, protocol, half-close window)
          // fails every waiter with its own type, not with a generic close.
          const active = this.#socket
          this.#onGone(failure.message, failure)
          active?.destroy()
          continue
        }
        const pending = this.#pending.get(message.id)
        if (pending === undefined) continue
        this.#settle(message.id, pending, () => {
          if (pending.stream === undefined) {
            pending.reject(failure)
            return
          }
          // A stream already handed to its reader fails through the stream;
          // without a listener the same bytes end it quietly instead of
          // becoming an uncaught 'error' on a socket nobody is watching.
          if (pending.stream.listenerCount('error') > 0) pending.stream.destroy(failure)
          else pending.stream.push(null)
        })
        continue
      }
      if (message.t === 'pong') {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) continue
        this.#settle(message.id, pending, () => { pending.resolve(true) })
        continue
      }
      if (message.t === 'res') {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) continue
        pending.status = message.status
        pending.headers = message.headers ?? {}
        pending.responded = true
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer)
          pending.timer = undefined
        }
        if (pending.mode === 'stream') {
          const stream = new GatewayStream(pending.status, pending.headers)
          pending.stream = stream
          // A viewer that goes away destroys its stream; tell the server so
          // the producer's client set does not keep an absent reader alive.
          stream.once('close', () => {
            const open = this.#pending.get(message.id)
            if (open === undefined) return
            const socket = this.#socket
            if (socket !== undefined && !socket.writableEnded) socket.write(encodeFrame({ t: 'abort', id: message.id }))
            this.#settle(message.id, open, () => { open.reject(new GatewayClosedError('stream destroyed by its reader')) })
          })
          pending.resolve(stream)
          if (frame.body.length > 0) stream.push(frame.body)
          if (message.stream !== true) this.#complete(message.id, pending)
          continue
        }
        if (message.stream !== true) {
          pending.chunks.push(frame.body)
          this.#complete(message.id, pending)
        }
        continue
      }
      if (message.t === 'chunk' || message.t === 'end') {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) continue
        if (frame.body.length > 0) {
          // A resolved stream pushes as frames land; only an answer still
          // waiting for its status header buffers.
          if (pending.mode === 'stream' && pending.stream !== undefined) pending.stream.push(frame.body)
          else pending.chunks.push(frame.body)
        }
        if (message.t === 'chunk') continue
        this.#complete(message.id, pending)
        continue
      }
      const stray = this.#socket
      this.#onGone(`gateway at ${this.path} sent an unexpected "${message.t}" message`)
      stray?.destroy()
      return
    }
  }

  /**
   * Deliver a finished buffered response or close a finished stream.
   * @param id - request id that finished.
   * @param pending - its bookkeeping.
   */
  #complete(id: number, pending: Pending): void {
    if (pending.mode === 'stream' && pending.stream !== undefined) {
      pending.stream.ended = true
      this.#settle(id, pending, () => {
        pending.stream?.push(null)
      })
      return
    }
    this.#settle(id, pending, () => {
      pending.resolve({ status: pending.status, headers: pending.headers, body: Buffer.concat(pending.chunks) })
    })
  }

  /**
   * Drop bookkeeping and then run the delivery, so a delivery that re-enters
   * the client never sees the message twice.
   * @param id - request id settling.
   * @param pending - its bookkeeping.
   * @param deliver - what the caller gets.
   */
  #settle(id: number, pending: Pending, deliver: () => void): void {
    if (!this.#pending.delete(id)) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    deliver()
  }

  /**
   * Fail every caller still waiting on a connection that is gone.
   * @param reason - why it closed.
   * @param failure - the typed refusal, when a peer sent one.
   */
  #onGone(reason: string, failure?: GatewayError): void {
    if (this.#socket === undefined && this.#handshake === undefined && this.#pending.size === 0) return
    const handshake = this.#handshake
    if (handshake !== undefined) {
      clearTimeout(handshake.timer)
      handshake.reject(failure ?? new GatewayClosedError(reason))
      this.#handshake = undefined
    }
    const waiting = [...this.#pending.values()]
    this.#pending.clear()
    this.#socket = undefined
    for (const pending of waiting) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      const dropped = failure ?? new GatewayClosedError(reason)
      // A stream already handed over fails through its own channel; killing it
      // here is what a daemon death mid-stream looked like over HTTP.
      if (pending.stream !== undefined) pending.stream.destroy(dropped)
      else pending.reject(dropped)
    }
    this.emit('close')
  }
}
