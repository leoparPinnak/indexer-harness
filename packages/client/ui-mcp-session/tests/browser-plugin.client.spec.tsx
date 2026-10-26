// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, NS } from '../src/client/index.ts'
import { McpSessionControl } from '../src/client/McpSessionControl.tsx'
import type { McpSessionControlInjected } from '../src/client/McpSessionControl.tsx'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const EMPTY = { servers: [] }
type Result =
  | { readonly ok: true; readonly value: typeof EMPTY }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Boot the plugin over fake Remote faces; each namespace records its calls. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<(request: { sessionId: string }) => Promise<Result>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const setServerEnabled = vi.fn<(request: { sessionId: string; serverName: string; enabled: boolean }) => Promise<Result>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  ctx.provide('remote.mcpSession', { list, setServerEnabled })
  /** Declare the composer slot the control occupies. */
  const declare = (): (() => void) => slots.register({
    name: 'root',
    children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  const entry = () => slots.entries('conversation.input.left')[0]
  return { ctx, slots, locale, list, setServerEnabled, declare, entry }
}

describe('ui-mcp-session browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(nodeApply).not.toThrow()
  })

  it('declares only the services the control uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.mcpSession'])
  })

  it('registers the composer control and wires both Remote calls', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const registered = b.entry()!
    expect(registered.component).toBe(McpSessionControl)
    expect(registered.options).toMatchObject({ id: 'mcp-session', order: 20 })
    expect(registered.locale).toBe(NS)
    expect(resolveSlotLabel(registered.options.label)).toBe('MCP')
    expect(b.list).not.toHaveBeenCalled()
    expect(b.setServerEnabled).not.toHaveBeenCalled()

    const face = (registered.inject as unknown as () => McpSessionControlInjected)()
    await expect(face.listServers('s1')).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledWith({ sessionId: 's1' })
    await expect(face.setServerEnabled('s1', 'rea', false)).resolves.toEqual(EMPTY)
    expect(b.setServerEnabled).toHaveBeenCalledWith({ sessionId: 's1', serverName: 'rea', enabled: false })

    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'gone' } })
    await expect(face.listServers('s1')).rejects.toThrow('mcpSession.list failed: REMOTE_ERROR: gone')
    b.setServerEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'no agent' } })
    await expect(face.setServerEnabled('s1', 'rea', true))
      .rejects.toThrow('mcpSession.setServerEnabled failed: DENIED: no agent')
    await b.ctx.fiber.dispose()
  })

  it('follows the locale and survives a late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.entry()).toBeUndefined()

    const stop = b.declare()
    await vi.waitFor(() => { expect(b.slots.entries('conversation.input.left')).toHaveLength(1) })
    expect(b.locale.bind(NS)('title')).not.toBe('')
    b.locale.setLocale('tr')
    expect(b.locale.bind(NS)('title')).toBe('Bu oturumun MCP sunucuları')

    stop()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
    b.declare()
    await vi.waitFor(() => { expect(b.entry()?.component).toBe(McpSessionControl) })

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
