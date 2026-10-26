/** Read-only Host plugin inventory and MCP server control registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.agentPreset' LocaleNamespaceMap merge, whose
// dictionaries the shipped-preset name resolution below reads.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Inline-safe shared fold: shipped ids map to dictionary keys in one home.
import { presetDisplayText } from '@deepseek-ai/dsh-agent-presets/display'
import { McpServersSettingsTab, type McpServersSettingsTabInjected } from './McpServersSettingsTab.tsx'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { en, tr, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { McpServersSettingsTabInjected, McpServersSettingsTabProps } from './McpServersSettingsTab.tsx'
export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin inventory and MCP server copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Contribute the inventory and MCP server tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  // Resolved per call over ui-agent-preset's dictionaries, so a language
  // switch re-resolves shipped names; user-authored metadata passes through.
  const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
  const presetName: PluginInventorySettingsTabInjected['presetName'] = preset =>
    presetDisplayText(preset, agentPresetCopy).name
  const injected = (): PluginInventorySettingsTabInjected => ({ list, presetName })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))

  const mcpList: McpServersSettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.mcpServers()
    if (!result.ok) {
      throw new Error(`pluginInventory.mcpServers failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const mcpSetEnabled: McpServersSettingsTabInjected['setEnabled'] = async (entryId, enabled) => {
    const result = await ctx.remote.pluginInventory.setMcpServerEnabled(entryId, enabled)
    if (!result.ok) {
      throw new Error(
        `pluginInventory.setMcpServerEnabled failed: ${result.error.code}: ${result.error.message}`,
      )
    }
    return result.value
  }
  const mcpAddServer: McpServersSettingsTabInjected['addServer'] = async request => {
    const result = await ctx.remote.pluginInventory.addMcpServer(request)
    if (!result.ok) {
      throw new Error(
        `pluginInventory.addMcpServer failed: ${result.error.code}: ${result.error.message}`,
      )
    }
    return result.value
  }
  const mcpInjected = (): McpServersSettingsTabInjected => ({ list: mcpList, setEnabled: mcpSetEnabled, addServer: mcpAddServer })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcp',
    order: 20,
    label: () => t('mcpTab'),
    locale: NS,
    inject: mcpInjected,
  }, McpServersSettingsTab))
}
