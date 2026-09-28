/**
 * Stage one of this package's right-Sidebar registration: what the `plan` tab
 * type IS.
 *
 * A page type: a plan is not workspace content and carries no resource address,
 * so it is opened by kind alone. `extension` is the band for a type that does
 * not ship with the product, and the one that may later take over a `builtin`
 * kind.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const PLAN_KIND = 'plan'

/** This implementation's identity in the tab system: the key its body registers under. */
export const PLAN_ID = '@deepseek-ai/dsh-client-ui-plan'

/**
 * The plan type's registry definition.
 *
 * The `guide` entry is what puts the type on the Right Sidebar's "add tab"
 * page: a type without one is registered and openable by kind, but never
 * offered, so it stays unreachable from the UI.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function planDefinition(t: TranslateNS<'plan'>): SidebarRightTabDefinition {
  return {
    id: PLAN_ID,
    kind: PLAN_KIND,
    priority: 'extension',
    title: () => t('tab.label'),
    guide: [{
      // First: reading the current plan is the reason to open this sidebar.
      order: 0,
      title: () => t('tab.label'),
      description: () => t('tab.description'),
    }],
  }
}
