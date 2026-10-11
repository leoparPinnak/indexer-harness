import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import WsClient from 'ws'
import { Context } from '@deepseek-ai/cordis'
import { createMultipartFrameParser, internals, registerSandboxRoutes, SandboxController } from '../src/sandbox.ts'
import { startDeamon } from '../src/deamon.ts'
import { DeamonManager, type DaemonStream } from '../src/deamon-manager.ts'

/**
 * Deterministic stand-in for the shipped helper. It speaks the same contract —
 * `-Stream`, `-CommandFile`, base64 frames on stdout, diagnostics on stderr —
 * through the real PowerShell interpreter, so the bridge's spawn, pipe framing,
 * and command-file handling are all exercised. Drained commands are appended to
 * `<CommandFile>.drained` so a spec can prove delivery.
 */
const FAKE_HELPER = `
param([switch]$Stream, [int]$Width = 800, [int]$Height = 600, [int]$Fps = 8, [string]$DesktopName = 'x', [string]$CommandFile = '')
[Console]::Error.WriteLine("fake desktop=\${DesktopName} viewport=\${Width}x\${Height}")
$frame = [byte[]](0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0xFF,0xD9)
$b64 = [Convert]::ToBase64String($frame)
$out = [Console]::OpenStandardOutput()
$n = 0
while ($n -lt 2000) {
  if ($CommandFile -ne '' -and (Test-Path -LiteralPath $CommandFile)) {
    $text = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
    if ($null -ne $text -and $text.Trim() -ne '') {
      Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
      Add-Content -LiteralPath ($CommandFile + '.drained') -Value $text.Trim()
      if ($text -match 'quit') { break }
      if ($text -match 'size\\s+(\\d+)\\s+(\\d+)') {
        [Console]::Error.WriteLine("fake viewport=\${0}x\${1}" -f $Matches[1], $Matches[2])
      }
      if ($text -match 'fps\\s+(\\d+)') {
        [Console]::Error.WriteLine("fake fps=\${0}" -f $Matches[1])
      }
      if ($text -match 'launch\\s+(.+)') {
        [Console]::Error.WriteLine("fake launch=\${0}" -f $Matches[1])
      }
    }
  }
  $n++
  $payload = [Text.Encoding]::ASCII.GetBytes($b64 + "\`n")
  $out.Write($payload, 0, $payload.Length)
  $out.Flush()
  Start-Sleep -Milliseconds 20
}
[Environment]::Exit(0)
`

interface Route { (req: IncomingMessage, res: ServerResponse): unknown }

/** Minimal request stand-in carrying an optional JSON body. */
function makeRequest(method: string, body?: string, urlPath = '/'): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [body])
  return Object.assign(stream, { method, url: urlPath }) as unknown as IncomingMessage
}

interface Captured {
  res: ServerResponse
  chunks: Buffer[]
  done: Promise<void>
}

