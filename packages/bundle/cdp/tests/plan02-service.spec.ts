/**
 * Plan 02 wave 1 service tests: `readText` and `expectCheck` envelopes through
 * the fake-session seam (no browser), the polling behaviour of their wait
 * budgets, the URL fallback for failed replies, and the best-effort evidence
 * helpers behind `cdp_click`/`cdp_type`. Infrastructure failures (no session)
 * still reject — only locator failures stay in-band.
 */

import { describe, expect, it } from 'vitest'
import { CdpService } from '../src/service.ts'
import type { PageEvaluation } from '../src/page.ts'

interface EvaluateCall {
  expression: string
  options: { awaitPromise?: boolean | undefined, timeoutMs?: number | undefined } | undefined
}

interface Seamed {
  getPageSession: (targetId?: string) => Promise<unknown>
}

/** Build a clean page evaluation carrying a JSON payload (or a raw string). */
function evaluation(payload: unknown): PageEvaluation {
  return {
    value: typeof payload === 'string' ? payload : JSON.stringify(payload),
    truncated: false,
    exception: undefined,
    hasValue: true,
    valueType: 'string',
  }
}

/**
 * A CdpService whose session seam answers from a reply queue; the last reply
 * repeats once the queue drains, and every evaluate call is recorded.
 */
function serviceWithReplies(
  replies: PageEvaluation[],
  pageUrl = 'https://example.com/page',
): { service: CdpService, calls: EvaluateCall[] } {
  const service = new CdpService()
  const calls: EvaluateCall[] = []
  let index = 0
  const seams = service as unknown as Seamed
  seams.getPageSession = async () => ({
    sessionId: 'sess-plan02',
    evaluate: async (expression: string, options?: EvaluateCall['options']) => {
      calls.push({ expression, options })
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (reply === undefined) throw new Error('fake session: no reply queued')
      return reply
    },
    url: async () => pageUrl,
  })
  return { service, calls }
}

const TARGET = {
  index: 0,
  tag: 'button',
  role: 'button',
  name: 'Gönder',
  ariaLabel: 'Gönder',
  id: 'send',
  rect: { x: 10, y: 20, width: 120, height: 32 },
  visible: true,
  enabled: true,
  inViewport: true,
  text: 'Gönder (Ctrl-Enter)',
  textLength: 18,
}

const ACTIONABLE = {
  attached: true,
  visible: true,
  stable: true,
  enabled: true,
  inViewport: true,
  hitTarget: true,
  failures: [] as string[],
}

function successReply(overrides: Record<string, unknown> = {}): PageEvaluation {
  return evaluation({
    ok: true,
    found: true,
    matched: 1,
    strategy: 'css',
    candidates: [],
    url: 'https://example.com/form',
    target: TARGET,
    actionability: ACTIONABLE,
    ...overrides,
  })
}

