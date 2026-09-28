/**
 * Plan 02 wave 1 tool tests: `cdp_text` and `cdp_expect` registration, output
 * schema conformance driven by REAL service envelopes (the `cdp_tabs.attached`
 * bug class — every field execute can return must be declared under
 * additionalProperties:false), the additive evidence fields on `cdp_click`/
 * `cdp_type`, the renderers, and the validation paths that fail in-band
 * without touching a browser. Legacy tools must stay registered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, DEFAULT_PROXY_LISTEN_PORT, DEFAULT_REMOTE_DEBUGGING_PORT } from '../src/index.ts'
import type { Config as CdpConfig } from '../src/index.ts'
import { CdpService } from '../src/service.ts'
import type { PageEvaluation } from '../src/page.ts'

/** The shipped deployment settings, as the bundle patch restates them. */
const CONFIG: CdpConfig = {
  remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
  proxyListenPort: DEFAULT_PROXY_LISTEN_PORT,
  guideAssetsDir: '',
}

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the plugin on a fresh context and return its registered tools. */
async function registeredTools(config: CdpConfig = CONFIG): Promise<Map<string, ToolDefinition>> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('webServer', {
    host: '127.0.0.1',
    port: 4567,
    register: () => () => {},
  })
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
    guard: () => () => {},
  })
  apply(ctx, config)
  // Deferred inject callbacks settle one macrotask after their services resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return tools
}

/** One clean page evaluation carrying a JSON payload (or a raw string). */
function evaluation(payload: unknown): PageEvaluation {
  return {
    value: typeof payload === 'string' ? payload : JSON.stringify(payload),
    truncated: false,
    exception: undefined,
    hasValue: true,
    valueType: 'string',
  }
}

/** A CdpService whose session seam answers from a reply queue (the last reply repeats). */
function serviceWithReplies(replies: PageEvaluation[]): CdpService {
  const service = new CdpService()
  let index = 0
  const seams = service as unknown as { getPageSession: (targetId?: string) => Promise<unknown> }
  seams.getPageSession = async () => ({
    sessionId: 'sess-plan02-tools',
    evaluate: async () => {
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (reply === undefined) throw new Error('fake session: no reply queued')
      return reply
    },
    url: async () => 'https://example.com/tool',
  })
  return service
}

const TARGET = {
  index: 0,
  tag: 'button',
  role: 'button',
  name: 'Gönder',
  ariaLabel: 'Gönder',
  id: 'send',
  rect: { x: 10, y: 20, width: 120, height: 32 },
  visible: true,
  enabled: true,
  inViewport: true,
  text: 'Gönder (Ctrl-Enter)',
  textLength: 18,
}

const ACTIONABLE = {
  attached: true,
  visible: true,
  stable: true,
  enabled: true,
  inViewport: true,
  hitTarget: true,
  failures: [] as string[],
}

describe('plan02: cdp_text / cdp_expect registration', () => {
  it('registers both locator tools alongside every legacy tool', async () => {
    const tools = await registeredTools()
    for (const name of [
      'cdp_status', 'cdp_open', 'cdp_navigate', 'cdp_tabs', 'cdp_snapshot', 'cdp_eval',
      'cdp_click', 'cdp_type', 'cdp_wait', 'net_capture', 'net_export',
    ]) {
      expect([...tools.keys()], `${name} must stay registered`).toContain(name)
    }
    expect([...tools.keys()]).toContain('cdp_text')
    expect([...tools.keys()]).toContain('cdp_expect')
  })

  it('cdp_text exposes the locator parameters the plan promises', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()
    const parameters = (definition?.parameters ?? {}) as { properties?: Record<string, unknown> }
    const declared = Object.keys(parameters.properties ?? {})
    for (const key of ['css', 'ariaLabel', 'role', 'name', 'text', 'textMatch', 'nth', 'scope', 'targetId', 'timeoutMs', 'maxChars']) {
      expect(declared, `cdp_text must declare ${key}`).toContain(key)
    }
    // plan08 owns the snapshot-ref path now: `ref` is a legitimate parameter.
    expect(declared).toContain('ref')
    // Frame-scoped resolution stays unsupported (refs refuse frame-local rects).
    expect(declared).not.toContain('frame')
  })

  it('cdp_expect exposes the six-check enum as a required parameter', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_expect')
    expect(definition, 'cdp_expect must be registered').toBeDefined()
    const parameters = (definition?.parameters ?? {}) as { properties?: Record<string, unknown>, required?: string[] }
    const declared = Object.keys(parameters.properties ?? {})
    expect(declared).toContain('check')
    expect(parameters.required ?? []).toContain('check')
    expect(declared).toContain('expected')
    // plan08 owns the snapshot-ref path now: `ref` is a legitimate parameter.
    expect(declared).toContain('ref')
  })
})

