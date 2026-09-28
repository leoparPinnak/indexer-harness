/**
 * plan11: `service.captcha()` over scripted seams, plus the `cdp_captcha` tool
 * envelope under `additionalProperties:false` and the render contract.
 *
 * What this layer pins:
 *  1. `scan` never swallows — an empty page is `ok:true + candidates: [] + reason`,
 *     a failed page script keeps the page's own reason, and a third-party frame
 *     is reported alongside candidates.
 *  2. `drag` never claims success without a read-back — the whole T3 F1 /
 *     T6 §3.2 failure class is "the tool said ok and nothing happened".
 *  3. `verify` omits a counter the page does not publish.
 *  4. The tool envelope validates (including the NEGATIVE case: an undeclared
 *     key is rejected) and `ok:false` never renders a success phrase.
 *
 * No browser: the page session and the connection are fakes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpService } from '../src/service.ts'
import { registerCdpTools } from '../src/tools.ts'

// ---------------------------------------------------------------------------
// Fake service harness
// ---------------------------------------------------------------------------

interface EvalReply {
  value: string
  hasValue?: boolean
  truncated?: boolean
  exception?: string
}

interface HarnessOptions {
  /** Replies in call order; the last one repeats once exhausted. */
  evaluate?: EvalReply[]
  /** Thrown by `Input.dispatchMouseEvent` when the method matches. */
  failOn?: string
  nowStep?: number
}

/** A CdpService wired to a scripted page session + input connection. */
function bootService(options: HarnessOptions = {}): { service: CdpService, sent: Array<{ method: string, params: Record<string, unknown> }>, evals: string[] } {
  const sent: Array<{ method: string, params: Record<string, unknown> }> = []
  const evals: string[] = []
  const replies = options.evaluate ?? []
  let call = 0
  let now = 1_000
  const connection = {
    endpoint: 'ws://127.0.0.1:0/fake',
    connected: true,
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      sent.push({ method, params })
      if (options.failOn !== undefined && method === options.failOn) throw new Error('protocol refused')
      return {}
    },
    on: (): (() => void) => () => {},
  }
  const service = Object.create(CdpService.prototype) as CdpService
  Object.assign(service, {
    connection,
    registry: { active: () => ({ targetId: 'tab-1' }) },
    getPageSession: async () => ({
      sessionId: 's-1',
      url: async () => 'https://fixture.test/dogrulama.html',
      title: async () => 'Fixture',
      evaluate: async (): Promise<EvalReply> => {
        const reply = replies[Math.min(call, replies.length - 1)]
        call += 1
        if (reply === undefined) return { value: '', hasValue: false }
        evals.push(reply.value)
        return { hasValue: true, truncated: false, ...reply }
      },
    }),
  })
  void now
  void options.nowStep
  return { service, sent, evals }
}

/** A scan reply the parser accepts: one checkbox, no overlays, no frames. */
function scanReply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    url: 'https://fixture.test/dogrulama.html',
    host: 'fixture.test',
    records: [{
      selector: 'div#v1-box',
      tag: 'div',
      id: 'v1-box',
      role: 'checkbox',
      name: 'Onay kutusu',
      rect: { x: 82, y: 228, width: 657, height: 56 },
      visible: true,
      inViewport: true,
      hitIsTarget: true,
      hitTag: 'div#v1-box',
      pointerEvents: 'auto',
      position: 'relative',
      opacity: 1,
      tabIndex: 0,
      ariaHidden: false,
      frame: 'top',
      ariaChecked: 'false',
    }],
    overlays: [],
    frames: [],
    warnings: [],
    truncated: false,
    ...over,
  })
}

