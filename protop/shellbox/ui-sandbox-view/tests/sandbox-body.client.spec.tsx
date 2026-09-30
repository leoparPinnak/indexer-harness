// @vitest-environment jsdom
/**
 * The sandbox tab body: one image fed from the host's private desktop over the
 * frame socket, and the pane size it reports back so the helper composites at
 * the right scale.
 *
 * The size report is the only thing this body sends, so the cases here pin its
 * whole contract: the debounce, the clamp into the helper's supported range, the
 * dedupe against the size last observed, and the teardown that must cancel a
 * pending report. The socket half pins its own contract: one URL per query, one
 * object URL swap per frame message, the retry ladder a close runs through, and
 * the cleanup that must close the socket and release the painted frame.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SandboxBody } from '../src/client/SandboxBody.tsx'
import { en } from '../src/client/locales.ts'

type ObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

/** Records every observer so a case can push sizes the way the browser would. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly observed: Element[] = []
  disconnected = false

  constructor(private readonly callback: ObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(element: Element): void { this.observed.push(element) }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true }

  /** Deliver one observed content rectangle. */
  emit(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } }] as unknown as ResizeObserverEntry[], this)
  }
}

/** A controllable stand-in for the frame socket the body owns. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void { this.closeCalls += 1 }

  /** Deliver one socket message the way the browser would. */
  deliver(data: Blob | string): void { this.onmessage?.({ data } as MessageEvent) }

  /** Report a transport failure. */
  fail(): void { this.onerror?.() }

  /** Report the socket closing. */
  end(): void { this.onclose?.() }
}

const t = (key: keyof typeof en): string => en[key]
const props = { t } as unknown as Parameters<typeof SandboxBody>[0]

let objectUrlSeq = 0
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  FakeResizeObserver.instances = []
  FakeWebSocket.instances = []
  objectUrlSeq = 0
  revokeObjectURL = vi.fn()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  vi.stubGlobal('WebSocket', FakeWebSocket)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:frame-${(objectUrlSeq += 1)}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

/** Render the body and give the size observer a pane to watch. */
function renderBody(): FakeResizeObserver {
  render(<SandboxBody {...props} />)
  const observer = FakeResizeObserver.instances[0]
  if (observer === undefined) throw new Error('the body mounted without observing its pane')
  return observer
}

/** Advance past the debounce and let the resulting promise settle. */
async function flushDebounce(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(400) })
}

/** The most recently opened frame socket. */
function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (socket === undefined) throw new Error('no frame socket was opened')
  return socket
}