describe('plan02: output schema conformance', () => {
  it('cdp_text accepts a real success envelope from the service', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()

    const service = serviceWithReplies([evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      target: TARGET,
      actionability: ACTIONABLE,
    })])
    const value = await service.readText({ css: '#send' })
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
  })

  it('cdp_text accepts a real failure envelope and still rejects undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()

    const service = serviceWithReplies([evaluation({
      ok: false,
      found: true,
      matched: 2,
      strategy: 'text',
      candidates: [
        { index: 0, tag: 'button', role: 'button', name: 'Kaydet', ariaLabel: '', id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true, enabled: true, inViewport: true },
        { index: 1, tag: 'a', role: 'link', name: 'Kaydet', ariaLabel: '', id: 'b', rect: { x: 0, y: 20, width: 10, height: 10 }, visible: true, enabled: true, inViewport: true },
      ],
      url: 'https://example.com/',
      reason: 'ambiguous: 2 candidates',
      hint: 'pass nth or narrow with scope/ariaLabel',
    })])
    const value = await service.readText({ text: 'Kaydet' })
    expect(value.ok).toBe(false)
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])

    const violations = validateJsonSchemaValue(definition?.output.schema as never, {
      ...value,
      resolvedBy: 'css',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('resolvedBy')
  })

  it('cdp_expect accepts real pass and fail envelopes', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_expect')
    expect(definition, 'cdp_expect must be registered').toBeDefined()

    const pass = await serviceWithReplies([evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      target: TARGET,
      actionability: ACTIONABLE,
    })]).expectCheck({ check: 'exists', spec: { css: '#send' } })
    expect(validateJsonSchemaValue(definition?.output.schema as never, pass)).toEqual([])

    const fail = await serviceWithReplies([evaluation({
      ok: false,
      found: false,
      matched: 0,
      strategy: 'aria-label',
      candidates: [],
      url: 'https://example.com/',
      reason: 'not found (aria-label matched 0 candidates)',
    })]).expectCheck({ check: 'exists', spec: { ariaLabel: 'Kapat' } })
    expect(fail.ok).toBe(false)
    expect(validateJsonSchemaValue(definition?.output.schema as never, fail)).toEqual([])

    const violations = validateJsonSchemaValue(definition?.output.schema as never, {
      ...fail,
      hint: 'use css instead',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('hint')
  })

  it('cdp_click accepts plain and evidence-bearing values, rejecting undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()

    expect(validateJsonSchemaValue(definition?.output.schema as never, { ok: true })).toEqual([])
    expect(validateJsonSchemaValue(definition?.output.schema as never, {
      ok: true,
      targetId: 'TARGET-1',
      url: 'https://example.com/',
      hit: { tag: 'button', role: 'button', name: 'Kaydet' },
    })).toEqual([])
    const violations = validateJsonSchemaValue(definition?.output.schema as never, {
      ok: true,
      attached: true,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('attached')
  })

  it('cdp_type accepts plain and evidence-bearing values, rejecting undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_type')
    expect(definition, 'cdp_type must be registered').toBeDefined()

    expect(validateJsonSchemaValue(definition?.output.schema as never, { ok: true, typedCharacters: 5 })).toEqual([])
    expect(validateJsonSchemaValue(definition?.output.schema as never, {
      ok: true,
      typedCharacters: 5,
      targetId: 'TARGET-1',
      url: 'https://example.com/',
      focused: { tag: 'input', role: 'textbox', name: 'E-posta' },
    })).toEqual([])
    const violations = validateJsonSchemaValue(definition?.output.schema as never, {
      ok: true,
      typedCharacters: 5,
      caret: 3,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('caret')
  })
})

