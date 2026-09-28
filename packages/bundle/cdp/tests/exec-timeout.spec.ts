/**
 * plan10-fix (T6 §3.3, §4.4–4.5) — `cdp_exec` timeout semantics:
 * (1) a send timeout cancels the page script (`Runtime.terminateExecution`)
 * so no zombie run keeps polluting the page, and the envelope says
 * `terminated`;
 * (2) hidden-tab timer throttling is made visible — pre-run
 * `document.hidden` rides the envelope, an implicit timeout gets a ×2
 * margin, and a timeout on a hidden target names the cause in its message.
 * New file on purpose: service.spec's plan01 exec tests stay untouched, and
 * the probe deliberately travels the raw connection so their
 * `session.evaluate` call-count assertions still hold.
 */

import { describe, expect, it } from 'vitest'
import { CdpTimeoutError as ConnectionTimeoutError } from '../src/connection.ts'
import { CdpSessionClosedError } from '../src/page.ts'
import { CdpService } from '../src/service.ts'

interface FakeSession {
  sessionId: string
  url: () => Promise<string>
  evaluate: (expression: string, options?: { timeoutMs?: number; awaitPromise?: boolean }) => Promise<Record<string, unknown>>
}

interface SentCommand {
  method: string
  params?: unknown
  sessionId?: unknown
}

interface PokeOptions {
  /** The probe's answer: boolean, or 'throw' to make the probe unreadable. */
  hidden?: boolean | 'throw'
  /**
   * plan15-hidden: the page's own `document.visibilityState`. Default follows
   * `hidden` (a hidden page that also reports `hidden` is corroborated); set
   * it to 'visible' to model a reading the visibility state REFUSES to
   * corroborate, which the service must refuse to repeat as a fact.
   */
  visibilityState?: string
  /** plan15-hidden: answer the Nth probe read with the Nth entry, then fall back to `hidden`. */
  probeSequence?: boolean[]
  /** Runtime.terminateExecution behavior: acknowledge (default) or refuse. */
  terminate?: 'ok' | 'reject'
}

