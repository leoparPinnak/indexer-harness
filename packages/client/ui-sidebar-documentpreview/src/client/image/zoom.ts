/**
 * Zoom arithmetic for the image preview: the bounds the zoom holds between, the
 * step the explicit buttons take, and the multiplier one wheel event applies.
 *
 * The wheel multiplier is exponential in the event's delta, so a mouse notch's
 * single large delta and a trackpad's stream of small ones both land on a sane
 * step. A fixed multiplier per event cannot do that: one trackpad gesture is
 * dozens of events, so the zoom leaves the reader far behind.
 */

/** Lowest zoom, in device pixels per image pixel. */
export const ZOOM_MIN = 0.05
/** Highest zoom, in device pixels per image pixel. */
export const ZOOM_MAX = 8

/** One step for the explicit zoom buttons. */
export const ZOOM_STEP = 1.25

/** How far one CSS pixel of wheel delta moves the zoom, on the exponential scale. */
const WHEEL_RATE = 0.001

/** Largest multiplier one wheel event may apply, so a single event cannot leap. */
const WHEEL_FACTOR_MAX = 1.18

/** Smallest multiplier one wheel event may apply. */
const WHEEL_FACTOR_MIN = 1 / WHEEL_FACTOR_MAX

/** CSS pixels one line covers, for the line `deltaMode`. */
const WHEEL_LINE_PIXELS = 16

/** One point, in the units its caller documents. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** A width and a height, in CSS pixels. */
interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Hold a value inside a range.
 * @param value - candidate value.
 * @param min - smallest allowed value.
 * @param max - largest allowed value.
 * @returns the value held between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Hold a zoom inside the supported range.
 * @param zoom - candidate zoom, in device pixels per image pixel.
 * @returns the zoom held between {@link ZOOM_MIN} and {@link ZOOM_MAX}.
 */
export function clampZoom(zoom: number): number {
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX)
}

/**
 * The zoom multiplier one wheel event applies.
 *
 * The multiplier is bounded, so no single event can jump the zoom: the reader's
 * gesture, not one event's size, decides how far the zoom travels.
 * @param deltaY - the event's vertical delta, in `deltaMode` units.
 * @param deltaMode - 0 for pixels, 1 for lines, 2 for pages.
 * @param viewportHeight - visible height in CSS pixels, used to size a page delta.
 * @returns the multiplier to apply to the current zoom.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixels = deltaMode === 1
    ? deltaY * WHEEL_LINE_PIXELS
    : deltaMode === 2 ? deltaY * viewportHeight : deltaY
  return clamp(Math.exp(-pixels * WHEEL_RATE), WHEEL_FACTOR_MIN, WHEEL_FACTOR_MAX)
}

/**
 * The pan offset that keeps one point of the picture under the cursor as the
 * zoom changes.
 *
 * The picture is centred in its frame and then translated by the pan offset, so
 * the point under the cursor is `(cursor - centre - offset) / scale` in image
 * pixels; holding that point still at the next scale gives the returned offset.
 * @param cursor - pointer position in CSS pixels inside the frame's content box.
 * @param viewport - the frame's content box size in CSS pixels.
 * @param offset - the pan offset the zoom is changing from.
 * @param scale - CSS pixels per image pixel before the zoom.
 * @param nextScale - CSS pixels per image pixel after the zoom.
 * @returns the pan offset that holds the cursor's image point still.
 */
export function anchoredOffset(
  cursor: Point,
  viewport: Size,
  offset: Point,
  scale: number,
  nextScale: number,
): Point {
  const anchor = {
    x: (cursor.x - viewport.width / 2 - offset.x) / scale,
    y: (cursor.y - viewport.height / 2 - offset.y) / scale,
  }
  return {
    x: cursor.x - viewport.width / 2 - anchor.x * nextScale,
    y: cursor.y - viewport.height / 2 - anchor.y * nextScale,
  }
}
