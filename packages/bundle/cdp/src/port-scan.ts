/**
 * @deepseek-ai/dsh-cdp — the pre-launch port survey.
 *
 * A browser is about to be launched, and the operator deserves to know what is
 * already on the machine before one more process appears. This module answers
 * that in a single pass and in a single round-trip, without ever binding a port
 * itself:
 *
 * 1. **Parallel scan** — one simultaneous TCP connect per port across the
 *    configured range. Every socket is opened in the same tick, so the cost is
 *    one round-trip rather than `range × timeout`, and no extra retry pass is
 *    ever needed.
 * 2. **Occupied-port diagnosis** — each open port is asked for `/json/version`,
 *    which separates a real CDP browser from any unrelated listener.
 * 3. **Atomic allocation** — handled by {@link ./launch}: the browser is started
 *    with `--remote-debugging-port=0` so the *operating system* picks the port
 *    and publishes it in the `DevToolsActivePort` file. Nothing here reserves a
 *    port, so a TOCTOU race between "this port looked free" and "something else
 *    took it" cannot occur.
 * 4. **userNotice** — one human-readable line naming what was occupied and which
 *    fresh port the instance came up on. It is part of the result payload, so it
 *    costs the caller no extra round-trip, and the agent relays it verbatim.
 *
 * @module @deepseek-ai/dsh-cdp/port-scan
 */

import { connect } from 'node:net'
import { request } from 'node:http'

/** First port of the surveyed loopback range, inclusive. */
export const SCAN_RANGE_START = 9222

/** Last port of the surveyed loopback range, inclusive. */
export const SCAN_RANGE_END = 9250

/** How long one scan socket waits for its connection to settle, in milliseconds. */
export const SCAN_CONNECT_TIMEOUT_MS = 250

/** How long one `/json/version` probe waits for its answer, in milliseconds. */
export const PROBE_TIMEOUT_MS = 600

/** One survey result: which ports answered, which refused. */
export interface PortScanResult {
  /** The surveyed range, rendered as `"start-end"`. */
  readonly scannedRange: string
  /** How many ports were probed. */
  readonly portsProbed: number
  /** Wall-clock cost of the whole parallel pass, in milliseconds. */
  readonly durationMs: number
  /** Ports that accepted a connection, ascending. */
  readonly occupiedPorts: readonly number[]
  /** Ports that refused, ascending. */
  readonly freePorts: readonly number[]
  /** The first free port in the range, or undefined when the range is saturated. */
  readonly firstFreePort: number | undefined
}

/** One open port identified as a live CDP browser. */
export interface CdpInstance {
  /** The port that answered. */
  readonly port: number
  /** The browser's own product string, e.g. `Chrome/153.0.8010.52`. */
  readonly browser: string
}

/** The full survey that rides back on a launch result. */
export interface PortAllocationNotice {
  /** The surveyed range, rendered as `"start-end"`. */
  readonly scannedRange: string
  /** Ports that were already occupied when the launch started. */
  readonly detectedOccupiedPorts: readonly number[]
  /** Which of those occupied ports actually speak CDP, and with which browser. */
  readonly activeCdpInstances: readonly CdpInstance[]
  /** The port the new browser actually came up on, as chosen by the OS. */
  readonly assignedPort: number
  /** The notice the operator must be shown, verbatim. */
  readonly userNotice: string
}

/** The environment seams, so a spec can survey without touching a real socket. */
export interface PortScanInternals {
  /** Probe one port; resolves true when something is listening. */
  readonly probePort: (port: number, timeoutMs: number) => Promise<boolean>
  /** Ask one port for its `/json/version`; resolves the product string or undefined. */
  readonly probeVersion: (port: number, timeoutMs: number) => Promise<string | undefined>
  /** The monotonic clock seam. */
  readonly now: () => number
}

/** Open one TCP connection to loopback and report whether it was accepted. */
function connectOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => { finish(true) })
    socket.once('timeout', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

/** Ask one loopback port for `/json/version` and read its `Browser` field. */
function versionOnce(port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body)
            const browser = (parsed as { Browser?: unknown }).Browser
            resolve(typeof browser === 'string' && browser !== '' ? browser : undefined)
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    req.once('timeout', () => { req.destroy(); resolve(undefined) })
    req.once('error', () => { resolve(undefined) })
    req.end()
  })
}

