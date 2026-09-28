/**
 * Plan control plugin, browser half. It occupies two seats over one piece of
 * state, both read from the host-computed `plan` projection through the
 * standard-kit `useProjection`, with zero client-side plan state:
 *
 * - the composer's named `conversation.input.plan` seat, with an active-state
 *   status chip. Plan mode is entered through the command source; while the
 *   projection's effective target is plan mode the chip renders and executes
 *   /plan off through `command.execute`, otherwise the seat stays empty.
 * - the right Sidebar's `plan` tab type, whose body renders the newest plan the
 *   model presented for review beside the plans it superseded, and whose guide
 *   entry offers it on the "add tab" page.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the right Sidebar's registry and keyed seats into type scope.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PLAN_ID, planDefinition } from './definition.ts'
import { PlanChip } from './PlanModeControl.tsx'
import { PlanTabBody } from './PlanTabBody.tsx'
import { createPlanTabStore } from './store.ts'
import { en, zh, tr } from './locales.ts'

export type { PlanKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'plan'

/** Injected business face of the composer plan seat. */
export interface PlanChipInjected {
  /**
   * Leave plan mode by executing /plan off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitPlanMode: () => Promise<string | null>
}

/** Injected business face of the Plan tab body. */
export interface PlanTabInjected {
  /**
   * Apply the plan the tab shows by executing /plan off. Approving a pending
   * exit review is a separate mechanism and does not run here.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  applyPlan: () => Promise<string | null>
}

/** Required services: the seat's slot registry, commands Remote, copy, and the right Sidebar's tab registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale', 'sidebarRightTabs']

/**
 * Run the command that leaves plan mode for one Session.
 * @param ctx - client root context owning the commands Remote.
 * @param sessionId - Session whose plan mode is being left.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function leavePlanMode(ctx: ClientContext, sessionId: SessionId): Promise<string | null> {
  const result = await ctx.remote.commands.execute(sessionId, '/plan off', [])
  // Failure strings stay English (error-surface policy: not localized).
  if (!result.ok) return `${result.error.message} (${result.error.code})`
  if (result.value === undefined) return 'unknown command: /plan off'
  return null
}

/**
 * Client plugin body: register the plan chip, the Plan tab type and its body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'ui-plan: dictionaries')
  const planTabStore = createPlanTabStore()

  ctx.effect(() => ctx.sidebarRightTabs.register(planDefinition(t)), 'ui-plan: plan tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: PLAN_ID,
      locale: NS,
      store: planTabStore,
      inject: (sessionId: SessionId): PlanTabInjected => ({
        applyPlan: async () => await leavePlanMode(ctx, sessionId),
      }),
    },
    PlanTabBody,
  )), 'ui-plan: plan tab body')

  ctx.slots.inject('conversation.input.plan', () => ctx.slots.register({
    name: 'conversation.input.plan',
    locale: NS,
    inject: (sessionId: SessionId): PlanChipInjected => ({
      exitPlanMode: async () => await leavePlanMode(ctx, sessionId),
    }),
  }, PlanChip))
}
