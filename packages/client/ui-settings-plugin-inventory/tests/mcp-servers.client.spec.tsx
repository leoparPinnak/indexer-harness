// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddMcpServerRequest, McpServersSnapshot, McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpServersSettingsTab } from '../src/client/McpServersSettingsTab.tsx'
import type {
  McpServersSettingsTabInjected,
  McpServersSettingsTabProps,
} from '../src/client/McpServersSettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as McpServersSettingsTabProps['t']

function props(
  list: McpServersSettingsTabInjected['list'],
  setEnabled: McpServersSettingsTabInjected['setEnabled'] = async () => ({ servers: [] }),
  addServer: McpServersSettingsTabInjected['addServer'] = async () => ({ servers: [] }),
): McpServersSettingsTabProps {
  return { t, list, setEnabled, addServer } as McpServersSettingsTabProps
}

/** One server row; every field a row can report is spelled out at its call site. */
function row(spec: {
  entryId: string
  serverName: string
  enabled: boolean
  fiberPhase: McpServerView['fiberPhase']
  state: McpServerView['state']
  toolCount?: number
  lastError?: string | null
}): McpServerView {
  return { toolCount: 0, lastError: null, ...spec } as unknown as McpServerView
}

function snapshot(...servers: McpServerView[]): McpServersSnapshot {
  return { servers } as McpServersSnapshot
}

/** A deployment with a live server, a disabled one, and a failed fiber. */
const MIXED = snapshot(
  row({ entryId: 'mcp-rea', serverName: 'rea', enabled: true, fiberPhase: 'active', state: 'connected', toolCount: 207 }),
  row({ entryId: 'mcp-git', serverName: 'git', enabled: false, fiberPhase: null, state: 'stopped', lastError: 'stale' }),
  row({ entryId: 'mcp-pdf', serverName: 'pdf', enabled: true, fiberPhase: 'failed', state: null, lastError: 'spawn ENOENT' }),
)

/** One enabled server per connection transition, plus the unrecorded state. */
const TRANSITIONS = snapshot(
  row({ entryId: 'a', serverName: 'a', enabled: true, fiberPhase: 'active', state: 'connected' }),
  row({ entryId: 'b', serverName: 'b', enabled: true, fiberPhase: 'active', state: 'connecting' }),
  row({ entryId: 'c', serverName: 'c', enabled: true, fiberPhase: 'active', state: 'reconnecting', lastError: 'broken pipe' }),
  row({ entryId: 'd', serverName: 'd', enabled: true, fiberPhase: 'active', state: 'failed', lastError: 'ECONNREFUSED' }),
  row({ entryId: 'e', serverName: 'e', enabled: true, fiberPhase: 'active', state: 'stopped' }),
  row({ entryId: 'f', serverName: 'f', enabled: true, fiberPhase: 'pending', state: null }),
)

/** The accessible name of one row's enablement switch. */
const switchLabel = (serverName: string): string => en.mcpSwitchLabel.replace('{name}', serverName)

const switchFor = (serverName: string): HTMLButtonElement =>
  screen.getByRole('switch', { name: switchLabel(serverName) }) as HTMLButtonElement

