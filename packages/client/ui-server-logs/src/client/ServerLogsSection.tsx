/**
 * The settings Server Logs section: the host log file's tail as newest-first
 * text, with a substring filter, live refresh, and a clear action.
 *
 * Newest-first keeps the freshest lines visible without scroll anchoring:
 * following the log is re-rendering, not scrolling.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './ServerLogsSection.module.css'

/** The host route serving the log file tail. */
const LOGS_URL = '/api/server/logs'

/** The host route truncating the log file. */
const CLEAR_URL = '/api/server/logs/clear'

/** Lines requested per tail fetch. */
const TAIL_LIMIT = 300

/** Live refresh period in milliseconds. */
const REFRESH_MS = 2000

/** The section's composed props: the section owner share and its copy. */
export type ServerLogsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'serverLogs'>

interface LogsPayload {
  readonly ok: boolean
  readonly lines?: unknown
  readonly truncated?: unknown
}

/** Keep the response's string lines; anything else reads as no lines. */
function toLines(payload: LogsPayload): string[] {
  if (!payload.ok || !Array.isArray(payload.lines)) return []
  return payload.lines.filter((line): line is string => typeof line === 'string')
}

/** Render the Server Logs section content column. */
export function ServerLogsSection({ t }: ServerLogsSectionProps): ReactNode {
  const [lines, setLines] = useState<readonly string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [filter, setFilter] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${LOGS_URL}?limit=${String(TAIL_LIMIT)}`)
        if (cancelled) return
        if (!res.ok) {
          setError(t('logs.error.load'))
          return
        }
        const data = await res.json() as LogsPayload
        if (!data.ok) {
          setError(t('logs.error.load'))
          return
        }
        setLines(toLines(data))
        setTruncated(data.truncated === true)
        setError(undefined)
      } catch {
        if (!cancelled) setError(t('logs.error.load'))
      }
    }
    void load()
    if (!autoRefresh) return undefined
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [autoRefresh, revision])

  const query = filter.trim().toLowerCase()
  const visible = query === '' ? lines : lines.filter(line => line.toLowerCase().includes(query))
  const view = [...visible].reverse()

  const handleRefresh = (): void => {
    setRevision(revision + 1)
  }

  const handleClear = async (): Promise<void> => {
    try {
      const res = await fetch(CLEAR_URL, { method: 'POST' })
      if (!res.ok) {
        setError(t('logs.error.clear'))
        return
      }
      const data = await res.json() as { ok: boolean; cleared?: unknown }
      if (!data.ok || data.cleared !== true) {
        setError(t('logs.error.clear'))
        return
      }
      setLines([])
      setTruncated(false)
      setError(undefined)
    } catch {
      setError(t('logs.error.clear'))
    }
  }

  return (
    <div className={css.section} data-server-logs>
      <p className={css.description}>{t('logs.description')}</p>
      <div className={css.toolbar}>
        <input
          type="search"
          className={css.filter}
          aria-label={t('logs.filter.label')}
          placeholder={t('logs.filter.placeholder')}
          value={filter}
          onChange={(event) => { setFilter(event.target.value) }}
        />
        <label className={css.toggle}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => { setAutoRefresh(event.target.checked) }}
          />
          {t('logs.autorefresh')}
        </label>
        <button type="button" className={css.toolButton} onClick={handleRefresh}>
          {t('logs.action.refresh')}
        </button>
        <button type="button" className={css.toolButton} onClick={() => void handleClear()}>
          {t('logs.action.clear')}
        </button>
      </div>
      {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}
      {truncated ? <p className={css.note}>{t('logs.truncated')}</p> : null}
      {view.length === 0
        ? <p className={css.note}>{t('logs.empty')}</p>
        : <pre className={css.pane}>{view.join('\n')}</pre>}
    </div>
  )
}
