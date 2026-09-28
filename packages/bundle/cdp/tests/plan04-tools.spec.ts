/**
 * plan04: `cdp_endpoints` and `cdp_contexts` registration, output-schema
 * conformance (the `additionalProperties:false` class of bug), render smoke,
 * and `cdp_open`'s extended pool verdict (`endpoint` param + `connectionId`/
 * `reused` outputs).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCdpTools } from '../src/tools.ts'
import type { CdpService } from '../src/service.ts'

const PLAN04_TOOLS = ['cdp_endpoints', 'cdp_contexts'] as const

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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

const connectedRow = (): Record<string, unknown> => ({
  port: 9222,
  reachable: true,
  attached: true,
  active: true,
  state: 'connected',
  endpoint: 'ws://127.0.0.1:9222',
  browser: 'Chrome/test',
  browserId: 'g-1',
  // plan13-profile: the profile column every row now carries.
  profile: 'assistant',
  kind: 'dsh',
  connectionId: 'ep-9222',
  targets: 2,
  error: '',
})

const deadRow = (): Record<string, unknown> => ({
  port: 9999,
  reachable: false,
  attached: false,
  active: false,
  state: 'unreachable',
  endpoint: '',
  browser: '',
  browserId: '',
  // A port that never answered exposes no profile; '' says exactly that.
  profile: '',
  kind: 'user',
  connectionId: '',
  targets: 0,
  error: 'ECONNREFUSED 127.0.0.1:9999',
})

/** A stand-in service recording how the tools called it. */
function fakeService(overrides: Record<string, unknown> = {}): { service: CdpService, seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = []
  const base = {
    endpointInventory: async (options: Record<string, unknown> = {}) => {
      seen.push({ call: 'endpointInventory', ...options })
      return [connectedRow(), deadRow()]
    },
    createContext: async () => ({ contextId: 'ctx-1' }),
    listContexts: async () => [
      { contextId: '', isDefault: true, targets: 2 },
      { contextId: 'ctx-1', isDefault: false, targets: 1 },
    ],
    openContextTab: async (contextId: string, url: string) => {
      seen.push({ call: 'openContextTab', contextId, url })
      return { targetId: 'tab-9' }
    },
    disposeContext: async (contextId: string) => {
      seen.push({ call: 'disposeContext', contextId })
      return { closed: 1 }
    },
    open: async (options: Record<string, unknown> = {}) => {
      seen.push({ call: 'open', ...options })
      return { endpoint: 'ws://127.0.0.1:9222', targets: 2, connectionId: 'ep-9222', reused: true }
    },
  }
  const service = { ...base, ...overrides } as unknown as CdpService
  return { service, seen }
}

describe('plan04: tool registration', () => {
  it('registers cdp_endpoints and cdp_contexts alongside the existing set', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (const name of PLAN04_TOOLS) expect([...tools.keys()]).toContain(name)
    // The full existing set stays mounted (later waves only add rows).
    for (const name of ['cdp_status', 'cdp_open', 'cdp_tabs', 'cdp_exec']) {
      expect([...tools.keys()]).toContain(name)
    }
    expect([...tools.keys()].length).toBeGreaterThanOrEqual(PLAN04_TOOLS.length + 19)
  })
})

