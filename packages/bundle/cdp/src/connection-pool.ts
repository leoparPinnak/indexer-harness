/**
 * @deepseek-ai/dsh-cdp — plan04: the endpoint connection pool, loopback
 * endpoint discovery, and the automatic reattachment driver.
 *
 * One `CdpConnection` used to be the whole world: every `connect()` dropped
 * the previous socket and every session bound to it. This module keeps every
 * attached browser reachable at once — a `Map` of pooled endpoints keyed by
 * their WebSocket URL — and arms the `CDP_CONNECTED_EVENT` /
 * `CDP_DISCONNECTED_EVENT` subscriber `connection.ts` documents but never had:
 * a socket drop degrades the entry, an exponential-backoff `reconnect()`
 * re-dials it, and the owner's `onReconnected` hook rebuilds the target
 * registry and page sessions on the new socket generation.
 *
 * The pool stores parked entries only: while an endpoint is ACTIVE its live
 * state (registry, sessions, focus subscription, launched browser) sits in
 * `CdpService`'s own fields, and `park`/`activate` swap it in and out.
 *
 * @module @deepseek-ai/dsh-cdp/connection-pool
 */

import { CDP_CONNECTED_EVENT, CDP_DISCONNECTED_EVENT, type CdpConnection, type CdpEvent } from './connection.ts'
import type { LaunchedBrowser } from './launch.ts'
import type { PageSession } from './page.ts'
import type { TargetRegistry } from './targets.ts'

/** First reconnection attempt delay, in milliseconds. */
export const RETRY_BASE_MS = 250

/** Upper bound for one reconnection delay, in milliseconds. */
export const RETRY_MAX_MS = 4_000

/** How many reconnect attempts an endpoint gets before it is marked closed. */
export const MAX_RETRY_ATTEMPTS = 5

/** Default number of endpoints one pool holds; beyond it attach refuses. */
export const DEFAULT_MAX_POOL_ENTRIES = 32

/** Loopback debug ports `cdp_endpoints` probes when the config lists none. */
export const DEFAULT_DISCOVERY_PORTS: readonly number[] = [9222, 9225, 9333, 9444]

/** Default per-port `/json/version` probe timeout, in milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 500

/**
 * plan04: lifecycle state of one pooled endpoint.
 * `connected` — socket open and registry live.
 * `degraded` — socket dropped; a retry is scheduled or exhausted-to-retry.
 * `reattaching` — a reconnect or registry rebuild is in flight.
 * `closed` — terminal: retries exhausted or intentionally detached.
 */
export type PooledState = 'connected' | 'degraded' | 'reattaching' | 'closed'

/**
 * plan04: one attached browser endpoint. While the endpoint is ACTIVE the
 * `registry`/`sessions`/`targetActivatedOff`/`launched` mirrors in
 * {@link ConnectionPool} may lag behind `CdpService`'s live fields; `park`
 * writes them into the record and `activate` reads them back.
 */
