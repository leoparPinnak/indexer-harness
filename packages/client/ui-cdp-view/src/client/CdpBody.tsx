/**
 * The CDP tab's body: the host's CDP status route as availability, extension
 * version, live target count, and local proxy state.
 *
 * The route is read with plain `fetch` on mount and again whenever the retry
 * control asks. An answer that is refused, fails, or does not carry the
 * declared fields settles into the error state, whose button re-runs the read;
 * every product string comes from the `cdpView` dictionary.
 *
 * The payload mirrors `CdpStatusResponse` in `packages/bundle/cdp/src/types.ts`.
 * The host bundle is a different package, so the fields are re-declared here
 * rather than imported; this module validates them at the fetch boundary, where
 * the bytes are untrusted.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './CdpBody.module.css'

/** The host route that reports the CDP extension's current state. */
export const CDP_STATUS_URL = '/api/server/cdp/status'

/** The host status route's validated body. */
export interface CdpStatus {
  /** Whether the CDP extension is installed and answering. */
  readonly ok: boolean
  /** The installed bundle's version, shown verbatim. */
  readonly version: string
  /** Live browser targets the extension currently controls. */
  readonly targets: number
  /** The local proxy listener's state. */
  readonly proxy: { readonly active: boolean }
}

/** The body's load state: loading, a failed read, or one validated status. */
type CdpLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly value: CdpStatus }

/** The body's composed props: the tab it draws and its copy. */
export type CdpBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'cdpView'>

/**
 * Whether one parsed value is a non-null object.
 * @param value - value of unknown shape.
 * @returns true for an object or array, false for null and every primitive.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validate one status-route answer at the fetch boundary; the rest of this
 * module reads the declared types alone.
 * @param value - parsed JSON of unknown shape.
 * @returns the status when every field has its declared type, otherwise undefined.
 */
export function parseCdpStatus(value: unknown): CdpStatus | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.ok !== 'boolean' || typeof value.version !== 'string') return undefined
  if (typeof value.targets !== 'number' || !Number.isInteger(value.targets)) return undefined
  if (!isRecord(value.proxy) || typeof value.proxy.active !== 'boolean') return undefined
  return {
    ok: value.ok,
    version: value.version,
    targets: value.targets,
    proxy: { active: value.proxy.active },
  }
}

/** The CDP tab's body. */
export function CdpBody({ t }: CdpBodyProps): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<CdpLoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(CDP_STATUS_URL)
        if (!response.ok) throw new Error(`CDP status route answered ${String(response.status)}`)
        const parsed = parseCdpStatus(await response.json())
        if (cancelled) return
        setState(parsed === undefined ? { status: 'error' } : { status: 'ready', value: parsed })
      } catch {
        // A refused, failing, or unreadable answer is the error state; the
        // retry control below is the only way to ask again.
        if (!cancelled) setState({ status: 'error' })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [attempt])

  const retry = useCallback((): void => {
    setState({ status: 'loading' })
    setAttempt(count => count + 1)
  }, [])

  if (state.status === 'loading') {
    return (
      <div className={css.body} data-cdp-view>
        <p className={css.notice} role="status">{t('status.loading')}</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={css.body} data-cdp-view>
        <p className={css.notice} role="alert">{t('status.error')}</p>
        <button type="button" className={css.retry} onClick={retry}>{t('action.retry')}</button>
      </div>
    )
  }

  const { value } = state
  return (
    <div className={css.body} data-cdp-view>
      <p className={css.availability}>
        <span
          className={value.ok ? `${css.dot} ${css.dotUp}` : css.dot}
          aria-hidden="true"
        />
        {value.ok ? t('status.ok') : t('status.unavailable')}
      </p>
      <dl className={css.fields}>
        <dt className={css.term}>{t('field.version')}</dt>
        <dd className={css.value}>{value.version}</dd>
        <dt className={css.term}>{t('field.targets')}</dt>
        <dd className={css.value}>{value.targets}</dd>
        <dt className={css.term}>{t('field.proxy')}</dt>
        <dd className={css.value}>{value.proxy.active ? t('value.active') : t('value.inactive')}</dd>
      </dl>
    </div>
  )
}
