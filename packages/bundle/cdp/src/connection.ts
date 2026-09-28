/**
 * @deepseek-ai/dsh-cdp — the raw Chrome DevTools Protocol connection. It owns
 * one `ws` client socket to a single browser endpoint, correlates every `send`
 * with the reply id the endpoint echoes back, fans protocol events out to
 * listeners that may be scoped to one `sessionId`, and re-opens the socket on
 * `reconnect()`. No Puppeteer or Playwright sits between the caller and the
 * protocol.
 * @module @deepseek-ai/dsh-cdp/connection
 */

import WebSocket from 'ws'

/**
 * Lifecycle event emitted after every successful socket open, including the
 * first. Session state does not survive a reconnect, so a session registry
 * subscribes once and re-attaches its sessions each time this fires.
 */
export const CDP_CONNECTED_EVENT = 'cdp.connected'

/**
 * Lifecycle event emitted after the socket closes for any reason, including a
 * failed open. `params` carries the `ws` close `code` and `reason`, so a caller
 * can distinguish a caller-initiated close from an unexpected drop.
 */
export const CDP_DISCONNECTED_EVENT = 'cdp.disconnected'

/**
 * Error code reported when an endpoint's error reply omits a numeric `code`.
 * Chrome sends `-32000` for server errors, so an absent code is reported the
 * same way instead of inventing a success-like zero.
 */
const UNKNOWN_PROTOCOL_CODE = -32000

/** WebSocket close code sent when a frame cannot be read as CDP. */
const PROTOCOL_VIOLATION_CLOSE_CODE = 1002

/** Milliseconds a send waits for its reply when neither the caller nor the options set one. */
const DEFAULT_SEND_TIMEOUT_MS = 30_000

/**
 * One protocol event or connection lifecycle notification delivered to an
 * `on()` listener.
 */
export interface CdpEvent {
  /** Event name: a CDP method such as `Page.loadEventFired`, or a lifecycle constant. */
  readonly method: string
  /** Event parameters exactly as the endpoint sent them, or `{}` for lifecycle events. */
  readonly params: Readonly<Record<string, unknown>>
  /** Session the event belongs to; `undefined` for browser-level and lifecycle events. */
  readonly sessionId: string | undefined
}

/**
 * Receives every event published under the name it subscribed to.
 * @param event - the delivered event.
 */
export type CdpEventListener = (event: CdpEvent) => void

/** Construction options for {@link CdpConnection}. */
export interface CdpConnectionOptions {
  /** Milliseconds a send waits for its reply when the send call passes none. */
  readonly timeoutMs?: number
}

/** A protocol error reply, carrying the endpoint's own code and the send that produced it. */
export class CdpError extends Error {
  /** Error code from the endpoint's `error.code`. */
  readonly code: number
  /** Method of the send that produced this error. */
  readonly method: string
  /** Session the failing send was bound to, when it was session-scoped. */
  readonly sessionId: string | undefined
  /** Optional `error.data` the endpoint attached; `undefined` when it sent none. */
  readonly data: unknown

  /**
   * @param code - error code from the endpoint's error reply.
   * @param message - error message from the endpoint's error reply.
   * @param method - method of the send that produced this error.
   * @param sessionId - session the failing send was bound to, when session-scoped.
   * @param data - optional `error.data` the endpoint attached.
   */
  constructor(code: number, message: string, method: string, sessionId: string | undefined, data: unknown) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.method = method
    this.sessionId = sessionId
    this.data = data
  }
}

/** A send whose reply did not arrive within its timeout. */
export class CdpTimeoutError extends Error {
  /** Method of the send that timed out. */
  readonly method: string
  /** Milliseconds the send waited before rejecting. */
  readonly timeoutMs: number

