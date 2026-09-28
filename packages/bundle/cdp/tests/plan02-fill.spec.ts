/**
 * Plan 02 wave 2 (§4.4) fill tests: argument validation, the composed page
 * script (locator core + write paths), the never-throws parse matrix, the
 * outcome/render verdicts, and `service.fill` through the fake-session seam —
 * happy path, the Input.insertText fallback (send recorded + read-back),
 * immediate kind rejections, and the locator poll retry.
 */

import { describe, expect, it } from 'vitest'
import { CdpService } from '../src/service.ts'
import type { PageEvaluation } from '../src/page.ts'
import {
  FILL_POST_SCHEMA,
  buildFillExpression,
  buildFillReadExpression,
  fillFallbackOutcome,
  fillOutcomeFromReply,
  isFillFatal,
  parseFillRead,
  parseFillReply,
  renderFill,
  validateFillArgs,
} from '../src/fill.ts'
import { buildLocatorExpression, locatorSpecFromArgs, validateLocatorSpec } from '../src/locator.ts'

/** One clean page evaluation carrying a JSON payload (or a raw string). */
function evaluation(payload: unknown): PageEvaluation {
  return {
    value: typeof payload === 'string' ? payload : JSON.stringify(payload),
    truncated: false,
    exception: undefined,
    hasValue: true,
    valueType: 'string',
  }
}

interface EvaluateCall {
  expression: string
  options: { awaitPromise?: boolean | undefined, timeoutMs?: number | undefined } | undefined
}

interface SendCall {
  method: string
  params: Record<string, unknown>
}

/**
 * A CdpService whose session seam answers from a reply queue and whose
 * connection records Input commands (the insertText fallback).
 */
function fillService(replies: PageEvaluation[]): { service: CdpService, calls: EvaluateCall[], sends: SendCall[] } {
  const service = new CdpService()
  const calls: EvaluateCall[] = []
  const sends: SendCall[] = []
  let index = 0
  const seams = service as unknown as {
    getPageSession: (targetId?: string) => Promise<unknown>
    connection: { send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown> }
  }
  seams.getPageSession = async () => ({
    sessionId: 'sess-fill',
    evaluate: async (expression: string, options?: EvaluateCall['options']) => {
      calls.push({ expression, options })
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (reply === undefined) throw new Error('fake session: no reply queued')
      return reply
    },
    url: async () => 'https://example.com/form',
  })
  seams.connection = {
    send: async (method: string, params: Record<string, unknown>) => {
      sends.push({ method, params })
      return {}
    },
  }
  return { service, calls, sends }
}

