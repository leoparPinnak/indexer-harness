/**
 * plan07-fix (T1 imza tutarlılığı) — the signature-consistency fixes pinned at
 * the service level with a scripted fake connection, no browser needed:
 *
 * 1. First-navigation seeding (Wire A): `Target.createTarget` lands on
 *    `about:blank`; the REAL URL is navigated only after the session carries
 *    the script + Emulation/Network UA overrides. The wire previously sent
 *    `HeadlessChrome/153` + `Sec-Ch-Ua: "Google Chrome";v="153"` while JS in
 *    the same document claimed Chrome/131.
 * 2. ONE Accept-Language channel (Wire B/C): neither override carries
 *    `acceptLanguage` — that doubler re-serialized `en-US,en;q=0.9` into
 *    `en-US,en;q=0.9;q=0.9` on main-frame navigations and reflected the raw
 *    split `["en-US","en;q=0.9"]` into navigator.languages. The header lives
 *    only in `Network.setExtraHTTPHeaders` (replace semantics).
 * 3. Both override surfaces carry the SAME UA + UA-CH metadata (G9).
 * 4. Seeding never steals the active tab (`activate:false`).
 *
 * The stealth contract stays untouched (src/stealth.ts:15-16): it only fixes
 * which story reaches the wire and when.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CdpService } from '../src/service.ts'
import { stealthScript } from '../src/stealth.ts'
import { DEFAULT_STEALTH_PROFILE, deriveAcceptLanguage } from '../src/stealth-profiles.ts'

interface SentCall {
  method: string
  params: Record<string, any>
  sessionId?: string | undefined
}

interface Harness {
  service: CdpService
  sent: SentCall[]
  activeCalls: string[]
}

/** A service wired to a scripted connection + registry, without a browser. */
function makeHarness(): Harness {
  const sent: SentCall[] = []
  const connection = {
    endpoint: 'ws://127.0.0.1:0/fake',
    connected: true,
    send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
      sent.push({ method, params, sessionId })
      if (method === 'Target.createTarget') return { targetId: 'T2' }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' }
      return {}
    },
    // PageSession subscribes in its constructor; an unsubscribe handle is enough.
    on: (_event: string, _listener: (params: unknown) => void): (() => void) => () => {},
  }
  const activeCalls: string[] = []
  let activeId: string | undefined = 'T1'
  const targets: Array<Record<string, unknown>> = [
    { targetId: 'T1', type: 'page', url: 'about:blank', title: '' },
  ]
  const registry = {
    targets: () => targets,
    list: async (): Promise<void> => {
      // Simulates the targetCreated event landing for the new tab.
      if (!targets.some(target => target.targetId === 'T2')) {
        targets.push({ targetId: 'T2', type: 'page', url: 'about:blank', title: '' })
      }
    },
    attach: async (targetId: string): Promise<string> => `S-${targetId}`,
    attachedSession: (targetId: string): string => `S-${targetId}`,
    active: (): unknown => (activeId !== undefined ? targets.find(target => target.targetId === activeId) : undefined),
    setActive: (targetId: string): void => {
      activeCalls.push(targetId)
      activeId = targetId
    },
  }
  const service = new CdpService()
  const writable = service as unknown as { connection: unknown, registry: unknown }
  writable.connection = connection
  writable.registry = registry
  return { service, sent, activeCalls }
}

