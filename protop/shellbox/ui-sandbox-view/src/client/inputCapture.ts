/**
 * Frame-pixel input capture for the sandbox pane: the conversions a rendered
 * `<img>` needs before its pointer and keyboard events become helper events,
 * and the batcher that keeps the request count low without reordering what the
 * desktop sees.
 *
 * The pane sends frame pixels; the helper owns the contained-fit inversion and
 * the window resolution, so nothing here knows about desktops or window handles.
 */

/** One event the host accepts, mirroring the sandbox input event union. */
export type CapturedInputEvent =
  | { readonly t: 'move'; readonly x: number; readonly y: number }
  | { readonly t: 'button'; readonly b: 'left' | 'right' | 'middle'; readonly p: 'down' | 'up' }
  | { readonly t: 'wheel'; readonly dx: number; readonly dy: number }
  | { readonly t: 'key'; readonly vk: number; readonly p: 'down' | 'up' }
  | { readonly t: 'char'; readonly c: number }

/** Events per request: the host refuses more than 64, so a flush leaves headroom. */
export const INPUT_BATCH_LIMIT = 60

/** Largest frame coordinate the host accepts on either axis. */
export const COORDINATE_LIMIT = 5120

/** Quiet period a pointer move waits for before it is delivered alone, in milliseconds. */
export const MOVE_COALESCE_MS = 40

/** One wheel line as a pixel delta, the unit a `deltaMode` of 1 reports. */
export const WHEEL_LINE_DELTA = 120

/** Pixel-domain factor applied to a wheel delta reported in pixels. */
export const WHEEL_PIXEL_FACTOR = 1.2

/** Mouse buttons the desktop distinguishes. */
export type CapturedButton = 'left' | 'right' | 'middle'

/**
 * Scale one rendered pixel coordinate into the frame's own pixel space and hold
 * it inside the host's limit.
 * @param value - the coordinate within the rendered image element, in CSS pixels.
 * @param rendered - the image element's rendered extent on that axis.
 * @param natural - the frame's own extent on that axis.
 * @returns the frame coordinate, clamped to `0..COORDINATE_LIMIT`.
 */
export function frameCoordinate(value: number, rendered: number, natural: number): number {
  if (!(rendered > 0) || !(natural > 0)) return 0
  const scaled = Math.round((value / rendered) * natural)
  return Math.min(Math.max(scaled, 0), COORDINATE_LIMIT)
}

/**
 * Normalize one wheel delta into pixels.
 * @param delta - the delta as the browser reported it.
 * @param deltaMode - `1` for lines, `2` for pages; anything else is already pixels.
 * @returns the pixel delta as a whole number.
 */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return Math.round(delta * WHEEL_LINE_DELTA)
  if (deltaMode === 2) return Math.round(delta * WHEEL_LINE_DELTA * 3)
  return Math.round(delta * WHEEL_PIXEL_FACTOR)
}

/**
 * Hold a virtual-key code inside the range the helper maps.
 * @param code - the code a browser keyboard event reported.
 * @returns the code, or `undefined` when it is outside `1..254`.
 */
export function keyCodeWithinRange(code: number): number | undefined {
  if (!Number.isInteger(code) || code < 1 || code > 254) return undefined
  return code
}

/**
 * Split text into its UTF-16 code units, the unit the desktop's `input char` takes.
 * @param text - the composed text.
 * @returns one entry per code unit, in order.
 */
export function utf16Units(text: string): number[] {
  const units: number[] = []
  for (let index = 0; index < text.length; index += 1) units.push(text.charCodeAt(index))
  return units
}

/** Timer seam the batcher needs, so a test can drive time instead of waiting. */
export interface InputBatcherTiming {
  readonly schedule?: (run: () => void, ms: number) => number
  readonly cancel?: (handle: number) => void
}

/** Constructor arguments of {@link InputBatcher}. */
export interface InputBatcherOptions extends InputBatcherTiming {
  /** Deliver one batch in order; the batcher never calls it with an empty batch. */
  readonly send: (events: readonly CapturedInputEvent[]) => void
}

const defaultSchedule = (run: () => void, ms: number): number => globalThis.setTimeout(run, ms)
const defaultCancel = (handle: number): void => { globalThis.clearTimeout(handle) }