describe('plan02: renderers through the registered tools', () => {
  it('renders cdp_text success and failure blocks', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()

    const pass = definition?.output.render({}, {
      ok: true,
      matched: 1,
      strategy: 'aria-label',
      candidates: [],
      waitedMs: 0,
      text: 'Gönder (Ctrl-Enter)',
      truncated: false,
      targetId: 'TARGET-1',
      url: 'https://example.com/',
      target: TARGET,
    } as never)
    expect(pass).toHaveLength(1)
    expect(pass?.[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(pass)).toContain('Gönder (Ctrl-Enter)')

    const fail = definition?.output.render({}, {
      ok: false,
      matched: 0,
      strategy: 'none',
      candidates: [],
      waitedMs: 0,
      reason: 'no locator given (pass css, ariaLabel, text, or role+name)',
    } as never)
    expect(JSON.stringify(fail)).toContain('FAILED')
    expect(JSON.stringify(fail)).toContain('no locator given')
  })

  it('renders cdp_expect PASS and FAIL blocks', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_expect')
    expect(definition, 'cdp_expect must be registered').toBeDefined()

    const pass = definition?.output.render({}, {
      ok: true,
      check: 'urlMatches',
      passed: true,
      matched: 0,
      strategy: 'none',
      candidates: [],
      waitedMs: 0,
      actual: 'https://example.com/dashboard',
      url: 'https://example.com/dashboard',
    } as never)
    expect(JSON.stringify(pass)).toContain('PASS')
    expect(JSON.stringify(pass)).toContain('https://example.com/dashboard')

    const fail = definition?.output.render({}, {
      ok: false,
      check: 'visible',
      passed: false,
      matched: 1,
      strategy: 'css',
      candidates: [],
      waitedMs: 0,
      reason: 'element resolved but is not visible',
      actual: 'not visible',
    } as never)
    expect(JSON.stringify(fail)).toContain('FAIL')
    expect(JSON.stringify(fail)).toContain('not visible')
  })

  it('keeps the legacy cdp_click render wording', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    const blocks = definition?.output.render({ x: 1, y: 1 } as never, { ok: true } as never)
    expect(blocks?.[0]).toMatchObject({ type: 'text', text: 'Click dispatched successfully.' })
  })
})

describe('plan02: execute validation paths (no browser)', () => {
  it('cdp_text fails in-band for a missing locator, role without name, and lone scope', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()

    const missing = await definition?.execute({}, {} as never) as Record<string, unknown>
    expect(missing.ok).toBe(false)
    expect(String(missing.reason)).toContain('no locator given')
    expect(missing.matched).toBe(0)
    expect(missing.strategy).toBe('none')
    expect(validateJsonSchemaValue(definition?.output.schema as never, missing)).toEqual([])

    const roleOnly = await definition?.execute({ role: 'button' }, {} as never) as Record<string, unknown>
    expect(roleOnly.ok).toBe(false)
    expect(String(roleOnly.reason)).toBe('role requires name')

    const scopeOnly = await definition?.execute({ scope: '.dialog' }, {} as never) as Record<string, unknown>
    expect(scopeOnly.ok).toBe(false)
    expect(String(scopeOnly.reason)).toContain('scope alone')
  })

  it('cdp_text still rejects at the session layer when a locator is sound', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_text')
    expect(definition, 'cdp_text must be registered').toBeDefined()
    await expect(definition?.execute({ css: '#send' }, {} as never)).rejects.toThrow()
  })

  it('cdp_expect fails in-band for missing expected, bad regex, and missing locator', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_expect')
    expect(definition, 'cdp_expect must be registered').toBeDefined()

    const textNoExpected = await definition?.execute({ check: 'textEquals' }, {} as never) as Record<string, unknown>
    expect(textNoExpected.ok).toBe(false)
    expect(textNoExpected.passed).toBe(false)
    expect(textNoExpected.check).toBe('textEquals')
    expect(String(textNoExpected.reason)).toContain('requires expected')
    expect(validateJsonSchemaValue(definition?.output.schema as never, textNoExpected)).toEqual([])

    const badRegex = await definition?.execute({ check: 'urlMatches', expected: '([' }, {} as never) as Record<string, unknown>
    expect(badRegex.ok).toBe(false)
    expect(String(badRegex.reason)).toContain('invalid regular expression')

    const noLocator = await definition?.execute({ check: 'exists' }, {} as never) as Record<string, unknown>
    expect(noLocator.ok).toBe(false)
    expect(String(noLocator.reason)).toContain('no locator given')
  })

  it('cdp_expect passes urlMatches without any locator and only then touches the session', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_expect')
    expect(definition, 'cdp_expect must be registered').toBeDefined()
    // Sound arguments reach the (unavailable) session: infrastructure rejects.
    await expect(definition?.execute({ check: 'urlMatches', expected: '^https://' }, {} as never)).rejects.toThrow()
  })
})

