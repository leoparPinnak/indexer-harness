/**
 * Stage one of this package's registration: what the `cdp` tab type IS.
 *
 * A page type: the CDP extension's status is not workspace content and carries
 * no resource address, so it is opened by kind alone. `extension` is the band
 * for a type that does not ship with the product, and the one that may later
 * take over a `builtin` kind.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** The tab kind this package owns; this is the internal id `openTab` names. */
export const CDP_KIND = 'cdp'

/** This implementation's identity in the tab system: the key its body registers under. */
export const CDP_ID = '@deepseek-ai/dsh-client-ui-cdp-view'

/**
 * The CDP type's registry definition.
 *
 * The `guide` entry is what puts the type on the Right Sidebar's "add tab"
 * page: a type without one is registered and openable by kind, but never
 * offered, so it stays unreachable from the UI.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function cdpDefinition(t: TranslateNS<'cdpView'>): SidebarRightTabDefinition {
  return {
    id: CDP_ID,
    kind: CDP_KIND,
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      // After the shipped file and document types invite you in.
      order: 20,
      title: () => t('type.label'),
      description: () => t('type.description'),
    }],
  }
}
