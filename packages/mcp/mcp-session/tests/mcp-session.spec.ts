import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mcpStatusRegistry } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools/src/testing.ts'
import McpSessionService from '../src/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A foreign event the visibility fold must skip, declared test-locally. */
    'test/unrelated': { note: string }
  }
}

const contexts: Context[] = []

beforeEach(() => {
  mcpStatusRegistry.clear()
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  mcpStatusRegistry.clear()
})

/** A Host with the Agent plane mounted, this service on top, and Agents to create. */
async function bench(): Promise<{
  ctx: Context
  service: McpSessionService
  create: (id: string) => Promise<Agent>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(McpSessionService)
  const harness = await mountAgentLoopTestHarness(ctx)
  return {
    ctx,
    service: ctx.get('mcpSession') as McpSessionService,
    create: id => harness.create(SessionId(id)),
  }
}

/** Register one server's tools exactly as the MCP bridge publishes them. */
function registerServer(ctx: Context, serverName: string, toolNames: readonly string[]): void {
  for (const toolName of toolNames) {
    ctx.tools.register(defineContentToolFixture({
      name: `mcp__${serverName}__${toolName}`,
      description: `fixture tool ${toolName}`,
      parameters: {},
      execute: () => Promise.resolve([]),
    }))
  }
}

/** Record one lifecycle transition, the way the bridge's supervisor does. */
function record(serverName: string, state: 'connected' | 'connecting' | 'failed', toolNames: readonly string[]): void {
  mcpStatusRegistry.record({
    serverName,
    scope: 'global',
    state,
    at: 1,
    toolCount: toolNames.length,
    toolNames: toolNames.map(toolName => `mcp__${serverName}__${toolName}`),
  })
}

/** Public tool names one Agent's next request would see. */
function visibleTools(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

describe('McpSessionService.list', () => {
  it('reports every known server as visible, counted from the registered tools', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search', 'fetch'])
    registerServer(ctx, 'git', ['status'])
    record('rea', 'connected', ['search', 'fetch'])
    record('git', 'connected', ['status'])
    // Configured but never connected: it still lists, with no tools to offer.
    record('paper', 'failed', [])
    const agent = await create('s1')

    expect(service.list({ sessionId: 's1' })).toEqual({
      servers: [
        { serverName: 'git', toolCount: 1, hostEnabled: true, enabled: true },
        { serverName: 'paper', toolCount: 0, hostEnabled: true, enabled: true },
        { serverName: 'rea', toolCount: 2, hostEnabled: true, enabled: true },
      ],
    })
    expect(visibleTools(ctx, agent)).toEqual([
      'mcp__git__status', 'mcp__rea__fetch', 'mcp__rea__search',
    ])
  })

  it('refuses a session this Host does not hold', async () => {
    const { service } = await bench()

    expect(() => service.list({ sessionId: 'absent' })).toThrow(/session "absent" is not live/)
  })

  it('leaves non-MCP tools out of every server count', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'a product tool that belongs to no MCP server',
      parameters: {},
      execute: () => Promise.resolve([]),
    }))
    await create('mixed')

    expect(service.list({ sessionId: 'mixed' }).servers).toEqual([
      { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
    ])
  })
})

describe('McpSessionService.setServerEnabled', () => {
  it('withholds one server from one session and leaves every other surface intact', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search', 'fetch'])
    registerServer(ctx, 'git', ['status'])
    record('rea', 'connected', ['search', 'fetch'])
    record('git', 'connected', ['status'])
    const one = await create('one')
    const two = await create('two')

    expect(service.setServerEnabled({ sessionId: 'one', serverName: 'rea', enabled: false })).toEqual({
      servers: [
        { serverName: 'git', toolCount: 1, hostEnabled: true, enabled: true },
        { serverName: 'rea', toolCount: 2, hostEnabled: true, enabled: false },
      ],
    })

    // The deciding session's next request no longer offers the server…
    expect(visibleTools(ctx, one)).toEqual(['mcp__git__status'])
    // …while the other session and the Host's own registry keep every tool.
    expect(visibleTools(ctx, two)).toEqual(['mcp__git__status', 'mcp__rea__fetch', 'mcp__rea__search'])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('mcp__rea__search')
    // The decision is the session's own durable record.
    expect(ctx.sessionProjections.stateOf(one.session, 'mcpServers')).toEqual({ disabled: ['rea'] })
  })

  it('covers a tool generation published after the switch', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    const agent = await create('late')
    service.setServerEnabled({ sessionId: 'late', serverName: 'rea', enabled: false })

    // A reconnect publishes a new generation: the restriction must follow it.
    registerServer(ctx, 'rea', ['fetch'])
    record('rea', 'connected', ['search', 'fetch'])

    expect(visibleTools(ctx, agent)).toEqual([])
    expect(service.list({ sessionId: 'late' }).servers).toEqual([
      { serverName: 'rea', toolCount: 2, hostEnabled: true, enabled: false },
    ])
  })

  it('restores every tool when the server is switched back on', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    const agent = await create('back')
    service.setServerEnabled({ sessionId: 'back', serverName: 'rea', enabled: false })

    expect(service.setServerEnabled({ sessionId: 'back', serverName: 'rea', enabled: true })).toEqual({
      servers: [{ serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true }],
    })
    expect(visibleTools(ctx, agent)).toEqual(['mcp__rea__search'])
    expect(ctx.sessionProjections.stateOf(agent.session, 'mcpServers')).toEqual({ disabled: [] })
  })

  it('withholds nothing for a server that registered no tools', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    record('paper', 'connecting', [])
    const agent = await create('quiet')

    expect(service.setServerEnabled({ sessionId: 'quiet', serverName: 'paper', enabled: false }).servers).toEqual([
      { serverName: 'paper', toolCount: 0, hostEnabled: true, enabled: false },
      { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
    ])
    expect(visibleTools(ctx, agent)).toEqual(['mcp__rea__search'])
  })

  it('refuses a server this Host never recorded', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    await create('known')

    expect(() => service.setServerEnabled({ sessionId: 'known', serverName: 'ghost', enabled: false }))
      .toThrow(/knows no MCP server named "ghost"/)
  })

  it('refuses a session with no live agent to switch tools for', async () => {
    const { ctx, service } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    const session = ctx.sessions.create(SessionId('idle'))

    expect(service.list({ sessionId: 'idle' }).servers).toEqual([
      { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
    ])
    expect(() => service.setServerEnabled({ sessionId: 'idle', serverName: 'rea', enabled: false }))
      .toThrow(/no live agent to switch tools for/)
    void session
  })
})