/** Wire a fake connection/registry/session into a fresh service instance. */
function pokedService(session: FakeSession, options: PokeOptions = {}): { service: CdpService; sent: SentCommand[] } {
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
        if (options.hidden === 'throw') return Promise.reject(new Error('probe refused'))
        // plan15-hidden: the probe reads all three signals in ONE round trip
        // now, so the fake answers the object the service actually sends.
        const hidden = options.probeSequence?.[probeCalls] ?? options.hidden ?? false
        probeCalls += 1
        const state = options.visibilityState ?? (hidden ? 'hidden' : 'visible')
        return Promise.resolve({
          result: { type: 'object', value: { hidden, state, focused: !hidden } },
        })
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

/** A session recording every evaluate call; scripts succeed, later phases can be forced to time out. */
function recordingSession(script: 'ok' | 'timeout', post: 'ok' | 'timeout' = 'ok'): {
  session: FakeSession
  calls: Array<{ expression: string; options?: { timeoutMs?: number; awaitPromise?: boolean } | undefined }>
} {
  const calls: Array<{ expression: string; options?: { timeoutMs?: number; awaitPromise?: boolean } | undefined }> = []
  let callIndex = 0
  const session: FakeSession = {
    sessionId: 'sess-1',
    url: () => Promise.resolve('https://example.com'),
    evaluate: (expression, options) => {
      calls.push({ expression, options })
      callIndex += 1
      const phase = callIndex === 1 ? script : post
      if (phase === 'timeout') return Promise.reject(new ConnectionTimeoutError('Runtime.evaluate', options?.timeoutMs ?? 15000))
      if (callIndex === 1) {
        return Promise.resolve({ value: '1', truncated: false, exception: undefined, hasValue: true, valueType: 'number' })
      }
      return Promise.resolve({
        value: JSON.stringify({ passed: true, value: 'true' }),
        truncated: false,
        exception: undefined,
        hasValue: true,
        valueType: 'string',
      })
    },
  }
  return { session, calls }
}

describe('cdp_exec timeout — zombie termination (plan10-fix T6 §3.3)', () => {
  it('a script timeout sends Runtime.terminateExecution and reports terminated:true', async () => {
    const { service, sent } = pokedService(timingOutSession(), { hidden: false })
    const outcome = await service.exec({ expression: 'while (true) {}', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.didAct).toBe(false)
    const error = outcome.error as { kind?: string }
    expect(error.kind).toBe('timeout')
    expect(outcome.terminated).toBe(true)
    expect(outcome.documentHidden).toBe(false)
    const terminate = sent.find(command => command.method === 'Runtime.terminateExecution')
    expect(terminate).toBeDefined()
    expect(terminate?.sessionId).toBe('sess-1')
    // The probe travelled out-of-band: the run itself never added a session.evaluate call.
    const probe = sent.find(command => command.method === 'Runtime.evaluate')
    expect(probe?.sessionId).toBe('sess-1')
  })

  it('reports terminated:false when the terminate request itself fails', async () => {
    const { service } = pokedService(timingOutSession(), { hidden: false, terminate: 'reject' })
    const outcome = await service.exec({ expression: 'while (true) {}', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.terminated).toBe(false)
  })

  it('a timeout in the postCondition phase also terminates (both phases covered)', async () => {
    const { session } = recordingSession('ok', 'timeout')
    const { service, sent } = pokedService(session, { hidden: false })
    const outcome = await service.exec({ expression: '1', postCondition: 'Boolean(1)', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    const error = outcome.error as { kind?: string; phase?: string }
    expect(error.kind).toBe('timeout')
    expect(error.phase).toBe('postCondition')
    expect(outcome.terminated).toBe(true)
    expect(outcome.postCondition).toEqual({ requested: true, passed: false })
    expect(sent.some(command => command.method === 'Runtime.terminateExecution')).toBe(true)
  })

  it('awaitPromise runs through the same path: forwarded, then terminated on timeout', async () => {
    const { session, calls } = recordingSession('timeout')
    const { service } = pokedService(session, { hidden: false })
    const outcome = await service.exec({ expression: 'new Promise(() => {})', awaitPromise: true, timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    const error = outcome.error as { kind?: string }
    expect(error.kind).toBe('timeout')
    expect(outcome.terminated).toBe(true)
    // The script call still carried both options — the fix changed only the failure path.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.awaitPromise).toBe(true)
    expect(calls[0]?.options?.timeoutMs).toBe(100)
  })
})

describe('cdp_exec hidden-tab throttling transparency (plan10-fix T6 §4.4)', () => {
  it('doubles the implicit timeout when the target is hidden and says why on failure', async () => {
    const { session, calls } = recordingSession('timeout')
    const { service } = pokedService(session, { hidden: true })
    const outcome = await service.exec({ expression: 'await slowStep()' })
    // Implicit (caller-unspecified) timeout: 15000 → 30000 as the hidden-tab margin.
    expect(calls[0]?.options?.timeoutMs).toBe(30_000)
    expect(outcome.documentHidden).toBe(true)
    expect(outcome.ok).toBe(false)
    const error = outcome.error as { kind?: string; message?: string }
    expect(error.kind).toBe('timeout')
    expect(error.message).toContain('timer throttling possible')
    expect(error.message).toContain('document.hidden=true')
    expect(outcome.terminated).toBe(true)
  })

  it('keeps an explicit timeoutMs untouched even on a hidden target', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { hidden: true })
    const outcome = await service.exec({ expression: '1', timeoutMs: 500 })
    expect(outcome.ok).toBe(true)
    expect(outcome.documentHidden).toBe(true)
    expect(calls[0]?.options?.timeoutMs).toBe(500)
  })

  it('leaves a visible target timeout message unmodified', async () => {
    const { service } = pokedService(timingOutSession(), { hidden: false })
    const outcome = await service.exec({ expression: '1', timeoutMs: 100 })
    expect(outcome.ok).toBe(false)
    expect(outcome.documentHidden).toBe(false)
    const error = outcome.error as { kind?: string; message?: string }
    expect(error.kind).toBe('timeout')
    expect(error.message).not.toContain('document.hidden')
    expect(error.message).not.toContain('timer throttling')
  })

  it('an unreadable probe changes nothing: no documentHidden, run proceeds', async () => {
    const { session, calls } = recordingSession('ok')
    const { service } = pokedService(session, { hidden: 'throw' })
    const outcome = await service.exec({ expression: '1' })
    expect(outcome.ok).toBe(true)
    expect(outcome.documentHidden).toBeUndefined()
    expect(outcome.terminated).toBeUndefined()
    expect(calls).toHaveLength(1)
    // No ×2 without a positive hidden answer: the default bound stays 15000.
    expect(calls[0]?.options?.timeoutMs).toBe(15_000)
  })
})

/** Mirror of the cdp_eval tool's execute path (tools.ts) without booting tools. */
async function runEvalLikeTool(service: CdpService, expression: string) {
  try {
    const meta = await service.evalWithMeta(expression)
    return { outcome: service.buildEvalOutcome(meta.evaluation, meta.targetId, meta.url, meta.documentHidden) }
  } catch (error) {
    return { outcome: service.buildEvalFailure(error, expression) }
  }
}

describe('cdp_eval zombie termination (plan10-fix, second wave)', () => {
  it('an eval timeout terminates the page script; visible-tab message stays untouched', async () => {
    const { service, sent } = pokedService(timingOutSession(), { hidden: false })
    const { outcome } = await runEvalLikeTool(service, 'while (true) {}')
    expect(outcome.ok).toBe(false)
    const error = outcome.error as { kind?: string; message?: string }
    expect(error.kind).toBe('timeout')
    expect(error.message).not.toContain('document.hidden')
    expect(error.message).not.toContain('timer throttling')
    expect(outcome.terminated).toBe(true)
    expect(outcome.documentHidden).toBe(false)
    const terminate = sent.find(command => command.method === 'Runtime.terminateExecution')
    expect(terminate).toBeDefined()
    expect(terminate?.sessionId).toBe('sess-1')
    // The probe travelled out-of-band: eval itself never added a session.evaluate call.
    expect(sent.some(command => command.method === 'Runtime.evaluate')).toBe(true)
  })

  it('a hidden target carries documentHidden on the failure envelope', async () => {
    const { service } = pokedService(timingOutSession(), { hidden: true })
    const { outcome } = await runEvalLikeTool(service, 'await slowStep()')
    expect(outcome.ok).toBe(false)
    expect(outcome.terminated).toBe(true)
    expect(outcome.documentHidden).toBe(true)
  })

  it('plan01 eval expectations stay intact: success shape unchanged, untagged failures gain nothing', async () => {
    const { session } = recordingSession('ok')
    const { service } = pokedService(session, { hidden: false })
    const { outcome } = await runEvalLikeTool(service, '1')
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe('1')
    expect(outcome.targetId).toBe('tab-1')
    expect(outcome.documentHidden).toBe(false)
    expect(Object.keys(outcome)).not.toContain('terminated')

    // A non-timeout infrastructure failure keeps exactly plan01's key set.
    const closedSession: FakeSession = {
      sessionId: 'sess-1',
      url: () => Promise.resolve('https://example.com'),
      evaluate: () => Promise.reject(new CdpSessionClosedError('sess-1')),
    }
    const { service: closedService } = pokedService(closedSession, { hidden: false })
    const { outcome: failure } = await runEvalLikeTool(closedService, '1')
    expect(failure.ok).toBe(false)
    const error = failure.error as { kind?: string }
    expect(error.kind).toBe('session')
    expect(Object.keys(failure)).not.toContain('terminated')
    expect(Object.keys(failure)).not.toContain('documentHidden')
  })
})
