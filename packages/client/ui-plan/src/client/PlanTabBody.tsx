/**
 * The Plan tab's body: a Current pane over the newest plan the model presented
 * for review, and a History pane over the plans it superseded.
 *
 * Plans arrive through the host-computed `plan` projection, so the tab shows
 * the same plans a restore or fork would, without replaying tool calls here. A
 * session that never presented one shows the empty line instead.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, MarkdownText, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type { PlanPresentation } from '@deepseek-ai/dsh-plan-mode/client'
import type {} from './locales.ts'
import type { PlanTabInjected } from './index.ts'
import type { createPlanTabStore } from './store.ts'
import css from './PlanTabBody.module.css'

/** The sub-tab a reader is looking at; the body opens on the newest plan. */
type PlanPane = 'current' | 'history'

/** No presented plans: one stable value, so an unprojected session keeps a stable list identity. */
const NO_PLANS: readonly PlanPresentation[] = []

/** The body's composed props: the tab's projection, the opened-plan mark, the apply verb, and its copy. */
export type PlanTabBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createPlanTabStore>>
  & InjectFace<PlanTabInjected>
  & PropsLocale<'plan'>

/**
 * One plan's presentation time through the dictionary's date template (the
 * workspace row pattern): `toLocaleString` would follow the browser language,
 * not the app locale, and produce mixed-language text after a switch.
 * @param at - Unix epoch milliseconds of the presentation.
 * @param t - the body's locale seat.
 * @returns the localized date and a zero-padded `HH:MM`.
 */
function planStamp(at: number, t: PlanTabBodyProps['t']): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = t('tab.ymd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() })
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The Plan tab's body. */
export function PlanTabBody(
  { useProjection, useStore, actions, applyPlan, t }: PlanTabBodyProps,
): ReactNode {
  const plan = useProjection('plan')
  const seenAt = useStore(state => state.seenAt)
  const [pane, setPane] = useState<PlanPane>('current')
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Reference-stable per locale revision: a fresh object each render would drop
  // MarkdownText's render cache.
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const presented = plan?.presented ?? null
  const history = plan?.history ?? NO_PLANS
  const past = presented === null ? history : history.slice(1)
  const opened = past.find(item => item.at === openedAt) ?? null
  const unseenAt = presented === null || (seenAt !== null && presented.at <= seenAt) ? null : presented.at

  // Opening the Current pane is what records the newest plan as read; the declared
  // store holds that mark, so switching sidebar tabs cannot re-announce it.
  useEffect(() => {
    if (pane === 'current' && unseenAt !== null) actions.markSeen(unseenAt)
  }, [pane, unseenAt, actions])

  const apply = (): void => {
    setFailure(null)
    void applyPlan().then((reason) => { setFailure(reason) }, (reason: unknown) => {
      setFailure(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <div className={css.body} data-plan-tab>
      <div className={css.subtabs}>
        <Pill
          active={pane === 'current'}
          aria-pressed={pane === 'current'}
          data-plan-subtab="current"
          onClick={() => { setPane('current') }}
        >
          {t('tab.current')}
          {/* Marked only while another pane is showing: entering this one records
              the plan as read before it could render. */}
          {unseenAt !== null && pane === 'history' && (
            <span className={css.badge} data-plan-new><Tag tone="info">{t('tab.new')}</Tag></span>
          )}
        </Pill>
        <Pill
          active={pane === 'history'}
          aria-pressed={pane === 'history'}
          data-plan-subtab="history"
          onClick={() => { setPane('history') }}
        >
          {t('tab.history')}
          {past.length > 0 && (
            <span className={css.badge} data-plan-history-count><Tag tone="neutral">{String(past.length)}</Tag></span>
          )}
        </Pill>
      </div>
      {pane === 'current' ? (
        <div className={css.pane} data-plan-pane="current">
          {presented === null
            ? <p className={css.empty} role="status" data-plan-tab-empty>{t('tab.empty')}</p>
            : (
              <>
                <article className={css.document}>
                  <MarkdownText text={presented.plan} labels={labels} />
                </article>
                <div className={css.apply}>
                  <Button variant="primary" data-plan-apply onClick={apply}>{t('apply.label')}</Button>
                  {failure !== null && (
                    <p className={css.failure} role="status" data-plan-apply-failed>
                      {`${t('apply.failed')}: ${failure}`}
                    </p>
                  )}
                </div>
              </>
            )}
        </div>
      ) : (
        <div className={css.pane} data-plan-pane="history">
          {past.length === 0
            ? <p className={css.empty} role="status" data-plan-history-empty>{t('tab.historyEmpty')}</p>
            : (
              <ol className={css.history} data-plan-history-list>
                {past.map((item, index) => (
                  <li key={`${String(item.at)}-${String(index)}`}>
                    <button
                      type="button"
                      className={css.row}
                      aria-pressed={item.at === opened?.at}
                      data-plan-history-row
                      onClick={() => { setOpenedAt(item.at) }}
                    >
                      <span className={css.rowTitle}>{item.title ?? t('tab.untitled')}</span>
                      <span className={css.rowStamp}>{planStamp(item.at, t)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          {opened !== null && (
            <article className={css.document} data-plan-history-document>
              <MarkdownText text={opened.plan} labels={labels} />
            </article>
          )}
        </div>
      )}
    </div>
  )
}
