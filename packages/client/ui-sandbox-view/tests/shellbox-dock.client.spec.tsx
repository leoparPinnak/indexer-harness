// @vitest-environment jsdom
/**
 * Tests for ShellboxDock and VirtualizationDashboard.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShellboxDockProps } from '../src/client/ShellboxDock.tsx'
import { ShellboxDock } from '../src/client/ShellboxDock.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]

const mockSessions = {
  byId: {
    'session-alpha': {
      id: 'session-alpha',
      title: 'Alpha Project',
      cwd: 'C:/projects/alpha',
    },
    'session-beta': {
      id: 'session-beta',
      title: 'Beta Project',
      cwd: 'C:/projects/beta',
    },
  },
  current: 'session-alpha',
}

const mockInstances = [
  {
    id: 'dsh-sb-sessionalpha-1',
    ownerSessionId: 'session-alpha',
    boundSessionIds: ['session-alpha'],
    type: 'win32',
    name: 'Masaüstü #1',
    desktopName: 'dsh-sb-sessionalpha',
    active: true,
    createdAt: Date.now(),
  },
  {
    id: 'dsh-sb-sessionbeta-1',
    ownerSessionId: 'session-beta',
    boundSessionIds: ['session-beta'],
    type: 'win32',
    name: 'Masaüstü #1',
    desktopName: 'dsh-sb-sessionbeta',
    active: false,
    createdAt: Date.now(),
  },
]

describe('ShellboxDock and VirtualizationDashboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (typeof url === 'string' && url.includes('/api/server/sandbox/instances')) {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, instances: mockInstances }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const renderDock = (props?: Partial<ShellboxDockProps>) => {
    const useSessions = vi.fn((selector: (s: typeof mockSessions) => unknown) => selector(mockSessions))
    const fullProps = {
      sessionId: 'session-alpha' as SessionId,
      useSessions: useSessions as unknown as ShellboxDockProps['useSessions'],
      t: t as unknown as TranslateNS<'sandboxView'>,
      ...props,
    } as unknown as ShellboxDockProps
    return render(<ShellboxDock {...fullProps} />)
  }

  it('renders the dock button and displays active count after fetch', async () => {
    renderDock()

    const button = screen.getByRole('button', { name: en['dock.tooltip'] })
    expect(button).toBeDefined()
    expect(button.textContent).toContain(en['dock.label'])

    // Wait for instance count
    await act(async () => {
      await Promise.resolve()
    })
    expect(button.textContent).toContain('(1)')
  })

  it('opens and closes the VirtualizationDashboard popover', async () => {
    renderDock()

    const toggleBtn = screen.getByRole('button', { name: en['dock.tooltip'] })
    await act(async () => {
      fireEvent.click(toggleBtn)
    })

    const dialog = screen.getByRole('dialog', { name: en['dock.title'] })
    expect(dialog).toBeDefined()

    // Close button closes the dialog
    const closeBtn = screen.getByTitle('Kapat')
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('allows switching between This Session and All Active tabs', async () => {
    renderDock()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['dock.tooltip'] }))
    })

    // Click "All Active" tab
    const allTab = screen.getByRole('button', { name: new RegExp(en['dock.tab.all']) })
    await act(async () => {
      fireEvent.click(allTab)
    })

    // Shows other session's title and attach button
    expect(screen.getByText(/Beta Project/)).toBeDefined()
    const attachBtn = screen.getByRole('button', { name: en['dock.action.attach'] })
    expect(attachBtn).toBeDefined()

    // Click attach
    await act(async () => {
      fireEvent.click(attachBtn)
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/instances/attach', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targetSessionId: 'session-alpha', instanceId: 'dsh-sb-sessionbeta-1' }),
    }))
  })

  it('triggers creation of win32, wsl-ubuntu, and hyperv instances', async () => {
    renderDock()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['dock.tooltip'] }))
    })

    const addWin32 = screen.getByRole('button', { name: en['dock.action.addWin32'] })
    await act(async () => {
      fireEvent.click(addWin32)
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/instances/create', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-alpha', type: 'win32' }),
    }))

    const addUbuntu = screen.getByRole('button', { name: en['dock.action.addUbuntu'] })
    await act(async () => {
      fireEvent.click(addUbuntu)
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/instances/create', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-alpha', type: 'wsl-ubuntu' }),
    }))

    const addHyperV = screen.getByRole('button', { name: en['dock.action.addHyperV'] })
    await act(async () => {
      fireEvent.click(addHyperV)
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/instances/create', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-alpha', type: 'hyperv' }),
    }))
  })
})
