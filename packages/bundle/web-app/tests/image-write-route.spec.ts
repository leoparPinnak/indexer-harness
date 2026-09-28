import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'

import { IMAGE_WRITE_PATH, handleImageWrite, registerImageWriteRoute } from '../src/image-write.ts'

const SESSION = 's-image'

/** Minimal request stand-in carrying a JSON body. */
function makeRequest(method: string, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [body]), { method, url: '/' }) as unknown as IncomingMessage
}

/** Minimal response collector: status and the bytes the handler writes. */
function makeResponse(): {
  res: ServerResponse
  status: () => number
  result: () => { status: number; body: unknown }
  text: () => string
} {
  let status = 0
  const chunks: Buffer[] = []
  const res = {
    get statusCode(): number { return status },
    set statusCode(value: number) { status = value },
    setHeader: () => res,
    end: (chunk?: Buffer | string) => { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
  } as unknown as ServerResponse
  const text = (): string => Buffer.concat(chunks).toString('utf8')
  return {
    res,
    text,
    status: () => status,
    result: () => ({ status, body: JSON.parse(text() || '{}') as unknown }),
  }
}

/** A body carrying one image's bytes in base64. */
function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: SESSION,
    path: join(root, 'shot.png'),
    dataBase64: Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64'),
    mode: 'overwrite',
    ...overrides,
  })
}

let root: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-image-write-'))
  outside = mkdtempSync(join(tmpdir(), 'dsh-image-outside-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** A context whose session store resolves {@link SESSION} to the temporary root. */
function makeContext(withSession = true): Context {
  const ctx = new Context()
  ctx.reflect.provide('sessions', {
    get: (id: string) => (withSession && id === SESSION ? { header: { cwd: root } } : undefined),
  })
  return ctx
}

describe('image write route', () => {
  it('replaces the original image and leaves no staging file behind', async () => {
    const target = join(root, 'shot.png')
    writeFileSync(target, 'old')
    const result = await handleImageWrite(makeContext(), makeRequest('POST', body()))
    expect(result).toEqual({ status: 200, body: { ok: true, path: target } })
    expect(readFileSync(target)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
    expect(readdirSync(root)).toEqual(['shot.png'])
  })

  it('writes a copy beside the original in copy mode', async () => {
    const target = join(root, 'shot.png')
    writeFileSync(target, 'old')
    const result = await handleImageWrite(makeContext(), makeRequest('POST', body({ mode: 'copy' })))
    expect(result.body).toEqual({ ok: true, path: join(root, 'shot.annotated.png') })
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'shot.annotated.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
  })

  it('refuses a path outside the session workspace and one that is not an image', async () => {
    const stray = join(outside, 'shot.png')
    writeFileSync(stray, 'old')
    const escaped = await handleImageWrite(makeContext(), makeRequest('POST', body({ path: stray })))
    expect(escaped.status).toBe(403)
    expect(readFileSync(stray, 'utf8')).toBe('old')

    const text = join(root, 'notes.txt')
    writeFileSync(text, 'old')
    const wrongType = await handleImageWrite(makeContext(), makeRequest('POST', body({ path: text })))
    expect(wrongType.status).toBe(403)
    expect(readFileSync(text, 'utf8')).toBe('old')
  })

  it('needs an existing regular file to overwrite, but not to copy', async () => {
    const missing = await handleImageWrite(makeContext(), makeRequest('POST', body()))
    expect(missing.status).toBe(403)
    expect(missing.body).toEqual({ ok: false, error: 'overwrite needs an existing regular file' })

    const directory = join(root, 'folder.png')
    mkdirSync(directory)
    expect((await handleImageWrite(makeContext(), makeRequest('POST', body({ path: directory })))).status).toBe(403)

    const copied = await handleImageWrite(makeContext(), makeRequest('POST', body({ mode: 'copy' })))
    expect(copied.status).toBe(200)
  })

  it('refuses an unknown session, a malformed body, and non-image bytes', async () => {
    expect((await handleImageWrite(makeContext(false), makeRequest('POST', body()))).status).toBe(409)
    expect((await handleImageWrite(makeContext(), makeRequest('POST', '{'))).status).toBe(400)
    expect((await handleImageWrite(makeContext(), makeRequest('POST', body({ mode: 'destroy' })))).status).toBe(400)
    expect((await handleImageWrite(makeContext(), makeRequest('POST', body({ path: 'relative.png' })))).status).toBe(400)
    expect((await handleImageWrite(makeContext(), makeRequest('POST', body({ dataBase64: 'not base64 !!' })))).status).toBe(400)
  })

  it('registers one POST route and refuses other methods', async () => {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    const ctx = makeContext()
    ctx.reflect.provide('webServer', {
      host: '127.0.0.1',
      port: 4567,
      register: (entry: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(entry.path, entry.handler)
        return () => { routes.delete(entry.path) }
      },
    })
    registerImageWriteRoute(ctx)
    const handler = routes.get(IMAGE_WRITE_PATH)
    if (handler === undefined) throw new Error('route was not registered')

    const rejected = makeResponse()
    await handler(makeRequest('GET'), rejected.res)
    expect(rejected.status()).toBe(405)
    expect(rejected.text()).toBe('Method Not Allowed')

    writeFileSync(join(root, 'shot.png'), 'old')
    const accepted = makeResponse()
    await handler(makeRequest('POST', body()), accepted.res)
    expect(accepted.result()).toEqual({ status: 200, body: { ok: true, path: join(root, 'shot.png') } })
  })

  it('refuses a body past the size cap before parsing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const huge = 'x'.repeat(49 * 1024 * 1024)
      const result = await handleImageWrite(makeContext(), makeRequest('POST', huge))
      expect(result.status).toBe(413)
    } finally {
      warn.mockRestore()
    }
  }, 30000)
})
