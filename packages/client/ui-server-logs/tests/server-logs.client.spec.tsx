// @vitest-environment jsdom
/**
 * Tests for the settings Server Logs section.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerLogsSectionProps } from '../src/client/ServerLogsSection.tsx'
import { ServerLogsSection } from '../src/client/ServerLogsSection.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]
const props = { t } as unknown as ServerLogsSectionProps

const threeLines = ['first line', 'second line', 'third line']

function mockLines(lines: unknown, truncated = false): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, lines, truncated }),
  } as unknown as Response)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  mockLines(threeLines)
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Flush the initial load promise. */
async function flushLoad(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('ServerLogsSection', () => {
  it('renders the tail newest-first', async () => {
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getByText(en['logs.description'])).toBeDefined()
    expect(document.querySelector('pre')?.textContent).toBe('third line\nsecond line\nfirst line')
  })

  it('notes a truncated tail', async () => {
    mockLines(threeLines, true)
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getByText(en['logs.truncated'])).toBeDefined()
  })

  it('shows the empty text without lines', async () => {
    mockLines([])
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getByText(en['logs.empty'])).toBeDefined()
    expect(document.querySelector('pre')).toBeNull()
  })

  it('filters lines by substring', async () => {
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    fireEvent.change(screen.getByRole('searchbox', { name: en['logs.filter.label'] }), {
      target: { value: 'second' },
    })
    expect(document.querySelector('pre')?.textContent).toBe('second line')
    fireEvent.change(screen.getByRole('searchbox', { name: en['logs.filter.label'] }), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText(en['logs.empty'])).toBeDefined()
  })

  it('refreshes on demand and on the live interval until paused', async () => {
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: en['logs.action.refresh'] }))
    await flushLoad()
    expect(fetch).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(fetch).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('checkbox', { name: en['logs.autorefresh'] }))
    // Toggling loads once, then the paused pane stays quiet.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('clears the log and empties the pane', async () => {
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(document.querySelector('pre')).not.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, cleared: true }),
    } as unknown as Response)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['logs.action.clear'] }))
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/logs/clear', { method: 'POST' })
    expect(screen.getByText(en['logs.empty'])).toBeDefined()
  })

  it('reports clear failures without emptying the pane', async () => {
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    const clear = (): void => {
      fireEvent.click(screen.getByRole('button', { name: en['logs.action.clear'] }))
    }

    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as unknown as Response)
    await act(async () => { clear() })
    expect(screen.getByRole('alert').textContent).toBe(en['logs.error.clear'])

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false }),
    } as unknown as Response)
    await act(async () => { clear() })
    expect(screen.getByRole('alert').textContent).toBe(en['logs.error.clear'])

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response)
    await act(async () => { clear() })
    expect(screen.getByRole('alert').textContent).toBe(en['logs.error.clear'])

    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { clear() })
    expect(screen.getByRole('alert').textContent).toBe(en['logs.error.clear'])
    expect(document.querySelector('pre')).not.toBeNull()
  })

  it('reports load failures and keeps non-string lines out', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as unknown as Response)
    const { unmount } = render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getByRole('alert').textContent).toBe(en['logs.error.load'])
    unmount()

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false }),
    } as unknown as Response)
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getAllByRole('alert')[0]?.textContent).toBe(en['logs.error.load'])

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, lines: ['kept', 7, 'kept2'] }),
    } as unknown as Response)
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(document.querySelectorAll('pre')[0]?.textContent).toBe('kept2\nkept')

    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    render(<ServerLogsSection {...props} />)
    await flushLoad()
    expect(screen.getAllByRole('alert').at(-1)?.textContent).toBe(en['logs.error.load'])
  })

  it('drops a load that resolves after unmount', async () => {
    const { unmount } = render(<ServerLogsSection {...props} />)
    unmount()
    await act(async () => {})
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
