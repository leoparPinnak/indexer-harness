/**
 * plan11 Katman B: `dispatchDrag` — the REAL CDP press-move-release flow.
 *
 * T6 §3.5 is the reason this file exists: with no drag primitive in the bundle,
 * the slider had to be solved with a page-side `dispatchEvent`, i.e. synthetic
 * input a page can tell apart from a person. The contract pinned here is
 * therefore (a) every gesture is `Input.dispatchMouseEvent` on the flattened
 * session, (b) the ORDER is approach → dwell → press → hold → moves → release,
 * (c) the held-button mask stays set on every move and is cleared only on the
 * release, and (d) a throw mid-move still releases — a drag must never leave a
 * mouse button held on the page.
 *
 * plan11-fix-drag-deliver adds the VERDICT layer on top of that protocol
 * layer, asserted against the same recorded payloads: a gesture whose press and
 * release are the same coordinate delivered NOTHING, and the envelope must say
 * so instead of borrowing an unrelated `data-done` flip as its proof. The old
 * "something changed" gate turned exactly that case into a silent success.
 *
 * No browser, no wall clock: the connection, clock, sleep, and random source
 * are all injected.
 */

import { describe, expect, it } from 'vitest'
import {
  dispatchDrag, dispatchedSpanPx, DRAG_COLLAPSE_MAX_PX,
  type DragConnection, type DragEvent,
} from '../src/drag.ts'
import { buildDragPlan, seededSource, type SliderGeometry } from '../src/captcha.ts'
import { CdpService } from '../src/service.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GEOMETRY: SliderGeometry = {
  track: { x: 66, y: 300, width: 664, height: 40 },
  thumb: { x: 69, y: 303, width: 34, height: 34 },
  currentPct: 0,
  viewport: { width: 754, height: 480 },
  inset: 3,
}

/** A connection that records the `Input.dispatchMouseEvent` calls. */
function recorder(options: { failOn?: string } = {}): { connection: DragConnection, sent: DragEvent[] } {
  const sent: DragEvent[] = []
  const connection: DragConnection = {
    send: async (method, params, sessionId) => {
      expect(method).toBe('Input.dispatchMouseEvent')
      expect(sessionId).toBe('s-1')
      const type = String(params.type)
      if (options.failOn === type) throw new Error(`protocol refused ${type}`)
      sent.push({
        type,
        x: Number(params.x),
        y: Number(params.y),
        button: String(params.button),
        buttons: Number(params.buttons),
        clickCount: Number(params.clickCount),
      })
      return {}
    },
  }
  return { connection, sent }
}

/** A clock that advances by a fixed step per read; no wall time at all. */
function fakeClock(step = 5): () => number {
  let now = 1_000
  return () => { now += step; return now }
}

