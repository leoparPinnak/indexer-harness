import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpService } from '../src/service.ts'

// ---------------------------------------------------------------------------
// plan04-proxy: `open()`'s launch branch must route a FRESH browser through
// the capture proxy only while the listener is actually up — live, net_capture
// recorded 0 exchanges because the browser went direct. The real spawn is
// faked: the branch is judged purely on the `extraArgs` it hands to launch.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({ launches: [] as Array<{ extraArgs: string[] }> }))

vi.mock('../src/launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/launch.ts')>()
  return {
    ...actual,
    launchBrowser: async (options: { extraArgs?: string[] }) => {
      hoisted.launches.push({ extraArgs: options.extraArgs ?? [] })
      throw new Error('launch-fake: refusing to spawn a browser in tests')
    },
  }
})

const services: CdpService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.stop().catch(() => {})
  }
})

/**
 * plan13-profile: a bare `open()` now DISCOVERS first (a live browser on a
 * default port returns `needsChoice` and launches nothing), so these launch
 * tests pin an empty port set. Without it the spec would pass or fail
 * depending on whether the developer happens to have a debug browser running.
 * @param options - the service options to add the hermetic port set to.
 * @returns a service whose discovery finds nothing.
 */
function hermetic(options: Record<string, unknown> = {}): CdpService {
  const service = new CdpService({ ...options, discoveryPorts: [] })
  services.push(service)
  return service
}

describe('plan04-proxy: --proxy-server joins a fresh launch only while the capture proxy is up', () => {
  it('routes the browser through the proxy when ensureProxy bound', async () => {
    const service = hermetic({ proxyListenPort: 0 })
    const state = await service.ensureProxy()
    expect(state.active).toBe(true)

    hoisted.launches.length = 0
    await expect(service.open()).rejects.toThrow('launch-fake')

    const record = hoisted.launches[hoisted.launches.length - 1]
    expect(record).toBeDefined()
    const args = record?.extraArgs ?? []
    expect(args).toContain(`--proxy-server=http://127.0.0.1:${String(state.port)}`)
    // The proxy MITMs HTTPS with the local CA, which a fresh profile distrusts.
    expect(args).toContain('--ignore-certificate-errors')
  }, 15_000)

  it('keeps the plain launch when every candidate port is busy', async () => {
    // plan04-fix2: 65535 leaves the scan window with this ONE candidate, so
    // ensureProxy honestly answers {active:false} — and the launch must then
    // carry NO proxy flags (the old behavior), not a dangling --proxy-server.
    const blocker = createServer()
    await new Promise<void>((resolve) => {
      blocker.once('error', () => { resolve() })
      blocker.listen(65535, '127.0.0.1', () => { resolve() })
    })
    const service = hermetic({ proxyListenPort: 65535 })
    try {
      const state = await service.ensureProxy()
      expect(state.active).toBe(false)

      hoisted.launches.length = 0
      await expect(service.open()).rejects.toThrow('launch-fake')

      const record = hoisted.launches[hoisted.launches.length - 1]
      expect(record).toBeDefined()
      const args = record?.extraArgs ?? []
      expect(args.some(arg => arg.startsWith('--proxy-server'))).toBe(false)
      expect(args).not.toContain('--ignore-certificate-errors')
    } finally {
      blocker.close(() => { /* a non-listening close answers with an err arg */ })
    }
  }, 15_000)

  it('a caller-passed extraArgs value survives alongside the proxy flags', async () => {
    const service = hermetic({ proxyListenPort: 0 })
    const state = await service.ensureProxy()
    expect(state.active).toBe(true)

    hoisted.launches.length = 0
    await expect(service.open({ extraArgs: ['--window-size=800,600'] }))
      .rejects.toThrow('launch-fake')

    const record = hoisted.launches[hoisted.launches.length - 1]
    const args = record?.extraArgs ?? []
    // Set-order contract: caller flags come last, so a caller can override.
    expect(args).toContain('--window-size=800,600')
    expect(args.indexOf('--window-size=800,600'))
      .toBeGreaterThan(args.indexOf(`--proxy-server=http://127.0.0.1:${String(state.port)}`))
  }, 15_000)
})
