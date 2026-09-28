/**
 * plan03: tab lifecycle (cdp_tab_new / cdp_tab_close / cdp_tab_focus), the
 * evidence-based target resolution inside `getPageSession`, the expanded
 * `cdp_tabs` (index/sequence/filter + active marker), and `cdp_scroll`.
 *
 * Three layers are covered:
 *  1. tool registration + output-schema conformance (the `additionalProperties:false`
 *     class of bug that the `cdp_tabs.attached` hotfix caught live),
 *  2. the real `CdpService` resolution/tab/scroll logic against a poked
 *     connection + registry (the pattern plan01 established),
 *  3. a REAL `ws` endpoint proving `connect()` arms `Target.setDiscoverTargets`
 *     and follows `Target.targetActivated` from the browser.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import WebSocket, { WebSocketServer } from 'ws'
import { CdpService } from '../src/service.ts'
import { registerCdpTools } from '../src/tools.ts'
import type { TargetInfo } from '../src/targets.ts'

const NEW_TOOLS = ['cdp_tab_new', 'cdp_tab_close', 'cdp_tab_focus', 'cdp_scroll'] as const

const LEGACY_TOOLS = [
  'cdp_status', 'cdp_open', 'cdp_tabs', 'cdp_navigate', 'cdp_snapshot', 'cdp_eval',
  'cdp_click', 'cdp_type', 'cdp_wait', 'net_capture', 'net_export',
  'cdp_screenshot', 'cdp_viewport', 'cdp_printpdf', 'cdp_download', 'cdp_readpdf',
  'cdp_pdftotext', 'cdp_files', 'cdp_exec',
] as const

const contexts: Context[] = []
const services: CdpService[] = []
const endpoints: Array<{ server: WebSocketServer, sockets: WebSocket[] }> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(services.splice(0).map(service => service.stop().catch(() => {})))
  for (const endpoint of endpoints.splice(0)) {
    for (const socket of endpoint.sockets) socket.terminate()
    await new Promise<void>((resolve) => { endpoint.server.close(() => { resolve() }) })
  }
})

/** Mount the bundle's tool registrations against a stand-in service. */
function bootTools(service: unknown): Map<string, ToolDefinition> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
    guard: () => () => {},
  } as never)
  registerCdpTools(ctx, service as CdpService)
  return tools
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

const violationsOf = (definition: ToolDefinition | undefined, value: unknown): unknown[] =>
  validateJsonSchemaValue(definition!.output.schema as never, value as never)

/** Two tabs: the incident's Migros/LiteLLM pair, so a refusal has candidates. */
function incidentRows(): Array<{ targetId: string, type: string, title: string, url: string, attached: boolean }> {
  return [
    { targetId: 'tab-1', type: 'page', title: 'Migros', url: 'https://migros.test/', attached: true },
    { targetId: 'tab-2', type: 'page', title: 'LiteLLM', url: 'http://localhost:4000/ui/login', attached: true },
  ]
}

/** A service whose tab lifecycle answers from the fixture rows above. */
function fakeService(overrides: Record<string, unknown> = {}): CdpService {
  const rows = incidentRows()
  const base = {
    targets: rows,
    status: () => ({
      ok: true,
      version: '0.0.0',
      targets: rows.length,
      proxy: { active: false },
      connectionState: 'connected',
      openTabs: [],
      activeTargetId: 'tab-1',
      pages: rows.length,
      resolvedBy: 'active',
    }),
    refreshTargets: async (): Promise<void> => {},
    createTab: async (options: { url?: string, focus?: boolean } = {}) => ({
      ok: true,
      targetId: 'tab-9',
      url: options.url ?? 'about:blank',
      title: '',
      focused: options.focus !== false,
      activeTargetId: 'tab-9',
      tabCount: rows.length + 1,
      pages: rows.length + 1,
    }),
    closeTab: async (options: { targetId?: string } = {}) => ({
      ok: true,
      closedTargetId: options.targetId ?? 'tab-1',
      wasActive: (options.targetId ?? 'tab-1') === 'tab-1',
      remainingPages: rows.length - 1,
      activeTargetId: 'tab-2',
      browserClosed: true,
    }),
    focusTab: async (targetId: string) => ({
      ok: true,
      targetId,
      previousTargetId: 'tab-1',
      url: 'https://migros.test/',
      title: 'Migros',
      activated: true,
      pageCount: rows.length,
    }),
    scroll: async (request: Record<string, unknown> = {}) => ({
      ok: true,
      mode: request.mode ?? 'wheel',
      targetId: 'tab-1',
      url: 'https://migros.test/',
      steps: 3,
      deltaX: request.deltaX ?? 0,
      deltaY: request.deltaY ?? 0,
      scrollX: 0,
      scrollY: 1200,
      maxScrollX: 0,
      maxScrollY: 5000,
      atTop: false,
      atBottom: false,
      resolvedBy: 'active',
      ...(request.selector !== undefined || request.anchor !== undefined ? { found: false } : {}),
    }),
  }
  return { ...base, ...overrides } as unknown as CdpService
}

