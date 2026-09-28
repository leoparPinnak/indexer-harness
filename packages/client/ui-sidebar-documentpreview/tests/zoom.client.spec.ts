// @vitest-environment jsdom
/**
 * The preview's zoom arithmetic: the bounds the zoom holds between, and the
 * multiplier one wheel event applies.
 *
 * The cases pin the property that keeps a gesture controllable. The multiplier
 * follows the event's delta on an exponential scale and is bounded, so a mouse
 * notch and a trackpad's stream of small deltas travel the same distance for the
 * same hand movement; a fixed multiplier per event cannot do that, because one
 * trackpad gesture is dozens of events.
 */
import { describe, expect, it } from 'vitest'
import {
  ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, anchoredOffset, clampZoom, wheelZoomFactor,
} from '../src/client/image/zoom.ts'

describe('clampZoom', () => {
  it('holds the zoom between the supported bounds', () => {
    expect(clampZoom(ZOOM_MIN / 10)).toBe(ZOOM_MIN)
    expect(clampZoom(ZOOM_MAX * 10)).toBe(ZOOM_MAX)
    expect(clampZoom(2)).toBe(2)
  })

  it('exposes the single step the explicit controls take', () => {
    expect(ZOOM_STEP).toBe(1.25)
  })
})

describe('wheelZoomFactor', () => {
  it('leaves the zoom alone for an event with no delta', () => {
    expect(wheelZoomFactor(0, 0, 1000)).toBe(1)
  })

  it('follows the delta on an exponential scale', () => {
    // One 100-pixel notch out of the picture and back in again.
    expect(wheelZoomFactor(100, 0, 1000)).toBeCloseTo(Math.exp(-0.1), 12)
    expect(wheelZoomFactor(-100, 0, 1000)).toBeCloseTo(Math.exp(0.1), 12)
  })

  it('reads a line delta as lines and a page delta as viewport heights', () => {
    expect(wheelZoomFactor(-1, 1, 1000)).toBeCloseTo(Math.exp(0.016), 12)
    // One 1000-pixel page is 1000 pixels of travel, already at the ceiling.
    expect(wheelZoomFactor(-1, 2, 1000)).toBe(wheelZoomFactor(-1000, 0, 1000))
  })

  it('bounds the multiplier, so one event can never leap', () => {
    expect(wheelZoomFactor(-100_000, 0, 1000)).toBe(wheelZoomFactor(-1000, 0, 1000))
    expect(wheelZoomFactor(100_000, 0, 1000)).toBe(wheelZoomFactor(1000, 0, 1000))
    // The ceiling is a small step, not the doubling an unbounded scale would give.
    expect(wheelZoomFactor(-100_000, 0, 1000)).toBeLessThan(1.2)
  })

  it('keeps a trackpad gesture and one mouse notch on the same distance', () => {
    let trackpad = 1
    for (let step = 0; step < 20; step += 1) trackpad *= wheelZoomFactor(-5, 0, 1000)
    expect(trackpad).toBeCloseTo(wheelZoomFactor(-100, 0, 1000), 12)
  })
})

describe('anchoredOffset', () => {
  it('holds the picture still when the cursor is on its centre', () => {
    expect(anchoredOffset({ x: 100, y: 100 }, { width: 200, height: 200 }, { x: 0, y: 0 }, 1, 2))
      .toEqual({ x: 0, y: 0 })
  })

  it('keeps the image point under the cursor while the zoom grows', () => {
    // At scale 1 the cursor sits 50 CSS pixels right of centre, over image pixel 50.
    const next = anchoredOffset({ x: 150, y: 100 }, { width: 200, height: 200 }, { x: 0, y: 0 }, 1, 2)
    expect(next).toEqual({ x: -50, y: 0 })
    // Centre plus that offset plus image pixel 50 at the new scale is the cursor again.
    expect(100 + next.x + 50 * 2).toBe(150)
  })
})
