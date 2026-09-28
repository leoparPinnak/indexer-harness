/**
 * plan07: `cdp_stealth` + `cdp_fingerprint` registration, output-schema
 * conformance (the `additionalProperties:false` class of bug), render smoke,
 * dialog-guard membership, and the A11 why-blocked classifier's unit
 * contracts (severity order, rule coverage, evidence passthrough).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCdpTools } from '../src/tools.ts'
import { DIALOG_GUARDED_TOOLS } from '../src/dialog.ts'
import { classifyWhyBlocked, type WhyBlockedEvidence } from '../src/why-blocked.ts'
import type { CdpService } from '../src/service.ts'

const PLAN07_TOOLS = ['cdp_stealth', 'cdp_fingerprint'] as const

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the bundle's tool registrations against a stand-in service. */
function bootTools(service: unknown): Map<string, ToolDefinition> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  } as never)
  registerCdpTools(ctx, service as CdpService)
  return tools
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

const violationsOf = (definition: ToolDefinition | undefined, value: unknown): unknown[] =>
  validateJsonSchemaValue(definition!.output.schema as never, value as never)

const STATUS = {
  profile: 'windows-chrome',
  profiles: [
    { name: 'windows-chrome', locale: 'en-US', platform: 'Windows', userAgent: 'UA-131' },
    { name: 'macos-chrome', locale: 'en-US', platform: 'macOS', userAgent: 'UA-MAC' },
  ],
  applied: true,
  coherence: { js: true, headers: false, launch: true },
  warnings: ['Network.setUserAgentOverride failed; JS and Sec-CH-UA headers may diverge (G9)'],
}

const FINGERPRINT = {
  profile: 'windows-chrome',
  coherent: false,
  checks: [
    { id: 'webdriver-hidden', ok: false, expected: 'false', actual: 'true' },
    { id: 'plugins-present', ok: true, expected: '> 0', actual: '4' },
  ],
  whyBlocked: [
    {
      code: 'A11-webdriver',
      severity: 'critical',
      layer: 'js',
      message: 'navigator.webdriver reports true — the page sees the automation flag directly.',
      evidence: 'navigator.webdriver === true',
    },
  ],
}

/** Stand-in service recording how the tools called it. */
function fakeService(overrides: Record<string, unknown> = {}): { service: CdpService, seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = []
  const base = {
    stealthStatus: () => STATUS,
    stealthApply: async (profile: string, targetId?: string) => {
      seen.push({ call: 'stealthApply', profile, targetId })
      return { ...STATUS, profile }
    },
    fingerprint: async (targetId?: string) => {
      seen.push({ call: 'fingerprint', targetId })
      return FINGERPRINT
    },
  }
  return { service: { ...base, ...overrides } as unknown as CdpService, seen }
}

describe('plan07: tool registration and dialog guard', () => {
  it('registers cdp_stealth and cdp_fingerprint alongside the existing set', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (const name of PLAN07_TOOLS) expect([...tools.keys()]).toContain(name)
    for (const name of ['cdp_status', 'cdp_open', 'cdp_tabs', 'cdp_exec', 'cdp_fill']) {
      expect([...tools.keys()]).toContain(name)
    }
  })

  it('both tools join the plan05 dialog guard set', () => {
    for (const name of PLAN07_TOOLS) expect(DIALOG_GUARDED_TOOLS.has(name)).toBe(true)
  })
})

