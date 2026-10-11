/**
 * @deepseek-ai/dsh-cdp — one page session over the `Page` and `Runtime`
 * domains. A `PageSession` owns the flattened session `TargetRegistry.attach`
 * returned: it navigates the tab's main frame, waits for the load event or a
 * selector under a caller-supplied timeout, reads the title and URL, and
 * evaluates an expression with a bounded result. Every wait and every returned
 * value is bounded; a closed session refuses further work instead of sending on
 * a dead session.
 * @module @deepseek-ai/dsh-cdp/page
 */

import {
  MAX_DIALOG_HISTORY,
  MAX_DIALOG_MESSAGE_CHARS,
  MAX_DIALOG_PROMPT_CHARS,
  MAX_DIALOG_URL_CHARS,
  type DialogAnswer,
  type DialogPolicy,
  type DialogRecord,
  normalizeDialogType,
  sanitizeDialogText,
} from './dialog.ts' /* plan05 */

/**
 * The subset of a CDP connection one page session reads. The connection owns
 * the socket and routes replies and events; this interface stays narrow so a
 * page session is exercised without a transport.
 */
export interface PageConnection {
  /**
   * Send one CDP command.
   * @param method - CDP method name, for example `Page.navigate`.
   * @param params - protocol parameters.
   * @param sessionId - flattened session to route through; omitted for a
   *   browser-level command such as `Target.detachFromTarget`.
   * @param timeoutMs - optional per-send reply timeout in milliseconds;
   *   omitted means the connection's own default.
   * @returns the reply's `result` object. Rejects with the connection's own
   *   error when the browser answers with a protocol error.
   */
  send(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>
  /**
   * Subscribe to one CDP event. The connection delivers every session's events;
   * the listener receives the emitting session's id, undefined for a
   * browser-level event.
   * @param event - event name, for example `Page.loadEventFired`.
   * @param listener - receives the event's `params` and the emitting session id.
   * @returns a disposer that removes the subscription; calling it twice is safe.
   */
  on(event: string, listener: (params: unknown, sessionId: string | undefined) => void): () => void
}

/** Outcome of one `Page.navigate` command. */
export interface NavigationOutcome {
  /** Frame the browser navigated. */
  readonly frameId: string
  /** URL the browser was asked to load. */
  readonly url: string
  /** Protocol-reported navigation failure; undefined when the navigation was accepted. */
  readonly errorText: string | undefined
}

/**
 * Structured envelope for one failed evaluation. Carried on
 * {@link PageEvaluation.error} so a caller can report what threw instead of
 * receiving an empty string that masks the failure.
 */
export interface EvaluationError {
  /** Classification of the failure. */
  readonly kind: 'exception' | 'timeout' | 'connection' | 'session' | 'protocol'
  /** Thrown value's constructor name, for example `TypeError`; absent when unknown. */
  readonly name?: string
  /** One-line message with any `Name: ` prefix removed. */
  readonly message: string
  /** Stack text compiled from the description or the protocol stack trace; absent when unknown. */
  readonly stack?: string
  /** The expression that was being evaluated when the failure happened. */
  readonly expression?: string
}

/** One bounded `Runtime.evaluate` result. */
export interface PageEvaluation {
  /** Serialized result, cut at {@link MAX_EVALUATE_CHARS}; empty when the expression threw. */
  readonly value: string
  /** True when `value` was cut at the bound. */
  readonly truncated: boolean
  /** Protocol exception text; undefined when the expression returned a value. */
  readonly exception: string | undefined
  /** Whether the expression produced a value at all; false for `undefined` and for throws. */
  readonly hasValue: boolean
  /** JSON type of the produced value: `undefined`, `null`, `string`, `number`, `boolean`, `object`, or `array`. */
  readonly valueType: string
  /** Structured failure envelope; present only when the evaluation did not produce a value cleanly. */
  readonly error?: EvaluationError
}

/** Options widening one {@link PageSession.evaluate} call. */
export interface EvaluateOptions {
  /** `Runtime.evaluate.awaitPromise`: await a returned promise before reading the value. Default false. */
  readonly awaitPromise?: boolean
  /**
   * Per-send reply timeout in milliseconds. `Runtime.evaluate` has no timeout
   * parameter of its own, so a page that never answers falls into the
   * `timeout` error class through this send bound.
   */
  readonly timeoutMs?: number
}

/** Error thrown when a bounded wait passes its timeout. */
export class CdpTimeoutError extends Error {
  /** Condition the wait named, for example `Page.loadEventFired` or `selector .ready`. */
  readonly condition: string
  /** The wait's timeout in milliseconds. */
  readonly timeoutMs: number