describe('plan02 wave 2: cdp_fill / cdp_wait / cdp_click registration', () => {
  it('cdp_fill declares the fill contract with a required value', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_fill')
    expect(definition, 'cdp_fill must be registered').toBeDefined()
    const parameters = (definition?.parameters ?? {}) as { properties?: Record<string, unknown>, required?: string[] }
    const declared = Object.keys(parameters.properties ?? {})
    for (const key of ['css', 'ariaLabel', 'role', 'name', 'text', 'textMatch', 'nth', 'scope', 'value', 'clear', 'verify', 'timeoutMs', 'targetId']) {
      expect(declared, `cdp_fill must declare ${key}`).toContain(key)
    }
    expect(parameters.required ?? []).toContain('value')
    expect(declared).not.toContain('frame')
  })

  it('cdp_wait declares all seven strategies with selector now optional', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_wait')
    expect(definition, 'cdp_wait must be registered').toBeDefined()
    const parameters = (definition?.parameters ?? {}) as { properties?: Record<string, { enum?: string[] }>, required?: string[] }
    const declared = Object.keys(parameters.properties ?? {})
    for (const key of ['selector', 'strategy', 'text', 'textMatch', 'url', 'idleMs', 'timeoutMs', 'targetId']) {
      expect(declared, `cdp_wait must declare ${key}`).toContain(key)
    }
    // §4.0 relaxation: selector is no longer schema-required — each strategy names its own need.
    expect(parameters.required ?? []).not.toContain('selector')
    expect(parameters.properties?.strategy?.enum).toEqual(['css', 'aria-label', 'text', 'visible', 'network-idle', 'navigation', 'url'])
    expect(parameters.properties?.textMatch?.enum).toEqual(['exact', 'contains'])
  })

  it('cdp_click declares the locator DSL parameters next to ref', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()
    const parameters = (definition?.parameters ?? {}) as { properties?: Record<string, unknown> }
    const declared = Object.keys(parameters.properties ?? {})
    for (const key of ['css', 'ariaLabel', 'role', 'name', 'text', 'textMatch', 'nth', 'scope', 'timeoutMs', 'ref', 'x', 'y', 'targetId']) {
      expect(declared, `cdp_click must declare ${key}`).toContain(key)
    }
    // Frame-scoped resolution stays unsupported everywhere in the locator layer.
    expect(declared).not.toContain('frame')
  })
})

