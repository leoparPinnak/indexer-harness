/**
 * @deepseek-ai/dsh-cdp/drag — plan11 Katman B: the press-move-release
 * protocol `cdp_captcha({action:'drag'})` dispatches.
 *
 * T6 §3.4 / §3.5 recorded why this exists: the bundle had no drag primitive, so
 * the slider had to be solved with a page-side `dispatchEvent` — synthetic
 * input the page could tell apart from a person. This module sends REAL
 * `Input.dispatchMouseEvent` traffic (mousePressed → mouseMoved\* → mouseReleased)
 * over the flattened session, which is the same channel `cdp_click` uses and the
 * only one a page's `isTrusted` check accepts.
 *
 * The plan itself is PURE (see `captcha.ts` → {@link buildDragPlan}); this file
 * only dispatches it. Two properties it guarantees:
 * - the release is ALWAYS attempted, even when a move fails mid-gesture, so a
 *   drag can never leave the button held down on the page;
 * - every delay reads the injected clock/sleep, so a spec runs without
 *   wall-clock waits.
 *
 * @module @deepseek-ai/dsh-cdp/drag
 */

import type { CaptchaPoint, DragPlan } from './captcha.ts'

/**
 * The subset of a CDP connection the drag reads. Same narrow shape `input.ts`
 * uses, so an in-process fake exercises the whole gesture.
 */