  /**
   * @param condition - what the wait was observing.
   * @param timeoutMs - the timeout the wait exceeded, in milliseconds.
   */
  constructor(condition: string, timeoutMs: number) {
    super(`CDP wait timed out after ${String(timeoutMs)}ms waiting for ${condition}`)
    this.name = 'CdpTimeoutError'
    this.condition = condition
    this.timeoutMs = timeoutMs
  }
}

/** Error thrown when work is attempted on a closed page session. */
export class CdpSessionClosedError extends Error {
  /** The closed session the refused command named. */
  readonly sessionId: string

  /**
   * @param sessionId - the closed flattened session.
   */
  constructor(sessionId: string) {
    super(`CDP session ${sessionId} is closed; the command was not sent`)
    this.name = 'CdpSessionClosedError'
    this.sessionId = sessionId
  }
}

/** Error thrown when a `Page` or `Runtime` reply is unusable. */
export class CdpPageError extends Error {
  /**
   * @param message - what the reply failed to carry, naming the expression when one was evaluated.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CdpPageError'
  }
}

/** Largest text one evaluation, title, or URL result returns to a caller. */
export const MAX_EVALUATE_CHARS = 16_384

/** Event a {@link PageSession.waitForLoad} observes. */
const LOAD_EVENT = 'Page.loadEventFired'

/** plan05: dialog/chooser events one session queues, answers, or reports. */
const DIALOG_OPENING_EVENT = 'Page.javascriptDialogOpening' /* plan05 */
const DIALOG_CLOSING_EVENT = 'Page.javascriptDialogClosing' /* plan05 */
const FILE_CHOOSER_EVENT = 'Page.fileChooserOpened' /* plan05 */

/** Interval between two `document.querySelector` probes inside {@link PageSession.waitForSelector}. */
const SELECTOR_POLL_INTERVAL_MS = 100

/** One normalized `Runtime.evaluate` reply. */
interface EvaluateReply {
  /** The remote value when `returnByValue` delivered one; undefined otherwise. */
  readonly value: unknown
  /** Whether the reply carried a remote value at all. */
  readonly hasValue: boolean
  /** Protocol exception text, or undefined when the expression returned. */
  readonly exception: string | undefined
  /** JSON type of `value` when one exists; `undefined` when the expression threw. */
  readonly valueType: string
  /** Structured failure envelope, present only when the expression threw. */
  readonly error?: EvaluationError
}

/** One pending {@link PageSession.waitForLoad} wait. */
interface LoadWaiter {
  /** Settle the wait as fulfilled. */
  resolve: () => void
  /** Settle the wait as rejected, naming the closed session. */
  reject: (error: Error) => void
}

/** plan05: one staged `Page.fileChooserOpened` request. */
export interface FileChooserRequest {
  /** `selectSingle` or `selectMultiple`, as the event reported it. */
  readonly mode: string
  /** Backend node of the chooser's file input, when the event carried one. */
  readonly backendNodeId: number | undefined
  /** Frame that opened the chooser. */
  readonly frameId: string
  /** `Date.now()` when the chooser opened (drives age reporting). */
  readonly at: number
}

/**
 * @param value - candidate protocol reply or nested field.
 * @returns the value as a string-keyed record, or undefined for a non-object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Render one remote evaluation value as text.
 * @param value - the value `Runtime.evaluate` returned by value.
 * @returns the string itself for a string result, and `JSON.stringify` otherwise.
 */
function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * @param text - candidate result text.
 * @returns the text cut at {@link MAX_EVALUATE_CHARS} and whether it was cut.
 */
function boundText(text: string): { value: string; truncated: boolean } {
  if (text.length <= MAX_EVALUATE_CHARS) return { value: text, truncated: false }
  return { value: text.slice(0, MAX_EVALUATE_CHARS), truncated: true }
}

/**
 * @param ms - non-negative milliseconds.
 * @returns a promise that settles after at least `ms` milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * One tab's page session: navigation, bounded waits, bounded reads, and
 * expression evaluation over the session `TargetRegistry.attach` returned.
 *
 * Constructing the session subscribes to the load event on the connection and
 * {@link close} releases that subscription. Until then the session accepts
 * commands; afterwards every method rejects with {@link CdpSessionClosedError}
 * and sends nothing.
 */
export class PageSession {
  /** True once {@link close} succeeded. */
  private closed = false
  /** Removers of this session's event subscriptions. */
  private readonly unsubscribe: Array<() => void>
  /** Waiters of {@link waitForLoad} calls that have not settled yet. */
  private readonly loadWaiters = new Set<LoadWaiter>()

