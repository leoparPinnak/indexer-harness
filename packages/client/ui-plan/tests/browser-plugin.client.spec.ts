/**
 * ui-plan browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.plan` single seat with the active
 * plan status chip, and registers the right Sidebar's `plan` tab type with the
 * body that renders the presented plan. The injected face executes /plan off
 * and folds admission outcomes into null (admitted) or a user-visible failure
 * line; teardown empties every seat and the type (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { PLAN_ID, PLAN_KIND } from '../src/client/definition.ts'
import { PlanChip } from '../src/client/PlanModeControl.tsx'
import { PlanTabBody } from '../src/client/PlanTabBody.tsx'
import type { PlanChipInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const SID = 's-plan' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  const locale = new LocaleRuntime(ctx)
  // Pin the language the copy assertions below read, so they do not depend on
  // the ambient browser language of the test runner.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  // Recording double for the stage-one registry: what this spec pins is the
  // definition the plugin hands it, which the registry's own specs cover.
  const registered: SidebarRightTabDefinition[] = []
  ctx.provide('sidebarRightTabs', {
    register: (definition: SidebarRightTabDefinition) => {
      registered.push(definition)
      return () => { registered.splice(registered.indexOf(definition), 1) }
    },
  })
  return { ctx, slots, execute, registered }
}

describe('ui-plan browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale', 'sidebarRightTabs'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the plan seat', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('remote', { commands: {} })
    ctx.provide('remote.commands', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sidebarRightTabs', { register: () => () => {} })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.plan')).toHaveLength(0)
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.plan': { kind: 'single', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.plan')).toHaveLength(1)
  })

  it('offers the plan tab type on the add-tab page and mounts its body', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const definition = b.registered[0]!
    expect(definition.id).toBe(PLAN_ID)
    expect(definition.kind).toBe(PLAN_KIND)
    expect(definition.title('')).toBe('计划')
    // Without a guide entry the type is registered but never offered, so the
    // tab is unreachable from the UI. This is the regression guard for that.
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide?.[0]?.title()).toBe('计划')
    expect(definition.guide?.[0]?.description?.()).toBe('阅读本次会话中最新提交的计划。')
    expect(b.slots.entries('sidebar.right.pane.tab')).toMatchObject([
      { component: PlanTabBody, options: { key: PLAN_ID } },
    ])

    await fiber.dispose()
    expect(b.registered).toHaveLength(0)
    expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  })

  it('registers the chip, executes /plan off, and unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.plan')[0]!
    expect(entry.component).toBe(PlanChip)
    const injected = (entry.inject as unknown as (id: SessionId) => PlanChipInjected)(SID)

    await expect(injected.exitPlanMode()).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/plan off', [])

    // Business failure folds to the composer-visible line: the generated method
    // reports the RPC failure in its error branch.
    b.execute.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('session/not-found', 'gone', { sessionId: SID }),
    } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('gone (session/not-found)')

    // Unmatched admission (plan-mode not composed host-side) is also a failure line.
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('unknown command: /plan off')

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.plan')).toHaveLength(0)
  })
})
