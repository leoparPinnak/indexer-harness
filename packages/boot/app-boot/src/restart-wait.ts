/**
 * Restart hand-over wait: the relaunched backend's side of the `dsh_server_restart`
 * / `/dsh_restart` swap. The restarting process spawns its own replacement while
 * its listener is still bound, so the replacement waits here — before any plugin
 * mounts and before anything binds — until the old listener releases the port.
 * Waiting belongs to the relaunched backend (not the exiting one): only the
 * survivor is alive to observe the release.
 * @module @deepseek-ai/dsh-app-boot/restart-wait
 */

import net from 'node:net'

/** Environment contract: the port the old listener must release before this boot binds. */
export const RESTART_WAIT_PORT_ENV = 'DSH_RESTART_WAIT_PORT'

/** Environment contract: how long the wait may take before boot proceeds anyway. */
export const RESTART_WAIT_TIMEOUT_ENV = 'DSH_RESTART_WAIT_TIMEOUT_MS'

/** How long the relaunched backend waits for the old listener to release the port. */
export const RESTART_WAIT_TIMEOUT_MS = 30_000

/** How often the relaunched backend re-checks the port while waiting. */
export const RESTART_WAIT_POLL_MS = 250

/**
 * Report whether a TCP listener still occupies the port.
 * @param port - port the backend binds.
 * @returns whether something is still listening.
 */
export function portBusy(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = net.connect({ port, host: '127.0.0.1' })
  const settle = (busy: boolean): void => {
    socket.destroy()
    resolve(busy)
  }
  socket.setTimeout(500)
  socket.once('connect', () => { settle(true) })
  socket.once('timeout', () => { settle(false) })
  socket.once('error', () => { settle(false) })
  return promise
}

/**
 * Wait until nothing listens on the port, or the budget runs out. A budget
 * expiry answers `false` and lets the boot proceed anyway — the new listener's
 * own bind then decides, so a truthful failure beats a silent stall.
 * @param port - port the old listener held.
 * @param options - budget and poll cadence (defaults from {@link RESTART_WAIT_TIMEOUT_MS} / {@link RESTART_WAIT_POLL_MS}).
 * @param probe - port occupancy seam (overridable for tests).
 * @returns whether the port observed free before the budget expired.
 */
export async function waitForPortRelease(
  port: number,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
  probe: (port: number) => Promise<boolean> = portBusy,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? RESTART_WAIT_TIMEOUT_MS
  const pollMs = options.pollMs ?? RESTART_WAIT_POLL_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (!await probe(port)) return true
    const { promise: slept, resolve: wake } = Promise.withResolvers<void>()
    setTimeout(wake, pollMs)
    await slept
  }
  return false
}
