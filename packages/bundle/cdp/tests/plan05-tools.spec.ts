/**
 * plan05 tool + route tests: `cdp_dialog`/`cdp_upload` registration, the
 * monotonic branch-1 `tools.guard` (deny set, reason text, targetId
 * pass-through), argument forwarding into the service, output-schema
 * conformance + render for both tools, and the two REST routes (405/200/400/
 * 500 mapping). The tools double mirrors the real registry contract by
 * providing `guard` alongside `register` — the pattern every wave with a new
 * ctx API should copy.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCdpTools } from '../src/tools.ts'
import { CDP_DIALOG_ROUTE, CDP_UPLOAD_ROUTE, registerCdpRoutes } from '../src/routes.ts'
import type { DialogBrief } from '../src/dialog.ts'
import type { CdpDialogResult, CdpService, CdpUploadResult } from '../src/service.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Read a rendered block's text. `output.render` returns the `ContentBlock`
 * union (text/image/…), so the plain `.text` access would not type-check;
 * this narrows structurally in one place instead of casting at every assert.
 */
function textOf(block: unknown): string {
  return typeof block === 'object' && block !== null && 'text' in block
    ? String((block as { text: unknown }).text)
    : ''
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The subset of the tool registry the plan05 plugin consumes. */
type GuardExecution = { name: string; arguments?: unknown }
type GuardFn = (execution: GuardExecution) => string | undefined

interface Boot {
  tools: Map<string, ToolDefinition>
  guards: GuardFn[]
  dialogCalls: Array<Record<string, unknown>>
  uploadCalls: Array<Record<string, unknown>>
  peekCalls: Array<string | undefined>
}

/** Mount registerCdpTools against a recording stub service + registry double. */
async function boot(pending?: DialogBrief): Promise<Boot> {
  const tools = new Map<string, ToolDefinition>()
  const guards: GuardFn[] = []
  const dialogCalls: Array<Record<string, unknown>> = []
  const uploadCalls: Array<Record<string, unknown>> = []
  const peekCalls: Array<string | undefined> = []

  const dialogResult: CdpDialogResult = {
    ok: true,
    targetId: 'T1',
    policy: 'none',
    pending: [],
    recent: [],
  }
  const uploadResult: CdpUploadResult = {
    ok: true,
    targetId: 'T1',
    mode: 'set',
    files: [],
    matched: 0,
    bound: false,
  }

  const serviceStub = {
    peekPendingDialog: (targetId?: string) => {
      peekCalls.push(targetId)
      return pending
    },
    dialog: async (options: Record<string, unknown>) => {
      dialogCalls.push(options)
      return dialogResult
    },
    upload: async (options: Record<string, unknown>) => {
      uploadCalls.push(options)
      return uploadResult
    },
  } as unknown as CdpService

  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    // plan05 pattern: doubles must mirror the REAL registry contract. The
    // plugin calls tools.guard(...) unconditionally (a silent skip would turn
    // a security guard off in tests only), so the double provides it and
    // records the registered predicates instead of faking them away.
    guard: (fn: GuardFn) => {
      guards.push(fn)
      return () => {}
    },
  } as never)

  registerCdpTools(ctx, serviceStub)
  // ctx.inject callbacks (which register the tools and the guard) fire one
  // macrotask after their services resolve — wait for them before asserting.
  await new Promise(resolve => { setTimeout(resolve, 0) })
  return { tools, guards, dialogCalls, uploadCalls, peekCalls }
}

const PENDING: DialogBrief = {
  targetId: 'T1',
  type: 'alert',
  message: 'Stop right there',
  url: 'https://example.test/page',
  ageMs: 12,
}