describe('plan02 wave 2: schema conformance (fill / wait / click locator)', () => {
  it('cdp_wait accepts real strategy envelopes and rejects undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_wait')
    expect(definition, 'cdp_wait must be registered').toBeDefined()

    const envelope = { ok: true, action: 'wait', strategy: 'css', selector: '#ready', waitedMs: 12, timedOut: false, url: 'https://example.com/' }
    expect(validateJsonSchemaValue(definition?.output.schema as never, envelope)).toEqual([])
    // In-band validation failures carry no strategy/url yet and still conform.
    const invalid = { ok: false, action: 'wait', waitedMs: 0, timedOut: false, reason: 'strategy css requires selector' }
    expect(validateJsonSchemaValue(definition?.output.schema as never, invalid)).toEqual([])
    // Target-bearing locator strategies conform too.
    const withTarget = { ...envelope, strategy: 'visible', target: TARGET }
    expect(validateJsonSchemaValue(definition?.output.schema as never, withTarget)).toEqual([])
    // The text strategy runs standalone and echoes its expected text.
    const textWait = { ok: true, action: 'wait', strategy: 'text', text: 'Gönderildi', waitedMs: 12, timedOut: false, url: 'https://example.com/' }
    expect(validateJsonSchemaValue(definition?.output.schema as never, textWait)).toEqual([])

    const violations = validateJsonSchemaValue(definition?.output.schema as never, { ...envelope, hint: 'use css' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('hint')
  })

  it('cdp_fill accepts a real service.fill envelope and rejects undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_fill')
    expect(definition, 'cdp_fill must be registered').toBeDefined()

    const service = serviceWithReplies([evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/form',
      target: TARGET,
      actionability: ACTIONABLE,
      post: { checked: true, passed: true, condition: 'value === expected', expected: 'selam', actual: 'selam' },
    })])
    const value = await service.fill({ css: '#mail' }, 'selam')
    expect(value.ok).toBe(true)
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])

    const violations = validateJsonSchemaValue(definition?.output.schema as never, { ...value, hint: 'try cdp_type' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('hint')
  })

  it('cdp_click accepts locator-mode envelopes and still rejects undeclared keys', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()

    const failure = {
      ok: false,
      mode: 'locator',
      matched: 0,
      strategy: 'none',
      candidates: [],
      reason: 'role requires name',
      targetId: 'TARGET-1',
      url: 'https://example.com/',
    }
    expect(validateJsonSchemaValue(definition?.output.schema as never, failure)).toEqual([])

    const success = {
      ok: true,
      mode: 'locator',
      matched: 1,
      strategy: 'css',
      target: TARGET,
      actionability: ACTIONABLE,
      targetId: 'TARGET-1',
      url: 'https://example.com/',
      hit: { tag: 'input', role: 'textbox', name: 'E-posta' },
    }
    expect(validateJsonSchemaValue(definition?.output.schema as never, success)).toEqual([])

    const violations = validateJsonSchemaValue(definition?.output.schema as never, { ...success, frame: 'child' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('frame')
  })
})