  /* plan05: JavaScript-dialog and file-chooser state for this session. */
  /** Dialogs reported open and not yet answered (queue; fail-fast contract). */
  private readonly dialogs: DialogRecord[] = []
  /** Ring of the most recent {@link MAX_DIALOG_HISTORY} dialogs, answered or not. */
  private readonly dialogHistory: DialogRecord[] = []
  /** Next per-session dialog id; never reused. */
  private dialogSeq = 0
  /** Auto-answer policy applied the moment an opening event arrives. */
  private dialogPolicy: DialogPolicy = { action: 'none' }
  /** Listeners notified the moment a dialog opens (the mid-flight race guard). */
  private readonly dialogWaiters = new Set<(record: DialogRecord) => void>()
  /** One file chooser staged by the opening event, awaiting {@link awaitFileChooser}. */
  private fileChooser: FileChooserRequest | undefined

  /**
   * @param connection - the CDP connection the session commands and observes.
   * @param sessionId - flattened session returned by `TargetRegistry.attach`.
   */
  constructor(private readonly connection: PageConnection, readonly sessionId: string) {
    this.unsubscribe = [
      connection.on(LOAD_EVENT, (_params, sessionId) => {
        if (sessionId !== this.sessionId) return
        for (const waiter of [...this.loadWaiters]) waiter.resolve()
      }),
      /* plan05: dialog lifecycle queued, answered, and reported for this session. */
      connection.on(DIALOG_OPENING_EVENT, (params, sessionId) => {
        if (sessionId !== this.sessionId) return
        this.onDialogOpening(params)
      }),
      connection.on(DIALOG_CLOSING_EVENT, (params, sessionId) => {
        if (sessionId !== this.sessionId) return
        this.onDialogClosing(params)
      }),
      connection.on(FILE_CHOOSER_EVENT, (params, sessionId) => {
        if (sessionId !== this.sessionId) return
        this.onFileChooserOpened(params)
      }),
    ]
  }

  /**
   * Ask the browser to navigate this session's main frame.
   *
   * The command resolves as soon as the browser accepts or refuses the
   * navigation; it never waits for the document, so a caller that needs the
   * load follows with {@link waitForLoad}.
   * @param url - absolute URL to load.
   * @returns the navigation outcome; `errorText` names a refusal the browser
   *   reported inside an otherwise successful reply, such as an invalid URL.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpPageError when the reply is not an object or carries no `frameId`.
   * Rejects with the connection's protocol error when the command itself fails.
   */
  async navigate(url: string): Promise<NavigationOutcome> {
    this.assertOpen()
    const result = await this.connection.send('Page.navigate', { url }, this.sessionId)
    const record = asRecord(result)
    if (record === undefined) throw new CdpPageError('Page.navigate reply was not an object')
    const frameId = record.frameId
    if (typeof frameId !== 'string' || frameId === '') throw new CdpPageError('Page.navigate reply carried no frameId')
    const errorText = record.errorText
    return { frameId, url, errorText: typeof errorText === 'string' ? errorText : undefined }
  }

  /**
   * Wait for this session's next `Page.loadEventFired`.
   *
   * The wait observes the next load event only: a load that fired before the
   * call is not seen, so a caller arms it before or immediately after
   * {@link navigate}. A load event of another session never settles it.
   * @param timeoutMs - maximum wait in milliseconds.
   * @returns nothing once the next load event arrives.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpTimeoutError naming `Page.loadEventFired` when no load event
   *   arrives within `timeoutMs`.
   */
  async waitForLoad(timeoutMs: number): Promise<void> {
    this.assertOpen()
    await new Promise<void>((resolve, reject) => {
      const waiter: LoadWaiter = {
        resolve: () => {
          clearTimeout(timer)
          this.loadWaiters.delete(waiter)
          resolve()
        },
        reject: (error: Error) => { reject(error) },
      }
      const timer = setTimeout(() => {
        this.loadWaiters.delete(waiter)
        reject(new CdpTimeoutError(LOAD_EVENT, timeoutMs))
      }, timeoutMs)
      this.loadWaiters.add(waiter)
    })
  }