const noSleep = async (): Promise<void> => {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan11: dispatchDrag event order', () => {
  it('sends a real mousePressed/mouseMoved/mouseReleased sequence on the session', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'order' })
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1',
      now: fakeClock(),
      sleep: noSleep,
      random: seededSource('order', 'dwell'),
    })

    const types = sent.map(event => event.type)
    expect(types[0]).toBe('mouseMoved')
    expect(types).toContain('mousePressed')
    expect(types).toContain('mouseMoved')
    expect(types[types.length - 1]).toBe('mouseReleased')
    // Exactly one press and one release, in that order.
    expect(types.filter(type => type === 'mousePressed')).toHaveLength(1)
    expect(types.filter(type => type === 'mouseReleased')).toHaveLength(1)
    expect(types.indexOf('mousePressed')).toBeLessThan(types.lastIndexOf('mouseReleased'))
    expect(result.released).toBe(true)
    expect(result.events).toBe(sent.length)
  })

  it('holds the button on every drag move and clears it only on the release', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'mask' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })

    const pressIndex = sent.findIndex(event => event.type === 'mousePressed')
    const releaseIndex = sent.findIndex(event => event.type === 'mouseReleased')
    expect(sent[pressIndex]?.buttons).toBe(1)
    expect(sent[pressIndex]?.button).toBe('left')
    expect(sent[pressIndex]?.clickCount).toBe(1)
    for (const event of sent.slice(pressIndex + 1, releaseIndex)) {
      expect(event.buttons, `move at (${String(event.x)},${String(event.y)}) must keep the button held`).toBe(1)
    }
    expect(sent[releaseIndex]?.buttons).toBe(0)
    expect(sent[releaseIndex]?.clickCount).toBe(1)
    // The approach moves BEFORE the press carry no button at all.
    for (const event of sent.slice(0, pressIndex)) {
      expect(event.buttons).toBe(0)
      expect(event.button).toBe('none')
    }
  })

  it('presses at the thumb centre and releases exactly on the planned target', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'points' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })

    const press = sent.find(event => event.type === 'mousePressed')!
    const release = sent.find(event => event.type === 'mouseReleased')!
    expect(press.x).toBe(plan.start.x)
    expect(press.y).toBe(plan.start.y)
    expect(release.x).toBe(plan.target.x)
    expect(release.y).toBe(plan.target.y)
  })

  it('releases at the FRESH retarget point when the track drifted (K2)', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'drift' })
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1',
      now: fakeClock(),
      sleep: noSleep,
      random: () => 0.5,
      // T6 §3.4: the window resized, the track moved 14px right.
      retarget: async () => ({ x: plan.target.x + 14, y: plan.target.y }),
    })
    const release = sent.find(event => event.type === 'mouseReleased')!
    expect(release.x).toBe(plan.target.x + 14)
    expect(result.released).toBe(true)
  })

  it('keeps the planned release point when the re-measure fails', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'keep' })
    await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5,
      retarget: async () => null,
    })
    expect(sent.find(event => event.type === 'mouseReleased')?.x).toBe(plan.target.x)
  })

  it('can skip the K4 approach path on request', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'noapproach' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5, approach: false })
    expect(sent[0]?.type).toBe('mousePressed')
  })
})

describe('plan11: the CDP payload contract (what we actually send)', () => {
  // A live T7 run is the reason this block exists. The gesture looked perfect in
  // the envelope (DELIVERED, matched=true) while the page never received a
  // `mouseup`: every event derived `button` from the held mask, so the release
  // carried `button:'none'` — "release a button that is not held". Chrome
  // accepts the call, `dispatchMouseEvent` reports success, and no `mouseup` is
  // produced. A fake connection cannot observe that, so the contract is pinned
  // HERE, on the payload — the part a spec can actually assert.
  it('sends button:left + clickCount:1 on the press, and the SAME on the release', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'payload' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })

    const press = sent.find(event => event.type === 'mousePressed')!
    const release = sent.find(event => event.type === 'mouseReleased')!
    expect(press.button).toBe('left')
    expect(press.buttons).toBe(1)
    expect(press.clickCount).toBe(1)
    // The release MUST still name the button it releases; only the mask drops.
    expect(release.button).toBe('left')
    expect(release.buttons).toBe(0)
    expect(release.clickCount).toBe(1)
  })

  it('never sends button:none on any press, move, or release', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'none-check' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    // 'none' is legitimate ONLY on a hover move, before anything is pressed.
    for (const event of sent) {
      if (event.button === 'none') {
        expect(event.buttons, `button:none is only valid with nothing held (${event.type})`).toBe(0)
        expect(event.type).toBe('mouseMoved')
      }
    }
    const afterPress = sent.slice(sent.findIndex(event => event.type === 'mousePressed'))
    expect(afterPress.length).toBeGreaterThan(0)
    expect(afterPress.every(event => event.button === 'left')).toBe(true)
  })

  it('carries the full protocol payload on every event', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const connection: DragConnection = {
      send: async (method, params) => {
        expect(method).toBe('Input.dispatchMouseEvent')
        payloads.push(params)
        return {}
      },
    }
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, steps: 8, seed: 'fields' })
    await dispatchDrag(connection, plan, { sessionId: 's-7', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    expect(payloads.length).toBeGreaterThan(8)
    for (const payload of payloads) {
      expect(typeof payload.x).toBe('number')
      expect(typeof payload.y).toBe('number')
      expect(typeof payload.buttons).toBe('number')
      expect(typeof payload.clickCount).toBe('number')
      expect(typeof payload.modifiers).toBe('number')
      expect(typeof payload.timestamp).toBe('number')
    }
  })

  it('sends the retarget move WITH the button held', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'rt-payload' })
    await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5,
      retarget: async () => ({ x: plan.target.x + 12, y: plan.target.y }),
    })
    const lastMove = sent.filter(event => event.type === 'mouseMoved').at(-1)!
    expect(lastMove.button).toBe('left')
    expect(lastMove.buttons).toBe(1)
  })
})

