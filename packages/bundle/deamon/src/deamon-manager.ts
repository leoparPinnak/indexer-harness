/**
 * Deamon Manager — Oversees the lifecycle of the independent
 * Deamon background service from within DSH.
 *
 * Spawns the daemon in its own isolated process, discovers its listening port,
 * checks health, and transparently restarts it on unexpected exits so that
 * streaming spikes or emulator crashes never affect DSH.
 *
 * @module @deepseek-ai/dsh-deamon/deamon-manager
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { get, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { GatewayClosedError, PipeGatewayClient } from '@deepseek-ai/dsh-ipc-pipe'
import {
  DEFAULT_DEAMON_PORT,
  getDaemonDiscoveryPath,
  getGatewaySeed,
  type DaemonInfo,
  type DaemonLogger,
} from './deamon.ts'
import { readBody, respondJson } from './sandbox.ts'

/** How the bridge reaches the daemon: the named-pipe gateway, or loopback HTTP. */
export type DeamonTransport = 'pipe' | 'http'

/** A daemon stream: its status line, headers, and the frame bytes as a stream. */
export interface DaemonStream extends Readable {
  /** Status line of the stream. */
  readonly statusCode: number
  /** Response headers of the stream. */
  readonly headers: Record<string, string | string[] | undefined>
}

/** Transport named by `DEAMON_TRANSPORT`, when it names one at all. */
function transportFromEnv(): DeamonTransport | undefined {
  const raw = process.env.DEAMON_TRANSPORT
  return raw === 'pipe' || raw === 'http' ? raw : undefined
}

/** Budget for a pipe round trip that is not a stream header (today's HTTP budget). */
const PIPE_REQUEST_TIMEOUT_MS = 30_000
/** Budget for a pipe request the tools make directly (today's HTTP budget). */
const PIPE_JSON_TIMEOUT_MS = 10_000
/** Budget for a stream's status header, which can wait on the helper starting. */
const PIPE_STREAM_TIMEOUT_MS = 10_000
/** Budget for the gateway handshake and ping used as a liveness probe. */
const PIPE_PROBE_TIMEOUT_MS = 1500

export interface DeamonManagerOptions {
  port?: number | undefined
  log: DaemonLogger
  daemonScript?: string | undefined
  /** Transport the bridge speaks; `pipe` unless `DEAMON_TRANSPORT` says otherwise. */
  transport?: DeamonTransport | undefined
}

export class DeamonManager {
  private child: ChildProcess | undefined
  private activePort: number | undefined
  private startingPromise: Promise<{ port: number; url: string }> | undefined
  private stopping = false
  private readonly targetPort: number
  private readonly log: DaemonLogger
  private readonly scriptPath: string
  /** Transport in force for this session; a refused gateway downgrades it once. */
  private transport: DeamonTransport
  /** The authenticated gateway connection, while one is open. */
  private pipe: PipeGatewayClient | undefined

  constructor(options: DeamonManagerOptions) {
    this.log = options.log
    this.transport = options.transport ?? transportFromEnv() ?? 'pipe'
    this.targetPort = options.port ?? DEFAULT_DEAMON_PORT
    if (options.daemonScript) {
      this.scriptPath = options.daemonScript
    } else {
      const tsPath = fileURLToPath(new URL('./deamon.ts', import.meta.url))
      const jsPath = fileURLToPath(new URL('./deamon.js', import.meta.url))
      this.scriptPath = existsSync(tsPath) ? tsPath : jsPath
    }
  }

  /** The transport in force, after any attach-time downgrade. */
  getTransport(): DeamonTransport {
    return this.transport
  }

  /**
   * Read the port discovery names, if it still names one. A gateway attach
   * happens before (or instead of) a port discovery, so this keeps
   * `{port, url}` meaningful for a caller that only speaks HTTP.
   */
  private adoptDiscoveryPort(): void {
    try {
      const info = JSON.parse(readFileSync(getDaemonDiscoveryPath(), 'utf-8')) as DaemonInfo
      if (typeof info.port === 'number') this.activePort = info.port
    } catch {
      // No usable discovery file: the pipe still answers without a port.
    }
  }