  /**
   * Poll this session's document until `document.querySelector(selector)`
   * returns an element.
   *
   * At least one probe runs, then one probe per {@link SELECTOR_POLL_INTERVAL_MS}
   * interval; the loop ends when the selector matches or `timeoutMs` has passed,
   * so it is bounded in both time and command count.
   * @param selector - CSS selector handed to `document.querySelector`; it is
   *   serialized with `JSON.stringify`, so it cannot break out of the expression.
   * @param timeoutMs - maximum wait in milliseconds.
   * @returns nothing once the selector matches.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpPageError when a probe's expression throws.
   * @throws CdpTimeoutError naming the selector when no element matches within `timeoutMs`.
   */
  async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    this.assertOpen()
    const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const probe = await this.evaluate(expression)
      if (probe.exception !== undefined) throw new CdpPageError(`waitForSelector: ${probe.exception}`)
      if (probe.value === 'true') return
      if (Date.now() >= deadline) throw new CdpTimeoutError(`selector ${selector}`, timeoutMs)
      await delay(Math.min(SELECTOR_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }
  }

  /**
   * Evaluate one expression in this session's page.
   *
   * A throw is reported through {@link PageEvaluation.error} with a parsed
   * name, message, and stack — it is never converted into a silent empty
   * string. The success shape keeps the previous `value`/`truncated` fields
   * byte-identical and adds the failure/type metadata.
   * @param expression - JavaScript source evaluated with `returnByValue: true`.
   * @param options - optional promise awaiting and per-send reply timeout.
   * @returns the serialized result, cut at {@link MAX_EVALUATE_CHARS} with
   *   `truncated` set; `exception`/`error` carry the failure instead when the
   *   expression threw.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpPageError when the reply carries neither a result nor exception details.
   * Rejects with the connection's protocol error when the command fails.
   */
  async evaluate(expression: string, options?: EvaluateOptions): Promise<PageEvaluation> {
    const reply = await this.sendEvaluate(expression, options)
    if (reply.error !== undefined) {
      return {
        value: '',
        truncated: false,
        exception: reply.exception,
        hasValue: false,
        valueType: 'undefined',
        error: reply.error,
      }
    }
    const bound = boundText(reply.hasValue ? renderValue(reply.value) : '')
    return {
      value: bound.value,
      truncated: bound.truncated,
      exception: undefined,
      hasValue: reply.hasValue,
      valueType: reply.valueType,
    }
  }

  /**
   * Read this session's document title.
   * @returns `document.title`, cut at {@link MAX_EVALUATE_CHARS}.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpPageError when the expression threw or did not return a string.
   */
  async title(): Promise<string> {
    return await this.evaluateString('document.title')
  }

  /**
   * Read this session's document URL.
   * @returns `location.href`, cut at {@link MAX_EVALUATE_CHARS}.
   * @throws CdpSessionClosedError when the session is closed.
   * @throws CdpPageError when the expression threw or did not return a string.
   */
  async url(): Promise<string> {
    return await this.evaluateString('location.href')
  }

  /**
   * Release this page session: detach the flattened session and end every
   * pending load wait with {@link CdpSessionClosedError}.
   *
   * The target and its page stay open; `TargetRegistry.close(targetId)` closes a
   * tab. Closing twice is safe. When the detach command fails the session stays
   * open, so a caller can retry.
   * @throws CdpSessionClosedError never; a closed session resolves without a command.
   * Rejects with the connection's protocol error when the browser refuses the detach.
   */
  async close(): Promise<void> {
    if (this.closed) return
    await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId })
    this.markClosed()
  }

