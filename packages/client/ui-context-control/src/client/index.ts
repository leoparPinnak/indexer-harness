/**
 * Client face: occupies the composer's `conversation.input.context` seat with
 * the context meter, the manual compaction action, and the per-session
 * compaction-mode settings.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the ctx.remote merge, the locale/slots service merges, and the
// conversation seat vocabulary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionSessionMode } from '@deepseek-ai/dsh-compaction/types'
import { ContextControl } from './ContextControl.tsx'
import type { ContextControlInjected, SummarizerModelGroup } from './ContextControl.tsx'
import { CompactionCap } from './CompactionCapSetting.tsx'
import type { CompactionCapInjected } from './CompactionCapSetting.tsx'
import { en, NS, tr, zh } from './locales.ts'

/**
 * Cordis services the client face reads. `remote.commands` is the service the
 * manual `/compact` action calls (`runCompact` below): Cordis refuses a
 * `ctx.<service>` read that is not listed here, so omitting it makes the panel's
 * Compact button fail at runtime with "cannot get property ... without inject"
 * even though the type-only import above makes the access type-check.
 */
export const inject = [
  'locale',
  'remote',
  'remote.session',
  'remote.settings',
  'remote.commands',
  'slots',
]

/**
 * Register the context-control dictionaries and its composer seat occupant.
 * @param ctx - Client plugin context.
 */
export const apply = (ctx: Context): void => {
  ctx.effect(() => ctx.locale.register(NS, { en, tr, zh }), 'ui-context-control: dictionaries')
  const t = ctx.locale.bind(NS) as ContextControlInjected['t']
  ctx.effect(
    () => ctx.slots.inject('conversation.input.context', () => ctx.slots.register({
      name: 'conversation.input.context',
      locale: NS,
      inject: (sessionId: SessionId): ContextControlInjected => ({
        t,
        runCompact: async () => {
          // Failure strings stay English (error-surface policy: not localized).
          const result = await ctx.remote.commands.execute(sessionId, '/compact', [])
          if (!result.ok) {
            throw new Error(`compact failed: ${result.error.message} (${result.error.code})`)
          }
          if (result.value === undefined) throw new Error('unknown command: /compact')
        },
        saveCompactionMode: async (mode: CompactionSessionMode) => {
          const result = await ctx.remote.session.setCompactionMode({ sessionId, mode })
          if (!result.ok) {
            throw new Error(`session.setCompactionMode failed: ${result.error.code}: ${result.error.message}`)
          }
        },
        loadSummarizerModels: async (): Promise<readonly SummarizerModelGroup[]> => {
          const result = await ctx.remote.session.modelCatalog()
          if (!result.ok) return []
          return result.value.groups.map(group => ({
            provider: group.id,
            models: group.models.map(model => model.id),
          }))
        },
        loadModelContexts: async () => {
          const result = await ctx.remote.session.modelCatalog()
          if (!result.ok) {
            throw new Error(`session.modelCatalog failed: ${result.error.code}: ${result.error.message}`)
          }
          return {
            default: {
              provider: result.value.default.provider,
              model: result.value.default.model,
            },
            models: result.value.groups.flatMap(group => group.models.map(model => ({
              provider: group.id,
              model: model.id,
              ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            }))),
          }
        },
      }),
    }, ContextControl)),
    'ui-context-control: composer context seat',
  )
  ctx.effect(
    () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'compaction-cap',
      order: 10,
      locale: NS,
      inject: (): CompactionCapInjected => ({
        readCap: async () => {
          const described = await ctx.remote.settings.describe()
          if (!described.ok) return undefined
          const view = described.value.namespaces.find(namespace => namespace.ns === 'compaction-basic')
          const value = view?.value as { maxTokens?: unknown } | undefined
          return typeof value?.maxTokens === 'number' ? value.maxTokens : undefined
        },
        writeCap: async (value) => {
          // The remote answers through a result envelope; a rejected write
          // must surface instead of reporting success.
          const response = value === undefined
            ? await ctx.remote.settings.mutate('compaction-basic', [{ op: 'unset', path: ['maxTokens'] }], undefined)
            : await ctx.remote.settings.update('compaction-basic', { maxTokens: value }, undefined)
          if (!response.ok) {
            throw new Error(`settings write failed: ${response.error.message} (${response.error.code})`)
          }
        },
      }),
    }, CompactionCap)),
    'ui-context-control: global compaction cap row',
  )
}

export type { ContextControlInjected, ContextControlProps, SummarizerModelGroup } from './ContextControl.tsx'