  /**
   * Open (or reuse) the authenticated gateway connection.
   * @returns the live client, or undefined when the gateway is unreachable.
   */
  private async connectPipe(): Promise<PipeGatewayClient | undefined> {
    if (this.transport === 'http') return undefined
    if (this.pipe?.connected) return this.pipe
    this.pipe = undefined
    try {
      const client = await PipeGatewayClient.connect({ seed: getGatewaySeed(), connectTimeoutMs: PIPE_PROBE_TIMEOUT_MS })
      client.on('close', () => { if (this.pipe === client) this.pipe = undefined })
      this.pipe = client
      this.adoptDiscoveryPort()
      this.log.info('deamon gateway attached over the named pipe')
      return client
    } catch {
      // Unreachable on the first run or before the daemon starts: the caller
      // falls back to the port discovery named, or to spawning.
      return undefined
    }
  }

  /**
   * Prove a daemon answers on the gateway.
   * @returns true when the handshake and ping both succeeded.
   */
  private async pingPipe(): Promise<boolean> {
    const client = await this.connectPipe()
    if (client === undefined) return false
    if (await client.ping(PIPE_PROBE_TIMEOUT_MS)) return true
    client.close()
    if (this.pipe === client) this.pipe = undefined
    return false
  }

  /** The coordinates every caller receives, including a gateway-only attach. */
  private describe(): { port: number; url: string } {
    const port = this.activePort ?? 0
    return { port, url: `http://127.0.0.1:${port}` }
  }

  /** True if the daemon child process is currently alive. */
  isActive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Return the currently discovered daemon base URL, or undefined if not active. */
  getBaseUrl(): string | undefined {
    return this.activePort ? `http://127.0.0.1:${this.activePort}` : undefined
  }

  /** Return the currently active port, or undefined if not active. */
  getPort(): number | undefined {
    return this.activePort
  }

  /**
   * Ensure the daemon is running and healthy.
   * If already healthy, returns immediately. Otherwise spawns and polls /health.
   */
  async ensureRunning(): Promise<{ port: number; url: string }> {
    if (this.startingPromise) {
      return this.startingPromise
    }

    // An authenticated gateway that answers is the daemon, whoever started it.
    if (this.transport === 'pipe' && await this.pingPipe()) return this.describe()

    if (this.isActive() && this.activePort !== undefined) {
      // Quick health ping
      const healthy = await this.pingHealth(this.activePort)
      if (healthy) {
        // The daemon speaks HTTP but not the gateway: run this session on the
        // transport that works instead of failing every request on the pipe.
        this.downgrade('the named-pipe gateway did not answer a live daemon')
        return { port: this.activePort, url: `http://127.0.0.1:${this.activePort}` }
      }
    }

    this.startingPromise = this.startDaemon()
    try {
      return await this.startingPromise
    } finally {
      this.startingPromise = undefined
    }
  }

  /**
   * Drop to the HTTP transport once, with the reason in the log. Both paths
   * stay alive during the shift; this is the switch flipping, not a rewrite.
   * @param reason - why the gateway is not the transport to use.
   */
  private downgrade(reason: string): void {
    if (this.transport !== 'pipe') return
    this.transport = 'http'
    this.log.warn(`deamon: ${reason}; using the http transport for this session`)
  }

