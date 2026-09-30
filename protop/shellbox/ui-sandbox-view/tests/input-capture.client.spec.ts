/**
 * Tests for the sandbox pane's input capture: the frame conversions, the wheel
 * and key normalization, and the batching the desktop actually receives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COORDINATE_LIMIT,
  INPUT_BATCH_LIMIT,
  InputBatcher,
  frameCoordinate,
  keyCodeWithinRange,
  normalizeWheelDelta,
  utf16Units,
} from '../src/client/inputCapture.ts'
import type { CapturedInputEvent } from '../src/client/inputCapture.ts'

describe('frameCoordinate', () => {
  it('scales a rendered pixel into the frame space', () => {
    expect(frameCoordinate(50, 200, 800)).toBe(200)
  })

  it('clamps beyond the host limit and below zero', () => {
    expect(frameCoordinate(100000, 200, 800)).toBe(COORDINATE_LIMIT)
    expect(frameCoordinate(-40, 200, 800)).toBe(0)
  })

  it('answers zero without a measurable element or frame', () => {
    expect(frameCoordinate(10, 0, 800)).toBe(0)
    expect(frameCoordinate(10, 200, 0)).toBe(0)
  })
})

describe('normalizeWheelDelta', () => {
  it('expands line mode into pixels', () => {
    expect(normalizeWheelDelta(3, 1)).toBe(360)
  })

  it('expands page mode further', () => {
    expect(normalizeWheelDelta(1, 2)).toBe(360)
  })

  it('scales pixel mode and rounds it', () => {
    expect(normalizeWheelDelta(10, 0)).toBe(12)
    expect(normalizeWheelDelta(3, 0)).toBe(4)
  })
})

describe('keyCodeWithinRange', () => {
  it('keeps a code the helper maps', () => {
    expect(keyCodeWithinRange(65)).toBe(65)
  })

  it('drops codes outside the range', () => {
    expect(keyCodeWithinRange(0)).toBeUndefined()
    expect(keyCodeWithinRange(255)).toBeUndefined()
    expect(keyCodeWithinRange(1.5)).toBeUndefined()
  })
})

describe('utf16Units', () => {
  it('splits one code unit per entry', () => {
    expect(utf16Units('Az')).toEqual([65, 122])
  })

  it('splits a surrogate pair into its two units', () => {
    expect(utf16Units('\u{1F600}')).toEqual([0xD83D, 0xDE00])
  })
})

describe('InputBatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces moves that arrive inside the quiet period', () => {
    vi.useFakeTimers()
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.move(10, 10)
    batcher.move(20, 20)
    vi.advanceTimersByTime(40)
    expect(batches).toEqual([[{ t: 'move', x: 20, y: 20 }]])
  })

  it('delivers the pending move before a discrete event', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.move(5, 6)
    batcher.button('left', true)
    batcher.flush()
    expect(batches).toEqual([[
      { t: 'move', x: 5, y: 6 },
      { t: 'button', b: 'left', p: 'down' },
    ]])
  })

  it('flushes at the batch limit the host accepts', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    for (let index = 0; index < INPUT_BATCH_LIMIT; index += 1) batcher.key(65, true)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(INPUT_BATCH_LIMIT)
  })

  it('ignores an empty wheel step', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.wheel(0, 0)
    batcher.flush()
    expect(batches).toEqual([])
  })

  it('releases every held key and button once', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.key(16, true)
    batcher.key(65, true)
    batcher.button('right', true)
    batcher.releaseAll()
    expect(batches[0]).toEqual([
      { t: 'key', vk: 16, p: 'down' },
      { t: 'key', vk: 65, p: 'down' },
      { t: 'button', b: 'right', p: 'down' },
      { t: 'key', vk: 16, p: 'up' },
      { t: 'key', vk: 65, p: 'up' },
      { t: 'button', b: 'right', p: 'up' },
    ])
    batcher.releaseAll()
    expect(batches).toHaveLength(1)
  })

  it('drops pending events when disposed', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.key(65, true)
    batcher.dispose()
    batcher.flush()
    expect(batches).toEqual([])
  })

  it('records exact text per code unit', () => {
    const batches: CapturedInputEvent[][] = []
    const batcher = new InputBatcher({ send: events => batches.push([...events]) })
    batcher.char('A\u{1F600}')
    batcher.flush()
    expect(batches[0]).toEqual([
      { t: 'char', c: 65 },
      { t: 'char', c: 0xD83D },
      { t: 'char', c: 0xDE00 },
    ])
  })
})
