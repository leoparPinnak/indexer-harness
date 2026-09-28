/**
 * ui-cdp-view browser half on a real SlotRegistry: the plugin registers the
 * right Sidebar's `cdp` tab type with the body that renders the host status
 * route, and tears both down with its fiber (HMR safety). The stage-one
 * registry is a recording double, because what this spec pins is the definition
 * the plugin hands it; the registry's own suite covers routing.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CdpBody } from '../src/client/CdpBody.tsx'
import { CDP_ID, CDP_KIND } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  // Pin the language the copy assertions below read, so they do not depend on
  // the ambient browser language of the test runner.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const registered: SidebarRightTabDefinition[] = []
  ctx.provide('sidebarRightTabs', {
    register: (definition: SidebarRightTabDefinition) => {
      registered.push(definition)
      return () => { registered.splice(registered.indexOf(definition), 1) }
    },
  })
  return { ctx, slots, registered }
}

describe('ui-cdp-view browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('offers the CDP tab type on the add-tab page and mounts its body', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const definition = b.registered[0]!
    expect(definition.id).toBe(CDP_ID)
    expect(definition.kind).toBe(CDP_KIND)
    expect(definition.kind).toBe('cdp')
    expect(definition.title('')).toBe('CDP')
    // Without a guide entry the type is registered but never offered, so the
    // tab is unreachable from the UI. This is the regression guard for that.
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide?.[0]?.title()).toBe('CDP')
    expect(definition.guide?.[0]?.description?.()).toBe(zh['type.description'])
    expect(b.slots.entries('sidebar.right.pane.tab')).toMatchObject([
      { component: CdpBody, options: { key: CDP_ID } },
    ])

    await fiber.dispose()
    expect(b.registered).toHaveLength(0)
    expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  })
})
