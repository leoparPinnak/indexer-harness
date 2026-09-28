/**
 * plan11-fix-drag-time: the drag took 71–156 s for a 24-sample gesture.
 *
 * Measured, not guessed (live browser, T7 fixture, `dispatchDrag` under a
 * per-command timer):
 *   24 approach+drag samples ⇒ 32 of 34 `Input.dispatchMouseEvent` calls took
 *   5001–5018 ms (mean 4699 ms). `mousePressed` took 1–2 ms and `mouseReleased`
 *   25 ms — on the same connection, in the same gesture. The page reported
 *   `document.visibilityState === "hidden"`: a renderer that is not compositing
 *   never acks the compositor side of a mouse MOVE, so Chrome waits out a fixed
 *   5-second ack timeout per move. 24 samples × 5 s is the whole defect. The
 *   8–24 ms human cadence in `MIN/MAX_SAMPLE_DELAY_MS` was never the cost.
 *
 * The contract this file pins is STRUCTURAL, not hardware-dependent: with a
 * clock that is injected, a gesture whose move acks NEVER arrive must still
 * finish inside the plan's own time budget, and the release — the one reply that
 * proves the gesture landed — must still be awaited.
 */

import { describe, expect, it } from 'vitest'
import {
  dispatchDrag,
  MAX_APPROACH_DWELL_MS,
  MAX_SAMPLE_DELAY_MS,
  MOVE_ACK_PROBE_MS,
  type DragConnection,
  type DragEvent,
} from '../src/drag.ts'
import { buildDragPlan, type SliderGeometry } from '../src/captcha.ts'

const GEOMETRY: SliderGeometry = {
  track: { x: 66, y: 300, width: 664, height: 40 },
  thumb: { x: 69, y: 303, width: 34, height: 34 },
  currentPct: 0,
  viewport: { width: 754, height: 480 },
  inset: 3,
}

/** A virtual clock: `now` reads it, `sleep` advances it. No wall clock at all. */
function virtualClock(): { now: () => number, sleep: (ms: number) => Promise<void>, elapsed: () => number } {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number): Promise<void> => { time += ms },
    elapsed: () => time,
  }
}

/**
 * The hidden-tab connection: a `mouseMoved` is dispatched and its reply NEVER
 * arrives (exactly what a 5-second compositor ack looks like from the caller's
 * side), while press and release answer immediately, as they do in the live run.
 */
function stallingConnection(options: { ackDelayMs?: number } = {}): {
  connection: DragConnection
  sent: DragEvent[]
  moves: number
} {
  const sent: DragEvent[] = []
  const state = { moves: 0 }
  const connection: DragConnection = {
    send: async (_method, params) => {
      const type = String(params.type)
      sent.push({
        type,
        x: Number(params.x),
        y: Number(params.y),
        button: String(params.button),
        buttons: Number(params.buttons),
        clickCount: Number(params.clickCount),
      })
      if (type !== 'mouseMoved') return {}
      state.moves += 1
      // A reply that would land 5000 ms later — and, in this test, never.
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { resolve({}) }, options.ackDelayMs ?? 60_000)
        void timer
      })
    },
  }
  return { connection, sent, moves: state.moves }
}

/** The plan's own time budget — what a 24-sample gesture costs when nothing stalls. */
function structuralBudget(plan: ReturnType<typeof buildDragPlan>): number {
  return (plan.approachPath.length + plan.dragPath.length) * MAX_SAMPLE_DELAY_MS
    + plan.holdMs
    + MAX_APPROACH_DWELL_MS
    + MOVE_ACK_PROBE_MS
}

describe('plan11-fix-drag-time: a stalled move ack cannot stall the gesture', () => {
  it('finishes inside the plan budget when every mouseMoved ack never arrives', async () => {
    const { connection, sent } = stallingConnection()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'stall' })
    const clock = virtualClock()
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1',
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    })

    const budget = structuralBudget(plan)
    expect(result.deltaMs, `gesture took ${String(result.deltaMs)}ms against a ${String(budget)}ms budget`).toBeLessThanOrEqual(budget)
    // The old cost, for the record: 32 stalled acks × 5000 ms.
    expect(result.deltaMs).toBeLessThan(5_000)
    // And the gesture is complete: every sample dispatched, button released.
    expect(result.released).toBe(true)
    expect(result.events).toBe(sent.length)
    expect(result.error).toBeUndefined()
    expect(sent.filter(event => event.type === 'mouseMoved')).toHaveLength(
      plan.dragPath.length + plan.approachPath.length,
    )
    expect(sent.at(-1)?.type).toBe('mouseReleased')
  })

  it('reports the outstanding acks as data, not as a failure', async () => {
    const { connection } = stallingConnection()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'unacked' })
    const clock = virtualClock()
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: clock.now, sleep: clock.sleep, random: () => 0.5,
    })
    expect(result.unackedMoves).toBe(plan.dragPath.length + plan.approachPath.length)
    expect(result.released).toBe(true)
  })

  it('reports zero un-acked moves on a page that does answer', async () => {
    const connection: DragConnection = { send: async () => ({}) }
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'acked' })
    const clock = virtualClock()
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: clock.now, sleep: clock.sleep, random: () => 0.5,
    })
    expect(result.unackedMoves).toBe(0)
    expect(result.released).toBe(true)
  })

  it('still refuses a move the protocol actually rejected, and still releases', async () => {
    let pressed = false
    const connection: DragConnection = {
      send: async (_method, params) => {
        const type = String(params.type)
        if (type === 'mousePressed') pressed = true
        if (pressed && type === 'mouseMoved') throw new Error('protocol refused mouseMoved')
        return {}
      },
    }
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'refused' })
    const clock = virtualClock()
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: clock.now, sleep: clock.sleep, random: () => 0.5,
    })
    expect(result.error).toContain('protocol refused mouseMoved')
    expect(result.released).toBe(true)
  })

  it('pays the bounded probe at most once per gesture', async () => {
    // Every ack answers, but only after the probe window: the gesture must not
    // re-open the probe per sample, or a slow page costs 40 ms × samples.
    let probeSleeps = 0
    const connection: DragConnection = {
      send: async (_method, params) => {
        if (String(params.type) === 'mouseMoved') await new Promise(resolve => { setTimeout(resolve, 5) })
        return {}
      },
    }
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'slowack' })
    const clock = virtualClock()
    await dispatchDrag(connection, plan, {
      sessionId: 's-1',
      now: clock.now,
      sleep: async (ms) => {
        if (ms === MOVE_ACK_PROBE_MS) probeSleeps += 1
        await clock.sleep(ms)
      },
      random: () => 0.5,
    })
    expect(probeSleeps).toBeLessThanOrEqual(1)
  })

  it('awaitMoveAck:false dispatches without looking at a single reply', async () => {
    const { connection } = stallingConnection()
    const plan = buildDragPlan(GEOMETRY, { targetPct: 72, seed: 'noack' })
    const clock = virtualClock()
    const result = await dispatchDrag(connection, plan, {
      sessionId: 's-1', now: clock.now, sleep: clock.sleep, random: () => 0.5, awaitMoveAck: false,
    })
    // No probe at all: the budget is the plan's own, untouched by the ack window.
    expect(result.deltaMs).toBeLessThanOrEqual(structuralBudget(plan) - MOVE_ACK_PROBE_MS)
    expect(result.released).toBe(true)
  })
})