describe('plan02 wave 2: execute validation paths (no browser)', () => {
  it('cdp_click refuses mixed addressing modes in-band', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()

    const refMix = await definition?.execute({ css: '#x', ref: 'r1' }, {} as never) as Record<string, unknown>
    expect(refMix.ok).toBe(false)
    expect(String(refMix.reason)).toBe('pass either ref or a locator, not both')
    expect(validateJsonSchemaValue(definition?.output.schema as never, refMix)).toEqual([])

    const coordMix = await definition?.execute({ css: '#x', x: 1, y: 2 }, {} as never) as Record<string, unknown>
    expect(coordMix.ok).toBe(false)
    expect(coordMix.mode).toBe('locator')
    expect(String(coordMix.reason)).toBe('pass either coordinates or a locator, not both')
    expect(validateJsonSchemaValue(definition?.output.schema as never, coordMix)).toEqual([])

    const roleOnly = await definition?.execute({ role: 'button' }, {} as never) as Record<string, unknown>
    expect(roleOnly.ok).toBe(false)
    expect(roleOnly.mode).toBe('locator')
    expect(String(roleOnly.reason)).toBe('role requires name')
    expect(validateJsonSchemaValue(definition?.output.schema as never, roleOnly)).toEqual([])
  })

  it('cdp_click locator mode still rejects at the session layer when the locator is sound', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()
    await expect(definition?.execute({ css: '#send' }, {} as never)).rejects.toThrow()
  })

  it('cdp_wait rejects schema-invalid args up front and fails in-band for semantic problems', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_wait')
    expect(definition, 'cdp_wait must be registered').toBeDefined()

    // `strategy` carries an enum: a value outside it never reaches execute —
    // defineTool's own validation raises ToolArgsError first.
    await expect(definition?.execute({ selector: '#x', strategy: 'forever' }, {} as never)).rejects.toThrow()

    // Structurally valid args reach execute and fail in-band with the reason.
    const missing = await definition?.execute({ strategy: 'visible' }, {} as never) as Record<string, unknown>
    expect(missing.ok).toBe(false)
    expect(String(missing.reason)).toBe('strategy visible requires selector')
    expect(validateJsonSchemaValue(definition?.output.schema as never, missing)).toEqual([])

    const badRegex = await definition?.execute({ strategy: 'url', url: '([' }, {} as never) as Record<string, unknown>
    expect(badRegex.ok).toBe(false)
    expect(String(badRegex.reason)).toContain('invalid url regular expression')
    expect(validateJsonSchemaValue(definition?.output.schema as never, badRegex)).toEqual([])

    // strategy=text without a value fails in-band and ECHOES the real
    // strategy (the failure line must not fall back to css).
    const missingText = await definition?.execute({ strategy: 'text' }, {} as never) as Record<string, unknown>
    expect(missingText.ok).toBe(false)
    expect(missingText.strategy).toBe('text')
    expect(String(missingText.reason)).toContain('strategy text requires text')
    expect(validateJsonSchemaValue(definition?.output.schema as never, missingText)).toEqual([])
    // textMatch carries its own enum: an invalid value never reaches execute.
    await expect(definition?.execute({ strategy: 'text', text: 'x', textMatch: 'fuzzy' }, {} as never)).rejects.toThrow()

    // Sound arguments reach the (unavailable) session: infrastructure rejects.
    await expect(definition?.execute({ selector: '#ready' }, {} as never)).rejects.toThrow()
  })

  it('cdp_fill rejects a missing required value up front and fails in-band for bad locators', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_fill')
    expect(definition, 'cdp_fill must be registered').toBeDefined()

    // `value` is schema-required: missing it raises ToolArgsError before execute.
    await expect(definition?.execute({ css: '#mail' }, {} as never)).rejects.toThrow()

    const noLocator = await definition?.execute({ value: 'selam' }, {} as never) as Record<string, unknown>
    expect(noLocator.ok).toBe(false)
    expect(noLocator.action).toBe('fill')
    expect(String(noLocator.reason)).toContain('no locator given')
    expect(validateJsonSchemaValue(definition?.output.schema as never, noLocator)).toEqual([])

    const roleOnly = await definition?.execute({ role: 'textbox', value: 'selam' }, {} as never) as Record<string, unknown>
    expect(roleOnly.ok).toBe(false)
    expect(String(roleOnly.reason)).toBe('role requires name')
    expect(validateJsonSchemaValue(definition?.output.schema as never, roleOnly)).toEqual([])

    // Sound arguments reach the dialog guard + service: infrastructure rejects.
    await expect(definition?.execute({ css: '#mail', value: 'selam' }, {} as never)).rejects.toThrow()
  })
})

describe('plan02 wave 2: renderers for the new modes', () => {
  it('renders locator-mode clicks distinctly, legacy otherwise', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_click')
    expect(definition, 'cdp_click must be registered').toBeDefined()

    const locator = definition?.output.render({}, { ok: true, mode: 'locator', strategy: 'css', matched: 1 } as never)
    expect(locator?.[0]).toMatchObject({ type: 'text', text: 'Clicked via locator (strategy=css, matched=1).' })

    const failed = definition?.output.render({}, { ok: false, mode: 'locator', reason: 'not clickable: not visible' } as never)
    expect(failed?.[0]).toMatchObject({ type: 'text', text: 'Click failed: not clickable: not visible' })

    const legacy = definition?.output.render({ x: 1, y: 1 } as never, { ok: true } as never)
    expect(legacy?.[0]).toMatchObject({ type: 'text', text: 'Click dispatched successfully.' })
  })

  it('keeps the legacy css wait line and renders other waits honestly', async () => {
    const tools = await registeredTools()
    const definition = tools.get('cdp_wait')
    expect(definition, 'cdp_wait must be registered').toBeDefined()

    const legacy = definition?.output.render({}, { ok: true, strategy: 'css', selector: '#ready', waitedMs: 9, timedOut: false } as never)
    expect(legacy?.[0]).toMatchObject({ type: 'text', text: 'Selector "#ready" is now present.' })

    const timedOut = definition?.output.render({}, {
      ok: false,
      strategy: 'network-idle',
      waitedMs: 10_000,
      timedOut: true,
      reason: 'timed out after 10000ms waiting for network-idle (3 request(s) still in flight)',
    } as never)
    expect(JSON.stringify(timedOut)).toContain('Wait FAILED after 10000ms (strategy=network-idle)')
    expect(JSON.stringify(timedOut)).toContain('3 request(s) still in flight')
  })
})