const TARGET = {
  index: 0,
  tag: 'input',
  role: 'textbox',
  name: 'E-posta',
  ariaLabel: 'E-posta',
  id: 'mail',
  rect: { x: 10, y: 20, width: 200, height: 32 },
  visible: true,
  enabled: true,
  inViewport: true,
  text: '',
  textLength: 0,
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

function fillSuccess(post: Record<string, unknown> = {}): PageEvaluation {
  return evaluation({
    ok: true,
    found: true,
    matched: 1,
    strategy: 'css',
    candidates: [],
    url: 'https://example.com/form',
    target: TARGET,
    actionability: ACTIONABLE,
    post: {
      checked: true,
      passed: true,
      condition: 'value === expected',
      expected: 'selam',
      actual: 'selam',
      ...post,
    },
  })
}

describe('plan02: validateFillArgs', () => {
  it('accepts a sound locator + string value and rejects each structural failure', () => {
    expect(validateFillArgs({ css: '#mail' }, 'selam')).toBeUndefined()
    expect(validateFillArgs(locatorSpecFromArgs({}), 42 as unknown)).toBe('value must be a string')
    expect(validateFillArgs({}, 'selam')).toContain('no locator given')
    expect(validateFillArgs({ role: 'textbox' }, 'selam')).toBe('role requires name')
    expect(validateFillArgs({ scope: '.dialog' }, 'selam')).toContain('scope alone')
    expect(validateLocatorSpec({ css: '#mail' })).toBeUndefined()
  })
})

describe('plan02: buildFillExpression', () => {
  it('composes the shared locator core with the input write path', () => {
    const expression = buildFillExpression({ css: '#mail' }, { value: 'selam', clear: true, verify: true })
    expect(expression).toContain('const spec = {"css":"#mail"}')
    expect(expression).toContain('const value = "selam";')
    expect(expression).toContain('const clear = true;')
    expect(expression).toContain('const verify = true;')
    // The extracted core: normalization + ladder + actionability, all present.
    expect(expression).toContain('const norm = ')
    expect(expression).toContain('const cut = ')
    expect(expression).toContain('out.actionability = {')
    // Native setter + framework events (React-safe write).
    expect(expression).toContain('window.HTMLInputElement.prototype')
    expect(expression).toContain("dispatchEvent(new Event('input'")
    // Read-back verification and the file-input refusal are in the script.
    expect(expression).toContain('out.post = {')
    expect(expression).toContain('file inputs cannot be filled via locator layer')
    expect(expression).toContain('value not accepted by framework (react state override suspected)')
    // No raw backtick can break out of the template the session evaluates.
    expect(expression).not.toContain('`')
  })

  it('JSON-escapes quotes and honours clear:false / verify:false', () => {
    const expression = buildFillExpression({ text: 'Gönder' }, { value: 'he "said"', clear: false, verify: false })
    expect(expression).toContain('const value = "he \\"said\\"";')
    expect(expression).toContain('const clear = false;')
    expect(expression).toContain('const verify = false;')
    // clear:false appends against the captured `before` value.
    expect(expression).toContain('String(el.value || \'\') + value')
  })

  it('covers select, contenteditable, and the read-back probe shapes', () => {
    const expression = buildFillExpression({ css: '#kind' }, { value: 'tr', clear: true, verify: true })
    expect(expression).toContain('hitOption.selected = true')
    expect(expression).toContain("document.execCommand('insertText'")
    expect(expression).toContain('el.isContentEditable')
    expect(expression).toContain("element cannot be filled: <' + tag + '>")

    expect(buildFillReadExpression('value')).toContain('document.activeElement')
    expect(buildFillReadExpression('value')).toContain('el.value')
    expect(buildFillReadExpression('contenteditable')).toContain('el.textContent')
  })
})

describe('plan02: parseFillReply / parseFillRead (never throws)', () => {
  it('maps a full reply with a sanitized post block', () => {
    const run = parseFillReply(fillSuccess(), 'TARGET-1')
    expect(run.targetId).toBe('TARGET-1')
    expect(run.reply.ok).toBe(true)
    expect(run.reply.post).toEqual({
      checked: true,
      passed: true,
      condition: 'value === expected',
      expected: 'selam',
      actual: 'selam',
    })
    expect(run.reply.fallbackNeeded).toBeUndefined()
  })

  it('keeps the fallback signals with a normalized kind', () => {
    const run = parseFillReply(evaluation({
      ok: false,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      post: { checked: true, passed: false, condition: 'value === expected', expected: 'selam', actual: '' },
      fallbackNeeded: true,
      fallbackKind: 'weird-ignored',
    }), '')
    expect(run.reply.fallbackNeeded).toBe(true)
    expect(run.reply.fallbackKind).toBeUndefined()
  })

  it('drops shape drift instead of trusting it', () => {
    const drift = parseFillReply(evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'u',
      post: { checked: 'yes', passed: true, condition: 1, expected: 'a', actual: 'a' },
    }), '')
    expect(drift.reply.ok).toBe(true)
    expect(drift.reply.post).toBeUndefined()
  })

  it('collapses evaluation errors, truncation, empty, garbage, and drift to ok:false', () => {
    const errored = { ...evaluation(''), error: { kind: 'timeout', message: 'took too long' } } as PageEvaluation
    expect(parseFillReply(errored, '').reply.reason).toContain('evaluation failed: timeout')
    expect(parseFillReply({ ...evaluation('{}'), truncated: true } as PageEvaluation, '').reply.reason).toContain('evaluation bound')
    expect(parseFillReply(evaluation(''), '').reply.reason).toContain('no fill reply')
    expect(parseFillReply(evaluation('not json'), '').reply.reason).toContain('unparseable fill reply')
    expect(parseFillReply(evaluation('[1,2,3]'), '').reply.reason).toContain('malformed fill reply')
    expect(parseFillReply(evaluation({ found: true }), '').reply.reason).toContain('malformed fill reply')
  })

  it('parses the read-back probe tolerantly', () => {
    expect(parseFillRead(evaluation({ url: 'https://example.com/', actual: 'selam' }))).toEqual({
      url: 'https://example.com/',
      actual: 'selam',
    })
    expect(parseFillRead(evaluation({ url: 'u' }))).toEqual({ url: 'u' })
    expect(parseFillRead(evaluation({ url: 'u', error: 'boom' }))).toEqual({ url: 'u' })
    expect(parseFillRead(evaluation('garbage'))).toBeUndefined()
    expect(parseFillRead({ ...evaluation(''), error: { kind: 'exception', message: 'boom' } } as PageEvaluation)).toBeUndefined()
  })
})

