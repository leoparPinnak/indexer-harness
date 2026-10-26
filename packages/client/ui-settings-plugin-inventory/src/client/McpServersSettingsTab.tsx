import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AddMcpServerRequest, McpServersSnapshot, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './McpServersSettingsTab.module.css'

/** Registration-side Remote face used by the MCP servers tab. */
export interface McpServersSettingsTabInjected {
  /** Read the current MCP server rows. */
  list: () => Promise<McpServersSnapshot>
  /** Write one server's enablement through the Host's managed patch block. */
  setEnabled: (entryId: string, enabled: boolean) => Promise<McpServersSnapshot>
  /** Add one server through the Host's managed patch block. */
  addServer: (request: AddMcpServerRequest) => Promise<McpServersSnapshot>
}

/** Full component props assembled by the Settings slot renderer. */
export type McpServersSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<McpServersSettingsTabInjected>

type Translate = McpServersSettingsTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly servers: readonly McpServerView[] }

/** Status copy for each connection transition a live row can report. */
const STATE_LABELS = {
  connected: 'mcpStateConnected',
  connecting: 'mcpStateConnecting',
  reconnecting: 'mcpStateReconnecting',
  failed: 'mcpStateFailed',
  stopped: 'mcpStateStopped',
} as const satisfies Record<NonNullable<McpServerView['state']>, PluginInventoryLocaleKey>

/** Dot and palette paired with each connection transition's copy. */
const STATE_VISUALS = {
  connected: { dot: 'done', tone: 'success' },
  connecting: { dot: 'ongoing', tone: 'info' },
  reconnecting: { dot: 'ongoing', tone: 'warning' },
  failed: { dot: 'error', tone: 'danger' },
  stopped: { dot: 'idle', tone: 'neutral' },
} as const satisfies Record<NonNullable<McpServerView['state']>, { dot: StateDotState; tone: TagTone }>

/** One row's effective status: tag copy, optional dot, and tag palette. */
interface RowStatus {
  readonly label: string
  /** Dot state, or null when nothing is in flight and nothing is running. */
  readonly dot: StateDotState | null
  readonly tone: TagTone
}

/**
 * Effective status of one server: Loader disablement first, then a failed
 * fiber, then the connection transition the mcp-client supervisor last
 * recorded — a server the Loader never started has recorded none.
 */
function rowStatus(server: McpServerView, t: Translate): RowStatus {
  if (!server.enabled) return { label: t('disabledTag'), dot: null, tone: 'neutral' }
  if (server.fiberPhase === 'failed') return { label: t('failedTag'), dot: 'error', tone: 'danger' }
  if (server.state === null) return { label: t('mcpStateUnknown'), dot: null, tone: 'neutral' }
  return { label: t(STATE_LABELS[server.state]), ...STATE_VISUALS[server.state] }
}

/** One server's identity, live status, tool count, and enablement switch. */
function ServerRow({ server, pending, t, onToggle }: {
  readonly server: McpServerView
  readonly pending: boolean
  readonly t: Translate
  readonly onToggle: (next: boolean) => void
}): ReactNode {
  const status = rowStatus(server, t)
  return (
    <li
      className={css.row}
      data-mcp-entry={server.entryId}
      data-mcp-state={server.state ?? 'unknown'}
      data-mcp-enabled={server.enabled ? 'true' : 'false'}
    >
      <div className={css.rowMain}>
        <span className={css.identity}>
          <strong className={css.name} title={server.serverName}>{server.serverName}</strong>
          <code className={css.entry} title={server.entryId}>{server.entryId}</code>
        </span>
        <span className={css.trailing}>
          {server.enabled ? (
            <span className={css.tools}>{t('mcpTools', { count: String(server.toolCount) })}</span>
          ) : null}
          {status.dot === null ? null : (
            <span className={css.dot} role="img" aria-label={status.label} title={status.label}>
              <StateDot state={status.dot} />
            </span>
          )}
          <Tag tone={status.tone}>{status.label}</Tag>
          <Switch
            checked={server.enabled}
            disabled={pending}
            label={t('mcpSwitchLabel', { name: server.serverName })}
            title={pending ? t('mcpApplying') : undefined}
            onChange={onToggle}
          />
        </span>
      </div>
      {server.enabled && server.lastError !== null ? (
        <p className={css.rowError} role="alert">{server.lastError}</p>
      ) : null}
    </li>
  )
}