describe('plan02/T-fixes: never fake success (F1 / F4 / F5)', () => {
  it('F1: a locator click reports failure when no click event was delivered', async () => {
    vi.spyOn(CdpService.prototype, 'resolveForAction').mockResolvedValue({
      ok: true,
      targetId: 'TARGET-1',
      url: 'https://example.com/tool',
      point: { x: 70, y: 36 },
      matched: 1,
      strategy: 'css',
      target: TARGET,
      actionability: ACTIONABLE,
    } as never)
    vi.spyOn(CdpService.prototype, 'guardPageDialog').mockImplementation(async (_targetId, fn) => await fn())
    vi.spyOn(CdpService.prototype, 'click').mockResolvedValue({ delivered: false } as never)

    const definition = (await registeredTools()).get('cdp_click')
    const value = await definition?.execute({ css: '#send' }, {} as never) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.mode).toBe('locator')
    expect(String(value.reason)).toContain('click not delivered')
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
  })

  it('F1: an in-bounds coordinate click still fails when the event never lands', async () => {
    vi.spyOn(CdpService.prototype, 'readViewport').mockResolvedValue({ width: 400, height: 700 })
    vi.spyOn(CdpService.prototype, 'describePoint').mockResolvedValue(undefined)
    vi.spyOn(CdpService.prototype, 'guardPageDialog').mockImplementation(async (_targetId, fn) => await fn())
    vi.spyOn(CdpService.prototype, 'click').mockResolvedValue({ delivered: false } as never)

    const definition = (await registeredTools()).get('cdp_click')
    const value = await definition?.execute({ x: 10, y: 10 }, {} as never) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(String(value.reason)).toContain('click not delivered')
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
  })

  it('F5: out-of-bounds coordinates fail in-band with the viewport in the reason', async () => {
    vi.spyOn(CdpService.prototype, 'readViewport').mockResolvedValue({ width: 400, height: 700 })

    const definition = (await registeredTools()).get('cdp_click')
    const far = await definition?.execute({ x: 5000, y: 9999 }, {} as never) as Record<string, unknown>
    expect(far.ok).toBe(false)
    expect(String(far.reason)).toBe('out-of-bounds coordinate (400×700 viewport, got 5000,9999)')
    expect(validateJsonSchemaValue(definition?.output.schema as never, far)).toEqual([])

    const negative = await definition?.execute({ x: -200, y: -300 }, {} as never) as Record<string, unknown>
    expect(negative.ok).toBe(false)
    expect(String(negative.reason)).toContain('out-of-bounds coordinate')
    expect(String(negative.reason)).toContain('finite and non-negative')
    expect(validateJsonSchemaValue(definition?.output.schema as never, negative)).toEqual([])
  })

  it('F4: a truncated type is ok:false with counts + retry advice, never plain success', async () => {
    vi.spyOn(CdpService.prototype, 'describeFocus').mockResolvedValue(undefined)
    vi.spyOn(CdpService.prototype, 'guardPageDialog').mockImplementation(async (_targetId, fn) => await fn())
    vi.spyOn(CdpService.prototype, 'type').mockResolvedValue({
      typed: 16,
      skipped: 7,
      events: [],
      boundsHit: new Set(['duration']),
      durationMs: 2_000,
    } as never)

    const definition = (await registeredTools()).get('cdp_type')
    const value = await definition?.execute({ text: 'Irmaklı Öğüş Çiçek İdil' }, {} as never) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.typedCharacters).toBe(16)
    expect(String(value.reason)).toBe('typed 16 of 23 characters — TRUNCATED by the input budget (retry with the remaining text)')
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
  })
})

/**
 * plan02-fix-type-focus: the ref path used to type into whatever held focus.
 * A click that left `document.activeElement` on `<body>` dispatched every
 * keystroke into the void and the tool still answered "Typed N characters.".
 * The gate refuses BEFORE the first character, and types exactly as before
 * whenever focus really is on the resolved element.
 */
