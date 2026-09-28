/**
 * The CDP bundle's registrations on a hand-built context: the status route, the
 * `cdp_status` tool, the `app:cdp-status` prompt section, and the fail-loud
 * deployment check. The real Loader composition is covered separately in
 * `loading-composition.spec.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, Config, DEFAULT_PROXY_LISTEN_PORT, DEFAULT_REMOTE_DEBUGGING_PORT } from '../src/index.ts'
import type { Config as CdpConfig } from '../src/index.ts'
import { CDP_STATUS_PATH, readCdpStatus } from '../src/status.ts'

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** The shipped deployment settings, as the bundle patch restates them. */
const CONFIG: CdpConfig = {
  remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
  proxyListenPort: DEFAULT_PROXY_LISTEN_PORT,
  guideAssetsDir: '',
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** One `systemPrompt.section` definition the plugin registered. */
interface PromptSection {
  name: string
  order: number
  text: () => string
}

/** The registrations one `apply` call exposed. */
interface Harness {
  ctx: Context
  routes: Map<string, RouteHandler>
  tools: Map<string, ToolDefinition>
  sections: PromptSection[]
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Minimal request stand-in carrying only the method the handler reads. */
function makeRequest(method: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method, url: CDP_STATUS_PATH }) as unknown as IncomingMessage
}

/** One captured response: status, headers, and body, without a socket. */
interface Captured {
  res: ServerResponse
  status: () => number
  header: (name: string) => string | undefined
  body: () => string
}

/** Collect a response's status, headers, and written bytes. */
function makeResponse(): Captured {
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  let status = 0
  const res = {
    get statusCode(): number { return status },
    set statusCode(value: number) { status = value },
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
    getHeader: (name: string) => headers[name.toLowerCase()],
    end: (chunk?: Buffer | string) => {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
    },
  } as unknown as ServerResponse
  return { res, status: () => status, header: name => headers[name], body: () => Buffer.concat(chunks).toString('utf8') }
}

/**
 * Mount the `cdp` plugin on a fresh context with the given registries present.
 * @param options - registries to leave out, to pin the deferred-registration paths.
 * @returns the booted harness plus the maps the registrations filled.
 */
async function setup(
  options: { tools?: boolean; systemPrompt?: boolean; config?: CdpConfig } = {},
): Promise<Harness> {
  const routes = new Map<string, RouteHandler>()
  const tools = new Map<string, ToolDefinition>()
  const sections: PromptSection[] = []
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('webServer', {
    host: '127.0.0.1',
    port: 4567,
    register: (entry: { path: string; handler: RouteHandler }) => {
      routes.set(entry.path, entry.handler)
      return () => { routes.delete(entry.path) }
    },
  })
  if (options.tools !== false) {
    ctx.reflect.provide('tools', {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
      guard: () => () => {},
    })
  }
  if (options.systemPrompt !== false) {
    ctx.reflect.provide('systemPrompt', {
      getSectionOrder: (key: string) => (key === 'WEB_SURFACE' ? 100 : 0),
      section: (definition: PromptSection) => {
        sections.push(definition)
        return () => {
          const index = sections.indexOf(definition)
          if (index !== -1) sections.splice(index, 1)
        }
      },
    })
  }
  // plan04-fix2: apply resolves once the capture-proxy startup settled, so
  // `proxy.active` is a settled value here, not a race.
  await apply(ctx, options.config ?? CONFIG)
  // Deferred inject callbacks settle one macrotask after their services resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { ctx, routes, tools, sections }
}

describe('cdp status surface', () => {
  it('mounts the status route and answers GET with the local read', async () => {
    const { routes } = await setup()
    const handler = routes.get(CDP_STATUS_PATH)
    expect(handler).toBeDefined()
    const captured = makeResponse()
    await handler?.(makeRequest('GET'), captured.res)
    expect(captured.status()).toBe(200)
    expect(captured.header('content-type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(captured.body())).toEqual({
      ok: true,
      version: PACKAGE_VERSION,
      targets: 0,
      proxy: { active: true },
      connectionState: 'disconnected',
      openTabs: [],
    })
  })

  it('refuses a non-GET status request with 405', async () => {
    const { routes } = await setup()
    const captured = makeResponse()
    await routes.get(CDP_STATUS_PATH)?.(makeRequest('POST'), captured.res)
    expect(captured.status()).toBe(405)
    expect(captured.header('allow')).toBe('GET')
    expect(captured.body()).toBe('Method Not Allowed')
  })

  it('registers cdp_status and answers it with the same local read', async () => {
    const { tools } = await setup()
    const definition = tools.get('cdp_status')
    expect(definition).toBeDefined()
    const value = await definition?.execute({}, {} as never)
    // plan04-fix2: the live tool is service-backed, `readCdpStatus()` is the
    // never-mounted service-less reader (plan01 §5.6) — with the capture
    // proxy now auto-starting, `proxy.active` is the ONE live field that
    // legitimately differs; every shared field must still be identical.
    expect(value).toEqual({ ...readCdpStatus(), proxy: { active: true } })
    const blocks = definition?.output.render({}, value as never)
    expect(blocks).toEqual([{ type: 'text', text: `CDP ${PACKAGE_VERSION}: 0 target(s), proxy active: true.` }])
  })

  it('publishes the app:cdp-status prompt section after WEB_SURFACE', async () => {
    const { sections } = await setup()
    const section = sections.find(entry => entry.name === 'app:cdp-status')
    expect(section?.order).toBe(107)
    expect(section?.text()).toContain('cdp_status')
    expect(section?.text()).toContain('Chrome DevTools Protocol')
  })

  it('keeps the status route when the tools and systemPrompt registries are absent', async () => {
    const { routes, tools, sections } = await setup({ tools: false, systemPrompt: false })
    expect([...routes.keys()]).toContain(CDP_STATUS_PATH)
    expect([...tools.keys()]).toEqual([])
    expect(sections).toEqual([])
  })

  it('removes every registration when the row is disposed', async () => {
    const { ctx, routes, tools, sections } = await setup()
    expect(routes.size).toBeGreaterThanOrEqual(1)
    expect(tools.size).toBeGreaterThanOrEqual(1)
    expect(sections).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
    expect(tools.size).toBe(0)
    expect(sections).toEqual([])
  })

  it('rejects a proxy port that equals the browser debugging port', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const mismatched: CdpConfig = {
      remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
      proxyListenPort: DEFAULT_REMOTE_DEBUGGING_PORT,
      guideAssetsDir: '',
    }
    expect(() => { apply(ctx, mismatched) })
      .toThrow('cdp: proxyListenPort must differ from remoteDebuggingPort')
  })

  it('applies the deployment defaults', () => {
    expect(Config({})).toEqual({
      remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
      proxyListenPort: DEFAULT_PROXY_LISTEN_PORT,
      guideAssetsDir: '',
      // plan10's config rows, asserted here because this spec owns Config's
      // default surface.
      downloadsDir: '',
      maxPdfBytes: 67108864,
      // plan05's upload path policy rows, asserted for the same reason.
      // K2-15: the root check is opt-OUT now (allowAnyPath defaults to true).
      uploadRoots: [],
      allowAnyPath: true,
      // plan04's endpoint discovery probe ports (cdp_endpoints default set).
      discoveryPorts: [9222, 9225, 9333, 9444],
    })
  })

  it('resolves the deployment defaults when the config leaves them out', async () => {
    const { routes } = await setup({ config: {} })
    expect([...routes.keys()]).toContain(CDP_STATUS_PATH)
  })
})
