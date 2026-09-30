import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDeamon, type DeamonHandle } from '../src/deamon.ts'
import { DeamonManager } from '../src/deamon-manager.ts'

/**
 * Daemon-relative paths mirroring the sandbox input, window, and change routes
 * the host bridge forwards through `DeamonManager.forwardJson`.
 */
const ROUTES = ['/input', '/windows', '/windows/focus', '/windows/close', '/changes'] as const

// Specs own their daemon discovery coordinates; the live daemon of this
// machine must never be overwritten or deleted by a test run. The gateway key
// the daemon derives from those coordinates lands in a temp DSH home for the
// same reason: a spec run must not litter the live `~/.dsh/ipc` directory.
let discoveryPath: string
let savedHome: string | undefined
let specHome: string
beforeEach(() => {
  discoveryPath = join(tmpdir(), `dsh-deamon-discovery-${randomUUID()}.json`)
  process.env.DEAMON_DISCOVERY_FILE = discoveryPath
  savedHome = process.env.DSH_HOME
  specHome = mkdtempSync(join(tmpdir(), 'dsh-deamon-home-'))
  process.env.DSH_HOME = specHome
})
afterEach(() => {
  delete process.env.DEAMON_DISCOVERY_FILE
  rmSync(discoveryPath, { force: true })
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  savedHome = undefined
  rmSync(specHome, { recursive: true, force: true })
})

function httpRequest(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const req = request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: options.method ?? (payload ? 'POST' : 'GET'),
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      } : {},
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try {
          json = JSON.parse(data) as Record<string, unknown>
        } catch {
          // Plain text response
        }
        resolve({
          status: res.statusCode ?? 0,
          body: data,
          json,
        })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('deamon microservice', () => {
  let daemon: DeamonHandle | undefined

  afterEach(async () => {
    if (daemon) {
      await daemon.close()
      daemon = undefined
    }
  })

  it('starts on an ephemeral port and responds to /health', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })
    expect(daemon.port).toBeGreaterThan(0)

    const res = await httpRequest(`http://127.0.0.1:${String(daemon.port)}/health`)
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.service).toBe('deamon')
    expect(typeof res.json.pid).toBe('number')
  })

  it('handles CORS options preflight', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })

    const res = await httpRequest(`http://127.0.0.1:${String(daemon.port)}/stream`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
  })

  it('handles /fps dynamic configuration', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })

    const res = await httpRequest(`http://127.0.0.1:${String(daemon.port)}/fps`, {
      method: 'POST',
      body: { fps: 60, sessionId: 'test-session' },
    })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.fps).toBe(60)
  })

  it('serves the mirrored sandbox input, window, and change routes', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })
    const base = `http://127.0.0.1:${String(daemon.port)}`

    // An unknown session is the documented empty window success, never 404.
    const windows = await httpRequest(`${base}/windows?session=unknown`)
    expect(windows.status).toBe(200)
    expect(windows.json).toEqual({ ok: true, active: false, fresh: false, windows: [] })

    const changes = await httpRequest(`${base}/changes?session=unknown`)
    expect(changes.status).toBe(200)
    expect(changes.json.ok).toBe(true)
    expect(changes.json.changes).toEqual([])

    // No helper backs an unknown session: input and window actions conflict.
    const input = await httpRequest(`${base}/input`, {
      method: 'POST',
      body: { session: 'unknown', events: [] },
    })
    expect(input.status).toBe(409)
    const focus = await httpRequest(`${base}/windows/focus`, {
      method: 'POST',
      body: { session: 'unknown', hwnd: 5 },
    })
    expect(focus.status).toBe(409)
    const close = await httpRequest(`${base}/windows/close`, {
      method: 'POST',
      body: { session: 'unknown', hwnd: 5 },
    })
    expect(close.status).toBe(409)

    // A paging cursor outside the frozen range is a 400, not a silent default.
    const paging = await httpRequest(`${base}/changes?session=unknown&limit=0`)
    expect(paging.status).toBe(400)

    // Every mirrored path is registered: an unsupported method answers 405.
    for (const path of ROUTES) {
      const wrongMethod = await httpRequest(`${base}${path}`, { method: 'PATCH' })
      expect(wrongMethod.status).toBe(405)
    }
  })

  it('handles instance lifecycle endpoints', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })
    const base = `http://127.0.0.1:${String(daemon.port)}`

    // Create
    const createRes = await httpRequest(`${base}/instances/create`, {
      method: 'POST',
      body: { sessionId: 'sess-1', type: 'hyperv', vmName: 'TestVM' },
    })
    expect(createRes.status).toBe(200)
    expect(createRes.json.ok).toBe(true)
    const inst = createRes.json.instance as { id: string; name: string }
    expect(inst.id).toBeDefined()

    // List
    const listRes = await httpRequest(`${base}/instances?session=sess-1`)
    expect(listRes.status).toBe(200)
    expect(listRes.json.ok).toBe(true)
    const instances = listRes.json.instances as Array<{ id: string }>
    expect(instances.some(i => i.id === inst.id)).toBe(true)

    // Attach to sess-2
    const attachRes = await httpRequest(`${base}/instances/attach`, {
      method: 'POST',
      body: { targetSessionId: 'sess-2', instanceId: inst.id },
    })
    expect(attachRes.status).toBe(200)
    expect(attachRes.json.ok).toBe(true)

    // Detach from sess-1
    const detachRes = await httpRequest(`${base}/instances/detach`, {
      method: 'POST',
      body: { sessionId: 'sess-1', instanceId: inst.id },
    })
    expect(detachRes.status).toBe(200)
    expect(detachRes.json.ok).toBe(true)

    // Terminate
    const termRes = await httpRequest(`${base}/instances/terminate`, {
      method: 'POST',
      body: { instanceId: inst.id },
    })
    expect(termRes.status).toBe(200)
    expect(termRes.json.ok).toBe(true)
  })
})

describe('DeamonManager lifecycle', () => {
  let daemon: DeamonHandle | undefined
  let manager: DeamonManager | undefined

  afterEach(async () => {
    if (manager) {
      await manager.stop()
      manager = undefined
    }
    if (daemon) {
      await daemon.close()
      daemon = undefined
    }
  })

  it('forwards requests to a running daemon and handles responses', async () => {
    daemon = await startDeamon({ port: 0, persistencePath: false })
    manager = new DeamonManager({
      port: daemon.port,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    })

    const health = await manager.fetchJson<{ ok: boolean; service: string }>('/health')
    expect(health.ok).toBe(true)
    expect(health.service).toBe('deamon')
  })

  it('spawns daemon child process via ensureRunning and stops it cleanly', async () => {
    const infos: string[] = []
    manager = new DeamonManager({
      port: 49750,
      log: {
        info: (message: string) => { infos.push(message) },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    })
    const ready = await manager.ensureRunning()
    expect(ready.port).toBe(49750)
    expect(manager.isActive()).toBe(true)

    const health = await manager.fetchJson<{ ok: boolean; service: string }>('/health')
    expect(health.ok).toBe(true)
    expect(health.service).toBe('deamon')

    // The child's stdout is drained into the log: its startup line arrives here
    // instead of filling the pipe and stalling the daemon.
    expect(infos.some(line => line.includes('deamon stdout:'))).toBe(true)

    await manager.stop()
    expect(manager.isActive()).toBe(false)
  })
})
