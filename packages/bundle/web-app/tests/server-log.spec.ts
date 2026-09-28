import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import {
  clearServerLog,
  getServerLogDir,
  getServerLogPath,
  installExitWitness,
  installLoggerExporter,
  installServerLogTee,
  readServerLogTail,
  registerServerLogRoutes,
  serverLogInternals,
  startAliveTick,
} from '../src/server-log.ts'

/** Minimal request stand-in carrying an optional path. */
function makeRequest(method: string, urlPath = '/'): IncomingMessage {
  const stream = Readable.from([])
  return Object.assign(stream, { method, url: urlPath }) as unknown as IncomingMessage
}

interface Captured {
  res: ServerResponse
  chunks: Buffer[]
  done: Promise<void>
}

/** Collect a response's status and written bytes without a socket. */
function makeResponse(): Captured {
  const chunks: Buffer[] = []
  let status = 0
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const res = {
    get statusCode(): number { return status },
    set statusCode(value: number) { status = value },
    setHeader: () => {},
    getHeader: () => undefined,
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

describe('web-app server log', () => {
  let tempDir: string
  let savedHome: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-server-log-'))
    savedHome = process.env.DSH_HOME
    // The log home is resolved live per call, so specs own their directory.
    process.env.DSH_HOME = tempDir
    mkdirSync(join(tempDir, 'logs'), { recursive: true })
  })

  afterEach(() => {
    serverLogInternals.reset()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function setupApp(): Promise<Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>> {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    const fakeServer = {
      host: '127.0.0.1',
      port: 4567,
      register: (entry: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(entry.path, entry.handler)
        return () => { routes.delete(entry.path) }
      },
    }
    const ctx = new Context()
    ctx.reflect.provide('webServer', fakeServer)
    registerServerLogRoutes(ctx)
    await Promise.resolve()
    return routes
  }

  it('installs the tee once and mirrors both console streams', () => {
    const first = installServerLogTee()
    expect(first).toBe(getServerLogPath())
    expect(installServerLogTee()).toBe(first)

    process.stdout.write('out-line\n')
    process.stderr.write('err-line\n')
    process.stdout.write(Buffer.from('buf-line\n'))
    const text = readFileSync(first as string, 'utf-8')
    expect(text).toContain('out-line')
    expect(text).toContain('err-line')
    expect(text).toContain('buf-line')
  })

  it('stringifies chunks the console would reject, then forwards the rejection', () => {
    const path = installServerLogTee() as string
    expect(() => process.stdout.write(123 as unknown as string)).toThrow()
    expect(readFileSync(path, 'utf-8')).toContain('123')
  })

  it('falls back to the home directory without DSH_HOME', () => {
    delete process.env.DSH_HOME
    try {
      expect(getServerLogDir().endsWith(join('.dsh', 'logs'))).toBe(true)
    } finally {
      process.env.DSH_HOME = tempDir
    }
  })

  it('rotates the live file once writes cross the cap', () => {
    const path = getServerLogPath()
    mkdirSync(join(tempDir, 'logs'), { recursive: true })
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024 - 100))
    expect(installServerLogTee()).toBe(path)
    process.stdout.write(`${'y'.repeat(200)}\n`)
    expect(readFileSync(join(tempDir, 'logs', 'dsh-web.log.1'), 'utf-8')).toContain('x')
    expect(readFileSync(path, 'utf-8')).toBe(`${'y'.repeat(200)}\n`)
  })

  it('rotates an oversized file found at install', () => {
    const path = getServerLogPath()
    writeFileSync(path, `${'x'.repeat(1024)}\n`.repeat(5200))
    expect(installServerLogTee()).toBe(path)
    expect(readFileSync(join(tempDir, 'logs', 'dsh-web.log.1'), 'utf-8')).toContain('x')
    process.stdout.write('fresh\n')
    expect(readFileSync(path, 'utf-8')).toBe('fresh\n')
  })

  it('refuses an uncreatable directory', () => {
    const blocker = join(tempDir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    expect(installServerLogTee(join(blocker, 'dsh-web.log'))).toBeUndefined()
  })

  it('stops teeing after the file becomes unwritable, without throwing', () => {
    const path = installServerLogTee() as string
    process.stdout.write('before\n')
    rmSync(join(tempDir, 'logs'), { recursive: true, force: true })
    expect(() => {
      process.stdout.write('lost\n')
      process.stdout.write('also lost\n')
    }).not.toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('stops teeing when the file turns read-only', () => {
    const path = installServerLogTee() as string
    process.stdout.write('before\n')
    chmodSync(path, 0o444)
    try {
      process.stdout.write('lost\n')
    } finally {
      chmodSync(path, 0o666)
    }
    expect(readFileSync(path, 'utf-8')).toBe('before\n')
  })

  it('mirrors structured logger records into the file', () => {
    installServerLogTee()
    let captured: { export: (message: { ts: number; name: string; type: string; args: unknown[] }) => void } | undefined
    const ctx = {
      logger: {
        exporter: (entry: { export: (message: { ts: number; name: string; type: string; args: unknown[] }) => void }) => {
          captured = entry
          return () => {}
        },
      },
    }
    const dispose = installLoggerExporter(ctx as never)
    captured?.export({ ts: 0, name: 'sandbox', type: 'info', args: ['hello', { n: 1 }] })
    captured?.export({ ts: 0, name: 'x', type: 'error', args: [new Error('boom')] })
    const stackless = new Error('bare')
    delete stackless.stack
    captured?.export({ ts: 0, name: 'x', type: 'error', args: [stackless] })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    captured?.export({ ts: 0, name: 'x', type: 'warn', args: [circular, undefined] })
    void dispose()
    const text = readFileSync(getServerLogPath(), 'utf-8')
    expect(text).toContain('[sandbox] [info] hello {"n":1}')
    expect(text).toContain('boom')
    expect(text).toContain('bare')
    expect(text).toContain('[object Object]')
    expect(text).toContain('undefined')
  })

  it('drops logger records once the file is dead', () => {
    installServerLogTee()
    let captured: { export: (message: { ts: number; name: string; type: string; args: unknown[] }) => void } | undefined
    const ctx = {
      logger: {
        exporter: (entry: { export: (message: { ts: number; name: string; type: string; args: unknown[] }) => void }) => {
          captured = entry
          return () => {}
        },
      },
    }
    installLoggerExporter(ctx as never)
    rmSync(join(tempDir, 'logs'), { recursive: true, force: true })
    expect(() => {
      captured?.export({ ts: 0, name: 'x', type: 'info', args: ['lost'] })
      captured?.export({ ts: 0, name: 'x', type: 'info', args: ['also lost'] })
    }).not.toThrow()
  })

  it('reads a missing file as an empty log', () => {
    expect(readServerLogTail(join(tempDir, 'nope.log'))).toEqual({ lines: [], truncated: false })
  })

  it('tails lines and caps the length', () => {
    const path = getServerLogPath()
    writeFileSync(path, ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n')
    expect(readServerLogTail(path, 10)).toEqual({ lines: ['a', 'b', 'c', 'd', 'e'], truncated: false })
    expect(readServerLogTail(path, 3)).toEqual({ lines: ['c', 'd', 'e'], truncated: true })
  })

  it('keeps an unterminated final line', () => {
    const path = join(tempDir, 'unterminated.log')
    writeFileSync(path, 'a\nb', 'utf-8')
    expect(readServerLogTail(path, 5)).toEqual({ lines: ['a', 'b'], truncated: false })
  })

  it('caps absurd limits at the request maximum', () => {
    const path = getServerLogPath()
    const many = Array.from({ length: 2100 }, (_, i) => `line-${String(i)}`)
    writeFileSync(path, `${many.join('\n')}\n`)
    const tail = readServerLogTail(path, 5000)
    expect(tail.lines).toHaveLength(2000)
    expect(tail.lines[0]).toBe('line-100')
    expect(tail.truncated).toBe(true)
  })

  it('drops the partial first line of a windowed read', () => {
    const path = getServerLogPath()
    writeFileSync(path, `${'y'.repeat(100)}\n`.repeat(6000))
    const tail = readServerLogTail(path, 5)
    expect(tail.truncated).toBe(true)
    expect(tail.lines).toHaveLength(5)
    expect(tail.lines.every(line => line === 'y'.repeat(100))).toBe(true)
  })

  it('falls back to the default tail for unusable limits', () => {
    const path = getServerLogPath()
    writeFileSync(path, 'only\n')
    for (const bad of [0, -4, NaN]) {
      expect(readServerLogTail(path, bad)).toEqual({ lines: ['only'], truncated: false })
    }
  })

  it('clears the live file and reports a missing one', () => {
    const path = getServerLogPath()
    writeFileSync(path, 'old\n')
    expect(clearServerLog(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('')
    expect(clearServerLog(join(tempDir, 'nope.log'))).toBe(false)
  })

  it('serves the tail and honors the limit parameter', async () => {
    writeFileSync(getServerLogPath(), ['one', 'two', 'three'].join('\n') + '\n')
    const routes = await setupApp()

    const full = makeResponse()
    await routes.get('/api/server/logs')!(makeRequest('GET', '/api/server/logs?limit=10'), full.res)
    await full.done
    expect(JSON.parse(Buffer.concat(full.chunks).toString())).toEqual({
      ok: true,
      lines: ['one', 'two', 'three'],
      truncated: false,
    })

    const capped = makeResponse()
    await routes.get('/api/server/logs')!(makeRequest('GET', '/api/server/logs?limit=2'), capped.res)
    await capped.done
    expect(JSON.parse(Buffer.concat(capped.chunks).toString())).toEqual({
      ok: true,
      lines: ['two', 'three'],
      truncated: true,
    })

    const fallback = makeResponse()
    await routes.get('/api/server/logs')!(makeRequest('GET', '/api/server/logs?limit=nope'), fallback.res)
    await fallback.done
    expect(JSON.parse(Buffer.concat(fallback.chunks).toString())).toMatchObject({ ok: true })

    const wrongMethod = makeResponse()
    await routes.get('/api/server/logs')!(makeRequest('POST', '/api/server/logs'), wrongMethod.res)
    await wrongMethod.done
    expect(wrongMethod.res.statusCode).toBe(405)
  })

  it('serves the default tail for a request without a URL', async () => {
    writeFileSync(getServerLogPath(), ['alpha', 'beta'].join('\n') + '\n')
    const routes = await setupApp()
    const bare = Object.assign(Readable.from([]), { method: 'GET' }) as unknown as IncomingMessage

    const captured = makeResponse()
    await routes.get('/api/server/logs')!(bare, captured.res)
    await captured.done
    expect(JSON.parse(Buffer.concat(captured.chunks).toString())).toEqual({
      ok: true,
      lines: ['alpha', 'beta'],
      truncated: false,
    })
  })

  it('clears the log on request and rejects other methods', async () => {
    writeFileSync(getServerLogPath(), 'old\n')
    const routes = await setupApp()

    const cleared = makeResponse()
    await routes.get('/api/server/logs/clear')!(makeRequest('POST', '/api/server/logs/clear'), cleared.res)
    await cleared.done
    expect(JSON.parse(Buffer.concat(cleared.chunks).toString())).toEqual({ ok: true, cleared: true })
    expect(readFileSync(getServerLogPath(), 'utf-8')).toBe('')

    const wrongMethod = makeResponse()
    await routes.get('/api/server/logs/clear')!(makeRequest('GET', '/api/server/logs/clear'), wrongMethod.res)
    await wrongMethod.done
    expect(wrongMethod.res.statusCode).toBe(405)
  })

  it('appends the stopping line when the exit witness runs', () => {
    installServerLogTee()
    installExitWitness()
    installExitWitness() // one listener per process
    serverLogInternals.emitExit(7)
    expect(readFileSync(getServerLogPath(), 'utf-8')).toMatch(/\[web-app\] \[info\] stopping code=7 uptime=\d+s/)
  })

  it('ignores an exit-witness run when none is registered', () => {
    expect(() => { serverLogInternals.emitExit(9) }).not.toThrow()
  })

  it('emits one alive line per interval until disposed', async () => {
    let calls = 0
    const stop = startAliveTick(() => { calls += 1 }, 5)
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
    stop()
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(1)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(calls).toBe(seen)
  })

  it('defaults to the death-signature cadence', () => {
    const stop = startAliveTick(() => {})
    stop()
  })
})