/** Collect a response's status, headers, and written bytes without a socket. */
function makeResponse(): Captured {
  const chunks: Buffer[] = []
  let status = 0
  const headers: Record<string, string> = {}
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const res = {
    get statusCode(): number { return status },
    set statusCode(value: number) { status = value },
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
    getHeader: (name: string) => headers[name.toLowerCase()],
    flushHeaders: () => {},
    write: (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); return true },
    end: (chunk?: Buffer | string) => {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      resolveDone()
    },
    on: () => res,
    once: () => res,
    writableEnded: false,
    destroyed: false,
  } as unknown as ServerResponse
  return { res, chunks, done }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('web-app sandbox bridge', () => {
  type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

  /** Upgrade routes captured from `registerSandboxRoutes`, keyed by path. */
  const upgrades = new Map<string, UpgradeHandler>()

  /** Next rejection Connection's `requestRejection` hands to an upgrade; undefined accepts. */
  let connectionRejection: 401 | 403 | undefined

  let tempDir: string
  let commandFile: string
  let savedHome: string | undefined

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-bridge-'))
    const helperPath = join(tempDir, 'fake-helper.ps1')
    writeFileSync(helperPath, FAKE_HELPER)
    commandFile = join(tempDir, 'commands.cmd')
    internals.helperScript = helperPath
    internals.commandFile = commandFile
    internals.useDaemon = false
    await internals.resetController()
    upgrades.clear()
    connectionRejection = undefined
    // Keep spawned daemons off the live discovery coordinates of this machine.
    process.env.DEAMON_DISCOVERY_FILE = join(tempDir, 'daemon-discovery.json')
    // Gateway keys a daemon derives land in a temp DSH home, not the live one.
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = tempDir
  })

  afterEach(async () => {
    // The awaited stop is what releases a helper's file handles: a helper that
    // is still booting keeps its script open, and removal must not race it.
    await internals.resetController()
    internals.commandFile = ''
    internals.useDaemon = true
    delete process.env.DEAMON_DISCOVERY_FILE
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    savedHome = undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
        break
      } catch (error: unknown) {
        const retry = (error as NodeJS.ErrnoException).code === 'EPERM' && attempt < 9
        if (!retry) throw error
        await wait(150)
      }
    }
  })

  /** The context of the most recent `setupApp`, read by the disposal case. */
  let lastCtx: Context | undefined

  async function setupApp(): Promise<Map<string, Route>> {
    const routes = new Map<string, Route>()
    const fakeServer = {
      host: '127.0.0.1',
      port: 4567,
      register: (entry: { path: string; handler: Route }) => {
        routes.set(entry.path, entry.handler)
        return () => { routes.delete(entry.path) }
      },
      registerUpgrade: (entry: { path: string; handler: UpgradeHandler }) => {
        upgrades.set(entry.path, entry.handler)
        return () => { upgrades.delete(entry.path) }
      },
    }
    const ctx = new Context()
    lastCtx = ctx
    ctx.reflect.provide('webServer', fakeServer)
    ctx.reflect.provide('connection', { requestRejection: () => connectionRejection })
    registerSandboxRoutes(ctx)
    // The WebSocket face registers through `ctx.inject`, which settles after
    // the reflected services resolve: one macrotask drains those microtasks.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    return routes
  }

  /** A real HTTP server that dispatches upgrades exactly as the Web server does. */
  async function startUpgradeBridge(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    server.on('upgrade', (req, socket, head) => {
      const handler = upgrades.get((req.url ?? '/').split('?')[0] ?? '/')
      if (handler === undefined) {
        socket.destroy()
        return
      }
      handler(req, socket, head)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port
    return {
      port,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    }
  }

  /** Connect a viewer to the frame socket and resolve once the handshake completes. */
  function openViewer(port: number, query = ''): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WsClient(`ws://127.0.0.1:${String(port)}/api/server/sandbox/ws${query}`)
      socket.once('open', () => { resolve(socket) })
      socket.once('error', reject)
    })
  }

  /** Perform the raw handshake and resolve only the HTTP status of a rejection. */
  function handshakeStatus(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/ws`)
      req.setHeader('connection', 'upgrade')
      req.setHeader('upgrade', 'websocket')
      req.setHeader('sec-websocket-version', '13')
      req.setHeader('sec-websocket-key', Buffer.from('dsh-test-key').toString('base64'))
      req.on('response', (res) => {
        resolve(res.statusCode ?? 0)
        res.resume()
      })
      req.on('upgrade', () => {
        req.destroy()
        reject(new Error('the handshake was accepted unexpectedly'))
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** Resolve the next binary message, or reject when none arrives in time. */
  function nextFrame(socket: WsClient, timeoutMs = 20000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('no frame arrived')) }, timeoutMs)
      socket.once('message', (data) => {
        clearTimeout(timer)
        if (Buffer.isBuffer(data)) {
          resolve(data)
          return
        }
        resolve(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data))
      })
    })
  }

  /** Resolve the client-visible close code, or reject when none arrives in time. */
  function nextClose(socket: WsClient, timeoutMs = 20000): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('no close arrived')) }, timeoutMs)
      socket.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code })
      })
    })
  }

  /**
   * Poll the fake helper's drained marker until it carries content, bounded by
   * `timeoutMs`: the helper is a real PowerShell process, so the wait ends on
   * the observable drain instead of a fixed sleep that coverage instrumentation
   * can overrun.
   */
  async function waitForDrained(timeoutMs = 15000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const text = readFileSync(`${commandFile}.drained`, 'utf8')
        if (text.trim() !== '') return text
      } catch {
        // The marker file does not exist until the helper drains the command file.
      }
      if (Date.now() >= deadline) throw new Error('the fake helper never wrote the drained marker')
      await wait(50)
    }
  }

  /**
 * A stand-in's `openStream`: one HTTP request to the stand-in's target server
 * (counting the contact) with its response as the returned frame stream. The
 * bridge contract moved onto `DeamonManager.openStream`, so stand-ins must
 * speak it for the late-answer scenarios to be meaningful.
 */
  async function httpStandInStream(port: number, path: string): Promise<DaemonStream> {
    return await new Promise<DaemonStream>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${String(port)}${path}`, (res) => {
        resolve(Object.assign(res, { statusCode: res.statusCode ?? 0, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('registers the sandbox and shellbox routes', async () => {
    const routes = await setupApp()
    expect([...routes.keys()].sort()).toEqual([
      '/api/server/sandbox/changes',
      '/api/server/sandbox/fps',
      '/api/server/sandbox/input',
      '/api/server/sandbox/instances',
      '/api/server/sandbox/instances/attach',
      '/api/server/sandbox/instances/create',
      '/api/server/sandbox/instances/detach',
      '/api/server/sandbox/instances/terminate',
      '/api/server/sandbox/launch',
      '/api/server/sandbox/size',
      '/api/server/sandbox/status',
      '/api/server/sandbox/stop',
      '/api/server/sandbox/stream',
      '/api/server/sandbox/uia',
      '/api/server/sandbox/windows',
      '/api/server/sandbox/windows/close',
      '/api/server/sandbox/windows/focus',
      '/api/server/shellbox/launch',
    ])
    expect([...upgrades.keys()]).toEqual(['/api/server/sandbox/ws'])
  })

  it('rejects a launch request with invalid command payload', async () => {
    const routes = await setupApp()
    for (const body of ['{}', 'null', '{ "command": 123 }', '{ "command": "" }', '{ "command": "   " }']) {
      const captured = makeResponse()
      await routes.get('/api/server/sandbox/launch')!(makeRequest('POST', body), captured.res)
      await captured.done
      expect(captured.res.statusCode).toBe(400)
      const parsed = JSON.parse(Buffer.concat(captured.chunks).toString()) as { ok: boolean }
      expect(parsed.ok).toBe(false)
    }
  })

  it('delivers launch commands to the helper', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/launch')!(makeRequest('POST', JSON.stringify({ command: 'notepad.exe' })), captured.res)
    await captured.done
    expect(captured.res.statusCode).toBe(200)
    expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toEqual({ ok: true, command: 'notepad.exe' })

    const drained = await waitForDrained()
    expect(drained).toContain('launch notepad.exe')

    await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), makeResponse().res)
  }, 30000)

  it('frames helper stdout as multipart JPEG parts', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    void routes.get('/api/server/sandbox/stream')!(makeRequest('GET'), captured.res)
    await wait(3000)

    const body = Buffer.concat(captured.chunks)
    expect(captured.res.getHeader('content-type')).toBe('multipart/x-mixed-replace; boundary=frame')
    expect(body.length).toBeGreaterThan(0)

    const text = body.toString('latin1')
    expect(text.startsWith('--frame\r\n')).toBe(true)
    expect(text).toContain('Content-Type: image/jpeg')
    expect(text).toContain('Content-Length: 14')

    // The part's payload must be the helper's own JPEG bytes.
    const headerEnd = body.indexOf('\r\n\r\n')
    expect(headerEnd).toBeGreaterThan(0)
    expect([...body.subarray(headerEnd + 4, headerEnd + 6)]).toEqual([0xFF, 0xD8])

    await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), makeResponse().res)
  }, 30000)

  it('rejects a viewport that is not a positive bounded integer', async () => {
    const routes = await setupApp()
    // 5120 is the physical-pixel cap: one past it is refused.
    for (const body of ['{}', '{ "width": 0, "height": 10 }', '{ "width": 5121, "height": 10 }', '{ "width": 10, "height": 999999 }']) {
      const captured = makeResponse()
      await routes.get('/api/server/sandbox/size')!(makeRequest('POST', body), captured.res)
      await captured.done
      expect(captured.res.statusCode).toBe(400)
      const parsed = JSON.parse(Buffer.concat(captured.chunks).toString()) as { ok: boolean }
      expect(parsed.ok).toBe(false)
    }
  })

  it('reports a conflict when no helper is running', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/size')!(makeRequest('POST', '{ "width": 640, "height": 480 }'), captured.res)
    await captured.done
    expect(captured.res.statusCode).toBe(409)
  })

  it('delivers the viewport to the helper and stops it on request', async () => {
    const routes = await setupApp()
    const stream = makeResponse()
    void routes.get('/api/server/sandbox/stream')!(makeRequest('GET'), stream.res)
    await wait(3000)

    const size = makeResponse()
    await routes.get('/api/server/sandbox/size')!(makeRequest('POST', '{ "width": 520, "height": 390 }'), size.res)
    await size.done
    expect(size.res.statusCode).toBe(200)
    expect(JSON.parse(Buffer.concat(size.chunks).toString())).toEqual({ ok: true, width: 520, height: 390 })

    const drained = await waitForDrained()
    expect(drained).toContain('size 520 390')

    const stop = makeResponse()
    await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), stop.res)
    await stop.done
    expect(stop.res.statusCode).toBe(200)
    const stopParsed = JSON.parse(Buffer.concat(stop.chunks).toString()) as { stopped: boolean }
    expect(stopParsed.stopped).toBe(true)

    // The helper exits on `quit`, so a second stop finds nothing to stop.
    const again = makeResponse()
    await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), again.res)
    await again.done
    const againParsed = JSON.parse(Buffer.concat(again.chunks).toString()) as { stopped: boolean }
    expect(againParsed.stopped).toBe(false)
  }, 40000)

  it('supports session-scoped launch, status, and stop', async () => {
    const routes = await setupApp()
    const sessionId = 'session-test-42'

    // Check status before launch (inactive)
    const statusBefore = makeResponse()
    await routes.get('/api/server/sandbox/status')!(
      Object.assign(makeRequest('GET'), { url: `/?session=${sessionId}` }),
      statusBefore.res,
    )
    await statusBefore.done
    expect(JSON.parse(Buffer.concat(statusBefore.chunks).toString())).toMatchObject({
      ok: true,
      session: sessionId,
      active: false,
      desktop: 'dsh-sb-sessiontest42',
    })

    // Launch into this session
    const launch = makeResponse()
    await routes.get('/api/server/sandbox/launch')!(
      makeRequest('POST', JSON.stringify({ command: 'calc.exe', sessionId })),
      launch.res,
    )
    await launch.done
    expect(launch.res.statusCode).toBe(200)
    expect(JSON.parse(Buffer.concat(launch.chunks).toString())).toEqual({
      ok: true,
      command: 'calc.exe',
      session: sessionId,
      desktop: 'dsh-sb-sessiontest42',
    })

    const drained = await waitForDrained()
    expect(drained).toContain('launch calc.exe')

    // Set FPS dynamically
    const fpsRes = makeResponse()
    await routes.get('/api/server/sandbox/fps')!(
      makeRequest('POST', JSON.stringify({ sessionId, fps: 60 })),
      fpsRes.res,
    )
    await fpsRes.done
    expect(JSON.parse(Buffer.concat(fpsRes.chunks).toString())).toEqual({
      ok: true,
      fps: 60,
      updated: true,
    })

    // Status now active
    const statusAfter = makeResponse()
    await routes.get('/api/server/sandbox/status')!(
      Object.assign(makeRequest('GET'), { url: `/?session=${sessionId}` }),
      statusAfter.res,
    )
    await statusAfter.done
    expect(JSON.parse(Buffer.concat(statusAfter.chunks).toString())).toMatchObject({
      ok: true,
      session: sessionId,
      active: true,
      desktop: 'dsh-sb-sessiontest42',
    })

    // Stop this specific session
    const stop = makeResponse()
    await routes.get('/api/server/sandbox/stop')!(
      makeRequest('POST', JSON.stringify({ sessionId })),
      stop.res,
    )
    await stop.done
    expect(JSON.parse(Buffer.concat(stop.chunks).toString())).toEqual({
      ok: true,
      stopped: true,
      session: sessionId,
    })
  }, 40000)

  it('supports multi-instance creation, listing, attaching, and termination', async () => {
    const routes = await setupApp()
    const sessionId = 'session-multitest'

    // Create first instance
    const create1 = makeResponse()
    await routes.get('/api/server/sandbox/instances/create')!(
      makeRequest('POST', JSON.stringify({ sessionId, type: 'win32' })),
      create1.res,
    )
    await create1.done
    interface InstanceResult {
      ok: boolean
      instance: {
        id: string
        ownerSessionId: string
        name: string
        desktopName: string
      }
    }
    const res1 = JSON.parse(Buffer.concat(create1.chunks).toString()) as InstanceResult
    expect(res1.ok).toBe(true)
    expect(res1.instance.ownerSessionId).toBe(sessionId)
    expect(res1.instance.name).toBe('Masaüstü #1')
    expect(res1.instance.desktopName).toBe('dsh-sb-sessionmultitest')

    // Create second instance for same session
    const create2 = makeResponse()
    await routes.get('/api/server/sandbox/instances/create')!(
      makeRequest('POST', JSON.stringify({ sessionId, type: 'win32' })),
      create2.res,
    )
    await create2.done
    const res2 = JSON.parse(Buffer.concat(create2.chunks).toString()) as InstanceResult
    expect(res2.ok).toBe(true)
    expect(res2.instance.name).toBe('Masaüstü #2')
    expect(res2.instance.desktopName).toBe('dsh-sb-sessionmultitest-2')

    // List instances
    const listRes = makeResponse()
    await routes.get('/api/server/sandbox/instances')!(
      makeRequest('GET'),
      listRes.res,
    )
    await listRes.done
    interface ListResult {
      ok: boolean
      instances: Array<{ id: string }>
    }
    const listPayload = JSON.parse(Buffer.concat(listRes.chunks).toString()) as ListResult
    expect(listPayload.ok).toBe(true)
    expect(listPayload.instances.some((i: { id: string }) => i.id === res1.instance.id)).toBe(true)
    expect(listPayload.instances.some((i: { id: string }) => i.id === res2.instance.id)).toBe(true)

    // Attach second instance to another session
    const otherSession = 'session-other'
    const attachRes = makeResponse()
    await routes.get('/api/server/sandbox/instances/attach')!(
      makeRequest('POST', JSON.stringify({ targetSessionId: otherSession, instanceId: res2.instance.id })),
      attachRes.res,
    )
    await attachRes.done
    expect(JSON.parse(Buffer.concat(attachRes.chunks).toString())).toEqual({
      ok: true,
      attached: true,
      instanceId: res2.instance.id,
      targetSessionId: otherSession,
    })

    // Terminate instance
    const termRes = makeResponse()
    await routes.get('/api/server/sandbox/instances/terminate')!(
      makeRequest('POST', JSON.stringify({ instanceId: res1.instance.id })),
      termRes.res,
    )
    await termRes.done
    expect(JSON.parse(Buffer.concat(termRes.chunks).toString())).toEqual({
      ok: true,
      terminated: true,
      instanceId: res1.instance.id,
    })
  })

  it('answers the window snapshot for an unknown session without a 404', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/windows')!(
      makeRequest('GET', undefined, '/api/server/sandbox/windows?session=unknown'),
      captured.res,
    )
    await captured.done
    expect(captured.res.statusCode).toBe(200)
    expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toEqual({
      ok: true,
      active: false,
      fresh: false,
      windows: [],
    })
  })

  it('refuses a window snapshot read that is not a GET', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/windows')!(makeRequest('POST', '{}'), captured.res)
    await captured.done
    expect(captured.res.statusCode).toBe(405)
  })

  it('rejects an input batch whose body is not valid JSON', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/input')!(makeRequest('POST', 'not json'), captured.res)
    await captured.done
    expect(captured.res.statusCode).toBe(400)
    expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toMatchObject({ ok: false })
  })

  it('reports a conflict when input targets a desktop with no helper', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/input')!(
      makeRequest('POST', JSON.stringify({ session: 'unknown', events: [] })),
      captured.res,
    )
    await captured.done
    expect(captured.res.statusCode).toBe(409)
    expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toMatchObject({ ok: false })
  })

  it('rejects a window action whose body is not valid JSON', async () => {
    const routes = await setupApp()
    for (const path of ['/api/server/sandbox/windows/focus', '/api/server/sandbox/windows/close']) {
      const captured = makeResponse()
      await routes.get(path)!(makeRequest('POST', '{'), captured.res)
      await captured.done
      expect(captured.res.statusCode).toBe(400)
      expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toMatchObject({ ok: false })
    }
  })

  it('rejects a change read whose paging cursor is invalid', async () => {
    const routes = await setupApp()
    for (const query of ['since=-1', 'limit=0', 'limit=501', 'limit=abc']) {
      const captured = makeResponse()
      await routes.get('/api/server/sandbox/changes')!(
        makeRequest('GET', undefined, `/api/server/sandbox/changes?session=unknown&${query}`),
        captured.res,
      )
      await captured.done
      expect(captured.res.statusCode).toBe(400)
      expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toMatchObject({ ok: false })
    }
  })

  it('refuses a change read that is not a GET', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/changes')!(makeRequest('POST', '{}'), captured.res)
    await captured.done
    expect(captured.res.statusCode).toBe(405)
  })

  it('answers an empty change page for an unknown session', async () => {
    const routes = await setupApp()
    const captured = makeResponse()
    await routes.get('/api/server/sandbox/changes')!(
      makeRequest('GET', undefined, '/api/server/sandbox/changes?session=unknown'),
      captured.res,
    )
    await captured.done
    expect(captured.res.statusCode).toBe(200)
    const page = JSON.parse(Buffer.concat(captured.chunks).toString()) as { ok: boolean; changes: unknown[] }
    expect(page.ok).toBe(true)
    expect(page.changes).toEqual([])
  })

  const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

  /**
   * A response stand-in whose lifecycle events a spec can emit: stream
   * attachment must observe viewer departure through `close`.
   */
  function makeEmitterResponse(): ServerResponse {
    const emitter = new EventEmitter()
    return Object.assign(emitter, {
      once: (event: string, cb: () => void) => emitter.on(event, cb),
      setHeader: () => {},
      getHeader: () => undefined,
      flushHeaders: () => {},
      writeHead: () => {},
      write: () => true,
      end: () => {},
      statusCode: 200,
      destroyed: false,
      writableEnded: false,
    }) as unknown as ServerResponse
  }

  it('pipes daemon frames through the bridge instead of redirecting', async () => {
    internals.useDaemon = true
    const daemon = await startDeamon({ port: 0, persistencePath: false })
    const manager = new DeamonManager({ port: daemon.port, log: quietLog })
    internals.daemonManager = manager
    const routes = await setupApp()
    const bridge = createServer((req, res) => {
      const handler = routes.get((req.url ?? '/').split('?')[0] ?? '/')
      if (handler === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      void handler(req, res)
    })
    await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', () => { resolve() }))
    const port = (bridge.address() as AddressInfo).port

    try {
      const first = await new Promise<{ status: number; contentType: string; location: unknown; head: Buffer }>((resolve, reject) => {
        let head = Buffer.alloc(0)
        const req = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/stream?session=my-session&fps=30`, (res) => {
          res.on('data', (chunk: Buffer) => {
            head = Buffer.concat([head, chunk])
            // One full part is 73 bytes (57 of framing, 14 of JPEG, 2 of
            // trailer); resolve only once the first payload bytes landed.
            if (head.length >= 70) {
              res.destroy()
              resolve({
                status: res.statusCode ?? 0,
                contentType: String(res.headers['content-type']),
                location: res.headers.location,
                head,
              })
            }
          })
          res.on('error', () => { /* destroy ends the client read; the resolve above owns the outcome */ })
        })
        req.on('error', reject)
        req.setTimeout(20000, () => { req.destroy(new Error('first frame timed out')) })
        req.end()
      })

      expect(first.status).toBe(200)
      expect(first.location).toBeUndefined()
      expect(first.contentType).toBe('multipart/x-mixed-replace; boundary=frame')
      expect(first.head.subarray(0, 9).toString('latin1')).toBe('--frame\r\n')
      const headerEnd = first.head.indexOf('\r\n\r\n')
      expect(headerEnd).toBeGreaterThan(0)
      expect([...first.head.subarray(headerEnd + 4, headerEnd + 6)]).toEqual([0xFF, 0xD8])
    } finally {
      internals.daemonManager = undefined
      await manager.stop()
      await new Promise<void>((resolve) => { bridge.close(() => { resolve() }) })
      await daemon.close()
    }
  }, 30000)

  it('survives a daemon that dies mid-stream', async () => {
    internals.useDaemon = true
    const daemon = await startDeamon({ port: 0, persistencePath: false })
    // The death injection below (closeAllConnections) cuts loopback HTTP
    // sockets; the pipe happy path is pinned by 'pipes daemon frames through
    // the bridge instead of redirecting', so this scenario deliberately rides
    // the legacy transport its kill switch understands.
    const manager = new DeamonManager({ port: daemon.port, log: quietLog, transport: 'http' })
    internals.daemonManager = manager
    const routes = await setupApp()
    const bridge = createServer((req, res) => {
      const handler = routes.get((req.url ?? '/').split('?')[0] ?? '/')
      if (handler === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      void handler(req, res)
    })
    await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', () => { resolve() }))
    const port = (bridge.address() as AddressInfo).port

    try {
      let resolveEnded!: () => void
      const ended = new Promise<void>((resolve) => { resolveEnded = resolve })
      let sawBytes = false
      let resolveFirst!: () => void
      const first = new Promise<void>((resolve) => { resolveFirst = resolve })
      const req = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/stream?session=dying-daemon`, (res) => {
        res.on('data', (chunk: Buffer) => {
          if (!sawBytes && chunk.length > 0) {
            sawBytes = true
            resolveFirst()
          }
        })
        res.on('end', () => { resolveEnded() })
        res.on('error', () => { resolveEnded() })
        res.on('close', () => { resolveEnded() })
      })
      req.on('error', () => { resolveEnded() })
      req.end()

      await first
      // Destroy every daemon socket mid-multipart: the bridge must end the
      // viewer cleanly, not crash on the forwarded response error.
      daemon.server.closeAllConnections()
      await Promise.race([ended, wait(8000).then(() => { throw new Error('the viewer was never released') })])

      // The web server must still answer: an unhandled error would have taken it down.
      const alive = await new Promise<number>((resolve, reject) => {
        const probe = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/unknown`, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        probe.on('error', reject)
        probe.end()
      })
      expect(alive).toBe(404)
    } finally {
      internals.daemonManager = undefined
      await manager.stop()
      await new Promise<void>((resolve) => { bridge.close(() => { resolve() }) })
      await daemon.close()
    }
  }, 30000)

  it('answers 502 when the daemon stream connection fails', async () => {
    internals.useDaemon = true
    internals.daemonManager = {
      ensureRunning: async () => ({ port: 1, url: 'http://127.0.0.1:1' }),
      openStream: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1') },
    } as unknown as DeamonManager

    try {
      const routes = await setupApp()
      const captured = makeResponse()
      await routes.get('/api/server/sandbox/stream')!(
        makeRequest('GET', '', '/api/server/sandbox/stream?session=my-session'),
        captured.res,
      )
      await captured.done
      expect(captured.res.statusCode).toBe(502)
      const body = JSON.parse(Buffer.concat(captured.chunks).toString()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('Failed to stream from daemon')
    } finally {
      internals.daemonManager = undefined
    }
  })

  it('answers 503 with a starting hint when the daemon cannot be ensured', async () => {
    internals.useDaemon = true
    internals.daemonManager = {
      ensureRunning: async () => { throw new Error('daemon down') },
    } as unknown as DeamonManager

    try {
      const routes = await setupApp()
      const captured = makeResponse()
      await routes.get('/api/server/sandbox/stream')!(
        makeRequest('GET', '', '/api/server/sandbox/stream?session=my-session'),
        captured.res,
      )
      await captured.done
      expect(captured.res.statusCode).toBe(503)
      expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toMatchObject({ ok: false, starting: true })
    } finally {
      internals.daemonManager = undefined
    }
  })

  it('keeps serving when a viewer leaves before the daemon answers', async () => {
    internals.useDaemon = true
    let daemonHits = 0
    const target = createServer((_req, res) => {
      daemonHits += 1
      res.statusCode = 404
      res.end('late')
    })
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', () => { resolve() }) })
    const targetPort = (target.address() as AddressInfo).port
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    internals.daemonManager = {
      ensureRunning: async () => {
        await startGate
        return { port: targetPort, url: `http://127.0.0.1:${String(targetPort)}` }
      },
      openStream: async (path: string) => await httpStandInStream(targetPort, path),
    } as unknown as DeamonManager
    const routes = await setupApp()
    const bridge = createServer((req, res) => {
      const handler = routes.get((req.url ?? '/').split('?')[0] ?? '/')
      if (handler === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      void handler(req, res)
    })
    await new Promise<void>((resolve) => { bridge.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (bridge.address() as AddressInfo).port

    try {
      const req = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/stream?session=leaving-viewer`)
      // The deliberate disconnect below owns this socket; the reset the daemon's
      // late answer produces must not surface as an uncaught client error.
      req.on('error', () => { /* consumed by the test's own teardown */ })
      req.end()
      // The handler is parked inside ensureRunning; the viewer goes away there,
      // so the daemon's answer lands on a response that no longer has a socket.
      await wait(150)
      req.destroy()
      await wait(200)
      releaseStart()
      await wait(400)
      expect(daemonHits).toBe(1)

      // Writing the header to the dead response must stay inside the guard:
      // an uncaught throw there would take the whole web server down.
      const alive = await new Promise<number>((resolve, reject) => {
        const probe = request(`http://127.0.0.1:${String(port)}/api/server/sandbox/unknown`, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        probe.on('error', reject)
        probe.end()
      })
      expect(alive).toBe(404)
    } finally {
      internals.daemonManager = undefined
      await new Promise<void>((resolve) => { bridge.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
    }
  }, 30000)

  it('keeps the helper alive after the last viewer leaves', async () => {
    const controller = new SandboxController(quietLog, 'dsh-test-persist')
    const viewer = makeEmitterResponse()
    try {
      controller.stream(viewer)
      await wait(1500)
      expect(controller.isActive()).toBe(true)

      ;(viewer as unknown as EventEmitter).emit('close')
      await wait(2500)
      expect(controller.isActive()).toBe(true)
    } finally {
      await controller.stop()
    }
  }, 30000)

  it('reassembles multipart frames across arbitrary chunk splits', () => {
    const payload = Buffer.from([1, 2, 3, 4])
    const part = Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n', 'ascii'),
      payload,
      Buffer.from('\r\n', 'ascii'),
    ])

    // Whole parts, two at once.
    expect(createMultipartFrameParser().push(Buffer.concat([part, part]))).toEqual([payload, payload])

    // Byte by byte: every split point runs through headers, payload, and trailer.
    const byByte = createMultipartFrameParser()
    const seen: Buffer[] = []
    for (const byte of part) seen.push(...byByte.push(Buffer.from([byte])))
    expect(seen).toEqual([payload])

    // Framing residue before a marker is dropped, not painted.
    expect(createMultipartFrameParser().push(Buffer.concat([Buffer.from('junk', 'ascii'), part]))).toEqual([payload])

    // A producer that stops before the trailer still delivers its frame.
    expect(createMultipartFrameParser().push(part.subarray(0, part.length - 2))).toEqual([payload])

    // Bytes without a marker keep only a marker-sized tail.
    const tail = createMultipartFrameParser()
    expect(tail.push(Buffer.from('xy', 'ascii'))).toEqual([])
    expect(tail.push(Buffer.from('abcdefghijklmno', 'ascii'))).toEqual([])
    expect(tail.push(part)).toEqual([payload])
  })

  it('drops a part whose length field cannot resume framing', () => {
    // No content length: the next boundary is unknowable, so the buffer resets.
    const noLength = createMultipartFrameParser()
    expect(noLength.push(Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\nab', 'ascii'))).toEqual([])
    expect(noLength.push(Buffer.from('--frame\r\nContent-Length: 2\r\n\r\nok', 'ascii'))).toEqual([Buffer.from('ok')])

    // A length that is not a safe integer would misplace every later payload.
    const unsafe = createMultipartFrameParser()
    expect(unsafe.push(Buffer.from('--frame\r\nContent-Length: 99999999999999999999\r\n\r\nxx', 'ascii'))).toEqual([])

    // A length past the buffer cap would pin memory on a stalled producer.
    const oversized = createMultipartFrameParser()
    expect(oversized.push(Buffer.from('--frame\r\nContent-Length: 99999999\r\n\r\nxx', 'ascii'))).toEqual([])
    expect(oversized.push(Buffer.from('--frame\r\nContent-Length: 2\r\n\r\nok\r\n', 'ascii'))).toEqual([Buffer.from('ok')])

    // A header block that never completes resets instead of growing forever.
    const flood = createMultipartFrameParser()
    expect(flood.push(Buffer.concat([Buffer.from('--frame\r\n', 'ascii'), Buffer.alloc(17 * 1024 * 1024, 0x41)]))).toEqual([])
  })

  it('frames helper output as binary messages on the frame socket', async () => {
    // The framing contract is transport-neutral; pin the legacy transport so
    // the scene needs no home gateway lock (the pipe frame path is pinned by
    // 'pipes daemon frames through the bridge instead of redirecting').
    const pinned = new DeamonManager({ log: quietLog, transport: 'http' })
    internals.daemonManager = pinned
    const routes = await setupApp()
    const bridge = await startUpgradeBridge()
    try {
      const viewer = await openViewer(bridge.port, '?fps=12')
      const first = await nextFrame(viewer)
      expect([...first.subarray(0, 2)]).toEqual([0xFF, 0xD8])
      expect(first.length).toBe(14)

      // A second viewer attaches to the same helper; one leaving never stops the other.
      const second = await openViewer(bridge.port, '?fps=12')
      expect((await nextFrame(second)).length).toBe(14)
      await new Promise<void>((resolve) => { viewer.once('close', () => { resolve() }); viewer.close() })
      expect((await nextFrame(second)).length).toBe(14)
      second.close()
    } finally {
      await bridge.close()
      const stop = makeResponse()
      await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), stop.res)
      // The pinned manager owns a spawned daemon child; stopping it keeps the
      // test fork from lingering on the child's stdio past the suite.
      await pinned.stop()
      internals.daemonManager = undefined
    }
  }, 30000)

  it('rejects the handshake before the WebSocket when Connection says so', async () => {
    const routes = await setupApp()
    const bridge = await startUpgradeBridge()
    try {
      connectionRejection = 401
      expect(await handshakeStatus(bridge.port)).toBe(401)
      connectionRejection = 403
      expect(await handshakeStatus(bridge.port)).toBe(403)

      // Clearing the rejection accepts the very same handshake.
      connectionRejection = undefined
      const viewer = await openViewer(bridge.port)
      expect((await nextFrame(viewer)).length).toBe(14)
      viewer.close()
    } finally {
      connectionRejection = undefined
      await bridge.close()
      const stop = makeResponse()
      await routes.get('/api/server/sandbox/stop')!(makeRequest('POST'), stop.res)
    }
  }, 30000)

  it('closes the frame socket when the helper cannot start', async () => {
    await setupApp()
    internals.helperScript = join(tempDir, 'missing-helper.ps1')
    const bridge = await startUpgradeBridge()
    try {
      const viewer = await openViewer(bridge.port)
      expect((await nextClose(viewer)).code).toBe(1011)
    } finally {
      await bridge.close()
    }
  }, 30000)

  it('surfaces daemon failures as retryable closes', async () => {
    internals.useDaemon = true
    const refusedStatus = createServer((_req, res) => { res.statusCode = 404; res.end('gone') })
    await new Promise<void>((resolve) => { refusedStatus.listen(0, '127.0.0.1', () => { resolve() }) })
    const refusedPort = (refusedStatus.address() as AddressInfo).port
    // The frame route captures its daemon manager at registration, so each
    // failure mode registers with its own stand-in.
    const closeCodeFor = async (fake: unknown): Promise<number> => {
      internals.daemonManager = fake as DeamonManager
      await setupApp()
      const bridge = await startUpgradeBridge()
      try {
        const viewer = await openViewer(bridge.port)
        return (await nextClose(viewer)).code
      } finally {
        await bridge.close()
      }
    }
    try {
      expect(await closeCodeFor({
        ensureRunning: async () => ({ port: refusedPort, url: `http://127.0.0.1:${String(refusedPort)}` }),
      })).toBe(1013)
      expect(await closeCodeFor({
        ensureRunning: async () => ({ port: 1, url: 'http://127.0.0.1:1' }),
      })).toBe(1013)
      expect(await closeCodeFor({
        ensureRunning: async () => { throw new Error('daemon starting') },
      })).toBe(1013)
    } finally {
      internals.daemonManager = undefined
      await new Promise<void>((resolve) => { refusedStatus.close(() => { resolve() }) })
    }
  }, 30000)

  it('drops a viewer that leaves while the daemon is starting', async () => {
    internals.useDaemon = true
    const target = createServer((_req, res) => { res.statusCode = 404; res.end('no') })
    let hits = 0
    target.on('request', () => { hits += 1 })
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', () => { resolve() }) })
    const targetPort = (target.address() as AddressInfo).port
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    internals.daemonManager = {
      ensureRunning: async () => {
        await startGate
        return { port: targetPort, url: `http://127.0.0.1:${String(targetPort)}` }
      },
      openStream: async (path: string) => await httpStandInStream(targetPort, path),
    } as unknown as DeamonManager
    // Registration must happen while this stand-in is the captured manager.
    await setupApp()
    const bridge = await startUpgradeBridge()
    try {
      const viewer = await openViewer(bridge.port)
      await new Promise<void>((resolve) => { viewer.once('close', () => { resolve() }); viewer.close() })
      // The client sees the close acknowledgement before the server's own
      // close event settles; the guard must be armed before the daemon resolves.
      await wait(200)
      releaseStart()
      await wait(300)
      // The daemon was never contacted: the left viewer must not reattach.
      expect(hits).toBe(0)
    } finally {
      internals.daemonManager = undefined
      await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
      await bridge.close()
    }
  }, 30000)

  it('closes with a retryable code when the daemon stream dies', async () => {
    internals.useDaemon = true
    // A stand-in daemon speaking the same multipart contract, so the death
    // path needs no desktop and settles deterministically.
    let ticker: NodeJS.Timeout | undefined
    const mini = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
      const part = Buffer.concat([
        Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n', 'ascii'),
        Buffer.from([1, 2, 3, 4]),
        Buffer.from('\r\n', 'ascii'),
      ])
      res.write(part)
      ticker = setInterval(() => { res.write(part) }, 50)
      res.on('close', () => { clearInterval(ticker) })
    })
    await new Promise<void>((resolve) => { mini.listen(0, '127.0.0.1', () => { resolve() }) })
    const miniPort = (mini.address() as AddressInfo).port
    internals.daemonManager = {
      ensureRunning: async () => ({ port: miniPort, url: `http://127.0.0.1:${String(miniPort)}` }),
      openStream: async (path: string) => await httpStandInStream(miniPort, path),
    } as unknown as DeamonManager
    await setupApp()
    const bridge = await startUpgradeBridge()
    try {
      const viewer = await openViewer(bridge.port, '?session=dying-viewer')
      expect((await nextFrame(viewer)).length).toBe(4)
      // Destroy every daemon socket mid-frame: the viewer must land on a
      // retryable close instead of hanging on a stream that never resumes.
      mini.closeAllConnections()
      expect((await nextClose(viewer)).code).toBe(1011)
    } finally {
      internals.daemonManager = undefined
      if (ticker !== undefined) clearInterval(ticker)
      await new Promise<void>((resolve) => { mini.close(() => { resolve() }) })
      await bridge.close()
    }
  }, 30000)

  it('unregisters the frame socket when the plugin fiber is disposed', async () => {
    const routes = await setupApp()
    expect([...upgrades.keys()]).toEqual(['/api/server/sandbox/ws'])
    const bridge = await startUpgradeBridge()
    const viewer = await openViewer(bridge.port, '?session=disposed-fiber')
    await lastCtx!.fiber.dispose()
    expect([...upgrades.keys()]).toEqual([])
    expect(routes.size).toBe(0)
    // Disposal terminates every still-connected viewer; a client that stays
    // open would leak past the unregister it just observed.
    await wait(200)
    expect(viewer.readyState).toBe(WsClient.CLOSED)
    await bridge.close()
  })
})
