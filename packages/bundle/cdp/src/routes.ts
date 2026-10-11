/**
 * @deepseek-ai/dsh-cdp/routes — HTTP REST routes mounted on webServer.
 * Provides the web API for the CDP extension status, tab navigation,
 * DOM snapshotting, script evaluation, and lifecycle controls.
 *
 * @module @deepseek-ai/dsh-cdp/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CdpViewportError, errorEnvelope, normalizeScreenshotRequest } from './capture.ts' /* plan06 */
import type { ScreenshotRequest } from './capture.ts' /* plan06 */
import { deleteFile, listFiles, statFile } from './files.ts' /* plan10 */
import { RefStaleError } from './refs.ts' /* plan08 */
import { parseExtractSpec } from './extract.ts' /* plan08 */
import type { CdpService } from './service.ts'

/**
 * GET route reporting the live CDP status — the same payload the
 * `cdp_status` tool answers with (plan01).
 */
export const CDP_STATUS_ROUTE = '/api/server/cdp/status'
/**
 * POST route opening or attaching a browser; a `needsChoice` body stays
 * `ok:true` because it is a report, not a failure (plan13-profile).
 */
export const CDP_OPEN_ROUTE = '/api/server/cdp/open'
/**
 * POST route navigating a tab to `url`; answers `{ ok, frameId, url }` and
 * 400 when `url` is missing.
 */
export const CDP_NAVIGATE_ROUTE = '/api/server/cdp/navigate'
/** GET route listing the open tab targets (`service.targets`). */
export const CDP_TABS_ROUTE = '/api/server/cdp/tabs'
/**
 * GET route capturing a fresh woven snapshot for the optional `targetId`
 * query parameter.
 */
export const CDP_SNAPSHOT_ROUTE = '/api/server/cdp/snapshot'
/**
 * POST route evaluating an `expression` in the page — page-level failures
 * answer 200 with the honest `ok:false` envelope; 500 stays for
 * infrastructure (plan01 §4.4).
 */
export const CDP_EVAL_ROUTE = '/api/server/cdp/eval'
// plan01: one-shot execute with the mandatory error envelope.
/**
 * plan01: POST route for one-shot script execution with the mandatory error
 * envelope — same shape as the `cdp_exec` tool.
 */
export const CDP_EXEC_ROUTE = '/api/server/cdp/exec'
/** POST route closing the target named by `targetId` (or the active one). */
export const CDP_CLOSE_ROUTE = '/api/server/cdp/close'
// plan06: screenshot capture and explicit viewport routes.
/**
 * plan06: POST route capturing a screenshot — JSON only, the image itself
 * always lands on disk; an invalid clip/selector fails 400 before any CDP
 * call.
 */
export const CDP_SCREENSHOT_ROUTE = '/api/server/cdp/screenshot'
/**
 * plan06: POST route for opt-in viewport control — no parameters only
 * reports the live observation, width+height set the device metrics
 * override, `reset` clears it; validation failures answer 400.
 */
export const CDP_VIEWPORT_ROUTE = '/api/server/cdp/viewport'
// plan10: downloads, print-to-PDF, PDF reading, and the file routes.
/**
 * plan10: POST route dispatching download actions — `configure`, `status`,
 * or `await`; an unknown action answers 400 `BAD_ACTION`.
 */
export const CDP_DOWNLOAD_ROUTE = '/api/server/cdp/download'
/**
 * plan10: POST route printing the page to PDF — the body mirrors the
 * `cdp_printpdf` tool, with `saveTo`/`filePath` picking the destination.
 */
export const CDP_PRINTPDF_ROUTE = '/api/server/cdp/printpdf'
/**
 * plan10: GET|POST route extracting text from a PDF file — POST body or GET
 * query params (`path`, `page`, `pageFrom`, `pages`, `maxChars`), with
 * `path` required.
 */
