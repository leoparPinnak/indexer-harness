/**
 * The pipe gateway server: one `net` listener on the home's named pipe (or
 * unix socket) that carries framed request/response messages to the handler
 * behind it.
 *
 * Three properties are load-bearing. A **single-instance lock** beside the
 * endpoint refuses a second mount instead of letting two listeners share one
 * pipe name — the failure mode that used to surface as a port collision.
 * A **handshake digest** must match before any request is accepted, so a stray
 * process on the same home cannot drive the daemon. A peer that **half-closes**
 * keeps its writable side alive for {@link HALF_CLOSE_TOLERANCE_MS}, so an
 * answer computed after the peer's FIN still lands.
 *
 * @module @deepseek-ai/dsh-ipc-pipe/server
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { digestMatches, gatewayCoordinates, type GatewayCoordinateOptions } from './coords.ts'
import {
  GatewayAlreadyRunningError,
  GatewayAuthError,
  GatewayClosedError,
  GatewayError,
  GatewayPayloadTooLargeError,
  GatewayProtocolError,
  GatewayTimeoutError,
} from './errors.ts'
import {
  DEFAULT_TIMEOUT_MS,
  encodeFrame,
  FrameReader,
  HALF_CLOSE_TOLERANCE_MS,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  type GatewayMessage,
} from './protocol.ts'

/** Minimal logger the gateway needs; the daemon's logger satisfies it. */
export interface GatewayLogger {
  /** Routine lifecycle lines. */
  info(message: string): void
  /** Refusals and recoverable oddities. */
  warn(message: string): void
  /** Connection-level failures. */
  error(message: string): void
}

/** One request as the handler sees it: a readable body plus HTTP-shaped metadata. */
export class GatewayRequest extends Readable {
  /** Upper-case HTTP method the peer sent. */
  readonly method: string
  /** Request target including its query string. */
  readonly url: string
  /** Lower-cased header fields the peer sent. */
  readonly headers: Record<string, string>
  /** True when the peer declared this request a long-lived stream. */
  readonly stream: boolean

  /**
   * @param init - method, target, headers, and the raw body bytes.
   */
  constructor(init: {
    method: string
    url: string
    headers?: Record<string, string> | undefined
    stream?: boolean | undefined
    body: Buffer
  }) {
    super()
    this.method = init.method
    this.url = init.url
    this.headers = init.headers ?? {}
    this.stream = init.stream === true
    if (init.body.length > 0) this.push(init.body)
    this.push(null)
  }

  /** Push-driven body: everything is already queued, nothing waits on demand. */
  override _read(): void {
    /* The body was buffered in the constructor. */
  }
}

/**
 * One response as the handler sees it: an HTTP-shaped write surface that
 * turns `setHeader`/`flushHeaders`/`write`/`end` into gateway frames. A
 * handler that only calls `end` answers in one buffered `res` frame; a handler
 * that writes or flushes first opens a stream the peer reads as `chunk` frames.
 */
export class GatewayResponse extends EventEmitter {
  /** Status line the peer will read. */
  statusCode = 200
  /** True once the `res` frame left this response. */
  headersSent = false
  /** True once `end` ran. */
  writableEnded = false
  /** True once the response finished or was destroyed; later writes drop. */
  destroyed = false

  /** Header fields waiting for the first frame. */
  readonly #headers = new Map<string, string>()
  /** Body bytes accumulated while the response is still buffered. */
  readonly #buffered: Buffer[] = []
  /** The connection this response answers on. */
  readonly #socket: Socket
  /** Correlates every frame with the peer's request. */
  readonly #id: number
  /** Timer refusing a handler that never produces a header. */
  #timer: NodeJS.Timeout | undefined
  /** True once the response switched to stream mode. */
  #streaming = false
  /** True while a socket `drain` listener is armed. */
  #drainArmed = false