  /**
   * @param method - method of the send that timed out.
   * @param timeoutMs - milliseconds the send waited before rejecting.
   */
  constructor(method: string, timeoutMs: number) {
    super(`CDP ${method} received no reply within ${timeoutMs}ms`)
    this.name = 'CdpTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

/**
 * A send rejected because the socket is not open. {@link CdpConnection.close}
 * also rejects every send left in flight with this error, so a closing
 * connection never leaves a caller waiting.
 */
export class CdpConnectionClosedError extends Error {
  /** Method of the rejected send. */
  readonly method: string

  /**
   * @param method - method of the rejected send.
   * @param reason - what closed or withheld the socket.
   */
  constructor(method: string, reason: string) {
    super(`Cannot send ${method}: ${reason}`)
    this.name = 'CdpConnectionClosedError'
    this.method = method
  }
}

/** One in-flight send awaiting its reply. */
interface PendingSend {
  readonly method: string
  readonly sessionId: string | undefined
  readonly timeout: NodeJS.Timeout
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
}

/** One listener registration, optionally scoped to a single session. */
interface EventRegistration {
  readonly listener: CdpEventListener
  readonly sessionId: string | undefined
}

/**
 * Connection state owned by {@link CdpConnection}. Exposed read-only through
 * {@link CdpConnection.state} so a status surface can report the socket's own
 * truth without probing it again.
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed'

/**
 * A raw CDP connection over one `ws` endpoint.
 *
 * Frame handling is explicit:
 * - A frame that is not valid JSON text, a JSON value that is not an object, or
 *   a binary frame is ignored; the socket stays open, because a stray payload is
 *   not evidence that the endpoint stopped speaking CDP.
 * - A reply whose `id` matches an in-flight send settles that send. An error
 *   object rejects only that send with {@link CdpError}; the connection stays
 *   open.
 * - A reply whose `id` matches no in-flight send is ignored, since it is most
 *   often a reply that arrived after its own send timed out.
 * - A frame without `id` whose `method` is a string is a protocol event.
 * - A frame without `id` that carries `result` or `error` is a reply that cannot
 *   be correlated. It is a protocol violation: the socket closes with WebSocket
 *   code `1002` and every in-flight send rejects with
 *   {@link CdpConnectionClosedError}.
 *
 * `close()` rejects every in-flight send with {@link CdpConnectionClosedError}
 * rather than resolving it, so a settled send always carries an endpoint
 * outcome. `close()` is not terminal: `connect()` and `reconnect()` may open the
 * socket again.
 */
export class CdpConnection {
  private readonly url: string
  private readonly defaultTimeoutMs: number
  private readonly pending = new Map<number, PendingSend>()
  private readonly listeners = new Map<string, Set<EventRegistration>>()
  private socket: WebSocket | undefined
  private connectPromise: Promise<void> | undefined
  private nextId = 1
  private stateValue: ConnectionState = 'idle'

  /**
   * @param url - `ws://` or `wss://` URL of one browser debugging endpoint.
   * @param options - send-timeout default; a send's own timeout overrides it.
   */
  constructor(url: string, options: CdpConnectionOptions = {}) {
    this.url = url
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  }

  /** The endpoint URL this connection targets. */
  get endpoint(): string {
    return this.url
  }

  /**
   * The socket's own lifecycle state: `idle` before the first connect,
   * `connecting` while one is in flight, `open` when sends are accepted, and
   * `closed` after a close or a dropped socket. This is a live read of the
   * state machine, not a cached snapshot.
   */
  get state(): ConnectionState {
    return this.stateValue
  }

  /** Whether the socket is currently open and able to carry a send. */
  get connected(): boolean {
    return this.stateValue === 'open'
  }

  /**
   * Open the socket if it is not already open. A second call while a connect is
   * in flight waits on that same attempt.
   * @returns a promise that resolves once the socket accepts sends and
   * {@link CDP_CONNECTED_EVENT} has fired, and rejects when it fails to open.
   */
  connect(): Promise<void> {
    if (this.stateValue === 'open') return Promise.resolve()
    const inFlight = this.connectPromise
    if (this.stateValue === 'connecting' && inFlight !== undefined) return inFlight
    const attempt = this.establish()
    this.connectPromise = attempt
    return attempt
  }

  /**
   * Close the current socket, settling every in-flight send, then open a new
   * socket and fire {@link CDP_CONNECTED_EVENT} again.
   * @returns a promise that resolves once the replacement socket accepts sends.
   */
  async reconnect(): Promise<void> {
    const socket = this.socket
    if (socket !== undefined) await this.teardown(socket, 'the connection is reconnecting')
    await this.connect()
  }

  /**
   * Close the socket and reject every send still awaiting a reply. Resolves once
   * the socket has actually closed, so the caller can rely on no listener or
   * timer from this connection firing afterwards. Idempotent.
   * @returns a promise that resolves when teardown reaches quiescence.
   */
  async close(): Promise<void> {
    const socket = this.socket
    if (socket === undefined) {
      this.stateValue = 'closed'
      this.rejectPending('the connection is closed')
      return
    }
    await this.teardown(socket, 'the connection is closed')
  }

  /**
   * Subscribe to one CDP event name or lifecycle constant.
   * @param event - CDP method name, or {@link CDP_CONNECTED_EVENT} / {@link CDP_DISCONNECTED_EVENT}.
   * @param listener - receives every matching event.
   * @param sessionId - when given, only events whose `sessionId` equals this value are delivered.
   * @returns a disposer that removes exactly this registration.
   */
  on(event: string, listener: CdpEventListener, sessionId?: string): () => void {
    let registrations = this.listeners.get(event)
    if (registrations === undefined) {
      registrations = new Set()
      this.listeners.set(event, registrations)
    }
    const registration: EventRegistration = { listener, sessionId }
    registrations.add(registration)
    return () => {
      registrations.delete(registration)
      if (registrations.size === 0) this.listeners.delete(event)
    }
  }

  /**
   * Send one CDP command and await its reply.
   * @param method - CDP method name, for example `Page.navigate`.
   * @param params - method parameters; `{}` when the method takes none.
   * @param sessionId - target session for a session-scoped command; omitted for browser-level commands.
   * @param timeoutMs - milliseconds to wait for the reply; overrides the connection default.
   * @returns the reply's `result`.
   * @throws CdpError when the endpoint answers with an error reply.
   * @throws CdpTimeoutError when no reply arrives within the timeout.
   * @throws CdpConnectionClosedError when the socket is not open or closes first.
   */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket
    if (this.stateValue !== 'open' || socket === undefined) {
      return Promise.reject(new CdpConnectionClosedError(method, 'the socket is not open'))
    }
    const id = this.nextId
    this.nextId += 1
    const timeout = timeoutMs ?? this.defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeoutError(method, timeout))
      }, timeout)
      timer.unref()
      this.pending.set(id, { method, sessionId, timeout: timer, resolve, reject })
      const frame: { id: number; method: string; params: Record<string, unknown>; sessionId?: string } = {
        id,
        method,
        params,
      }
      if (sessionId !== undefined) frame.sessionId = sessionId
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Open the socket and resolve once it is open. */
  private async establish(): Promise<void> {
    this.stateValue = 'connecting'
    const socket = this.createSocket()
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('close', onCloseBeforeOpen)
        socket.off('error', onError)
        this.stateValue = 'open'
        this.dispatch(CDP_CONNECTED_EVENT, {}, undefined)
        resolve()
      }
      const onError = (error: Error): void => {
        socket.off('close', onCloseBeforeOpen)
        socket.off('open', onOpen)
        reject(error)
      }
      const onCloseBeforeOpen = (): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        reject(new Error(`CDP socket ${this.url} closed before it opened`))
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onCloseBeforeOpen)
    })
  }

  /** Create a socket with its persistent handlers attached. */
  private createSocket(): WebSocket {
    const socket = new WebSocket(this.url)
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.handleMessage(socket, data, isBinary)
    })
    socket.on('close', (code: number, reason: Buffer) => {
      this.handleClose(socket, code, reason)
    })
    // ws emits `error` and then `close` for every failure. This listener only
    // prevents an unhandled `error` from crashing the process; `establish()`
    // and `handleClose()` own the outcome the caller sees.
    socket.on('error', () => {})
    return socket
  }

  /** Close one socket and wait for its `close` event. */
  private async teardown(socket: WebSocket, reason: string): Promise<void> {
    this.rejectPending(reason)
    if (socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
      socket.close(1000, 'closed by caller')
    })
  }

  /** Settle every in-flight send by rejecting it. */
  private rejectPending(reason: string): void {
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    for (const entry of inFlight) {
      clearTimeout(entry.timeout)
      entry.reject(new CdpConnectionClosedError(entry.method, reason))
    }
  }

  /** Route one received frame: replies settle sends, events reach listeners, malformed frames follow the class policy. */
  private handleMessage(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    if (this.socket !== socket || isBinary) return
    const frame = parseJsonFrame(decodeText(data))
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return
    const record = frame as Record<string, unknown>
    const id = record['id']
    if (typeof id === 'number') {
      this.settleReply(id, record)
      return
    }
    const method = record['method']
    if (typeof method === 'string') {
      this.dispatch(method, asParams(record['params']), asSessionId(record['sessionId']))
      return
    }
    if ('result' in record || 'error' in record) {
      this.failForProtocolViolation(socket)
    }
  }

  /** Settle the in-flight send whose id the reply echoed. */
  private settleReply(id: number, record: Record<string, unknown>): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timeout)
    const error = record['error']
    if (error !== undefined) {
      entry.reject(toCdpError(error, entry))
      return
    }
    entry.resolve(record['result'])
  }

  /** Close a socket whose frame could not be read as CDP. */
  private failForProtocolViolation(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.rejectPending('a CDP reply arrived without an id')
    socket.close(PROTOCOL_VIOLATION_CLOSE_CODE, 'CDP reply without id')
  }

  /** Mark this socket closed, settle its sends, and publish the disconnect. */
  private handleClose(socket: WebSocket, code: number, reason: Buffer): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.stateValue = 'closed'
    this.rejectPending(`the endpoint socket closed (code ${code})`)
    this.dispatch(CDP_DISCONNECTED_EVENT, { code, reason: reason.toString('utf8') }, undefined)
  }

  /** Deliver one event to its listeners, skipping listeners scoped to another session. */
  private dispatch(method: string, params: Readonly<Record<string, unknown>>, sessionId: string | undefined): void {
    const registrations = this.listeners.get(method)
    if (registrations === undefined) return
    const event: CdpEvent = { method, params, sessionId }
    for (const registration of [...registrations]) {
      if (registration.sessionId !== undefined && registration.sessionId !== sessionId) continue
      try {
        registration.listener(event)
      } catch (error) {
        // One listener that throws must not starve the listeners after it or
        // reject the message handler it runs inside.
        console.error(`[cdp] ${method} listener threw`, error)
      }
    }
  }
}