export interface DragConnection {
  /**
   * Send one CDP command.
   * @param method - CDP method name, here always `Input.dispatchMouseEvent`.
   * @param params - protocol parameters.
   * @param sessionId - flattened target session to route through.
   * @returns the reply's `result` object.
   */
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

/** Mouse buttons the drag can hold; slider dragging is always `left`. */
export type DragButton = 'left' | 'right' | 'middle'

/** `Input.dispatchMouseEvent.buttons` bit per button (input.ts's own table). */
const BUTTON_BITS: Readonly<Record<DragButton, number>> = { left: 1, right: 2, middle: 4 }

/** Shortest settle after a sample, in milliseconds. */
export const MIN_SAMPLE_DELAY_MS = 8

/** Longest settle after a sample, in milliseconds. */
export const MAX_SAMPLE_DELAY_MS = 24

/** Shortest hover dwell before the press, in milliseconds. */
export const MIN_APPROACH_DWELL_MS = 60

/** Longest hover dwell before the press, in milliseconds. */
export const MAX_APPROACH_DWELL_MS = 180

/**
 * plan11-fix-drag-deliver: a press→release span at or below this many CSS
 * pixels dispatched no meaningful travel.
 *
 * The live failure this bounds: a thumb already sitting on (or within a pixel
 * of) the requested release point makes the whole plan degenerate — the press
 * and the release land on the same coordinate, the path still reports 24
 * samples, and the envelope looked complete while the gesture dragged nothing.
 * 2px is the point below which the pointer did not go anywhere a person could
 * have meant; a track with real travel asks for tens of pixels at minimum.
 */
export const DRAG_COLLAPSE_MAX_PX = 2

/**
 * plan11-fix-drag-time. How long one mouse MOVE waits for its protocol
 * acknowledgement before the gesture stops waiting at all.
 *
 * The measured failure this bounds (24 samples, live browser, 3 runs):
 *   32 of 34 `Input.dispatchMouseEvent` calls took 5001–5018 ms — mean 4699 ms —
 *   while `mousePressed` took 1–2 ms and `mouseReleased` 25 ms, on the SAME
 *   connection, in the SAME gesture. The cause is not this module: the page
 *   reported `document.visibilityState === "hidden"`, and a renderer that is
 *   not producing frames never acks the compositor side of a mouse MOVE, so
 *   Chrome's input pipeline waits out its fixed 5-second ack timeout per move.
 *   24 samples × 5 s is the 71–156 s the live runs measured.
 *
 * The events are still DELIVERED while that ack is outstanding — they are
 * written to the socket in order and the renderer drains them — so waiting for
 * the move ack buys nothing except 5 seconds per sample. The press and the
 * release keep waiting: they are fast, and the release's reply is the proof the
 * gesture reached the page.
 */
export const MOVE_ACK_PROBE_MS = 40


/** One dispatched mouse event, as the test fake recorded it. */
export interface DragEvent {
  /** Protocol `type`: `mouseMoved`, `mousePressed`, `mouseReleased`. */
  readonly type: string
  /** Horizontal coordinate in CSS pixels. */
  readonly x: number
  /** Vertical coordinate in CSS pixels. */
  readonly y: number
  /** Button field (`'none'`, `'left'`, …). */
  readonly button: string
  /** Held-button mask. */
  readonly buttons: number
  /** Protocol click count. */
  readonly clickCount: number
}

/** What one dispatched gesture reported. */
export interface DragDispatchResult {
  /** `Input.dispatchMouseEvent` calls dispatched. */
  readonly events: number
  /** Milliseconds the gesture took, per the injected clock. */
  readonly deltaMs: number
  /** True when the release reached the browser without a protocol error. */
  readonly released: boolean
  /**
   * plan11-fix-drag-time: mouse moves whose protocol reply was still outstanding
   * when the gesture finished. `0` on a page that is producing frames; a
   * hidden/occluded tab reports every move here — the events were dispatched in
   * order, Chrome simply does not ack a move it never composites.
   */
  readonly unackedMoves: number
  /** Every dispatched event, in order (the test seam). */
  readonly trace: readonly DragEvent[]
  /** The failure line when a send threw; absent on a clean gesture. */
  readonly error?: string
}

/**
 * plan11-fix-drag-time: one in-flight mouse-move acknowledgement.
 *
 * The move is sent and the promise is kept, never awaited inline. `settled`
 * flips in the promise's own handler, so the loop can read the outcome later
 * without a second round trip — and an un-acked move is a value, not a hang.
 */
interface MoveAck {
  settled: boolean
  ok: boolean
  error: string
}


/**
 * plan11-fix-drag-deliver: the distance the DISPATCHED gesture actually
 * travelled — press point to release point, read off the trace rather than off
 * the plan, because the trace is what actually went over the wire.
 *
 * This is the measurement that catches a collapsed gesture. The plan can be
 * fully built, every sample dispatched, the release delivered, and the total
 * press→release span still be ~0px when the thumb already sits where the plan
 * wanted to release it. A plan-only check cannot see that (the path has samples
 * either way); the dispatched coordinates can.
 * @param trace - the events {@link dispatchDrag} recorded, in order.
 * @returns the press→release distance in CSS pixels, or `undefined` when the
 *   trace holds no complete press→release pair. An incomplete gesture is NOT a
 *   collapsed one — a press that never landed, or a release that never went
 *   out, is a failed gesture and is reported as such.
 */
export function dispatchedSpanPx(trace: readonly DragEvent[]): number | undefined {
  const press = trace.find(event => event.type === 'mousePressed')
  const release = trace.find(event => event.type === 'mouseReleased')
  if (press === undefined || release === undefined) return undefined
  return Math.hypot(release.x - press.x, release.y - press.y)
}

/** Options {@link dispatchDrag} honours. */
export interface DragDispatchOptions {
  /** Flattened session every event is routed to. */
  readonly sessionId: string
  /** Which button to hold. */
  readonly button?: DragButton
  /** Millisecond clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Sleep used between samples; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Deterministic `[0, 1)` source for the dwell. The PATH is already
   * deterministic (it comes from the plan); only the pre-press dwell needs one.
   */
  readonly random?: () => number
  /** Skip the K4 approach path (the press point becomes the origin). */
  readonly approach?: boolean
  /**
   * plan11-fix-drag-time: watch each mouse move's acknowledgement at all.
   * `true` (the default) pays at most ONE bounded probe per gesture — enough to
   * see a refusal, and free on a page that produces frames. `false` dispatches
   * every move without looking, for a caller that wants no wait whatsoever.
   */
  readonly awaitMoveAck?: boolean
  /**
   * K2 — called after the drag path completes and BEFORE the release, with the
   * button still held. Return a FRESH point to release at instead of the
   * planned one; return `null` to keep the plan. T6 §3.4 is the reason: a
   * window resize between plan and release moved the track and the first drag
   * landed on 74 instead of 72.
   */
  readonly retarget?: () => Promise<CaptchaPoint | null>
}

/**
 * Dispatch one slider gesture from a pure plan.
 *
 * Sequence: (optional) approach samples → dwell → `mousePressed` at the thumb
 * centre → hold → drag samples with `buttons` held → `mouseReleased` at the
 * final sample. The release runs in a `finally`, so a throw mid-move still
 * lifts the button; `released` then reports whether that release itself got
 * through, which is what separates "the gesture reached the page" from "the
 * page is now stuck with a held mouse button".
 * @param connection - connection to send on.
 * @param plan - the pure plan from `buildDragPlan`.
 * @param options - session, button, and the clock/sleep/random seams.
 * @returns the event count, duration, release verdict, and the full trace.
 */
export async function dispatchDrag(
  connection: DragConnection,
  plan: DragPlan,
  options: DragDispatchOptions,
): Promise<DragDispatchResult> {
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const random = options.random ?? Math.random
  const button = options.button ?? 'left'
  const bits = BUTTON_BITS[button]
  const started = now()
  const trace: DragEvent[] = []
  let events = 0
  let error: string | undefined
  /**
   * Dispatch one mouse event.
   *
   * `button` and `buttons` are DIFFERENT protocol fields and this is where a
   * drag silently dies:
   *  - `button` names the button THIS event acts on — `left` on the press,
   *    `left` on every move, **`left` on the release**, and `none` only for a
   *    plain hover move where no button is involved;
   *  - `buttons` is the bitmask of what is currently held — `1` from the press
   *    until the release, `0` on the release itself and on hover moves.
   *
   * A `mouseReleased` sent with `button:'none'` is "release a button that is
   * not held": Chrome accepts the call, `dispatchMouseEvent` reports success,
   * and the page never receives a `mouseup`. A live T7 run showed exactly that
   * — `mousedown` arrived (the thumb followed the pointer), `mouseup` did not,
   * so the page's release handler never ran. `clickCount: 1` is required on
   * BOTH the press and the release, matching what `HumanInput.click` sends.
   */
  const send = async (
    type: string,
    point: CaptchaPoint,
    held: number,
    clickCount: number,
    actingButton: DragButton | 'none' = held === 0 ? 'none' : button,
  ): Promise<void> => {
    await connection.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: actingButton,
      buttons: held,
      clickCount,
      modifiers: 0,
      timestamp: (now() / 1000),
    }, options.sessionId)
    trace.push({ type, x: point.x, y: point.y, button: actingButton, buttons: held, clickCount })
    events += 1
  }

  /* plan11-fix-drag-time — a mouse MOVE is dispatched, never awaited inline.
   *
   * The measured cost of awaiting one: on a hidden/occluded tab Chrome waits
   * out a fixed 5-second compositor ack per move (32 of 34 calls at 5001–5018 ms
   * in the live run), so a 24-sample plan spent 71–156 s waiting for replies
   * that carry no information. The frame still reaches the renderer while that
   * ack is outstanding, and the socket preserves order, so the gesture only has
   * to LEARN the outcome — it does not have to wait for it to start the next
   * step. The press and the release keep their full await: both are fast, and
   * the release's reply is the proof the gesture landed. */
  let unackedMoves = 0
  // A page that produces frames acks in microseconds, so ONE bounded probe is
  // enough to tell "slow" from "never"; after that the gesture stops paying.
  let ackProbeOpen = options.awaitMoveAck !== false

  const sendMove = (
    point: CaptchaPoint,
    held: number,
    clickCount: number,
    actingButton: DragButton | 'none',
  ): MoveAck => {
    const ack: MoveAck = { settled: false, ok: false, error: '' }
    const sent = connection.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: actingButton,
      buttons: held,
      clickCount,
      modifiers: 0,
      timestamp: (now() / 1000),
    }, options.sessionId)
    // The handler is attached synchronously, so a refusal can never surface as
    // an unhandled rejection after the gesture has moved on.
    void Promise.resolve(sent).then(
      () => { ack.settled = true; ack.ok = true },
      (thrown: unknown) => {
        ack.settled = true
        ack.ok = false
        ack.error = thrown instanceof Error ? thrown.message : String(thrown)
      },
    )
    trace.push({ type: 'mouseMoved', x: point.x, y: point.y, button: actingButton, buttons: held, clickCount })
    events += 1
    return ack
  }

  /**
   * Learn one move's outcome. Throws when the protocol REFUSED it (the old
   * contract: a refused move stops the path and the release still runs), and
   * reports an outstanding ack as data instead of a failure.
   */
  const observeMove = async (ack: MoveAck): Promise<void> => {
    if (ack.settled) {
      if (!ack.ok) throw new Error(ack.error)
      return
    }
    if (!ackProbeOpen) {
      unackedMoves += 1
      return
    }
    // The planned per-sample delay already ran; this is the only extra wait, and
    // it is paid at most once per gesture.
    await sleep(MOVE_ACK_PROBE_MS)
    ackProbeOpen = false
    if (ack.settled) {
      if (!ack.ok) throw new Error(ack.error)
      return
    }
    unackedMoves += 1
  }

  // K4: walk in before pressing, so the pointer never teleports onto the thumb.
  // A failure here is reported, not thrown: the caller gets a `released:false`
  // envelope instead of an exception it has to re-classify.
  const approach = options.approach === false ? [] : plan.approachPath
  try {
    for (const point of approach) {
      const ack = sendMove(point, 0, 0, 'none')
      await sleep(MIN_SAMPLE_DELAY_MS + random() * (MAX_SAMPLE_DELAY_MS - MIN_SAMPLE_DELAY_MS))
      await observeMove(ack)
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  if (error === undefined && approach.length > 0) {
    await sleep(MIN_APPROACH_DWELL_MS + random() * (MAX_APPROACH_DWELL_MS - MIN_APPROACH_DWELL_MS))
  }
  if (error !== undefined) {
    // Nothing was pressed, so there is nothing to release.
    return { events, deltaMs: now() - started, released: false, unackedMoves, trace, error }
  }

  // A refusal to press is final — there is nothing to release.
  try {
    await send('mousePressed', plan.start, bits, 1, button)
  } catch (thrown) {
    return { events, deltaMs: now() - started, released: false, unackedMoves, trace, error: thrown instanceof Error ? thrown.message : String(thrown) }
  }
  await sleep(plan.holdMs)

  let cursor = plan.start
  try {
    for (const [index, point] of plan.dragPath.entries()) {
      const ack = sendMove(point, bits, 0, button)
      cursor = point
      await sleep(plan.delaysMs[index] ?? MIN_SAMPLE_DELAY_MS)
      await observeMove(ack)
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  // The release is unconditional: a failed move must never leave the button down.
  let released = false
  try {
    let last = plan.dragPath[plan.dragPath.length - 1] ?? cursor
    // K2: a fresh re-measure may move the target; take it before the release.
    if (options.retarget !== undefined) {
      try {
        const fresh = await options.retarget()
        if (fresh !== null && (fresh.x !== last.x || fresh.y !== last.y)) {
          const ack = sendMove(fresh, bits, 0, button)
          last = fresh
          // A refused re-aim is reported and the release still goes out: the
          // pointer is already at the fresh point, only the ack is missing.
          try {
            await observeMove(ack)
          } catch (thrown) {
            error = error ?? (thrown instanceof Error ? thrown.message : String(thrown))
          }
        }
      } catch (thrown) {
        error = error ?? `retarget failed (${thrown instanceof Error ? thrown.message : String(thrown)})`
      }
    }
    // `button` names the button this event releases, so it stays `left` even
    // though `buttons` (the held mask) drops to 0 here.
    await send('mouseReleased', last, 0, 1, button)
    released = true
  } catch (thrown) {
    error = error ?? (thrown instanceof Error ? thrown.message : String(thrown))
  }

  return {
    events,
    deltaMs: now() - started,
    released,
    unackedMoves,
    trace,
    ...(error !== undefined ? { error } : {}),
  }
}