  /**
   * @param socket - connection to write frames on.
   * @param id - request id this response answers.
   */
  constructor(socket: Socket, id: number) {
    super()
    this.#socket = socket
    this.#id = id
  }

  /**
   * Arm the refusal clock for this request.
   * @param timer - fires when no header reached the wire in time.
   */
  attachTimeout(timer: NodeJS.Timeout): void {
    this.#timer = timer
    timer.unref()
  }

  /**
   * Set one response header.
   * @param name - header field name.
   * @param value - header field value.
   * @throws Error once the header block has been sent.
   */
  setHeader(name: string, value: string | number | readonly string[]): void {
    if (this.headersSent) throw new Error('cannot set headers after they are sent')
    this.#headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
  }

  /**
   * Read a response header set earlier.
   * @param name - header field name.
   * @returns the value, or undefined when never set.
   */
  getHeader(name: string): string | undefined {
    return this.#headers.get(name.toLowerCase())
  }

  /**
   * Send the header block without a body: this opens stream mode, because a
   * peer waiting on `flushHeaders` must learn the status before any body byte.
   */
  flushHeaders(): void {
    if (this.headersSent || this.destroyed) return
    this.#streaming = true
    this.headersSent = true
    this.#clearTimer()
    this.#send({ t: 'res', id: this.#id, status: this.statusCode, headers: this.#headerRecord(), stream: true })
    this.emit('header')
  }

  /**
   * Write one body piece.
   * @param chunk - bytes to append.
   * @returns false when the peer should back off until `drain`.
   */
  write(chunk: unknown): boolean {
    if (this.destroyed || this.writableEnded) return false
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), 'utf8')
    if (!this.#streaming) this.flushHeaders()
    if (bytes.length > MAX_RESPONSE_BYTES) {
      this.destroy(new GatewayPayloadTooLargeError(`a stream chunk of ${String(bytes.length)} bytes passes the ${String(MAX_RESPONSE_BYTES)} byte response cap`))
      return false
    }
    const backedUp = !this.#send({ t: 'chunk', id: this.#id }, bytes)
    if (backedUp && !this.#drainArmed) {
      this.#drainArmed = true
      this.#socket.once('drain', () => {
        this.#drainArmed = false
        if (!this.destroyed) this.emit('drain')
      })
    }
    return !backedUp && !this.#drainArmed
  }

  /**
   * End the response, flushing whatever is buffered.
   * @param chunk - optional final body piece.
   */
  end(chunk?: unknown): void {
    if (this.destroyed || this.writableEnded) return
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      const bytes = typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), 'utf8')
      // A handler that only ends keeps its one buffered frame; a handler that
      // already writes has opened the stream and the tail is one more chunk.
      if (this.#streaming) this.write(bytes)
      else this.#buffered.push(bytes)
    }
    if (this.destroyed) return
    if (this.#streaming) {
      this.writableEnded = true
      this.#clearTimer()
      this.#send({ t: 'end', id: this.#id })
      this.#finish()
      return
    }
    const body = Buffer.concat(this.#buffered)
    if (body.length > MAX_RESPONSE_BYTES) {
      // Checked before the response is committed: the refusal still reaches
      // the peer as an `error` frame instead of a silently missing answer.
      this.destroy(new GatewayPayloadTooLargeError(`a response of ${String(body.length)} bytes passes the ${String(MAX_RESPONSE_BYTES)} byte response cap`))
      return
    }
    this.writableEnded = true
    this.#clearTimer()
    this.headersSent = true
    this.#send({ t: 'res', id: this.#id, status: this.statusCode, headers: this.#headerRecord() }, body)
    this.#finish()
  }

  /**
   * Finish or abort the response. An unfinished response reports its failure
   * to the peer with an explicit `error` frame; a finished one just stops
   * accepting writes.
   * @param error - why the response is dying, when it is dying early.
   */
  destroy(error?: unknown): void {
    if (this.destroyed) return
    this.#clearTimer()
    if (!this.writableEnded) {
      const failure = error instanceof GatewayError
        ? error
        : new GatewayClosedError(error === undefined ? 'response destroyed' : String(error))
      this.#send({ t: 'error', id: this.#id, code: failure.code, message: failure.message })
      this.destroyed = true
      this.emit('close')
      if (this.listenerCount('error') > 0) this.emit('error', failure)
      return
    }
    this.#finish()
  }

  /** Mark the response complete and announce it once. */
  #finish(): void {
    this.destroyed = true
    this.emit('finish')
    this.emit('close')
  }

  /** Snapshot of the pending header fields. */
  #headerRecord(): Record<string, string> {
    return Object.fromEntries(this.#headers)
  }

  /**
   * Write one frame on the connection.
   * @param message - envelope to send.
   * @param body - optional raw payload.
   * @returns false when the socket buffers the frame.
   */
  #send(message: GatewayMessage, body?: Buffer): boolean {
    if (this.#socket.destroyed || this.#socket.writableEnded) return false
    return this.#socket.write(encodeFrame(message, body))
  }

  /** Drop the pending timeout once a header is on the wire. */
  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}

