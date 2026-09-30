/**
 * Deamon — Independent background HTTP service for desktop streaming
 * and virtualization management.
 *
 * Runs as an isolated Node.js process so that high-framerate MJPEG encoding,
 * GDI window capture pipes, and potential emulator crashes NEVER block or crash
 * DSH's main Node.js process, Web GUI, or Agent loops.
 *
 * @module @deepseek-ai/dsh-deamon/deamon
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GatewayAlreadyRunningError, startPipeGateway, type PipeGateway } from '@deepseek-ai/dsh-ipc-pipe'
import {
  SandboxSessionManager,
  parseSessionParam,
  parseInstanceParam,
  parseTargetParam,
  parseFpsParam,
  resolveLaunchCommand,
  readBody,
  respondJson,
  handleSandboxInputLocal,
  handleSandboxUiaLocal,
  handleSandboxWindowsLocal,
  handleSandboxWindowActionLocal,
  handleSandboxChangesLocal,
} from './sandbox.ts'

/** Fallback daemon TCP port when neither the environment nor an option names one. */
export const DEFAULT_DEAMON_PORT = 4005

/** Minimal logger contract for the daemon. */
export interface DaemonLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

/** Metadata written to disk so DSH or local clients discover the daemon's coordinates. */
export interface DaemonInfo {
  port: number
  pid: number
  startedAt: number
}

/** Configuration options for starting the Deamon service. */
export interface DeamonOptions {
  port?: number | undefined
  host?: string | undefined
  log?: DaemonLogger | undefined
  persistencePath?: string | false | undefined
}

/** Running daemon handle. */
export interface DeamonHandle {
  server: Server
  port: number
  close: () => Promise<void>
  manager: SandboxSessionManager
}

/**
 * Resolve the daemon discovery file path: `DEAMON_DISCOVERY_FILE` overrides
 * it so a spec can own its own path, otherwise `$DSH_HOME` or `~/.dsh`.
 * @returns the absolute path to the daemon discovery file.
 */
export function getDaemonDiscoveryPath(): string {
  const override = process.env.DEAMON_DISCOVERY_FILE
  if (override !== undefined && override !== '') return override
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (!existsSync(base)) {
    try {
      mkdirSync(base, { recursive: true })
    } catch {
      // Ignored
    }
  }
  return join(base, 'deamon.json')
}

/**
 * Seed naming this daemon's gateway coordinates. `DEAMON_DISCOVERY_FILE`
 * keeps a spec's pipe beside its own discovery file so two daemons in one
 * test run never fight over an endpoint; without it the DSH home names it.
 * @returns the seed, or undefined for the home-derived default.
 */
export function getGatewaySeed(): string | undefined {
  const override = process.env.DEAMON_DISCOVERY_FILE
  return override !== undefined && override !== '' ? override : undefined
}

/** Create a minimal console logger when none is provided. */
function createDefaultLogger(): DaemonLogger {
  return {
    info: (msg: string) => { console.log(`[deamon] ${msg}`) },
    warn: (msg: string) => { console.warn(`[deamon] ${msg}`) },
    error: (msg: string) => { console.error(`[deamon] ${msg}`) },
    debug: () => { /* quiet by default */ },
  }
}

/**
 * Start the standalone Deamon HTTP service.
 * @param options - optional port, host, and logger.
 * @returns live handle with server, port, and close method.
 */
