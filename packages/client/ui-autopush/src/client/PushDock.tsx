/**
 * The auto-push dock: a chip under the composer that turns the gate on and off,
 * and the dashboard behind it that lists what was published.
 *
 * The chip reads the host's `autopush` projection rather than holding a local
 * switch, so the state the reader sees is the state the model was given. The
 * counter and the last-push clock are the same value read twice.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `autopush` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-autopush/client'
import type { PushDockInjected } from './index.ts'
import css from './PushDock.module.css'

/** Full props: the session standard kit, the injected verb, and the locale seat. */
export type PushDockProps =
  & PropsRuntime<'conversation.composer.dock'>
  & InjectFace<PushDockInjected>
  & PropsLocale<'autopush'>

/**
 * Format one push time for the chip: local wall clock, hour and minute.
 * @param at - milliseconds since the epoch.
 * @returns `ss:dd`.
 */
export function chipTime(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format one push time for the history: the full local date and time.
 * @param at - milliseconds since the epoch.
 * @returns `gg.aa.yyyy ss:dd`.
 */
export function fullTime(at: number): string {
  const date = new Date(at)
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear())} ${chipTime(at)}`
}

/**
 * Zero-pad one clock or calendar field.
 * @param value - the field value.
 * @returns two digits.
 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * GitHub mark glyph for the auto-push button.
 * @param props - icon size and class.
 * @returns the SVG element.
 */
function GithubIcon({ size = 13, className }: { size?: number | undefined; className?: string | undefined }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      />
    </svg>
  )
}

/**
 * The chip and its dashboard.
 * @param props - projection reader, injected toggle, and copy.
 * @returns the dock entry.
 */
export function PushDock({ useProjection: read, setEnabled, t }: PushDockProps): ReactNode {
  const state = read('autopush')
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'session' | 'project'>('session')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (state === undefined) return null

  const toggle = (): void => {
    setError(null)
    void setEnabled(!state.enabled).then((failure) => { setError(failure) })
  }
  const last = state.lastAt === null ? t('dashboard.none') : chipTime(state.lastAt)

  return (
    <div className={css.dock} data-autopush-dock>
      <button
        type="button"
        className={state.enabled ? css.chipOn : css.chip}
        aria-pressed={state.enabled}
        aria-label={state.enabled ? t('chip.on.aria') : t('chip.off.aria')}
        title={state.enabled ? t('chip.on.title') : t('chip.off.title')}
        data-autopush-toggle
        onClick={toggle}
      >
        <GithubIcon size={13} className={css.icon} />
        <span>{t('chip.label')}</span>
      </button>
      <button
        type="button"
        className={css.summary}
        aria-expanded={open}
        data-autopush-summary
        onClick={() => { setOpen(value => !value) }}
      >
        <span data-autopush-count>{state.count}</span>
        <span className={css.dot}>·</span>
        <span data-autopush-last>{last}</span>
      </button>
      {error !== null && <span className={css.error} role="status" title={error}>{error}</span>}
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('dashboard.title')} data-autopush-panel>
          <div className={css.panelHead}>
            <span>{t('dashboard.title')}</span>
            <span className={css.panelSpacer} />
            <button
              type="button"
              className={css.close}
              aria-label={t('dashboard.close')}
              data-autopush-close
              onClick={() => { setOpen(false) }}
            >
              ✕
            </button>
          </div>
          <dl className={css.facts}>
            <dt>{t('dashboard.session')}</dt>
            <dd>{state.enabled ? t('chip.on.title') : t('chip.off.title')}</dd>
            <dt>{t('dashboard.count')}</dt>
            <dd data-autopush-panel-count>{state.count}</dd>
            <dt>{t('dashboard.last')}</dt>
            <dd data-autopush-panel-last>{state.lastAt === null ? t('dashboard.none') : fullTime(state.lastAt)}</dd>
          </dl>
          <div className={css.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'session'}
              className={activeTab === 'session' ? css.tabBtnActive : css.tabBtn}
              onClick={() => { setActiveTab('session') }}
            >
              {t('dashboard.tab.session')} ({state.history.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'project'}
              className={activeTab === 'project' ? css.tabBtnActive : css.tabBtn}
              onClick={() => { setActiveTab('project') }}
            >
              {t('dashboard.tab.project')} ({state.projectHistory?.length ?? 0})
            </button>
          </div>
          {activeTab === 'session' ? (
            state.history.length === 0
              ? <p className={css.empty}>{t('dashboard.empty')}</p>
              : (
                <ol className={css.history} data-autopush-history>
                  {state.history.map(push => (
                    <li key={`${push.sha}-${String(push.at)}`} className={css.entry}>
                      <span className={css.stamp}>{fullTime(push.at)}</span>
                      <span className={css.message}>{push.message}</span>
                      <span className={css.meta}>
                        {push.sha}
                        {' · '}
                        {t('dashboard.files', { files: push.files })}
                        {' · '}
                        {push.remote}/{push.branch}
                      </span>
                    </li>
                  ))}
                </ol>
              )
          ) : (
            (state.projectHistory === undefined || state.projectHistory.length === 0)
              ? <p className={css.empty}>{t('dashboard.emptyProject')}</p>
              : (
                <ol className={css.history} data-autopush-history>
                  {state.projectHistory.map(push => (
                    <li key={`project-${push.sha}-${String(push.at)}`} className={css.entry}>
                      <span className={css.stamp}>{push.date ?? fullTime(push.at)}</span>
                      <span className={css.message}>{push.message}</span>
                      <span className={css.meta}>
                        {push.sha}
                        {' · '}
                        {t('dashboard.files', { files: push.files })}
                        {' · '}
                        {push.remote}/{push.branch}
                      </span>
                    </li>
                  ))}
                </ol>
              )
          )}
        </div>
      )}
    </div>
  )
}
