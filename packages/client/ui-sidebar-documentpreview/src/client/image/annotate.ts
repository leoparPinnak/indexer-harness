/**
 * Drawing primitives for the image editor: the shape model, the pointer-to-image
 * mapping, and the canvas painting.
 *
 * Shapes hold IMAGE-pixel coordinates, never screen ones, so a stroke survives
 * zooming, panning, resizing, and the export at the picture's own resolution.
 * Everything here is a pure function of its arguments, which keeps the geometry
 * testable without a browser.
 */

/** The tools the editor offers. `pan` moves the picture, `crop` frames a cut, `select` picks a mark, the rest draw. */
export type EditorTool = 'pan' | 'crop' | 'select' | 'pen' | 'line' | 'arrow' | 'rect'

/** One point in image pixels. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** Stroke properties every shape carries. */
export interface Stroke {
  readonly color: string
  readonly width: number
}

/** A freehand path: the pointer's trail, already in image pixels. */
export interface PenShape extends Stroke {
  readonly kind: 'pen'
  readonly points: readonly Point[]
}

/** A shape defined by its two corners. */
export interface DragShape extends Stroke {
  readonly kind: 'line' | 'arrow' | 'rect'
  readonly from: Point
  readonly to: Point
}

/** One mark on the picture. */
export type Shape = PenShape | DragShape

/** The tools that paint a mark: everything except moving, cropping, and selecting. */
export type DrawingTool = Exclude<EditorTool, 'pan' | 'crop' | 'select'>

/** A region of the picture, in image pixels. */
export interface CropRect {
  readonly x: number
  readonly y: number
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

/** The 2D context surface these helpers use; narrowed so a test can stand in. */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'closePath' | 'fill' | 'lineTo' | 'moveTo' | 'stroke' | 'strokeRect'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  lineWidth: number
  strokeStyle: string | CanvasGradient | CanvasPattern
}

/** Default stroke colors, offered in this order. */
export const EDITOR_COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ffffff', '#000000'] as const

/** Default stroke width in image pixels, and the offered steps. */
export const EDITOR_WIDTHS = [2, 4, 8, 16] as const

/** Arrow head length as a multiple of the stroke width. */
const ARROW_HEAD_SCALE = 5

/** Arrow head opening angle, in radians on each side of the shaft. */
const ARROW_HEAD_ANGLE = Math.PI / 7

/**
 * The region one crop drag frames, clamped to the picture and normalised so the
 * corners may be dragged in any order.
 * @param from - one corner, in image pixels.
 * @param to - the opposite corner, in image pixels.
 * @param bounds - the picture's own size.
 * @returns the region, or undefined when the drag covers no pixels.
 */
export function cropRectOf(from: Point, to: Point, bounds: { width: number; height: number }): CropRect | undefined {
  const left = clamp(Math.round(Math.min(from.x, to.x)), 0, bounds.width)
  const top = clamp(Math.round(Math.min(from.y, to.y)), 0, bounds.height)
  const right = clamp(Math.round(Math.max(from.x, to.x)), 0, bounds.width)
  const bottom = clamp(Math.round(Math.max(from.y, to.y)), 0, bounds.height)
  if (right - left < 1 || bottom - top < 1) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Move one shape into the cropped picture's coordinates.
 * @param shape - the mark, in the original picture's pixels.
 * @param dx - how far the crop's origin moves leftwards (negative x of the region).
 * @param dy - how far the crop's origin moves upwards (negative y of the region).
 * @returns the mark in the cropped picture's coordinates.
 */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.kind === 'pen') {
    return { ...shape, points: shape.points.map(point => ({ x: point.x + dx, y: point.y + dy })) }
  }
  return {
    ...shape,
    from: { x: shape.from.x + dx, y: shape.from.y + dy },
    to: { x: shape.to.x + dx, y: shape.to.y + dy },
  }
}

/**
 * Convert a pointer position in the window into image pixels.
 * @param client - the pointer position, in CSS pixels relative to the shown picture's top-left.
 * @param scale - CSS pixels the picture is drawn at per image pixel.
 * @returns the point in image pixels.
 */
export function toImagePoint(client: Point, scale: number): Point {
  return { x: client.x / scale, y: client.y / scale }
}

/**
 * Paint one shape.
 * @param context - the drawing surface, already scaled to image pixels.
 * @param shape - the mark to paint.
 */
export function paintShape(context: PaintContext, shape: Shape): void {
  context.strokeStyle = shape.color
  context.lineWidth = shape.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (shape.kind === 'pen') {
    const [first, ...rest] = shape.points
    if (first === undefined) return
    context.beginPath()
    context.moveTo(first.x, first.y)
    for (const point of rest) context.lineTo(point.x, point.y)
    // A tap with no travel is still a mark.
    if (rest.length === 0) context.lineTo(first.x + 0.01, first.y)
    context.stroke()
    return
  }
  if (shape.kind === 'rect') {
    const x = Math.min(shape.from.x, shape.to.x)
    const y = Math.min(shape.from.y, shape.to.y)
    context.strokeRect(x, y, Math.abs(shape.to.x - shape.from.x), Math.abs(shape.to.y - shape.from.y))
    return
  }
  context.beginPath()
  context.moveTo(shape.from.x, shape.from.y)
  context.lineTo(shape.to.x, shape.to.y)
  context.stroke()
  if (shape.kind === 'arrow') paintArrowHead(context, shape)
}

