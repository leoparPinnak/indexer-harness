/**
 * Stdio NDJSON client for the prebuilt `cua-helper.exe`.
 *
 * Mirrors Codex's `WindowsHelperTransport`: one spawn per client, requests
 * numbered from 1, per-method timeouts (`launch_app` 15s, everything else
 * 10s unless overridden), a request-budget stamp in `meta`, approvalRequest
 * re-delivery, and pending-request rejection on timeout/exit/protocol error.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { resolveHelperPath } from './helper-path.ts'
import {
  APPROVED_APP_META_KEY,
  NdjsonDecoder,
  encodeRequest,
  requestTimeoutFor,
  type CuaApprovalRequest,
  type CuaRequestMeta,
  type DecodedLine,
} from './protocol.ts'

/** A target window as the helper addresses it: the integer handle carries it. */
export interface CuaWindowRef {
  readonly app?: string
  readonly id: number
  readonly title?: string
}

/**
 * Spawn options for {@link CuaHelperClient}: helper binary and arguments,
 * environment overrides, request budget, and the approval hook.
 */
export interface CuaHelperClientOptions {
  /** Explicit helper path; otherwise package bin, repo bin, or `CUA_HELPER_PATH`. */
  readonly helperPath?: string
  readonly helperArgs?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Overrides both per-method default timeouts. */
  readonly timeoutMs?: number
  /**
   * Approval flow, mirroring Codex's elicitation hook. Return true to resend
   * the request with `x-oai-cua-approved-app` stamped into `meta`; without a
   * handler the request rejects with `CuaApprovalRequiredError`.
   */
  readonly approvalHandler?: (
    approval: CuaApprovalRequest,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<boolean> | boolean
}

/**
 * Per-request overrides for {@link CuaHelperClient.request}: an approved app,
 * extra `meta`, and a timeout.
 */
export interface CuaRequestOptions {
  readonly approvedApp?: string
  readonly meta?: CuaRequestMeta
  readonly timeoutMs?: number
}

/** The helper answered a request with an `error` frame instead of a result. */
export class CuaHelperRequestError extends Error {
  /** The helper method that failed. */
  readonly method: string
  constructor(method: string, message: string) {
    super(message)
    this.name = 'CuaHelperRequestError'
    this.method = method
  }
}

/** No answer within the method's budget; the client kills the helper and fails every pending request. */
export class CuaHelperTimeoutError extends Error {
  /** The helper method whose budget expired. */
  readonly method: string
  constructor(method: string) {
    super(`computer-use request timed out: ${method}`)
    this.name = 'CuaHelperTimeoutError'
    this.method = method
  }
}

/** The helper emitted a line that is not a valid response object; pending requests reject with it. */
export class CuaHelperProtocolError extends Error {
  constructor(line: string) {
    super(`computer-use helper emitted invalid JSON: ${line}`)
    this.name = 'CuaHelperProtocolError'
  }
}

/** The helper process exited while its requests were pending. */
export class CuaHelperExitError extends Error {
  /** Process exit code, or null when a signal ended the process. */
  readonly exitCode: number | null
  /** Terminating signal name, or null for a plain exit. */
  readonly signal: string | null
  /** Tail of the helper's stderr (4 KiB) quoted in the message. */
  readonly stderr: string
  constructor(exitCode: number | null, signal: string | null, stderr: string) {
    const how = signal === null ? `exit code ${exitCode ?? 'unknown'}` : `signal ${signal}`
    super(stderr.trim() === '' ? `computer-use helper exited with ${how}` : `computer-use helper exited with ${how}: ${stderr.trim()}`)
    this.name = 'CuaHelperExitError'
    this.exitCode = exitCode
    this.signal = signal
    this.stderr = stderr
  }
}

/** The helper demanded approval for an app and no handler granted it; carries the request to retry. */
export class CuaApprovalRequiredError extends Error {
  /** The approval prompt the helper raised (app, display name, risk level). */
  readonly approval: CuaApprovalRequest
  /** The helper method that paused awaiting approval. */
  readonly method: string
  /** The original params to resend once `approval.app` is approved. */
  readonly params: Record<string, unknown>
  constructor(approval: CuaApprovalRequest, method: string, params: Record<string, unknown>) {
    super(`computer-use requires approval to use ${approval.displayName}`)
    this.name = 'CuaApprovalRequiredError'
    this.approval = approval
    this.method = method
    this.params = params
  }
}

interface PendingRequest {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly options: CuaRequestOptions
  readonly depth: number
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** One screenshot in a window state: image reference, stacking order, origin, and pixel size. */
export interface CuaScreenshot {
  readonly id: string
  readonly zIndex: number
  readonly url: string
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/** One UIA element as the helper serializes it: index, stable path, control type, name, value, and bounds. */
export interface CuaElementRecord {
  readonly element_index: number
  readonly path: string
  readonly controlType: string
  readonly name: string
  readonly value?: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly enabled?: boolean
  readonly offscreen?: boolean
  readonly automationId?: string
  readonly className?: string
}

/** The accessibility half of a window state: tree text plus element records, with the helper's diff flags. */
export interface CuaAccessibility {
  readonly tree: string
  readonly elements: readonly CuaElementRecord[]
  readonly diff?: 'full' | 'incremental'
  readonly changed?: boolean
  readonly unchanged?: boolean
  readonly focused_element?: string
}

/** `get_window_state` result: the target window, its screenshots, capture mode, and optional accessibility tree. */
export interface CuaWindowStateResult {
  readonly window: CuaWindowRef
  readonly screenshots: readonly CuaScreenshot[]
  readonly captureMode?: string
  readonly accessibility?: CuaAccessibility
}

/** What one input delivery reported: landed flag, detail line, target and foreground handles, and focus transfer. */
export interface CuaInputOutcome {
  readonly delivered: boolean
  readonly detail: string
  readonly target: number
  readonly foreground: number
  readonly focusTransferred: boolean
}

/** `capture` result: frame size, mechanism used (`wgc` or `gdi`), desktop source, and observed color per region. */
export interface CuaCaptureResult {
  readonly width: number
  readonly height: number
  readonly mode: 'wgc' | 'gdi'
  readonly fallbackReason?: string
  readonly desktopSource?: 'wgc' | 'none'
  readonly regions: Record<string, string>
}

/** One window as `list_windows` reports it: owning app, window id, and optional title. */
export interface CuaWindowInfo {
  readonly app: string
  readonly id: number
  readonly title?: string
}

/** `get_helper_info` result: helper path, desktop, pid, elevation, COM apartment, and optional cursor point. */
export interface CuaHelperInfo {
  readonly helper: string
  readonly desktop: string
  readonly pid: number
  readonly elevated: boolean
  readonly comApartment: string
  readonly cursor?: { readonly x: number; readonly y: number }
}

/** One spawned helper over stdio NDJSON: numbered requests, per-method budgets, typed rejections, approval retry. */
export class CuaHelperClient {
  /** Absolute path of the helper binary spawned at construction. */
  readonly helperPath: string
  #child: ChildProcessWithoutNullStreams
  #pending = new Map<number, PendingRequest>()
  #nextId = 1
  #decoder = new NdjsonDecoder()
  #stderr = ''
  #closed = false
  #fatal: Error | null = null
  #exited: Promise<void>
  #options: CuaHelperClientOptions

