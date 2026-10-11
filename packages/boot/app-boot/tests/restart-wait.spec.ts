import net from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  portBusy,
  RESTART_WAIT_POLL_MS,
  RESTART_WAIT_PORT_ENV,
  RESTART_WAIT_TIMEOUT_ENV,
  RESTART_WAIT_TIMEOUT_MS,
  waitForPortRelease,
} from '../src/restart-wait.ts'

describe('restart hand-over wait', () => {
  it('pins the environment contract both halves of the swap share', () => {
    // The sender (command-restart) spells these literals at its spawn seam;
    // this pin is what keeps the two halves agreeing.
    expect(RESTART_WAIT_PORT_ENV).toBe('DSH_RESTART_WAIT_PORT')
    expect(RESTART_WAIT_TIMEOUT_ENV).toBe('DSH_RESTART_WAIT_TIMEOUT_MS')
    expect(RESTART_WAIT_TIMEOUT_MS).toBe(30_000)
    expect(RESTART_WAIT_POLL_MS).toBe(250)
  })

  it('waits while the old listener holds the port and resolves once it releases', async () => {
    const probes: number[] = []
    let busy = true
    const freed = await waitForPortRelease(4004, { timeoutMs: 1_000, pollMs: 1 }, (port) => {
      probes.push(port)
      // Busy twice, free afterwards: the real listener dies mid-wait.
      if (probes.length >= 3) busy = false
      return Promise.resolve(busy)
    })
    expect(freed).toBe(true)
    expect(probes.length).toBeGreaterThanOrEqual(3)
    expect(probes.every(port => port === 4004)).toBe(true)
  })

  it('resolves immediately when nothing holds the port', async () => {
    const probes: number[] = []
    const freed = await waitForPortRelease(4004, { timeoutMs: 1_000, pollMs: 1 }, (port) => {
      probes.push(port)
      return Promise.resolve(false)
    })
    expect(freed).toBe(true)
    expect(probes).toEqual([4004])
  })

  it('gives up when the budget expires and reports it honestly', async () => {
    const freed = await waitForPortRelease(4004, { timeoutMs: 5, pollMs: 1 }, () => Promise.resolve(true))
    expect(freed).toBe(false)
  })
})

describe('portBusy', () => {
  it('reports a closed port as free', async () => {
    // Bind then release to learn a port nothing else occupies.
    const { promise: listening, resolve: bound } = Promise.withResolvers<number>()
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      bound(typeof address === 'object' && address !== null ? address.port : 0)
    })
    const port = await listening
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
    expect(await portBusy(port)).toBe(false)
  })
})
