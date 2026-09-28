/**
 * Plan 02 wave 2 (§4.7) wait tests: argument validation and plans for all
 * seven strategies, `runWait` dispatch through the seam (pass + in-band
 * timeout + legacy css byte-compat), the network-idle counter with its
 * enable/disable + disposer contract, and the renderer lines.
 */

import { describe, expect, it } from 'vitest'
import { CdpTimeoutError } from '../src/page.ts'
import { CdpService } from '../src/service.ts'
import {
  WAIT_DEFAULT_IDLE_MS,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_STRATEGIES,
  renderWait,
  runWait,
  validateWaitArgs,
  waitPlan,
  waitForNetworkIdle,
  waitForUrlPattern,
  type NetworkIdleEvent,
  type WaitSeam,
} from '../src/waits.ts'

/** A seam whose calls are recorded; per-method behaviour is overridable. */
function loggedSeam(overrides: Partial<WaitSeam> = {}): {
  seam: WaitSeam
  selectorCalls: Array<{ selector: string, timeoutMs: number }>
  loadCalls: number[]
  expectCalls: Array<{ check: string, spec: unknown, timeoutMs: number }>
  networkCalls: Array<{ timeoutMs: number, idleMs: number }>
} {
  const selectorCalls: Array<{ selector: string, timeoutMs: number }> = []
  const loadCalls: number[] = []
  const expectCalls: Array<{ check: string, spec: unknown, timeoutMs: number }> = []
  const networkCalls: Array<{ timeoutMs: number, idleMs: number }> = []
  const seam: WaitSeam = {
    waitForSelector: async (selector, timeoutMs) => { selectorCalls.push({ selector, timeoutMs }) },
    waitForLoad: async (timeoutMs) => { loadCalls.push(timeoutMs) },
    currentUrl: async () => 'https://example.com/next',
    expectCheck: async (check, spec, timeoutMs) => {
      expectCalls.push({ check, spec, timeoutMs })
      return { passed: true, url: 'https://example.com/ok' }
    },
    networkIdle: async (timeoutMs, idleMs) => {
      networkCalls.push({ timeoutMs, idleMs })
      return { ok: true, timedOut: false, waitedMs: 7 }
    },
    ...overrides,
  }
  return { seam, selectorCalls, loadCalls, expectCalls, networkCalls }
}

describe('plan02: validateWaitArgs', () => {
  it('defaults to css and accepts every strategy with its required value', () => {
    expect(validateWaitArgs({ selector: '#ready' })).toBeUndefined()
    expect(validateWaitArgs({ selector: '#ready', strategy: 'css' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'aria-label', selector: 'Kapat' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'text', selector: 'Gönder' })).toBeUndefined()
    // §4.7 contract: text runs standalone on text (+ textMatch), no selector.
    expect(validateWaitArgs({ strategy: 'text', text: 'Gönderildi' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'text', text: 'Gönderildi', textMatch: 'contains' })).toBeUndefined()
    // A bare `text` argument implies the text strategy.
    expect(validateWaitArgs({ text: 'Gönderildi' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'visible', selector: '#compose' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'network-idle' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'navigation' })).toBeUndefined()
    expect(validateWaitArgs({ strategy: 'url', url: '^https://.+/done$' })).toBeUndefined()
    // The url strategy may borrow the selector slot for its pattern.
    expect(validateWaitArgs({ strategy: 'url', selector: '/done$' })).toBeUndefined()
    for (const strategy of WAIT_STRATEGIES) expect(strategy).toBeTruthy()
  })

  it('reports unknown strategies, missing values, bad regexes, and bad idleMs in-band', () => {
    expect(validateWaitArgs({ strategy: 'until-forever' })).toContain('unknown wait strategy')
    expect(validateWaitArgs({})).toBe('strategy css requires selector')
    expect(validateWaitArgs({ strategy: 'visible' })).toBe('strategy visible requires selector')
    expect(validateWaitArgs({ strategy: 'aria-label', selector: '  ' })).toBe('strategy aria-label requires selector')
    expect(validateWaitArgs({ strategy: 'text' })).toBe('strategy text requires text (or selector for back-compat)')
    expect(validateWaitArgs({ strategy: 'text', text: 'x', textMatch: 'fuzzy' })).toBe('textMatch must be "exact" or "contains"')
    expect(validateWaitArgs({ strategy: 'url' })).toContain('requires a pattern')
    expect(validateWaitArgs({ strategy: 'url', url: '([' })).toContain('invalid url regular expression')
    expect(validateWaitArgs({ strategy: 'network-idle', idleMs: -1 })).toBe('idleMs must be a non-negative number')
  })
})

