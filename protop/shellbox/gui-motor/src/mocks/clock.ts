/** Waiters and clocks shared by the MOCK backends and the runner. */

import { setTimeout as timer } from 'node:timers/promises'

/** Consumes a mock's synthetic latency budget. */
export type Wait = (ms: number) => Promise<void>

/** Default waiter: a real timer, used by the printed benchmark run. */
export async function realTimerWait(ms: number): Promise<void> {
  await timer(ms)
}

/**
 * Deterministic clock: `wait` advances `now` without spending wall time, so
 * tests measure exactly the latency the mock profile declares.
 */
export interface VirtualClock {
  now(): number
  wait(ms: number): Promise<void>
}

/** Create a virtual clock whose `now`/`wait` share one accumulator. */
export function createVirtualClock(): VirtualClock {
  let timeMs = 0
  return {
    now: () => timeMs,
    wait: async (ms: number) => {
      timeMs += ms
    },
  }
}
