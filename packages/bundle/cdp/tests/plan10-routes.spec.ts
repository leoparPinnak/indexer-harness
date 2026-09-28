/**
 * Plan 10 §5.7/§8 — REST twins for download / printpdf / readpdf / files:
 * 405s, `{ ok:false, error:{ code, message } }` envelopes (the new shape the
 * forward-compat envelope reserved for additive routes), and the containment
 * guarantee on GET /files (400 for traversal, never a filesystem hit).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CDP_DOWNLOAD_ROUTE,
  CDP_FILES_ROUTE,
  CDP_PRINTPDF_ROUTE,
  CDP_READPDF_ROUTE,
  CDP_STATUS_ROUTE,
  registerCdpRoutes,
} from '../src/routes.ts'
import type { CdpService } from '../src/service.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Captured {
  res: ServerResponse
  status: () => number
  body: () => string
  json: () => any
}

function captureResponse(): Captured {
  let status = 200
  const headers = new Map<string, string>()
  const chunks: string[] = []
  const res = {
    get statusCode() { return status },
    set statusCode(code: number) { status = code },
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), String(value))
      return res
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: (chunk?: string) => {
      if (chunk !== undefined) chunks.push(chunk)
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    body: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')) as any,
  }
}

function makeRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
  const content = bodyJson !== undefined ? JSON.stringify(bodyJson) : ''
  return Object.assign(Readable.from([content]), {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function setupRoutes(overrides: Record<string, unknown>): Map<string, RouteHandler> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, RouteHandler>()
  ctx.provide('webServer', {
    register: (registration: { kind: string, path: string, handler: RouteHandler }) => {
      routes.set(registration.path, registration.handler)
      return () => { routes.delete(registration.path) }
    },
  })
  registerCdpRoutes(ctx, overrides as unknown as CdpService)
  return routes
}

describe('plan10: REST routes', () => {
  it('registers the four new routes next to the existing seven', () => {
    const routes = setupRoutes({})
    for (const path of [CDP_DOWNLOAD_ROUTE, CDP_PRINTPDF_ROUTE, CDP_READPDF_ROUTE, CDP_FILES_ROUTE, CDP_STATUS_ROUTE]) {
      expect(routes.has(path)).toBe(true)
    }
  })

  it('answers 405 with the right Allow header on method mismatches', async () => {
    const routes = setupRoutes({})
    for (const path of [CDP_DOWNLOAD_ROUTE, CDP_PRINTPDF_ROUTE]) {
      const cap = captureResponse()
      await routes.get(path)!(makeRequest('GET', path), cap.res)
      expect(cap.status()).toBe(405)
    }
    const files = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('POST', CDP_FILES_ROUTE, {}), files.res)
    expect(files.status()).toBe(405)
    const readpdf = captureResponse()
    await routes.get(CDP_READPDF_ROUTE)!(makeRequest('PUT', CDP_READPDF_ROUTE), readpdf.res)
    expect(readpdf.status()).toBe(405)
    expect(readpdf.res.getHeader('allow')).toBe('GET, POST')
  })

  it('download action=configure/status/await follow the envelope', async () => {
    const configured: unknown[] = []
    const routes = setupRoutes({
      downloadsRootPath: '/tmp/dl',
      downloadManager: { configure: async () => { configured.push(true) } },
      downloadStatus: () => [{ guid: 'g1', state: 'completed' }],
      downloadNext: async () => ({
        ok: true, state: 'completed', guid: 'g1', suggestedFilename: 'a.bin', path: 'a.bin', bytes: 9, error: undefined,
      }),
    })

    const conf = captureResponse()
    await routes.get(CDP_DOWNLOAD_ROUTE)!(makeRequest('POST', CDP_DOWNLOAD_ROUTE, { action: 'configure' }), conf.res)
    expect(conf.status()).toBe(200)
    expect(conf.json()).toMatchObject({ ok: true, behavior: 'allowAndName', downloadsRoot: '/tmp/dl' })
    expect(configured).toHaveLength(1)

    const statusCap = captureResponse()
    await routes.get(CDP_DOWNLOAD_ROUTE)!(makeRequest('POST', CDP_DOWNLOAD_ROUTE, { action: 'status' }), statusCap.res)
    expect(statusCap.json().downloads).toHaveLength(1)

    const awaitCap = captureResponse()
    await routes.get(CDP_DOWNLOAD_ROUTE)!(makeRequest('POST', CDP_DOWNLOAD_ROUTE, { action: 'await', timeoutMs: 5 }), awaitCap.res)
    expect(awaitCap.status()).toBe(200)
    expect(awaitCap.json()).toMatchObject({ ok: true, path: 'a.bin' })

    const bad = captureResponse()
    await routes.get(CDP_DOWNLOAD_ROUTE)!(makeRequest('POST', CDP_DOWNLOAD_ROUTE, { action: 'nope' }), bad.res)
    expect(bad.status()).toBe(400)
    expect(bad.json().error).toMatchObject({ code: 'BAD_ACTION' })
  })

  it('download await failure uses the object error envelope', async () => {
    const routes = setupRoutes({
      downloadsRootPath: '/tmp/dl',
      downloadNext: async () => ({
        ok: false, state: 'canceled', guid: 'g', suggestedFilename: 'x', path: undefined, bytes: 0,
        error: 'cdp: download: canceled: g',
      }),
    })
    const cap = captureResponse()
    await routes.get(CDP_DOWNLOAD_ROUTE)!(makeRequest('POST', CDP_DOWNLOAD_ROUTE, { action: 'await' }), cap.res)
    expect(cap.status()).toBe(500)
    expect(cap.json()).toEqual({ ok: false, error: { code: 'DOWNLOAD_FAILED', message: 'cdp: download: canceled: g' } })
  })

  it('printpdf returns only projected fields (no bytes) and maps client errors to 400', async () => {
    const received: unknown[] = []
    const routes = setupRoutes({
      printToPdf: async (options: unknown) => {
        received.push(options)
        return { path: 'p.pdf', bytes: 500, pageCount: 2, data: Buffer.from('never-serialized') }
      },
    })
    const ok = captureResponse()
    await routes.get(CDP_PRINTPDF_ROUTE)!(makeRequest('POST', CDP_PRINTPDF_ROUTE, { format: 'A4', filePath: 'p.pdf' }), ok.res)
    expect(ok.status()).toBe(200)
    expect(ok.json()).toEqual({ ok: true, path: 'p.pdf', bytes: 500, pageCount: 2 })
    expect(ok.body()).not.toContain('never-serialized')
    expect(received[0]).toMatchObject({ format: 'A4', saveTo: 'p.pdf' })

    const escaping = setupRoutes({
      printToPdf: async () => {
        throw new Error('cdp: destination exists: p.pdf')
      },
    })
    const bad = captureResponse()
    await escaping.get(CDP_PRINTPDF_ROUTE)!(makeRequest('POST', CDP_PRINTPDF_ROUTE, { saveTo: 'p.pdf' }), bad.res)
    expect(bad.status()).toBe(400)
    expect(bad.json().error).toEqual({ code: 'BAD_REQUEST', message: 'cdp: destination exists: p.pdf' })
  })

  it('readpdf GET/POST resolve and a missing path is a 400 BAD_REQUEST', async () => {
    const routes = setupRoutes({
      readPdf: async (options: { path: string }) => ({
        path: options.path,
        extracted: { pageCount: 1, pages: [{ page: 1, text: 'hi', kind: 'text' }] },
      }),
    })

    const missing = captureResponse()
    await routes.get(CDP_READPDF_ROUTE)!(makeRequest('GET', '/api/server/cdp/readpdf'), missing.res)
    await tick()
    expect(missing.status()).toBe(400)
    expect(missing.json().error).toMatchObject({ code: 'BAD_REQUEST', message: 'cdp: readpdf: path is required' })

    const get = captureResponse()
    await routes.get(CDP_READPDF_ROUTE)!(makeRequest('GET', '/api/server/cdp/readpdf?path=doc.pdf&maxChars=500'), get.res)
    await tick()
    expect(get.status()).toBe(200)
    expect(get.json()).toMatchObject({ ok: true, path: 'doc.pdf', extracted: { pageCount: 1 } })

    const post = captureResponse()
    await routes.get(CDP_READPDF_ROUTE)!(makeRequest('POST', CDP_READPDF_ROUTE, { path: 'doc.pdf', pages: '1-2' }), post.res)
    await tick()
    expect(post.status()).toBe(200)
    expect(post.json().ok).toBe(true)
  })

  it('readpdf maps traversal to 400 with the object envelope', async () => {
    const routes = setupRoutes({
      readPdf: async () => {
        throw new Error('cdp: path escapes downloads root: ../x.pdf')
      },
    })
    const cap = captureResponse()
    await routes.get(CDP_READPDF_ROUTE)!(makeRequest('POST', CDP_READPDF_ROUTE, { path: '../x.pdf' }), cap.res)
    await tick()
    expect(cap.status()).toBe(400)
    expect(cap.json()).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'cdp: path escapes downloads root: ../x.pdf' },
    })
  })

  it('files list/stat/remove operate on the real root and refuse traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-routes-'))
    roots.push(root)
    await writeFile(join(root, 'hello.txt'), 'hi')
    const routes = setupRoutes({ downloadsRootPath: root })

    const list = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=list'), list.res)
    expect(list.status()).toBe(200)
    const names = (list.json().entries as Array<{ name: string }>).map(entry => entry.name)
    expect(names).toContain('hello.txt')

    const filtered = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=list&pattern=hello&limit=1'), filtered.res)
    expect(filtered.json().entries).toHaveLength(1)

    const stat = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=stat&path=hello.txt'), stat.res)
    expect(stat.json()).toMatchObject({ ok: true, type: 'file', size: 2 })

    const escape = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=stat&path=..'), escape.res)
    expect(escape.status()).toBe(400)
    expect(escape.json().error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(escape.json().error.message).toContain('path escapes downloads root')

    const remove = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=remove&path=hello.txt'), remove.res)
    expect(remove.json()).toMatchObject({ ok: true, deleted: true })

    const unknown = captureResponse()
    await routes.get(CDP_FILES_ROUTE)!(makeRequest('GET', '/api/server/cdp/files?action=frobnicate'), unknown.res)
    expect(unknown.status()).toBe(400)
    expect(unknown.json().error).toMatchObject({ code: 'BAD_ACTION' })
  })
})