describe('plan05: tool registration + the branch-1 guard', () => {
  it('registers cdp_dialog and cdp_upload alongside the established set', async () => {
    const { tools } = await boot()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (const name of ['cdp_dialog', 'cdp_upload', 'cdp_status', 'cdp_open', 'cdp_navigate', 'cdp_snapshot', 'cdp_eval', 'cdp_click', 'cdp_type', 'cdp_wait', 'net_capture']) {
      expect([...tools.keys()], `expected ${name}`).toContain(name)
    }
  })

  it('mounts exactly one guard that denies the page-scoped tools with one teaching line', async () => {
    const { guards, peekCalls } = await boot(PENDING)
    expect(guards).toHaveLength(1)
    const guard = guards[0]!

    for (const name of ['cdp_navigate', 'cdp_snapshot', 'cdp_eval', 'cdp_click', 'cdp_type', 'cdp_wait', 'cdp_exec']) {
      const reason = guard({ name, arguments: {} })
      expect(reason, `expected ${name} to be denied`).toBeDefined()
      expect(reason).toContain('dialog-open')
      expect(reason).toContain('cdp_dialog')
      expect(reason).toContain('Stop right there')
    }

    // The answerer, the upload tool (own envelope), and browser-level tools stay open.
    for (const name of ['cdp_dialog', 'cdp_upload', 'cdp_status', 'cdp_tabs', 'net_capture', 'cdp_text']) {
      expect(guard({ name, arguments: {} }), `expected ${name} to pass`).toBeUndefined()
    }
    expect(peekCalls.length).toBeGreaterThan(0)
  })

  it('passes execution.targetId through and stays open with no pending dialog', async () => {
    const { guards, peekCalls } = await boot()
    const guard = guards[0]!
    expect(guard({ name: 'cdp_eval', arguments: { targetId: 'T9', expression: '1' } })).toBeUndefined()
    expect(peekCalls).toContain('T9')

    const pendingBoot = await boot(PENDING)
    const pendingGuard = pendingBoot.guards[0]!
    expect(pendingGuard({ name: 'cdp_eval', arguments: { targetId: 'T9' } })).toContain('dialog-open')
    expect(pendingBoot.peekCalls).toContain('T9')
  })
})

