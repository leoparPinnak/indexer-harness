/**
 * Browser half: the composer's auto-push chip and its dashboard.
 *
 * The chip occupies the list seat below the input bar — `conversation.composer.dock`,
 * where the chat statistics already sit — and reads the host's `autopush`
 * projection through the standard kit. The one verb it needs is the toggle, which
 * runs the same `/autopush` command a reader could type, so the logged state has
 * exactly one writer on the host.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the composer dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { PushDock } from './PushDock.tsx'
import { en, tr, zh } from './locales.ts'

export type { PushDockProps } from './PushDock.tsx'
export type { AutoPushKey } from './locales.ts'

/** This plugin's copy namespace. */
const NS = 'autopush'

/** Injected business face of the dock. */
export interface PushDockInjected {
  /**
   * Turn auto-push on or off through the session's own command.
   * @param enabled - the requested state.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  setEnabled: (enabled: boolean) => Promise<string | null>
}

/** Required browser services: the slots, the command Remote, and copy. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: register the dictionary and the composer dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, tr }), 'autopush: dictionaries')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'autopush',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): PushDockInjected => ({
      // Failure strings stay English (error-surface policy: not localized).
      setEnabled: async (enabled) => {
        const result = await ctx.remote.commands.execute(sessionId, enabled ? '/autopush on' : '/autopush off', [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /autopush'
        return null
      },
    }),
  }, PushDock))
}