export interface PooledEndpoint {
  /** Stable display id (`ep-<port>` or `ep-<browserId prefix>`). */
  readonly connectionId: string
  /** Normalized WebSocket debugger URL this entry is keyed by. */
  readonly endpoint: string
  /** GUID carved from the ws URL path (`devtools/browser/<id>`); `''` when absent. */
  readonly browserId: string
  /** Loopback port parsed from the URL; `undefined` when the URL carries none. */
  readonly port: number | undefined
  /** The live connection object; never swapped — stale entries are detached and re-dialed. */
  readonly connection: CdpConnection
  /** Parked target registry; the service field mirrors it while active. */
  registry: TargetRegistry | undefined
  /** Parked page sessions keyed by flattened session id; stale ids are dropped on reconnect. */
  sessions: Map<string, PageSession>
  /** Parked `Target.targetActivated` focus-sync disposer (plan03). */
  targetActivatedOff: (() => void) | undefined
  /** Parked browser process launched for this endpoint, if any. */
  launched: LaunchedBrowser | undefined
  /* plan13-profile: the user-data directory this endpoint's browser runs on,
     and the identity derived from it (`assistant` for a named profile,
     `dsh-cdp-XXXXXX` for a throwaway one, `external` for a browser DSH did
     not launch). `undefined` until the owner records it; the inventory then
     reports an unknown profile instead of inventing one. */
  profileName: string | undefined
  /**
   * The absolute user-data directory this endpoint's browser runs on, when DSH
   * launched it. Kept next to {@link profileName} because the lock check
   * compares DIRECTORIES, not display names: two endpoints can both report the
   * identity `assistant` only if they are genuinely the same one.
   */
  userDataDir: string | undefined
  /** Whether DSH launched this browser (`true`) or attached to a foreign one. */
  launchedByService: boolean
  /** Target id to restore after a reconnect, captured while parked. */
  activeTargetId: string | undefined
  /** Current lifecycle state (see {@link PooledState}). */
  state: PooledState
  /** Successful reconnects observed on this connection. */
  reconnects: number
  /** Last failure text (close code or reconnect error); `''`-equivalent `undefined` when healthy. */
  lastError: string | undefined
  /** Disposers for the pool's own lifecycle listeners. */
  lifecycleOff: Array<() => void>
  /** Pending backoff timer, if one is armed. */
  retryTimer: NodeJS.Timeout | undefined
  /** Backoff steps already consumed (reset on a successful reconnect). */
  retryAttempt: number
  /** True while this entry's own `reconnect()` call is executing. */
  reconnectInFlight: boolean
  /** True once the entry was detached/stopped; suppresses retries and state writes. */
  stopped: boolean
}

/** One `/api/server/cdp/endpoints` row — every field always present. */
export interface CdpEndpointRow {
  /** Loopback port the row reports. */
  port: number
  /** Whether `/json/version` answered on that port. */
  reachable: boolean
  /** Whether this endpoint is in the pool with a live socket. */
  attached: boolean
  /** Whether this endpoint is the service's ACTIVE connection. */
  active: boolean
  /** `unreachable` | `unattached` | `connected` | `degraded` | `reattaching` | `closed`. */
  state: string
  /** WebSocket debugger URL; `''` when unreachable. */
  endpoint: string
  /** `/json/version` `Browser` value; `''` when unknown. */
  browser: string
  /** GUID carved from the ws URL; `''` when unknown. */
  browserId: string
  /**
   * plan13-profile: the browser's profile identity — the user-data directory's
   * last segment (`assistant`, `dsh-cdp-XXXXXX`), `external` for a browser DSH
   * attached to but did not launch, and `''` when no directory is known (a
   * probed-but-unattached port exposes no profile through `/json/version`).
   */
  profile: string
  /**
   * plan13-profile: `dsh` when this browser was launched by DSH (its profile
   * directory is known and the identity above is trustworthy), `user` when it
   * is somebody else's browser DSH merely reached.
   */
  kind: 'user' | 'dsh'
  /** Pool connection id; `''` when not attached. */
  connectionId: string
  /** Live tracked target count; `0` when unknown or detached. */
  targets: number
  /** Free-form failure note; `''` when none. */
  error: string
}

/** plan04: hooks the owner (CdpService) supplies to the pool's reattach driver. */
export interface PoolHooks {
  /**
   * Rebuild registry/sessions/subscriptions after `entry.connection` re-opened
   * its socket. Rejections are recorded on `entry.lastError`, never thrown.
   */
  readonly onReconnected: (entry: PooledEndpoint) => Promise<void>
}

/** Construction options for {@link ConnectionPool}. */
export interface ConnectionPoolOptions {
  /** Entry cap; default {@link DEFAULT_MAX_POOL_ENTRIES}. */
  readonly maxEntries?: number
  /** Owner callbacks. */
  readonly hooks: PoolHooks
}

/** Thrown when a new attach would exceed the pool cap with nothing evictable. */
export class CdpPoolFullError extends Error {
  /** Entries currently held. */
  readonly size: number
  /** Configured cap. */
  readonly max: number

