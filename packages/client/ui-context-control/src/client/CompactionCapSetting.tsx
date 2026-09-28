/**
 * Global compaction-cap row for the General settings page: edits the
 * `compaction-basic` settings section's `maxTokens` — the deployment default a
 * session's "follow default" state reads. Unset shows the plugin default
 * greyed; the write is immediate.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ContextControl.module.css'

/** The settings section the compaction plugin's config lives under. */
const NS = 'compaction-basic'

/** The plugin's configured default when the section writes nothing. */
const FALLBACK = 8192

/** Registrant-supplied operations for the row; copy arrives through the locale seat. */
export interface CompactionCapInjected {
  /** Read the section's stored `maxTokens`, or undefined when unset. */
  readCap: () => Promise<number | undefined>
  /** Write (or clear) the section's `maxTokens`; throws the Host diagnostic on refusal. */
  writeCap: (value: number | undefined) => Promise<void>
}

/** Full props of the General-page compaction-cap row. */
export type CompactionCapProps =
  PropsRuntime<'settings.general.item'>
  & InjectFace<CompactionCapInjected>
  & PropsLocale<'ui-context-control'>

/**
 * Render the global compaction-cap setting.
 * @param props - the injected read/write face and locale seat.
 * @returns the settings row.
 */
export function CompactionCap({ t, readCap, writeCap }: CompactionCapProps): ReactNode {
  const [stored, setStored] = useState<number | undefined>(undefined)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const reads = useRef(readCap)
  reads.current = readCap

  useEffect(() => {
    void reads.current().then((value) => {
      setStored(value)
      setText(value === undefined ? '' : String(value))
    })
  }, [])

  return (
    <div className={css.sliderRow}>
      <span className={css.autoToggle}>{t('settings.summaryCap')}</span>
      <input
        className={css.input}
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={String(stored ?? FALLBACK)}
        aria-label={t('settings.summaryCap')}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const parsed = next.trim() === '' ? undefined : Number(next.trim())
          if (next.trim() !== '' && (!Number.isSafeInteger(parsed) || (parsed ?? 0) <= 0)) return
          void writeCap(parsed).then(
            () => {
              setStored(parsed)
              setStatus(t('settings.saved'))
            },
            (error: unknown) => {
              setStatus(t('settings.failed', { error: error instanceof Error ? error.message : String(error) }))
            },
          )
        }}
      />
      <span className={css.sliderFigures}>{t('settings.capHint')}</span>
      {status === null ? null : <span role="status" className={css.sliderFigures}>{status}</span>}
    </div>
  )
}

export { NS as COMPACTION_CAP_SETTINGS_NAMESPACE }