describe('plan02: fill verdicts and rendering', () => {
  it('builds the outcome from a reply with value.length and omits empty evidence', () => {
    const reply = parseFillReply(fillSuccess(), 'T1').reply
    const outcome = fillOutcomeFromReply(reply, 'T1', 'selam'.length)
    expect(outcome).toMatchObject({ ok: true, action: 'fill', length: 5, matched: 1, strategy: 'css', targetId: 'T1', url: 'https://example.com/form' })
    expect(outcome.candidates).toBeUndefined()
    expect(outcome.reason).toBeUndefined()

    const bare = fillOutcomeFromReply({ ok: false, found: false, matched: 0, strategy: 'none', candidates: [], url: '', reason: 'file inputs cannot be filled via locator layer' }, '', 5)
    expect(bare).toMatchObject({ ok: false, action: 'fill', length: 5, reason: 'file inputs cannot be filled via locator layer' })
    expect(bare.matched).toBeUndefined()
    expect(bare.strategy).toBeUndefined()
  })

  it('settles the fallback outcome: pass through the read-back, honest reason on failure', () => {
    const reply = parseFillReply(evaluation({
      ok: false,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      post: { checked: true, passed: false, condition: 'value === expected', expected: 'selam', actual: '' },
      fallbackNeeded: true,
      fallbackKind: 'value',
    }), '').reply

    const passed = fillFallbackOutcome(reply, 'T1', 'selam'.length, 'selam', 'https://example.com/form')
    expect(passed.ok).toBe(true)
    expect(passed.fallbackUsed).toBe(true)
    expect(passed.post).toMatchObject({ checked: true, passed: true, expected: 'selam', actual: 'selam' })
    expect(passed.reason).toBeUndefined()

    const failed = fillFallbackOutcome(reply, 'T1', 'selam'.length, '', 'https://example.com/form')
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('react state override suspected')
    expect(failed.post?.reason).toContain('react state override suspected')
  })

  it('classifies fatal reasons so the poll loop stops immediately', () => {
    expect(isFillFatal('file inputs cannot be filled via locator layer')).toBe(true)
    expect(isFillFatal('element cannot be filled: <div> accepts no value (only input/textarea/select/contenteditable)')).toBe(true)
    expect(isFillFatal('no option matches value: tr')).toBe(true)
    expect(isFillFatal('fill script failed: x is not defined')).toBe(true)
    expect(isFillFatal('not found (css matched 0 candidates)')).toBe(false)
    expect(isFillFatal('not actionable: not visible')).toBe(false)
    expect(isFillFatal('ambiguous: 2 candidates')).toBe(false)
  })

  it('renders success with the subject/strategy/verification and failures with the reason', () => {
    const post = { checked: true, passed: true, condition: 'value === expected', expected: 'selam', actual: 'selam' }
    const success = renderFill({ ok: true, strategy: 'css', matched: 1, target: { tag: 'input', id: 'mail', name: 'E-posta' }, post }, 'selam')
    expect(success).toContain('Filled <input#mail "E-posta"> with "selam"')
    expect(success).toContain('strategy=css, matched=1')
    expect(success).toContain('verified: value matches')

    const mismatch = renderFill({
      ok: false,
      target: { tag: 'input', id: 'mail' },
      post: { ...post, passed: false, actual: '' },
    }, 'selam')
    expect(mismatch).toContain('FAILED to fill <input#mail>')
    expect(mismatch).toContain('value not accepted (expected "selam", actual "")')

    const rejected = renderFill({ ok: false, reason: 'file inputs cannot be filled via locator layer' })
    expect(rejected).toBe('FAILED to fill element: file inputs cannot be filled via locator layer')
  })

  it('keeps the post schema closed and required-blocked', () => {
    expect(FILL_POST_SCHEMA.type).toBe('object')
    expect(FILL_POST_SCHEMA.additionalProperties).toBe(false)
    expect(FILL_POST_SCHEMA.properties.checked.required).toBe(true)
    expect('required' in FILL_POST_SCHEMA.properties.reason).toBe(false)
  })
})