/**
 * Collects captured events into ordered batches. A pointer move is held as the
 * pending trailing position for {@link MOVE_COALESCE_MS} so a drag does not
 * become one request per mouse report, while every discrete event commits the
 * pending move first — a click always lands where the pointer was when it fired.
 */
export class InputBatcher {
  private readonly pending: CapturedInputEvent[] = []
  private readonly heldKeys = new Set<number>()
  private readonly heldButtons = new Set<CapturedButton>()
  private trailingMove: CapturedInputEvent | undefined
  private moveTimer: number | undefined
  private readonly send: (events: readonly CapturedInputEvent[]) => void
  private readonly schedule: (run: () => void, ms: number) => number
  private readonly cancel: (handle: number) => void

  /**
   * @param options - the batch sink and the optional timer seam.
   */
  constructor(options: InputBatcherOptions) {
    this.send = options.send
    this.schedule = options.schedule ?? defaultSchedule
    this.cancel = options.cancel ?? defaultCancel
  }

  /**
   * Record a pointer position, coalescing consecutive reports.
   * @param x - frame pixel column.
   * @param y - frame pixel row.
   */
  move(x: number, y: number): void {
    this.trailingMove = { t: 'move', x, y }
    this.maybeFlush()
  }

  /**
   * Record a mouse button transition.
   * @param button - which button changed.
   * @param pressed - true for a press, false for a release.
   */
  button(button: CapturedButton, pressed: boolean): void {
    if (pressed) this.heldButtons.add(button)
    else this.heldButtons.delete(button)
    this.push({ t: 'button', b: button, p: pressed ? 'down' : 'up' })
  }

  /**
   * Record a wheel step in pixels.
   * @param dx - horizontal delta, positive to the right.
   * @param dy - vertical delta, positive downwards.
   */
  wheel(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    this.push({ t: 'wheel', dx, dy })
  }

  /**
   * Record a virtual-key transition.
   * @param vk - the key code, already inside the helper's range.
   * @param pressed - true for a press, false for a release.
   */
  key(vk: number, pressed: boolean): void {
    if (pressed) this.heldKeys.add(vk)
    else this.heldKeys.delete(vk)
    this.push({ t: 'key', vk, p: pressed ? 'down' : 'up' })
  }

  /**
   * Record exact text, one event per UTF-16 code unit.
   * @param text - the composed text to insert.
   */
  char(text: string): void {
    for (const unit of utf16Units(text)) this.push({ t: 'char', c: unit })
  }

  /**
   * Release everything still held and deliver it, so focus loss cannot leave a
   * key or button down on the desktop.
   */
  releaseAll(): void {
    const keys = [...this.heldKeys]
    this.heldKeys.clear()
    const buttons = [...this.heldButtons]
    this.heldButtons.clear()
    for (const vk of keys) this.push({ t: 'key', vk, p: 'up' })
    for (const button of buttons) this.push({ t: 'button', b: button, p: 'up' })
    this.flush()
  }

  /** Deliver everything captured so far. */
  flush(): void {
    this.detachMoveTimer()
    this.commitMove()
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, this.pending.length)
    this.send(batch)
  }

  /** Drop everything captured, including a held key or button, without sending. */
  dispose(): void {
    this.detachMoveTimer()
    this.pending.length = 0
    this.trailingMove = undefined
    this.heldKeys.clear()
    this.heldButtons.clear()
  }

  private push(event: CapturedInputEvent): void {
    this.commitMove()
    this.pending.push(event)
    this.maybeFlush()
  }

  private commitMove(): void {
    if (this.trailingMove === undefined) return
    this.pending.push(this.trailingMove)
    this.trailingMove = undefined
  }

  private maybeFlush(): void {
    this.detachMoveTimer()
    if (this.pending.length >= INPUT_BATCH_LIMIT) {
      this.flush()
      return
    }
    if (this.trailingMove !== undefined && this.moveTimer === undefined) {
      const handle = this.schedule(() => {
        this.moveTimer = undefined
        this.commitMove()
        this.flush()
      }, MOVE_COALESCE_MS)
      this.moveTimer = handle
    }
  }

  private detachMoveTimer(): void {
    if (this.moveTimer === undefined) return
    this.cancel(this.moveTimer)
    this.moveTimer = undefined
  }
}