  /** Send one `Runtime.evaluate` and normalize its reply. */
  private async sendEvaluate(expression: string, options?: EvaluateOptions): Promise<EvaluateReply> {
    this.assertOpen()
    const params: Record<string, unknown> = { expression, returnByValue: true }
    if (options?.awaitPromise === true) params.awaitPromise = true
    const result = await this.connection.send('Runtime.evaluate', params, this.sessionId, options?.timeoutMs)
    const record = asRecord(result)
    if (record === undefined) throw new CdpPageError('Runtime.evaluate reply was not an object')
    const exceptionDetails = asRecord(record.exceptionDetails)
    if (exceptionDetails !== undefined) {
      const parsed = parseExceptionDetails(exceptionDetails, expression)
      return { value: undefined, hasValue: false, exception: parsed.exception, valueType: 'undefined', error: parsed.error }
    }
    const remote = asRecord(record.result)
    if (remote === undefined) throw new CdpPageError('Runtime.evaluate reply carried no result object')
    const hasValue = remote.value !== undefined
    return {
      value: remote.value,
      hasValue,
      exception: undefined,
      valueType: hasValue ? readValueType(remote.value) : 'undefined',
    }
  }

  /** Evaluate one expression that must return a string, and bound the returned text. */
  private async evaluateString(expression: string): Promise<string> {
    const reply = await this.sendEvaluate(expression)
    if (reply.exception !== undefined) throw new CdpPageError(`${expression}: ${reply.exception}`)
    if (typeof reply.value !== 'string') throw new CdpPageError(`${expression} did not return a string`)
    return boundText(reply.value).value
  }

  /** Take the closed-session refusal before any command reaches the connection. */
  private assertOpen(): void {
    if (this.closed) throw new CdpSessionClosedError(this.sessionId)
  }

  /** Mark the session closed, drop its subscriptions, and settle every pending wait. */
  private markClosed(): void {
    this.closed = true
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    const error = new CdpSessionClosedError(this.sessionId)
    for (const waiter of [...this.loadWaiters]) waiter.reject(error)
    this.loadWaiters.clear()
  }

  /* plan05: dialog queue/history, per-session policy, answer, and race primitives. */

  /**
   * The dialog at the head of this session's queue — the one
   * {@link answerDialog} would answer next.
   * @returns the dialog still pending on this session, or undefined — a
   *   closed session never reports one (its dialogs died with it).
   */
  pendingDialog(): DialogRecord | undefined {
    if (this.closed) return undefined
    return this.dialogs[0]
  }

  /**
   * The ring of recent dialogs this session saw — kept after they settle so
   * tool outputs can report dialogs that were already answered or closed.
   * @returns a copy of the session's recent-dialog ring, oldest first.
   */
  recentDialogs(): readonly DialogRecord[] {
    return [...this.dialogHistory]
  }

  /**
   * Read the auto-answer policy this session applies the moment a dialog
   * opens; callers get a detached copy, not the live policy object.
   * @returns the current auto-answer policy (a copy).
   */
  getDialogPolicy(): DialogPolicy {
    return { action: this.dialogPolicy.action, promptText: this.dialogPolicy.promptText }
  }

  /**
   * Replace the auto-answer policy for this session: the new action applies
   * to dialogs that open from now on, never to one already pending.
   * @param policy - replacement policy applied to future opening events.
   */
  setDialogPolicy(policy: DialogPolicy): void {
    this.dialogPolicy = { action: policy.action, promptText: policy.promptText }
  }

  /**
   * Register a listener for dialog openings on this session (the mid-flight
   * race guard listens here while its underlying command is in flight).
   * @param listener - called with the record the moment a dialog opens.
   * @returns a disposer removing the listener; calling it twice is safe.
   */
  onDialogOpened(listener: (record: DialogRecord) => void): () => void {
    this.dialogWaiters.add(listener)
    return () => { this.dialogWaiters.delete(listener) }
  }

  /**
   * Answer the dialog currently pending on this session. The reply defaults
   * to the dialog's own `defaultPrompt` for `prompt` dialogs; a dismiss never
   * carries one.
   * @param accept - true to accept, false to dismiss.
   * @param promptText - explicit reply for a `prompt` dialog, bounded at
   *   {@link MAX_DIALOG_PROMPT_CHARS}; omitted keeps `defaultPrompt`.
   * @returns nothing once the browser accepted the answer.
   * @throws CdpPageError when no dialog is pending.
   * Rejects with the connection's protocol error when the browser refuses.
   */
  async answerDialog(accept: boolean, promptText?: string): Promise<void> {
    this.assertOpen()
    const dialog = this.dialogs[0]
    if (dialog === undefined) throw new CdpPageError('answerDialog: no dialog is pending on this session')
    const reply = promptText !== undefined
      ? sanitizeDialogText(promptText, MAX_DIALOG_PROMPT_CHARS)
      : (dialog.type === 'prompt' ? dialog.defaultPrompt : undefined)
    await this.connection.send(
      'Page.handleJavaScriptDialog',
      { accept, ...(reply !== undefined ? { promptText: reply } : {}) },
      this.sessionId,
    )
    this.settleDialog(dialog, accept ? 'accepted' : 'dismissed', reply)
  }