/** Render every configured MCP server with its live status and enablement switch. */
export function McpServersSettingsTab({ list, setEnabled, addServer, t }: McpServersSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [busy, setBusy] = useState<readonly string[]>([])
  const [writeFailed, setWriteFailed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addFailed, setAddFailed] = useState(false)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', servers: snapshot.servers }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  /** Write one toggle and adopt the rows the Host reports back. */
  const toggle = (server: McpServerView, next: boolean): void => {
    setWriteFailed(false)
    setBusy(current => [...current, server.entryId])
    void Promise.resolve().then(() => setEnabled(server.entryId, next)).then(
      (snapshot) => {
        setBusy(current => current.filter(id => id !== server.entryId))
        setState({ status: 'ready', servers: snapshot.servers })
      },
      () => {
        setBusy(current => current.filter(id => id !== server.entryId))
        setWriteFailed(true)
      },
    )
  }

  /** Write one add-server submit, adopt the rows, and close the form. */
  const submitAdd = (requestBody: AddMcpServerRequest): Promise<void> =>
    Promise.resolve().then(() => addServer(requestBody)).then(
      (snapshot) => {
        setAddOpen(false)
        setAddFailed(false)
        setState({ status: 'ready', servers: snapshot.servers })
      },
      () => {
        setAddFailed(true)
      },
    )

  const servers = state.status === 'ready' ? state.servers : []
  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('mcpLoading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('mcpError')}</p>
          <button
            type="button"
            onClick={() => {
              setState({ status: 'loading' })
              setRequest(value => value + 1)
            }}
          >
            {t('retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <div className={css.heading}>
            <h3>{t('mcpTab')}</h3>
            <span className={css.headingTrail}>
              <span data-mcp-count={servers.length}>
                {`${String(servers.length)} ${t('mcpCountUnit')}`}
              </span>
              <button
                type="button"
                className={css.addOpen}
                aria-expanded={addOpen}
                data-mcp-add-open={addOpen ? 'true' : 'false'}
                onClick={() => { setAddOpen(value => !value); setAddFailed(false) }}
              >
                {t('mcpAddOpen')}
              </button>
            </span>
          </div>
          {writeFailed ? <p className={css.writeFailure} role="alert">{t('mcpWriteFailed')}</p> : null}
          {addOpen ? (
            <AddServerForm t={t} failed={addFailed} onAdd={submitAdd} onCancel={() => { setAddOpen(false); setAddFailed(false) }} />
          ) : null}
          {servers.length === 0 && !addOpen ? <p className={css.status}>{t('mcpEmpty')}</p> : null}
          {servers.length > 0 ? (
            <ul className={css.rows}>
              {servers.map(server => (
                <ServerRow
                  key={server.entryId}
                  server={server}
                  pending={busy.includes(server.entryId)}
                  t={t}
                  onToggle={(next) => { toggle(server, next) }}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Form shape the add-server panel edits; every line-based field is raw text. */
interface AddFormState {
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command: string
  readonly args: string
  readonly env: string
  readonly cwd: string
  readonly url: string
  readonly headers: string
}

/** The empty form: stdio defaults, every line-based field blank. */
const EMPTY_ADD_FORM: AddFormState = {
  serverName: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  cwd: '',
  url: '',
  headers: '',
}

/** Split one-per-line form text into its value list, dropping blank lines. */
function parseLines(value: string): readonly string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** Split `NAME=VALUE` lines into a record; a malformed line is form-invalid. */
function parseAssignments(value: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {}
  for (const line of parseLines(value)) {
    const at = line.indexOf('=')
    if (at <= 0) return undefined
    entries[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return entries
}

/** Split `NAME: VALUE` lines into a record; a malformed line is form-invalid. */
function parseHeaderPairs(value: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {}
  for (const line of parseLines(value)) {
    const at = line.indexOf(':')
    if (at <= 0) return undefined
    entries[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return entries
}

/**
 * The add-server form: transport choice, name, and the transport's fields.
 * Submission assembles the Remote request; the Host owns every validation
 * beyond the syntactic parse this form performs.
 */
function AddServerForm({ t, failed, onAdd, onCancel }: {
  readonly t: McpServersSettingsTabProps['t']
  readonly failed: boolean
  readonly onAdd: (request: AddMcpServerRequest) => Promise<void>
  readonly onCancel: () => void
}): ReactNode {
  const [form, setForm] = useState<AddFormState>(EMPTY_ADD_FORM)
  const [submitting, setSubmitting] = useState(false)
  const field = (key: keyof AddFormState) => ({
    value: form[key],
    onChange: (event: { currentTarget: { value: string } }) => {
      const { value } = event.currentTarget
      setForm(current => ({ ...current, [key]: value }))
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (form.transport === 'stdio') {
      const env = parseAssignments(form.env)
      if (env === undefined) return
      const request: AddMcpServerRequest = {
        serverName: form.serverName.trim(),
        transport: 'stdio',
        command: form.command.trim(),
        args: parseLines(form.args),
        env,
        ...(form.cwd.trim() === '' ? {} : { cwd: form.cwd.trim() }),
      }
      setSubmitting(true)
      void onAdd(request).finally(() => { setSubmitting(false) })
      return
    }
    const headers = parseHeaderPairs(form.headers)
    if (headers === undefined) return
    const request: AddMcpServerRequest = {
      serverName: form.serverName.trim(),
      transport: 'streamable-http',
      url: form.url.trim(),
      headers,
    }
    setSubmitting(true)
    void onAdd(request).finally(() => { setSubmitting(false) })
  }

  return (
    <form
      className={css.addForm}
      data-mcp-add-form="true"
      data-mcp-add-failed={failed ? 'true' : 'false'}
      onSubmit={submit}
      onReset={onCancel}
    >
      <p className={css.addTitle}>{t('mcpAddTitle')}</p>
      <p className={css.addHint}>{t('mcpAddHostNote')}</p>
      <div className={css.addField}>
        <label htmlFor="dsh-mcp-add-name">{t('mcpAddName')}</label>
        <input id="dsh-mcp-add-name" inputMode="text" required {...field('serverName')} />
        <p className={css.addHint}>{t('mcpAddNameHint')}</p>
      </div>
      <div className={css.addField}>
        <label htmlFor="dsh-mcp-add-transport">{t('mcpAddTransport')}</label>
        <select id="dsh-mcp-add-transport" {...field('transport')}>
          <option value="stdio">{t('mcpAddStdio')}</option>
          <option value="streamable-http">{t('mcpAddHttp')}</option>
        </select>
      </div>
      {form.transport === 'stdio' ? (
        <>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-command">{t('mcpAddCommand')}</label>
            <input id="dsh-mcp-add-command" inputMode="text" required {...field('command')} />
          </div>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-args">{t('mcpAddArgs')}</label>
            <textarea id="dsh-mcp-add-args" rows={2} {...field('args')} />
          </div>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-env">{t('mcpAddEnv')}</label>
            <textarea id="dsh-mcp-add-env" rows={2} {...field('env')} data-mcp-env-invalid={parseAssignments(form.env) === undefined ? 'true' : 'false'} />
          </div>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-cwd">{t('mcpAddCwd')}</label>
            <input id="dsh-mcp-add-cwd" inputMode="text" {...field('cwd')} />
          </div>
        </>
      ) : (
        <>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-url">{t('mcpAddUrl')}</label>
            <input id="dsh-mcp-add-url" type="url" required {...field('url')} />
            <p className={css.addHint}>{t('mcpAddUrlHint')}</p>
          </div>
          <div className={css.addField}>
            <label htmlFor="dsh-mcp-add-headers">{t('mcpAddHeaders')}</label>
            <textarea id="dsh-mcp-add-headers" rows={2} {...field('headers')} data-mcp-headers-invalid={parseHeaderPairs(form.headers) === undefined ? 'true' : 'false'} />
          </div>
        </>
      )}
      {failed ? <p className={css.writeFailure} role="alert">{t('mcpWriteFailed')}</p> : null}
      <div className={css.addActions}>
        <button type="reset" disabled={submitting}>{t('mcpAddCancel')}</button>
        <button type="submit" disabled={submitting}>{t('mcpAddSubmit')}</button>
      </div>
    </form>
  )
}
