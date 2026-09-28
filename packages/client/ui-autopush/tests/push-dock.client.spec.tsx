// @vitest-environment jsdom
/**
 * The auto-push dock: the chip follows the host projection, the toggle runs the
 * session's own command, and the dashboard lists the session's pushes with full
 * local timestamps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AutoPushProjection } from '@deepseek-ai/dsh-autopush/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PushDock, chipTime, fullTime, type PushDockProps } from '../src/client/PushDock.tsx'
import { tr } from '../src/client/locales.ts'

afterEach(cleanup)

const t: PushDockProps['t'] = makeTranslate(tr, commonZh)

/** One push at a fixed local time, so the assertions do not depend on the clock. */
const AT = new Date(2026, 8, 11, 16, 42).getTime()

function projection(overrides: Partial<AutoPushProjection> = {}): AutoPushProjection {
  return { enabled: false, count: 0, lastAt: null, history: [], projectHistory: [], ...overrides }
}

function dock(value: AutoPushProjection | undefined, setEnabled = vi.fn(() => Promise.resolve<string | null>(null))) {
  const store = createSnapshotStore<{ value: AutoPushProjection | undefined }>({ value })
  const read = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection: read, setEnabled, t } as unknown as PushDockProps
  const view = render(<PushDock {...props} />)
  return { store, setEnabled, view }
}

describe('auto-push dock', () => {
  it('formats the chip clock by hour and minute and the history in full', () => {
    expect(chipTime(AT)).toBe('16:42')
    expect(fullTime(AT)).toBe('11.09.2026 16:42')
  })

  it('renders nothing without the projection, and the off state otherwise', () => {
    expect(dock(undefined).view.container.innerHTML).toBe('')
    cleanup()
    dock(projection())
    expect(screen.getByRole('button', { name: 'Oto-push kapalı, açmak için basın' }).textContent).toContain('AUTO-PUSH')
    expect(document.querySelector('[data-autopush-count]')?.textContent).toBe('0')
    expect(document.querySelector('[data-autopush-last]')?.textContent).toBe('Henüz push yok')
  })

  it('turns the gate on and off through the session command', async () => {
    const on = vi.fn(() => Promise.resolve<string | null>(null))
    dock(projection(), on)
    fireEvent.click(screen.getByRole('button', { name: 'Oto-push kapalı, açmak için basın' }))
    expect(on).toHaveBeenLastCalledWith(true)
    cleanup()

    const off = vi.fn(() => Promise.resolve<string | null>(null))
    dock(projection({ enabled: true }), off)
    fireEvent.click(screen.getByRole('button', { name: 'Oto-push açık, kapatmak için basın' }))
    expect(off).toHaveBeenLastCalledWith(false)
  })

  it('surfaces a refused toggle without leaving the off state', async () => {
    const refused = vi.fn(() => Promise.resolve('host said no'))
    dock(projection(), refused)
    fireEvent.click(screen.getByRole('button', { name: 'Oto-push kapalı, açmak için basın' }))
    expect((await screen.findByRole('status')).textContent).toBe('host said no')
  })

  it('shows the session count and the newest push on the chip', () => {
    dock(projection({ enabled: true, count: 3, lastAt: AT }))
    expect(document.querySelector('[data-autopush-count]')?.textContent).toBe('3')
    expect(document.querySelector('[data-autopush-last]')?.textContent).toBe('16:42')
  })

  it('opens a dashboard with the count and the full history', () => {
    dock(projection({
      enabled: true,
      count: 2,
      lastAt: AT,
      history: [
        { at: AT, message: 'kırpma aracı eklendi', sha: 'abc1234', files: 3, remote: 'origin', branch: 'master' },
        { at: AT - 3600_000, message: 'ilk sürüm', sha: 'def5678', files: 1, remote: 'origin', branch: 'master' },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: /0|2|16:42/u, expanded: false } as never))
    const panel = screen.getByRole('dialog', { name: 'Oto-push' })
    expect(panel.getAttribute('data-autopush-panel')).toBe('true')
    expect(document.querySelector('[data-autopush-panel-count]')?.textContent).toBe('2')
    expect(document.querySelector('[data-autopush-panel-last]')?.textContent).toBe('11.09.2026 16:42')
    const entries = document.querySelectorAll('[data-autopush-history] li')
    expect(entries).toHaveLength(2)
    expect(entries[0]?.textContent).toContain('11.09.2026 16:42')
    expect(entries[0]?.textContent).toContain('kırpma aracı eklendi')
    expect(entries[1]?.textContent).toContain('11.09.2026 15:42')
    expect(entries[0]?.textContent).toContain('abc1234')
    expect(entries[0]?.textContent).toContain('3 dosya')
  })

  it('says so when nothing was pushed, and closes on Escape', async () => {
    dock(projection())
    const summary = document.querySelector('[data-autopush-summary]') as HTMLButtonElement
    fireEvent.click(summary)
    expect(document.querySelector('[data-autopush-history]')).toBeNull()
    expect(screen.getByText('Bu oturumda henüz push yapılmadı.')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('switches between session pushes and project history tabs', () => {
    dock(projection({
      enabled: true,
      count: 1,
      lastAt: AT,
      history: [
        { at: AT, message: 'oturum commit', sha: 'sess123', files: 1, remote: 'origin', branch: 'master' },
      ],
      projectHistory: [
        { at: AT - 7200_000, date: '11.09.2026 14:42', message: 'proje commit', sha: 'proj456', files: 2, remote: 'origin', branch: 'master' },
      ],
    }))
    fireEvent.click(document.querySelector('[data-autopush-summary]') as HTMLButtonElement)
    expect(screen.getByText(/oturum commit/)).toBeTruthy()

    const projectTab = screen.getByRole('tab', { name: /Proje geçmişi/ })
    fireEvent.click(projectTab)
    expect(screen.getByText(/proje commit/)).toBeTruthy()
    expect(screen.getByText(/proj456/)).toBeTruthy()

    const sessionTab = screen.getByRole('tab', { name: /Bu oturum/ })
    fireEvent.click(sessionTab)
    expect(screen.getByText(/oturum commit/)).toBeTruthy()
  })
})
