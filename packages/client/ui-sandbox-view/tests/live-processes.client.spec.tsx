// @vitest-environment jsdom
/**
 * Tests for the live-process widget's list, its empty and failure states, and
 * the two window actions it forwards to the host.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveProcessesWidget } from '../src/client/LiveProcessesWidget.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]

const windowsUrl = '/api/server/sandbox/windows?session=s1'
const focusUrl = '/api/server/sandbox/windows/focus'
const closeUrl = '/api/server/sandbox/windows/close'

const requestBody = { session: 's1' }

const windows = [
  { hwnd: 101, pid: 7, title: 'Untitled - Notepad', exe: 'notepad.exe' },
  { hwnd: 202, pid: 9, title: '', exe: 'explorer.exe' },
]

/**
 * Answer the windows route with a fixed body and record every other request.
 * @param body - the JSON body the windows route answers with.
 * @returns the stub and the recorded calls.
 */
function stubFetch(body: unknown): { fetchMock: ReturnType<typeof vi.fn>; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push(init === undefined ? { url } : { url, init })
    if (url === windowsUrl) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

describe('LiveProcessesWidget', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists the desktop windows with their process and actions', async () => {
    stubFetch({ ok: true, active: true, windows })
    render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={() => undefined}
      />,
    )
    expect(screen.getByText(en['processes.loading'])).toBeTruthy()
    expect(await screen.findByText('Untitled - Notepad')).toBeTruthy()
    expect(screen.getByText('notepad.exe', { exact: false })).toBeTruthy()
    expect(screen.getByText('explorer.exe')).toBeTruthy()
    expect(screen.getAllByText(en['processes.action.focus'])).toHaveLength(2)
    expect(screen.getAllByText(en['processes.action.close'])).toHaveLength(2)
  })

  it('forwards a focus action with the window handle and the request scope', async () => {
    const { calls } = stubFetch({ ok: true, windows })
    render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={() => undefined}
      />,
    )
    const focusButtons = await screen.findAllByText(en['processes.action.focus'])
    fireEvent.click(focusButtons[1] as HTMLElement)
    await waitFor(() => { expect(calls.some(call => call.url === focusUrl)).toBe(true) })
    const action = calls.find(call => call.url === focusUrl)
    const body = typeof action?.init?.body === 'string' ? action.init.body : ''
    expect(action?.init?.method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ session: 's1', hwnd: 202 })
  })

  it('reports a refused close action and keeps the list', async () => {
    const onRefused = vi.fn()
    const fetchMock = vi.fn((url: string) => {
      if (url === windowsUrl) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, windows }) })
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={onRefused}
      />,
    )
    const closeButtons = await screen.findAllByText(en['processes.action.close'])
    fireEvent.click(closeButtons[0] as HTMLElement)
    await waitFor(() => { expect(onRefused).toHaveBeenCalledWith(en['control.refused']) })
  })

  it('separates an empty desktop from a failed read', async () => {
    stubFetch({ ok: true, active: false, windows: [] })
    const view = render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={() => undefined}
      />,
    )
    expect(await screen.findByText(en['processes.empty'])).toBeTruthy()
    view.unmount()

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })))
    render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={() => undefined}
      />,
    )
    expect(await screen.findByText(en['processes.error'])).toBeTruthy()
  })

  it('reloads the list from the refresh action', async () => {
    const { fetchMock } = stubFetch({ ok: true, windows })
    render(
      <LiveProcessesWidget
        t={t}
        windowsUrl={windowsUrl}
        focusUrl={focusUrl}
        closeUrl={closeUrl}
        requestBody={requestBody}
        onRefused={() => undefined}
      />,
    )
    await screen.findByText('Untitled - Notepad')
    fireEvent.click(screen.getByText(en['processes.action.refresh']))
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => call[0] === windowsUrl).length).toBeGreaterThan(1)
    })
  })
})