describe('plan07-fix: seeding before the first navigation (Wire A)', () => {
  it('creates the target on about:blank, seeds the session, THEN navigates', async () => {
    const { service, sent, activeCalls } = makeHarness()
    const result = await service.createTab({ url: 'https://example.com/page', focus: false })
    expect(result.ok).toBe(true)

    const createIndex = sent.findIndex(call => call.method === 'Target.createTarget')
    const navIndex = sent.findIndex(call => call.method === 'Page.navigate')
    const scriptIndex = sent.findIndex(call => call.method === 'Page.addScriptToEvaluateOnNewDocument')
    const emulationIndex = sent.findIndex(call => call.method === 'Emulation.setUserAgentOverride')
    const networkIndex = sent.findIndex(call => call.method === 'Network.setUserAgentOverride')

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(sent[createIndex]?.params.url).toBe('about:blank')
    // Everything that dresses the wire exists BEFORE the first real request.
    expect(scriptIndex).toBeGreaterThan(createIndex)
    expect(emulationIndex).toBeGreaterThan(createIndex)
    expect(networkIndex).toBeGreaterThan(createIndex)
    expect(navIndex).toBeGreaterThan(scriptIndex)
    expect(navIndex).toBeGreaterThan(emulationIndex)
    expect(navIndex).toBeGreaterThan(networkIndex)
    expect(sent[navIndex]?.params.url).toBe('https://example.com/page')
    // The tab reports the REQUESTED url, not the about:blank seed document.
    expect(result.url).toBe('https://example.com/page')
    // focus:false seeding must not touch the active tab either.
    expect(activeCalls).toEqual([])
  })

  it('skips seeding for an about:blank tab (no wasted round trips)', async () => {
    const { service, sent } = makeHarness()
    await service.createTab({ focus: false })
    expect(sent.some(call => call.method === 'Page.navigate')).toBe(false)
    expect(sent.some(call => call.method === 'Emulation.setUserAgentOverride')).toBe(false)
    expect(sent.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(false)
  })
})

describe('plan07-fix: ONE Accept-Language channel (Wire B/C)', () => {
  it('neither override carries acceptLanguage; only setExtraHTTPHeaders sets it', async () => {
    const { service, sent } = makeHarness()
    await service.createTab({ url: 'https://example.com/', focus: false })

    const emulation = sent.find(call => call.method === 'Emulation.setUserAgentOverride')
    const network = sent.find(call => call.method === 'Network.setUserAgentOverride')
    expect(emulation).toBeDefined()
    expect(network).toBeDefined()
    const emulationParams = (emulation as SentCall).params
    const networkParams = (network as SentCall).params
    expect(Object.prototype.hasOwnProperty.call(emulationParams, 'acceptLanguage')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(networkParams, 'acceptLanguage')).toBe(false)

    const alChannels = sent.filter(call => JSON.stringify(call.params).includes('Accept-Language'))
    expect(alChannels).toHaveLength(1)
    expect(alChannels[0]?.method).toBe('Network.setExtraHTTPHeaders')
    expect(alChannels[0]?.params.headers['Accept-Language'])
      .toBe(deriveAcceptLanguage(DEFAULT_STEALTH_PROFILE.languageValues))
    expect(alChannels[0]?.params.headers['Accept-Language']).not.toContain(';q=0.9;q=')
  })

  it('both override surfaces carry the SAME UA + UA-CH metadata (G9)', async () => {
    const { service, sent } = makeHarness()
    await service.createTab({ url: 'https://example.com/', focus: false })

    const emulation = (sent.find(call => call.method === 'Emulation.setUserAgentOverride') as SentCall).params
    const network = (sent.find(call => call.method === 'Network.setUserAgentOverride') as SentCall).params
    expect(emulation.userAgent).toBe(DEFAULT_STEALTH_PROFILE.userAgent)
    expect(network.userAgent).toBe(DEFAULT_STEALTH_PROFILE.userAgent)
    expect(emulation.userAgentMetadata.fullVersion).toBe(DEFAULT_STEALTH_PROFILE.chromeVersion)
    expect(emulation.userAgentMetadata.brands.length).toBeGreaterThan(0)
    expect(JSON.stringify(emulation.userAgentMetadata)).toBe(JSON.stringify(network.userAgentMetadata))
    // The override story has no HeadlessChrome anywhere on the wire.
    expect(JSON.stringify(emulation)).not.toContain('HeadlessChrome')
    expect(JSON.stringify(network)).not.toContain('HeadlessChrome')
  })
})

describe('plan07-fix: seeding never steals the active tab', () => {
  it('getPageSession(activate:false) leaves the active target alone', async () => {
    const { service, activeCalls } = makeHarness()
    await service.getPageSession('T2', { activate: false })
    expect(activeCalls).toEqual([])
    // The default still activates (cdp_navigate / cdp_click semantics unchanged).
    await service.getPageSession('T2')
    expect(activeCalls).toEqual(['T2'])
  })

  it('openContextTab seeds the background tab without activating it', async () => {
    const { service, sent, activeCalls } = makeHarness()
    const result = await service.openContextTab('ctx-1', 'https://example.com/')
    expect(result.targetId).toBe('T2')

    const createIndex = sent.findIndex(call => call.method === 'Target.createTarget')
    const navIndex = sent.findIndex(call => call.method === 'Page.navigate')
    expect(sent[createIndex]?.params.url).toBe('about:blank')
    expect(sent[createIndex]?.params.browserContextId).toBe('ctx-1')
    expect(navIndex).toBeGreaterThan(createIndex)
    expect(sent[navIndex]?.params.url).toBe('https://example.com/')
    expect(activeCalls).toEqual([])
  })
})

/* ── plan07-fix2: loadTimes() must mirror the LIVE document epoch ─────────── */

describe('plan07-fix2: loadTimes() is anchored to performance.timeOrigin', () => {
  it('passes the detector one-liner: |startLoadTime*1000 − timeOrigin| < 1000', () => {
    // Real Chromium: startLoadTime*1000 === performance.timeOrigin (0 ms
    // divergence). The old patch pinned a fixed 2024-06-20 date — 828 days
    // off the document's own timeOrigin, detectable with one subtraction.
    const timeOrigin = 1_790_389_019_935
    const sandbox: Record<string, any> = { performance: { timeOrigin } }
    sandbox.window = sandbox
    const context = createContext(sandbox)
    runInContext(stealthScript(), context)
    const loadTimes = runInContext('window.chrome.loadTimes()', context) as Record<string, any>

    expect(Math.abs((loadTimes.startLoadTime as number) * 1000 - timeOrigin)).toBeLessThan(1000)
    expect(loadTimes.startLoadTime).toBe(timeOrigin / 1000)
    // The fixed calendar date is gone from every epoch-family stamp.
    expect(loadTimes.startLoadTime).not.toBe(1_718_847_000.124)
    expect(loadTimes.requestTime as number).toBeGreaterThan(timeOrigin / 1000 - 1)

    // Internal ordering preserved (request ≤ start < commit < doc < finish).
    expect(loadTimes.requestTime as number).toBeLessThan(loadTimes.startLoadTime as number)
    expect(loadTimes.commitLoadTime as number).toBeGreaterThan(loadTimes.startLoadTime as number)
    expect(loadTimes.finishDocumentLoadTime as number).toBeGreaterThan(loadTimes.commitLoadTime as number)
    expect(loadTimes.finishLoadTime as number).toBeGreaterThanOrEqual(loadTimes.finishDocumentLoadTime as number)

    // The story fields stay exactly as shipped (G8).
    expect(loadTimes.connectionInfo).toBe('h2')
    expect(loadTimes.npnNegotiatedProtocol).toBe('h2')
    expect(loadTimes.navigationType).toBe('Other')
    expect(runInContext('window.chrome.csi().pageT', context)).toBe(612)
  })
})