/** The handler a gateway serves: HTTP-shaped request in, HTTP-shaped response out. */
export type GatewayHandler = (req: GatewayRequest, res: GatewayResponse) => void | Promise<void>

/** Options accepted by {@link startPipeGateway}. */
export interface StartPipeGatewayOptions extends GatewayCoordinateOptions {
  /** Handler every authenticated request is passed to. */
  handler: GatewayHandler
  /** Logger; defaults to a silent one so the package never prints on its own. */
  log?: GatewayLogger | undefined
  /** Default per-request budget in milliseconds; a request may ask for its own. */
  timeoutMs?: number | undefined
  /** How long a half-closed peer still receives answers, in milliseconds. */
  halfCloseToleranceMs?: number | undefined
}

/** A mounted gateway. */
export interface PipeGateway {
  /** Endpoint path the peer connects to. */
  readonly path: string
  /** Close the listener, drain in-flight answers, and release the lock. */
  close(): Promise<void>
}

/** Per-connection state the server keeps. */
interface ConnectionState {
  /** False until `hello` matched the local digest. */
  handshaken: boolean
  /** Timer refusing a peer that never says hello. */
  handshakeTimer: NodeJS.Timeout | undefined
  /** Responses still waiting for their first header. */
  pending: Map<number, GatewayResponse>
  /** True once the peer sent its FIN. */
  peerEnded: boolean
  /** Half-close tolerance timer armed when the peer went away first. */
  halfCloseTimer: NodeJS.Timeout | undefined
}

/** Lock file contents: who currently owns the endpoint. */
interface LockHolder {
  /** Pid of the mounting process. */
  pid: number
  /** When the lock was taken, for a reader diagnosing a stale file. */
  startedAt?: number
}

/**
 * Probe whether a pid still exists; a foreign pid we may not signal counts as alive.
 * @param pid - process to probe.
 * @returns true when the process is there.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take the single-instance lock, stealing it from a dead holder.
 * @param lockPath - lock file to create.
 * @throws GatewayAlreadyRunningError when a live process already owns it.
 */