export async function startDeamon(options: DeamonOptions = {}): Promise<DeamonHandle> {
  const log = options.log ?? createDefaultLogger()
  const manager = new SandboxSessionManager(
    log,
    options.persistencePath !== undefined ? { persistencePath: options.persistencePath } : undefined,
  )
  const targetPort = options.port ?? (process.env.DEAMON_PORT ? Number(process.env.DEAMON_PORT) : DEFAULT_DEAMON_PORT)
  const host = options.host ?? '127.0.0.1'

  /**
   * Drain a request body for a local sandbox handler. A destroyed body carries
   * no text: the handler parses the empty string and answers its own 400.
   * @param req - the request to read.
   * @returns the body text, or an empty string when the body cannot be read.
   */
  const readSandboxBody = async (req: IncomingMessage): Promise<string> => {
    try {
      return await readBody(req)
    } catch {
      return ''
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Add permissive CORS headers so browser direct streaming works seamlessly
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', '*')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${host}`)
    const pathname = url.pathname

    try {
      // Health check endpoint
      if (pathname === '/health' && req.method === 'GET') {
        respondJson(res, 200, {
          ok: true,
          service: 'deamon',
          pid: process.pid,
          uptime: process.uptime(),
        })
        return
      }

      // MJPEG video stream endpoint
      if (pathname === '/stream' && req.method === 'GET') {
        const sessionId = parseSessionParam(req)
        const instanceId = parseInstanceParam(req)
        const target = parseTargetParam(req)
        const fps = parseFpsParam(req)
        const controller = manager.get(sessionId, instanceId, target)
        if (fps !== undefined) {
          controller.setFps(fps)
        }
        controller.stream(res)
        return
      }

      // Status endpoint
      if (pathname === '/status' && req.method === 'GET') {
        const sessionId = parseSessionParam(req)
        const instanceId = parseInstanceParam(req)
        const target = parseTargetParam(req)
        const controller = manager.get(sessionId, instanceId, target)
        respondJson(res, 200, {
          ok: true,
          session: sessionId,
          instanceId,
          active: controller.isActive(),
          desktop: controller.desktop,
          fps: controller.getMeasuredFps(),
          targetFps: controller.getFps(),
        })
        return
      }

      // Dynamic viewport resize
      if (pathname === '/size' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const width = typeof rec.width === 'number' ? rec.width : undefined
        const height = typeof rec.height === 'number' ? rec.height : undefined
        if (width === undefined || height === undefined) {
          respondJson(res, 400, { ok: false, error: 'width and height are required positive integers' })
          return
        }
        const sessionId = parseSessionParam(req, payload)
        const instanceId = parseInstanceParam(req, payload)
        const target = parseTargetParam(req, payload)
        const controller = manager.get(sessionId, instanceId, target)
        const delivered = controller.setViewport(width, height)
        respondJson(res, 200, { ok: true, width, height, delivered })
        return
      }

      // Dynamic FPS update
      if (pathname === '/fps' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const fps = parseFpsParam(req, payload)
        if (fps === undefined) {
          respondJson(res, 400, { ok: false, error: 'fps must be an integer between 1 and 60' })
          return
        }
        const sessionId = parseSessionParam(req, payload)
        const instanceId = parseInstanceParam(req, payload)
        const target = parseTargetParam(req, payload)
        const controller = manager.get(sessionId, instanceId, target)
        const updated = controller.setFps(fps)
        respondJson(res, 200, { ok: true, fps, updated })
        return
      }

      // Launch application on desktop
      if (pathname === '/launch' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const command = typeof rec.command === 'string' ? rec.command.trim() : ''
        if (command === '') {
          respondJson(res, 400, { ok: false, error: 'command is required' })
          return
        }
        const sessionId = parseSessionParam(req, payload)
        const instanceId = parseInstanceParam(req, payload)
        const target = parseTargetParam(req, payload)
        const controller = manager.get(sessionId, instanceId, target)
        const resolved = resolveLaunchCommand(command, controller.desktop)
        if (!controller.launch(resolved)) {
          respondJson(res, 500, { ok: false, error: 'could not launch command on Shellbox desktop' })
          return
        }
        respondJson(res, 200, {
          ok: true,
          command: resolved,
          session: sessionId,
          desktop: controller.desktop,
        })
        return
      }

      // Stop helper process
      if (pathname === '/stop' && req.method === 'POST') {
        let payload: unknown = {}
        try {
          const bodyText = await readBody(req)
          if (bodyText.trim() !== '') payload = JSON.parse(bodyText)
        } catch {
          // Empty payload is acceptable
        }
        const sessionId = parseSessionParam(req, payload)
        const instanceId = parseInstanceParam(req, payload)
        const target = parseTargetParam(req, payload)
        const controller = manager.get(sessionId, instanceId, target)
        const stopped = await controller.stop()
        respondJson(res, 200, { ok: true, stopped, session: sessionId, instanceId })
        return
      }

      // Deliver sandbox input events to the target desktop
      if (pathname === '/input') {
        const result = await handleSandboxInputLocal(manager, req, await readSandboxBody(req))
        respondJson(res, result.status, result.body)
        return
      }

      // Read one window's bounded accessibility tree from the target desktop
      if (pathname === '/uia') {
        const result = await handleSandboxUiaLocal(manager, req, await readSandboxBody(req))
        respondJson(res, result.status, result.body)
        return
      }

      // Read the target desktop's latest window snapshot
      if (pathname === '/windows') {
        const result = await handleSandboxWindowsLocal(manager, req)
        respondJson(res, result.status, result.body)
        return
      }

      // Focus a window on the target desktop
      if (pathname === '/windows/focus') {
        const result = await handleSandboxWindowActionLocal(manager, req, await readSandboxBody(req), 'focus')
        respondJson(res, result.status, result.body)
        return
      }

      // Close a window on the target desktop
      if (pathname === '/windows/close') {
        const result = await handleSandboxWindowActionLocal(manager, req, await readSandboxBody(req), 'close')
        respondJson(res, result.status, result.body)
        return
      }

      // Read the change ring page for the requested session or instance
      if (pathname === '/changes') {
        const result = await handleSandboxChangesLocal(manager, req)
        respondJson(res, result.status, result.body)
        return
      }

      // List instances
      if (pathname === '/instances' && req.method === 'GET') {
        const sessionId = parseSessionParam(req)
        const allInstances = manager.listInstances()
        const instances = sessionId ? allInstances.filter(i => i.boundSessionIds.includes(sessionId)) : allInstances
        respondJson(res, 200, { ok: true, session: sessionId, instances })
        return
      }

      // Create instance
      if (pathname === '/instances/create' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const sessionId = parseSessionParam(req, payload) || 'default'
        const rawType = typeof rec.type === 'string' ? rec.type : undefined
        const type = rawType === 'hyperv' ? 'hyperv' : rawType === 'wsl-ubuntu' ? 'wsl-ubuntu' : 'win32'
        const vmName = typeof rec.vmName === 'string' ? rec.vmName : undefined
        const instance = manager.createInstance({ sessionId, type, vmName })
        respondJson(res, 200, {
          ok: true,
          instance: {
            id: instance.id,
            name: instance.name,
            type: instance.type,
            desktopName: instance.desktopName,
            vmName: instance.vmName,
            ownerSessionId: instance.ownerSessionId,
            boundSessionIds: instance.boundSessionIds,
            active: instance.controller.isActive(),
            createdAt: instance.createdAt,
          },
        })
        return
      }

      // Attach instance
      if (pathname === '/instances/attach' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const targetSessionId = typeof rec.targetSessionId === 'string' ? rec.targetSessionId : undefined
        const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
        if (targetSessionId === undefined || instanceId === undefined) {
          respondJson(res, 400, { ok: false, error: 'targetSessionId and instanceId are required' })
          return
        }
        const attached = manager.attachInstance(targetSessionId, instanceId)
        if (!attached) {
          respondJson(res, 404, { ok: false, error: `instance "${instanceId}" not found` })
          return
        }
        respondJson(res, 200, { ok: true, attached: true, instanceId, targetSessionId })
        return
      }

      // Detach instance
      if (pathname === '/instances/detach' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : undefined
        const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
        if (sessionId === undefined || instanceId === undefined) {
          respondJson(res, 400, { ok: false, error: 'sessionId and instanceId are required' })
          return
        }
        const detached = manager.detachInstance(sessionId, instanceId)
        respondJson(res, 200, { ok: true, detached, instanceId, sessionId })
        return
      }

      // Terminate instance
      if (pathname === '/instances/terminate' && req.method === 'POST') {
        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
          return
        }
        const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
        if (instanceId === undefined) {
          respondJson(res, 400, { ok: false, error: 'instanceId is required' })
          return
        }
        const terminated = await manager.terminateInstance(instanceId)
        respondJson(res, 200, { ok: true, terminated, instanceId })
        return
      }

      // Unknown route
      respondJson(res, 404, { ok: false, error: `Not Found: ${pathname}` })
    } catch (err: unknown) {
      log.error(`unhandled error on ${pathname}: ${String(err)}`)
      if (!res.headersSent) {
        respondJson(res, 500, { ok: false, error: 'Internal Server Error' })
      }
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  // Start listening
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && targetPort !== 0) {
        log.warn(`port ${targetPort} in use, falling back to ephemeral port`)
        server.listen(0, host, () => {
          const addr = server.address()
          resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
        })
      } else {
        reject(err)
      }
    })

    server.listen(targetPort, host, () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : targetPort)
    })
  })

  log.info(`listening on http://${host}:${actualPort} (PID: ${process.pid})`)

  // Write discovery coordinates to disk
  const discoveryFile = getDaemonDiscoveryPath()
  const info: DaemonInfo = {
    port: actualPort,
    pid: process.pid,
    startedAt: Date.now(),
  }
  try {
    writeFileSync(discoveryFile, JSON.stringify(info, null, 2))
  } catch (err: unknown) {
    log.warn(`failed to write discovery file: ${String(err)}`)
  }

  // Mount the named-pipe gateway beside the HTTP listener. The bridge picks
  // its transport with `deamon.transport`; both stay alive for the shift, and
  // a gateway already mounted by another live daemon is reported, not fatal —
  // that daemon is the one the bridge will attach to.
  let gateway: PipeGateway | undefined
  try {
    gateway = await startPipeGateway({
      seed: getGatewaySeed(),
      log,
      handler: async (req, res) => {
        // The gateway pair carries exactly the HTTP-shaped subset the routes
        // read: method, url, a readable body, and a response they set headers
        // on and write to — the same objects a `node:http` listener hands over.
        await handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      },
    })
  } catch (error: unknown) {
    if (error instanceof GatewayAlreadyRunningError) {
      log.warn(`deamon: ${error.message}; serving the HTTP transport only`)
    } else {
      log.error(`deamon: named-pipe gateway did not mount: ${String(error)}`)
    }
  }

  const close = async (): Promise<void> => {
    try {
      rmSync(discoveryFile, { force: true })
    } catch {
      // Ignored
    }
    if (gateway !== undefined) await gateway.close()
    await manager.stopAll()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  }

  return {
    server,
    port: actualPort,
    close,
    manager,
  }
}

// Standalone execution entrypoint
const isMain = process.argv[1] !== undefined && (
  fileURLToPath(import.meta.url) === process.argv[1]
  || process.argv[1].endsWith('deamon.ts')
  || process.argv[1].endsWith('deamon.js')
)

if (isMain) {
  const portArg = process.argv[2] ? Number(process.argv[2]) : undefined
  startDeamon({ port: portArg }).then((daemon) => {
    const handleExit = (): void => {
      void daemon.close().then(() => { process.exit(0) })
    }
    process.on('SIGINT', handleExit)
    process.on('SIGTERM', handleExit)
  }).catch((err: unknown) => {
    console.error('[deamon] fatal startup error:', err)
    process.exit(1)
  })
}
