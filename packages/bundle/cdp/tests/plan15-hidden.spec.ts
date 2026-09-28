/**
 * plan15-hidden (defect 2): `cdp_exec` / `cdp_eval` read a single bare
 * `document.hidden` out-of-band, and whenever it came back `true` the timeout
 * message asserted a hard-coded claim:
 *
 *   "... (document.hidden=true — timer throttling possible)"
 *
 * In this environment the page reported `document.hidden === false` the whole
 * time (occlusion is off, so a background tab is never truly hidden), yet the
 * message still asserted `document.hidden=true` — the exact T6-re note: the
 * hidden-tab branches could not be tested because the browser never produced
 * a real hidden tab, so the value either arrived wrong or was replayed stale.
 *
 * A timeout message is a claim about the page's state. A claim that the page
 * itself contradicts is worse than no claim at all: it sends the agent
 * chasing timer throttling that is not happening. So the reading is now
 * CORROBORATED (document.hidden plus the page's own visibilityState, read in
 * one round trip), RE-READ at the instant the timeout is reported rather than
 * replayed from before the run, and the x2 timeout margin follows the same
 * corroborated value — applied silently only when the page genuinely is a
 * hidden tab, and reported through effectiveTimeoutMs when it is.
 */

import { describe, expect, it } from 'vitest'
import { CdpTimeoutError as ConnectionTimeoutError } from '../src/connection.ts'
import { CdpService } from '../src/service.ts'
import {
  hiddenEnvelopeValue,
  PAGE_ACTIVITY_EXPRESSION,
  readPageActivity,
  UNVERIFIED_ACTIVITY,
} from '../src/exec.ts'

interface FakeSession {
  sessionId: string
  url: () => Promise<string>
  evaluate: (expression: string, options?: { timeoutMs?: number, awaitPromise?: boolean }) => Promise<Record<string, unknown>>
}

interface SentCommand {
  readonly method: string
  readonly params?: unknown
  readonly sessionId?: unknown
}

/** One page-activity answer the fake page reports. */
interface ActivityReading {
  readonly hidden?: boolean
  readonly state?: string
  readonly focused?: boolean
}

interface ActivityOptions {
  /**
   * The answer for each successive probe read, in order. The last entry is
   * reused once the list runs out (the pre-run and the report-time read are
   * the two that matter).
   */
  readonly readings: ActivityReading[]
  /** Make every probe read throw, so nothing can be corroborated. */
  readonly refuse?: boolean
}

interface PokeOptions extends ActivityOptions {
  /** Runtime.terminateExecution behavior: acknowledge (default) or refuse. */
  readonly terminate?: 'ok' | 'reject'
}

/** Wire a fake connection/registry/session into a fresh service instance. */
function pokedService(session: FakeSession, options: PokeOptions): { service: CdpService, sent: SentCommand[] } {
  const sent: SentCommand[] = []
  const page = { targetId: 'tab-1', type: 'page', title: 'Home', url: 'https://example.com' }
  const service = new CdpService()
  const poked = service as unknown as {
    connection: unknown
    registry: Record<string, unknown>
    sessions: Map<string, unknown>
  }
  let probeCalls = 0
  poked.connection = {
    endpoint: 'ws://127.0.0.1:9222/test',
    state: 'open',
    send: (method: string, params?: unknown, sessionId?: unknown) => {
      sent.push({ method, params, sessionId })
      if (method === 'Runtime.evaluate') {
        if (options.refuse === true) return Promise.reject(new Error('probe refused'))
        const reading = options.readings[Math.min(probeCalls, options.readings.length - 1)] ?? {}
        probeCalls += 1
        return Promise.resolve({ result: { type: 'object', value: { ...reading } } })
      }
      if (method === 'Runtime.terminateExecution' && options.terminate === 'reject') {
        return Promise.reject(new Error('terminate refused'))
      }
      return Promise.resolve({})
    },
  }
  poked.registry = {
    targets: () => [page],
    active: () => page,
    attachedSession: () => session.sessionId,
    attach: async () => session.sessionId,
    setActive: () => {},
    list: async () => {},
    dispose: () => {},
  }
  poked.sessions = new Map([[session.sessionId, session]])
  return { service, sent }
}

