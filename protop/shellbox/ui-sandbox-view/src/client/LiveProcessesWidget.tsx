/**
 * Live-process widget for the sandbox pane: the visible windows of the tracked
 * desktop, fed by the helper's state snapshot, with the two window actions the
 * host exposes. Window titles and executable names are user data and stay
 * verbatim; every label comes from the namespace dictionary.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SandboxViewKey } from './locales.ts'
import css from './LiveProcessesWidget.module.css'

/** One window of the sandbox desktop, as the host reports it. */
export interface LiveProcessesWindow {
  readonly hwnd: number
  readonly pid: number
  readonly title: string
  readonly exe: string
}

/** What the host answers on the windows route. */
interface WindowsResponse {
  readonly ok?: boolean
  readonly active?: boolean
  readonly windows?: readonly LiveProcessesWindow[]
}

/** Composed props: the copy seat, the three routes, and the parent's window scope. */
export interface LiveProcessesWidgetProps {
  /** Namespace translator owned by the pane's locale seat. */
  readonly t: (key: SandboxViewKey) => string
  /** `GET` route that answers the desktop's visible windows. */
  readonly windowsUrl: string
  /** `POST` route that foregrounds one window. */
  readonly focusUrl: string
  /** `POST` route that closes one window. */
  readonly closeUrl: string
  /** Session/instance/target fields every action body carries. */
  readonly requestBody: Record<string, unknown>
  /** Report a host refusal to the pane's status line. */
  readonly onRefused: (message: string) => void
}

/** Poll interval of the window list while the pane is mounted. */
const POLL_MS = 3000

/**
 * Draw the live-process list and run its focus, close, and refresh actions.
 * @param props - the copy seat, routes, request scope, and refusal sink.
 * @returns the widget.
 */
export function LiveProcessesWidget({
  t,
  windowsUrl,
  focusUrl,
  closeUrl,
  requestBody,
  onRefused,
}: LiveProcessesWidgetProps): ReactNode {
  const [windows, setWindows] = useState<readonly LiveProcessesWindow[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const requestSeq = useRef(0)
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    requestSeq.current += 1
    const seq = requestSeq.current
    try {
      const res = await fetch(windowsUrl)
      const body = await res.json() as WindowsResponse
      if (!mounted.current || seq !== requestSeq.current) return
      setFailed(!res.ok)
      setWindows(Array.isArray(body.windows) ? body.windows : [])
    } catch {
      if (!mounted.current || seq !== requestSeq.current) return
      setFailed(true)
    }
  }, [windowsUrl])

  const act = useCallback(async (url: string, hwnd: number): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody, hwnd }),
      })
      if (!res.ok) onRefused(t('control.refused'))
    } catch {
      onRefused(t('control.refused'))
    }
    await load()
  }, [load, onRefused, requestBody, t])

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [load])

  return (
    <section className={css.panel} aria-label={t('processes.title')}>
      <header className={css.head}>
        <span className={css.title}>{t('processes.title')}</span>
        <button
          type="button"
          className={css.action}
          onClick={() => void load()}
        >
          {t('processes.action.refresh')}
        </button>
      </header>
      {windows === undefined ? (
        <p className={css.note}>{t('processes.loading')}</p>
      ) : failed && windows.length === 0 ? (
        <p className={css.note} role="alert">{t('processes.error')}</p>
      ) : windows.length === 0 ? (
        <p className={css.note}>{t('processes.empty')}</p>
      ) : (
        <ul className={css.list}>
          {windows.map(win => (
            <li key={win.hwnd} className={css.row}>
              <span className={css.windowTitle} title={win.title}>
                {win.title !== '' ? win.title : win.exe}
              </span>
              <span className={css.meta}>{win.exe}{' · '}{t('processes.meta.pid')}{win.pid}</span>
              <span className={css.rowActions}>
                <button
                  type="button"
                  className={css.action}
                  onClick={() => void act(focusUrl, win.hwnd)}
                >
                  {t('processes.action.focus')}
                </button>
                <button
                  type="button"
                  className={css.action}
                  onClick={() => void act(closeUrl, win.hwnd)}
                >
                  {t('processes.action.close')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