describe('McpSessionService durability and lifecycle', () => {
  it('collapses one server name recorded in two scopes into one row', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    // The same name live on two planes: one public tool namespace, one row.
    mcpStatusRegistry.record({ serverName: 'rea', scope: 'preset', state: 'connecting', at: 2, toolCount: 0, toolNames: [] })
    await create('both')

    expect(service.list({ sessionId: 'both' }).servers).toEqual([
      { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
    ])
  })

  it('ignores the session events it does not own', async () => {
    const { service, create } = await bench()
    const agent = await create('noise')
    agent.session.append('test/unrelated', { note: 'a foreign event the fold must skip' })

    expect(service.list({ sessionId: 'noise' }).servers).toEqual([])
  })

  it('treats a session no projection watches as fully visible', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    await create('unwatched')
    const stateOf = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    try {
      expect(service.list({ sessionId: 'unwatched' }).servers).toEqual([
        { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
      ])
    } finally {
      stateOf.mockRestore()
    }
  })

  it('lists a Loader-configured server that recorded no transition and shows its disabled host flag', async () => {
    const { ctx, service, create } = await bench()
    // The bench has no Loader; a stub with the same `entries()` shape stands
    // in for roster rows the real survey list serves (`disabled` is the
    // Entry-scoped getter on the row itself, not a config member).
    const entries = [
      { disabled: true, options: { id: 'configured', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'configured' } } },
      { options: { id: 'reaching', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'reaching' } } },
    ] as never[]
    ctx.reflect.provide('loader', { entries: () => entries })
    registerServer(ctx, 'reaching', ['ping'])
    await create('loader-aware')

    // A configured-but-never-connected server lists with zero tools so a
    // session switch can pre-commit before the bridge ever connects; a
    // Host-disabled row reports hostEnabled false so the panel can show why
    // its switch does nothing.
    expect(service.list({ sessionId: 'loader-aware' }).servers).toEqual([
      { serverName: 'configured', toolCount: 0, hostEnabled: false, enabled: false },
      { serverName: 'reaching', toolCount: 1, hostEnabled: true, enabled: true },
    ])
  })

  it('drops a disposed agent and keeps serving the sessions that remain', async () => {
    const { ctx, service, create } = await bench()
    registerServer(ctx, 'rea', ['search'])
    record('rea', 'connected', ['search'])
    const gone = await ctx.agents.create({
      sessionId: SessionId('gone'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const alive = await create('alive')
    service.setServerEnabled({ sessionId: 'gone', serverName: 'rea', enabled: false })

    await gone.dispose()

    expect(ctx.agents.get(SessionId('gone'))).toBeUndefined()
    expect(service.list({ sessionId: 'alive' }).servers).toEqual([
      { serverName: 'rea', toolCount: 1, hostEnabled: true, enabled: true },
    ])
    expect(visibleTools(ctx, alive)).toEqual(['mcp__rea__search'])
  })

  it('unwinds its Agent wiring when the Host disposes the service', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(McpSessionService)
    expect(ctx.get('mcpSession')).toBeDefined()

    await ctx.fiber.dispose()

    expect(ctx.get('mcpSession')).toBeUndefined()
    expect(ctx.get('sessionProjections')).toBeUndefined()
  })
})
