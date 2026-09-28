// @vitest-environment jsdom
/**
 * The Plan tab type through the REAL right-Sidebar registry: the composite the
 * user actually reaches.
 *
 * The unit specs around this file pin the definition the plugin hands over and
 * the body's rendering. This one pins the joined result — that mounting
 * `ui-sidebar-right` and this package together puts a `plan` kind in the
 * registry, offers it on the add-tab guide page, and lets a caller open it by
 * kind. A definition whose guide entry went missing is registered but
 * unreachable from the UI, which no assertion over the definition alone would
 * catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as sidebarRightApply, inject as sidebarRightInject } from '../../ui-sidebar-right/src/client/index.ts'
import { PLAN_ID, PLAN_KIND } from '../src/client/definition.ts'
import { PlanTabBody } from '../src/client/PlanTabBody.tsx'
import { apply, inject } from '../src/client/index.ts'

const SESSION = 's-plan-tab' as SessionId
const runtimes: SlotTestRuntime[] = []

let getAnimationsDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
  }
})

describe('plan tab registration', () => {
  it('offers the plan kind on the guide page and opens it by kind', async () => {
    const runtime = await SlotTestRuntime.create()
    runtimes.push(runtime)
    runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
    runtime.ctx.provide('resources', { pin: vi.fn() } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({ 'rightbar': { kind: 'single', scope: 'root' } })
    await runtime.sessions.add({ id: SESSION })
    await runtime.mount({ inject: [...sidebarRightInject], apply: sidebarRightApply })

    runtime.ctx.provide('remote', { commands: { execute: vi.fn() } } as never)
    runtime.ctx.provide('remote.commands', { execute: vi.fn() } as never)
    await runtime.mount({ inject: [...inject], apply })

    const registry = runtime.ctx.sidebarRightTabs
    expect(registry.get(PLAN_KIND)?.id).toBe(PLAN_ID)
    expect(registry.entries().map(entry => entry.kind)).toContain(PLAN_KIND)
    expect(registry.guide().map(box => ({ order: box.order, kind: box.kind }))).toEqual([{ order: 0, kind: PLAN_KIND }])
    expect(registry.guide()[0]?.title()).toBe('计划')
    expect(registry.claim(`sidebar://${PLAN_KIND}`, PLAN_KIND)).toEqual({
      kind: PLAN_KIND,
      contentId: `sidebar://${PLAN_KIND}`,
      title: '计划',
    })
    expect(runtime.slots.entries('sidebar.right.pane.tab')).toContainEqual(
      expect.objectContaining({ component: PlanTabBody, options: { key: PLAN_ID } }),
    )
  })
})
