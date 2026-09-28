/**
 * plan05 dialog tests (own file; siblings own their specs): the pure
 * primitives in `dialog.ts` (sanitizing, quoting, briefs, denial text, the
 * guarded-tool set) plus `PageSession` dialog/chooser state over the
 * in-process fake connection — queue, per-session policy auto-answer, the
 * answer flow, external closing, waiter notification, the history ring cap,
 * and file-chooser staging. No socket, browser, or port is used.
 */

import { describe, expect, it } from 'vitest'
import {
  CdpPageError,
  CdpSessionClosedError,
  CdpTimeoutError,
  PageSession,
  type PageConnection,
} from '../src/page.ts'
import {
  CdpDialogOpenError,
  DIALOG_GUARDED_TOOLS,
  MAX_DIALOG_HISTORY,
  MAX_DIALOG_MESSAGE_CHARS,
  briefDialog,
  dialogDenialReason,
  isDialogGuardedTool,
  normalizeDialogType,
  quoteDialogText,
  sanitizeDialogText,
  type DialogRecord,
  type DialogType,
} from '../src/dialog.ts'

/** Flattened session every case drives. */
const SESSION = 'session-1'

/** One command the fake connection was asked to send. */
interface SentCommand {
  method: string
  params: Record<string, unknown>
  sessionId: string | undefined
}

/** In-process stand-in for the CDP connection: records commands, answers from a reply table, emits events. */
interface FakeConnection {
  connection: PageConnection
  sent: SentCommand[]
  reply(method: string, value: unknown): void
  fail(method: string, error: Error): void
  emit(event: string, params: unknown, sessionId: string | undefined): void
}

/** Build one fake connection. */
function makeConnection(): FakeConnection {
  const sent: SentCommand[] = []
  const replies = new Map<string, () => Promise<unknown>>()
  const listeners = new Map<string, Array<(params: unknown, sessionId: string | undefined) => void>>()
  return {
    connection: {
      send: (method, params, sessionId) => {
        sent.push({ method, params, sessionId })
        const reply = replies.get(method)
        if (reply === undefined) return Promise.reject(new Error(`no canned reply for ${method}`))
        return reply()
      },
      on: (event, listener) => {
        const registered = listeners.get(event) ?? []
        registered.push(listener)
        listeners.set(event, registered)
        return () => {
          const index = registered.indexOf(listener)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
    sent,
    reply: (method, value) => { replies.set(method, () => Promise.resolve(value)) },
    fail: (method, error) => { replies.set(method, () => Promise.reject(error)) },
    emit: (event, params, sessionId) => {
      for (const listener of listeners.get(event) ?? []) listener(params, sessionId)
    },
  }
}

/** Let queued microtasks and zero-delay timers settle. */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5) })

const OPENING_EVENT = 'Page.javascriptDialogOpening'
const CLOSING_EVENT = 'Page.javascriptDialogClosing'
const CHOOSER_EVENT = 'Page.fileChooserOpened'

const opening = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'confirm',
  message: 'Sure?',
  url: 'https://example.test/page',
  ...extra,
})