describe('plan11: dispatchDrag never leaves a button held', () => {
  it('releases even when a move throws mid-gesture, and says so', async () => {
    // Fail only the DRAG moves, not the approach: a held button must be lifted.
    const { connection, sent } = {
      ...recorder(),
    }
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'throw' })
    let pressed = false
    const failing: DragConnection = {
      send: async (method, params, sessionId) => {
        const type = String(params.type)
        if (type === 'mousePressed') pressed = true
        if (pressed && type === 'mouseMoved') throw new Error('protocol refused mouseMoved')
        await connection.send(method, params, sessionId)
        return {}
      },
    }
    const result = await dispatchDrag(failing, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    // The move failed, but the release still went out…
    expect(sent.some(event => event.type === 'mouseReleased')).toBe(true)
    // …the caller is told, and the failure is not swallowed.
    expect(result.error).toContain('protocol refused mouseMoved')
  })

  it('reports released:false and never throws when the APPROACH fails', async () => {
    const { connection } = recorder({ failOn: 'mouseMoved' })
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'approachfail' })
    const result = await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    // Nothing was pressed, so nothing had to be released — and the refusal is
    // reported as data instead of escaping as an exception.
    expect(result.released).toBe(false)
    expect(result.error).toContain('protocol refused mouseMoved')
  })

  it('reports released:false when the RELEASE itself cannot be delivered', async () => {
    const { connection } = recorder({ failOn: 'mouseReleased' })
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'relfail' })
    const result = await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    expect(result.released).toBe(false)
    expect(result.error).toContain('protocol refused mouseReleased')
  })

  it('keeps a retarget failure non-fatal — the planned release still happens', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'rtfail' })
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5,
      retarget: async () => { throw new Error('measure failed') },
    })
    expect(sent.find(event => event.type === 'mouseReleased')?.x).toBe(plan.target.x)
    expect(result.released).toBe(true)
    expect(result.error).toContain('retarget failed (measure failed)')
  })
})

describe('plan11: dispatchDrag timing', () => {
  it('measures its duration from the injected clock, not the wall clock', async () => {
    const { connection } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'time' })
    const run = async (): Promise<number> => {
      let clock = 0
      const result = await dispatchDrag(connection, plan, {
        sessionId: 's-1',
        now: () => { clock += 10; return clock },
        sleep: async () => { clock += 1 },
        random: () => 0.5,
      })
      return result.deltaMs
    }
    const first = await run()
    expect(first).toBeGreaterThan(0)
    // Same plan, same seams ⇒ the same duration: the clock is the only input.
    expect(await run()).toBe(first)
  })

  it('sends an exact number of moves for a given step count', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, steps: 12, seed: 'count' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    // 12 drag samples + 1 press + 1 release + the approach path.
    const moves = sent.filter(event => event.type === 'mouseMoved').length
    expect(moves).toBe(plan.dragPath.length + plan.approachPath.length)
  })
})