describe('plan02-fix-type-focus: cdp_type refuses a lost focus instead of faking delivery', () => {
  const REF_EVIDENCE = {
    ref: 'input|E-posta|0',
    role: 'textbox',
    name: 'E-posta',
    tag: 'input',
    id: 'email',
    rect: { x: 10, y: 20, width: 120, height: 32 },
    ariaLabel: 'E-posta',
    visible: true,
    enabled: true,
    inViewport: true,
    hitTarget: true,
    text: '',
    textLength: 0,
    frameLocal: false,
    url: 'https://example.com/form',
  }

  /** Every seam the ref path touches, with the focus verdict left to the test. */
  function stubRefPath(verdict: { holds: boolean, active?: { tag: string, role: string, name: string } }): { typeCalls: number[] } {
    const seen = { typeCalls: [] as number[] }
    vi.spyOn(CdpService.prototype, 'status').mockReturnValue({
      ok: true,
      version: '0.0.0',
      targets: 1,
      proxy: { active: false },
      connectionState: 'connected',
      openTabs: [],
      activeTargetId: 'TARGET-1',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1, source: 'live-window' },
    } as never)
    vi.spyOn(CdpService.prototype, 'resolveRef').mockResolvedValue(REF_EVIDENCE as never)
    vi.spyOn(CdpService.prototype, 'describeFocus').mockResolvedValue(undefined)
    vi.spyOn(CdpService.prototype, 'armTypeFocus').mockResolvedValue(true)
    vi.spyOn(CdpService.prototype, 'verifyTypeFocus').mockResolvedValue({
      url: 'https://example.com/form',
      ...verdict,
    } as never)
    vi.spyOn(CdpService.prototype, 'guardPageDialog').mockImplementation(async (_targetId, fn) => await fn())
    vi.spyOn(CdpService.prototype, 'click').mockResolvedValue({ delivered: true } as never)
    vi.spyOn(CdpService.prototype, 'type').mockImplementation(async (text: string) => {
      seen.typeCalls.push(text.length)
      return { typed: text.length, skipped: 0, events: [], boundsHit: new Set(), durationMs: 5 } as never
    })
    return seen
  }

  it('focus on <body>: ok:false with an actionable reason and NOT ONE character typed', async () => {
    const seen = stubRefPath({ holds: false, active: { tag: 'body', role: 'body', name: '' } })

    const definition = (await registeredTools()).get('cdp_type')
    const value = await definition?.execute({ text: 'kalan', ref: 'input|E-posta|0' }, {} as never) as Record<string, unknown>

    expect(value.ok).toBe(false)
    expect(value.typedCharacters).toBe(0)
    expect(value.ref).toBe('input|E-posta|0')
    expect(value.staleRef).toBe(false)
    expect(value.resolvedBy).toBe('ref')
    expect(String(value.reason)).toContain('focus lost')
    expect(String(value.reason)).toContain('<body>')
    expect(String(value.reason)).toContain('cdp_click')
    expect(seen.typeCalls, 'no keystroke may be dispatched after a lost focus').toEqual([])
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
    // The renderer must not claim characters landed.
    const rendered = (definition?.output as unknown as {
      render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
    }).render({}, value).map(part => part.text).join('\n')
    expect(rendered).toContain('Typing failed')
    expect(rendered).not.toContain('Typed 5 characters.')
  })

  it('focus on the resolved element: the text is typed, envelope unchanged', async () => {
    const seen = stubRefPath({ holds: true, active: { tag: 'input', role: 'textbox', name: 'E-posta' } })

    const definition = (await registeredTools()).get('cdp_type')
    const value = await definition?.execute({ text: 'kalan', ref: 'input|E-posta|0' }, {} as never) as Record<string, unknown>

    expect(value).toMatchObject({ ok: true, typedCharacters: 5, ref: 'input|E-posta|0', staleRef: false, resolvedBy: 'ref' })
    expect(value.reason).toBeUndefined()
    expect(seen.typeCalls).toEqual([5])
    expect(validateJsonSchemaValue(definition?.output.schema as never, value)).toEqual([])
  })
})