describe('sandbox tab body', () => {
  it('opens the frame socket and paints what it receives', () => {
    renderBody()
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws')
    const image = screen.getByRole('img')
    expect(image.getAttribute('src')).toBeNull()
    expect(image.getAttribute('alt')).toBe(en['stream.alt'])

    act(() => { lastSocket().deliver(new Blob(['first frame'])) })
    expect(image.getAttribute('src')).toBe('blob:frame-1')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    act(() => { lastSocket().deliver(new Blob(['second frame'])) })
    expect(image.getAttribute('src')).toBe('blob:frame-2')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')

    // A message that is not a frame payload never reaches the image.
    act(() => { lastSocket().deliver('not a jpeg') })
    expect(image.getAttribute('src')).toBe('blob:frame-2')
  })

  it('retries a failed socket before showing the failure notice', () => {
    renderBody()
    expect(FakeWebSocket.instances).toHaveLength(1)
    // A close and a transport error on the same socket buy one retry, not two.
    act(() => {
      lastSocket().fail()
      lastSocket().end()
    })
    // The pane reopens on its own instead of failing at the first error.
    expect(screen.queryByRole('img')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Two more failures buy two more retries; the fourth shows the notice.
    act(() => { lastSocket().fail() })
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => { lastSocket().fail() })
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => { lastSocket().fail() })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en['stream.failed'])
  })

  it('collapses an image failure and a socket failure inside one retry window', () => {
    renderBody()
    act(() => { fireEvent.error(screen.getByRole('img')) })
    act(() => { lastSocket().fail() })
    act(() => { vi.advanceTimersByTime(2000) })
    // The second failure replaced the pending timer instead of stacking one.
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('closes the socket and releases the painted frame on unmount', () => {
    renderBody()
    act(() => { lastSocket().deliver(new Blob(['frame'])) })
    const socket = lastSocket()
    cleanup()
    expect(socket.closeCalls).toBe(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')

    // Late events arrive after teardown and must not reopen anything.
    socket.fail()
    socket.end()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reports the observed pane size once, after the debounce', async () => {
    const observer = renderBody()
    const sizeCalls = (): Array<[RequestInfo | URL, RequestInit | undefined]> =>
      vi.mocked(fetch).mock.calls.filter(c => c[0] === '/api/server/sandbox/size') as Array<[RequestInfo | URL, RequestInit | undefined]>
    await act(async () => { observer.emit(812, 604) })
    expect(sizeCalls()).toHaveLength(0)
    await flushDebounce()
    expect(sizeCalls()).toHaveLength(1)
    expect(sizeCalls()[0]).toEqual(['/api/server/sandbox/size', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ width: 812, height: 604 }),
    }])
  })

  it('folds a drag into one report and skips an unchanged size', async () => {
    const observer = renderBody()
    const sizeCalls = (): Array<[RequestInfo | URL, RequestInit | undefined]> =>
      vi.mocked(fetch).mock.calls.filter(c => c[0] === '/api/server/sandbox/size') as Array<[RequestInfo | URL, RequestInit | undefined]>
    await act(async () => { observer.emit(700, 500) })
    await act(async () => { observer.emit(760, 520) })
    await act(async () => { observer.emit(820, 540) })
    await flushDebounce()
    expect(sizeCalls()).toHaveLength(1)
    expect(JSON.parse(sizeCalls()[0]![1]!.body as string)).toEqual({ width: 820, height: 540 })

    await act(async () => { observer.emit(820, 540) })
    await flushDebounce()
    expect(sizeCalls()).toHaveLength(1)
  })

  it('clamps a pane outside the helper range into it', async () => {
    const observer = renderBody()
    const sizeCalls = (): Array<[RequestInfo | URL, RequestInit | undefined]> =>
      vi.mocked(fetch).mock.calls.filter(c => c[0] === '/api/server/sandbox/size') as Array<[RequestInfo | URL, RequestInit | undefined]>
    await act(async () => { observer.emit(10, 99999) })
    await flushDebounce()
    expect(JSON.parse(sizeCalls()[0]![1]!.body as string)).toEqual({ width: 320, height: 2880 })
  })

  it('reports physical pixels, so a scaled display gets a 1:1 picture', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    try {
      const observer = renderBody()
      const sizeCalls = (): Array<[RequestInfo | URL, RequestInit | undefined]> =>
        vi.mocked(fetch).mock.calls.filter(c => c[0] === '/api/server/sandbox/size') as Array<[RequestInfo | URL, RequestInit | undefined]>
      await act(async () => { observer.emit(810, 500) })
      await flushDebounce()
      expect(JSON.parse(sizeCalls()[0]![1]!.body as string)).toEqual({ width: 1620, height: 1000 })
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
    }
  })

  it('stops observing and cancels a pending report on unmount', async () => {
    const observer = renderBody()
    const sizeCalls = (): Array<[RequestInfo | URL, RequestInit | undefined]> =>
      vi.mocked(fetch).mock.calls.filter(c => c[0] === '/api/server/sandbox/size') as Array<[RequestInfo | URL, RequestInit | undefined]>
    await act(async () => { observer.emit(900, 600) })
    cleanup()
    expect(observer.disconnected).toBe(true)
    await flushDebounce()
    expect(sizeCalls()).toHaveLength(0)
  })

  it('keeps the socket when a size report is refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const observer = renderBody()
    await act(async () => { observer.emit(700, 500) })
    await flushDebounce()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(lastSocket().closeCalls).toBe(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('allows retrying after the failure notice appears', () => {
    renderBody()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      act(() => { lastSocket().fail() })
      act(() => { vi.advanceTimersByTime(2000) })
    }
    expect(screen.queryByRole('img')).toBeNull()

    const retryBtn = screen.getByRole('button', { name: en['action.retry'] })
    fireEvent.click(retryBtn)
    expect(screen.getByRole('img')).not.toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(5)
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws')
  })

  it('stops the stream when clicking the stop button', async () => {
    renderBody()
    const stopBtn = screen.getByRole('button', { name: en['action.stop'] })
    await act(async () => {
      fireEvent.click(stopBtn)
    })
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/stop', { method: 'POST' })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en['stream.failed'])
    expect(lastSocket().closeCalls).toBe(1)
  })

  it('binds the socket to the provided sessionId and updates on session change', () => {
    const { rerender } = render(<SandboxBody {...props} sessionId={'session-alpha' as SessionId} />)
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?session=session-alpha')

    rerender(<SandboxBody {...props} sessionId={'session-beta' as SessionId} />)
    // The session change bumps both the query and the reconnect counter, so
    // the assertion lands on the socket that is actually open.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?session=session-beta')
  })

  it('renders the target selector with win32, hyperv, and desktop options', () => {
    renderBody()
    const select = screen.getByRole('combobox', { name: 'Target environment' }) as HTMLSelectElement
    expect(select.value).toBe('win32')
    expect(screen.getByRole('option', { name: en['target.win32'] })).toBeDefined()
    expect(screen.getByRole('option', { name: en['target.hyperv'] })).toBeDefined()
    expect(screen.getByRole('option', { name: en['target.desktop'] })).toBeDefined()

    fireEvent.change(select, { target: { value: 'hyperv' } })
    expect(select.value).toBe('hyperv')
  })

  it('renders the fps selector and posts updated fps', () => {
    renderBody()
    const fpsSelect = screen.getByRole('combobox', { name: en['fps.label'] }) as HTMLSelectElement
    expect(fpsSelect.value).toBe('30')
    expect(screen.getByRole('option', { name: '15 FPS' })).toBeDefined()
    expect(screen.getByRole('option', { name: '30 FPS' })).toBeDefined()
    expect(screen.getByRole('option', { name: '60 FPS' })).toBeDefined()

    fireEvent.change(fpsSelect, { target: { value: '60' } })
    expect(fpsSelect.value).toBe('60')
    expect(fetch).toHaveBeenCalledWith('/api/server/sandbox/fps', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ target: 'win32', fps: 60 }),
    }))
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?fps=60')
  })

  it('renders live fps badge and updates when status returns fps', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (href.includes('/api/server/sandbox/status')) {
        return {
          ok: true,
          json: async () => ({ ok: true, active: true, fps: 28.5 }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    })
    renderBody()
    expect(screen.getByText('-- FPS')).toBeDefined()
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(screen.getByText('28.5 FPS')).toBeDefined()
  })

  /** A status poll that reports no frames: a fresh socket gets opened. */
  function stubStatusFps(fps: () => number): void {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (href.includes('/api/server/sandbox/status')) {
        return { ok: true, json: async () => ({ ok: true, active: true, fps: fps() }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true, instances: [] }) } as unknown as Response
    })
  }

  it('reopens the socket when the status poll reports no frames', async () => {
    stubStatusFps(() => 0)
    renderBody()
    expect(FakeWebSocket.instances).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws')
    expect(FakeWebSocket.instances[0]!.closeCalls).toBe(1)
  })

  it('stops reconnecting once frames flow again', async () => {
    let fps = 0
    stubStatusFps(() => fps)
    renderBody()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    fps = 30
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    const opened = FakeWebSocket.instances.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(FakeWebSocket.instances).toHaveLength(opened)
  })

  /** Instances fetch stubbed to the given bound list for auto-pick cases. */
  function stubInstances(
    instances: Array<{ id: string; name: string; desktopName: string; type: string; boundSessionIds: string[] }>,
  ): void {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (href.includes('/api/server/sandbox/instances')) {
        return { ok: true, json: async () => ({ ok: true, instances }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true, fps: 0 }) } as unknown as Response
    })
  }

  it('auto-picks the isolated desktop over the host mirror', async () => {
    stubInstances([
      { id: 'host-desktop', name: 'Ana Masaüstü', desktopName: 'Default', type: 'win32', boundSessionIds: ['session-x'] },
      { id: 'dsh-sb-x', name: 'Masaüstü #1', desktopName: 'dsh-sb-x', type: 'win32', boundSessionIds: ['session-x'] },
    ])
    render(<SandboxBody {...props} sessionId={'session-x' as SessionId} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const select = screen.getByRole('combobox', { name: 'Target environment' }) as HTMLSelectElement
    expect(select.value).toBe('dsh-sb-x')
  })

  it('falls back to the host mirror when it is the only instance', async () => {
    stubInstances([
      { id: 'host-desktop', name: 'Ana Masaüstü', desktopName: 'Default', type: 'win32', boundSessionIds: ['session-x'] },
    ])
    render(<SandboxBody {...props} sessionId={'session-x' as SessionId} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const select = screen.getByRole('combobox', { name: 'Target environment' }) as HTMLSelectElement
    expect(select.value).toBe('host-desktop')
  })

  it('shapes the frame-socket query from the target when no instance answers for it', () => {
    const first = render(<SandboxBody {...props} sessionId={'session-q' as SessionId} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Target environment' }), { target: { value: 'hyperv' } })
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?session=session-q&target=hyperv')
    first.unmount()

    const second = render(<SandboxBody {...props} sessionId={'session-q' as SessionId} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Target environment' }), { target: { value: 'host-desktop' } })
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?session=session-q&target=desktop')
    second.unmount()

    render(<SandboxBody {...props} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Target environment' }), { target: { value: 'host-desktop' } })
    expect(lastSocket().url).toBe('ws://localhost:3000/api/server/sandbox/ws?target=desktop')
  })

  it('holds the reconnect ladder inside its delay window while the stream stays stalled', async () => {
    stubStatusFps(() => 0)
    renderBody()
    // First step (1s): the stall ages past the tolerance and reconnects at t=4000.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Second step (2s): the stall is still past the tolerance, so t=8000 reconnects.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(FakeWebSocket.instances).toHaveLength(3)
    // Third step (4s): t=12000 reconnects and advances the ladder to its last rung.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(FakeWebSocket.instances).toHaveLength(4)
    // The last rung wants an eight-second gap from t=12000, so every
    // qualifying tick inside that window is refused instead of reopening.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(FakeWebSocket.instances).toHaveLength(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('clears the pending reconnect timer when a manual retry supersedes it', () => {
    renderBody()
    act(() => { fireEvent.error(screen.getByRole('img')) })
    act(() => { lastSocket().fail() })
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => { fireEvent.error(screen.getByRole('img')) })
    act(() => { lastSocket().fail() })
    expect(screen.getByRole('alert').textContent).toBe(en['stream.failed'])
    const opened = FakeWebSocket.instances.length
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(FakeWebSocket.instances.length).toBe(opened + 1)
    act(() => { vi.advanceTimersByTime(2000) })
    // The timer the manual retry superseded never schedules another reopen.
    expect(FakeWebSocket.instances.length).toBe(opened + 1)
  })

  it('cancels a pending reconnect when the pane unmounts', () => {
    renderBody()
    act(() => { lastSocket().fail() })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
