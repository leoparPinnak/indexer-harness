/**
 * Stage one of this package's registration: what the `sandbox` tab type IS.
 *
 * A page type: it recognizes no resource address, because a live desktop is not
 * workspace content, so it is opened by kind alone. `extension` is the band for
 * a type that does not ship with the product, and the one that may later take
 * over a `builtin` kind.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const SANDBOX_KIND = 'sandbox'

/** This implementation's identity in the tab system: the key its body registers under. */
export const SANDBOX_ID = '@deepseek-ai/dsh-client-ui-sandbox-view'

/**
 * The sandbox type's registry definition.
 *
 * The `guide` entry is what puts the type on the Right Sidebar's "add tab"
 * page: a type without one is registered and openable by kind, but never
 * offered, so it stays unreachable from the UI.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function sandboxDefinition(t: TranslateNS<'sandboxView'>): SidebarRightTabDefinition {
  return {
    id: SANDBOX_ID,
    kind: SANDBOX_KIND,
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