describe('plan02: waitPlan', () => {
  it('keeps the legacy css contract: raw caller timeout (default 10000), no clamping', () => {
    const legacy = waitPlan({ selector: '#ready' })
    expect(legacy).toMatchObject({ strategy: 'css', selector: '#ready', timeoutMs: WAIT_DEFAULT_TIMEOUT_MS })
    expect(WAIT_DEFAULT_TIMEOUT_MS).toBe(10_000)
    // The raw passthrough matters: legacy cdp_wait handed the caller's number
    // straight to waitForSelector, so a 99999 budget must stay 99999.
    expect(waitPlan({ selector: '#ready', timeoutMs: 99_999 }).timeoutMs).toBe(99_999)
  })

  it('clamps the locator-backed strategies into the 30s budget', () => {
    const plan = waitPlan({ strategy: 'visible', selector: '#compose', timeoutMs: 99_999 })
    expect(plan.timeoutMs).toBe(30_000)
    expect(plan.idleMs).toBe(WAIT_DEFAULT_IDLE_MS)
    expect(waitPlan({ strategy: 'network-idle', idleMs: 1_500 }).idleMs).toBe(1_500)
    expect(waitPlan({ strategy: 'url', url: 'x$' }).urlPattern).toBe('x$')
    expect(waitPlan({ strategy: 'navigation', timeoutMs: 0 }).timeoutMs).toBe(0)
  })

  it('carries text + textMatch without a selector key (strategy=text)', () => {
    const plan = waitPlan({ strategy: 'text', text: 'Gönderildi', textMatch: 'contains', timeoutMs: 5_000 })
    expect(plan).toMatchObject({ strategy: 'text', text: 'Gönderildi', textMatch: 'contains', timeoutMs: 5_000 })
    expect(plan.selector).toBeUndefined()
    // Bare `text` resolves to the text strategy; the legacy selector slot keeps carrying the value.
    expect(waitPlan({ text: 'Bitti' })).toMatchObject({ strategy: 'text', text: 'Bitti' })
    expect(waitPlan({ strategy: 'text', selector: 'Gönder' })).toMatchObject({ strategy: 'text', text: 'Gönder', selector: 'Gönder' })
  })
})

