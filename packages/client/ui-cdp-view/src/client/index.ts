/**
 * Browser half: register `cdp` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`
 * (stage one), then its body into the keyed `sidebar.right.pane.tab` seat under
 * the type's `id` (stage two). Nothing here reaches into the Sidebar's store or
 * panes.
 *
 * The body reads the CDP extension's host status route; the tab owns no state
 * the host could report and nothing else in this package draws.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: brings the `slots` service declaration (ui-renderer owns it), the
// Sidebar's `sidebarRightTabs` face, and the `ctx.locale` service declaration
// into this module's type scope.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CDP_ID, cdpDefinition } from './definition.ts'
import { CdpBody } from './CdpBody.tsx'
import { en, tr, zh } from './locales.ts'

/** This package's copy namespace. */
const NS = 'cdpView'

/** Required browser services: the tab registry, the keyed seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, and its body.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(cdpDefinition(t)), 'ui-cdp-view: cdp type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-cdp-view: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: CDP_ID, locale: NS },
    CdpBody,
  )), 'ui-cdp-view: cdp body')
}
