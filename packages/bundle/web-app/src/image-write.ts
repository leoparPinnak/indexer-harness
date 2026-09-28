/**
 * The image editor's save route: authenticated bytes written back to the
 * session workspace.
 *
 * The workspace file capability is read-only by design — the agent owns writes,
 * and the UI follows them on the change feed — so an edit made in the browser
 * has no other way home. This route is the narrow exception: one image file,
 * inside the session's own workspace, replaced atomically or written beside the
 * original. Everything it refuses, it refuses loudly.
 *
 * A saved file does not travel the agent's change feed, so an open preview keeps
 * the picture it drew until its next reload rather than announcing a change.
 *
 * @module @deepseek-ai/dsh-web-app/image-write
 */

import { existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Route path of the image save endpoint. */
export const IMAGE_WRITE_PATH = '/api/server/image-write'

/** Largest accepted request body, base64 included. */
const MAX_BODY_BYTES = 48 * 1024 * 1024

/** Suffixes this route will write: the formats the preview can render and export. */
const WRITABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Inserted before the extension in `copy` mode. */
const COPY_SUFFIX = '.annotated'

/** How a save lands: over the original, or beside it. */
export type ImageWriteMode = 'overwrite' | 'copy'

/** A validated save request. */
interface SaveRequest {
  readonly sessionId: string
  readonly path: string
  readonly data: Buffer
  readonly mode: ImageWriteMode
}

/** Write a JSON response with the cross-origin headers the other server routes use. */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read the request body, refusing anything past {@link MAX_BODY_BYTES}.
 * @param req - the incoming request.
 * @returns the decoded text, or undefined when the cap was crossed.
 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Canonical base64: the only form whose decode is the bytes the client drew. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/**
 * Validate one parsed save request.
 * @param value - the parsed JSON body.
 * @returns the request, or the reason it cannot be served.
 */
function parseRequest(value: unknown): SaveRequest | string {
  if (typeof value !== 'object' || value === null) return 'body must be a JSON object'
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return 'sessionId is required'
  if (typeof record.path !== 'string' || !isAbsolute(record.path)) return 'path must be an absolute file path'
  if (typeof record.dataBase64 !== 'string' || !isBase64(record.dataBase64)) return 'dataBase64 is not base64 image data'
  if (record.mode !== 'overwrite' && record.mode !== 'copy') return 'mode must be "overwrite" or "copy"'
  const data = Buffer.from(record.dataBase64, 'base64')
  if (data.length === 0) return 'dataBase64 is not base64 image data'
  return { sessionId: record.sessionId, path: record.path, data, mode: record.mode }
}

/**
 * Whether a string is canonical base64 rather than text the decoder would
 * silently salvage by dropping characters it cannot read.
 * @param value - the candidate field.
 * @returns true when the string is base64 and a whole number of quads.
 */
function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64.test(value)
}

/**
 * The session workspace root a save must stay inside.
 * @param ctx - plugin context carrying the session store.
 * @param sessionId - the Session identity the browser sent.
 * @returns the root, or undefined when no such Session is live.
 */
function workspaceRootOf(ctx: Context, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined
  return sessions?.get?.(sessionId)?.header?.cwd
}

/**
 * Decide the file one validated request writes.
 * @param request - the validated request.
 * @param root - the session workspace root.
 * @returns the absolute target path, or the reason the save is refused.
 */
function targetOf(request: SaveRequest, root: string): { path: string } | { error: string } {
  const target = resolve(request.path)
  const within = relative(resolve(root), target)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    return { error: 'path is outside the session workspace' }
  }
  const extension = extname(target).toLowerCase()
  if (!WRITABLE_EXTENSIONS.has(extension)) {
    return { error: `only ${[...WRITABLE_EXTENSIONS].join(', ')} can be written` }
  }
  if (request.mode === 'overwrite') {
    if (!existsSync(target) || !statSync(target).isFile()) return { error: 'overwrite needs an existing regular file' }
    return { path: target }
  }
  return { path: join(dirname(target), `${basename(target, extension)}${COPY_SUFFIX}${extension}`) }
}

/**
 * Write bytes where they land, through a staging file so a reader never sees a
 * half-written image.
 * @param target - the absolute destination.
 * @param data - the complete new content.
 */
function writeAtomically(target: string, data: Buffer): void {
  const staging = `${target}.dsh-image-${randomBytes(6).toString('hex')}`
  writeFileSync(staging, data)
  renameSync(staging, target)
}

/** One save's outcome as JSON. */
interface SaveResult {
  readonly ok: boolean
  readonly path?: string
  readonly error?: string
}

/**
 * Handle one image save.
 * @param ctx - plugin context carrying the session store.
 * @param req - the incoming request.
 * @returns the file written, or the reason it was refused.
 */
export async function handleImageWrite(ctx: Context, req: IncomingMessage): Promise<{ status: number; body: SaveResult }> {
  const raw = await readBody(req)
  if (raw === undefined) return { status: 413, body: { ok: false, error: 'request body is too large' } }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 400, body: { ok: false, error: 'request body is not valid JSON' } }
  }
  const request = parseRequest(parsed)
  if (typeof request === 'string') return { status: 400, body: { ok: false, error: request } }
  const root = workspaceRootOf(ctx, request.sessionId)
  if (root === undefined) return { status: 409, body: { ok: false, error: 'no live session with that id' } }
  const target = targetOf(request, root)
  if ('error' in target) return { status: 403, body: { ok: false, error: target.error } }
  writeAtomically(target.path, request.data)
  return { status: 200, body: { ok: true, path: target.path } }
}

/**
 * Register the image save route on the Web server.
 * @param ctx - plugin context carrying the webServer service.
 */
export function registerImageWriteRoute(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: IMAGE_WRITE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      const result = await handleImageWrite(ctx, req)
      respondJson(res, result.status, result.body)
    },
  }), `web-app: POST ${IMAGE_WRITE_PATH}`)
}
