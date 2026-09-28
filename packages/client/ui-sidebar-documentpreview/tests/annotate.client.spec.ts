// @vitest-environment jsdom
/**
 * The annotation layer's pure geometry: image-pixel mapping, the shape one drag
 * produces, and the canvas commands each shape paints.
 *
 * Shapes hold image pixels rather than screen ones, which is what makes a stroke
 * survive zoom, pan, and the export at the picture's own resolution.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  cropRectOf, distanceToShape, hitShape, paintShape, paintShapes, shapeBounds, shapeOf, toImagePoint, translateShape,
  type PaintContext, type Shape,
} from '../src/client/image/annotate.ts'

/** Records the drawing calls one shape makes. */
function recorder(): PaintContext & { calls: string[] } {
  const calls: string[] = []
  const record = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.join(',')})`) }
  return {
    calls,
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    fill: record('fill'),
    lineTo: record('lineTo'),
    moveTo: record('moveTo'),
    stroke: record('stroke'),
    strokeRect: record('strokeRect'),
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 0,
    strokeStyle: '',
  } as unknown as PaintContext & { calls: string[] }
}

const stroke = { color: '#ff3b30', width: 4 }

describe('annotation geometry', () => {
  it('maps a pointer to image pixels through the shown scale', () => {
    expect(toImagePoint({ x: 250, y: 125 }, 0.5)).toEqual({ x: 500, y: 250 })
    expect(toImagePoint({ x: 10, y: 10 }, 2)).toEqual({ x: 5, y: 5 })
  })

  it('builds one shape per drawing tool and refuses a degenerate drag', () => {
    expect(shapeOf('line', stroke, { x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({
      kind: 'line', ...stroke, from: { x: 1, y: 2 }, to: { x: 3, y: 4 },
    })
    expect(shapeOf('arrow', stroke, { x: 1, y: 1 }, { x: 9, y: 9 })?.kind).toBe('arrow')
    expect(shapeOf('rect', stroke, { x: 1, y: 1 }, { x: 9, y: 9 })?.kind).toBe('rect')
    // A pen needs its trail; the others need travel.
    expect(shapeOf('pen', stroke, { x: 1, y: 1 }, { x: 1, y: 1 }, [])).toBeUndefined()
    expect(shapeOf('pen', stroke, { x: 1, y: 1 }, { x: 1, y: 1 }, [{ x: 1, y: 1 }])?.kind).toBe('pen')
    expect(shapeOf('line', stroke, { x: 1, y: 1 }, { x: 1, y: 1 })).toBeUndefined()
  })

  it('paints a pen trail, a rectangle, a line, and an arrow head', () => {
    const pen = recorder()
    paintShape(pen, { kind: 'pen', ...stroke, points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] })
    expect(pen.calls).toEqual(['beginPath()', 'moveTo(1,1)', 'lineTo(2,3)', 'stroke()'])

    // A tap paints a dot rather than nothing at all.
    const tap = recorder()
    paintShape(tap, { kind: 'pen', ...stroke, points: [{ x: 5, y: 5 }] })
    expect(tap.calls).toEqual(['beginPath()', 'moveTo(5,5)', 'lineTo(5.01,5)', 'stroke()'])

    const box = recorder()
    paintShape(box, { kind: 'rect', ...stroke, from: { x: 9, y: 9 }, to: { x: 2, y: 4 } })
    expect(box.calls).toEqual(['strokeRect(2,4,7,5)'])

    const line = recorder()
    paintShape(line, { kind: 'line', ...stroke, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } })
    expect(line.calls).toEqual(['beginPath()', 'moveTo(0,0)', 'lineTo(10,10)', 'stroke()'])

    const arrow = recorder()
    paintShape(arrow, { kind: 'arrow', ...stroke, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } })
    // The shaft, then a filled head whose wings close back on the tip.
    const calls = arrow.calls
    expect(calls.slice(0, 4)).toEqual(['beginPath()', 'moveTo(0,0)', 'lineTo(10,0)', 'stroke()'])
    expect(calls[4]).toBe('beginPath()')
    expect(calls[5]).toBe('moveTo(10,0)')
    expect(calls.at(-2)).toBe('closePath()')
    expect(calls.at(-1)).toBe('fill()')
    const wing = (index: number): { x: number; y: number } => {
      const match = /^lineTo\(([-\d.]+),([-\d.]+)\)$/u.exec(calls[index] ?? '')
      if (match === null) throw new Error(`call ${String(index)} is not a wing: ${String(calls[index])}`)
      return { x: Number(match[1]), y: Number(match[2]) }
    }
    const first = wing(6)
    const second = wing(7)
    // Both wings sit behind the tip and mirror each other across the shaft.
    expect(first.x).toBeLessThan(10)
    expect(first.y).toBeCloseTo(-second.y, 6)
  })

  it('normalises a crop drag and clamps it to the picture', () => {
    const bounds = { width: 1000, height: 800 }
    // Corners in any order.
    expect(cropRectOf({ x: 300, y: 200 }, { x: 100, y: 400 }, bounds)).toEqual({ x: 100, y: 200, width: 200, height: 200 })
    // Past the edges.
    expect(cropRectOf({ x: -50, y: -50 }, { x: 5000, y: 5000 }, bounds)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    // No pixels covered is not a crop.
    expect(cropRectOf({ x: 10, y: 10 }, { x: 10, y: 10 }, bounds)).toBeUndefined()
    expect(cropRectOf({ x: 10.2, y: 10.2 }, { x: 10.4, y: 10.4 }, bounds)).toBeUndefined()
  })

  it('moves marks into the cropped coordinates without changing their shape', () => {
    expect(translateShape(
      { kind: 'line', color: '#fff', width: 2, from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
      -5,
      -8,
    )).toEqual({ kind: 'line', color: '#fff', width: 2, from: { x: 5, y: 12 }, to: { x: 25, y: 32 } })
    expect(translateShape(
      { kind: 'pen', color: '#fff', width: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      -1,
      -2,
    )).toEqual({ kind: 'pen', color: '#fff', width: 2, points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] })
  })

  it('paints marks in order, each with its own colour', () => {
    const context = recorder()
    const shapes: Shape[] = [
      { kind: 'line', color: '#ff3b30', width: 2, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
      { kind: 'rect', color: '#0a84ff', width: 2, from: { x: 2, y: 2 }, to: { x: 4, y: 4 } },
    ]
    paintShapes(context, shapes)
    expect(context.calls).toEqual([
      'beginPath()', 'moveTo(0,0)', 'lineTo(1,1)', 'stroke()', 'strokeRect(2,2,2,2)',
    ])
  })

  it('paints nothing for an empty trail', () => {
    const context = recorder()
    const strokeSpy = vi.fn()
    paintShape({ ...context, stroke: strokeSpy }, { kind: 'pen', ...stroke, points: [] })
    expect(strokeSpy).not.toHaveBeenCalled()
  })
})

describe('grabbing a mark', () => {
  const line: Shape = { kind: 'line', ...stroke, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }
  const box: Shape = { kind: 'rect', ...stroke, from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }

  it('measures against the outline, not the area a box encloses', () => {
    expect(distanceToShape(line, { x: 50, y: 0 })).toBe(0)
    expect(distanceToShape(line, { x: 50, y: 10 })).toBe(10)
    // Past the far end the nearest point is that end, not the infinite line.
    expect(distanceToShape(line, { x: 200, y: 0 })).toBe(100)
    expect(distanceToShape(box, { x: 50, y: 10 })).toBe(10)
    // The middle of the box is far from every edge, which keeps a mark drawn
    // inside another one reachable.
    expect(distanceToShape(box, { x: 50, y: 50 })).toBe(50)
  })

  it('measures a trail, and treats a degenerate segment as a point', () => {
    const trail: Shape = { kind: 'pen', ...stroke, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
    expect(distanceToShape(trail, { x: 50, y: 7 })).toBe(7)
    const dot: Shape = { kind: 'pen', ...stroke, points: [{ x: 10, y: 10 }] }
    expect(distanceToShape(dot, { x: 10, y: 13 })).toBe(3)
    const empty: Shape = { kind: 'pen', ...stroke, points: [] }
    expect(distanceToShape(empty, { x: 0, y: 0 })).toBe(Number.POSITIVE_INFINITY)
    const zeroLength: Shape = { kind: 'line', ...stroke, from: { x: 5, y: 5 }, to: { x: 5, y: 5 } }
    expect(distanceToShape(zeroLength, { x: 5, y: 9 })).toBe(4)
  })

  it('grabs the newest mark within tolerance and nothing outside it', () => {
    const older: Shape = { kind: 'line', ...stroke, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }
    const newer: Shape = { kind: 'line', ...stroke, from: { x: 0, y: 4 }, to: { x: 100, y: 4 } }
    expect(hitShape([older, newer], { x: 50, y: 2 }, 3)).toBe(1)
    expect(hitShape([older, newer], { x: 50, y: 40 }, 3)).toBeUndefined()
    // A thick stroke is grabbable by half its own width even with no tolerance.
    const thick: Shape = { kind: 'line', ...stroke, width: 20, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }
    expect(hitShape([thick], { x: 50, y: 9 }, 0)).toBe(0)
    expect(hitShape([], { x: 0, y: 0 }, 3)).toBeUndefined()
  })

  it('bounds a mark by its own pixels plus half its stroke', () => {
    expect(shapeBounds({ kind: 'line', ...stroke, width: 4, from: { x: 0, y: 0 }, to: { x: 100, y: 50 } }))
      .toEqual({ x: -2, y: -2, width: 104, height: 54 })
    expect(shapeBounds({ kind: 'pen', ...stroke, width: 2, points: [{ x: 10, y: 10 }, { x: 30, y: 40 }] }))
      .toEqual({ x: 9, y: 9, width: 22, height: 32 })
    expect(shapeBounds({ kind: 'pen', ...stroke, points: [] })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