describe('McpServersSettingsTab', () => {
  it('holds the loading state until the first read settles', async () => {
    const deferred = Promise.withResolvers<McpServersSnapshot>()
    const view = render(<McpServersSettingsTab {...props(() => deferred.promise)} />)

    expect(screen.getByText(en.mcpLoading)).toBeTruthy()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')

    await act(async () => { deferred.resolve(MIXED) })
    expect(screen.queryByText(en.mcpLoading)).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  })

  it('renders every server with its identity, tool count, status and switch', async () => {
    const view = render(<McpServersSettingsTab {...props(async () => MIXED)} />)
    await screen.findByRole('switch', { name: switchLabel('rea') })

    expect(view.container.querySelector('[data-mcp-count]')?.getAttribute('data-mcp-count')).toBe('3')
    expect(screen.getByText(`3 ${en.mcpCountUnit}`)).toBeTruthy()

    const rea = view.container.querySelector('[data-mcp-entry="mcp-rea"]')
    expect(rea?.getAttribute('data-mcp-state')).toBe('connected')
    expect(rea?.getAttribute('data-mcp-enabled')).toBe('true')
    expect(rea?.querySelector('code')?.textContent).toBe('mcp-rea')
    expect(screen.getByText(`207 ${en.mcpTools.replace('{count} ', '')}`)).toBeTruthy()
    expect(screen.getByRole('img', { name: en.mcpStateConnected })).toBeTruthy()
    expect(switchFor('rea').getAttribute('aria-checked')).toBe('true')

    // A disabled Loader row reports disablement alone: no tool count, no dot,
    // and the error its last connection left behind stays out of the list.
    const git = view.container.querySelector('[data-mcp-entry="mcp-git"]')
    expect(git?.getAttribute('data-mcp-state')).toBe('stopped')
    expect(git?.getAttribute('data-mcp-enabled')).toBe('false')
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
    expect(switchFor('git').getAttribute('aria-checked')).toBe('false')

    // A failed fiber outranks the connection state and shows its error.
    expect(screen.getByText(en.failedTag)).toBeTruthy()
    expect(screen.getByText('spawn ENOENT')).toBeTruthy()
    // Only the live row and the failed fiber carry a dot.
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('names every connection transition a live server can report', async () => {
    const view = render(<McpServersSettingsTab {...props(async () => TRANSITIONS)} />)
    await screen.findByRole('switch', { name: switchLabel('a') })

    expect(screen.getByRole('img', { name: en.mcpStateConnected })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.mcpStateConnecting })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.mcpStateReconnecting })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.mcpStateFailed })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.mcpStateStopped })).toBeTruthy()
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy()
    expect(screen.getByText('broken pipe')).toBeTruthy()

    // A row whose supervisor recorded nothing states that and carries no dot.
    expect(view.container.querySelector('[data-mcp-entry="f"]')?.getAttribute('data-mcp-state')).toBe('unknown')
    expect(screen.getByText(en.mcpStateUnknown)).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(5)
  })

  it('toggles one server and adopts the rows the Host reports back', async () => {
    const deferred = Promise.withResolvers<McpServersSnapshot>()
    const setEnabled = vi.fn<McpServersSettingsTabInjected['setEnabled']>(() => deferred.promise)
    render(<McpServersSettingsTab {...props(async () => MIXED, setEnabled)} />)
    await screen.findByRole('switch', { name: switchLabel('rea') })

    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledTimes(1) })
    expect(setEnabled).toHaveBeenCalledWith('mcp-rea', false)
    // The switch locks itself while the write is in flight.
    expect(switchFor('rea').disabled).toBe(true)
    expect(switchFor('rea').title).toBe(en.mcpApplying)

    await act(async () => {
      deferred.resolve(snapshot(
        row({ entryId: 'mcp-rea', serverName: 'rea', enabled: false, fiberPhase: null, state: 'stopped' }),
      ))
    })
    expect(screen.queryByText('pdf')).toBeNull()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(switchFor('rea').disabled).toBe(false)
    expect(switchFor('rea').title).toBe('')
    expect(switchFor('rea').getAttribute('aria-checked')).toBe('false')
  })

  it('reports a refused write and keeps the rows it already has', async () => {
    const setEnabled = vi.fn<McpServersSettingsTabInjected['setEnabled']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValue(MIXED)
    render(<McpServersSettingsTab {...props(async () => MIXED, setEnabled)} />)
    await screen.findByRole('switch', { name: switchLabel('rea') })

    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(screen.getByText(en.mcpWriteFailed)).toBeTruthy() })
    expect(screen.queryByText('private transport detail')).toBeNull()
    expect(screen.getByRole('switch', { name: switchLabel('rea') }).getAttribute('aria-checked')).toBe('true')
    expect(switchFor('rea').disabled).toBe(false)

    // The next write clears the report before it starts.
    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(screen.queryByText(en.mcpWriteFailed)).toBeNull() })
    expect(setEnabled).toHaveBeenCalledTimes(2)
  })

  it('adds a stdio server through the form and adopts the rows back', async () => {
    const addServer = vi.fn<McpServersSettingsTabInjected['addServer']>(async () => snapshot(
      row({ entryId: 'mcp-github', serverName: 'github', enabled: true, fiberPhase: 'loading', state: 'connecting' }),
    ))
    render(<McpServersSettingsTab {...props(async () => ({ servers: [] }), async () => ({ servers: [] }), addServer)} />)
    await screen.findByText(en.mcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.mcpAddOpen }))
    await screen.findByLabelText(en.mcpAddName)

    fireEvent.input(screen.getByLabelText(en.mcpAddName), { target: { value: 'github' } } as never)
    const command = screen.getByLabelText(en.mcpAddCommand) as HTMLInputElement
    fireEvent.input(command, { target: { value: 'node' } } as never)
    fireEvent.input(screen.getByLabelText(en.mcpAddArgs), { target: { value: 'server.mjs\n--flag a b' } } as never)
    fireEvent.input(screen.getByLabelText(en.mcpAddEnv), { target: { value: 'TOKEN=sEcReT' } } as never)

    fireEvent.click(screen.getByRole('button', { name: en.mcpAddSubmit }))
    await waitFor(() => { expect(addServer).toHaveBeenCalledTimes(1) })
    expect(addServer).toHaveBeenCalledWith({
      serverName: 'github',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs', '--flag a b'],
      env: { TOKEN: 'sEcReT' },
    } satisfies AddMcpServerRequest)
    // The form closes and the Host's refreshed rows replace the list.
    expect(await screen.findByText(en.mcpAddOpen)).toBeTruthy()
    expect(screen.getByText(en.mcpStateConnecting)).toBeTruthy()
  })

  it('adds an HTTP server, keeps a malformed env block invalid, and reports a refused write', async () => {
    const addServer = vi.fn<McpServersSettingsTabInjected['addServer']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(snapshot(row({ entryId: 'mcp-web', serverName: 'web', enabled: true, fiberPhase: null, state: null })))
    render(<McpServersSettingsTab {...props(async () => ({ servers: [] }), async () => ({ servers: [] }), addServer)} />)
    await screen.findByText(en.mcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.mcpAddOpen }))

    // A malformed env line marks the field but HTTP mode never submits env.
    fireEvent.input(screen.getByLabelText(en.mcpAddName), { target: { value: 'web' } } as never)
    fireEvent.change(screen.getByLabelText(en.mcpAddTransport), { target: { value: 'streamable-http' } } as never)
    fireEvent.input(screen.getByLabelText(en.mcpAddUrl), { target: { value: 'http://github.local/mcp' } } as never)
    fireEvent.input(screen.getByLabelText(en.mcpAddHeaders), { target: { value: 'Authorization: Bearer x' } } as never)

    fireEvent.click(screen.getByRole('button', { name: en.mcpAddSubmit }))
    await waitFor(() => { expect(screen.getByText(en.mcpWriteFailed)).toBeTruthy() })
    expect(screen.queryByText('private transport detail')).toBeNull()

    // The retry submits the same shape and closes with refreshed rows.
    fireEvent.click(screen.getByRole('button', { name: en.mcpAddSubmit }))
    await waitFor(() => { expect(addServer).toHaveBeenCalledTimes(2) })
    expect(addServer).toHaveBeenLastCalledWith({
      serverName: 'web',
      transport: 'streamable-http',
      url: 'http://github.local/mcp',
      headers: { Authorization: 'Bearer x' },
    } satisfies AddMcpServerRequest)
    expect(await screen.findByText(en.mcpAddOpen)).toBeTruthy()
  })

  it('shows a generic failure and retries into an empty list', async () => {
    const list = vi.fn<McpServersSettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ servers: [] } as McpServersSnapshot)
    render(<McpServersSettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.mcpError)
    expect(screen.queryByText('private transport detail')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText(en.mcpEmpty)).toBeTruthy()
    expect(screen.getByText(`0 ${en.mcpCountUnit}`)).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as McpServersSettingsTabInjected['list']
    const failed = render(<McpServersSettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.mcpError)
    failed.unmount()

    const deferred = Promise.withResolvers<McpServersSnapshot>()
    const pending = render(<McpServersSettingsTab {...props(() => deferred.promise)} />)
    expect(screen.getByText(en.mcpLoading)).toBeTruthy()
    pending.unmount()
    await act(async () => { deferred.resolve(MIXED) })

    const deferredFailure = Promise.withResolvers<McpServersSnapshot>()
    const pendingFailure = render(<McpServersSettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
