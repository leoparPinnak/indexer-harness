// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { McpServersSettingsTab } from '../src/client/McpServersSettingsTab.tsx'
import type { McpServersSettingsTabInjected } from '../src/client/McpServersSettingsTab.tsx'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY = { entries: [] }
const EMPTY_SERVERS = { servers: [] }
type ListResult =
  | { readonly ok: true; readonly value: typeof EMPTY }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
type ServersResult =
  | { readonly ok: true; readonly value: typeof EMPTY_SERVERS }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const mcpServers = vi.fn<() => Promise<ServersResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY_SERVERS })
  const setMcpServerEnabled = vi.fn<(entryId: string, enabled: boolean) => Promise<ServersResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY_SERVERS })
  ctx.provide('remote.pluginInventory', { list, mcpServers, setMcpServerEnabled })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, mcpServers, setMcpServerEnabled }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The injected business face one registered tab declared. */
function face<T>(slots: SlotRegistry, id: string): T {
  const entry = slots.entries('settings.plugins.tab').find(candidate => candidate.options.id === id)
  expect(entry?.options.id).toBe(id)
  return (entry!.inject as unknown as () => T)()
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory'])
  })

  it('registers both localized tabs without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries.map(entry => entry.component)).toEqual([
      PluginInventorySettingsTab,
      McpServersSettingsTab,
    ])
    expect(entries.map(entry => entry.options)).toMatchObject([{ id: 'all', order: 10 }, { id: 'mcp', order: 20 }])
    expect(entries.map(entry => entry.locale)).toEqual([NS, NS])
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['插件列表', 'MCP 服务器'])
    expect(b.list).not.toHaveBeenCalled()
    expect(b.mcpServers).not.toHaveBeenCalled()
    expect(b.setMcpServerEnabled).not.toHaveBeenCalled()

    const inventory = face<PluginInventorySettingsTabInjected>(b.slots, 'all')
    await expect(inventory.list()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(inventory.list()).rejects.toThrow('pluginInventory.list failed: REMOTE_ERROR: unavailable')

    // Shipped preset names resolve over the agent-preset dictionaries the
    // real plugin registers; user-authored metadata stays untranslated.
    b.locale.register('settings.agentPreset', 'zh', { presetStandardName: '标准模式' } as never)
    expect(inventory.presetName({ id: 'standard', trust: 'system', isDefault: true, rows: [] })).toBe('标准模式')
    expect(inventory.presetName({ id: 'mine', trust: 'user', name: '我自己的', isDefault: false, rows: [] })).toBe('我自己的')

    const mcp = face<McpServersSettingsTabInjected>(b.slots, 'mcp')
    await expect(mcp.list()).resolves.toEqual(EMPTY_SERVERS)
    expect(b.mcpServers).toHaveBeenCalledOnce()
    await expect(mcp.setEnabled('mcp-rea', false)).resolves.toEqual(EMPTY_SERVERS)
    expect(b.setMcpServerEnabled).toHaveBeenCalledWith('mcp-rea', false)

    b.mcpServers.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'gone' } })
    await expect(mcp.list()).rejects.toThrow('pluginInventory.mcpServers failed: REMOTE_ERROR: gone')
    b.setMcpServerEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'readonly' } })
    await expect(mcp.setEnabled('mcp-rea', true))
      .rejects.toThrow('pluginInventory.setMcpServerEnabled failed: DENIED: readonly')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.plugins.tab').map(entry => resolveSlotLabel(entry.options.label)))
      .toEqual(['Plugin list', 'MCP servers'])

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    const mcpEntry = (): unknown =>
      b.slots.entries('settings.plugins.tab').find(entry => entry.options.id === 'mcp')?.component
    await vi.waitFor(() => {
      expect(mcpEntry()).toBe(McpServersSettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