describe('plan05: cdp_dialog tool contract', () => {
  it('forwards arguments into the service without inventing keys', async () => {
    const { tools, dialogCalls } = await boot()
    const dialog = tools.get('cdp_dialog')!

    await dialog.execute!({}, {} as never)
    expect(dialogCalls[0]).toEqual({})

    await dialog.execute!(
      { action: 'accept', targetId: 'T1', promptText: 'typed', policy: 'dismiss' },
      {} as never,
    )
    expect(dialogCalls[1]).toEqual({
      action: 'accept',
      targetId: 'T1',
      promptText: 'typed',
      policy: { action: 'dismiss' },
    })
  })

  it('satisfies its declared output schema for success and failure shapes', async () => {
    const { tools } = await boot()
    const schema = tools.get('cdp_dialog')!.output.schema as never

    const success = {
      ok: true,
      targetId: 'T1',
      policy: 'accept',
      pending: [{ targetId: 'T1', type: 'alert', message: 'Stop', url: 'https://x.test/', defaultPrompt: 'd', ageMs: 12 }],
      recent: [
        { targetId: 'T1', type: 'confirm', message: 'Ok?', url: 'https://x.test/', ageMs: 40, answered: 'auto-accepted' },
        { targetId: 'T1', type: 'prompt', message: 'Name?', url: '', ageMs: 7 },
      ],
      answered: { action: 'accepted', promptText: 'typed' },
    }
    expect(validateJsonSchemaValue(schema, success)).toEqual([])

    const failure = {
      ok: false,
      targetId: '',
      policy: 'none',
      pending: [],
      recent: [],
      error: { code: 'no-dialog', message: 'cdp_dialog: no dialog is pending' },
    }
    expect(validateJsonSchemaValue(schema, failure)).toEqual([])

    // The schema stays strict: an undeclared key must be rejected.
    const violations = validateJsonSchemaValue(schema, { ...success, unexpected: 'field' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unexpected')
  })

  it('renders a pending list and a failure line without throwing', async () => {
    const { tools } = await boot()
    const output = tools.get('cdp_dialog')!.output

    const blocks = output.render({}, {
      ok: true,
      targetId: 'T1',
      policy: 'none',
      pending: [{ targetId: 'T1', type: 'alert', message: 'Stop', url: 'https://x.test/', ageMs: 12 }],
      recent: [],
    } as never)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(textOf(blocks[0])).toContain('1 pending')
    expect(textOf(blocks[0])).toContain('Stop')

    const failed = output.render({}, {
      ok: false,
      targetId: '',
      policy: 'none',
      pending: [],
      recent: [],
      error: { code: 'no-dialog', message: 'cdp_dialog: no dialog is pending — list first' },
    } as never)
    expect(textOf(failed[0])).toContain('failed [no-dialog]')
  })
})

describe('plan05: cdp_upload tool contract', () => {
  it('forwards only string files and typed option fields', async () => {
    const { tools, uploadCalls } = await boot()
    const upload = tools.get('cdp_upload')!

    await upload.execute!(
      { files: ['/abs/a.txt', '/abs/b.txt'], selector: '#file', targetId: 'T1', chooser: false, timeoutMs: 1_500 },
      {} as never,
    )
    expect(uploadCalls[0]).toEqual({
      files: ['/abs/a.txt', '/abs/b.txt'],
      selector: '#file',
      targetId: 'T1',
      chooser: false,
      timeoutMs: 1_500,
    })

    // Absent optional keys stay absent — never `key: undefined`.
    await upload.execute!({ files: ['/abs/a.txt'] }, {} as never)
    expect(uploadCalls[1]).toEqual({ files: ['/abs/a.txt'] })

    // Non-string entries never reach the body: defineTool's argument
    // validator rejects them first (ToolArgsError), so the schema is the gate.
    await expect(upload.execute!({ files: ['/abs/a.txt', 42] }, {} as never)).rejects.toThrow('files[1]')
    expect(uploadCalls).toHaveLength(2)
  })

  it('satisfies its declared output schema for success and failure shapes', async () => {
    const { tools } = await boot()
    const schema = tools.get('cdp_upload')!.output.schema as never

    const success = {
      ok: true,
      targetId: 'T1',
      mode: 'set',
      files: [{ path: 'C:\\data\\a.txt', name: 'a.txt', size: 3 }],
      matched: 1,
      bound: true,
      input: { tag: 'input', accept: '.txt', multiple: true, verified: true, fileList: ['a.txt'] },
    }
    expect(validateJsonSchemaValue(schema, success)).toEqual([])

    // `input.accept` absent must still validate (conditional key, not undefined).
    const noAccept = { ...success, input: { tag: 'input', multiple: false, verified: true, fileList: ['a.txt'] } }
    expect(validateJsonSchemaValue(schema, noAccept)).toEqual([])

    const failure = {
      ok: false,
      targetId: '',
      mode: 'chooser',
      files: [],
      matched: 0,
      bound: false,
      error: { code: 'chooser-timeout', message: 'cdp_upload: no file chooser opened within 5000ms' },
    }
    expect(validateJsonSchemaValue(schema, failure)).toEqual([])

    const violations = validateJsonSchemaValue(schema, { ...success, unexpected: 'field' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unexpected')
  })

  it('renders success evidence and a failure line without throwing', async () => {
    const { tools } = await boot()
    const output = tools.get('cdp_upload')!.output

    const blocks = output.render({}, {
      ok: true,
      targetId: 'T1',
      mode: 'set',
      files: [{ path: '/abs/a.txt', name: 'a.txt', size: 3 }],
      matched: 1,
      bound: true,
      input: { tag: 'input', multiple: true, verified: true, fileList: ['a.txt'], accept: '.txt' },
    } as never)
    expect(blocks).toHaveLength(1)
    expect(textOf(blocks[0])).toContain('Bound 1 file(s)')
    expect(textOf(blocks[0])).toContain('verified')

    const failed = output.render({}, {
      ok: false,
      targetId: '',
      mode: 'set',
      files: [],
      matched: 0,
      bound: false,
      error: { code: 'path-forbidden', message: 'cdp_upload: outside every allowed root' },
    } as never)
    expect(textOf(failed[0])).toContain('failed [path-forbidden]')
  })
})

/* --- routes ---------------------------------------------------------------- */

/** Captured HTTP response for route assertions (plan06 pattern). */
function captureResponse(): { res: ServerResponse; status(): number; header(name: string): string | undefined; body(): string } {
  let status = 200
  const headers = new Map<string, string>()
  const chunks: string[] = []
  const res = {
    get statusCode() { return status },
    set statusCode(code: number) { status = code },
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value)
      return res
    },
    end: (chunk?: string) => {
      if (chunk !== undefined) chunks.push(chunk)
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    header: name => headers.get(name.toLowerCase()),
    body: () => chunks.join(''),
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

describe('plan05: dialog + upload REST routes', () => {
  /**
   * Mount the routes against a recording service stub. Each result is
   * configurable so the 200/400/500 mapping can be asserted per branch.
   */
  function setupRoutes(overrides: {
    dialog?: (options: Record<string, unknown>) => Promise<CdpDialogResult>
    upload?: (options: Record<string, unknown>) => Promise<CdpUploadResult>
  } = {}): { routes: Map<string, RouteHandler>; dialogCalls: Array<Record<string, unknown>>; uploadCalls: Array<Record<string, unknown>> } {
    const routes = new Map<string, RouteHandler>()
    const dialogCalls: Array<Record<string, unknown>> = []
    const uploadCalls: Array<Record<string, unknown>> = []
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', {
      register: (entry: { path: string; handler: RouteHandler }) => {
        routes.set(entry.path, entry.handler)
        return () => { routes.delete(entry.path) }
      },
    })
    const okDialog: CdpDialogResult = { ok: true, targetId: '', policy: 'none', pending: [], recent: [] }
    const service = {
      dialog: async (options: Record<string, unknown>) => {
        dialogCalls.push(options)
        return overrides.dialog === undefined ? okDialog : await overrides.dialog(options)
      },
      upload: async (options: Record<string, unknown>) => {
        uploadCalls.push(options)
        return overrides.upload === undefined
          ? { ok: true, targetId: '', mode: 'set', files: [], matched: 0, bound: false } satisfies CdpUploadResult
          : await overrides.upload(options)
      },
    } as unknown as CdpService
    registerCdpRoutes(ctx, service)
    return { routes, dialogCalls, uploadCalls }
  }

  it('registers both routes and refuses wrong methods with Allow', async () => {
    const { routes } = setupRoutes()
    expect(routes.has(CDP_DIALOG_ROUTE)).toBe(true)
    expect(routes.has(CDP_UPLOAD_ROUTE)).toBe(true)

    const bad = captureResponse()
    await routes.get(CDP_DIALOG_ROUTE)!(makeRequest('PUT', CDP_DIALOG_ROUTE, {}), bad.res)
    expect(bad.status()).toBe(405)
    expect(bad.header('allow')).toBe('GET, POST')

    const badUpload = captureResponse()
    await routes.get(CDP_UPLOAD_ROUTE)!(makeRequest('GET', CDP_UPLOAD_ROUTE), badUpload.res)
    expect(badUpload.status()).toBe(405)
    expect(badUpload.header('allow')).toBe('POST')
  })

  it('GET dialog lists with the query targetId; POST forwards the body', async () => {
    const { routes, dialogCalls } = setupRoutes()

    const listed = captureResponse()
    await routes.get(CDP_DIALOG_ROUTE)!(
      makeRequest('GET', `${CDP_DIALOG_ROUTE}?targetId=T1`),
      listed.res,
    )
    expect(listed.status()).toBe(200)
    expect(dialogCalls[0]).toEqual({ targetId: 'T1' })
    expect(JSON.parse(listed.body())).toMatchObject({ ok: true })

    const answered = captureResponse()
    await routes.get(CDP_DIALOG_ROUTE)!(
      makeRequest('POST', CDP_DIALOG_ROUTE, { action: 'accept', targetId: 'T1', promptText: 'hi', policy: 'accept' }),
      answered.res,
    )
    expect(answered.status()).toBe(200)
    expect(dialogCalls[1]).toEqual({
      action: 'accept',
      targetId: 'T1',
      promptText: 'hi',
      policy: { action: 'accept' },
    })
  })

  it('maps dialog/upload failures to 400 and internal refusals to 500', async () => {
    const clientFailure = setupRoutes({
      dialog: async () => ({
        ok: false, targetId: '', policy: 'none', pending: [], recent: [],
        error: { code: 'no-dialog', message: 'cdp_dialog: no dialog is pending' },
      }),
      upload: async () => ({
        ok: false, targetId: '', mode: 'set', files: [], matched: 0, bound: false,
        error: { code: 'path-forbidden', message: 'cdp_upload: outside every allowed root' },
      }),
    })
    const dialog400 = captureResponse()
    await clientFailure.routes.get(CDP_DIALOG_ROUTE)!(
      makeRequest('POST', CDP_DIALOG_ROUTE, { action: 'accept' }),
      dialog400.res,
    )
    expect(dialog400.status()).toBe(400)

    const upload400 = captureResponse()
    await clientFailure.routes.get(CDP_UPLOAD_ROUTE)!(
      makeRequest('POST', CDP_UPLOAD_ROUTE, { files: ['/x'] }),
      upload400.res,
    )
    expect(upload400.status()).toBe(400)

    const serverFailure = setupRoutes({
      upload: async () => ({
        ok: false, targetId: '', mode: 'set', files: [], matched: 0, bound: false,
        error: { code: 'no-session', message: 'cdp_upload: no active browser connection' },
      }),
    })
    const upload500 = captureResponse()
    await serverFailure.routes.get(CDP_UPLOAD_ROUTE)!(
      makeRequest('POST', CDP_UPLOAD_ROUTE, { files: ['/x'] }),
      upload500.res,
    )
    expect(upload500.status()).toBe(500)
    expect(JSON.parse(upload500.body())).toMatchObject({ ok: false, error: { code: 'no-session' } })
  })

  it('returns 500 INTERNAL when the body cannot be parsed', async () => {
    const { routes } = setupRoutes()
    const broken = Object.assign(Readable.from(['{ nope']), {
      method: 'POST',
      url: CDP_UPLOAD_ROUTE,
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage
    const cap = captureResponse()
    await routes.get(CDP_UPLOAD_ROUTE)!(broken, cap.res)
    expect(cap.status()).toBe(500)
    expect(JSON.parse(cap.body())).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})