  constructor(options: CuaHelperClientOptions = {}) {
    this.#options = options
    this.helperPath = resolveHelperPath(options.helperPath)
    const env: Record<string, string | undefined> = { ...process.env, ...options.env }
    this.#child = spawn(this.helperPath, [...(options.helperArgs ?? [])], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => {
      for (const message of this.#decoder.push(chunk)) this.#deliver(message)
    })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4096)
    })
    const exited = Promise.withResolvers<void>()
    this.#exited = exited.promise
    // 'close' (not 'exit'): stderr must be flushed before the exit error is built.
    this.#child.once('close', () => {
      this.#onExit()
      exited.resolve()
    })
    this.#child.once('error', (error: NodeJS.ErrnoException) => {
      this.#fatal = error
      this.#failAll(error)
      exited.resolve()
    })
  }

  /** Helper process id, or undefined while no process is attached. */
  get pid(): number | undefined {
    return this.#child.pid
  }

  /** Settles once the helper's streams close or the spawn fails; never rejects. */
  get exited(): Promise<void> {
    return this.#exited
  }

  /**
   * Send one request; resolves with `result` or rejects with a typed error.
   * The rejection is one of the typed errors (or the spawn failure).
   * @param method - helper method name, for example `get_window_state`.
   * @param params - method params in the helper's wire shape.
   * @param options - per-request approval, `meta`, and timeout overrides.
   * @returns the method's `result`, cast to the caller's `T`.
   */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CuaRequestOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('computer-use client is closed'))
    if (this.#fatal !== null) return Promise.reject(this.#fatal)
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.#begin(method, params, options, 0, resolve, reject)
    return promise as Promise<T>
  }

  #begin(
    method: string,
    params: Record<string, unknown>,
    options: CuaRequestOptions,
    depth: number,
    resolve: (value: unknown) => void,
    reject: (reason: unknown) => void,
  ): void {
    const id = this.#nextId
    this.#nextId += 1
    const timeoutMs = requestTimeoutFor(method, options.timeoutMs ?? this.#options.timeoutMs)
    const meta: CuaRequestMeta = { ...(options.meta ?? {}) }
    const approvedApp = options.approvedApp
    if (approvedApp !== undefined) meta[APPROVED_APP_META_KEY] = approvedApp
    const timer = setTimeout(() => {
      this.#onTimeout(id, method)
    }, timeoutMs)
    this.#pending.set(id, { method, params, options, depth, resolve, reject, timer })
    const line = encodeRequest(id, method, params, meta, timeoutMs)
    this.#child.stdin.write(line, 'utf8', (error) => {
      if (error !== null && error !== undefined) {
        const pending = this.#pending.get(id)
        if (pending !== undefined) {
          clearTimeout(pending.timer)
          this.#pending.delete(id)
          pending.reject(error)
        }
      }
    })
  }

  #deliver(message: DecodedLine): void {
    switch (message.kind) {
      case 'ignored':
        return
      case 'invalid':
        this.#failAll(new CuaHelperProtocolError(message.line))
        return
      case 'result': {
        const pending = this.#settle(message.id)
        if (pending !== undefined) pending.resolve(message.result)
        return
      }
      case 'error': {
        const pending = this.#settle(message.id)
        if (pending !== undefined) pending.reject(new CuaHelperRequestError(pending.method, message.error))
        return
      }
      case 'approval': {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.#pending.delete(message.id)
        this.#handleApproval(pending, message.approval)
        return
      }
    }
  }

  #handleApproval(pending: PendingRequest, approval: CuaApprovalRequest): void {
    const handler = this.#options.approvalHandler
    if (handler === undefined || pending.depth >= 1) {
      pending.reject(new CuaApprovalRequiredError(approval, pending.method, pending.params))
      return
    }
    void (async () => {
      let allowed: boolean
      try {
        allowed = await handler(approval, pending.method, pending.params)
      } catch (error) {
        pending.reject(error)
        return
      }
      if (!allowed) {
        pending.reject(new CuaApprovalRequiredError(approval, pending.method, pending.params))
        return
      }
      if (this.#fatal !== null || this.#closed) {
        pending.reject(this.#fatal ?? new Error('computer-use client is closed'))
        return
      }
      this.#begin(
        pending.method,
        pending.params,
        { ...pending.options, approvedApp: approval.app },
        pending.depth + 1,
        pending.resolve,
        pending.reject,
      )
    })()
  }

  #settle(id: number): PendingRequest | undefined {
    const pending = this.#pending.get(id)
    if (pending === undefined) return undefined
    clearTimeout(pending.timer)
    this.#pending.delete(id)
    return pending
  }

  #failAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      const pending = this.#settle(id)
      pending?.reject(error)
    }
  }

  #onTimeout(id: number, method: string): void {
    if (!this.#pending.has(id)) return
    const error = new CuaHelperTimeoutError(method)
    this.#failAll(error)
    this.#fatal = this.#fatal ?? error
    this.#child.kill()
  }

  #onExit(): void {
    if (this.#fatal === null) {
      this.#fatal = new CuaHelperExitError(this.#child.exitCode, this.#child.signalCode, this.#stderr)
    }
    this.#failAll(this.#fatal)
  }

  /** Mirror Codex's `close()`: ask, wait for the exit, kill as the fallback. */
  async close(): Promise<void> {
    if (this.#closed) return
    if (this.#fatal !== null) {
      this.#closed = true
      return
    }
    try {
      await this.request('close', {}, { timeoutMs: 3000 })
    } catch {
      // The helper may have exited on its own; the kill below is idempotent.
    }
    this.#closed = true
    await Promise.race([this.#exited, delay(2000)])
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill()
      await Promise.race([this.#exited, delay(1000)])
    }
  }

  // ---- Codex client surface -------------------------------------------------

  /**
   * Read a window's state: screenshots, capture mode, and optionally its UIA tree.
   * @param window - target window as the helper addresses it.
   * @param options - what to include: screenshot, text, and diff suppression.
   * @returns the window state with the requested halves filled in.
   */
  getWindowState(
    window: CuaWindowRef,
    options: { includeScreenshot?: boolean; includeText?: boolean; disableDiff?: boolean } = {},
  ): Promise<CuaWindowStateResult> {
    return this.request<CuaWindowStateResult>('get_window_state', {
      window,
      include_screenshot: options.includeScreenshot ?? true,
      include_text: options.includeText ?? false,
      disableDiff: options.disableDiff ?? false,
    })
  }

  /**
   * Enumerate the top-level windows of the helper's desktop.
   * @returns every window the helper can address, with app, id, and title.
   */
  listWindows(): Promise<CuaWindowInfo[]> {
    return this.request<CuaWindowInfo[]>('list_windows', {})
  }

  /**
   * Enumerate the running apps the helper groups those windows by.
   * @returns one entry per owning process, carrying its windows.
   */
  listApps(): Promise<readonly CuaWindowInfo[]> {
    return this.request('list_apps', {})
  }

  /**
   * Look up one window by id.
   * @param ref - window id, optionally qualified by the owning app.
   * @returns the window record the helper matched.
   */
  getWindow(ref: { app?: string; id: number }): Promise<CuaWindowInfo> {
    return this.request<CuaWindowInfo>('get_window', { ...(ref.app !== undefined ? { app: ref.app } : {}), id: ref.id })
  }

  /**
   * Bring a window to the foreground.
   * @param window - window to activate.
   * @returns delivery outcome, including whether focus actually transferred.
   */
  activateWindow(window: CuaWindowRef): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('activate_window', { window })
  }

  /**
   * Move the cursor to a point.
   * @param window - window the point is addressed against.
   * @param x - horizontal coordinate.
   * @param y - vertical coordinate.
   * @param space - `screen` (default) or `window` coordinates.
   * @returns delivery outcome for the injected move.
   */
  move(window: CuaWindowRef, x: number, y: number, space: 'screen' | 'window' = 'screen'): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('move', { window, x, y, space })
  }

  /**
   * Click at a point inside a window.
   * @param window - window the point is addressed against.
   * @param params - point, click count, mouse button, and coordinate space.
   * @returns delivery outcome, including whether focus transferred.
   */
  click(
    window: CuaWindowRef,
    params: { x: number; y: number; clickCount?: number; button?: 'left' | 'right' | 'middle'; space?: 'screen' | 'window' },
  ): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('click', {
      window,
      x: params.x,
      y: params.y,
      click_count: params.clickCount ?? 1,
      mouse_button: params.button ?? 'left',
      space: params.space ?? 'screen',
    })
  }

  /**
   * Click an element previously read from the window's UIA tree.
   * @param window - window owning the element.
   * @param elementIndex - the element's `element_index` from a tree read.
   * @param params - click count and button; defaults to one left click.
   * @returns delivery outcome, including whether focus transferred.
   */
  clickElement(
    window: CuaWindowRef,
    elementIndex: number,
    params: { clickCount?: number; button?: 'left' | 'right' | 'middle' } = {},
  ): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('click_element', {
      window,
      element_index: elementIndex,
      click_count: params.clickCount ?? 1,
      mouse_button: params.button ?? 'left',
    })
  }

  /**
   * Scroll at a point by wheel deltas.
   * @param window - window the point is addressed against.
   * @param params - point, X/Y wheel deltas, and coordinate space.
   * @returns delivery outcome for the injected wheel events.
   */
  scroll(
    window: CuaWindowRef,
    params: { x: number; y: number; scrollX: number; scrollY: number; space?: 'screen' | 'window' },
  ): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('scroll', {
      window,
      x: params.x,
      y: params.y,
      scrollX: params.scrollX,
      scrollY: params.scrollY,
      space: params.space ?? 'screen',
    })
  }

  /**
   * Drag from one point to another inside a window.
   * @param window - window the points are addressed against.
   * @param params - start and end points plus coordinate space.
   * @returns delivery outcome for the injected pointer sequence.
   */
  drag(
    window: CuaWindowRef,
    params: { fromX: number; fromY: number; toX: number; toY: number; space?: 'screen' | 'window' },
  ): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('drag', {
      window,
      from_x: params.fromX,
      from_y: params.fromY,
      to_x: params.toX,
      to_y: params.toY,
      space: params.space ?? 'screen',
    })
  }

  /**
   * Press and release one key.
   * @param window - window receiving the key.
   * @param key - key name the helper's key map accepts.
   * @returns delivery outcome, including whether focus transferred.
   */
  pressKey(window: CuaWindowRef, key: string): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('press_key', { window, key })
  }

  /**
   * Type a run of text.
   * @param window - window receiving the text.
   * @param text - characters to synthesize.
   * @returns delivery outcome for the injected keystrokes.
   */
  typeText(window: CuaWindowRef, text: string): Promise<CuaInputOutcome> {
    return this.request<CuaInputOutcome>('type_text', { window, text })
  }

  /**
   * Invoke a named secondary action on an element.
   * @param window - window owning the element.
   * @param elementIndex - the element's `element_index` from a tree read.
   * @param action - action name the helper applies to the element.
   * @returns the helper's raw result for the action.
   */
  performSecondaryAction(window: CuaWindowRef, elementIndex: number, action: string): Promise<Record<string, unknown>> {
    return this.request('perform_secondary_action', { window, element_index: elementIndex, action })
  }

  /**
   * Write a value into an element.
   * @param window - window owning the element.
   * @param elementIndex - the element's `element_index` from a tree read.
   * @param value - value to assign.
   * @returns the helper's raw result for the assignment.
   */
  setValue(window: CuaWindowRef, elementIndex: number, value: string): Promise<Record<string, unknown>> {
    return this.request('set_value', { window, element_index: elementIndex, value })
  }

  /**
   * Capture a frame and sample named region colors from it.
   * @param window - window to capture.
   * @param samples - named points in `window` or `desktop` space; none means no region samples.
   * @param mode - force `wgc` or `gdi`; omitted lets the helper choose and fall back.
   * @returns frame size, the mechanism used, and the observed color per region.
   */
  capture(
    window: CuaWindowRef,
    samples: readonly { name: string; space: 'window' | 'desktop'; x: number; y: number }[] = [],
    mode?: 'wgc' | 'gdi',
  ): Promise<CuaCaptureResult> {
    return this.request<CuaCaptureResult>('capture', {
      window,
      samples: [...samples],
      ...(mode !== undefined ? { mode } : {}),
    })
  }

  /**
   * Launch an app on the helper's desktop.
   * @param app - executable name or path, optionally with arguments.
   * @param options - per-request approval, `meta`, and timeout overrides.
   * @returns whether the helper launched the app.
   */
  launchApp(app: string, options: CuaRequestOptions = {}): Promise<{ app: string; launched: boolean }> {
    return this.request('launch_app', { app }, options)
  }

  /**
   * End the turn: drop the helper's cached UIA snapshots and diff state.
   * @returns the helper's acknowledgment that its caches are clear.
   */
  endTurn(): Promise<{ endTurn: boolean }> {
    return this.request('end_turn', {})
  }

  /**
   * Read the helper's own runtime facts.
   * @returns helper path, desktop, pid, elevation, and COM apartment.
   */
  getHelperInfo(): Promise<CuaHelperInfo> {
    return this.request<CuaHelperInfo>('get_helper_info', {})
  }

  /**
   * Diagnostic: WGC readiness plus a forced fresh frame (window or monitor).
   * @param window - window frame to probe; omitted probes the monitor.
   * @returns the helper's raw probe report.
   */
  probeCapture(window?: CuaWindowRef): Promise<Record<string, unknown>> {
    return this.request('probe_capture', window !== undefined ? { window } : {})
  }
}

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
