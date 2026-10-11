/**
 * The sandbox tab's body: the host helper's live Windows desktop as WebSocket
 * frame messages painted into one image, and the pane's pixel size reported
 * back to it.
 *
 * Frames arrive as binary WebSocket messages — one JPEG per message, so the
 * transport stays the battle-tested mux path instead of a long-lived multipart
 * response — and each one replaces the image's object URL; nothing else here
 * reads or buffers bytes. The size report is the one thing this body sends: a
 * `ResizeObserver` on the pane, debounced so one drag lands as one request,
 * clamped to the helper's supported viewport, and deduplicated against the size
 * last observed. A socket that cannot connect or closes leaves a short notice
 * in the image's place; a refused size report is silent because the next
 * resize asks again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompositionEvent as ReactCompositionEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from './locales.ts'
import { InputBatcher, frameCoordinate, keyCodeWithinRange, normalizeWheelDelta } from './inputCapture.ts'
import type { CapturedButton, CapturedInputEvent } from './inputCapture.ts'
import { LiveProcessesWidget } from './LiveProcessesWidget.tsx'
import css from './SandboxBody.module.css'

/** The host upgrade route that delivers the helper's desktop as one binary JPEG message per frame. */
const STREAM_WS_PATH = '/api/server/sandbox/ws'

/** The host route that forwards one viewport size to the helper's stdin. */
const SIZE_URL = '/api/server/sandbox/size'

/** The host route that stops the helper and tears down the desktop. */
const STOP_URL = '/api/server/sandbox/stop'

/** The host route that spools one captured input batch for the helper. */
const INPUT_URL = '/api/server/sandbox/input'

/** The host route that answers the tracked desktop's visible windows. */
const WINDOWS_URL = '/api/server/sandbox/windows'

/** The host route that foregrounds one window of the tracked desktop. */
const WINDOWS_FOCUS_URL = '/api/server/sandbox/windows/focus'

/** The host route that closes one window of the tracked desktop. */
const WINDOWS_CLOSE_URL = '/api/server/sandbox/windows/close'

/** The host route that reads the desktop change ring without advancing any cursor. */
const CHANGES_URL = '/api/server/sandbox/changes'

/** How often the pane asks for the change ring's current cursor, in milliseconds. */
const CHANGES_POLL_MS = 2000

/** Client-local key holding the change cursor this browser already reviewed. */
const LAST_SEEN_PREFIX = 'dsh.shellbox.changes.'

/** Quiet period after the last observed resize before its size is reported. */
const SIZE_DEBOUNCE_MS = 250

/** Smallest viewport the helper is asked to composite, in physical pixels. */
const MIN_WIDTH = 320
const MIN_HEIGHT = 240

/** Largest viewport the helper is asked to composite, in physical pixels (the host's own cap, halved for width). */
const MAX_WIDTH = 5120
const MAX_HEIGHT = 2880

/** Quiet period in measured frames tolerated before the stream is treated as dead. */
const STALL_TOLERANCE_MS = 4000

/** Escalating delays between automatic stream reconnects, in milliseconds. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

/** Upper bound applied to the reconnect delay ladder. */
const RETRY_DELAY_CAP_MS = 15000

/** Connection failures tolerated on a fresh stream URL before the failure notice appears. */
const MAX_CONNECT_RETRIES = 3

/** Delay before re-requesting the stream after a connection failure. */
const CONNECT_RETRY_DELAY_MS = 2000

/** One pane size in physical pixels, already clamped into the helper's supported range. */
interface PaneSize {
  readonly width: number
  readonly height: number
}

/** Supported visualization target environments. */
export type TargetType = 'win32' | 'hyperv' | 'desktop'

/** The body's composed props: the tab it draws and its copy. */
export type SandboxBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sandboxView'>

/**
 * Clamp one observed pane dimension into the helper's supported range.
 * @param value - observed physical pixels.
 * @param min - smallest supported value.
 * @param max - largest supported value.
 * @returns the value held between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Name the mouse button a pointer event reported.
 * @param button - the DOM button index.
 * @returns the desktop's button name, or `undefined` for a button the grammar has no event for.
 */
function pointerButtonOf(button: number): CapturedButton | undefined {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return undefined
}

