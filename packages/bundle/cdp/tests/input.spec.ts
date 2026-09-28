/**
 * Tests for HumanInput: mouse movements along curved paths, jitter,
 * clicking, scrolling, text typing, key chords, and bounded operations
 * with deterministic random and clock injection.
 */

import { describe, expect, it } from 'vitest'
import {
  CdpInputError,
  characterKeyDefinition,
  HumanInput,
  keyDefinition,
  type InputConnection,
  type Point,
} from '../src/input.ts'

interface DispatchedEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string | undefined
}

function createFakeConnection(): { connection: InputConnection; events: DispatchedEvent[] } {
  const events: DispatchedEvent[] = []
  const connection: InputConnection = {
    send: (method, params, sessionId) => {
      events.push({ method, params, sessionId })
      return Promise.resolve({})
    },
  }
  return { connection, events }
}

describe('HumanInput', () => {
  it('dispatches mouse move events with monotone timestamps and curved path', async () => {
    const { connection, events } = createFakeConnection()
    let time = 1000
    const fakeNow = () => time
    const fakeSleep = (ms: number) => {
      time += ms
      return Promise.resolve()
    }
    const deterministicRandom = () => 0.5

    const input = new HumanInput({
      connection,
      sessionId: 'session-test',
      now: fakeNow,
      sleep: fakeSleep,
      random: deterministicRandom,
      startPoint: { x: 10, y: 10 },
    })

    const to: Point = { x: 100, y: 100 }
    const outcome = await input.movePointer(to)

    expect(outcome.points.length).toBeGreaterThanOrEqual(3)
    expect(outcome.boundsHit).toEqual([])

    // Check dispatched mouse events
    const mouseMoves = events.filter(e => e.params.type === 'mouseMoved')
    expect(mouseMoves.length).toBe(outcome.points.length)

    // Verify timestamps are non-decreasing
    let lastTs = -1
    for (const move of mouseMoves) {
      const ts = move.params.timestamp as number
      expect(ts).toBeGreaterThanOrEqual(lastTs)
      lastTs = ts
    }
  })

  it('respects path step bounds and reports pathSteps bound hit without throwing', async () => {
    const { connection } = createFakeConnection()
    const input = new HumanInput({
      connection,
      sessionId: 'session-1',
      bounds: { maxPathSteps: 5, maxDurationMs: 5000, maxCharacters: 100, maxScrollSteps: 10 },
      sleep: () => Promise.resolve(),
      startPoint: { x: 0, y: 0 },
    })

    const outcome = await input.movePointer({ x: 1000, y: 1000 })
    expect(outcome.points.length).toBe(5)
    expect(outcome.boundsHit).toContain('pathSteps')
  })

  it('performs click with press, release, and settle delays', async () => {
    const { connection, events } = createFakeConnection()
    let time = 5000
    const input = new HumanInput({
      connection,
      sessionId: 'session-1',
      now: () => time,
      sleep: (ms) => {
        time += ms
        return Promise.resolve()
      },
      random: () => 0.5,
      startPoint: { x: 50, y: 50 },
    })

    const outcome = await input.click({ x: 50, y: 50 }, { holdMs: 50, settleMs: 40 })
    expect(outcome.boundsHit).toEqual([])

    const press = events.find(e => e.params.type === 'mousePressed')
    const release = events.find(e => e.params.type === 'mouseReleased')
    expect(press).toBeDefined()
    expect(release).toBeDefined()
    expect(press?.params.x).toBe(50)
    expect(press?.params.y).toBe(50)
    expect(press?.params.button).toBe('left')
  })

  it('dispatches scroll with inertial steps', async () => {
    const { connection, events } = createFakeConnection()
    const input = new HumanInput({
      connection,
      sessionId: 'session-1',
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    })

    const outcome = await input.scroll({ x: 50, y: 50 }, { x: 0, y: 200 })
    expect(outcome.steps).toBeGreaterThan(1)
    const wheelEvents = events.filter(e => e.params.type === 'mouseWheel')
    expect(wheelEvents.length).toBe(outcome.steps)
  })

  it('types text with character delays and reports character bounds', async () => {
    const { connection, events } = createFakeConnection()
    let time = 1000
    const input = new HumanInput({
      connection,
      sessionId: 'session-1',
      bounds: { maxPathSteps: 100, maxDurationMs: 10000, maxCharacters: 4, maxScrollSteps: 10 },
      now: () => time,
      sleep: (ms) => {
        time += ms
        return Promise.resolve()
      },
      random: () => 0.5,
    })

    const outcome = await input.typeText('Hello World')
    expect(outcome.typed).toBe(4)
    expect(outcome.skipped).toBe(7)
    expect(outcome.boundsHit).toContain('characters')

    const keyEvents = events.filter(e => e.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThanOrEqual(4)
  })

  it('dispatches key chords with correct modifier bitmasks', async () => {
    const { connection, events } = createFakeConnection()
    const input = new HumanInput({
      connection,
      sessionId: 'session-1',
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    })

    const outcome = await input.pressChord(['Control', 'Shift', 'a'])
    expect(outcome.boundsHit).toEqual([])

    const keyEvents = events.filter(e => e.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThan(0)
    // Control bit 2 + Shift bit 8 = 10
    const downA = keyEvents.find(e => e.params.key === 'a' && e.params.type === 'rawKeyDown')
    expect(downA?.params.modifiers).toBe(10)
  })

  it('resolves key definitions correctly and rejects invalid characters', () => {
    const enter = keyDefinition('Enter')
    expect(enter.windowsVirtualKeyCode).toBe(13)
    expect(enter.code).toBe('Enter')

    const charA = characterKeyDefinition('a')
    expect(charA.key).toBe('a')
    expect(charA.code).toBe('KeyA')
    expect(charA.windowsVirtualKeyCode).toBe(65)

    expect(() => characterKeyDefinition('ab')).toThrow(CdpInputError)
    expect(() => keyDefinition('NonExistentKey123')).toThrow(CdpInputError)
  })
})