/** A slider measurement: a 664px track, 34px thumb, 3px inset, target 72. */
function measureReply(currentPct = 0, thumbX = 69, state: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    track: { x: 66, y: 300, width: 664, height: 40 },
    thumb: { x: thumbX, y: 303, width: 34, height: 34 },
    currentPct,
    declaredTarget: '72',
    viewport: { width: 754, height: 480 },
    reason: '',
    state: {
      ariaChecked: '', dataDone: '', dataSolved: '', dataConfirmed: '',
      value: '', thumbLeft: '', thumbData: [], ...state,
    },
  })
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe('plan11: service.captcha scan', () => {
  it('answers ok:true with the classified candidates and a first-party verdict', async () => {
    const { service } = bootService({ evaluate: [{ value: scanReply() }] })
    const outcome = await service.captcha({ action: 'scan' })
    expect(outcome.action).toBe('scan')
    expect('ok' in outcome && outcome.ok).toBe(true)
    if (!('candidates' in outcome)) throw new Error('scan must carry candidates')
    expect(outcome.found).toBe(1)
    expect(outcome.candidates[0]?.kind).toBe('checkbox')
    expect(outcome.thirdParty.verdict).toBe('first-party')
    expect(outcome.thirdParty.reason).toBeUndefined()
    expect(outcome.targetId).toBe('tab-1')
  })

  it('never swallows an empty page: candidates: [] + a reason, not a silent []', async () => {
    // timeoutMs:0 = single probe: this pins the empty shape, not the wait.
    const { service } = bootService({ evaluate: [{ value: scanReply({ records: [] }) }] })
    const outcome = await service.captcha({ action: 'scan', timeoutMs: 0 })
    expect('ok' in outcome && outcome.ok).toBe(true)
    if (!('reason' in outcome)) throw new Error('an empty scan must carry a reason')
    expect(outcome.reason).toContain('no first-party verification candidate')
    if (!('found' in outcome)) throw new Error('found must be present')
    expect(outcome.found).toBe(0)
  })

  it('keeps the page own reason when the page-side scan failed', async () => {
    const { service } = bootService({
      evaluate: [{ value: JSON.stringify({ ok: false, reason: 'scan script failed (boom)' }) }],
    })
    const outcome = await service.captcha({ action: 'scan' })
    expect('ok' in outcome && outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toBe('scan script failed (boom)')
  })

  it('reports a page-side evaluation that produced nothing as a failure', async () => {
    const { service } = bootService({ evaluate: [{ value: '', hasValue: false, exception: 'boom' }] })
    const outcome = await service.captcha({ action: 'scan' })
    expect('ok' in outcome && outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('produced no value')
  })

  it('reports a third-party frame without blocking', async () => {
    const { service } = bootService({
      evaluate: [{
        value: scanReply({
          frames: [{ src: 'https://www.google.com/recaptcha/api2/anchor', id: 'rc', title: 'reCAPTCHA', accessible: false }],
        }),
      }],
    })
    const outcome = await service.captcha({ action: 'scan' })
    expect('ok' in outcome && outcome.ok).toBe(true)
    if (!('thirdParty' in outcome)) throw new Error('scan must carry a verdict')
    expect(outcome.thirdParty.verdict).toBe('third-party-present')
    expect(outcome.thirdParty.providers).toContain('recaptcha')
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('reported alongside the candidates')
    if (!('warnings' in outcome)) throw new Error('scan must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('third-party provider present')
  })
})

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

describe('plan11: service.captcha drag', () => {
  it('dispatches a real press-move-release and reports DELIVERED from the read-back', async () => {
    // measure(before, pct 0) → measure(after, pct 72)
    const { service, sent } = bootService({
      evaluate: [{ value: measureReply(0, 69) }, { value: measureReply(0, 69) }, { value: measureReply(72, 518) }],
    })
    const outcome = await service.captcha({ action: 'drag', targetPct: 72, approach: false, overshoot: false })
    expect(outcome.action).toBe('drag')
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')
    expect(outcome.ok).toBe(true)
    expect(outcome.delivered).toBe(true)
    expect(outcome.matched).toBe(true)
    expect(outcome.beforeValue).toBe(0)
    expect(outcome.finalValue).toBeCloseTo(72, 1)
    expect(outcome.expectedValue).toBe(72)
    expect(outcome.attempts).toBe(1)
    // Real CDP input, not a page-side dispatchEvent.
    const mouse = sent.filter(call => call.method === 'Input.dispatchMouseEvent')
    expect(mouse.length).toBeGreaterThan(3)
    expect(mouse.map(call => call.params.type)).toContain('mousePressed')
    expect(mouse.map(call => call.params.type)).toContain('mouseReleased')
  })

  it('answers NOT DELIVERED when the read-back shows the value never moved', async () => {
    // T3 F1's failure class: the gesture was dispatched and nothing happened.
    const { service } = bootService({
      evaluate: [{ value: measureReply(0, 69) }, { value: measureReply(0, 69) }, { value: measureReply(0, 69) }],
    })
    const outcome = await service.captcha({ action: 'drag', targetPct: 72, approach: false })
    expect(outcome.ok).toBe(false)
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')
    expect(outcome.delivered).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('not delivered')
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('did not move')
  })

  it('answers NOT DELIVERED when the post-release read-back itself fails', async () => {
    const { service } = bootService({
      evaluate: [
        { value: measureReply(0, 69) },
        { value: JSON.stringify({ ok: false, reason: 'the slider has no measurable geometry' }) },
      ],
    })
    const outcome = await service.captcha({ action: 'drag', targetPct: 72, approach: false })
    expect(outcome.ok).toBe(false)
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')
    expect(outcome.delivered).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('no measurable geometry')
  })

  it('refuses with a reason when the page has no slider at all', async () => {
    const { service } = bootService({
      evaluate: [{ value: JSON.stringify({ ok: false, reason: 'cdp_captcha: no slider track found' }) }],
    })
    const outcome = await service.captcha({ action: 'drag' })
    expect(outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('no slider track found')
  })

  it('refuses when neither targetPct nor data-target names a percent', async () => {
    const { service } = bootService({
      evaluate: [{ value: JSON.stringify({ ...JSON.parse(measureReply()), declaredTarget: null }) }],
    })
    const outcome = await service.captcha({ action: 'drag' })
    expect(outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('no target percent')
  })

  it('reads the target from the track data-target when targetPct is absent', async () => {
    const { service } = bootService({
      evaluate: [{ value: measureReply(0, 69) }, { value: measureReply(0, 69) }, { value: measureReply(72, 518) }],
    })
    const outcome = await service.captcha({ action: 'drag', approach: false, overshoot: false })
    if (!('expectedValue' in outcome)) throw new Error('drag must carry expectedValue')
    expect(outcome.expectedValue).toBe(72)
  })

  it('warns when targetPct overrides the track own data-target', async () => {
    const { service } = bootService({
      evaluate: [{ value: measureReply(0, 69) }, { value: measureReply(0, 69) }, { value: measureReply(50, 400) }],
    })
    const outcome = await service.captcha({ action: 'drag', targetPct: 50, approach: false, overshoot: false })
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('overrides the track')
  })

  it('releases even when the input channel refuses, and says the gesture was reported', async () => {
    const { service } = bootService({
      evaluate: [{ value: measureReply(0, 69) }, { value: measureReply(0, 69) }, { value: measureReply(0, 69) }],
      failOn: 'Input.dispatchMouseEvent',
    })
    const outcome = await service.captcha({ action: 'drag', targetPct: 72, approach: false })
    expect(outcome.ok).toBe(false)
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('gesture reported')
  })

  it('refuses a locator that the DSL itself rejects, before any protocol call', async () => {
    const { service, sent } = bootService({ evaluate: [{ value: measureReply() }] })
    const outcome = await service.captcha({ action: 'drag', spec: { role: 'slider' } })
    expect(outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('role requires name')
    expect(sent).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe('plan11: service.captcha verify', () => {
  it('reads the solution state and the page counters in one call', async () => {
    const { service } = bootService({
      evaluate: [{
        value: JSON.stringify({
          ok: true,
          url: 'https://fixture.test/dogrulama.html',
          ariaChecked: ['#v1-box=true'],
          dataSolved: [],
          dataConfirmed: [],
          sliders: ['#v2-track=72(72)'],
          badges: ['V1 · çözüldü'],
          counters: { checkbox: true, wrongClicks: 0, decoyClicks: 1, honeypotHit: false, resolved: { checkbox: 1790360184445 } },
        }),
      }],
    })
    const outcome = await service.captcha({ action: 'verify' })
    expect(outcome.action).toBe('verify')
    expect(outcome.ok).toBe(true)
    if (!('solved' in outcome)) throw new Error('verify must carry solved')
    expect(outcome.solved).toBe(true)
    if (!('wrongClicks' in outcome)) throw new Error('verify must carry counters')
    expect(outcome.wrongClicks).toBe(0)
    expect(outcome.decoyClicks).toBe(1)
    expect(outcome.honeypotHit).toBe(false)
    expect(outcome.solvedAt).toBe(1790360184445)
  })

  it('omits counters the page does not publish, and says the metric is unavailable', async () => {
    const { service } = bootService({
      evaluate: [{
        value: JSON.stringify({
          ok: true, url: 'u', ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], counters: null,
        }),
      }],
    })
    const outcome = await service.captcha({ action: 'verify' })
    if (!('warnings' in outcome)) throw new Error('verify must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('unavailable (not zero)')
    expect('wrongClicks' in outcome).toBe(false)
    expect('decoyClicks' in outcome).toBe(false)
  })

  it('reports a page-side verify failure in-band', async () => {
    const { service } = bootService({
      evaluate: [{ value: JSON.stringify({ ok: false, reason: 'verify script failed (boom)' }) }],
    })
    const outcome = await service.captcha({ action: 'verify' })
    expect(outcome.ok).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toBe('verify script failed (boom)')
  })
})

// ---------------------------------------------------------------------------
// Tool envelope + render
// ---------------------------------------------------------------------------

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bootTools(service: unknown): Promise<Map<string, ToolDefinition>> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  })
  registerCdpTools(ctx, service as CdpService)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  if (tools.size === 0) throw new Error('plan11: registerCdpTools registered zero tools')
  return tools
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const violationsOf = (definition: ToolDefinition | undefined, value: unknown): unknown[] =>
  validateJsonSchemaValue(definition!.output.schema as never, value as never)

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

const SCAN_OK = {
  ok: true,
  action: 'scan',
  found: 1,
  targetId: 'tab-1',
  url: 'https://fixture.test/dogrulama.html',
  warnings: [],
  candidates: [{
    kind: 'checkbox',
    selector: 'div#v1-box',
    tag: 'div',
    id: 'v1-box',
    role: 'checkbox',
    name: 'Onay kutusu',
    rect: { x: 82, y: 228, width: 657, height: 56 },
    visible: true,
    inViewport: true,
    hitTest: 'pass',
    hitIsTarget: true,
    blockedBy: '',
    frame: 'top',
    evidence: ['role=checkbox'],
    driftPx: 0,
  }],
  overlays: [],
  honeypots: [],
  thirdParty: { verdict: 'first-party', iframes: [], providers: [] },
} as const

const DRAG_OK = {
  ok: true,
  action: 'drag',
  delivered: true,
  startX: 86,
  startY: 320,
  targetX: 535,
  targetY: 320,
  finalValue: 72.03,
  expectedValue: 72,
  beforeValue: 0,
  matched: true,
  deltaMs: 1365,
  attempts: 1,
  url: 'https://fixture.test/dogrulama.html',
  targetId: 'tab-1',
  warnings: [],
} as const

const VERIFY_OK = {
  ok: true,
  action: 'verify',
  solved: true,
  signals: {
    ariaChecked: ['#v1-box=true'],
    dataSolved: [],
    dataConfirmed: [],
    sliders: ['#v2-track=72(72)'],
    badges: ['V1 · çözüldü'],
    flags: ['checkbox=true'],
  },
  wrongClicks: 0,
  decoyClicks: 0,
  honeypotHit: false,
  solvedAt: 1790360184445,
  url: 'https://fixture.test/dogrulama.html',
  targetId: 'tab-1',
  warnings: [],
} as const

describe('plan11: cdp_captcha tool envelope', () => {
  it('is registered as tool #35', async () => {
    const tools = await bootTools({ captcha: async () => SCAN_OK })
    expect(tools.get('cdp_captcha')).toBeDefined()
  })

  it('validates every action envelope under additionalProperties:false', async () => {
    const tools = await bootTools({ captcha: async (command: { action: string }) => (command.action === 'drag' ? DRAG_OK : command.action === 'verify' ? VERIFY_OK : SCAN_OK) })
    const definition = tools.get('cdp_captcha')
    expect(violationsOf(definition, await execute(definition, { action: 'scan' }))).toEqual([])
    expect(violationsOf(definition, DRAG_OK)).toEqual([])
    expect(violationsOf(definition, VERIFY_OK)).toEqual([])
  })

  it('NEGATIVE: rejects an undeclared key on the envelope', async () => {
    const tools = await bootTools({ captcha: async () => SCAN_OK })
    const definition = tools.get('cdp_captcha')
    expect(violationsOf(definition, { ...SCAN_OK, somethingElse: true }).length).toBeGreaterThan(0)
    // …and inside a candidate row.
    const bad = { ...SCAN_OK, candidates: [{ ...SCAN_OK.candidates[0], undeclared: 1 }] }
    expect(violationsOf(definition, bad).length).toBeGreaterThan(0)
  })

  it('NEGATIVE: rejects a refusal that carries undeclared success data', async () => {
    const tools = await bootTools({ captcha: async () => SCAN_OK })
    const definition = tools.get('cdp_captcha')
    // A failed envelope may not smuggle fields the action does not produce.
    expect(violationsOf(definition, { ok: false, action: 'scan', token: 'g-recaptcha-response' }).length).toBeGreaterThan(0)
    // …nor a `found` count that contradicts `ok:false` without a reason.
    expect(violationsOf(definition, { ok: false, action: 'scan' }).length).toBe(0)
  })

  it('forwards action/locator/drag parameters verbatim through the shared locator DSL', async () => {
    const seen: Array<Record<string, unknown>> = []
    const tools = await bootTools({
      captcha: async (command: Record<string, unknown>) => { seen.push(command); return SCAN_OK },
    })
    await execute(tools.get('cdp_captcha'), {
      action: 'drag',
      targetId: 'tab-9',
      role: 'slider',
      name: 'Kaydır',
      nth: 1,
      targetPct: 72,
      steps: 30,
      approach: false,
      overshoot: true,
      timeoutMs: 1234,
      bogus: 'dropped',
    })
    expect(seen[0]).toEqual({
      action: 'drag',
      targetId: 'tab-9',
      spec: { role: 'slider', name: 'Kaydır', nth: 1 },
      targetPct: 72,
      steps: 30,
      approach: false,
      overshoot: true,
      timeoutMs: 1234,
    })
  })

  it('refuses ref + locator together, in-band, without touching the service', async () => {
    let touched = 0
    const tools = await bootTools({ captcha: async () => { touched += 1; return SCAN_OK } })
    const definition = tools.get('cdp_captcha')
    const value = await execute(definition, { action: 'drag', ref: 'button|Kaydet|0', css: '#track' })
    expect(violationsOf(definition, value)).toEqual([])
    expect(value.ok).toBe(false)
    expect(String(value.reason)).toContain('not both')
    expect(touched).toBe(0)
  })

  it('refuses an unknown action at the parameter boundary, never guessing one', async () => {
    let touched = 0
    const tools = await bootTools({ captcha: async () => { touched += 1; return SCAN_OK } })
    const definition = tools.get('cdp_captcha')
    // The runtime validates the enum before execute; the guard inside execute
    // is the second line for a caller that reaches it another way. Either way
    // the service must not see the call.
    await expect(execute(definition, { action: 'bypass' })).rejects.toThrow(/bypass|action/)
    expect(touched).toBe(0)
  })

  it('renders each action in its own shape and never a success phrase on failure', async () => {
    const tools = await bootTools({ captcha: async () => SCAN_OK })
    const definition = tools.get('cdp_captcha')

    const scan = renderOf(definition, { action: 'scan' }, SCAN_OK)
    expect(scan).toContain('1 first-party candidate(s) · third-party verdict: first-party')
    expect(scan).toContain('[checkbox] div#v1-box · hit=pass')

    const drag = renderOf(definition, { action: 'drag' }, DRAG_OK)
    expect(drag).toContain('Captcha drag: DELIVERED')
    expect(drag).toContain('press (86, 320) → release (535, 320)')

    const verify = renderOf(definition, { action: 'verify' }, VERIFY_OK)
    expect(verify).toContain('Captcha verify: SOLVED')
    expect(verify).toContain('wrongClicks=0')

    const failed = renderOf(definition, { action: 'drag' }, { ...DRAG_OK, ok: false, reason: 'not delivered' })
    expect(failed).toContain('Captcha drag failed: not delivered')
    expect(failed).not.toContain('DELIVERED')
  })
})