/** The production seams. */
export const defaultPortScanInternals: PortScanInternals = {
  probePort: connectOnce,
  probeVersion: versionOnce,
  now: () => Date.now(),
}

/**
 * Survey the loopback range in one parallel pass.
 *
 * Every port is probed concurrently, so the whole survey costs one connect
 * timeout rather than one per port — there is no serial walk and no second pass.
 *
 * @param start - First port of the range, inclusive.
 * @param end - Last port of the range, inclusive.
 * @param internals - The environment seams; defaults to the real sockets.
 * @returns Which ports are occupied, which are free, and what the pass cost.
 */
export async function scanLoopbackPorts(
  start: number = SCAN_RANGE_START,
  end: number = SCAN_RANGE_END,
  internals: PortScanInternals = defaultPortScanInternals,
): Promise<PortScanResult> {
  const ports: number[] = []
  for (let port = start; port <= end; port++) ports.push(port)

  const began = internals.now()
  const open = await Promise.all(ports.map(port => internals.probePort(port, SCAN_CONNECT_TIMEOUT_MS)))
  const durationMs = internals.now() - began

  const occupiedPorts: number[] = []
  const freePorts: number[] = []
  ports.forEach((port, index) => { (open[index] === true ? occupiedPorts : freePorts).push(port) })

  return {
    scannedRange: `${start}-${end}`,
    portsProbed: ports.length,
    durationMs,
    occupiedPorts,
    freePorts,
    firstFreePort: freePorts[0],
  }
}

/**
 * Identify which occupied ports are actually live CDP browsers.
 *
 * @param ports - The occupied ports from a scan.
 * @param internals - The environment seams; defaults to the real sockets.
 * @returns One entry per port that answered `/json/version` with a product string.
 */
export async function detectCdpInstances(
  ports: readonly number[],
  internals: PortScanInternals = defaultPortScanInternals,
): Promise<CdpInstance[]> {
  const found = await Promise.all(ports.map(async (port) => {
    const browser = await internals.probeVersion(port, PROBE_TIMEOUT_MS)
    return browser === undefined ? undefined : { port, browser }
  }))
  return found.filter((entry): entry is CdpInstance => entry !== undefined)
}

/**
 * Compose the operator notice for one launch.
 *
 * The notice is deliberately plain text: it is meant to be read out to the
 * operator unchanged, and to say both what was already running and where the new
 * instance landed.
 *
 * @param scan - The completed port survey.
 * @param instances - The occupied ports that speak CDP.
 * @param assignedPort - The port the new browser actually came up on.
 * @returns The notice string, plus the structured facts it was built from.
 */
export function buildPortAllocationNotice(
  scan: PortScanResult,
  instances: readonly CdpInstance[],
  assignedPort: number,
): PortAllocationNotice {
  const userNotice = scan.occupiedPorts.length === 0
    ? `BILDIRIM: ${scan.scannedRange} port araligi tamamen bos. Tarayici ${assignedPort} bos portunda baslatildi.`
    : `BILDIRIM: Bilgisayarinizda ${scan.occupiedPorts.length} port dolu -> ${scan.occupiedPorts.join(', ')}.`
      + ` Tespit edilen CDP ornekleri: ${instances.length > 0
        ? instances.map(instance => `${instance.port} (${instance.browser})`).join(', ')
        : 'yok'}.`
      + ` Yeni ve bagimsiz tarayici ${assignedPort} bos portunda baslatildi.`

  return {
    scannedRange: scan.scannedRange,
    detectedOccupiedPorts: scan.occupiedPorts,
    activeCdpInstances: instances,
    assignedPort,
    userNotice,
  }
}

/**
 * Run the whole pre-launch survey and return it ready to ride on a result.
 *
 * @param assignedPort - The port the new browser came up on.
 * @param start - First port of the surveyed range, inclusive.
 * @param end - Last port of the surveyed range, inclusive.
 * @param internals - The environment seams; defaults to the real sockets.
 * @returns The survey, the diagnosis, and the operator notice.
 */
export async function surveyBeforeLaunch(
  assignedPort: number,
  start: number = SCAN_RANGE_START,
  end: number = SCAN_RANGE_END,
  internals: PortScanInternals = defaultPortScanInternals,
): Promise<PortAllocationNotice> {
  const scan = await scanLoopbackPorts(start, end, internals)
  const instances = await detectCdpInstances(scan.occupiedPorts, internals)
  return buildPortAllocationNotice(scan, instances, assignedPort)
}