describe('plan02: service.readText', () => {
  it('returns the visible text with full evidence and awaits the page promise', async () => {
    const { service, calls } = serviceWithReplies([successReply()])
    const outcome = await service.readText({ css: '#send' })
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toBe('Gönder (Ctrl-Enter)')
    expect(outcome.truncated).toBe(false)
    expect(outcome.matched).toBe(1)
    expect(outcome.strategy).toBe('css')
    expect(outcome.target?.tag).toBe('button')
    expect(outcome.actionability?.visible).toBe(true)
    expect(outcome.url).toBe('https://example.com/form')
    expect(outcome.targetId).toBe('')
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.awaitPromise).toBe(true)
    expect(calls[0]?.expression).toContain('const spec = {"css":"#send"}')
  })

  it('reports not-found in-band with the ladder reason and reads the URL fallback', async () => {
    const { service } = serviceWithReplies([evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'text',
      candidates: [],
      url: '',
      reason: 'not found (strategy ladder exhausted: aria-label -> role+name -> tag+text -> innerText)',
    })], 'https://example.com/fallback')
    const outcome = await service.readText({ text: 'Kaydet' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('strategy ladder exhausted')
    expect(outcome.matched).toBe(0)
    expect(outcome.candidates).toEqual([])
    expect(outcome.url).toBe('https://example.com/fallback')
  })

  it('fails a resolved-but-hidden element instead of returning its innerText', async () => {
    const { service } = serviceWithReplies([successReply({
      actionability: {
        ...ACTIONABLE,
        visible: false,
        hitTarget: false,
        failures: ['not visible: no layout box or hidden by display/visibility/opacity'],
      },
    })])
    const outcome = await service.readText({ css: '#send' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('is not visible')
    expect(outcome.text).toBeUndefined()
    expect(outcome.target).toBeDefined()
  })

  it('polls until the element shows up within the budget', async () => {
    const { service, calls } = serviceWithReplies([
      evaluation({ ok: false, found: false, matched: 0, strategy: 'css', candidates: [], url: 'https://example.com/', reason: 'not found (css matched 0 candidates)' }),
      successReply(),
    ])
    const outcome = await service.readText({ css: '#send' }, { timeoutMs: 500 })
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toBe('Gönder (Ctrl-Enter)')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  }, 5_000)

  it('stops at the budget with a timed-out reason', async () => {
    const { service, calls } = serviceWithReplies([
      evaluation({ ok: false, found: false, matched: 0, strategy: 'css', candidates: [], url: 'https://example.com/', reason: 'not found (css matched 0 candidates)' }),
    ])
    const outcome = await service.readText({ css: '#send' }, { timeoutMs: 150 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('not found (css matched 0 candidates)')
    expect(outcome.reason).toContain('timed out after')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  }, 5_000)

  it('keeps an ambiguous resolution as a failure with candidate evidence', async () => {
    const { service } = serviceWithReplies([evaluation({
      ok: false,
      found: true,
      matched: 2,
      strategy: 'text',
      candidates: [
        { index: 0, tag: 'button', role: 'button', name: 'Kaydet', ariaLabel: '', id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true, enabled: true, inViewport: true },
        { index: 1, tag: 'a', role: 'link', name: 'Kaydet', ariaLabel: '', id: 'b', rect: { x: 0, y: 20, width: 10, height: 10 }, visible: true, enabled: true, inViewport: true },
      ],
      url: 'https://example.com/',
      reason: 'ambiguous: 2 candidates',
      hint: 'pass nth or narrow with scope/ariaLabel',
    })])
    const outcome = await service.readText({ text: 'Kaydet' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('ambiguous: 2 candidates')
    expect(outcome.matched).toBe(2)
    expect(outcome.candidates).toHaveLength(2)
  })

  it('rejects when no session exists — infrastructure errors are not in-band', async () => {
    const service = new CdpService()
    await expect(service.readText({ css: '#send' })).rejects.toThrow()
  })
})

describe('plan02: service.expectCheck', () => {
  it('passes exists on a clean resolution', async () => {
    const { service, calls } = serviceWithReplies([successReply()])
    const outcome = await service.expectCheck({ check: 'exists', spec: { css: '#send' } })
    expect(outcome.ok).toBe(true)
    expect(outcome.passed).toBe(true)
    expect(outcome.check).toBe('exists')
    expect(outcome.actual).toBe('1 candidate(s)')
    expect(outcome.matched).toBe(1)
    expect(calls[0]?.expression).toContain('const spec = {"css":"#send"}')
  })

  it('fails visible in-band when the element is hidden', async () => {
    const { service } = serviceWithReplies([successReply({
      actionability: {
        ...ACTIONABLE,
        visible: false,
        hitTarget: false,
        failures: ['not visible: no layout box or hidden by display/visibility/opacity'],
      },
    })])
    const outcome = await service.expectCheck({ check: 'visible', spec: { css: '#send' } })
    expect(outcome.ok).toBe(false)
    expect(outcome.passed).toBe(false)
    expect(outcome.reason).toContain('is not visible')
    expect(outcome.actual).toBe('not visible')
  })

  it('urlMatches runs URL-only and ignores any locator', async () => {
    const { service, calls } = serviceWithReplies([evaluation({
      ok: true,
      found: false,
      matched: 0,
      strategy: 'none',
      candidates: [],
      url: 'https://example.com/dashboard',
    })])
    const outcome = await service.expectCheck({
      check: 'urlMatches',
      spec: { css: '#ignored' },
      expected: '^https://example\\.com/dashboard',
    })
    expect(outcome.passed).toBe(true)
    expect(outcome.actual).toBe('https://example.com/dashboard')
    expect(calls[0]?.expression).toContain('const spec = null')
  })

  it('urlMatches failure carries the actual URL and the pattern', async () => {
    const { service } = serviceWithReplies([evaluation({
      ok: true,
      found: false,
      matched: 0,
      strategy: 'none',
      candidates: [],
      url: 'https://example.com/',
    })])
    const outcome = await service.expectCheck({ check: 'urlMatches', expected: '^https://other\\.com/' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('url does not match')
    expect(outcome.actual).toBe('https://example.com/')
  })

  it('textEquals normalizes a dirty expected against the clean target text', async () => {
    const { service } = serviceWithReplies([successReply()])
    const outcome = await service.expectCheck({
      check: 'textEquals',
      spec: { css: '#send' },
      expected: 'Gönder ‪(Ctrl-Enter)‬',
    })
    expect(outcome.passed).toBe(true)
    expect(outcome.expected).toBeDefined()
    expect(outcome.actual).toBe('Gönder (Ctrl-Enter)')
  })

  it('textContains reports the actual text on mismatch', async () => {
    const { service } = serviceWithReplies([successReply()])
    const outcome = await service.expectCheck({
      check: 'textContains',
      spec: { css: '#send' },
      expected: 'Vazgeç',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.actual).toBe('Gönder (Ctrl-Enter)')
    expect(outcome.reason).toContain('does not contain')
  })

  it('exists failure keeps the page reason', async () => {
    const { service } = serviceWithReplies([evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'aria-label',
      candidates: [],
      url: 'https://example.com/',
      reason: 'not found (aria-label matched 0 candidates)',
    })])
    const outcome = await service.expectCheck({ check: 'exists', spec: { ariaLabel: 'Kapat' } })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('aria-label matched 0')
  })
})

describe('plan02: service evidence helpers', () => {
  it('describePoint returns target, URL, and the hit description', async () => {
    const { service } = serviceWithReplies([evaluation({
      url: 'https://example.com/',
      hit: { tag: 'button', role: 'button', name: 'Kaydet' },
    })])
    const evidence = await service.describePoint(100, 200, 'TARGET-9')
    expect(evidence).toEqual({
      targetId: 'TARGET-9',
      url: 'https://example.com/',
      hit: { tag: 'button', role: 'button', name: 'Kaydet' },
    })
  })

  it('describePoint omits the hit when nothing is under the point', async () => {
    const { service } = serviceWithReplies([evaluation({ url: 'https://example.com/' })])
    const evidence = await service.describePoint(1, 2)
    expect(evidence).toEqual({ targetId: '', url: 'https://example.com/' })
    expect(evidence?.hit).toBeUndefined()
  })

  it('describePoint returns undefined for evaluation errors and junk', async () => {
    const errored = new CdpService()
    ;(errored as unknown as Seamed).getPageSession = async () => ({
      evaluate: async (): Promise<PageEvaluation> => ({
        value: '',
        truncated: false,
        exception: 'boom',
        hasValue: false,
        valueType: 'undefined',
        error: { kind: 'exception', message: 'ReferenceError: x is not defined' },
      }),
      url: async () => 'https://example.com/',
    })
    expect(await errored.describePoint(1, 1)).toBeUndefined()

    const junk = await serviceWithReplies([evaluation('not json at all')]).service.describePoint(1, 1)
    expect(junk).toBeUndefined()
  })

  it('describeFocus reports the active element, or just the URL', async () => {
    const withFocus = await serviceWithReplies([evaluation({
      url: 'https://example.com/form',
      focused: { tag: 'input', role: 'textbox', name: 'E-posta' },
    })]).service.describeFocus('TARGET-3')
    expect(withFocus).toEqual({
      targetId: 'TARGET-3',
      url: 'https://example.com/form',
      focused: { tag: 'input', role: 'textbox', name: 'E-posta' },
    })

    const noFocus = await serviceWithReplies([evaluation({ url: 'https://example.com/' })]).service.describeFocus()
    expect(noFocus).toEqual({ targetId: '', url: 'https://example.com/' })
    expect(noFocus?.focused).toBeUndefined()
  })
})

describe('plan02 wave 2: service.resolveForAction (cdp_click locator mode)', () => {
  it('returns the rect centre as the click point with full evidence', async () => {
    const { service, calls } = serviceWithReplies([successReply()])
    const resolution = await service.resolveForAction({ css: '#send' })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('expected a successful resolution')
    // rect { x:10, y:20, width:120, height:32 } → centre (70, 36), rounded.
    expect(resolution.point).toEqual({ x: 70, y: 36 })
    expect(resolution.matched).toBe(1)
    expect(resolution.strategy).toBe('css')
    expect(resolution.target.tag).toBe('button')
    expect(resolution.actionability.visible).toBe(true)
    expect(resolution.targetId).toBe('')
    expect(resolution.url).toBe('https://example.com/form')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.expression).toContain('const spec = {"css":"#send"}')
    expect(calls[0]?.options?.awaitPromise).toBe(true)
  })

  it('refuses a resolved-but-not-clickable target with the failing axes', async () => {
    const { service } = serviceWithReplies([successReply({
      actionability: { ...ACTIONABLE, visible: false, failures: ['not visible', 'hit-target blocked by overlay'] },
    })])
    const resolution = await service.resolveForAction({ css: '#send' }, undefined, 0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('not clickable: not visible; hit-target blocked by overlay')
    expect(resolution.candidates).toEqual([])
  })

  it('keeps the not-found reason with a zero budget (single attempt)', async () => {
    const { service, calls } = serviceWithReplies([evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      reason: 'not found (css matched 0 candidates)',
    })])
    const resolution = await service.resolveForAction({ css: '#ghost' }, undefined, 0)
    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('not found (css matched 0 candidates)')
    expect(calls).toHaveLength(1)
  })

  it('polls until the target becomes clickable (timeoutMs budget)', async () => {
    const { service, calls } = serviceWithReplies([
      successReply({ actionability: { ...ACTIONABLE, failures: ['banner overlay covers the point'] } }),
      successReply(),
    ])
    const resolution = await service.resolveForAction({ css: '#send' }, undefined, 600)
    expect(resolution.ok).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('plan02-fix F1: service.click activates the target and proves delivery', () => {
  interface SendCall {
    method: string
    params: Record<string, unknown>
    sessionId?: string | undefined
  }

  /**
   * The session seam plus a recording connection: evaluate answers [arm,
   * read] while Input.* and Target.* sends are captured in order.
   */
  function clickService(replies: PageEvaluation[]): { service: CdpService, calls: EvaluateCall[], sends: SendCall[] } {
    const { service, calls } = serviceWithReplies(replies)
    const sends: SendCall[] = []
    const seams = service as unknown as Seamed & {
      connection: { send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown> }
    }
    seams.connection = {
      send: async (method, params, sessionId) => {
        sends.push({ method, params, sessionId })
        return {}
      },
    }
    return { service, calls, sends }
  }

  it('activates the target before dispatch and reports delivered:true when a click event lands', async () => {
    const { service, calls, sends } = clickService([
      evaluation({ ok: true }), // arm
      evaluation({ n: 1 }), // read
    ])
    const outcome = await service.click({ x: 70, y: 36 }, 'TARGET-7')
    expect(outcome).toEqual({ delivered: true })

    // Browser-level activation happens BEFORE any input is dispatched —
    // a background/hidden target drops raw input at (0,0) or entirely.
    const activateIndex = sends.findIndex(s => s.method === 'Target.activateTarget')
    const mouseIndex = sends.findIndex(s => s.method === 'Input.dispatchMouseEvent')
    expect(activateIndex).toBeGreaterThanOrEqual(0)
    expect(sends[activateIndex]?.params).toEqual({ targetId: 'TARGET-7' })
    expect(mouseIndex).toBeGreaterThan(activateIndex)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.expression).toContain('__dshClickProbe')
    expect(calls[1]?.expression).toContain('__dshClickProbe')
  })

  it('reports delivered:false when the page saw no click event (hidden target)', async () => {
    const { service, sends } = clickService([
      evaluation({ ok: true }),
      evaluation({ n: 0 }),
    ])
    const outcome = await service.click({ x: 70, y: 36 })
    expect(outcome).toEqual({ delivered: false })
    expect(sends.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(true)
  })

  it('degrades to an empty envelope when the probe could not arm (best-effort)', async () => {
    const { service, calls } = clickService([evaluation({ ok: false })])
    const outcome = await service.click({ x: 10, y: 10 })
    expect(outcome).toEqual({})
    expect(calls).toHaveLength(1) // arm only — no read after a failed arm
  })

  it('readViewport reports the page-side size, or undefined on junk', async () => {
    const ok = await serviceWithReplies([evaluation({ width: 400, height: 700 })]).service.readViewport('T1')
    expect(ok).toEqual({ width: 400, height: 700 })

    const junk = await serviceWithReplies([evaluation('not json')]).service.readViewport()
    expect(junk).toBeUndefined()
  })
})