describe('plan04: output schema conformance', () => {
  it('cdp_endpoints returns rows that satisfy its own declared schema', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const value = await execute(tools.get('cdp_endpoints'), {})
    expect(value.ok).toBe(true)
    expect((value.endpoints as unknown[]).length).toBe(2)
    expect(violationsOf(tools.get('cdp_endpoints'), value)).toEqual([])
  })

  it('cdp_endpoints rejects undeclared keys in a row', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const violations = violationsOf(tools.get('cdp_endpoints'), { ok: true, endpoints: [{ ...connectedRow(), surprise: 1 }] })
    expect(violations).toHaveLength(1)
    expect(String(violations[0])).toContain('surprise')
  })

  it('every cdp_contexts action answers with schema-valid output', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_contexts')

    const listed = await execute(definition, {})
    expect(listed.action).toBe('list')
    expect(violationsOf(definition, listed)).toEqual([])

    const created = await execute(definition, { action: 'create' })
    expect(created.contextId).toBe('ctx-1')
    expect(violationsOf(definition, created)).toEqual([])

    const opened = await execute(definition, { action: 'open', contextId: 'ctx-1', url: 'https://iso.test/' })
    expect(opened.targetId).toBe('tab-9')
    expect(violationsOf(definition, opened)).toEqual([])

    const disposed = await execute(definition, { action: 'dispose', contextId: 'ctx-1' })
    expect(disposed.closed).toBe(1)
    expect(violationsOf(definition, disposed)).toEqual([])
  })

  it('cdp_open declares connectionId/reused as required pool verdicts', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')

    const value = await execute(definition, { endpoint: 'ws://127.0.0.1:9222' })
    expect(value).toMatchObject({ ok: true, connectionId: 'ep-9222', reused: true })
    expect(violationsOf(definition, value)).toEqual([])

    // A payload without the new verdicts must VIOLATE the schema (they are
    // required, not opportunistic).
    const missing = violationsOf(definition, { ok: true, endpoint: 'ws://127.0.0.1:9222', targets: 2 })
    expect(missing.length).toBeGreaterThan(0)
    expect(String(missing[0])).toContain('connectionId')
  })
})

// ---------------------------------------------------------------------------
// plan13-profile: the tool surface of the choice gate + the durable profile.
// The service-level proof (what actually reaches the launcher) lives in
// plan13-profile.spec.ts; here the SCHEMA and the RENDER are pinned, because a
// `needsChoice` payload that violates additionalProperties:false is invisible
// to the model that must act on it.
// ---------------------------------------------------------------------------

/** One discovery row as `open()` reports it. */
const discoveredRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  port: 9222,
  profile: 'assistant',
  kind: 'dsh',
  targets: 3,
  attached: true,
  active: false,
  endpoint: 'ws://127.0.0.1:9222/devtools/browser/abc',
  browser: 'Chrome/130',
  ...overrides,
})

describe('plan13-profile: cdp_open choice gate and profile surface', () => {
  it('projects needsChoice with a schema-valid table and no phantom attach', async () => {
    const { service } = fakeService({
      open: async () => ({
        endpoint: '',
        targets: 0,
        connectionId: '',
        reused: false,
        needsChoice: true,
        discovered: [discoveredRow()],
        choices: ['switchTo:9222', 'endpoint:ws://127.0.0.1:9222/devtools/browser/abc', 'profile:<name>'],
      }),
    })
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')

    const value = await execute(definition, {})
    expect(value).toMatchObject({ ok: true, needsChoice: true, endpoint: '', connectionId: '', reused: false })
    expect((value.discovered as unknown[])).toHaveLength(1)
    expect(violationsOf(definition, value)).toEqual([])

    // A needsChoice card is a QUESTION, never "Connected to browser at ".
    const text = renderOf(definition, {}, value)
    expect(text).toContain('No decision made')
    expect(text).toContain('nothing was opened or closed')
    expect(text).toContain('port=9222 profile=assistant kind=dsh')
    expect(text).toContain('switchTo')
    expect(text).not.toContain('Connected to browser')
  })

  it('an unknown profile renders as (unknown), never as a blank cell', async () => {
    const { service } = fakeService({
      open: async () => ({
        endpoint: '', targets: 0, connectionId: '', reused: false,
        needsChoice: true,
        discovered: [discoveredRow({ profile: '', kind: 'user', port: 9333 })],
        choices: ['switchTo:9333'],
      }),
    })
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')
    const text = renderOf(definition, {}, await execute(definition, {}))
    expect(text).toContain('profile=(unknown)')
    expect(text).toContain('kind=user')
  })

  it('a refusal answers ok:false with its reason and stays schema-valid', async () => {
    const { service } = fakeService({
      open: async () => ({
        endpoint: '', targets: 0, connectionId: '', reused: false,
        reason: 'cdp: profile "assistant" is already open in another browser',
        reasonCode: 'PROFILE_LOCKED',
        profileDir: '/home/me/.dsh/profiles/assistant',
      }),
    })
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')

    const value = await execute(definition, { profile: 'assistant' })
    expect(value.ok).toBe(false)
    expect(String(value.reason)).toContain('already open in another browser')
    expect(violationsOf(definition, value)).toEqual([])

    const text = renderOf(definition, {}, value)
    expect(text).toContain('cdp_open refused')
    expect(text).toContain('/home/me/.dsh/profiles/assistant')
  })

  it('forwards profile and switchTo, and names the profile it attached to', async () => {
    // The override still records, so the forwarding itself is what is asserted.
    const { service, seen } = fakeService()
    const recorded = seen
    const tools = bootTools({
      ...(service as unknown as Record<string, unknown>),
      open: async (options: Record<string, unknown> = {}) => {
        recorded.push({ call: 'open', ...options })
        return {
          endpoint: 'ws://127.0.0.1:9222', targets: 2, connectionId: 'ep-9222', reused: false, profile: 'assistant',
        }
      },
    } as unknown as CdpService)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')

    const value = await execute(definition, { profile: 'assistant', switchTo: 9222, headless: false })
    expect(recorded[0]).toMatchObject({ call: 'open', profile: 'assistant', switchTo: 9222, headless: false })
    expect(value.profile).toBe('assistant')
    expect(violationsOf(definition, value)).toEqual([])
    // The connected card names the profile: "which Google profile is that?"
    expect(renderOf(definition, {}, value)).toContain('profile=assistant')
  })

  it('an empty profile string is treated as absent, not as an invalid name', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await execute(tools.get('cdp_open'), { profile: '' })
    expect(seen[0]).toMatchObject({ call: 'open' })
    expect((seen[0] as { profile?: unknown }).profile).toBeUndefined()
  })

  it('rejects an undeclared key inside a discovered row', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_open')
    const violations = violationsOf(definition, {
      ok: true, endpoint: '', targets: 0, connectionId: '', reused: false,
      needsChoice: true,
      discovered: [{ ...discoveredRow(), surprise: 1 }],
      choices: [],
    })
    expect(violations.length).toBeGreaterThan(0)
    expect(String(violations[0])).toContain('surprise')
  })
})

