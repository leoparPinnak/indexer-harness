/** Per-session MCP server switches contributed to the composer tool row. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ui-conversation's SlotMap merge, where the host slot this
// control occupies is declared.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { McpSessionControl, type McpSessionControlInjected } from './McpSessionControl.tsx'
import { en, tr, zh, type McpSessionLocaleKey } from './locales.ts'

export type { McpSessionControlInjected, McpSessionControlProps } from './McpSessionControl.tsx'
export type { McpSessionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Per-session MCP switch copy. */
    'mcp.session': McpSessionLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'mcp.session'

/** Services required by the registration and the generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.mcpSession']

/** Contribute the MCP server switches to the composer's left tool row. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-mcp-session: dictionaries')

  const t = ctx.locale.bind(NS)
  const listServers: McpSessionControlInjected['listServers'] = async (sessionId) => {
    const result = await ctx.remote.mcpSession.list({ sessionId })
    if (!result.ok) {
      throw new Error(`mcpSession.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const setServerEnabled: McpSessionControlInjected['setServerEnabled'] = async (sessionId, serverName, enabled) => {
    const result = await ctx.remote.mcpSession.setServerEnabled({ sessionId, serverName, enabled })
    if (!result.ok) {
      throw new Error(`mcpSession.setServerEnabled failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): McpSessionControlInjected => ({ listServers, setServerEnabled })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'mcp-session',
    order: 20,
    label: () => t('label'),
    locale: NS,
    inject: injected,
  }, McpSessionControl))
}