  /**
   * @param size - entries currently held.
   * @param max - configured cap.
   */
  constructor(size: number, max: number) {
    super(`cdp: connection pool is full (${String(size)}/${String(max)}); detach an endpoint first (cdp_open reuse or POST /api/server/cdp/disconnect)`)
    this.name = 'CdpPoolFullError'
    this.size = size
    this.max = max
  }
}

/**
 * Normalize a ws debugger URL for pool keying (trailing slash only).
 * @param endpoint - candidate URL.
 * @returns the key.
 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint
}

/**
 * Carve the browser GUID and loopback port out of a debugger URL.
 * @param endpoint - `ws://host:port[/devtools/browser/<id>]`.
 * @returns both parts; empty string / undefined when absent.
 */
export function parseEndpoint(endpoint: string): { browserId: string, port: number | undefined } {
  try {
    const url = new URL(endpoint)
    const segments = url.pathname.split('/').filter(segment => segment !== '')
    const last = segments.length > 0 ? segments[segments.length - 1] : undefined
    const browserId = last !== undefined && last !== 'devtools' ? decodeURIComponent(last) : ''
    return { browserId, port: url.port === '' ? undefined : Number(url.port) }
  } catch {
    return { browserId: '', port: undefined }
  }
}

/**
 * Derive the stable display id for one endpoint.
 * @param endpoint - normalized debugger URL.
 * @returns `ep-<port>` or `ep-<browserId prefix>` or `ep-ws`.
 */
export function connectionIdOf(endpoint: string): string {
  const { browserId, port } = parseEndpoint(endpoint)
  if (port !== undefined) return `ep-${String(port)}`
  if (browserId !== '') return `ep-${browserId.slice(0, 8)}`
  return 'ep-ws'
}

/** Result of probing one loopback port's `/json/version`. */
export interface DiscoveredEndpoint {
  /** Probed port. */
  port: number
  /** Whether a CDP browser answered. */
  reachable: boolean
  /** The browser's WebSocket debugger URL; absent when not a browser. */
  webSocketDebuggerUrl?: string | undefined
  /** `/json/version` `Browser` value; absent when unknown. */
  browser?: string | undefined
  /** GUID carved from {@link webSocketDebuggerUrl}; absent when unknown. */
  browserId?: string | undefined
  /** Failure note when `reachable` is false or the answer was not a browser. */
  error?: string | undefined
}

/**
 * Probe one loopback port's `/json/version`. Never throws: a refusal,
 * timeout, or non-browser answer comes back as `reachable:false`/`error`.
 * @param port - loopback port to probe.
 * @param fetchImpl - fetch to use (tests inject).
 * @param timeoutMs - abort budget for the request.
 * @returns the probe result.
 */
