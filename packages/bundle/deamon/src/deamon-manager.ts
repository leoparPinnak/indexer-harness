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
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DEAMON_PORT,
  getDaemonDiscoveryPath,
  type DaemonInfo,
  type DaemonLogger,
} from './deamon.ts'
import { readBody, respondJson } from './sandbox.ts'

export interface DeamonManagerOptions {
  port?: number | undefined
  log: DaemonLogger
  daemonScript?: string | undefined
}

export class DeamonManager {
  private child: ChildProcess | undefined
  private activePort: number | undefined
  private startingPromise: Promise<{ port: number; url: string }> | undefined
  private stopping = false
  private readonly targetPort: number
  private readonly log: DaemonLogger
  private readonly scriptPath: string

  constructor(options: DeamonManagerOptions) {
    this.log = options.log
    this.targetPort = options.port ?? DEFAULT_DEAMON_PORT
    if (options.daemonScript) {
      this.scriptPath = options.daemonScript
    } else {
      const tsPath = fileURLToPath(new URL('./deamon.ts', import.meta.url))
      const jsPath = fileURLToPath(new URL('./deamon.js', import.meta.url))
      this.scriptPath = existsSync(tsPath) ? tsPath : jsPath
    }
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
    if (this.isActive() && this.activePort !== undefined) {
      // Quick health ping
      const healthy = await this.pingHealth(this.activePort)
      if (healthy) {
        return { port: this.activePort, url: `http://127.0.0.1:${this.activePort}` }
      }
    }

    if (this.startingPromise) {
      return this.startingPromise
    }

    this.startingPromise = this.startDaemon()
    try {
      return await this.startingPromise
    } finally {
      this.startingPromise = undefined
    }
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
   * Stop the daemon process cleanly.
   */
  async stop(): Promise<void> {
    this.stopping = true
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