function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true })
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockHolder)}\n`, { flag: 'wx' })
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = readHolder(lockPath)
      if (holder !== undefined && isAlive(holder.pid)) {
        throw new GatewayAlreadyRunningError(`gateway already mounted by pid ${String(holder.pid)} (${lockPath})`)
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new GatewayAlreadyRunningError(`gateway lock at ${lockPath} could not be claimed`)
}

/**
 * Read the lock file's owner.
 * @param lockPath - lock file to read.
 * @returns the holder, or undefined when the file is gone or unreadable.
 */
function readHolder(lockPath: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockHolder>
    return typeof parsed.pid === 'number' ? { pid: parsed.pid } : undefined
  } catch {
    return undefined
  }
}

/**
 * Release the lock, leaving a successor's file alone.
 * @param lockPath - lock file to drop.
 */
function releaseLock(lockPath: string): void {
  if (readHolder(lockPath)?.pid === process.pid) rmSync(lockPath, { force: true })
}

/**
 * Mount the pipe gateway.
 * @param options - handler, coordinates, budgets, and logger.
 * @returns the live gateway handle.
 * @throws GatewayAlreadyRunningError when another live process holds the endpoint.
 */
export async function startPipeGateway(options: StartPipeGatewayOptions): Promise<PipeGateway> {
  const coords = gatewayCoordinates(options)
  const log = options.log ?? { info: () => {}, warn: () => {}, error: () => {} }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const halfCloseToleranceMs = options.halfCloseToleranceMs ?? HALF_CLOSE_TOLERANCE_MS
  acquireLock(coords.lockPath)

  const sockets = new Set<Socket>()
  let awaitingTotal = 0

  /**
   * Send a frame unless the socket already went away.
   * @param socket - connection to write on.
   * @param message - envelope to send.
   * @param body - optional raw payload.
   */
  const send = (socket: Socket, message: GatewayMessage, body?: Buffer): void => {
    if (socket.destroyed || socket.writableEnded) return
    socket.write(encodeFrame(message, body))
  }

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    const state: ConnectionState = {
      handshaken: false,
      handshakeTimer: undefined,
      pending: new Map(),
      peerEnded: false,
      halfCloseTimer: undefined,
    }
    state.handshakeTimer = setTimeout(() => {
      log.warn(`ipc-pipe: ${coords.path} dropped a connection that never sent a handshake`)
      socket.destroy()
    }, timeoutMs)
    state.handshakeTimer.unref()
    const reader = new FrameReader()

    /** Drop per-connection bookkeeping exactly once. */
    const cleanup = (): void => {
      sockets.delete(socket)
      if (state.handshakeTimer !== undefined) clearTimeout(state.handshakeTimer)
      if (state.halfCloseTimer !== undefined) clearTimeout(state.halfCloseTimer)
      for (const response of state.pending.values()) {
        response.destroy(new GatewayClosedError('connection closed before the response header'))
      }
      state.pending.clear()
    }

    /**
     * Refuse the connection with an explicit error frame, then close it.
     * @param failure - typed refusal to report.
     */
    const refuse = (failure: GatewayError): void => {
      send(socket, { t: 'error', code: failure.code, message: failure.message })
      socket.end()
    }

    socket.on('data', (chunk: Buffer) => {
      if (socket.writableEnded) return
      let frames
      try {
        frames = reader.push(chunk)
      } catch (error: unknown) {
        const failure = error instanceof GatewayError ? error : new GatewayProtocolError(String(error))
        log.warn(`ipc-pipe: ${coords.path} refused a frame: ${failure.message}`)
        refuse(failure)
        return
      }
      for (const frame of frames) {
        const message = frame.message
        if (!state.handshaken) {
          if (message.t !== 'hello') {
            log.warn(`ipc-pipe: ${coords.path} refused a connection that spoke "${message.t}" before the handshake`)
            refuse(new GatewayProtocolError('first message must be hello'))
            return
          }
          if (message.v !== PROTOCOL_VERSION || !digestMatches(coords.digest, message.digest)) {
            log.warn(`ipc-pipe: ${coords.path} refused a connection with a mismatched key digest`)
            refuse(new GatewayAuthError('handshake digest does not match this gateway key'))
            return
          }
          state.handshaken = true
          if (state.handshakeTimer !== undefined) {
            clearTimeout(state.handshakeTimer)
            state.handshakeTimer = undefined
          }
          send(socket, { t: 'welcome', v: PROTOCOL_VERSION })
          continue
        }

        if (message.t === 'ping') {
          send(socket, { t: 'pong', id: message.id })
          continue
        }
        if (message.t === 'bye') {
          socket.end()
          continue
        }
        if (message.t === 'abort') {
          // A reader that went away releases its producer: the response ends,
          // and the handler's own `close` listener detaches it.
          state.pending.get(message.id)?.destroy()
          continue
        }
        if (message.t !== 'req') {
          refuse(new GatewayProtocolError(`unexpected "${message.t}" message from a client`))
          return
        }

        const budget = Math.min(Math.max(message.timeoutMs ?? timeoutMs, 100), 60_000)
        const response = new GatewayResponse(socket, message.id)
        const timer = setTimeout(() => {
          if (!state.pending.has(message.id)) return
          log.warn(`ipc-pipe: request ${message.method} ${message.url} exceeded ${String(budget)}ms on ${coords.path}`)
          response.destroy(new GatewayTimeoutError(`request exceeded ${String(budget)}ms`))
        }, budget)
        response.attachTimeout(timer)
        state.pending.set(message.id, response)
        awaitingTotal += 1
        let awaiting = true
        // A header or a close ends this request's claim on the close grace:
        // an open stream never blocks shutdown, an answer still cooking does.
        const stopAwaiting = (): void => {
          if (!awaiting) return
          awaiting = false
          awaitingTotal -= 1
        }
        response.once('header', stopAwaiting)
        response.once('close', () => {
          stopAwaiting()
          state.pending.delete(message.id)
          if (state.peerEnded && state.pending.size === 0) socket.end()
        })
        const request = new GatewayRequest({
          method: message.method,
          url: message.url,
          headers: message.headers,
          stream: message.stream,
          body: frame.body,
        })
        void Promise.resolve()
          .then(() => options.handler(request, response))
          .catch((error: unknown) => {
            response.destroy(error instanceof GatewayError ? error : new GatewayProtocolError(`handler failed: ${String(error)}`))
          })
      }
    })

    socket.on('end', () => {
      state.peerEnded = true
      if (state.pending.size === 0) {
        socket.end()
        return
      }
      // The peer stopped sending but still reads: an answer computed later
      // must land. Only an answer that never comes loses the connection, and
      // only after the tolerance window.
      state.halfCloseTimer = setTimeout(() => {
        log.warn(`ipc-pipe: ${coords.path} dropped a half-closed connection after ${String(halfCloseToleranceMs)}ms with ${String(state.pending.size)} answer(s) outstanding`)
        send(socket, {
          t: 'error',
          code: 'CLOSED',
          message: `half-closed connection dropped after ${String(halfCloseToleranceMs)}ms with ${String(state.pending.size)} answer(s) outstanding`,
        })
        socket.end()
      }, halfCloseToleranceMs)
      state.halfCloseTimer.unref()
    })
    socket.on('error', (error: Error) => {
      log.warn(`ipc-pipe: connection error on ${coords.path}: ${error.message}`)
    })
    socket.on('close', cleanup)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    // A stale socket file from a crashed run would refuse a fresh mount; the
    // lock already proved no live holder remains, so the path is ours to take.
    if (process.platform !== 'win32') rmSync(coords.path, { force: true })
    server.listen(coords.path)
  }).catch((error: unknown) => {
    releaseLock(coords.lockPath)
    throw error
  })

  log.info(`ipc-pipe: gateway listening on ${coords.path}`)
  let closing: Promise<void> | undefined

  return {
    path: coords.path,
    close(): Promise<void> {
      closing ??= (async () => {
        // Stop accepting first; live connections may still be answering.
        const stopped = new Promise<void>((resolve) => {
          server.close(() => { resolve() })
        })
        const deadline = Date.now() + 1000
        while (awaitingTotal > 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
        }
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        await stopped
        releaseLock(coords.lockPath)
        if (process.platform !== 'win32') rmSync(coords.path, { force: true })
        log.info(`ipc-pipe: gateway closed on ${coords.path}`)
      })()
      return closing
    },
  }
}