describe('plan04: render smoke', () => {
  it('renders cdp_endpoints and cdp_contexts without throwing', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const endpoints = await execute(tools.get('cdp_endpoints'), {})
    const endpointsText = renderOf(tools.get('cdp_endpoints'), {}, endpoints)
    expect(endpointsText).toContain('Endpoints (2)')
    // plan13-profile: the profile column is what answers "which profile is that?".
    expect(endpointsText).toContain('port=9222 profile=assistant kind=dsh connected targets=2')
    expect(endpointsText).toContain('port=9999 profile=(unknown) kind=user unreachable')

    const contextsValue = await execute(tools.get('cdp_contexts'), { action: 'dispose', contextId: 'ctx-1' })
    const contextsText = renderOf(tools.get('cdp_contexts'), {}, contextsValue)
    expect(contextsText).toContain('Contexts after dispose')
    expect(contextsText).toContain('Disposed (closed 1 tabs)')

    const open = await execute(tools.get('cdp_open'), {})
    expect(renderOf(tools.get('cdp_open'), {}, open)).toContain('[ep-9222, reused]')
  })
})

describe('plan04: argument forwarding and validation', () => {
  it('cdp_endpoints parses the ports CSV and forwards timeoutMs', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    await execute(tools.get('cdp_endpoints'), { ports: '9222, 9333 , abc, 0', timeoutMs: 1234 })
    expect(seen[0]).toMatchObject({ call: 'endpointInventory', ports: [9222, 9333], timeoutMs: 1234 })

    await execute(tools.get('cdp_endpoints'), {})
    expect(seen[1]).toEqual({ call: 'endpointInventory' }) // no overrides → configured defaults
  })

  it('cdp_contexts forwards contextId/url and refuses unknown actions or url-less opens', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    await execute(tools.get('cdp_contexts'), { action: 'open', contextId: 'ctx-7', url: 'about:blank' })
    expect(seen).toContainEqual({ call: 'openContextTab', contextId: 'ctx-7', url: 'about:blank' })

    await expect(execute(tools.get('cdp_contexts'), { action: 'teleport' }))
      .rejects.toThrow("unknown action 'teleport'")
    await expect(execute(tools.get('cdp_contexts'), { action: 'open' }))
      .rejects.toThrow('requires url')
  })

  it('cdp_open forwards the explicit endpoint', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await execute(tools.get('cdp_open'), { endpoint: 'ws://127.0.0.1:9444' })
    expect(seen[0]).toMatchObject({ call: 'open', endpoint: 'ws://127.0.0.1:9444' })
  })
})