/**
 * Decode a `ws` payload to UTF-8 text. CDP is JSON text.
 * @param data - the payload frame.
 * @returns the frame's text.
 */
function decodeText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

/**
 * Parse one frame as JSON.
 * @param text - raw frame text.
 * @returns the parsed value, or `undefined` when the frame is not JSON.
 */
function parseJsonFrame(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A non-JSON frame is not CDP; the class policy ignores it and keeps the socket open.
    return undefined
  }
}

/**
 * Read an event's parameters.
 * @param value - the frame's `params` field.
 * @returns the object parameters, or `{}` when the endpoint sent none or sent a non-object.
 */
function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Read a frame's session id.
 * @param value - the frame's `sessionId` field.
 * @returns the session id, or `undefined` for a browser-level frame.
 */
function asSessionId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Convert an error reply body into the typed protocol error.
 * @param source - the frame's `error` field.
 * @param entry - the in-flight send the reply settles.
 * @returns the error to reject that send with.
 */
function toCdpError(source: unknown, entry: PendingSend): CdpError {
  const record = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {}
  const code = typeof record['code'] === 'number' ? record['code'] : UNKNOWN_PROTOCOL_CODE
  const message = typeof record['message'] === 'string'
    ? record['message']
    : 'CDP error reply carried no message'
  return new CdpError(code, message, entry.method, entry.sessionId, record['data'])
}