/**
 * Paint an arrow's head at the far end of its shaft.
 * @param context - the drawing surface.
 * @param shape - the arrow's geometry and stroke.
 */
function paintArrowHead(context: PaintContext, shape: DragShape): void {
  const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x)
  const length = shape.width * ARROW_HEAD_SCALE
  context.fillStyle = shape.color
  context.beginPath()
  context.moveTo(shape.to.x, shape.to.y)
  context.lineTo(
    shape.to.x - length * Math.cos(angle - ARROW_HEAD_ANGLE),
    shape.to.y - length * Math.sin(angle - ARROW_HEAD_ANGLE),
  )
  context.lineTo(
    shape.to.x - length * Math.cos(angle + ARROW_HEAD_ANGLE),
    shape.to.y - length * Math.sin(angle + ARROW_HEAD_ANGLE),
  )
  context.closePath()
  context.fill()
}

/**
 * Paint every mark in order.
 * @param context - the drawing surface.
 * @param shapes - the marks, oldest first.
 */
export function paintShapes(context: PaintContext, shapes: readonly Shape[]): void {
  for (const shape of shapes) paintShape(context, shape)
}

/**
 * The shape one drag produces, or undefined when the drag is too short to be a mark.
 * @param tool - the active drawing tool.
 * @param stroke - color and width for the new shape.
 * @param from - the drag's start, in image pixels.
 * @param to - the drag's end, in image pixels.
 * @param points - the pointer trail, for the pen.
 * @returns the finished shape, or undefined for a degenerate drag.
 */
export function shapeOf(
  tool: DrawingTool,
  stroke: Stroke,
  from: Point,
  to: Point,
  points: readonly Point[] = [],
): Shape | undefined {
  if (tool === 'pen') return points.length === 0 ? undefined : { kind: 'pen', ...stroke, points }
  if (from.x === to.x && from.y === to.y) return undefined
  return { kind: tool, ...stroke, from, to }
}

/**
 * How far one point sits from a line segment.
 * @param point - the probe, in image pixels.
 * @param from - the segment's first end.
 * @param to - the segment's second end.
 * @returns the distance in image pixels, zero when the point lies on the segment.
 */
function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y)
  const along = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1)
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy))
}

/**
 * How far one point sits from a shape's outline.
 *
 * Only the outline counts: a box is grabbed by its edge, not by the area it
 * encloses, so a mark inside another stays reachable.
 * @param shape - the mark to measure against.
 * @param point - the probe, in image pixels.
 * @returns the distance in image pixels.
 */
export function distanceToShape(shape: Shape, point: Point): number {
  if (shape.kind === 'pen') {
    const [first, ...rest] = shape.points
    if (first === undefined) return Number.POSITIVE_INFINITY
    if (rest.length === 0) return Math.hypot(point.x - first.x, point.y - first.y)
    let nearest = Number.POSITIVE_INFINITY
    let from = first
    for (const to of rest) {
      nearest = Math.min(nearest, distanceToSegment(point, from, to))
      from = to
    }
    return nearest
  }
  if (shape.kind === 'rect') {
    const corners = [
      shape.from,
      { x: shape.to.x, y: shape.from.y },
      shape.to,
      { x: shape.from.x, y: shape.to.y },
    ] as const
    return corners.reduce((nearest, corner, index) => {
      const next = corners[(index + 1) % corners.length] ?? corner
      return Math.min(nearest, distanceToSegment(point, corner, next))
    }, Number.POSITIVE_INFINITY)
  }
  return distanceToSegment(point, shape.from, shape.to)
}

/**
 * The newest mark one point grabs.
 * @param shapes - the marks, oldest first.
 * @param point - the probe, in image pixels.
 * @param tolerance - how far from the outline still counts, in image pixels.
 * @returns the index of the newest hit, or undefined when the point misses every mark.
 */
export function hitShape(shapes: readonly Shape[], point: Point, tolerance: number): number | undefined {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index]
    if (shape === undefined) continue
    if (distanceToShape(shape, point) <= Math.max(tolerance, shape.width / 2)) return index
  }
  return undefined
}

/**
 * The rectangle one shape occupies, padded by half its stroke.
 * @param shape - the mark to measure.
 * @returns the region the mark covers, in image pixels.
 */
export function shapeBounds(shape: Shape): CropRect {
  const pad = shape.width / 2
  if (shape.kind !== 'pen') {
    const left = Math.min(shape.from.x, shape.to.x)
    const top = Math.min(shape.from.y, shape.to.y)
    return {
      x: left - pad,
      y: top - pad,
      width: Math.abs(shape.to.x - shape.from.x) + shape.width,
      height: Math.abs(shape.to.y - shape.from.y) + shape.width,
    }
  }
  const [first, ...rest] = shape.points
  if (first === undefined) return { x: 0, y: 0, width: 0, height: 0 }
  let left = first.x
  let right = first.x
  let top = first.y
  let bottom = first.y
  for (const point of rest) {
    left = Math.min(left, point.x)
    right = Math.max(right, point.x)
    top = Math.min(top, point.y)
    bottom = Math.max(bottom, point.y)
  }
  return { x: left - pad, y: top - pad, width: right - left + shape.width, height: bottom - top + shape.width }
}