export const CDP_READPDF_ROUTE = '/api/server/cdp/readpdf'
/**
 * plan10: GET route over the downloads root — `action=list|stat|remove`,
 * with `pattern`/`limit` narrowing the listing; unknown actions answer 400.
 */
export const CDP_FILES_ROUTE = '/api/server/cdp/files'
// plan05: dialog inspection/answering and file-input binding routes.
/**
 * plan05: GET|POST route for dialogs — GET `?targetId=` lists open dialogs;
 * POST `{ action, targetId?, promptText?, policy? }` accepts, dismisses, or
 * sets the default policy.
 */
export const CDP_DIALOG_ROUTE = '/api/server/cdp/dialog' /* plan05 */
/**
 * plan05: POST route binding files to a file input or answering a chooser —
 * `{ files[], selector?, targetId?, chooser?, timeoutMs? }`.
 */
export const CDP_UPLOAD_ROUTE = '/api/server/cdp/upload' /* plan05 */
// plan04: endpoint inventory, per-connection pool state, and context lifecycle.
/**
 * plan04: GET route probing loopback debug ports (`?ports=…&timeoutMs=`) and
 * merging the answer with the connection pool, so attached-but-unprobed
 * endpoints (ephemeral launched ports) still get a row.
 */
export const CDP_ENDPOINTS_ROUTE = '/api/server/cdp/endpoints' /* plan04 */
/**
 * plan04: GET route reporting per-connection pool state plus the active
 * connection id, keeping `cdp_status`'s strict schema untouched.
 */
export const CDP_CONNECTIONS_ROUTE = '/api/server/cdp/connections' /* plan04 */
/**
 * plan04: POST route driving context lifecycle —
 * `{ action: list|create|open|dispose, contextId?, url? }`; `open` requires
 * a non-empty `url`.
 */
export const CDP_CONTEXTS_ROUTE = '/api/server/cdp/contexts' /* plan04 */
/**
 * plan04: POST route detaching the ACTIVE endpoint only; every other pooled
 * endpoint stays attached and its reconnect driver keeps running.
 */
export const CDP_DISCONNECT_ROUTE = '/api/server/cdp/disconnect' /* plan04 */
// plan08: ref path — resolve a woven snapshot ref against a fresh document.
/**
 * plan08: POST route resolving a woven snapshot ref against a FRESH
 * document — a stale ref answers 200 `{ ok:false, staleRef:true, reason }`
 * as DATA, not an HTTP failure; 400 is caller input, 500 session/protocol.
 */
export const CDP_REF_ROUTE = '/api/server/cdp/ref' /* plan08 */
/**
 * plan08: POST route discovering elements by `ref`, `selector`, `ariaLabel`,
 * `role`, or `text` — `matched:0` is 200 data, a missing query key is 400.
 */
export const CDP_FIND_ROUTE = '/api/server/cdp/find' /* plan08 */
/**
 * plan08: POST route running a JSON projection spec — the spec is validated
 * host-side before any protocol call (broken spec answers 400), and every
 * projection outcome is 200 data.
 */
export const CDP_EXTRACT_ROUTE = '/api/server/cdp/extract' /* plan08 */

/**
 * Write a JSON response with standard non-cache headers.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read request body as parsed JSON with length ceiling.
 * @param req - incoming request.
 * @param maxBytes - maximum payload bytes allowed.
 * @returns parsed JSON value.
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes = 65_536,
): Promise<T> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    totalBytes += buffer.length
    if (totalBytes > maxBytes) {
      throw new Error('Payload Too Large')
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (raw.trim().length === 0) return {} as T
  return JSON.parse(raw) as T
}

/**
 * plan10: error responder for the new routes — `{ ok:false, error:{ code, message } }`.
 * Caller-input problems (traversal, validation, missing/oversize files) map to
 * `400 BAD_REQUEST`; protocol and runtime failures map to `500 INTERNAL`.
 * Existing routes keep their own string `error` shape untouched.
 * @param res - server response.
 * @param error - caught error (usually `Error('cdp: …')`).
 */