/** A session whose script evaluate always times out on the wire. */
function timingOutSession(): FakeSession {
  return {
    sessionId: 'sess-1',
    url: () => Promise.resolve('https://example.com'),
    evaluate: () => Promise.reject(new ConnectionTimeoutError('Runtime.evaluate', 15000)),
  }
}

/** A session recording every evaluate call; scripts succeed unless forced to time out. */
function recordingSession(script: 'ok' | 'timeout'): {
  session: FakeSession
  calls: Array<{ expression: string, options?: { timeoutMs?: number, awaitPromise?: boolean } | undefined }>
} {
  const calls: Array<{ expression: string, options?: { timeoutMs?: number, awaitPromise?: boolean } | undefined }> = []
  let callIndex = 0
  return {
    session: {
      sessionId: 'sess-1',
      url: () => Promise.resolve('https://example.com'),
      evaluate: (expression, options) => {
        calls.push({ expression, options })
        callIndex += 1
        if (callIndex === 1 && script === 'timeout') {
          return Promise.reject(new ConnectionTimeoutError('Runtime.evaluate', options?.timeoutMs ?? 15000))
        }
        return Promise.resolve({ value: '1', truncated: false, exception: undefined, hasValue: true, valueType: 'number' })
      },
    },
    calls,
  }
}

/** The visible-page reading: not hidden, visible, focused. */
const VISIBLE: ActivityReading = { hidden: false, state: 'visible', focused: true }

/** A genuinely hidden tab: the flag AND the visibility state agree. */
const HIDDEN: ActivityReading = { hidden: true, state: 'hidden', focused: false }

/** A page that says it is hidden while its own visibility state says otherwise. */
const UNCORROBORATED: ActivityReading = { hidden: true, state: 'visible', focused: true }

// ── the corroboration rule, in isolation ────────────────────────────────────

describe('plan15-hidden: readPageActivity corroborates before it claims', () => {
  it('believes a hidden tab only when the visibility state agrees', () => {
    expect(readPageActivity(HIDDEN)).toEqual({ state: 'hidden', visibilityState: 'hidden', focused: false })
    expect(readPageActivity(VISIBLE)).toEqual({ state: 'visible', visibilityState: 'visible', focused: true })
  })

  it('refuses to repeat a lone document.hidden:true as a fact', () => {
    const probe = readPageActivity(UNCORROBORATED)
    expect(probe.state).toBe('unverified')
    expect(probe.visibilityState).toBe('visible')
    expect(hiddenEnvelopeValue(probe)).toBeUndefined()
  })

  it('a hidden flag with no visibility state at all is unverified, never hidden', () => {
    expect(readPageActivity({ hidden: true }).state).toBe('unverified')
    expect(readPageActivity({ hidden: true, focused: false }).state).toBe('unverified')
  })

  it('an answer that is not the probe object is unverified', () => {
    // The exact pre-fix shape: a bare boolean can no longer be believed.
    expect(readPageActivity(true)).toEqual(UNVERIFIED_ACTIVITY)
    expect(readPageActivity(false)).toEqual(UNVERIFIED_ACTIVITY)
    for (const bad of [null, undefined, 'hidden', 7, [], [1, 2], {}]) {
      expect(readPageActivity(bad).state).toBe('unverified')
    }
  })

  it('maps the verdict onto the envelope tri-state', () => {
    expect(hiddenEnvelopeValue(readPageActivity(HIDDEN))).toBe(true)
    expect(hiddenEnvelopeValue(readPageActivity(VISIBLE))).toBe(false)
    expect(hiddenEnvelopeValue(readPageActivity(UNCORROBORATED))).toBeUndefined()
  })

  it('the probe reads all three signals in one round trip, with no backtick', () => {
    expect(PAGE_ACTIVITY_EXPRESSION).not.toContain('`')
    expect(PAGE_ACTIVITY_EXPRESSION).toContain('document.hidden')
    expect(PAGE_ACTIVITY_EXPRESSION).toContain('document.visibilityState')
    expect(PAGE_ACTIVITY_EXPRESSION).toContain('document.hasFocus()')
    // One expression, one Runtime.evaluate — the verdict comes from a single
    // instant instead of a mix of readings taken at different moments.
    expect(PAGE_ACTIVITY_EXPRESSION.match(/document\./g)).toHaveLength(3)
  })
})