// ---------------------------------------------------------------------------
// plan04-FAZ7: net_capture / net_export must report an inactive interceptor
// honestly instead of dressing the failure up as `Captured 0 of 0`.
// ---------------------------------------------------------------------------

/** Stand-in carrying only the surface the net tools read. */
function netService(
  ensureProxy: () => Promise<{ active: boolean, port?: number, error?: string }>,
  exchanges: Array<Record<string, unknown>> = [],
): CdpService {
  return {
    ensureProxy,
    captureStore: {
      list: () => exchanges,
      size: exchanges.length,
      totalBodyBytes: exchanges.length * 4,
    },
  } as unknown as CdpService
}

const exchangeRow = (): Record<string, unknown> => ({
  id: 'x-1',
  flowId: 'f-1',
  redacted: false,
  truncated: false,
  bodiesEvicted: false,
  evicted: false,
  request: { method: 'GET', url: 'https://api.test/v1/items', startedAt: 1_000, body: { bytes: Buffer.from('q') } },
  response: { status: 200, finishedAt: 1_250, body: { bytes: Buffer.from('resp') } },
})

const proxyBindRefused = async () => ({
  active: false,
  error: 'listen EADDRINUSE: address already in use 127.0.0.1:9333',
})

describe('plan04-FAZ7: net tools refuse honestly while the proxy is inactive', () => {
  it('net_capture answers ok:false with the reason — not Captured 0 of 0', async () => {
    const tools = bootTools(netService(proxyBindRefused))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('net_capture')

    const value = await execute(definition, {})
    expect(value.ok).toBe(false)
    expect(String(value.reason)).toContain('proxy inactive — capture impossible')
    expect(String(value.reason)).toContain('EADDRINUSE')
    expect(value).toMatchObject({ total: 0, returned: 0, exchanges: [] })
    // The refusal itself must satisfy its own additionalProperties:false
    // schema — declaring `reason` is what keeps it legal.
    expect(violationsOf(definition, value)).toEqual([])

    const text = renderOf(definition, {}, value)
    expect(text).toContain('Capture unavailable')
    expect(text).toContain('proxy inactive')
    expect(text).not.toContain('Captured 0 of 0')
  })

  it('net_export mirrors the same envelope', async () => {
    const tools = bootTools(netService(proxyBindRefused))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('net_export')

    const value = await execute(definition, {})
    expect(value.ok).toBe(false)
    expect(String(value.reason)).toContain('proxy inactive — capture impossible')
    expect(value).toMatchObject({ totalExchanges: 0, totalBodyBytes: 0, hosts: [] })
    expect(violationsOf(definition, value)).toEqual([])

    const text = renderOf(definition, {}, value)
    expect(text).toContain('Capture unavailable')
    expect(text).not.toContain('Traffic Summary')
  })

  it('a listening proxy keeps the original ok:true shape', async () => {
    const tools = bootTools(netService(async () => ({ active: true, port: 9333 }), [exchangeRow()]))
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const capture = await execute(tools.get('net_capture'), {})
    expect(capture.ok).toBe(true)
    expect('reason' in capture).toBe(false)
    expect(capture).toMatchObject({ total: 1, returned: 1 })
    expect(violationsOf(tools.get('net_capture'), capture)).toEqual([])
    expect(renderOf(tools.get('net_capture'), {}, capture)).toContain('Captured 1 of 1 exchanges')

    const exported = await execute(tools.get('net_export'), {})
    expect(exported.ok).toBe(true)
    expect('reason' in exported).toBe(false)
    expect(exported.totalExchanges).toBe(1)
    expect((exported.hosts as unknown[]).length).toBe(1)
    expect(violationsOf(tools.get('net_export'), exported)).toEqual([])
    expect(renderOf(tools.get('net_export'), {}, exported)).toContain('Traffic Summary: 1 exchanges')
  })
})