export async function probeEndpoint(
  port: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DiscoveredEndpoint> {
  const url = `http://127.0.0.1:${String(port)}/json/version`
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { port, reachable: false, error: `HTTP ${String(res.status)}` }
    const data = await res.json() as { webSocketDebuggerUrl?: unknown, Browser?: unknown }
    const webSocketDebuggerUrl = typeof data.webSocketDebuggerUrl === 'string' ? data.webSocketDebuggerUrl : undefined
    if (webSocketDebuggerUrl === undefined) {
      return { port, reachable: true, error: 'answer carried no webSocketDebuggerUrl' }
    }
    return {
      port,
      reachable: true,
      webSocketDebuggerUrl,
      browser: typeof data.Browser === 'string' ? data.Browser : '',
      browserId: parseEndpoint(webSocketDebuggerUrl).browserId,
    }
  } catch (error) {
    return { port, reachable: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Probe several loopback ports concurrently, preserving the input order.
 * @param ports - ports to probe.
 * @param fetchImpl - fetch to use (tests inject).
 * @param timeoutMs - per-port abort budget.
 * @returns one result per input port.
 */
export async function discoverEndpoints(
  ports: readonly number[],
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DiscoveredEndpoint[]> {
  return await Promise.all(ports.map(async port => await probeEndpoint(port, fetchImpl, timeoutMs)))
}

/**
 * plan04: the pool of attached browser endpoints. Entries are keyed by
 * normalized WebSocket URL; each one owns its lifecycle listeners and its
 * backoff reconnection timer, so `closeAll()` is the only full teardown.
 */
export class ConnectionPool {
  private readonly entries = new Map<string, PooledEndpoint>()
  private readonly maxEntries: number
  private readonly hooks: PoolHooks

  /**
   * @param options - cap and owner hooks.
   */
  constructor(options: ConnectionPoolOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_POOL_ENTRIES
    this.hooks = options.hooks
  }

  /** Every pooled endpoint, in attach order. */
  list(): PooledEndpoint[] {
    return [...this.entries.values()]
  }

  /** Entries currently held. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Look an endpoint up by its debugger URL.
   * @param endpoint - normalized or raw URL.
   * @returns the entry, or undefined when unattached.
   */
  get(endpoint: string): PooledEndpoint | undefined {
    return this.entries.get(normalizeEndpoint(endpoint))
  }

  /**
   * Look an entry up by its display id.
   * @param connectionId - e.g. `ep-9333`.
   * @returns the entry, or undefined.
   */
  byConnectionId(connectionId: string): PooledEndpoint | undefined {
    return this.list().find(entry => entry.connectionId === connectionId)
  }

  /**
   * plan04-F6: locate a target id ANYWHERE in the pool (including parked
   * endpoints' registries). When the active endpoint changes, ids that stayed
   * behind are otherwise a dead end — this returns their URL so callers can
   * propose a same-URL successor on the active endpoint.
   * @param targetId - target id the caller still holds.
   * @returns its URL and pool id, or undefined when no entry tracks it.
   */
  parkedTarget(targetId: string): { url: string, connectionId: string } | undefined {
    for (const entry of this.entries.values()) {
      const info = entry.registry?.targets().find(target => target.targetId === targetId)
      if (info !== undefined) return { url: info.url, connectionId: entry.connectionId }
    }
    return undefined
  }

  /**
   * Register (or fetch) an endpoint and arm its lifecycle listeners.
   * Call AFTER the first successful `connection.connect()` — the initial
   * `CDP_CONNECTED_EVENT` has already fired, so every event this listener
   * sees is a reconnect by construction.
   * @param endpoint - debugger URL the connection dialed.
   * @param connection - the live connection.
   * @returns the pool entry.
   * @throws CdpPoolFullError when the cap is reached with nothing evictable.
   */
  adopt(endpoint: string, connection: CdpConnection): PooledEndpoint {
    const key = normalizeEndpoint(endpoint)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      if (existing.connection === connection) return existing
      // A stale object for the same URL: disarm it and replace below.
      this.forget(existing)
    }
    this.makeRoom()
    const { browserId, port } = parseEndpoint(key)
    const entry: PooledEndpoint = {
      connectionId: connectionIdOf(key),
      endpoint: key,
      browserId,
      port,
      connection,
      registry: undefined,
      sessions: new Map<string, PageSession>(),
      targetActivatedOff: undefined,
      launched: undefined,
      // plan13-profile: the owner stamps the real identity right after adopt().
      profileName: undefined,
      userDataDir: undefined,
      launchedByService: false,
      activeTargetId: undefined,
      state: connection.connected ? 'connected' : 'degraded',
      reconnects: 0,
      lastError: undefined,
      lifecycleOff: [],
      retryTimer: undefined,
      retryAttempt: 0,
      reconnectInFlight: false,
      stopped: false,
    }
    const offConnected = connection.on(CDP_CONNECTED_EVENT, () => {
      if (entry.stopped) return
      entry.reconnects += 1
      entry.retryAttempt = 0
      entry.state = 'reattaching'
      entry.lastError = undefined
      this.hooks.onReconnected(entry).then(
        () => { if (!entry.stopped) entry.state = 'connected' },
        (error: unknown) => {
          if (entry.stopped) return
          entry.lastError = error instanceof Error ? error.message : String(error)
          entry.state = 'degraded'
        },
      )
    })
    const offDisconnected = (event: CdpEvent): void => {
      if (entry.stopped) return
      const code = typeof event.params['code'] === 'number' ? event.params['code'] : '?'
      const reason = typeof event.params['reason'] === 'string' && event.params['reason'] !== ''
        ? `: ${event.params['reason']}`
        : ''
      entry.state = 'degraded'
      entry.lastError = `socket closed (code ${String(code)})${reason}`
      this.scheduleRetry(entry)
    }
    const offDisconnectedEvent = connection.on(CDP_DISCONNECTED_EVENT, offDisconnected)
    entry.lifecycleOff.push(offConnected, offDisconnectedEvent)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * Stop an entry: cancel its retry timer, disarm its listeners, and drop it
   * from the map WITHOUT closing the socket (the caller decides whether the
   * connection dies with it — `disconnect()` closes it right after).
   * @param entry - entry to forget.
   */
  forget(entry: PooledEndpoint): void {
    entry.stopped = true
    if (entry.retryTimer !== undefined) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = undefined
    }
    for (const dispose of entry.lifecycleOff.splice(0)) dispose()
    entry.targetActivatedOff?.()
    entry.targetActivatedOff = undefined
    if (this.entries.get(entry.endpoint) === entry) this.entries.delete(entry.endpoint)
  }

  /**
   * Fully detach an entry: {@link forget} plus closing its socket.
   * @param entry - entry to detach.
   */
  async detach(entry: PooledEndpoint): Promise<void> {
    this.forget(entry)
    await entry.connection.close().catch(() => {})
    entry.state = 'closed'
  }

  /**
   * Teardown every pooled endpoint: timers and listeners off, sockets closed,
   * launched browser trees terminated. Used by `CdpService.stop()`.
   */
  async closeAll(): Promise<void> {
    const entries = this.list()
    for (const entry of entries) {
      this.forget(entry)
      await entry.connection.close().catch(() => {})
      entry.state = 'closed'
      if (entry.launched !== undefined) {
        await entry.launched.close().catch(() => {})
        entry.launched = undefined
      }
    }
  }

  /** Make room for one more entry; evicts `closed` entries only. */
  private makeRoom(): void {
    if (this.entries.size < this.maxEntries) return
    for (const entry of this.entries.values()) {
      if (entry.state === 'closed') {
        this.forget(entry)
        return
      }
    }
    throw new CdpPoolFullError(this.entries.size, this.maxEntries)
  }

  /** Arm one backoff step, unless a retry/timer is already live. */
  private scheduleRetry(entry: PooledEndpoint): void {
    if (entry.stopped || entry.retryTimer !== undefined || entry.reconnectInFlight) return
    if (entry.retryAttempt >= MAX_RETRY_ATTEMPTS) {
      entry.state = 'closed'
      entry.lastError = entry.lastError ?? `reconnect failed after ${String(MAX_RETRY_ATTEMPTS)} attempts`
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** entry.retryAttempt, RETRY_MAX_MS)
    entry.retryAttempt += 1
    const timer = setTimeout(() => {
      entry.retryTimer = undefined
      void this.runRetry(entry).catch(() => undefined)
    }, delay)
    timer.unref()
    entry.retryTimer = timer
  }

  /** One reconnect attempt; schedules the next step on failure. */
  private async runRetry(entry: PooledEndpoint): Promise<void> {
    if (entry.stopped) return
    entry.reconnectInFlight = true
    entry.state = 'reattaching'
    try {
      await entry.connection.reconnect()
    } catch (error) {
      entry.lastError = `reconnect failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      entry.reconnectInFlight = false
    }
    if (entry.stopped) return
    if (entry.connection.connected) {
      entry.retryAttempt = 0
      return
    }
    this.scheduleRetry(entry)
  }
}
