/**
 * Server log viewer plugin, browser half: the settings Server Logs section
 * showing the Web host's log file tail with live refresh and clear.
 *
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the settings slot declarations. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots service merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, tr, zh, type ServerLogsKey } from './locales.ts'
import { ServerLogsSection } from './ServerLogsSection.tsx'

export type { ServerLogsSectionProps } from './ServerLogsSection.tsx'
export type { ServerLogsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Server log viewer copy. */
    serverLogs: ServerLogsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'serverLogs'

/** Required services: the section slot and locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Register the `serverLogs` dictionaries and the Server Logs section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-server-logs: dictionaries')
  // Diagnostics sit last: routine sections keep the top of the nav.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'server-logs',
    order: 90,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
  }, ServerLogsSection))
}