describe('plan02: service.fill through the session seam', () => {
  it('writes, verifies, and returns the full envelope with awaited evaluation', async () => {
    const { service, calls } = fillService([fillSuccess()])
    const outcome = await service.fill({ css: '#mail' }, 'selam')
    expect(outcome.ok).toBe(true)
    expect(outcome.action).toBe('fill')
    expect(outcome.length).toBe(5)
    expect(outcome.post).toMatchObject({ checked: true, passed: true, expected: 'selam', actual: 'selam' })
    expect(outcome.target?.tag).toBe('input')
    expect(outcome.actionability?.visible).toBe(true)
    expect(outcome.targetId).toBe('')
    expect(outcome.url).toBe('https://example.com/form')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.awaitPromise).toBe(true)
    expect(calls[0]?.expression).toContain('const value = "selam";')
  })

  it('falls back to Input.insertText when the write was reverted, then proves it stuck', async () => {
    const reverted = evaluation({
      ok: false,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      target: TARGET,
      actionability: ACTIONABLE,
      post: { checked: true, passed: false, condition: 'value === expected', expected: 'selam', actual: '' },
      fallbackNeeded: true,
      fallbackKind: 'value',
    })
    const { service, calls, sends } = fillService([reverted, evaluation({ url: 'https://example.com/form', actual: 'selam' })])
    const outcome = await service.fill({ css: '#mail' }, 'selam')
    expect(outcome.ok).toBe(true)
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.post).toMatchObject({ passed: true, actual: 'selam', expected: 'selam' })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ method: 'Input.insertText', params: { text: 'selam' } })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.expression).toContain('document.activeElement')
  })

  it('reports a second failure with the honest framework-revert reason', async () => {
    const reverted = evaluation({
      ok: false,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      post: { checked: true, passed: false, condition: 'value === expected', expected: 'selam', actual: '' },
      fallbackNeeded: true,
      fallbackKind: 'value',
    })
    const { service } = fillService([reverted, evaluation({ url: 'https://example.com/form', actual: '' })])
    const outcome = await service.fill({ css: '#mail' }, 'selam')
    expect(outcome.ok).toBe(false)
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.reason).toContain('react state override suspected')
    expect(outcome.post?.passed).toBe(false)
  })

  it('stops immediately on a fatal kind rejection (file input)', async () => {
    const { service, calls, sends } = fillService([evaluation({
      ok: false,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      reason: 'file inputs cannot be filled via locator layer',
    })])
    const outcome = await service.fill({ css: '#upload' }, 'x', { timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('file inputs cannot be filled via locator layer')
    expect(outcome.action).toBe('fill')
    expect(calls).toHaveLength(1)
    expect(sends).toHaveLength(0)
  })

  it('polls a resolution failure until it succeeds (timeoutMs budget)', async () => {
    const notFound = evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      reason: 'not found (css matched 0 candidates)',
    })
    const { service, calls } = fillService([notFound, fillSuccess()])
    const outcome = await service.fill({ css: '#mail' }, 'selam', { timeoutMs: 600 })
    expect(outcome.ok).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up in-band with the last reason once the budget expires', async () => {
    const notFound = evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      reason: 'not found (css matched 0 candidates)',
    })
    const { service, calls } = fillService([notFound])
    const outcome = await service.fill({ css: '#ghost' }, 'x', { timeoutMs: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('not found (css matched 0 candidates)')
    expect(calls).toHaveLength(1)
  })

  it('honours clear:false and verify:false through the options', async () => {
    const noVerify = evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      post: { checked: false, passed: true, condition: 'value === expected', expected: 'a' + 'bc', actual: '' },
    })
    const { service, calls } = fillService([noVerify])
    const outcome = await service.fill({ css: '#mail' }, 'bc', { clear: false, verify: false, timeoutMs: 0 })
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.expression).toContain('const clear = false;')
    expect(calls[0]?.expression).toContain('const verify = false;')
  })
})

describe('plan02-fix F3: generated scripts are executable JavaScript', () => {
  // The T3/T6 blocker: a stray backtick (template closes early) or a
  // duplicate top-level `const` (locator core's `failures`/`before`
  // colliding with the fill body's own) is a *parse* error — the browser
  // answers "evaluation failed: exception: Identifier 'failures' has
  // already been declared" and EVERY fill dies before doing anything.
  // Compile each strategy's script here so a template or a shadowing
  // regression cannot ship silently again.
  it('compiles the fill script for every locator strategy without a SyntaxError', () => {
    const specs = [
      { css: '#mail' },
      { role: 'textbox', name: 'E-posta' },
      { text: 'Gönder', textMatch: 'contains' as const },
      { ariaLabel: 'Gönder' },
      { css: '.row', scope: '#modal', nth: 1 },
    ]
    for (const spec of specs) {
      const expression = buildFillExpression(spec, { value: 'selam', clear: true, verify: true })
      expect(
        () => { new Function('return ' + expression) },
        `fill script must parse: ${JSON.stringify(spec)}`,
      ).not.toThrow()
    }
  })

  it('compiles the read-back probe and the locator expression (same shared core)', () => {
    for (const kind of ['value', 'contenteditable'] as const) {
      expect(() => { new Function('return ' + buildFillReadExpression(kind)) }).not.toThrow()
    }
    expect(() => { new Function('return ' + buildLocatorExpression({ css: '#send' })) }).not.toThrow()
    expect(() => { new Function('return ' + buildLocatorExpression({ role: 'button', name: 'Gönder' })) }).not.toThrow()
  })

  it('declares each colliding name exactly once at script top level (block shadowing)', () => {
    const expression = buildFillExpression({ css: '#mail' }, { value: 'selam', clear: true, verify: true })
    // The core declares them once; the fill body's copies live inside its own
    // nested block. A regression hoisting any of them back to the try-block
    // scope would turn the whole script into a SyntaxError again.
    expect(expression.split('const failures').length - 1).toBe(2)
    expect(expression.split('const before').length - 1).toBe(2)
  })
})