// ── the timeout message: the reported bug, end to end ───────────────────────

describe('plan15-hidden: the timeout message never contradicts the page', () => {
  it('a page that is NOT hidden gets no throttling hint', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [VISIBLE] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.kind).toBe('timeout')
    expect(outcome.documentHidden).toBe(false)
    const message = outcome.error?.message ?? ''
    expect(message).not.toContain('throttl')
    expect(message).not.toContain('document.hidden')
  })

  it('a genuinely hidden tab DOES get the hint', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [HIDDEN] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBe(true)
    const message = outcome.error?.message ?? ''
    expect(message).toContain('timer throttling possible')
    expect(message).toContain('document.hidden=true')
    expect(message).toContain('visibilityState=hidden')
  })

  it('the pre-fix sentence is gone: it asserted a fact the page never made', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [HIDDEN] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.error?.message).not.toContain('(document.hidden=true — timer throttling possible)')
  })

  it('an UNCORROBORATED hidden flag produces no hint and no documentHidden', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [UNCORROBORATED] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.kind).toBe('timeout')
    // The tool proves nothing here, so it says nothing: not false, not true.
    expect(outcome.documentHidden).toBeUndefined()
    expect(Object.keys(outcome)).not.toContain('documentHidden')
    const message = outcome.error?.message ?? ''
    expect(message).not.toContain('throttl')
    expect(message).not.toContain('document.hidden')
  })

  it('a stale pre-run hidden is re-read: a tab back in view gets no hint', async () => {
    // The pre-run probe says hidden, the page comes back into view while the
    // script runs, and the timeout fires afterwards. Replaying the first
    // reading is exactly the false claim this fixes.
    const { service, sent } = pokedService(timingOutSession(), { readings: [HIDDEN, VISIBLE] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBe(false)
    const message = outcome.error?.message ?? ''
    expect(message).not.toContain('throttl')
    expect(message).not.toContain('document.hidden')
    // Two probe reads: one before the run, one at report time.
    expect(sent.filter(command => command.method === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('a tab that went hidden DURING the run still gets the honest hint', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [VISIBLE, HIDDEN] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBe(true)
    expect(outcome.error?.message).toContain('timer throttling possible')
  })

  it('a probe that refuses entirely changes nothing, as before', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [VISIBLE], refuse: true })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBeUndefined()
    expect(outcome.error?.message).not.toContain('throttl')
  })
})

// ── the x2 margin follows the same corroborated value ──────────────────────