describe('plan07: cdp_stealth output schema conformance', () => {
  it('status answers with a schema-valid envelope', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_stealth')
    const value = await execute(definition, {})
    expect(value.ok).toBe(true)
    expect(value.action).toBe('status')
    expect(value.profile).toBe('windows-chrome')
    expect((value.profiles as unknown[]).length).toBe(2)
    expect(violationsOf(definition, value)).toEqual([])
  })

  it('apply forwards profile/targetId and reports schema-valid output', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_stealth')
    const value = await execute(definition, { action: 'apply', profile: 'macos-chrome', targetId: 'T1' })
    expect(seen).toContainEqual({ call: 'stealthApply', profile: 'macos-chrome', targetId: 'T1' })
    expect(value.profile).toBe('macos-chrome')
    expect(violationsOf(definition, value)).toEqual([])
  })

  it('apply without a profile and unknown actions are usage errors', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_stealth')
    await expect(execute(definition, { action: 'apply' })).rejects.toThrow(/requires profile/)
    // plan07: the parameter enum validates first (ToolArgsError), so an unknown
    // action never reaches execute; either wording means the call was refused.
    await expect(execute(definition, { action: 'teleport' })).rejects.toThrow(/must be one of|unknown action/)
  })

  it('rejects undeclared keys in the envelope', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const violations = violationsOf(tools.get('cdp_stealth'), { ...STATUS, ok: true, action: 'status', surprise: 1 })
    expect(violations).toHaveLength(1)
    expect(String(violations[0])).toContain('surprise')
  })

  it('renders status with coherence verdict and warnings', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_stealth')
    const value = await execute(definition, {})
    const text = renderOf(definition, {}, value)
    expect(text).toContain('Stealth profile: windows-chrome')
    expect(text).toContain('headers: false')
    expect(text).toContain('Sec-CH-UA headers may diverge')
    expect(text).toContain('windows-chrome, macos-chrome')
  })
})

describe('plan07: cdp_fingerprint output schema conformance', () => {
  it('answers with checks + whyBlocked that satisfy the declared schema', async () => {
    const { service, seen } = fakeService()
    const tools = bootTools(service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_fingerprint')
    const value = await execute(definition, { targetId: 'T9' })
    expect(seen).toContainEqual({ call: 'fingerprint', targetId: 'T9' })
    expect(value.coherent).toBe(false)
    expect((value.whyBlocked as unknown[]).length).toBe(1)
    expect(violationsOf(definition, value)).toEqual([])
  })

  it('rejects undeclared keys in a check row', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const violations = violationsOf(tools.get('cdp_fingerprint'), {
      ...FINGERPRINT,
      ok: true,
      checks: [{ id: 'x', ok: true, expected: 'y', actual: 'z', surprise: 1 }],
    })
    expect(violations).toHaveLength(1)
    expect(String(violations[0])).toContain('surprise')
  })

  it('renders divergence with failed checks and why-blocked reasons', async () => {
    const tools = bootTools(fakeService().service)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const definition = tools.get('cdp_fingerprint')
    const value = await execute(definition, {})
    const text = renderOf(definition, {}, value)
    expect(text).toContain('DIVERGED')
    expect(text).toContain('1/2 ok')
    expect(text).toContain('webdriver-hidden')
    expect(text).toContain('[critical/js] A11-webdriver')
  })
})