/** Record every CDP frame a poked service sends, and answer plausibly. */
interface Poke {
  readonly service: CdpService
  readonly rows: TargetInfo[]
  readonly sent: Array<{ method: string, params?: Record<string, unknown> | undefined, sessionId?: string | undefined }>
  /** How many registry refreshes (Target.getTargets equivalents) ran. */
  listCalls(): number
}

function pokedService(
  rows: TargetInfo[],
  options: { activeId?: string, scrollBody?: () => string } = {},
): Poke {
  const service = new CdpService()
  services.push(service)
  const sent: Poke['sent'] = []
  const state: { active: TargetInfo | undefined } = {
    active: rows.find(row => row.targetId === options.activeId),
  }
  let listCalls = 0
  const positionOf = options.scrollBody ?? (() =>
    JSON.stringify({ sx: 0, sy: 0, mx: 0, my: 4000, iw: 1000, ih: 800, href: 'https://migros.test/' }))
  const registry = {
    targets: () => [...rows],
    active: () => state.active,
    setActive: (targetId: string) => {
      const found = rows.find(row => row.targetId === targetId)
      if (found === undefined) throw new Error(`unknown ${targetId}`)
      state.active = found
    },
    attachedSession: () => undefined,
    attach: async () => 'session-9',
    list: async () => {
      listCalls += 1
      return [...rows]
    },
    close: async (targetId: string) => {
      const index = rows.findIndex(row => row.targetId === targetId)
      if (index === -1) return false
      rows.splice(index, 1)
      if (state.active?.targetId === targetId) state.active = undefined
      return true
    },
    dispose: () => {},
  }
  const connection = {
    connected: true,
    state: 'connected',
    endpoint: 'ws://127.0.0.1:9222/plan03',
    send: (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
      sent.push({ method, params, sessionId })
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'session-9' })
      if (method === 'Target.createTarget') {
        rows.push({
          targetId: 'created-1',
          type: 'page',
          title: '',
          url: typeof params?.url === 'string' ? params.url : 'about:blank',
          attached: false,
        })
        return Promise.resolve({ targetId: 'created-1' })
      }
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string'
        && params.expression.startsWith('JSON.stringify({ sx')) {
        return Promise.resolve({ result: { value: positionOf() } })
      }
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string'
        && params.expression.includes('scrollIntoView')) {
        return Promise.resolve({ result: { value: JSON.stringify({ found: false }) } })
      }
      return Promise.resolve({})
    },
    on: () => () => {},
    close: () => Promise.resolve(),
  }
  const poke = service as unknown as { connection: unknown, registry: unknown }
  poke.connection = connection
  poke.registry = registry
  return { service, rows, sent, listCalls: () => listCalls }
}

const target = (targetId: string, title: string, url: string): TargetInfo =>
  ({ targetId, type: 'page', title, url, attached: true })

