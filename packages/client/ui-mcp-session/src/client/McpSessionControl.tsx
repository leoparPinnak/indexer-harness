import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { McpSessionServerView, McpSessionSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  Switch,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './McpSessionControl.module.css'

/** Registration-side Remote face used by the composer control. */
export interface McpSessionControlInjected {
  /** Read one session's MCP server visibility. */
  listServers: (sessionId: string) => Promise<McpSessionSnapshot>
  /** Switch one server for one session and read the rows back. */
  setServerEnabled: (sessionId: string, serverName: string, enabled: boolean) => Promise<McpSessionSnapshot>
}

/** Full component props assembled by the composer slot renderer. */
export type McpSessionControlProps =
  PropsRuntime<'conversation.input.left'>
  & PropsLocale<'mcp.session'>
  & InjectFace<McpSessionControlInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly servers: readonly McpSessionServerView[] }

/**
 * Compact MCP switch cluster for the composer tool row: one trigger showing how
 * many of the known servers this session keeps, and a panel of switches that
 * writes the session's own choice.
 */
export function McpSessionControl({ sessionId, listServers, setServerEnabled, t }: McpSessionControlProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [writeFailed, setWriteFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, side: 'top', gap: 8, margin: 8 })

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    let current = true
    setState({ status: 'loading' })
    void Promise.resolve().then(() => listServers(sessionId)).then(
      (snapshot) => { if (current) setState({ status: 'ready', servers: snapshot.servers }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [open, request, listServers, sessionId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const servers = state.status === 'ready' ? state.servers : []
  const kept = servers.filter(server => server.enabled).length

  /** Write one switch; the panel keeps its rows and reports only its own failure. */
  const toggle = (server: McpSessionServerView, next: boolean): void => {
    setWriteFailed(false)
    setBusy(server.serverName)
    void Promise.resolve().then(() => setServerEnabled(sessionId, server.serverName, next)).then(
      (snapshot) => {
        setBusy(null)
        setState({ status: 'ready', servers: snapshot.servers })
      },
      () => {
        setBusy(null)
        setWriteFailed(true)
      },
    )
  }

  return (
    <div className={css.root} ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className={open ? `${css.trigger} ${css.triggerOpen}` : css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('label')}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.triggerLabel}>{t('label')}</span>
        {state.status === 'ready' ? (
          <span className={css.count} data-mcp-kept={kept} data-mcp-total={servers.length}>
            {`${String(kept)}/${String(servers.length)}`}
          </span>
        ) : null}
        <IconChevronDownOutline14
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
          aria-hidden
        />
      </button>
      {open && position !== null ? createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('title')}
          className={css.panel}
          style={position}
        >
          <p className={css.title}>{t('title')}</p>
          {state.status === 'loading' ? <p className={css.note}>{t('loading')}</p> : null}
          {state.status === 'error' ? (
            <p className={css.note} role="alert">
              {t('error')}
              <button
                type="button"
                className={css.retry}
                onClick={() => { setRequest(value => value + 1) }}
              >
                {t('retry')}
              </button>
            </p>
          ) : null}
          {writeFailed ? <p className={css.note} role="alert">{t('writeFailed')}</p> : null}
          {state.status === 'ready' && servers.length === 0 ? <p className={css.note}>{t('empty')}</p> : null}
          {servers.length > 0 ? (
            <ul className={css.list}>
              {servers.map(server => (
                <li key={server.serverName} className={css.row} data-mcp-server={server.serverName}>
                  <span className={css.rowName}>{server.serverName}</span>
                  <span className={css.rowTools}>{t('tools', { count: String(server.toolCount) })}</span>
                  {server.hostEnabled ? (
                    <Switch
                      checked={server.enabled}
                      disabled={busy === server.serverName}
                      label={t('toggle', { name: server.serverName })}
                      title={busy === server.serverName ? t('pending') : undefined}
                      onChange={(next) => { toggle(server, next) }}
                    />
                  ) : (
                    <span className={css.hostDisabled}>{t('hostDisabledNote')}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