  /**
   * Wait for the next file chooser this session stages through the opening
   * event. A chooser staged before this call is returned immediately, so the
   * caller may enable interception and then bind.
   * @param timeoutMs - maximum wait in milliseconds.
   * @returns the chooser request the opening event carried.
   * @throws CdpTimeoutError when no chooser opens in time.
   */
  async awaitFileChooser(timeoutMs: number): Promise<FileChooserRequest> {
    this.assertOpen()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.closed) throw new CdpSessionClosedError(this.sessionId)
      const staged = this.fileChooser
      if (staged !== undefined) {
        this.fileChooser = undefined
        return staged
      }
      if (Date.now() >= deadline) throw new CdpTimeoutError('file chooser', timeoutMs)
      await delay(Math.min(SELECTOR_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }
  }

  /** plan05: queue the opening dialog, run the policy, notify race waiters. */
  private onDialogOpening(params: unknown): void {
    const record = asRecord(params)
    const defaultPrompt = typeof record?.defaultPrompt === 'string' ? record.defaultPrompt : undefined
    const dialog: DialogRecord = {
      id: ++this.dialogSeq,
      sessionId: this.sessionId,
      type: normalizeDialogType(record?.type),
      message: sanitizeDialogText(typeof record?.message === 'string' ? record.message : '', MAX_DIALOG_MESSAGE_CHARS),
      url: sanitizeDialogText(typeof record?.url === 'string' ? record.url : '', MAX_DIALOG_URL_CHARS),
      defaultPrompt: defaultPrompt === undefined
        ? undefined
        : sanitizeDialogText(defaultPrompt, MAX_DIALOG_PROMPT_CHARS),
      openedAt: Date.now(),
      answered: undefined,
      answerPromptText: undefined,
    }
    this.dialogs.push(dialog)
    this.dialogHistory.push(dialog)
    while (this.dialogHistory.length > MAX_DIALOG_HISTORY) this.dialogHistory.shift()
    if (this.dialogPolicy.action !== 'none') {
      const accept = this.dialogPolicy.action === 'accept'
      const reply = dialog.type === 'prompt' && accept
        ? (this.dialogPolicy.promptText ?? dialog.defaultPrompt)
        : undefined
      void this.connection.send(
        'Page.handleJavaScriptDialog',
        { accept, ...(reply !== undefined ? { promptText: reply } : {}) },
        this.sessionId,
      ).then(() => {
        this.settleDialog(dialog, accept ? 'auto-accepted' : 'auto-dismissed', reply)
      }).catch(() => {
        // Auto-answer lost a race (page closed it first): the record stays
        // pending-looking for the guard, and race waiters are still told.
        this.notifyDialogWaiters(dialog)
      })
      return
    }
    this.notifyDialogWaiters(dialog)
  }

  /** plan05: the dialog went away without our answer — close it out. */
  private onDialogClosing(_params: unknown): void {
    const dialog = this.dialogs.shift()
      ?? [...this.dialogHistory].reverse().find(entry => entry.answered === undefined)
    if (dialog === undefined) return
    dialog.answered = 'closed-externally'
  }

  /** plan05: stage the file chooser for the next {@link awaitFileChooser}. */
  private onFileChooserOpened(params: unknown): void {
    const record = asRecord(params)
    const backendNodeId = typeof record?.backendNodeId === 'number' && Number.isFinite(record.backendNodeId)
      ? record.backendNodeId
      : undefined
    this.fileChooser = {
      mode: typeof record?.mode === 'string' && record.mode !== '' ? record.mode : 'selectSingle',
      backendNodeId,
      frameId: typeof record?.frameId === 'string' ? record.frameId : '',
      at: Date.now(),
    }
  }

