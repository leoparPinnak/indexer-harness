/**
 * `PageSession` behavior over an in-process fake connection: navigation
 * outcomes, the bounded load and selector waits, title/URL reads, bounded
 * evaluation results, and the closed-session refusal. No socket, browser, or
 * port is used; waits stay short so the suite is fast.
 */

import { describe, expect, it } from 'vitest'
import {
  CdpPageError,
  CdpSessionClosedError,
  CdpTimeoutError,
  MAX_EVALUATE_CHARS,
  PageSession,
  type PageConnection,
} from '../src/page.ts'

/** Flattened session every case drives. */
const SESSION = 'session-1'

/** Event a load wait observes. */
const LOAD_EVENT = 'Page.loadEventFired'

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
  answer(method: string, handler: () => unknown): void
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
    answer: (method, handler) => { replies.set(method, () => Promise.resolve(handler())) },
    fail: (method, error) => { replies.set(method, () => Promise.reject(error)) },
    emit: (event, params, sessionId) => {
      for (const listener of listeners.get(event) ?? []) listener(params, sessionId)
    },
  }
}

/**
 * @param value - the value a `Runtime.evaluate` by-value result carries.
 * @returns the minimal successful reply for that value.
 */
function evaluated(value: unknown): unknown {
  return { result: { type: typeof value, value } }
}