export function respondPlan10Error(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const clientSide = /^cdp: (path escapes|not found|not a directory|is a directory|invalid filename|invalid pages spec|page \d|destination exists|files: unknown|write: content|readpdf: path|.*: not a PDF|.*: exceeds)/.test(message)
    || message === 'Payload Too Large'
  respondJson(res, clientSide ? 400 : 500, {
    ok: false,
    error: { code: clientSide ? 'BAD_REQUEST' : 'INTERNAL', message },
  })
}

/**
 * Register all CDP HTTP REST routes on the webServer.
 * @param ctx - Cordis context carrying webServer.
 * @param service - CdpService instance backing the endpoints.
 */
export function registerCdpRoutes(ctx: Context, service: CdpService): void {
  // Status route
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_STATUS_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      // plan01: the route and the cdp_status tool answer with the same live payload.
      respondJson(res, 200, await service.statusLive())
    },
  }), 'cdp: GET /api/server/cdp/status')

  // Open browser
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_OPEN_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          endpoint?: string
          port?: number
          headless?: boolean
          executablePath?: string
          profile?: string
          switchTo?: number
        }>(req)
        const outcome = await service.open(body)
        // plan13-profile: `ok` is false exactly when `reason` says the call did
        // nothing (invalid profile name, or a profile another browser holds).
        // A `needsChoice` body stays ok:true — it is a report, not a failure.
        respondJson(res, 200, { ok: outcome.reason === undefined, ...outcome })
      } catch (err) {
        respondJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/open')

  // Navigate tab
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_NAVIGATE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ url: string; targetId?: string; timeoutMs?: number }>(req)
        if (typeof body.url !== 'string' || body.url.length === 0) {
          respondJson(res, 400, { ok: false, error: 'url is required' })
          return
        }
        const outcome = await service.navigate(body.url, body.targetId, body.timeoutMs)
        respondJson(res, 200, { ok: true, frameId: outcome.frameId, url: body.url })
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/navigate')

  // List tabs
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_TABS_ROUTE,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      respondJson(res, 200, { ok: true, tabs: service.targets })
    },
  }), 'cdp: GET /api/server/cdp/tabs')

  // Capture snapshot
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_SNAPSHOT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      try {
        const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1')
        const targetId = urlObj.searchParams.get('targetId') ?? undefined
        const snapshot = await service.snapshot(targetId)
        respondJson(res, 200, { ok: true, snapshot })
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: GET /api/server/cdp/snapshot')

  // Evaluate script
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_EVAL_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ expression: string; targetId?: string }>(req)
        if (typeof body.expression !== 'string') {
          respondJson(res, 400, { ok: false, error: 'expression is required' })
          return
        }
        // plan01 §4.4: a page-level failure answers 200 with the honest
        // envelope (ok:false + error); the catch below keeps today's 500
        // shape for infrastructure failures only.
        const meta = await service.evalWithMeta(body.expression, body.targetId)
        respondJson(res, 200, service.buildEvalOutcome(meta.evaluation, meta.targetId, meta.url, meta.documentHidden)) /* plan10-fix */
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/eval')

  // plan01: execute a script with the mandatory error envelope — same shape
  // as the cdp_exec tool. Page-level failures (including postCondition)
  // answer 200; 500 stays reserved for infrastructure.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_EXEC_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          expression?: string
          targetId?: string
          awaitPromise?: boolean
          postCondition?: string
          timeoutMs?: number
        }>(req)
        if (typeof body.expression !== 'string') {
          respondJson(res, 400, { ok: false, error: 'expression is required' })
          return
        }
        const outcome = await service.exec({
          expression: body.expression,
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
          ...(body.awaitPromise === true ? { awaitPromise: true } : {}),
          ...(typeof body.postCondition === 'string' ? { postCondition: body.postCondition } : {}),
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        })
        respondJson(res, 200, outcome)
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/exec')

  // Close target
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_CLOSE_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ targetId?: string }>(req)
        await service.closeTarget(body.targetId)
        respondJson(res, 200, { ok: true })
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/close')

  // plan06: capture a screenshot. JSON only: the image itself always lands on
  // disk, so base64 never crosses REST either; an invalid clip/selector fails
  // as 400 before any CDP call.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_SCREENSHOT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let request: ScreenshotRequest
      try {
        const body = await readJsonBody<Record<string, unknown>>(req)
        request = normalizeScreenshotRequest(body)
      } catch (err) {
        respondJson(res, 400, errorEnvelope(err))
        return
      }
      try {
        const outcome = await service.screenshot(request)
        respondJson(res, 200, { ...outcome, inline: undefined })
      } catch (err) {
        respondJson(res, 500, errorEnvelope(err))
      }
    },
  }), 'cdp: POST /api/server/cdp/screenshot')

  // plan06: opt-in viewport control. Without parameters it only reports the
  // live observation; width+height set Emulation.setDeviceMetricsOverride;
  // reset clears it. Validation failures answer 400, protocol failures 500.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_VIEWPORT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody<Record<string, unknown>>(req)
      } catch (err) {
        respondJson(res, 400, errorEnvelope(err))
        return
      }
      const invalidType
        = (body.width !== undefined && typeof body.width !== 'number')
          || (body.height !== undefined && typeof body.height !== 'number')
          || (body.deviceScaleFactor !== undefined && typeof body.deviceScaleFactor !== 'number')
          || (body.mobile !== undefined && typeof body.mobile !== 'boolean')
          || (body.reset !== undefined && typeof body.reset !== 'boolean')
          || (body.targetId !== undefined && typeof body.targetId !== 'string')
      if (invalidType) {
        respondJson(res, 400, {
          ok: false,
          error: {
            name: 'CdpViewportError',
            message: 'viewport body carries invalid parameter types: width/height/deviceScaleFactor must be numbers, mobile/reset booleans, targetId a string',
          },
        })
        return
      }
      try {
        const outcome = await service.applyViewport({
          ...(typeof body.width === 'number' ? { width: body.width } : {}),
          ...(typeof body.height === 'number' ? { height: body.height } : {}),
          ...(typeof body.deviceScaleFactor === 'number' ? { deviceScaleFactor: body.deviceScaleFactor } : {}),
          ...(typeof body.mobile === 'boolean' ? { mobile: body.mobile } : {}),
          ...(typeof body.reset === 'boolean' ? { reset: body.reset } : {}),
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
        })
        respondJson(res, 200, outcome)
      } catch (err) {
        respondJson(res, err instanceof CdpViewportError ? 400 : 500, errorEnvelope(err))
      }
    },
  }), 'cdp: POST /api/server/cdp/viewport')

  // plan10: downloads — configure / status / await (body `{ action, … }`).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_DOWNLOAD_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          action?: string
          timeoutMs?: number
          renameTo?: string
        }>(req)
        const action = typeof body.action === 'string' ? body.action : ''
        if (action === 'status') {
          respondJson(res, 200, { ok: true, downloads: service.downloadStatus() })
          return
        }
        if (action === 'configure') {
          // behavior/downloadPath from the plan's body shape are ignored — the
          // root comes from config (allowAndName inside it), never from callers.
          await service.downloadManager.configure()
          respondJson(res, 200, { ok: true, downloadsRoot: service.downloadsRootPath, behavior: 'allowAndName' })
          return
        }
        if (action === 'await') {
          const outcome = await service.downloadNext({
            ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
            ...(typeof body.renameTo === 'string' ? { renameTo: body.renameTo } : {}),
          })
          if (!outcome.ok) {
            respondJson(res, 500, {
              ok: false,
              error: { code: 'DOWNLOAD_FAILED', message: outcome.error ?? `cdp: download: ${outcome.state}` },
            })
            return
          }
          respondJson(res, 200, { ...outcome, ok: true })
          return
        }
        respondJson(res, 400, {
          ok: false,
          error: { code: 'BAD_ACTION', message: `cdp: download: unknown action: ${action} (expected configure|status|await)` },
        })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: POST /api/server/cdp/download') /* plan10 */

  // plan10: print round-trip — body mirrors the cdp_printpdf tool.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_PRINTPDF_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          format?: string
          landscape?: boolean
          scale?: number
          printBackground?: boolean
          pageRanges?: string
          targetId?: string
          saveTo?: string
          filePath?: string
        }>(req)
        const destination = typeof body.saveTo === 'string' ? body.saveTo : body.filePath
        const printed = await service.printToPdf({
          ...(typeof body.format === 'string' && (body.format === 'A4' || body.format === 'Letter' || body.format === 'Legal' || body.format === 'Tabloid') ? { format: body.format } : {}),
          ...(typeof body.landscape === 'boolean' ? { landscape: body.landscape } : {}),
          ...(typeof body.scale === 'number' ? { scale: body.scale } : {}),
          ...(typeof body.printBackground === 'boolean' ? { printBackground: body.printBackground } : {}),
          ...(typeof body.pageRanges === 'string' ? { pageRanges: body.pageRanges } : {}),
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
          ...(typeof destination === 'string' ? { saveTo: destination } : {}),
        })
        respondJson(res, 200, { ok: true, path: printed.path, bytes: printed.bytes, pageCount: printed.pageCount })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: POST /api/server/cdp/printpdf') /* plan10 */

  // plan10: PDF reading — POST body, plus GET with query params like /snapshot.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_READPDF_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const query = req.url === undefined ? undefined : new URL(req.url, 'http://localhost').searchParams
      const intParam = (name: string): number | undefined => {
        const raw = query?.get(name)
        if (raw === null || raw === undefined || raw.trim() === '') return undefined
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : undefined
      }
      const strParam = (name: string): string | undefined => {
        const raw = query?.get(name)
        return raw === null || raw === undefined || raw.trim() === '' ? undefined : raw
      }
      const readWith = (options: {
        path?: string | undefined
        page?: number | undefined
        pageFrom?: number | undefined
        pages?: string | undefined
        maxChars?: number | undefined
        includeMeta?: boolean | undefined
      }): void => {
        if (options.path === undefined || options.path.trim() === '') {
          respondJson(res, 400, {
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'cdp: readpdf: path is required' },
          })
          return
        }
        void service.readPdf({
          path: options.path,
          ...(options.page !== undefined ? { page: options.page } : {}),
          ...(options.pageFrom !== undefined ? { pageFrom: options.pageFrom } : {}),
          ...(options.pages !== undefined ? { pages: options.pages } : {}),
          ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
          ...(options.includeMeta !== undefined ? { includeMeta: options.includeMeta } : {}),
        }).then(
          ({ path, extracted }) => respondJson(res, 200, { ok: true, path, extracted }),
          (err: unknown) => { respondPlan10Error(res, err) },
        )
      }
      if (req.method === 'GET') {
        readWith({
          path: strParam('path'),
          page: intParam('page'),
          pageFrom: intParam('pageFrom'),
          pages: strParam('pages'),
          maxChars: intParam('maxChars'),
          ...(query?.get('includeMeta') === 'false' ? { includeMeta: false } : {}),
        })
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          path?: string
          page?: number
          pageFrom?: number
          pages?: string
          maxChars?: number
          includeMeta?: boolean
        }>(req)
        readWith({
          path: typeof body.path === 'string' ? body.path : undefined,
          page: typeof body.page === 'number' ? body.page : undefined,
          pageFrom: typeof body.pageFrom === 'number' ? body.pageFrom : undefined,
          pages: typeof body.pages === 'string' ? body.pages : undefined,
          maxChars: typeof body.maxChars === 'number' ? body.maxChars : undefined,
          ...(typeof body.includeMeta === 'boolean' ? { includeMeta: body.includeMeta } : {}),
        })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: GET|POST /api/server/cdp/readpdf') /* plan10 */

  // plan10: files — GET ?action=list&pattern=&limit= | stat&path= | remove&path=
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_FILES_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      try {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const action = query.get('action') ?? 'list'
        const root = service.downloadsRootPath
        if (action === 'list') {
          const listed = await listFiles(root, query.get('path') ?? '')
          const pattern = query.get('pattern')
          const limitRaw = query.get('limit')
          const limit = limitRaw === null || limitRaw.trim() === '' ? undefined : Number.parseInt(limitRaw, 10)
          let entries = listed.entries
          if (pattern !== null && pattern.trim() !== '') {
            const needle = pattern.toLowerCase()
            entries = entries.filter(entry => entry.name.toLowerCase().includes(needle))
          }
          if (limit !== undefined && Number.isFinite(limit) && limit >= 0) entries = entries.slice(0, limit)
          respondJson(res, 200, { ok: true, path: listed.path, entries })
          return
        }
        if (action === 'stat') {
          const path = query.get('path') ?? ''
          const result = await statFile(root, path)
          respondJson(res, 200, { ok: true, ...result })
          return
        }
        if (action === 'remove') {
          const path = query.get('path') ?? ''
          const result = await deleteFile(root, path, { recursive: query.get('recursive') === 'true' })
          respondJson(res, 200, { ok: true, ...result })
          return
        }
        respondJson(res, 400, {
          ok: false,
          error: { code: 'BAD_ACTION', message: `cdp: files: unknown action: ${action} (expected list|stat|remove)` },
        })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: GET /api/server/cdp/files') /* plan10 */

  // plan05: dialog — GET ?targetId= lists; POST { action, targetId?, promptText?, policy? }.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_DIALOG_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        let result
        if (req.method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://localhost').searchParams
          const targetId = query.get('targetId')
          result = await service.dialog(targetId === null || targetId === '' ? {} : { targetId })
        } else {
          const body = await readJsonBody<{
            action?: string
            targetId?: string
            promptText?: string
            policy?: string
          }>(req)
          result = await service.dialog({
            ...(typeof body.action === 'string' && body.action !== ''
              ? { action: body.action as 'list' | 'accept' | 'dismiss' | 'policy' }
              : {}),
            ...(typeof body.targetId === 'string' && body.targetId !== '' ? { targetId: body.targetId } : {}),
            ...(typeof body.promptText === 'string' ? { promptText: body.promptText } : {}),
            ...(body.policy === 'none' || body.policy === 'accept' || body.policy === 'dismiss'
              ? { policy: { action: body.policy } }
              : {}),
          })
        }
        respondJson(res, plan05Status(result), result)
      } catch (err) {
        respondJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } })
      }
    },
  }), 'cdp: GET|POST /api/server/cdp/dialog') /* plan05 */

  // plan05: upload — POST { files[], selector?, targetId?, chooser?, timeoutMs? }.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_UPLOAD_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          files?: unknown
          selector?: string
          targetId?: string
          chooser?: boolean
          timeoutMs?: number
        }>(req)
        const result = await service.upload({
          files: Array.isArray(body.files)
            ? body.files.filter((entry): entry is string => typeof entry === 'string')
            : [],
          ...(typeof body.selector === 'string' ? { selector: body.selector } : {}),
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
          ...(typeof body.chooser === 'boolean' ? { chooser: body.chooser } : {}),
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        })
        respondJson(res, plan05Status(result), result)
      } catch (err) {
        respondJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } })
      }
    },
  }), 'cdp: POST /api/server/cdp/upload') /* plan05 */

  // plan04: endpoints — GET ?ports=9222,9333&timeoutMs=500 probes loopback
  // debug ports and merges the answer with the connection pool, so attached
  //-but-unprobed endpoints (ephemeral launched ports) still get a row.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_ENDPOINTS_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      try {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const portsRaw = query.get('ports')
        const ports = portsRaw !== null && portsRaw.trim() !== ''
          ? portsRaw.split(',').map(part => Number(part.trim()))
              .filter(port => Number.isInteger(port) && port >= 1 && port <= 65_535)
          : undefined
        const timeoutRaw = query.get('timeoutMs')
        const timeoutMs = timeoutRaw === null || timeoutRaw.trim() === '' ? Number.NaN : Number(timeoutRaw)
        const endpoints = await service.endpointInventory({
          ...(ports !== undefined ? { ports } : {}),
          ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
        })
        respondJson(res, 200, { ok: true, endpoints })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: GET /api/server/cdp/endpoints') /* plan04 */

  // plan04: connections — GET reports per-connection pool state (the
  // `connections`/`activeConnectionId` view declared on CdpStatusResponse but
  // emitted through this route, keeping cdp_status's strict schema untouched).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_CONNECTIONS_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      const activeConnectionId = service.activeConnectionId()
      respondJson(res, 200, {
        ok: true,
        connections: service.connections(),
        ...(activeConnectionId !== undefined ? { activeConnectionId } : {}),
      })
    },
  }), 'cdp: GET /api/server/cdp/connections') /* plan04 */

  // plan04: contexts — POST { action: list|create|open|dispose, contextId?, url? }.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_CONTEXTS_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ action?: unknown, contextId?: unknown, url?: unknown }>(req)
        const action = typeof body.action === 'string' && body.action !== '' ? body.action : 'list'
        if (action !== 'list' && action !== 'create' && action !== 'open' && action !== 'dispose') {
          respondJson(res, 400, {
            ok: false,
            error: { code: 'BAD_ACTION', message: `cdp: contexts: unknown action: ${action} (expected list|create|open|dispose)` },
          })
          return
        }
        const contextId = typeof body.contextId === 'string' ? body.contextId : ''
        const url = typeof body.url === 'string' ? body.url : ''
        if (action === 'open' && url === '') {
          respondJson(res, 400, {
            ok: false,
            error: { code: 'BAD_REQUEST', message: "cdp: contexts: action 'open' requires url" },
          })
          return
        }
        if (action === 'create') {
          const created = await service.createContext()
          respondJson(res, 200, { ok: true, action, contexts: await service.listContexts(), contextId: created.contextId })
          return
        }
        if (action === 'open') {
          const opened = await service.openContextTab(contextId, url)
          respondJson(res, 200, { ok: true, action, contexts: await service.listContexts(), targetId: opened.targetId })
          return
        }
        if (action === 'dispose') {
          const disposed = await service.disposeContext(contextId)
          respondJson(res, 200, { ok: true, action, contexts: await service.listContexts(), closed: disposed.closed })
          return
        }
        respondJson(res, 200, { ok: true, action, contexts: await service.listContexts() })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: POST /api/server/cdp/contexts') /* plan04 */

  // plan04: disconnect — POST detaches the ACTIVE endpoint only; every other
  // pooled endpoint stays attached (its reconnect driver keeps running).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_DISCONNECT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        await service.disconnect()
        respondJson(res, 200, { ok: true })
      } catch (err) {
        respondPlan10Error(res, err)
      }
    },
  }), 'cdp: POST /api/server/cdp/disconnect') /* plan04 */

  // plan08: ref path — resolve a woven snapshot ref against a FRESH document.
  // 200 {ok:true, evidence…} on success; 200 {ok:false, staleRef:true, reason}
  // for a stale ref (a stale ref is DATA, not an HTTP failure); 400 for
  // caller input; 500 for session/protocol refusals (plan03 rejections keep
  // their message text).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_REF_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ ref?: string; targetId?: string }>(req)
        if (typeof body.ref !== 'string' || body.ref === '') {
          respondJson(res, 400, { ok: false, error: 'ref is required' })
          return
        }
        try {
          const evidence = await service.resolveRef(body.ref, body.targetId)
          respondJson(res, 200, { ok: true, resolvedBy: 'ref', ...evidence })
        } catch (err) {
          if (!(err instanceof RefStaleError)) throw err
          respondJson(res, 200, { ok: false, staleRef: true, ref: body.ref, reason: err.message })
        }
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/ref') /* plan08 */

  // plan08: find — discovery answers are DATA: matched>0 → 200 {ok:true,…},
  // matched:0/nth-range → 200 {ok:false, reason, …} (the caller reads the
  // honesty fields), missing query keys → 400, session refusals → 500.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_FIND_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{
          ref?: string
          selector?: string
          ariaLabel?: string
          role?: string
          text?: string
          scope?: string
          nth?: number
          timeoutMs?: number
          targetId?: string
        }>(req)
        const keys = ['ref', 'selector', 'ariaLabel', 'role', 'text'] as const
        const hasQuery = keys.some(key => typeof body[key] === 'string' && body[key] !== '')
        if (!hasQuery) {
          respondJson(res, 400, { ok: false, error: 'pass at least one of ref, selector, ariaLabel, role, text' })
          return
        }
        const outcome = await service.find({
          ...(typeof body.ref === 'string' && body.ref !== '' ? { ref: body.ref } : {}),
          ...(typeof body.selector === 'string' && body.selector !== '' ? { selector: body.selector } : {}),
          ...(typeof body.ariaLabel === 'string' && body.ariaLabel !== '' ? { ariaLabel: body.ariaLabel } : {}),
          ...(typeof body.role === 'string' && body.role !== '' ? { role: body.role } : {}),
          ...(typeof body.text === 'string' && body.text !== '' ? { text: body.text } : {}),
          ...(typeof body.scope === 'string' && body.scope !== '' ? { scope: body.scope } : {}),
          ...(typeof body.nth === 'number' ? { nth: body.nth } : {}),
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
          ...(typeof body.targetId === 'string' && body.targetId !== '' ? { targetId: body.targetId } : {}),
        })
        respondJson(res, 200, outcome)
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/find') /* plan08 */

  // plan08: extract — the spec is validated host-side BEFORE any protocol
  // call, so a broken spec answers 400 {ok:false, error} (plan §4.5); every
  // projection outcome (complete, truncated, or empty-with-missing) is data
  // and answers 200, while session refusals stay 500 with their plan03 text.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CDP_EXTRACT_ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      try {
        const body = await readJsonBody<{ spec?: string; targetId?: string; timeoutMs?: number }>(req)
        if (typeof body.spec !== 'string') {
          respondJson(res, 400, { ok: false, error: 'spec is required (a JSON projection spec)' })
          return
        }
        const parsed = parseExtractSpec(body.spec)
        if (!parsed.ok) {
          respondJson(res, 400, { ok: false, error: parsed.error })
          return
        }
        const outcome = await service.extract({
          spec: body.spec,
          ...(typeof body.targetId === 'string' && body.targetId !== '' ? { targetId: body.targetId } : {}),
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        })
        respondJson(res, 200, outcome)
      } catch (err) {
        respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'cdp: POST /api/server/cdp/extract') /* plan08 */
}

/**
 * plan05: HTTP status for a dialog/upload report. Success is 200; caller-input
 * and state problems (dialog-open, no-dialog, path policy, missing locator)
 * are 400; only session/protocol/verification failures are 500.
 * @param result - a plan05 tool result carrying `ok` and optional `error.code`.
 * @returns 200, 400, or 500.
 */
function plan05Status(result: { ok: boolean; error?: { code?: string } }): number {
  if (result.ok) return 200
  const code = result.error?.code
  return code === 'no-session' || code === 'handle-failed' || code === 'dom-error' ? 500 : 400
}
