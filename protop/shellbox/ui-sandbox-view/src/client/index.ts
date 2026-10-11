/**
 * Browser half: register `sandbox` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`
 * (stage one), then its body into the keyed `sidebar.right.pane.tab` seat and
 * its chip title into `sidebar.right.pane.tab.title`, both under the type's
 * `id` (stage two). Nothing here reaches into the Sidebar's store or panes.
 *
 * The tab draws the live Windows desktop the web host publishes from its
 * sandbox helper, whose routes and line protocol are frozen in
 * `packages/bundle/deamon/sandbox/PROTOCOL.md`; the body owns presentation and
 * the pane-size report, and nothing else.
 */
import React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Brings the `slots` Context service declaration (ui-renderer owns it) and the
// Sidebar's `sidebarRightTabs` face into this module's type scope.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SANDBOX_ID, sandboxDefinition } from './definition.ts'
import { SandboxBody } from './SandboxBody.tsx'
import { SandboxTitle } from './SandboxTitle.tsx'
import { ShellboxDock } from './ShellboxDock.tsx'
import { en, tr, zh } from './locales.ts'

/** This package's copy namespace. */
const NS = 'sandboxView'

/** Required browser services: the tab registry, the keyed seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, its body, its chip title, and composer dock.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(sandboxDefinition(t)), 'ui-sandbox-view: sandbox type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-sandbox-view: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SANDBOX_ID, locale: NS },
    SandboxBody,
  )), 'ui-sandbox-view: sandbox body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SANDBOX_ID },
    SandboxTitle,
  )), 'ui-sandbox-view: sandbox title')
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'shellbox',
    order: 25,
    locale: NS,
  }, props => React.createElement(ShellboxDock, {
    ...props,
    openSidebarShellbox: (sess) => {
      const target = sess as SessionId | undefined
      const sidebar = ctx.get('sidebarRight')
      if (sidebar !== undefined) {
        if (target) sidebar.openTabIn(target, SANDBOX_ID)
        else sidebar.openTab(SANDBOX_ID)
      }
    },
  }))), 'ui-sandbox-view: shellbox dock entry')
}