describe('plan05: dialog primitives', () => {
  it('sanitizes C0 control bytes while keeping tab/newline and marking cuts', () => {
    const raw = `line1${String.fromCharCode(27)}[31mline2${String.fromCharCode(0)}x${String.fromCharCode(127)}\tand\nnewline`
    expect(sanitizeDialogText(raw)).toBe('line1[31mline2x\tand\nnewline')
    // The source itself must never carry a raw control byte back out.
    expect([...sanitizeDialogText(raw)].some(ch => (ch.codePointAt(0) ?? 0) < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r')).toBe(false)
    expect(sanitizeDialogText('a'.repeat(10), 4)).toBe('aaaa…[truncated]')
    expect(sanitizeDialogText('x'.repeat(MAX_DIALOG_MESSAGE_CHARS + 50))).toContain('…[truncated]')
  })

  it('quotes dialog text onto one escape-safe line', () => {
    expect(quoteDialogText('say "hi"\\there\nbye')).toBe('"say \\"hi\\"\\\\there\\nbye"')
    // ESC is stripped inside, so a hostile dialog cannot forge tool-output lines.
    expect(quoteDialogText(`${String.fromCharCode(27)}[31mred`)).toBe('"[31mred"')
  })

  it('normalizes unknown dialog types to alert instead of dropping them', () => {
    expect(normalizeDialogType('confirm')).toBe('confirm')
    expect(normalizeDialogType('prompt')).toBe('prompt')
    expect(normalizeDialogType('beforeunload')).toBe('beforeunload')
    expect(normalizeDialogType('banana')).toBe('alert')
    expect(normalizeDialogType(undefined)).toBe('alert')
  })

  it('builds briefs with optional keys omitted, never undefined', () => {
    const base: DialogRecord = {
      id: 1,
      sessionId: SESSION,
      type: 'confirm',
      message: 'Sure?',
      url: 'https://example.test/page',
      defaultPrompt: undefined,
      openedAt: 1_000,
      answered: undefined,
      answerPromptText: undefined,
    }
    const pending = briefDialog(base, 'T1', 1_500)
    expect(pending).toEqual({
      targetId: 'T1',
      type: 'confirm',
      message: 'Sure?',
      url: 'https://example.test/page',
      ageMs: 500,
    })
    expect('defaultPrompt' in pending).toBe(false)
    expect('answered' in pending).toBe(false)

    const prompt: DialogRecord = { ...base, type: 'prompt' as DialogType, defaultPrompt: 'prefilled', answered: 'accepted' }
    const done = briefDialog(prompt, '', 1_000)
    expect(done.defaultPrompt).toBe('prefilled')
    expect(done.answered).toBe('accepted')
    expect(done.ageMs).toBe(0)
  })

  it('denies with one teaching line and guards exactly the page-scoped tools', () => {
    const brief = briefDialog({
      id: 1, sessionId: SESSION, type: 'alert', message: 'Boom', url: 'https://x.test/',
      defaultPrompt: undefined, openedAt: 0, answered: undefined, answerPromptText: undefined,
    }, 'T1', 10)
    const reason = dialogDenialReason(brief)
    expect(reason.startsWith('dialog-open:')).toBe(true)
    expect(reason).toContain('cdp_dialog')
    expect(reason).toContain('"Boom"')
    expect(new CdpDialogOpenError(brief).code).toBe('dialog-open')

    expect([...DIALOG_GUARDED_TOOLS].sort()).toEqual(
      // plan07 appended cdp_stealth/cdp_fingerprint to the guarded page set.
      ['cdp_click', 'cdp_eval', 'cdp_exec', 'cdp_fingerprint', 'cdp_navigate', 'cdp_stealth', 'cdp_snapshot', 'cdp_type', 'cdp_wait'].sort(),
    )
    for (const name of ['cdp_dialog', 'cdp_upload', 'cdp_status', 'cdp_tabs']) {
      expect(isDialogGuardedTool(name)).toBe(false)
    }
  })
})

describe('plan05: PageSession dialog state', () => {
  it('queues an opening dialog and ignores foreign-session events', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.emit(OPENING_EVENT, opening(), 'other-session')
    expect(page.pendingDialog()).toBeUndefined()

    fake.emit(OPENING_EVENT, opening({ message: ` hi${String.fromCharCode(27)} ` }), SESSION)
    const pending = page.pendingDialog()
    expect(pending).toMatchObject({ type: 'confirm', message: ' hi ', url: 'https://example.test/page', answered: undefined })
    const brief = briefDialog(pending!, 'T1', pending!.openedAt)
    expect(brief.targetId).toBe('T1')
    expect(brief.ageMs).toBe(0)
  })

  it('answers a prompt dialog with its default reply when none is given', async () => {
    const fake = makeConnection()
    fake.reply('Page.handleJavaScriptDialog', {})
    const page = new PageSession(fake.connection, SESSION)

    fake.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'prefilled' }), SESSION)
    await page.answerDialog(true)

    expect(fake.sent).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'prefilled' }, sessionId: SESSION },
    ])
    expect(page.pendingDialog()).toBeUndefined()
    expect(page.recentDialogs()[0]?.answered).toBe('accepted')
    expect(briefDialog(page.recentDialogs()[0]!, 'T1').answered).toBe('accepted')
  })

  it('sanitizes an explicit reply and sends no promptText on a dismiss', async () => {
    const fake = makeConnection()
    fake.reply('Page.handleJavaScriptDialog', {})
    const page = new PageSession(fake.connection, SESSION)

    fake.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'x' }), SESSION)
    await page.answerDialog(true, `evil${String.fromCharCode(27)}reply`)
    expect(fake.sent[0]?.params).toEqual({ accept: true, promptText: 'evilreply' })

    fake.emit(OPENING_EVENT, opening({ type: 'confirm' }), SESSION)
    await page.answerDialog(false)
    expect(fake.sent[1]?.params).toEqual({ accept: false })
    // History reads oldest first: the prompt accepted first, then the confirm.
    expect(page.recentDialogs().map(entry => entry.answered)).toEqual(['accepted', 'dismissed'])
  })

  it('refuses to answer when nothing is pending and when the browser refuses', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)
    await expect(page.answerDialog(true)).rejects.toBeInstanceOf(CdpPageError)

    fake.emit(OPENING_EVENT, opening(), SESSION)
    fake.fail('Page.handleJavaScriptDialog', new Error('devtools protocol error'))
    await expect(page.answerDialog(true)).rejects.toThrow('devtools protocol error')
    // The dialog stays pending after a failed answer — the guard still sees it.
    expect(page.pendingDialog()).toBeDefined()
  })

  it('auto-answers under the accept policy and the dismiss policy', async () => {
    const fake = makeConnection()
    fake.reply('Page.handleJavaScriptDialog', {})
    const page = new PageSession(fake.connection, SESSION)

    page.setDialogPolicy({ action: 'accept' })
    fake.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'default' }), SESSION)
    await flush()
    expect(fake.sent[0]?.params).toEqual({ accept: true, promptText: 'default' })
    expect(page.pendingDialog()).toBeUndefined()
    expect(page.recentDialogs()[0]?.answered).toBe('auto-accepted')
    expect(page.getDialogPolicy()).toEqual({ action: 'accept', promptText: undefined })

    page.setDialogPolicy({ action: 'accept', promptText: 'fixed' })
    fake.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'default' }), SESSION)
    await flush()
    expect(fake.sent[1]?.params).toEqual({ accept: true, promptText: 'fixed' })

    page.setDialogPolicy({ action: 'dismiss' })
    fake.emit(OPENING_EVENT, opening(), SESSION)
    await flush()
    expect(fake.sent[2]?.params).toEqual({ accept: false })
    // History is oldest first — the dismiss is the newest row.
    expect(page.recentDialogs().at(-1)?.answered).toBe('auto-dismissed')
  })

  it('keeps the record pending when the auto-answer fails and still notifies waiters', async () => {
    const fake = makeConnection()
    fake.fail('Page.handleJavaScriptDialog', new Error('page closed it first'))
    const page = new PageSession(fake.connection, SESSION)
    const seen: DialogRecord[] = []
    page.onDialogOpened(record => { seen.push(record) })

    page.setDialogPolicy({ action: 'accept' })
    fake.emit(OPENING_EVENT, opening(), SESSION)
    await flush()
    expect(seen).toHaveLength(1)
    expect(page.pendingDialog()).toBeDefined()
  })

  it('marks an externally closed dialog and notifies waiters only while subscribed', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)
    const seen: DialogRecord[] = []
    const off = page.onDialogOpened(record => { seen.push(record) })

    fake.emit(OPENING_EVENT, opening(), SESSION)
    expect(seen).toHaveLength(1)
    fake.emit(CLOSING_EVENT, {}, SESSION)
    expect(page.pendingDialog()).toBeUndefined()
    expect(page.recentDialogs()[0]?.answered).toBe('closed-externally')

    off()
    fake.emit(OPENING_EVENT, opening(), SESSION)
    expect(seen).toHaveLength(1)
    expect(page.pendingDialog()).toBeDefined()
  })

  it('caps the history ring at MAX_DIALOG_HISTORY while draining each auto-answer', async () => {
    const fake = makeConnection()
    fake.reply('Page.handleJavaScriptDialog', {})
    const page = new PageSession(fake.connection, SESSION)
    page.setDialogPolicy({ action: 'accept' })

    for (let i = 0; i < MAX_DIALOG_HISTORY + 5; i += 1) {
      fake.emit(OPENING_EVENT, opening({ message: `m${String(i)}` }), SESSION)
    }
    await flush()
    expect(page.recentDialogs()).toHaveLength(MAX_DIALOG_HISTORY)
    expect(page.pendingDialog()).toBeUndefined()
    expect(page.recentDialogs().every(entry => entry.answered === 'auto-accepted')).toBe(true)
  })

  it('refuses dialog reads and answers after the session closed', async () => {
    const fake = makeConnection()
    fake.reply('Page.handleJavaScriptDialog', {})
    const page = new PageSession(fake.connection, SESSION)
    fake.emit(OPENING_EVENT, opening(), SESSION)
    expect(page.pendingDialog()).toBeDefined()

    fake.reply('Target.detachFromTarget', {})
    await page.close()
    expect(page.pendingDialog()).toBeUndefined()
    await expect(page.answerDialog(true)).rejects.toBeInstanceOf(CdpSessionClosedError)
  })
})

describe('plan05: PageSession file chooser staging', () => {
  it('returns a staged chooser immediately and times out the next wait', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.emit(CHOOSER_EVENT, { mode: 'select', backendNodeId: 7, frameId: 'frame-1' }, SESSION)
    await expect(page.awaitFileChooser(50)).resolves.toMatchObject({ mode: 'select', backendNodeId: 7, frameId: 'frame-1' })
    await expect(page.awaitFileChooser(30)).rejects.toBeInstanceOf(CdpTimeoutError)
  })

  it('stages only from the owning session', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.emit(CHOOSER_EVENT, { mode: 'select', backendNodeId: 7, frameId: 'f' }, 'other-session')
    await expect(page.awaitFileChooser(30)).rejects.toBeInstanceOf(CdpTimeoutError)
  })
})