describe('plan07 A11: classifyWhyBlocked', () => {
  it('produces no reasons for a clean page', () => {
    const clean: WhyBlockedEvidence = {
      webdriver: false,
      userAgent: 'Mozilla/5.0 Chrome/131.0.0.0',
      platform: 'Win32',
      uaChPlatform: 'Windows',
      pluginsLength: 5,
      hasChrome: true,
      chromeHasRuntime: false,
      chromeHasExtras: true,
      fontsStatus: 'loaded',
      connectionType: '4g',
      automationKeys: [],
      screenCoversWindow: true,
    }
    expect(classifyWhyBlocked(clean)).toEqual([])
  })

  it('orders critical before high/medium/low regardless of rule order', () => {
    const dirty: WhyBlockedEvidence = {
      webdriver: true, // critical
      automationKeys: ['$cdc_aslflpuoagpo'], // critical
      chromeHasRuntime: true, // high
      pluginsLength: 0, // medium
      fontsStatus: 'loading', // low
      connectionType: '3g', // low
    }
    const reasons = classifyWhyBlocked(dirty)
    expect(reasons.map(reason => reason.code)).toEqual([
      'A11-webdriver',
      'A11-automation-vars',
      'A11-chrome-runtime',
      'A11-empty-plugins',
      'A11-fonts-stuck',
      'A11-connection-story',
    ])
    const severities = reasons.map(reason => reason.severity)
    expect(severities[0]).toBe('critical')
    expect(severities[severities.length - 1]).toBe('low')
  })

  it('flags the coherence tells with layer + evidence', () => {
    const reasons = classifyWhyBlocked({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', // no Chrome/<major>
      uaChPlatform: 'Windows',
      platform: 'Linux x86_64',
      screenCoversWindow: false,
      automationKeys: [],
    })
    const codes = reasons.map(reason => reason.code)
    expect(codes).toContain('A11-ua-chrome-missing')
    expect(codes).toContain('A11-platform-coherence')
    expect(codes).toContain('A11-screen-window')
    const coherence = reasons.find(reason => reason.code === 'A11-platform-coherence')
    expect(coherence?.layer).toBe('header')
    expect(coherence?.evidence).toContain('platform=Linux x86_64')
  })

  it('skips absent evidence instead of guessing', () => {
    expect(classifyWhyBlocked({})).toEqual([])
    expect(classifyWhyBlocked({ webdriver: false, pluginsLength: 3 })).toEqual([])
  })

  it('plan07-fix: flags real-vs-forged structure breaks (T1 §4)', () => {
    const reasons = classifyWhyBlocked({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      navigatorOwnKeys: ['webdriver', 'languages', 'hardwareConcurrency'],
      protoInstanceMismatches: ['hardwareConcurrency', 'deviceMemory'],
      uaChBrandMajor: '153',
      languagesWithQ: ['en;q=0.9'],
      pluginInstanceof: false,
    })
    const codes = reasons.map(reason => reason.code)
    expect(codes).toContain('A11-own-prop-trace')
    expect(codes).toContain('A11-prototype-mismatch')
    expect(codes).toContain('A11-ua-ch-version-mismatch')
    expect(codes).toContain('A11-languages-q-pollution')
    expect(codes).toContain('A11-plugin-instance')
    // Both criticals come first; severities stay sorted.
    expect(codes.slice(0, 2)).toEqual(['A11-own-prop-trace', 'A11-prototype-mismatch'])
    const severities = reasons.map(reason => reason.severity)
    expect(severities.indexOf('critical')).toBe(0)
    expect(severities[severities.length - 1]).toBe('medium') // plugin-instance rides last
    const ownTrace = reasons.find(reason => reason.code === 'A11-own-prop-trace')
    expect(ownTrace?.severity).toBe('critical')
    expect(ownTrace?.layer).toBe('js')
    expect(ownTrace?.evidence).toContain('webdriver')
    const qPollution = reasons.find(reason => reason.code === 'A11-languages-q-pollution')
    expect(qPollution?.severity).toBe('high')
    expect(qPollution?.layer).toBe('header')
    const uaMismatch = reasons.find(reason => reason.code === 'A11-ua-ch-version-mismatch')
    expect(uaMismatch?.evidence).toContain('uaChMajor=153')
    expect(uaMismatch?.evidence).toContain('uaMajor=131')
  })

  it('plan07-fix: stays quiet when the structure is genuinely Chrome-shaped', () => {
    expect(classifyWhyBlocked({
      webdriver: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      uaChPlatform: 'Windows',
      pluginsLength: 5,
      hasChrome: true,
      chromeHasRuntime: false,
      chromeHasExtras: true,
      fontsStatus: 'loaded',
      connectionType: '4g',
      automationKeys: [],
      screenCoversWindow: true,
      navigatorOwnKeys: [],
      protoInstanceMismatches: [],
      uaChBrandMajor: '131',
      languagesWithQ: [],
      pluginInstanceof: true,
    })).toEqual([])
  })
})