  /**
   * Ping the /health endpoint of the daemon.
   */
  private async pingHealth(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1500,
      }, (res) => {
        resolve(res.statusCode === 200)
        res.resume() // Drain stream
      })
      req.on('error', () => { resolve(false) })
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  /**
   * Spawn the daemon subprocess and wait until it is listening and passes health check.
   */
  private async startDaemon(): Promise<{ port: number; url: string }> {
    this.stopping = false

    // A gateway already serving means a daemon is already up: attach to it
    // before thinking about spawning a second one.
    if (this.transport === 'pipe' && await this.pingPipe()) {
      this.log.info('re-attached to the running deamon over the named pipe')
      return this.describe()
    }

    // Check if an existing daemon is already running (e.g. from previous run or file)
    const discoveryFile = getDaemonDiscoveryPath()
    if (existsSync(discoveryFile)) {
      try {
        const text = readFileSync(discoveryFile, 'utf-8')
        const info = JSON.parse(text) as DaemonInfo
        if (typeof info.port === 'number') {
          const healthy = await this.pingHealth(info.port)
          if (healthy) {
            this.activePort = info.port
            this.downgrade('the discovered deamon serves HTTP but not the gateway')
            this.log.info(`re-attached to existing running daemon on port ${this.activePort}`)
            return { port: this.activePort, url: `http://127.0.0.1:${this.activePort}` }
          }
        }
      } catch {
        // Discovery file invalid or dead process, proceed to spawn fresh
      }
    }

    const args: string[] = ['--import', 'tsx/esm', this.scriptPath, String(this.targetPort)]

    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
    this.log.info(`spawning deamon on target port ${this.targetPort}...`)
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DEAMON_PORT: String(this.targetPort) },
    })
    this.child = child

    child.stderr.on('data', (chunk: Buffer | string) => {
      const line = String(chunk).trim()
      if (line) this.log.warn(`deamon stderr: ${line}`)
    })
    // The daemon reports on stdout (startup, helper relay lines). Draining is
    // load-bearing either way: an unread pipe fills and stalls the daemon.
    child.stdout.on('data', (chunk: Buffer | string) => {
      const line = String(chunk).trim()
      if (line) this.log.info(`deamon stdout: ${line}`)
    })

    child.on('close', (code, signal) => {
      this.child = undefined
      this.activePort = undefined
      if (!this.stopping) {
        this.log.warn(`deamon terminated unexpectedly (code: ${String(code)}, signal: ${String(signal)})`)
      }
    })

    // Poll for port discovery & readiness
    const deadline = Date.now() + 10000
    let detectedPort: number | undefined

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`deamon exited immediately with code ${String(child.exitCode)}`)
      }

      if (this.transport === 'pipe' && await this.pingPipe()) {
        this.log.info('deamon is online over the named pipe')
        return this.describe()
      }

      if (existsSync(discoveryFile)) {
        try {
          const text = readFileSync(discoveryFile, 'utf-8')
          const info = JSON.parse(text) as DaemonInfo
          if (typeof info.port === 'number' && info.pid === child.pid) {
            detectedPort = info.port
            const healthy = await this.pingHealth(detectedPort)
            if (healthy) {
              this.activePort = detectedPort
              this.log.info(`deamon is online and healthy at http://127.0.0.1:${this.activePort}`)
              return { port: this.activePort, url: `http://127.0.0.1:${this.activePort}` }
            }
          }
        } catch {
          // Retry on next tick
        }
      }
      await new Promise(r => setTimeout(r, 150))
    }

    throw new Error('timed out waiting for deamon to become ready')
  }

  /**
   * Forward a JSON API request from DSH to the daemon.
   * Catches network dropouts cleanly and sends HTTP 502 without crashing DSH.
   */
  async forwardJson(
    req: IncomingMessage,
    res: ServerResponse,
    targetPath: string,
    bodyOverride?: unknown,
  ): Promise<void> {
    let port: number
    try {
      const ready = await this.ensureRunning()
      port = ready.port
    } catch (err: unknown) {
      respondJson(res, 503, {
        ok: false,
        error: `Deamon unavailable: ${String(err)}`,
        starting: true,
      })
      return
    }

    let payloadString: string
    if (bodyOverride !== undefined) {
      payloadString = typeof bodyOverride === 'string' ? bodyOverride : JSON.stringify(bodyOverride)
    } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        payloadString = await readBody(req)
      } catch {
        respondJson(res, 400, { ok: false, error: 'could not read request body' })
        return
      }
    } else {
      payloadString = ''
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
    }
    if (payloadString.length > 0) {
      headers['content-length'] = String(Buffer.byteLength(payloadString))
    }

    // Pipe first: the gateway carries the same bytes without a loopback hop.
    // Only a lost connection falls back to the port, and only while discovery
    // still names one — a refused request is an answer, not a transport bug.
    if (this.transport === 'pipe') {
      const client = await this.connectPipe()
      if (client !== undefined) {
        try {
          const answer = await client.request(
            { method: req.method ?? 'GET', url: targetPath, headers, body: payloadString },
            PIPE_REQUEST_TIMEOUT_MS,
          )
          res.statusCode = answer.status
          for (const [key, value] of Object.entries(answer.headers)) res.setHeader(key, value)
          res.end(answer.body)
          return
        } catch (err: unknown) {
          this.log.error(`error forwarding ${req.method} ${targetPath} over the pipe: ${String(err)}`)
          const lost = err instanceof GatewayClosedError && !client.connected
          if (!lost || this.activePort === undefined) {
            if (!res.headersSent) {
              respondJson(res, 502, {
                ok: false,
                error: `Deamon communication error: ${String(err)}`,
              })
            }
            return
          }
          this.log.warn('falling back to the http transport for this request')
        }
      } else if (this.activePort === undefined) {
        respondJson(res, 502, {
          ok: false,
          error: 'Deamon communication error: the named-pipe gateway is unavailable',
        })
        return
      }
    }

    const daemonReq = request({
      hostname: '127.0.0.1',
      port,
      path: targetPath,
      method: req.method,
      headers,
      timeout: 30000,
    }, (daemonRes) => {
      res.statusCode = daemonRes.statusCode ?? 200
      for (const [key, value] of Object.entries(daemonRes.headers)) {
        if (value !== undefined) {
          res.setHeader(key, value)
        }
      }
      daemonRes.pipe(res)
    })

    daemonReq.on('error', (err) => {
      this.log.error(`error forwarding ${req.method} ${targetPath} to daemon: ${err.message}`)
      if (!res.headersSent) {
        respondJson(res, 502, {
          ok: false,
          error: `Deamon communication error: ${err.message}`,
        })
      }
    })

    if (payloadString.length > 0) {
      daemonReq.write(payloadString)
    }
    daemonReq.end()
  }

  /**
   * Fetch a JSON endpoint on the daemon directly (e.g. for tools).
   */
  async fetchJson<T = unknown>(targetPath: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const ready = await this.ensureRunning()
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const method = options.method ?? (payload ? 'POST' : 'GET')

    if (this.transport === 'pipe') {
      const client = await this.connectPipe()
      if (client !== undefined) {
        try {
          const answer = await client.request(
            { method, url: targetPath, headers: { 'content-type': 'application/json' }, body: payload },
            PIPE_JSON_TIMEOUT_MS,
          )
          const text = answer.body.toString('utf8')
          try {
            return JSON.parse(text) as T
          } catch {
            throw new Error(`invalid JSON from daemon (${String(answer.status)}): ${text.slice(0, 100)}`)
          }
        } catch (err: unknown) {
          const lost = err instanceof GatewayClosedError && !client.connected
          if (!lost || this.activePort === undefined) throw err
          this.log.warn('falling back to the http transport for this request')
        }
      } else if (this.activePort === undefined) {
        throw new Error('the named-pipe gateway is unavailable and discovery names no port')
      }
    }

    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (payload) {
        headers['content-length'] = String(Buffer.byteLength(payload))
      }

      const req = request({
        hostname: '127.0.0.1',
        port: ready.port,
        path: targetPath,
        method,
        headers,
        timeout: 10000,
      }, (res) => {
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(text) as T)
          } catch {
            reject(new Error(`invalid JSON from daemon (${String(res.statusCode)}): ${text.slice(0, 100)}`))
          }
        })
      })

      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  /**
   * Open a streaming GET on the daemon: the multipart frame feed as a byte
   * stream, whichever transport is in force. The caller has already ensured
   * the daemon, so a rejection here is a transport failure the route reports.
   * @param targetPath - daemon path including its query string.
   * @returns the status line, headers, and the frame bytes as a stream.
   */
  async openStream(targetPath: string): Promise<DaemonStream> {
    if (this.transport === 'pipe') {
      const client = await this.connectPipe()
      if (client !== undefined) {
        return await client.openStream({ method: 'GET', url: targetPath }, PIPE_STREAM_TIMEOUT_MS)
      }
      if (this.activePort === undefined) {
        throw new Error('the named-pipe gateway is unavailable and discovery names no port')
      }
    }
    const port = this.activePort
    if (port === undefined) throw new Error('the deamon is not running')
    return await new Promise<DaemonStream>((resolve, reject) => {
      const proxyReq = get(`http://127.0.0.1:${String(port)}${targetPath}`, (response) => {
        /* v8 ignore next -- Node emits a response only after a status line; the cast keeps the one response shape both transports return. */
        resolve(response as unknown as DaemonStream)
      })
      proxyReq.on('error', reject)
    })
  }

  /**
   * Stop the daemon process cleanly.
   */
  async stop(): Promise<void> {
    this.stopping = true
    const pipe = this.pipe
    this.pipe = undefined
    pipe?.close()
    if (this.child) {
      this.child.kill('SIGTERM')
      const child = this.child
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.on('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.child = undefined
    this.activePort = undefined
  }
}