describe('plan02: runWait dispatch through the seam', () => {
  it('css: passes through waitForSelector verbatim and reports the wait', async () => {
    const { seam, selectorCalls } = loggedSeam()
    const outcome = await runWait(seam, waitPlan({ selector: '#ready' }))
    expect(outcome).toMatchObject({ ok: true, action: 'wait', strategy: 'css', selector: '#ready', timedOut: false, url: 'https://example.com/next' })
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0)
    expect(selectorCalls).toEqual([{ selector: '#ready', timeoutMs: 10_000 }])
    expect(renderWait(outcome)).toBe('Selector "#ready" is now present.')
  })

  it('css: converts CdpTimeoutError to an in-band timeout envelope', async () => {
    const { seam } = loggedSeam({
      waitForSelector: async () => { throw new CdpTimeoutError('selector #slow', 40) },
    })
    const outcome = await runWait(seam, waitPlan({ selector: '#slow' }))
    expect(outcome.ok).toBe(false)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.strategy).toBe('css')
    expect(outcome.selector).toBe('#slow')
    expect(outcome.reason).toBe('timed out after 10000ms waiting for css: #slow')
    expect(renderWait(outcome)).toContain('Wait FAILED after')
    expect(renderWait(outcome)).toContain('timed out after 10000ms')
  })

  it('css: lets infrastructure errors (non-timeout) propagate', async () => {
    const { seam } = loggedSeam({
      waitForSelector: async () => { throw new Error('session closed') },
    })
    await expect(runWait(seam, waitPlan({ selector: '#x' }))).rejects.toThrow('session closed')
  })

  it('navigation: waits for the load event and reports timeouts in-band', async () => {
    const pass = loggedSeam()
    const ok = await runWait(pass.seam, waitPlan({ strategy: 'navigation', timeoutMs: 2_000 }))
    expect(ok.ok).toBe(true)
    expect(pass.loadCalls).toEqual([2_000])

    const failing = loggedSeam({
      waitForLoad: async () => { throw new CdpTimeoutError('Page.loadEventFired', 50) },
    })
    const timedOut = await runWait(failing.seam, waitPlan({ strategy: 'navigation', timeoutMs: 50 }))
    expect(timedOut).toMatchObject({ ok: false, timedOut: true, strategy: 'navigation' })
    expect(timedOut.reason).toBe('timed out after 50ms waiting for navigation')
  })

  it('url: matches the polled page URL and times out with the pattern + actual', async () => {
    const match = loggedSeam()
    const ok = await runWait(match.seam, waitPlan({ strategy: 'url', url: 'example\\.com/next' }))
    expect(ok).toMatchObject({ ok: true, timedOut: false, url: 'https://example.com/next' })

    const miss = loggedSeam()
    const timedOut = await runWait(miss.seam, waitPlan({ strategy: 'url', url: '/done$', timeoutMs: 0 }))
    expect(timedOut.ok).toBe(false)
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.reason).toContain('/done$')
    expect(timedOut.reason).toContain('https://example.com/next')
  })

  it('aria-label / text / visible map onto expectCheck with the right check + spec', async () => {
    const aria = loggedSeam()
    const ariaOutcome = await runWait(aria.seam, waitPlan({ strategy: 'aria-label', selector: 'Kapat', timeoutMs: 1_500 }))
    expect(ariaOutcome.ok).toBe(true)
    expect(aria.expectCalls).toEqual([{ check: 'exists', spec: { ariaLabel: 'Kapat' }, timeoutMs: 1_500 }])

    const text = loggedSeam()
    await runWait(text.seam, waitPlan({ strategy: 'text', selector: 'Gönder' }))
    expect(text.expectCalls).toEqual([{ check: 'visible', spec: { text: 'Gönder' }, timeoutMs: 10_000 }])

    const visible = loggedSeam()
    const visibleOutcome = await runWait(visible.seam, waitPlan({ strategy: 'visible', selector: '#compose' }))
    expect(visibleOutcome).toMatchObject({ ok: true, strategy: 'visible', url: 'https://example.com/ok' })
    expect(visible.expectCalls).toEqual([{ check: 'visible', spec: { css: '#compose' }, timeoutMs: 10_000 }])

    const failing = loggedSeam({
      expectCheck: async () => ({ passed: false, reason: 'element resolved but is not visible', url: 'https://example.com/ok' }),
    })
    const failed = await runWait(failing.seam, waitPlan({ strategy: 'visible', selector: '#compose' }))
    expect(failed).toMatchObject({ ok: false, timedOut: true, reason: 'element resolved but is not visible' })
    expect(failed.strategy).toBe('visible')
  })

  it('aria-label failure without a reason still explains the timeout', async () => {
    const failing = loggedSeam({ expectCheck: async () => ({ passed: false }) })
    const failed = await runWait(failing.seam, waitPlan({ strategy: 'aria-label', selector: 'Kapat', timeoutMs: 900 }))
    expect(failed.ok).toBe(false)
    expect(failed.reason).toBe('timed out after 900ms waiting for aria-label: Kapat')
  })

  it('text: runs standalone on text + textMatch — passes when found, in-band timeout naming the text when not', async () => {
    const pass = loggedSeam()
    const ok = await runWait(pass.seam, waitPlan({ strategy: 'text', text: 'Gönderildi', textMatch: 'contains', timeoutMs: 5_000 }))
    expect(ok).toMatchObject({ ok: true, strategy: 'text', text: 'Gönderildi', timedOut: false })
    expect(pass.expectCalls).toEqual([
      { check: 'visible', spec: { text: 'Gönderildi', textMatch: 'contains' }, timeoutMs: 5_000 },
    ])

    const miss = loggedSeam({ expectCheck: async () => ({ passed: false }) })
    const timedOut = await runWait(miss.seam, waitPlan({ strategy: 'text', text: 'Kaydedildi', textMatch: 'contains', timeoutMs: 700 }))
    expect(timedOut.ok).toBe(false)
    expect(timedOut.timedOut).toBe(true)
    // The reason names the EXPECTED text and the comparison mode…
    expect(timedOut.reason).toContain('waiting for text "Kaydedildi"')
    expect(timedOut.reason).toContain('(contains)')
    expect(renderWait(timedOut)).toContain('strategy=text')
  })

  it('network-idle: forwards idleMs, passes through the runner result + reason', async () => {
    const ok = loggedSeam()
    const good = await runWait(ok.seam, waitPlan({ strategy: 'network-idle', idleMs: 750, timeoutMs: 4_000 }))
    expect(good).toMatchObject({ ok: true, timedOut: false })
    expect(ok.networkCalls).toEqual([{ timeoutMs: 4_000, idleMs: 750 }])

    const failing = loggedSeam({
      networkIdle: async () => ({ ok: false, timedOut: true, waitedMs: 3_000, reason: 'timed out after 3000ms waiting for network-idle (2 request(s) still in flight)' }),
    })
    const bad = await runWait(failing.seam, waitPlan({ strategy: 'network-idle' }))
    expect(bad.ok).toBe(false)
    expect(bad.timedOut).toBe(true)
    expect(bad.reason).toContain('network-idle')
  })
})