describe('plan11-fix-drag-deliver: dispatchedSpanPx', () => {
  it('measures press → release, not the plan', async () => {
    const { connection, sent } = recorder()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'span' })
    await dispatchDrag(connection, plan, { sessionId: 's-1', now: fakeClock(), sleep: noSleep, random: () => 0.5 })
    const span = dispatchedSpanPx(sent)!
    expect(span).toBeCloseTo(Math.hypot(plan.target.x - plan.start.x, plan.target.y - plan.start.y), 5)
    expect(span).toBeGreaterThan(DRAG_COLLAPSE_MAX_PX)
  })

  it('reports 0 for a gesture that pressed and released on the same point', () => {
    const trace: DragEvent[] = [
      { type: 'mousePressed', x: 464, y: 301, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 463, y: 301, button: 'left', buttons: 0, clickCount: 1 },
    ]
    expect(dispatchedSpanPx(trace)).toBe(1)
    expect(dispatchedSpanPx(trace)!).toBeLessThanOrEqual(DRAG_COLLAPSE_MAX_PX)
  })

  it('is undefined for an INCOMPLETE gesture — never pressed is not "collapsed"', () => {
    expect(dispatchedSpanPx([{ type: 'mousePressed', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1 }])).toBeUndefined()
    expect(dispatchedSpanPx([{ type: 'mouseReleased', x: 10, y: 10, button: 'left', buttons: 0, clickCount: 1 }])).toBeUndefined()
    expect(dispatchedSpanPx([])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// plan11-fix-drag-deliver: the delivery criterion, end to end
// ---------------------------------------------------------------------------

/**
 * A `CdpService` whose page session answers a scripted measurement and whose
 * input connection records every `Input.dispatchMouseEvent` payload. Same
 * fakes the plan11 service spec uses, kept local here so this file can assert
 * the VERDICT against the bytes that actually went out.
 */
function bootDragService(replies: string[]): {
  service: CdpService
  sent: Array<{ method: string, params: Record<string, unknown> }>
} {
  const sent: Array<{ method: string, params: Record<string, unknown> }> = []
  let call = 0
  const connection = {
    endpoint: 'ws://127.0.0.1:0/fake',
    connected: true,
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      sent.push({ method, params })
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
      evaluate: async (): Promise<{ hasValue: boolean, truncated: boolean, value: string }> => {
        const value = replies[Math.min(call, replies.length - 1)]
        call += 1
        return { hasValue: true, truncated: false, value: value ?? '' }
      },
    }),
  })
  return { service, sent }
}

/**
 * A measurement of the shared fixture track: 664px wide, 34px thumb, 3px
 * inset ⇒ 624px of usable travel, and the thumb's LEFT edge sits at
 * `69 + pct × 6.24` (the resting 0% position is x=69, as the plan11 service
 * fixtures use). `pct` therefore places the thumb at any percent.
 * @param pct - the percent the thumb currently reads.
 * @param dataDone - the page's own `data-done` value, when it publishes one.
 * @returns the page-side measurement JSON.
 */
function measure(pct: number, dataDone = ''): string {
  return JSON.stringify({
    ok: true,
    track: { x: 66, y: 300, width: 664, height: 40 },
    thumb: { x: Math.round(69 + (pct / 100) * 624), y: 303, width: 34, height: 34 },
    currentPct: pct,
    declaredTarget: '20',
    viewport: { width: 754, height: 480 },
    reason: '',
    state: { ariaChecked: '', dataDone, dataSolved: '', dataConfirmed: '', value: '', thumbLeft: '', thumbData: [] },
  })
}

/** @param sent - the recorded protocol calls. @returns the mouse events. */
function mouseEvents(sent: Array<{ method: string, params: Record<string, unknown> }>): DragEvent[] {
  return sent
    .filter(call => call.method === 'Input.dispatchMouseEvent')
    .map(call => ({
      type: String(call.params.type),
      x: Number(call.params.x),
      y: Number(call.params.y),
      button: String(call.params.button),
      buttons: Number(call.params.buttons),
      clickCount: Number(call.params.clickCount),
    }))
}