/**
 * Build the frame-socket query for the current view: the owning session, the
 * selected instance or target environment, and a non-default frame rate.
 * @param sessionId - optional session ID owning the desktop.
 * @param target - selected target environment.
 * @param instanceId - selected instance ID, when the instance list resolved one.
 * @param fps - requested frame rate; 30 is the helper's default and is omitted.
 * @returns the query string with its leading `?`, or an empty string when nothing is selected.
 */
function buildStreamQuery(sessionId: string | undefined, target: string, instanceId: string | undefined, fps: number): string {
  const parts: string[] = []
  if (sessionId) {
    parts.push(`session=${encodeURIComponent(sessionId)}`)
    if (instanceId) parts.push(`instance=${encodeURIComponent(instanceId)}`)
    else if (target === 'desktop' || target === 'host-desktop') parts.push('target=desktop')
    else if (target === 'hyperv') parts.push('target=hyperv')
  } else if (target === 'desktop' || target === 'host-desktop') parts.push('target=desktop')
  else if (target === 'hyperv') parts.push('target=hyperv')
  if (fps !== 30) parts.push(`fps=${String(fps)}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/**
 * Post one clamped pane size to the host.
 *
 * A refused or failed report is swallowed on purpose: the helper keeps
 * compositing at its previous viewport, and the next resize reports again, so
 * there is nothing here for the reader to act on.
 * @param size - the clamped pane size in physical pixels.
 * @param sessionId - optional session ID owning this viewport.
 * @param instanceId - optional instance ID owning this viewport.
 */
async function reportSize(size: PaneSize, sessionId?: string, instanceId?: string): Promise<void> {
  try {
    const payload: Record<string, unknown> = { ...size }
    if (sessionId) payload.sessionId = sessionId
    if (instanceId) payload.instanceId = instanceId
    await fetch(SIZE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // The only thrower is fetch refusing or losing the request; see above.
  }
}

/**
 * Report the pane's settled pixel size to the host for as long as it is mounted.
 *
 * The reported size is physical pixels — the pane's CSS box times the current
 * `devicePixelRatio` — because the helper composites at the display's real
 * resolution; a scaled display therefore gets a picture it can show at 1:1
 * instead of an upscaled one.
 * @param pane - the body element whose size the stream follows.
 * @param sessionId - optional session ID owning this pane.
 * @param instanceId - optional instance ID owning this pane.
 */
function usePaneSize(pane: RefObject<HTMLDivElement | null>, sessionId?: string, instanceId?: string): void {
  // The size last observed, not the last one posted: a debounce that folds
  // several intermediate sizes into one request still ends at what is on screen.
  const observed = useRef<PaneSize>()
  useEffect(() => {
    const element = pane.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
      const size: PaneSize = {
        width: clamp(Math.round(entry.contentRect.width * ratio), MIN_WIDTH, MAX_WIDTH),
        height: clamp(Math.round(entry.contentRect.height * ratio), MIN_HEIGHT, MAX_HEIGHT),
      }
      const previous = observed.current
      if (previous !== undefined && previous.width === size.width && previous.height === size.height) return
      observed.current = size
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void reportSize(size, sessionId, instanceId) }, SIZE_DEBOUNCE_MS)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [pane, sessionId, instanceId])
}

/** The sandbox tab's body. */
export function SandboxBody({ sessionId, t }: SandboxBodyProps): ReactNode {
  const pane = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  /** Object URL of the newest frame message; undefined until the first frame lands. */
  const [frameUrl, setFrameUrl] = useState<string | undefined>(undefined)
  const [cacheBuster, setCacheBuster] = useState(0)
  const [target, setTarget] = useState<string>('win32')
  const [fps, setFps] = useState<number>(30)
  const [liveFps, setLiveFps] = useState<number>(0)
  const [inputEnabled, setInputEnabled] = useState(false)
  const [status, setStatus] = useState('')
  const [changeCursor, setChangeCursor] = useState(0)
  const imgRef = useRef<HTMLImageElement>(null)
  const seenRef = useRef<number | undefined>(undefined)
  const [sessionInstances, setSessionInstances] = useState<Array<{ id: string; name: string; desktopName: string; type: string }>>([])
  /**
   * Reconnection bookkeeping. The frame socket can die without a usable
   * signal — a helper exit closes it, but a half-open one just goes silent —
   * so the pane tracks liveness through the status poll and rebuilds the
   * socket when frames stop arriving.
   */
  const stalledSinceRef = useRef<number | undefined>(undefined)
  const reconnectAttemptRef = useRef(0)
  const lastReconnectAtRef = useRef(0)
  const connectFailuresRef = useRef(0)
  const retryTimerRef = useRef<number | undefined>(undefined)
  /** Object URL currently painted; revoked when a newer frame or a reconnect replaces it. */
  const frameUrlRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    const loadInstances = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/server/sandbox/instances?session=${encodeURIComponent(sessionId)}`)
        if (res.ok && !cancelled) {
          interface InstancesPayload {
            ok: boolean
            instances: Array<{ id: string; name: string; desktopName: string; type: string; boundSessionIds: string[] }>
          }
          const data = await res.json() as InstancesPayload
          if (data.ok && Array.isArray(data.instances)) {
            const my = data.instances.filter(i => i.boundSessionIds.includes(sessionId))
            setSessionInstances(my)
            // Auto-pick the session's own isolated desktop, never the shared
            // read-only host mirror: it sorts first by age and would otherwise
            // steal the default view.
            const first = my.find(i => i.id !== 'host-desktop') ?? my[0]
            if (first && !my.some(i => i.id === target) && target !== 'desktop' && target !== 'host-desktop') {
              setTarget(first.id)
            }
          }
        }
      } catch {
        // Ignore network errors
      }
    }
    void loadInstances()
    const timer = setInterval(() => { void loadInstances() }, 2500)
    const onFocus = (): void => { void loadInstances() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [sessionId, target])

  const selectedInstanceId = sessionInstances.some(i => i.id === target) ? target : undefined
  usePaneSize(pane, sessionId, selectedInstanceId)

  useEffect(() => {
    let cancelled = false
    const pollStatus = async (): Promise<void> => {
      try {
        let url = '/api/server/sandbox/status'
        const params: string[] = []
        if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`)
        if (selectedInstanceId) params.push(`instance=${encodeURIComponent(selectedInstanceId)}`)
        else if (target === 'desktop' || target === 'host-desktop') params.push('target=desktop')
        else if (target === 'hyperv') params.push('target=hyperv')
        if (params.length > 0) url += `?${params.join('&')}`

        const res = await fetch(url)
        if (res.ok && !cancelled) {
          interface StatusPayload {
            ok: boolean
            active?: boolean
            fps?: number
          }
          const data = await res.json() as StatusPayload
          if (data.ok && typeof data.fps === 'number') {
            setLiveFps(data.fps)
            if (data.fps > 0) {
              stalledSinceRef.current = undefined
              reconnectAttemptRef.current = 0
            } else if (stalledSinceRef.current === undefined) {
              stalledSinceRef.current = Date.now()
            }
          }
        }
      } catch {
        // Ignore network errors
      }
    }
    void pollStatus()
    const timer = setInterval(() => { void pollStatus() }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, selectedInstanceId, target])

  /**
   * Watchdog for a silently frozen stream: once the status poll has reported
   * zero frames for longer than the tolerance, re-request the stream URL and
   * keep retrying with an escalating delay up to the cap. A stream that
   * recovers resets the ladder through the status poll above.
   */
  useEffect(() => {
    if (failed) return undefined
    const timer = setInterval(() => {
      const stalledSince = stalledSinceRef.current
      if (stalledSince === undefined) return
      if (Date.now() - stalledSince < STALL_TOLERANCE_MS) return
      const now = Date.now()
      /* v8 ignore next -- Math.min already bounds the index into the ladder, so the element at that index always exists. */
      const ladder = RETRY_DELAYS_MS[Math.min(reconnectAttemptRef.current, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAY_CAP_MS
      const delay = Math.min(ladder, RETRY_DELAY_CAP_MS)
      if (now - lastReconnectAtRef.current < delay) return
      reconnectAttemptRef.current += 1
      lastReconnectAtRef.current = now
      stalledSinceRef.current = now
      setCacheBuster(now)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [failed])

  const prevSession = useRef(sessionId)
  const prevTarget = useRef(target)
  useEffect(() => {
    if (prevSession.current !== sessionId || prevTarget.current !== target) {
      prevSession.current = sessionId
      prevTarget.current = target
      setFailed(false)
      setCacheBuster(Date.now())
      stalledSinceRef.current = undefined
      reconnectAttemptRef.current = 0
      connectFailuresRef.current = 0
    }
  }, [sessionId, target])

  useEffect(() => () => {
    if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current)
  }, [])

  const handleRefresh = (): void => {
    setCacheBuster(Date.now())
  }

  const handleRetry = (): void => {
    connectFailuresRef.current = 0
    reconnectAttemptRef.current = 0
    stalledSinceRef.current = undefined
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = undefined
    }
    setFailed(false)
    setCacheBuster(Date.now())
  }

  /**
   * A socket that fails or closes is retried a few times before the failure
   * notice appears: a helper or daemon that is still starting closes with a
   * retryable code that clears on its own once ready. The identity is stable
   * so the frame-socket effect may depend on it.
   */
  const handleStreamError = useCallback((): void => {
    if (connectFailuresRef.current < MAX_CONNECT_RETRIES) {
      connectFailuresRef.current += 1
      if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = undefined
        setCacheBuster(Date.now())
      }, CONNECT_RETRY_DELAY_MS)
      return
    }
    setFailed(true)
  }, [])

  const handleStop = async (): Promise<void> => {
    try {
      if (selectedInstanceId) {
        await fetch(STOP_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instanceId: selectedInstanceId }),
        })
      } else if (sessionId) {
        await fetch(STOP_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } else {
        await fetch(STOP_URL, { method: 'POST' })
      }
    } catch {
      // Ignored: network failure still marks the view as stopped.
    }
    setFailed(true)
  }

  const handleFpsChange = (newFps: number): void => {
    setFps(newFps)
    void fetch('/api/server/sandbox/fps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        instanceId: selectedInstanceId,
        target: selectedInstanceId ? undefined : target,
        fps: newFps,
      }),
    }).catch(() => {
      // Ignore network errors
    })
  }

  const streamQuery = buildStreamQuery(sessionId, target, selectedInstanceId, fps)

  /**
   * Own the frame socket for the current target and ladder step: every
   * `cacheBuster` move builds a fresh socket, each binary message replaces
   * the image's object URL, and a socket that errors or closes runs the same
   * retry ladder an image load used to. Unmount, target switches, and manual
   * retries all travel through `cacheBuster`, so the cleanup below is the one
   * place a socket goes away.
   */
  useEffect(() => {
    if (failed) return undefined
    const origin = window.location.origin.replace(/^http/u, 'ws')
    const socket = new WebSocket(`${origin}${STREAM_WS_PATH}${streamQuery}`)
    let settled = false
    socket.onmessage = (event: MessageEvent): void => {
      if (!(event.data instanceof Blob)) return
      const url = URL.createObjectURL(event.data)
      const stale = frameUrlRef.current
      frameUrlRef.current = url
      if (stale !== undefined) URL.revokeObjectURL(stale)
      setFrameUrl(url)
    }
    const settle = (): void => {
      if (settled) return
      settled = true
      handleStreamError()
    }
    socket.onclose = settle
    socket.onerror = settle
    return () => {
      settled = true
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
      const stale = frameUrlRef.current
      if (stale !== undefined) {
        URL.revokeObjectURL(stale)
        frameUrlRef.current = undefined
      }
      setFrameUrl(undefined)
    }
  }, [failed, cacheBuster, streamQuery, handleStreamError])

  const inputScope = useMemo(
    () => ({ session: sessionId, instance: selectedInstanceId, target: selectedInstanceId ? undefined : target }),
    [sessionId, selectedInstanceId, target],
  )

  /**
   * Forward one captured batch. A refused or failed delivery is reported on the
   * pane's status line; an accepted batch restores the hint, so a stale refusal
   * never outlives the next delivered event.
   */
  const sendInput = useCallback((events: readonly CapturedInputEvent[]): void => {
    void fetch(INPUT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...inputScope, events }),
    }).then((res) => {
      setStatus(res.ok ? t('control.focusHint') : t('control.refused'))
    }).catch(() => { setStatus(t('control.refused')) })
  }, [inputScope, t])

  const batcherRef = useRef<InputBatcher | undefined>(undefined)
  useEffect(() => {
    const instance = new InputBatcher({ send: sendInput })
    batcherRef.current = instance
    return () => {
      instance.releaseAll()
      instance.dispose()
      if (batcherRef.current === instance) batcherRef.current = undefined
    }
  }, [sendInput])

  const framePointOf = useCallback((image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const rect = image.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return undefined
    return {
      x: frameCoordinate(clientX - rect.left, rect.width, image.naturalWidth),
      y: frameCoordinate(clientY - rect.top, rect.height, image.naturalHeight),
    }
  }, [])

  /**
   * The pane's wheel listener is native because React registers `wheel`
   * passively at its root, and a forward-scrolled desktop needs the browser's own
   * scroll suppressed first.
   */
  useEffect(() => {
    const image = imgRef.current
    if (image === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (!inputEnabled) return
      const instance = batcherRef.current
      if (instance === undefined) return
      event.preventDefault()
      const point = framePointOf(image, event.clientX, event.clientY)
      if (point === undefined) return
      instance.move(point.x, point.y)
      instance.wheel(
        normalizeWheelDelta(event.deltaX, event.deltaMode),
        normalizeWheelDelta(event.deltaY, event.deltaMode),
      )
    }
    image.addEventListener('wheel', onWheel, { passive: false })
    return () => { image.removeEventListener('wheel', onWheel) }
  }, [failed, framePointOf, inputEnabled])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    event.preventDefault()
    event.currentTarget.focus()
    const point = framePointOf(event.currentTarget, event.clientX, event.clientY)
    const instance = batcherRef.current
    if (instance === undefined || point === undefined) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A test environment without pointer capture still delivers the events.
    }
    instance.move(point.x, point.y)
    const button = pointerButtonOf(event.button)
    if (button !== undefined) instance.button(button, true)
  }, [framePointOf, inputEnabled])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    const point = framePointOf(event.currentTarget, event.clientX, event.clientY)
    if (point === undefined) return
    batcherRef.current?.move(point.x, point.y)
  }, [framePointOf, inputEnabled])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    const button = pointerButtonOf(event.button)
    if (button !== undefined) batcherRef.current?.button(button, false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Nothing was captured, so there is nothing to release.
    }
  }, [inputEnabled])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- the helper grammar takes a virtual-key code, which only `keyCode` reports
    const vk = keyCodeWithinRange(event.keyCode)
    if (vk !== undefined) batcherRef.current?.key(vk, true)
  }, [inputEnabled])

  const handleKeyUp = useCallback((event: ReactKeyboardEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- the helper grammar takes a virtual-key code, which only `keyCode` reports
    const vk = keyCodeWithinRange(event.keyCode)
    if (vk !== undefined) batcherRef.current?.key(vk, false)
  }, [inputEnabled])

  const handleCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLImageElement>): void => {
    if (!inputEnabled) return
    batcherRef.current?.char(event.data)
  }, [inputEnabled])

  /** Drop every held key and button, so focus loss cannot strand input on the desktop. */
  const releaseInput = useCallback((): void => {
    batcherRef.current?.releaseAll()
  }, [])

  const toggleInput = useCallback((): void => {
    setInputEnabled((enabled) => {
      if (enabled) {
        batcherRef.current?.releaseAll()
        setStatus(t('control.released'))
        return false
      }
      setStatus(t('control.focusHint'))
      return true
    })
  }, [t])

  const seenKey = `${LAST_SEEN_PREFIX}${sessionId}`

  /**
   * Track the desktop change ring's cursor and compare it with the cursor this
   * browser already reviewed. The read never advances any cursor, so the badge
   * is a client-local fact while the model keeps its own acknowledgement.
   */
  useEffect(() => {
    if (failed) return undefined
    const readSeen = (): number | undefined => {
      try {
        const raw = window.localStorage.getItem(seenKey)
        return raw === null ? undefined : Number(raw)
      } catch {
        // A browser that refuses storage keeps the badge inside this mount.
        return undefined
      }
    }
    const writeSeen = (value: number): void => {
      try {
        window.localStorage.setItem(seenKey, String(value))
      } catch {
        // See readSeen: the in-memory cursor still tracks the session.
      }
    }
    if (seenRef.current === undefined) {
      const stored = readSeen()
      seenRef.current = stored !== undefined && !Number.isNaN(stored) ? stored : undefined
    }
    let cancelled = false
    const poll = async (): Promise<void> => {
      const params = new URLSearchParams()
      if (sessionId !== '') params.set('session', sessionId)
      if (selectedInstanceId !== undefined) params.set('instance', selectedInstanceId)
      params.set('since', '0')
      params.set('limit', '1')
      try {
        const res = await fetch(`${CHANGES_URL}?${params.toString()}`)
        if (!res.ok || cancelled) return
        const body = await res.json() as { ringCursor?: number }
        const cursor = typeof body.ringCursor === 'number' ? body.ringCursor : 0
        setChangeCursor(cursor)
        if (seenRef.current === undefined) {
          seenRef.current = cursor
          writeSeen(cursor)
        }
      } catch {
        // A failed poll leaves the last observed cursor standing.
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, CHANGES_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [failed, seenKey, selectedInstanceId, sessionId])

  const unseenChanges = seenRef.current === undefined ? 0 : Math.max(0, changeCursor - seenRef.current)

  const clearChanges = useCallback((): void => {
    seenRef.current = changeCursor
    try {
      window.localStorage.setItem(seenKey, String(changeCursor))
    } catch {
      // See readSeen: clearing still holds for this mount.
    }
    setChangeCursor(changeCursor)
  }, [changeCursor, seenKey])

  return (
    <div ref={pane} className={css.body} data-sandbox-view>
      {failed ? (
        <div className={css.failure}>
          <p className={css.failureNotice} role="alert">{t('stream.failed')}</p>
          <button
            type="button"
            className={css.retryButton}
            onClick={handleRetry}
          >
            {t('action.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className={css.toolbar}>
            <select
              className={css.targetSelect}
              value={target}
              aria-label="Target environment"
              onChange={(e) => { setTarget(e.target.value) }}
            >
              {sessionInstances.length > 0 ? (
                <>
                  {sessionInstances.map(inst => (
                    <option key={inst.id} value={inst.id}>
                      {inst.type === 'wsl-ubuntu' ? '🐧' : inst.type === 'win32' ? '🖥️' : '🪟'} {inst.name} ({inst.desktopName})
                    </option>
                  ))}
                  <option value="host-desktop">{t('target.desktop')}</option>
                </>
              ) : (
                <>
                  <option value="win32">{t('target.win32')}</option>
                  <option value="hyperv">{t('target.hyperv')}</option>
                  <option value="host-desktop">{t('target.desktop')}</option>
                </>
              )}
            </select>
            <select
              className={css.targetSelect}
              value={fps}
              aria-label={t('fps.label')}
              onChange={(e) => { handleFpsChange(Number(e.target.value)) }}
            >
              <option value={15}>15 FPS</option>
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
            </select>
            <span
              className={css.fpsBadge}
              title={`${t('fps.live')}: ${liveFps > 0 ? liveFps.toFixed(1) : '0'} FPS`}
              aria-label={`${t('fps.live')}: ${liveFps > 0 ? liveFps.toFixed(1) : '0'} FPS`}
            >
              <span className={`${css.fpsDot} ${liveFps >= 20 ? '' : liveFps >= 10 ? css.fpsDotWarn : css.fpsDotSlow}`} />
              {liveFps > 0 ? `${liveFps.toFixed(1)} FPS` : '-- FPS'}
            </span>
            <button
              type="button"
              className={`${css.toolButton} ${inputEnabled ? css.toolButtonActive : ''}`}
              title={t('control.tooltip')}
              aria-pressed={inputEnabled}
              onClick={toggleInput}
            >
              {t('control.label')}
            </button>
            {unseenChanges > 0 ? (
              <button
                type="button"
                className={css.changeBadge}
                title={t('changes.badge')}
                onClick={clearChanges}
              >
                {t('changes.badge')} {unseenChanges}
              </button>
            ) : null}
            <button
              type="button"
              className={css.toolButton}
              title={t('action.refresh')}
              onClick={handleRefresh}
            >
              {t('action.refresh')}
            </button>
            <button
              type="button"
              className={css.toolButton}
              title={t('action.stop')}
              onClick={() => void handleStop()}
            >
              {t('action.stop')}
            </button>
          </div>
          <img
            ref={imgRef}
            className={`${css.stream} ${inputEnabled ? css.streamCapturing : ''}`}
            src={frameUrl}
            alt={t('stream.alt')}
            tabIndex={0}
            onError={handleStreamError}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={releaseInput}
            onBlur={releaseInput}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onCompositionEnd={handleCompositionEnd}
            onContextMenu={(event) => { if (inputEnabled) event.preventDefault() }}
          />
          <LiveProcessesWidget
            t={t}
            windowsUrl={`${WINDOWS_URL}${streamQuery}`}
            focusUrl={WINDOWS_FOCUS_URL}
            closeUrl={WINDOWS_CLOSE_URL}
            requestBody={inputScope}
            onRefused={setStatus}
          />
          {status === '' ? null : <p className={css.statusLine} role="status">{status}</p>}
        </>
      )}
    </div>
  )
}