  /** plan05: dequeue one answered dialog and record what its answer was. */
  private settleDialog(dialog: DialogRecord, answer: DialogAnswer, promptText: string | undefined): void {
    const index = this.dialogs.indexOf(dialog)
    if (index >= 0) this.dialogs.splice(index, 1)
    dialog.answered = answer
    dialog.answerPromptText = promptText
  }

  /** plan05: tell every registered race waiter about the opening dialog. */
  private notifyDialogWaiters(record: DialogRecord): void {
    for (const waiter of [...this.dialogWaiters]) waiter(record)
  }
}

/** One parsed `Runtime.evaluate` exception: the legacy text plus its envelope. */
export interface ParsedExceptionDetails {
  /** Legacy exception text: description, else protocol text, else `unknown exception`. */
  readonly exception: string
  /** Structured failure envelope carrying kind `exception` and this expression. */
  readonly error: EvaluationError
}

/**
 * Read `Runtime.evaluate` exception details into the legacy exception text
 * and a structured envelope. Name resolution order: the thrown value's
 * `className`, then a `Name: ` prefix on the description's first line, then
 * the protocol's own `text`. The message is the first line with any
 * `Name: ` prefix cut; the stack is the description below its first line,
 * falling back to frames compiled from the protocol stack trace.
 * @param exceptionDetails - the reply's exception details record.
 * @param expression - the expression that threw, carried on the envelope.
 * @returns the legacy exception text and the structured failure envelope.
 */
export function parseExceptionDetails(
  exceptionDetails: Record<string, unknown>,
  expression: string,
): ParsedExceptionDetails {
  const exception = asRecord(exceptionDetails.exception)
  const rawDescription = exception?.description
  const description = typeof rawDescription === 'string' && rawDescription !== '' ? rawDescription : undefined
  const rawText = exceptionDetails.text
  const protocolText = typeof rawText === 'string' && rawText !== '' ? rawText : undefined
  const exceptionText = description ?? protocolText ?? 'unknown exception'
  const firstLine = description === undefined ? '' : description.split('\n', 1)[0] ?? ''

  let name: string | undefined = typeof exception?.className === 'string' && exception.className !== ''
    ? exception.className
    : undefined
  if (name === undefined && firstLine !== '') {
    const prefix = /^([A-Za-z_$][\w$]*): /.exec(firstLine)
    if (prefix !== null) name = prefix[1]
  }
  if (name === undefined) name = protocolText

  let message: string
  if (firstLine !== '') {
    message = name !== undefined && firstLine.startsWith(`${name}: `)
      ? firstLine.slice(name.length + 2)
      : firstLine
  } else {
    message = protocolText ?? 'unknown exception'
  }

  let stack: string | undefined
  if (description !== undefined) {
    const newline = description.indexOf('\n')
    const rest = newline === -1 ? '' : description.slice(newline + 1)
    if (rest.trim() !== '') stack = rest
  }
  if (stack === undefined) {
    stack = compileStackTrace(asRecord(exceptionDetails.stackTrace))
  }

  return {
    exception: exceptionText,
    error: {
      kind: 'exception',
      ...(name === undefined ? {} : { name }),
      message,
      ...(stack === undefined ? {} : { stack }),
      expression,
    },
  }
}

/**
 * @param stackTrace - the protocol's `stackTrace` record, when present.
 * @returns `at function (url:row:col)` lines joined by newlines, or undefined when none compile.
 */
function compileStackTrace(stackTrace: Record<string, unknown> | undefined): string | undefined {
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : undefined
  if (callFrames === undefined || callFrames.length === 0) return undefined
  const lines = callFrames.map((frame) => {
    const record = asRecord(frame)
    const fn = typeof record?.functionName === 'string' && record.functionName !== '' ? record.functionName : '<anonymous>'
    const url = typeof record?.url === 'string' && record.url !== '' ? record.url : '<anonymous>'
    const line = typeof record?.lineNumber === 'number' ? record.lineNumber + 1 : 1
    const column = typeof record?.columnNumber === 'number' ? record.columnNumber + 1 : 1
    return `at ${fn} (${url}:${String(line)}:${String(column)})`
  })
  return lines.length > 0 ? lines.join('\n') : undefined
}

/**
 * @param value - a value `Runtime.evaluate` returned by value.
 * @returns the value's JSON-facing type name; exotic unserializable cases fall back to `undefined`.
 */
function readValueType(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return type
  if (type === 'object') return 'object'
  return 'undefined'
}