describe('plan11-fix-drag-deliver: a collapsed gesture is NOT a delivery', () => {
  it('answers delivered:false with the collapse reason when the thumb already sits on the target', async () => {
    // The live failure, reproduced exactly: the thumb is already at 20%, the
    // requested target is 20%, so the plan's press and release are the SAME
    // coordinate — a 0px drag. The page's `data-done` then flips 0→1 for its
    // own reasons, which is the "evidence" the old gate used to call this a
    // success. Nothing about the requested target was ever applied.
    const { service, sent } = bootDragService([measure(20, '0'), measure(20, '0'), measure(20, '1')])
    const outcome = await service.captcha({ action: 'drag', targetPct: 20, approach: false, overshoot: false })
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')

    // The gesture really did collapse — asserted on the PAYLOAD, not the plan.
    const events = mouseEvents(sent)
    const span = dispatchedSpanPx(events)!
    const press = events.find(event => event.type === 'mousePressed')!
    const release = events.find(event => event.type === 'mouseReleased')!
    // Press is the thumb CENTRE and release is the requested point measured
    // with the same inset, so a thumb already on the target leaves a span of a
    // pixel or two — under the bound, and nowhere near a real drag.
    expect(span).toBeLessThanOrEqual(DRAG_COLLAPSE_MAX_PX)
    expect(Math.abs(release.x - press.x)).toBeLessThanOrEqual(DRAG_COLLAPSE_MAX_PX)

    // The page's own state change is what the old gate would have trusted.
    if (!('verifiedBy' in outcome)) throw new Error('drag must carry verifiedBy')
    expect(outcome.verifiedBy).toBe('state-changed')
    expect(outcome.stateDiffs).toContain('dataDone: 0 → 1')

    // …and it is still not a delivery.
    expect(outcome.ok).toBe(false)
    expect(outcome.delivered).toBe(false)
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('gesture collapsed: the thumb was already at/near the target, no movement was dispatched')
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('the dispatched gesture travelled')
    // One gesture, dispatched once: a collapsed drag is re-measured, never
    // blindly replayed.
    expect(outcome.attempts).toBe(1)
    expect(events.filter(event => event.type === 'mousePressed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'mouseReleased')).toHaveLength(1)
  })

  it('still reports the honest measurements of a collapsed gesture', async () => {
    const { service } = bootDragService([measure(20, '0'), measure(20, '0'), measure(20, '1')])
    const outcome = await service.captcha({ action: 'drag', targetPct: 20, approach: false, overshoot: false })
    if (!('delivered' in outcome) || !('matched' in outcome)) throw new Error('drag must carry the verdict fields')
    // `matched` is unchanged by this fix: the thumb WAS on the target (the
    // read-back lands within the 1.5% tolerance of where the finger was). The
    // collapse is what fails the drag — and the envelope says so rather than
    // pretending the read-back was wrong.
    expect(outcome.matched).toBe(true)
    expect(outcome.beforeValue).toBeCloseTo(20, 0)
    expect(outcome.finalValue).toBeCloseTo(20, 0)
    expect(outcome.expectedValue).toBe(20)
    expect(outcome.deltaMs).toBeGreaterThanOrEqual(0)
  })

  it('refuses a read-back that never reached the requested target, and names both numbers', async () => {
    // 20 was asked for, 67.6 is what the thumb reports: the gesture landed
    // somewhere else entirely. That is not delivery, whatever else changed.
    const { service } = bootDragService([measure(67.6, '0'), measure(67.6, '0'), measure(67.6, '1')])
    const outcome = await service.captcha({ action: 'drag', targetPct: 20, approach: false, overshoot: false })
    expect(outcome.ok).toBe(false)
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')
    expect(outcome.delivered).toBe(false)
    if (!('matched' in outcome)) throw new Error('drag must carry matched')
    expect(outcome.matched).toBe(false)
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).toContain('value did not reach the requested target')
    if (!('reason' in outcome)) throw new Error('a refusal must carry a reason')
    expect(outcome.reason).toContain('not delivered')
    expect(outcome.reason).toContain('20%')
  })
})

describe('plan11-fix-drag-deliver: a normal gesture still delivers', () => {
  it('answers delivered:true from a thumb that really travelled to the target', async () => {
    // Thumb at rest (0%), target 72%: the plan asks for ~450px of travel, the
    // gesture dispatches it, and the read-back lands on the target.
    const { service, sent } = bootDragService([measure(0), measure(0), measure(72)])
    const outcome = await service.captcha({ action: 'drag', targetPct: 72, approach: false, overshoot: false })
    if (!('delivered' in outcome)) throw new Error('drag must carry delivered')
    expect(outcome.ok).toBe(true)
    expect(outcome.delivered).toBe(true)
    if (!('matched' in outcome)) throw new Error('drag must carry matched')
    expect(outcome.matched).toBe(true)
    // A success carries NO reason key at all — a refusal always does.
    expect('reason' in outcome).toBe(false)
    if (!('warnings' in outcome)) throw new Error('drag must carry warnings')
    expect(outcome.warnings.join(' ')).not.toContain('did not reach the requested target')

    // The payload agrees: a real press → release span, well clear of the
    // collapse bound.
    const events = mouseEvents(sent)
    const span = dispatchedSpanPx(events)!
    expect(span).toBeGreaterThan(DRAG_COLLAPSE_MAX_PX)
    const pressed = events.find(event => event.type === 'mousePressed')!
    const released = events.find(event => event.type === 'mouseReleased')!
    expect(released.x).toBeGreaterThan(pressed.x)
    expect(outcome.attempts).toBe(1)
  })
})