describe('plan03: tool registration', () => {
  it('registers the four new tools alongside the existing set', async () => {
    const tools = bootTools(fakeService())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (const name of NEW_TOOLS) expect([...tools.keys()]).toContain(name)
    for (const name of LEGACY_TOOLS) expect([...tools.keys()]).toContain(name)
    // plan05/plan02: later waves append tools (cdp_dialog, cdp_upload, the
    // locator pair), so an exact count is brittle — presence above is the
    // contract, and the total may only grow.
    expect([...tools.keys()].length).toBeGreaterThanOrEqual(LEGACY_TOOLS.length + NEW_TOOLS.length)
  })
})

describe('plan03: output schema conformance', () => {
  it('every new tool satisfies its own declared output schema', async () => {
    const tools = bootTools(fakeService())
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const created = await execute(tools.get('cdp_tab_new'), { url: 'https://example.test/' })
    expect(violationsOf(tools.get('cdp_tab_new'), created)).toEqual([])

    const closed = await execute(tools.get('cdp_tab_close'), { targetId: 'tab-2' })
    expect(violationsOf(tools.get('cdp_tab_close'), closed)).toEqual([])

    const focused = await execute(tools.get('cdp_tab_focus'), { targetId: 'tab-2' })
    expect(violationsOf(tools.get('cdp_tab_focus'), focused)).toEqual([])

    const wheeled = await execute(tools.get('cdp_scroll'), { deltaY: 600 })
    expect(violationsOf(tools.get('cdp_scroll'), wheeled)).toEqual([])

    const anchored = await execute(tools.get('cdp_scroll'), { mode: 'anchor', anchor: 'pricing' })
    expect(anchored.found).toBe(false)
    expect(violationsOf(tools.get('cdp_scroll'), anchored)).toEqual([])
  })

  it('cdp_tabs accepts rows carrying index/active and still rejects undeclared keys', async () => {
    const tools = bootTools(fakeService())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const tabs = tools.get('cdp_tabs')

    const value = await execute(tabs, { refresh: false })
    expect(violationsOf(tabs, value)).toEqual([])
    const rows = value.tabs as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ targetId: 'tab-1', index: 1, active: true })
    expect(rows[1]).toMatchObject({ targetId: 'tab-2', index: 2, active: false })
    expect(value.activeTargetId).toBe('tab-1')

    const violations = violationsOf(tabs, { ok: true, tabs: [{ targetId: 'T', type: 'page', title: '', url: 'u', attached: false, surprise: 1 }] })
    expect(violations).toHaveLength(1)
    expect(String(violations[0])).toContain('surprise')
  })

  it('cdp_tabs filters by type and query, and reports a failed refresh as stale', async () => {
    const tools = bootTools(fakeService({
      refreshTargets: async () => { throw new Error('socket gone') },
    }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const tabs = tools.get('cdp_tabs')

    const filtered = await execute(tabs, { query: 'lite' })
    const rows = filtered.tabs as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetId).toBe('tab-2')
    expect(filtered.stale).toBe(true)
    expect(violationsOf(tabs, filtered)).toEqual([])
    expect(renderOf(tabs, {}, filtered)).toContain('Active tab: tab-1')
    expect(renderOf(tabs, {}, filtered)).toContain('tracked list, refresh failed')
  })

  it('renders every new tool output without throwing', async () => {
    const tools = bootTools(fakeService())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const samples: Array<[string, Record<string, unknown>]> = [
      ['cdp_tab_new', await execute(tools.get('cdp_tab_new'), {})],
      ['cdp_tab_close', await execute(tools.get('cdp_tab_close'), {})],
      ['cdp_tab_focus', await execute(tools.get('cdp_tab_focus'), { targetId: 'tab-2' })],
      ['cdp_scroll', await execute(tools.get('cdp_scroll'), { deltaY: -300 })],
    ]
    for (const [name, value] of samples) {
      const text = renderOf(tools.get(name), {}, value)
      expect(text.length).toBeGreaterThan(0)
    }
    expect(renderOf(tools.get('cdp_tab_close'), {}, samples[1]![1])).toContain('Closed tab')
  })

  it('cdp_scroll refuses an unknown mode before touching the service', async () => {
    const tools = bootTools(fakeService())
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await expect(execute(tools.get('cdp_scroll'), { mode: 'teleport' })).rejects.toThrow("unknown mode 'teleport'")
  })

  it('cdp_tab_focus and cdp_tab_new forward their arguments', async () => {
    const seen: Array<Record<string, unknown>> = []
    const tools = bootTools(fakeService({
      createTab: async (options: Record<string, unknown>) => { seen.push(options); return { ok: true, targetId: 'x', url: 'u', title: '', focused: true, tabCount: 1, pages: 1 } },
      focusTab: async (targetId: string, activateBrowser: boolean) => { seen.push({ targetId, activateBrowser }); return { ok: true, targetId, url: 'u', title: '', activated: activateBrowser, pageCount: 1 } },
    }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await execute(tools.get('cdp_tab_new'), { url: 'https://a.test/', focus: false })
    await execute(tools.get('cdp_tab_focus'), { targetId: 'tab-2', activateBrowser: false })
    expect(seen[0]).toMatchObject({ url: 'https://a.test/', focus: false })
    expect(seen[1]).toMatchObject({ targetId: 'tab-2', activateBrowser: false })
  })
})

describe('plan03: resolution evidence in CdpService.getPageSession', () => {
  it('refuses an explicit targetId that no refresh can prove', async () => {
    const { service, listCalls } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')])
    await expect(service.getPageSession('ghost-id')).rejects.toThrow('is not tracked; call cdp_tabs')
    // One registry refresh (Target.getTargets) ran before the refusal.
    expect(listCalls()).toBeGreaterThanOrEqual(1)
    expect(service.status().resolvedBy).toBeUndefined()
  })

  it('refuses an omitted targetId when two tabs and no active tab make it unprovable', async () => {
    const { service } = pokedService(incidentRows())
    await expect(service.getPageSession()).rejects.toThrow('cannot prove which of 2 tabs')
    await expect(service.getPageSession()).rejects.toThrow('call cdp_tab_focus')
    expect(service.status().resolvedBy).toBeUndefined()
  })

  it('refuses when no page exists instead of spawning about:blank', async () => {
    const { service, sent } = pokedService([])
    await expect(service.getPageSession()).rejects.toThrow('call cdp_tab_new')
    expect(sent.some(frame => frame.method === 'Target.createTarget')).toBe(false)
  })

  it('resolves the single page by default and reports the evidence', async () => {
    const { service } = pokedService([target('only', 'Home', 'https://home.test/')])
    const session = await service.getPageSession()
    expect(session.sessionId).toBe('session-9')
    const status = service.status()
    expect(status.resolvedBy).toBe('single-page')
    expect(status.activeTargetId).toBe('only')
    expect(status.pages).toBe(1)
    // Explicit ids stay reportable too.
    await service.getPageSession('only')
    expect(service.status().resolvedBy).toBe('explicit')
  })
})

describe('plan03: tab lifecycle on a poked service', () => {
  it('createTab runs Target.createTarget, activates, and reports', async () => {
    const { service, sent } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')])
    const created = await service.createTab({ url: 'https://example.test/' })
    // plan07-fix (T1 Wire A): the target is created on about:blank and the
    // REAL url travels on the seeded Page.navigate, after the profile's UA
    // overrides exist on the session — never on createTarget itself.
    expect(sent.some(frame => frame.method === 'Target.createTarget' && frame.params?.url === 'about:blank')).toBe(true)
    expect(sent.some(frame => frame.method === 'Page.navigate' && frame.params?.url === 'https://example.test/')).toBe(true)
    expect(sent.some(frame => frame.method === 'Emulation.setUserAgentOverride')).toBe(true)
    expect(sent.some(frame => frame.method === 'Target.activateTarget')).toBe(true)
    expect(created).toMatchObject({ ok: true, targetId: 'created-1', focused: true, activeTargetId: 'created-1' })
    expect(created.pages).toBe(2)
    expect(service.status().activeTargetId).toBe('created-1')
  })

  it('createTab(background) leaves the active tab alone', async () => {
    const { service, sent } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')], { activeId: 'tab-1' })
    const created = await service.createTab({ focus: false })
    expect(sent.some(frame => frame.method === 'Target.createTarget' && frame.params?.background === true)).toBe(true)
    expect(sent.some(frame => frame.method === 'Target.activateTarget')).toBe(false)
    expect(created.focused).toBe(false)
    expect(created.activeTargetId).toBe('tab-1')
    expect(service.status().activeTargetId).toBe('tab-1')
  })

  it('createTab enforces the page cap before creating', async () => {
    const many = Array.from({ length: 24 }, (_unused, index) => target(`t${String(index)}`, `P${String(index)}`, 'https://x.test/'))
    const { service, sent } = pokedService(many)
    await expect(service.createTab()).rejects.toThrow('page cap reached')
    expect(sent.some(frame => frame.method === 'Target.createTarget')).toBe(false)
  })

  it('closeTab refuses the last page without force and the active tab without confirmation', async () => {
    const { service } = pokedService([target('solo', 'Only', 'https://solo.test/')], { activeId: 'solo' })
    await expect(service.closeTab({ targetId: 'solo' })).rejects.toThrow('last remaining page tab')
    await expect(service.closeTab()).rejects.toThrow('refusing to close the ACTIVE tab')
    const closed = await service.closeTab({ targetId: 'solo', force: true })
    expect(closed).toMatchObject({ ok: true, closedTargetId: 'solo', wasActive: true, remainingPages: 0, browserClosed: true })
    expect(closed.activeTargetId).toBeUndefined()
  })

  it('closeTab picks a successor when the active tab closes, and leaves focus when it does not', async () => {
    const { service } = pokedService([...incidentRows()], { activeId: 'tab-1' })
    const passive = await service.closeTab({ targetId: 'tab-2' })
    expect(passive.wasActive).toBe(false)
    expect(passive.remainingPages).toBe(1)
    expect(passive.activeTargetId).toBe('tab-1')

    const { service: serviceB } = pokedService([...incidentRows()], { activeId: 'tab-1' })
    const active = await serviceB.closeTab({ targetId: 'tab-1' })
    expect(active.wasActive).toBe(true)
    expect(active.activeTargetId).toBe('tab-2')
    expect(serviceB.status().activeTargetId).toBe('tab-2')
  })

  it('focusTab activates the browser target and reports the previous one', async () => {
    const { service, sent } = pokedService([...incidentRows()], { activeId: 'tab-1' })
    const focused = await service.focusTab('tab-2')
    expect(sent.some(frame => frame.method === 'Target.activateTarget' && frame.params?.targetId === 'tab-2')).toBe(true)
    expect(focused).toMatchObject({
      ok: true,
      targetId: 'tab-2',
      previousTargetId: 'tab-1',
      title: 'LiteLLM',
      url: 'http://localhost:4000/ui/login',
      activated: true,
      pageCount: 2,
    })
    expect(service.status().activeTargetId).toBe('tab-2')
    await expect(service.focusTab('ghost')).rejects.toThrow('is not tracked; call cdp_tabs')
  })
})

describe('plan03: cdp_scroll on a poked service', () => {
  it('wheel mode dispatches real mouseWheel events and reports the position', async () => {
    const { service, sent } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')], { activeId: 'tab-1' })
    const report = await service.scroll({ deltaY: 800 })
    const wheels = sent.filter(frame => frame.method === 'Input.dispatchMouseEvent' && frame.params?.type === 'mouseWheel')
    expect(wheels.length).toBeGreaterThan(0)
    expect(report).toMatchObject({ ok: true, mode: 'wheel', targetId: 'tab-1', resolvedBy: 'active', atTop: true })
    expect(report.deltaY).toBeGreaterThan(0)
    expect(report.deltaY).toBeLessThanOrEqual(800)
    expect(report.steps).toBeGreaterThan(0)
    expect(report.maxScrollY).toBe(4000)
    // The window never moved — the advisory must say so instead of faking success.
    expect(report.note).toContain('nested container')
  })

  it('paging mode dispatches the PageDown key', async () => {
    const { service, sent } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')], { activeId: 'tab-1' })
    const report = await service.scroll({ mode: 'pagedown' })
    const keys = sent.filter(frame => frame.method === 'Input.dispatchKeyEvent')
    expect(keys.some(frame => frame.params?.code === 'PageDown')).toBe(true)
    expect(keys.some(frame => frame.params?.windowsVirtualKeyCode === 34)).toBe(true)
    expect(report.mode).toBe('pagedown')
    expect(report.steps).toBe(1)
  })

  it('anchor mode reports a missing anchor as found:false without wheeling', async () => {
    const { service, sent } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')], { activeId: 'tab-1' })
    const report = await service.scroll({ mode: 'anchor', anchor: 'pricing' })
    expect(report.found).toBe(false)
    expect(report.steps).toBe(0)
    expect(sent.some(frame => frame.method === 'Input.dispatchMouseEvent')).toBe(false)
    expect(sent.some(frame => frame.method === 'Runtime.evaluate' && String(frame.params?.expression).includes('pricing'))).toBe(true)
  })

  it('unprovable target makes wheel mode refuse before any input dispatch', async () => {
    const { service, sent } = pokedService([...incidentRows()])
    await expect(service.scroll({ deltaY: 800 })).rejects.toThrow('cannot prove which of 2 tabs')
    expect(sent.some(frame => frame.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('wheel mode refuses a zero delta on a provable target', async () => {
    const { service } = pokedService([target('tab-1', 'Migros', 'https://migros.test/')], { activeId: 'tab-1' })
    await expect(service.scroll({ mode: 'wheel' })).rejects.toThrow("needs a non-zero deltaX/deltaY")
  })
})

// ---------------------------------------------------------------------------
// Real endpoint: connect() must arm discovery and follow the browser's focus.
// ---------------------------------------------------------------------------

interface Wire {
  readonly url: string
  readonly frames: Array<Record<string, unknown>>
  broadcast(payload: Record<string, unknown>): void
}

/** A `ws` endpoint that auto-replies to every CDP request frame. */
async function startWire(targetInfos: Array<Record<string, unknown>>): Promise<Wire> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets: WebSocket[] = []
  const frames: Array<Record<string, unknown>> = []
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      frames.push(frame)
      const method = typeof frame.method === 'string' ? frame.method : ''
      const result = method === 'Target.getTargets'
        ? { targetInfos }
        : method === 'Target.attachToTarget'
          ? { sessionId: 'sess-1' }
          : {}
      socket.send(JSON.stringify({ id: frame.id, result }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('wire did not bind a port')
  const wire: Wire = {
    url: `ws://127.0.0.1:${String(address.port)}`,
    frames,
    broadcast: (payload) => { for (const socket of sockets) socket.send(JSON.stringify(payload)) },
  }
  endpoints.push({ server, sockets })
  return wire
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the deadline')
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('plan03: real endpoint discovery and focus sync', () => {
  it('connect() enables setDiscoverTargets, follows targetActivated, then resolves by active', async () => {
    const wire = await startWire([
      { targetId: 'tab-1', type: 'page', title: 'Migros', url: 'https://migros.test/', attached: false },
      { targetId: 'tab-2', type: 'page', title: 'LiteLLM', url: 'http://localhost:4000/ui/login', attached: false },
    ])
    const service = new CdpService()
    services.push(service)
    await service.connect(wire.url)

    await waitFor(() => wire.frames.some(frame =>
      frame.method === 'Target.setDiscoverTargets'
      && (frame.params as { discover?: unknown } | undefined)?.discover === true))

    const status = service.status()
    expect(status.connectionState).toBe('connected')
    expect(status.pages).toBe(2)
    expect(status.resolvedBy).toBeUndefined()

    // Two tabs, none active: the wrong-tab incident's exact precondition → refuse.
    await expect(service.getPageSession()).rejects.toThrow('cannot prove which of 2 tabs')

    // The browser focuses tab-2 (a human click) → the active pointer follows.
    wire.broadcast({ method: 'Target.targetActivated', params: { targetId: 'tab-2' } })
    await waitFor(() => service.status().activeTargetId === 'tab-2')

    const session = await service.getPageSession()
    expect(session.sessionId).toBe('sess-1')
    expect(service.status().resolvedBy).toBe('active')
    expect(service.status().activeTargetId).toBe('tab-2')
  }, 15_000)
})