describe('plan15-hidden: the x2 timeout margin', () => {
  it('applies, and is REPORTED, for a corroborated hidden tab', async () => {
    const { session, calls } = recordingSession('timeout')
    const { service } = pokedService(session, { readings: [HIDDEN] })
    const outcome = await service.exec({ expression: 'await slowStep()' })
    expect(calls[0]?.options?.timeoutMs).toBe(30_000)
    // plan15-hidden: a silently doubled deadline is a hidden variable.
    expect(outcome.effectiveTimeoutMs).toBe(30_000)
  })

  it('does not apply for a visible page, and reports no effective bound', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { readings: [VISIBLE] })
    const outcome = await service.exec({ expression: '1' })
    expect(calls[0]?.options?.timeoutMs).toBe(15_000)
    expect(outcome.effectiveTimeoutMs).toBeUndefined()
    expect(Object.keys(outcome)).not.toContain('effectiveTimeoutMs')
  })

  it('does not apply for an uncorroborated hidden flag — the reported false positive', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { readings: [UNCORROBORATED] })
    const outcome = await service.exec({ expression: '1' })
    expect(calls[0]?.options?.timeoutMs).toBe(15_000)
    expect(outcome.effectiveTimeoutMs).toBeUndefined()
  })

  it('does not apply when the probe proves nothing at all', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { readings: [VISIBLE], refuse: true })
    const outcome = await service.exec({ expression: '1' })
    expect(calls[0]?.options?.timeoutMs).toBe(15_000)
    expect(outcome.effectiveTimeoutMs).toBeUndefined()
  })

  it('an explicit timeoutMs stays untouched even on a hidden tab', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { readings: [HIDDEN] })
    const outcome = await service.exec({ expression: '1', timeoutMs: 500 })
    expect(calls[0]?.options?.timeoutMs).toBe(500)
    expect(outcome.documentHidden).toBe(true)
    expect(outcome.effectiveTimeoutMs).toBeUndefined()
  })

  it('the run still owns exactly one session.evaluate — the probe stayed out-of-band', async () => {
    const { session, calls } = recordingSession('timeout')
    const { service, sent } = pokedService(session, { readings: [HIDDEN] })
    await service.exec({ expression: 'await slowStep()' })
    expect(calls).toHaveLength(1)
    expect(sent.filter(command => command.method === 'Runtime.evaluate')).toHaveLength(2)
  })
})

// ── the cdp_eval half ───────────────────────────────────────────────────────

/** Mirror of the cdp_eval tool's execute path (tools.ts) without booting tools. */
async function runEvalLikeTool(service: CdpService, expression: string) {
  try {
    const meta = await service.evalWithMeta(expression)
    return { outcome: service.buildEvalOutcome(meta.evaluation, meta.targetId, meta.url, meta.documentHidden) }
  } catch (error) {
    return { outcome: service.buildEvalFailure(error, expression) }
  }
}

describe('plan15-hidden: cdp_eval carries the same corroborated value', () => {
  it('a hidden eval timeout still terminates the page script and reports the cause', async () => {
    const { service, sent } = pokedService(timingOutSession(), { readings: [HIDDEN] })
    const { outcome } = await runEvalLikeTool(service, 'await slowStep()')
    expect(outcome.ok).toBe(false)
    expect(outcome.terminated).toBe(true)
    expect(outcome.documentHidden).toBe(true)
    expect(sent.some(command => command.method === 'Runtime.terminateExecution')).toBe(true)
  })

  it('a visible eval timeout leaves the message untouched', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [VISIBLE] })
    const { outcome } = await runEvalLikeTool(service, 'while (true) {}')
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBe(false)
    const message = (outcome.error as { message?: string } | undefined)?.message ?? ''
    expect(message).not.toContain('document.hidden')
    expect(message).not.toContain('throttl')
  })

  it('an uncorroborated hidden flag leaves documentHidden off the eval envelope', async () => {
    const { service } = pokedService(timingOutSession(), { readings: [UNCORROBORATED] })
    const { outcome } = await runEvalLikeTool(service, 'await slowStep()')
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBeUndefined()
    expect(Object.keys(outcome)).not.toContain('documentHidden')
  })

  it('a stale pre-run hidden is re-read on the eval path too', async () => {
    const { service, sent } = pokedService(timingOutSession(), { readings: [HIDDEN, VISIBLE] })
    const { outcome } = await runEvalLikeTool(service, 'await slowStep()')
    expect(outcome.documentHidden).toBe(false)
    expect(sent.filter(command => command.method === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('a successful run still reports a corroborated value and nothing else', async () => {
    const { session } = recordingSession('ok')
    const { service } = pokedService(session, { readings: [VISIBLE] })
    const { outcome } = await runEvalLikeTool(service, '1')
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe('1')
    expect(outcome.documentHidden).toBe(false)
    expect(Object.keys(outcome)).not.toContain('terminated')
  })
})
