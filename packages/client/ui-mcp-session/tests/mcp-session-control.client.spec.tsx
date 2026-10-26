// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpSessionServerView, McpSessionSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { McpSessionControl } from '../src/client/McpSessionControl.tsx'
import type {
  McpSessionControlInjected,
  McpSessionControlProps,
} from '../src/client/McpSessionControl.tsx'
import { en, type McpSessionLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: McpSessionLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as McpSessionControlProps['t']

function props(
  listServers: McpSessionControlInjected['listServers'],
  setServerEnabled: McpSessionControlInjected['setServerEnabled'] = async () => ({ servers: [] }),
  sessionId = 'session-1',
): McpSessionControlProps {
  return { t, sessionId, listServers, setServerEnabled } as unknown as McpSessionControlProps
}

function server(spec: {
  serverName: string
  enabled: boolean
  toolCount?: number
  hostEnabled?: boolean
}): McpSessionServerView {
  return { toolCount: 0, hostEnabled: true, ...spec } as McpSessionServerView
}

function snapshot(...servers: McpSessionServerView[]): McpSessionSnapshot {
  return { servers } as McpSessionSnapshot
}

const TWO = snapshot(server({ serverName: 'rea', enabled: true, toolCount: 207 }), server({ serverName: 'git', enabled: false, toolCount: 3 }))

const trigger = (): HTMLButtonElement => screen.getByRole('button', { name: en.label }) as HTMLButtonElement
const switchFor = (name: string): HTMLButtonElement =>
  screen.getByRole('switch', { name: en.toggle.replace('{name}', name) }) as HTMLButtonElement

/** Open the panel and wait for its first read to settle. */
async function openPanel(
  listServers: McpSessionControlInjected['listServers'] = async () => TWO,
  setServerEnabled: McpSessionControlInjected['setServerEnabled'] = async () => ({ servers: [] }),
) {
  const view = render(<McpSessionControl {...props(listServers, setServerEnabled)} />)
  fireEvent.click(trigger())
  await screen.findByRole('dialog', { name: en.title })
  return view
}

describe('McpSessionControl', () => {
  it('stays closed until the trigger is pressed and closes on a second press', () => {
    render(<McpSessionControl {...props(async () => TWO)} />)

    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: en.title })).toBeTruthy()

    fireEvent.click(trigger())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('shows how many servers the session keeps beside the label', async () => {
    await openPanel()

    expect(trigger().textContent).toContain('1/2')
    expect(screen.getByText(`207 ${en.tools.replace('{count} ', '')}`)).toBeTruthy()
    expect(switchFor('rea').getAttribute('aria-checked')).toBe('true')
    expect(switchFor('git').getAttribute('aria-checked')).toBe('false')
  })

  it('holds the loading state until the first read settles', async () => {
    const deferred = Promise.withResolvers<McpSessionSnapshot>()
    render(<McpSessionControl {...props(() => deferred.promise)} />)
    fireEvent.click(trigger())

    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByText('1/2')).toBeNull()

    await act(async () => { deferred.resolve(TWO) })
    expect(screen.queryByText(en.loading)).toBeNull()
    expect(trigger().textContent).toContain('1/2')
  })

  it('reports a failed read and retries into the server list', async () => {
    const listServers = vi.fn<McpSessionControlInjected['listServers']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(TWO)
    render(<McpSessionControl {...props(listServers)} />)
    fireEvent.click(trigger())

    expect((await screen.findByRole('alert')).textContent).toBe(`${en.error}${en.retry}`)
    expect(screen.queryByText('private transport detail')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(listServers).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(`207 ${en.tools.replace('{count} ', '')}`)).toBeTruthy()
  })

  it('says so when the Host knows no MCP server', async () => {
    await openPanel(async () => snapshot())

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(trigger().textContent).toContain('0/0')
  })

  it('switches one server and adopts the rows the Host reports back', async () => {
    const deferred = Promise.withResolvers<McpSessionSnapshot>()
    const setServerEnabled = vi.fn<McpSessionControlInjected['setServerEnabled']>(() => deferred.promise)
    render(<McpSessionControl {...props(async () => TWO, setServerEnabled)} />)
    fireEvent.click(trigger())
    await screen.findByText('rea')

    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(setServerEnabled).toHaveBeenCalledTimes(1) })
    expect(setServerEnabled).toHaveBeenCalledWith('session-1', 'rea', false)
    expect(switchFor('rea').disabled).toBe(true)
    expect(switchFor('rea').title).toBe(en.pending)

    await act(async () => {
      deferred.resolve(snapshot(server({ serverName: 'rea', enabled: false, toolCount: 207 })))
    })
    expect(switchFor('rea').getAttribute('aria-checked')).toBe('false')
    expect(switchFor('rea').disabled).toBe(false)
    expect(trigger().textContent).toContain('0/1')
  })

  it('reports a refused switch and keeps the rows it already has', async () => {
    const setServerEnabled = vi.fn<McpSessionControlInjected['setServerEnabled']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValue(TWO)
    render(<McpSessionControl {...props(async () => TWO, setServerEnabled)} />)
    fireEvent.click(trigger())
    await screen.findByText('rea')

    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(screen.getByText(en.writeFailed)).toBeTruthy() })
    expect(screen.queryByText('private transport detail')).toBeNull()
    expect(switchFor('rea').getAttribute('aria-checked')).toBe('true')
    expect(switchFor('rea').disabled).toBe(false)

    // The next write clears the report before it starts.
    fireEvent.click(switchFor('rea'))
    await waitFor(() => { expect(screen.queryByText(en.writeFailed)).toBeNull() })
    expect(setServerEnabled).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape and on a pointer outside the panel', async () => {
    await openPanel()

    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('dialog', { name: en.title })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    fireEvent.click(trigger())
    await screen.findByRole('dialog', { name: en.title })
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it("shows why a Host-disabled server's switch is frozen", async () => {
    const HOST_OFF = snapshot(
      server({ serverName: 'off', enabled: false, hostEnabled: false, toolCount: 0 }),
      server({ serverName: 'live', enabled: true, toolCount: 2 }),
    )
    const setServerEnabled = vi.fn<McpSessionControlInjected['setServerEnabled']>(async () => HOST_OFF)
    await openPanel(async () => HOST_OFF, setServerEnabled)

    expect(screen.getByText(en.hostDisabledNote)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: en.toggle.replace('{name}', 'off') })).toBeNull()
    // The reachable server beside it keeps its switch.
    expect(switchFor('live').getAttribute('aria-checked')).toBe('true')
    expect(trigger().textContent).toContain('1/2')
  })

  it('ignores a read that settles after unmount', async () => {
    const deferred = Promise.withResolvers<McpSessionSnapshot>()
    const view = render(<McpSessionControl {...props(() => deferred.promise)} />)
    fireEvent.click(trigger())
    view.unmount()
    await act(async () => { deferred.resolve(TWO) })

    const rejected = Promise.withResolvers<McpSessionSnapshot>()
    const failing = render(<McpSessionControl {...props(() => rejected.promise)} />)
    fireEvent.click(trigger())
    failing.unmount()
    await act(async () => { rejected.reject(new Error('late failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