describe('PageSession', () => {
  it('navigates the session frame and reports the accepted outcome', async () => {
    const fake = makeConnection()
    fake.reply('Page.navigate', { frameId: 'frame-1' })
    const page = new PageSession(fake.connection, SESSION)

    await expect(page.navigate('https://example.test/')).resolves.toEqual({
      frameId: 'frame-1',
      url: 'https://example.test/',
      errorText: undefined,
    })
    expect(fake.sent).toEqual([
      { method: 'Page.navigate', params: { url: 'https://example.test/' }, sessionId: SESSION },
    ])
  })

  it('reports a navigation the browser refused without rejecting', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.reply('Page.navigate', { frameId: 'frame-1', errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    await expect(page.navigate('https://missing.test/')).resolves.toMatchObject({
      errorText: 'net::ERR_NAME_NOT_RESOLVED',
    })

    fake.reply('Page.navigate', { frameId: 'frame-1', errorText: 7 })
    await expect(page.navigate('https://missing.test/')).resolves.toMatchObject({ errorText: undefined })
  })

  it('refuses a navigate reply without a frame id', async () => {
    for (const value of [undefined, {}, { frameId: '' }, { frameId: 7 }]) {
      const fake = makeConnection()
      fake.reply('Page.navigate', value)
      const page = new PageSession(fake.connection, SESSION)
      await expect(page.navigate('https://example.test/')).rejects.toBeInstanceOf(CdpPageError)
    }
  })

  it('propagates a protocol error from the connection', async () => {
    const fake = makeConnection()
    fake.fail('Page.navigate', new Error('cdp: -32000 target closed'))
    const page = new PageSession(fake.connection, SESSION)
    await expect(page.navigate('https://example.test/')).rejects.toThrow('cdp: -32000 target closed')
  })

  it('resolves the load wait on the session load event', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    const wait = page.waitForLoad(1000)
    fake.emit(LOAD_EVENT, {}, SESSION)
    await expect(wait).resolves.toBeUndefined()
  })

  it('times out the load wait when no load event for the session arrives', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    const wait = page.waitForLoad(40)
    fake.emit(LOAD_EVENT, {}, 'other-session')
    fake.emit(LOAD_EVENT, {}, undefined)
    await expect(wait).rejects.toBeInstanceOf(CdpTimeoutError)
    await expect(wait).rejects.toMatchObject({ condition: LOAD_EVENT, timeoutMs: 40 })
  })

  it('resolves the selector wait once a probe matches', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)
    let probes = 0
    fake.answer('Runtime.evaluate', () => {
      probes += 1
      return evaluated(probes >= 2)
    })

    await expect(page.waitForSelector('.ready', 1000)).resolves.toBeUndefined()
    expect(probes).toBe(2)
    expect(fake.sent[0]).toEqual({
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector(".ready") !== null', returnByValue: true },
      sessionId: SESSION,
    })
  })

  it('times out the selector wait naming the selector', async () => {
    const fake = makeConnection()
    fake.reply('Runtime.evaluate', evaluated(false))
    const page = new PageSession(fake.connection, SESSION)

    await expect(page.waitForSelector('.never', 40)).rejects.toBeInstanceOf(CdpTimeoutError)
    await expect(page.waitForSelector('.never', 40)).rejects.toMatchObject({
      condition: 'selector .never',
      timeoutMs: 40,
    })
    expect(fake.sent.length).toBeGreaterThan(0)
  })

  it('refuses a selector wait whose probe throws', async () => {
    const fake = makeConnection()
    fake.reply('Runtime.evaluate', { exceptionDetails: { text: 'Uncaught' } })
    const page = new PageSession(fake.connection, SESSION)
    await expect(page.waitForSelector('.x', 100)).rejects.toBeInstanceOf(CdpPageError)
  })

  it('returns a bounded serialized evaluation result', async () => {
    const fake = makeConnection()
    fake.reply('Runtime.evaluate', evaluated('plain'))
    const page = new PageSession(fake.connection, SESSION)

    await expect(page.evaluate('1')).resolves.toEqual({ value: 'plain', truncated: false, exception: undefined, hasValue: true, valueType: 'string' })

    fake.reply('Runtime.evaluate', evaluated({ a: 1 }))
    await expect(page.evaluate('1')).resolves.toEqual({ value: '{"a":1}', truncated: false, exception: undefined, hasValue: true, valueType: 'object' })

    fake.reply('Runtime.evaluate', evaluated('x'.repeat(MAX_EVALUATE_CHARS + 1)))
    const cut = await page.evaluate('1')
    expect(cut.value).toHaveLength(MAX_EVALUATE_CHARS)
    expect(cut.truncated).toBe(true)

    fake.reply('Runtime.evaluate', evaluated('x'.repeat(MAX_EVALUATE_CHARS)))
    await expect(page.evaluate('1')).resolves.toMatchObject({ truncated: false })

    fake.reply('Runtime.evaluate', { result: { type: 'undefined' } })
    await expect(page.evaluate('1')).resolves.toEqual({ value: '', truncated: false, exception: undefined, hasValue: false, valueType: 'undefined' })
  })

  it('reports an evaluation exception instead of a value', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.reply('Runtime.evaluate', { exceptionDetails: { exception: { description: 'Error: boom' }, text: 'Uncaught' } })
    await expect(page.evaluate('throw 1')).resolves.toEqual({
      value: '',
      truncated: false,
      exception: 'Error: boom',
      hasValue: false,
      valueType: 'undefined',
      error: { kind: 'exception', name: 'Error', message: 'boom', expression: 'throw 1' },
    })

    fake.reply('Runtime.evaluate', { exceptionDetails: { exception: { description: '' }, text: 'Uncaught' } })
    await expect(page.evaluate('throw 1')).resolves.toMatchObject({ exception: 'Uncaught' })

    fake.reply('Runtime.evaluate', { exceptionDetails: {} })
    await expect(page.evaluate('throw 1')).resolves.toMatchObject({ exception: 'unknown exception' })
  })

  it('refuses an evaluate reply with no result or exception', async () => {
    for (const value of [undefined, 42, { result: 7 }]) {
      const fake = makeConnection()
      fake.reply('Runtime.evaluate', value)
      const page = new PageSession(fake.connection, SESSION)
      await expect(page.evaluate('1')).rejects.toBeInstanceOf(CdpPageError)
    }
  })

  it('reads the title and URL from the document', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)
    fake.answer('Runtime.evaluate', () => evaluated('Example'))

    await expect(page.title()).resolves.toBe('Example')
    fake.answer('Runtime.evaluate', () => evaluated('https://example.test/'))
    await expect(page.url()).resolves.toBe('https://example.test/')
    expect(fake.sent.map(command => command.params.expression)).toEqual(['document.title', 'location.href'])
  })

  it('refuses a title that throws, is not a string, or is unbounded', async () => {
    const fake = makeConnection()
    const page = new PageSession(fake.connection, SESSION)

    fake.reply('Runtime.evaluate', { exceptionDetails: { text: 'Uncaught' } })
    await expect(page.title()).rejects.toBeInstanceOf(CdpPageError)

    fake.reply('Runtime.evaluate', evaluated(42))
    await expect(page.title()).rejects.toBeInstanceOf(CdpPageError)

    fake.reply('Runtime.evaluate', evaluated('y'.repeat(MAX_EVALUATE_CHARS + 1)))
    await expect(page.title()).resolves.toHaveLength(MAX_EVALUATE_CHARS)
  })

  it('refuses every command after close without sending', async () => {
    const fake = makeConnection()
    fake.reply('Runtime.evaluate', evaluated('ok'))
    fake.reply('Page.navigate', { frameId: 'frame-1' })
    fake.reply('Target.detachFromTarget', {})
    const page = new PageSession(fake.connection, SESSION)

    await page.close()
    expect(fake.sent).toEqual([
      { method: 'Target.detachFromTarget', params: { sessionId: SESSION }, sessionId: undefined },
    ])
    const sends = fake.sent.length

    const attempts: Array<() => Promise<unknown>> = [
      () => page.navigate('https://example.test/'),
      () => page.waitForLoad(1000),
      () => page.waitForSelector('.x', 1000),
      () => page.evaluate('1'),
      () => page.title(),
      () => page.url(),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(CdpSessionClosedError)
    }
    expect(fake.sent).toHaveLength(sends)

    await expect(page.close()).resolves.toBeUndefined()
    expect(fake.sent).toHaveLength(sends)
  })

  it('settles a pending load wait when the session closes', async () => {
    const fake = makeConnection()
    fake.reply('Target.detachFromTarget', {})
    const page = new PageSession(fake.connection, SESSION)

    const wait = page.waitForLoad(1000)
    await page.close()
    await expect(wait).rejects.toBeInstanceOf(CdpSessionClosedError)
  })

  it('keeps the session open when the detach command fails', async () => {
    const fake = makeConnection()
    fake.fail('Target.detachFromTarget', new Error('cdp: detach refused'))
    fake.reply('Runtime.evaluate', evaluated('Example'))
    const page = new PageSession(fake.connection, SESSION)

    await expect(page.close()).rejects.toThrow('cdp: detach refused')
    await expect(page.title()).resolves.toBe('Example')
  })
})