describe('plan02: waitForUrlPattern', () => {
  it('polls until the pattern matches', async () => {
    const urls = ['about:blank', 'about:blank', 'https://example.com/done']
    const result = await waitForUrlPattern(async () => urls.shift() ?? 'https://example.com/done', '/done$', 2_000, 5)
    expect(result.ok).toBe(true)
    expect(result.actual).toBe('https://example.com/done')
    expect(result.waitedMs).toBeGreaterThanOrEqual(0)
  })

  it('answers an invalid pattern without throwing', async () => {
    const result = await waitForUrlPattern(async () => 'x', '([', 0)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.reason).toContain('invalid url regular expression')
  })

  it('tolerates a failing URL read as an empty string', async () => {
    const result = await waitForUrlPattern(async () => { throw new Error('gone') }, 'example', 0)
    expect(result.ok).toBe(false)
    expect(result.actual).toBe('')
  })
})

describe('plan02: waitForNetworkIdle counters', () => {
  it('passes after a quiet window and always disables + unsubscribes', async () => {
    const sent: string[] = []
    const subscriptions: string[] = []
    let disposed = 0
    const seam = {
      sessionId: 'sess-net',
      send: async (method: string) => { sent.push(method); return {} },
      on: (event: string, _listener: (event: NetworkIdleEvent) => void) => {
        subscriptions.push(event)
        return () => { disposed += 1 }
      },
    }
    // idleMs 0 + zero traffic: the first check already satisfies the quiet window.
    const result = await waitForNetworkIdle(seam, 0, 0)
    expect(result.ok).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(sent).toEqual(['Network.enable', 'Network.disable'])
    expect(subscriptions.sort()).toEqual(['Network.loadingFailed', 'Network.loadingFinished', 'Network.requestWillBeSent'])
    expect(disposed).toBe(3)
  })

  it('times out while traffic is in flight and still cleans up', async () => {
    const sent: string[] = []
    let disposed = 0
    const seam = {
      sessionId: 'sess-net',
      send: async (method: string) => { sent.push(method); return {} },
      on: (event: string, listener: (event: NetworkIdleEvent) => void) => {
        // Traffic arrives as soon as it is subscribed and never finishes.
        if (event === 'Network.requestWillBeSent') listener({ method: event, params: {}, sessionId: 'sess-net' })
        return () => { disposed += 1 }
      },
    }
    const result = await waitForNetworkIdle(seam, 0, 0)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.reason).toContain('network-idle (1 request(s) still in flight)')
    expect(sent).toEqual(['Network.enable', 'Network.disable'])
    expect(disposed).toBe(3)
  })

  it('service.waitNetworkIdle binds the connection seam to the session id', async () => {
    const service = new CdpService()
    const sent: string[] = []
    const subscriptions: Array<{ event: string, sessionId: string | undefined }> = []
    const seams = service as unknown as {
      getPageSession: (targetId?: string) => Promise<unknown>
      connection: {
        send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>
        on: (event: string, listener: unknown, sessionId?: string) => () => void
      }
    }
    seams.getPageSession = async () => ({ sessionId: 'sess-wait' })
    seams.connection = {
      send: async (method: string, _params: Record<string, unknown>, sessionId?: string) => {
        sent.push(`${method}@${sessionId ?? ''}`)
        return {}
      },
      on: (event: string, _listener: unknown, sessionId?: string) => {
        subscriptions.push({ event, sessionId })
        return () => {}
      },
    }
    const result = await service.waitNetworkIdle(0, 0)
    expect(result.ok).toBe(true)
    expect(sent).toEqual(['Network.enable@sess-wait', 'Network.disable@sess-wait'])
    expect(subscriptions.every(entry => entry.sessionId === 'sess-wait')).toBe(true)
    expect(subscriptions).toHaveLength(3)
  })
})

describe('plan02: renderWait', () => {
  it('keeps the legacy css success line verbatim', () => {
    expect(renderWait({ ok: true, strategy: 'css', selector: '#ready', waitedMs: 12, timedOut: false })).toBe('Selector "#ready" is now present.')
  })

  it('names the strategy + measured wait on every other success', () => {
    expect(renderWait({ ok: true, strategy: 'visible', selector: '#compose', waitedMs: 812, timedOut: false }))
      .toBe('Waited 812ms: strategy=visible, #compose condition met.')
    expect(renderWait({ ok: true, strategy: 'text', text: 'Gönderildi', waitedMs: 812, timedOut: false }))
      .toBe('Waited 812ms: strategy=text, "Gönderildi" condition met.')
    expect(renderWait({ ok: true, strategy: 'network-idle', waitedMs: 501, timedOut: false }))
      .toContain('Waited 501ms: strategy=network-idle')
  })

  it('leads failures with the honest timeout line', () => {
    const line = renderWait({
      ok: false,
      strategy: 'network-idle',
      waitedMs: 10_000,
      timedOut: true,
      reason: 'timed out after 10000ms waiting for network-idle (3 request(s) still in flight)',
    })
    expect(line).toContain('Wait FAILED after 10000ms (strategy=network-idle)')
    expect(line).toContain('3 request(s) still in flight')
  })
})
