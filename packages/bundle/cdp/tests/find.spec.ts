/**
 * plan08 §4.2: cdp_find — three layers:
 *  1. the pure query engine: ref/selector/ariaLabel/role/text + scope, the
 *     display-normalized (bidi-safe) text path, and the honest guard that
 *     an unbounded name-less query answers [] instead of "everything".
 *  2. `service.find()` over a fake connection: no-match → ok:false + reason,
 *     nth out of range → ok:false, stale chosen → ok:false (NEVER thrown),
 *     success → fresh box + actionable + candidates, scope miss named.
 *  3. the tool envelope under `additionalProperties:false` (both ok branches)
 *     plus the POST /api/server/cdp/find route (400/405/500/200).
 *
 * All plain data + fakes: no browser needed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpService } from '../src/service.ts'
import { registerCdpTools } from '../src/tools.ts'
import { CDP_FIND_ROUTE, registerCdpRoutes } from '../src/routes.ts'
import { buildRefIndex } from '../src/refs.ts'
import { type CdpDomNode } from '../src/snapshot.ts'
import {
  displayNormalize,
  matchFindCandidates,
  querySummary,
} from '../src/find.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface DomNode {
  nodeId: number
  parentId?: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  localName?: string
  attributes?: string[]
  children?: DomNode[]
}

/** Two identically-labelled buttons + an input, hand-built. */
function tinyDoc(): CdpDomNode {
  const element = (nodeId: number, nodeName: string, localName: string, attributes?: string[]): DomNode => ({
    nodeId,
    nodeType: 1,
    nodeName,
    localName,
    ...(attributes !== undefined ? { attributes } : {}),
    children: [],
  })
  return {
    nodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    nodeValue: '',
    children: [
      {
        nodeId: 2,
        nodeType: 1,
        nodeName: 'HTML',
        localName: 'html',
        children: [
          {
            nodeId: 3,
            nodeType: 1,
            nodeName: 'BODY',
            localName: 'body',
            children: [
              { ...element(4, 'BUTTON', 'button', ['aria-label', 'Kaydet']) },
              { ...element(5, 'BUTTON', 'button', ['aria-label', 'Kaydet']) },
              { ...element(6, 'INPUT', 'input', ['value', 'Merhaba']) },
            ],
          },
        ],
      },
    ],
  } as unknown as CdpDomNode
}

const index = () => buildRefIndex(tinyDoc())

const FIND_OK = {
  ok: true,
  matched: 2,
  targetId: 'tab-1',
  url: 'https://example.com/',
  warnings: ['search matched 2 elements; nth=0 shown — pass nth to pick another'],
  chosen: {
    ref: 'button|Kaydet|0',
    role: 'button',
    name: 'Kaydet',
    rawName: 'Kaydet',
    box: { x: 10, y: 20, width: 30, height: 40 },
    visible: true,
    inViewport: true,
    frameLocal: false,
  },
  actionable: { connected: true, visible: true, inViewport: true, enabled: true, hitTarget: true },
  candidates: [
    { ref: 'button|Kaydet|0', role: 'button', name: 'Kaydet', box: { x: 10, y: 20, width: 30, height: 40 }, visible: true },
    { ref: 'button|Kaydet|1', role: 'button', name: 'Kaydet', box: { x: 10, y: 20, width: 30, height: 40 }, visible: true },
  ],
} as const

const FIND_NO_MATCH = {
  ok: false,
  matched: 0,
  targetId: 'tab-1',
  url: 'https://example.com/',
  warnings: ['no element matched role=button text=Zzz (waited 0ms)'],
  reason: 'no element matched role=button text=Zzz (waited 0ms)',
} as const

// ---------------------------------------------------------------------------
// Layer 1 — the pure query engine
// ---------------------------------------------------------------------------

describe('plan08: matchFindCandidates / displayNormalize', () => {
  it('ref query answers exactly that node, never a fuzzy set', () => {
    const idx = index()
    // tinyDoc refs are full paths (html > generic > button) — never guess them.
    const ref = [...idx.keys()].find(key => key.includes('button|'))!
    const matches = matchFindCandidates(idx, { ref })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.ref).toBe(ref)
  })

  it('ariaLabel is exact after normalization; text is a substring path', () => {
    const idx = index()
    expect(matchFindCandidates(idx, { ariaLabel: 'Kaydet' })).toHaveLength(2)
    expect(matchFindCandidates(idx, { ariaLabel: 'kaydet' })).toHaveLength(0)
    expect(matchFindCandidates(idx, { role: 'button', text: 'Kay' })).toHaveLength(2)
    expect(matchFindCandidates(idx, { role: 'button', text: 'Zzz' })).toHaveLength(0)
  })

  it('a name-less query with no role guard answers [] instead of everything', () => {
    const idx = index()
    expect(matchFindCandidates(idx, { text: 'anything' })).toEqual([])
  })

  it('scope narrows the candidate universe', () => {
    const idx = index()
    const all = matchFindCandidates(idx, { role: 'button' })
    expect(all).toHaveLength(2)
    const scopedOut = matchFindCandidates(idx, { role: 'button' }, { scopeIds: new Set([6]) })
    expect(scopedOut).toEqual([])
  })

  it('selector membership is decided by the protocol, not by guesswork', () => {
    const idx = index()
    const buttonNodeIds = [...idx.entries()]
      .filter(([, entry]) => entry.role === 'button')
      .map(([, entry]) => entry.nodeId)
    const hit = matchFindCandidates(idx, { selector: '.btn' }, { selectorIds: buttonNodeIds })
    expect(hit.map(match => match.role)).toEqual(['button', 'button'])
    // The selector path returns EXACTLY the protocol's node-id set — in this
    // case the input (nodeId 6) — regardless of what a role hint would guess.
    const only = matchFindCandidates(idx, { selector: '.only' }, { selectorIds: [6] })
    expect(only.map(match => match.nodeId)).toEqual([6])
    // No selector → no selectorIds involvement at all.
    expect(matchFindCandidates(idx, { role: 'button' }, { selectorIds: [6] })).toHaveLength(2)
  })

  it('displayNormalize hides bidi controls and collapses whitespace on BOTH sides', () => {
    expect(displayNormalize('‮evil‬ label')).toBe('evil label')
    expect(displayNormalize('⁦a⁩   b\n c')).toBe('a b c')
    // refs stay raw: normalization is display-only.
    expect(displayNormalize('Kaydet')).toBe('Kaydet')
  })

  it('querySummary renders the human summary used in warnings', () => {
    const summary = querySummary({ role: 'button', text: 'Kaydet' })
    expect(summary).toContain('button')
    expect(summary).toContain('Kaydet')
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — service.find() over a fake connection
// ---------------------------------------------------------------------------

interface HarnessOptions {
  root?: CdpDomNode
  scopedNode?: number
  selectorNodes?: Record<string, number[]>
  describe?: unknown
}

function bootService(options: HarnessOptions = {}): { service: CdpService, calls: string[] } {
  const calls: string[] = []
  const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push(method)
    if (method === 'DOM.enable') return {}
    if (method === 'DOM.getDocument') return { root: options.root ?? tinyDoc() }
    if (method === 'DOM.querySelector') return { nodeId: options.scopedNode ?? 0 }
    if (method === 'DOM.querySelectorAll') {
      const selector = String(params.selector)
      if (selector === '*') return { nodeIds: [4, 5, 6] }
      return { nodeIds: options.selectorNodes?.[selector] ?? [] }
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'o-1' } }
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          value: options.describe ?? {
            ok: true,
            tag: 'button',
            id: '',
            ariaLabel: 'Kaydet',
            text: 'Kaydet',
            textLength: 6,
            rect: { x: 10, y: 20, width: 30, height: 40 },
            visible: true,
            enabled: true,
            inViewport: true,
            hitTarget: true,
            frameLocal: false,
            url: 'https://example.com/',
          },
        },
      }
    }
    throw new Error(`unexpected CDP method ${method}`)
  }
  const service = Object.create(CdpService.prototype) as CdpService
  Object.assign(service, {
    connection: { send },
    registry: { active: () => ({ targetId: 'tab-1' }) },
    getPageSession: async () => ({
      sessionId: 's-1',
      url: async () => 'https://example.com/',
      title: async () => 'Fixture',
      evaluate: async () => ({ value: '{}', truncated: false, hasValue: true }),
    }),
  })
  return { service, calls }
}

describe('plan08: service.find honesty', () => {
  it('rejects an empty query in-band WITHOUT touching the protocol', async () => {
    const { service, calls } = bootService()
    const outcome = await service.find()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('at least one of ref, selector, ariaLabel, role, text')
    expect(calls).toEqual([])
  })

  it('answers matched:0 → ok:false + a reason naming the query (never an empty swallow)', async () => {
    const { service } = bootService()
    const outcome = await service.find({ role: 'button', text: 'Zzz', timeoutMs: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.matched).toBe(0)
    expect(outcome.warnings[0]).toContain('no element matched')
    expect(outcome.reason).toBe(outcome.warnings[0])
    expect(outcome.url).toBe('https://example.com/')
  })

  it('scope misses are named as scope misses, not generic no-match', async () => {
    const { service } = bootService({ scopedNode: 0 })
    const outcome = await service.find({ role: 'button', scope: '#missing', timeoutMs: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('scope matched nothing: #missing')
  })

  it('nth out of range answers ok:false with the match count', async () => {
    const { service } = bootService()
    const outcome = await service.find({ role: 'button', nth: 5, timeoutMs: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.matched).toBe(2)
    expect(outcome.reason).toContain('nth 5 is out of range')
  })

  it('success carries a fresh box, actionability, ambiguity warning and ≤10 candidates', async () => {
    const { service } = bootService()
    const outcome = await service.find({ role: 'button', timeoutMs: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.matched).toBe(2)
    expect(outcome.chosen?.box).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    expect(outcome.actionable?.hitTarget).toBe(true)
    expect(outcome.candidates).toHaveLength(2)
    expect(outcome.warnings.some(line => line.includes('nth=0'))).toBe(true)
    // refs come from the live index — never hardcoded guesses.
    const idx = index()
    expect([...idx.keys()]).toContain(outcome.chosen!.ref)
  })

  it('a stale describe during find answers ok:false + stale-ref warning — NEVER throws', async () => {
    const { service } = bootService({
      describe: { ok: false, reason: 'stale-ref: no element carries this reference in the current document' },
    })
    const outcome = await service.find({ role: 'button', timeoutMs: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.matched).toBe(2)
    expect(String(outcome.reason)).toContain('stale-ref')
    expect(outcome.warnings.some(line => line.includes('stale'))).toBe(true)
  })

  it('frame-local chosen boxes are flagged with a refusal warning', async () => {
    const { service } = bootService({
      describe: {
        ok: true,
        tag: 'button',
        id: '',
        ariaLabel: 'Kaydet',
        text: 'Kaydet',
        textLength: 6,
        rect: { x: 1, y: 2, width: 3, height: 4 },
        visible: true,
        enabled: true,
        inViewport: true,
        hitTarget: true,
        frameLocal: true,
        url: 'https://example.com/',
      },
    })
    const outcome = await service.find({ role: 'button', timeoutMs: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.chosen?.frameLocal).toBe(true)
    expect(outcome.warnings.some(line => line.includes('frame-local'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — the tool envelope + render
// ---------------------------------------------------------------------------

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bootTools(service: unknown): Promise<Map<string, ToolDefinition>> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  })
  registerCdpTools(ctx, service as CdpService)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  if (tools.size === 0) throw new Error('find.spec: registerCdpTools registered zero tools')
  return tools
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const violationsOf = (definition: ToolDefinition | undefined, value: unknown): unknown[] =>
  validateJsonSchemaValue(definition!.output.schema as never, value as never)

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

function fakeService(find: (options: Record<string, unknown>) => Promise<unknown>): unknown {
  return {
    status: async () => ({ ok: true, version: '0.0.0' }),
    find,
    extract: async () => ({ ok: true }),
  }
}

describe('plan08: cdp_find tool envelope', () => {
  it('validates BOTH ok branches under additionalProperties:false', async () => {
    const tools = await bootTools(fakeService(async () => FIND_OK))
    const definition = tools.get('cdp_find')
    expect(definition).toBeDefined()
    const ok = await execute(definition, { role: 'button' })
    expect(violationsOf(definition, ok)).toEqual([])

    const tools2 = await bootTools(fakeService(async () => FIND_NO_MATCH))
    const definition2 = tools2.get('cdp_find')
    // The find schema pins matched/targetId/url/warnings as required because
    // EVERY branch of service.find carries them — so both real envelopes
    // validate while the honesty fields can never be dropped silently.
    expect(violationsOf(definition2, FIND_NO_MATCH)).toEqual([])
    expect(violationsOf(definition2, FIND_NO_MATCH)).not.toContain('missing required property "value.warnings"')
  })

  it('render never claims success on ok:false and never hides the warning block', async () => {
    const tools = await bootTools(fakeService(async () => FIND_NO_MATCH))
    const definition = tools.get('cdp_find')
    const miss = renderOf(definition, { role: 'button', text: 'Zzz' }, FIND_NO_MATCH)
    expect(miss).toContain('No match')
    expect(miss).not.toContain('Found 2 match')

    const tools2 = await bootTools(fakeService(async () => FIND_OK))
    const definition2 = tools2.get('cdp_find')
    const hit = renderOf(definition2, { role: 'button' }, FIND_OK)
    expect(hit).toContain('Found 2 match(es)')
    // plan08-fix (T3 F2): the ref prints raw inside quotes — never decorated —
    // so copying it from the render resolves at every consumer.
    expect(hit).toContain('match 1: "button|Kaydet|0"')
    expect(hit).not.toContain('@button|Kaydet|0')
    expect(hit).toContain('actionable.')
    expect(hit).toContain('Warnings:')
  })

  it('forwards only the documented query keys to the service', async () => {
    const seen: Record<string, unknown>[] = []
    const tools = await bootTools(fakeService(async (options) => {
      seen.push(options)
      return FIND_OK
    }))
    await execute(tools.get('cdp_find'), {
      ref: 'r', selector: '.x', ariaLabel: 'A', role: 'button', text: 'T', scope: '#s',
      nth: 1, timeoutMs: 0, targetId: 'tab-9', bogus: 'dropped',
    })
    expect(seen[0]).toEqual({
      ref: 'r', selector: '.x', ariaLabel: 'A', role: 'button', text: 'T', scope: '#s',
      nth: 1, timeoutMs: 0, targetId: 'tab-9',
    })
    expect(seen[0]).not.toHaveProperty('bogus')
  })
})

// ---------------------------------------------------------------------------
// The REST twin — POST /api/server/cdp/find
// ---------------------------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

function setupRoutes(overrides: Record<string, unknown>): Map<string, RouteHandler> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, RouteHandler>()
  ctx.provide('webServer', {
    register: (registration: { kind: string, path: string, handler: RouteHandler }) => {
      routes.set(registration.path, registration.handler)
      return () => { routes.delete(registration.path) }
    },
  })
  registerCdpRoutes(ctx, overrides as unknown as CdpService)
  return routes
}

function captureResponse(): { res: ServerResponse, status: () => number, json: () => any } {
  let status = 200
  const chunks: string[] = []
  const res = {
    get statusCode() { return status },
    set statusCode(code: number) { status = code },
    setHeader: () => res,
    end: (chunk?: string) => { if (chunk !== undefined) chunks.push(chunk) },
  } as unknown as ServerResponse
  return { res, status: () => status, json: () => JSON.parse(chunks.join('')) as any }
}

const makeRequest = (method: string, bodyJson?: unknown): IncomingMessage => {
  const content = bodyJson !== undefined ? JSON.stringify(bodyJson) : ''
  return Object.assign(Readable.from([content]), {
    method,
    url: CDP_FIND_ROUTE,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

describe('plan08: POST /api/server/cdp/find', () => {
  it('registers on the shared webServer at /api/server/cdp/find', () => {
    const routes = setupRoutes({})
    expect(routes.has(CDP_FIND_ROUTE)).toBe(true)
    expect(CDP_FIND_ROUTE).toBe('/api/server/cdp/find')
  })

  it('answers 200 for BOTH a match and a no-match discovery (discovery is data)', async () => {
    const routes = setupRoutes({ find: async () => FIND_OK })
    const ok = captureResponse()
    await routes.get(CDP_FIND_ROUTE)!(makeRequest('POST', { role: 'button' }), ok.res)
    expect(ok.status()).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true, matched: 2 })

    const missRoutes = setupRoutes({ find: async () => FIND_NO_MATCH })
    const miss = captureResponse()
    await missRoutes.get(CDP_FIND_ROUTE)!(makeRequest('POST', { role: 'button', text: 'Zzz' }), miss.res)
    expect(miss.status()).toBe(200)
    expect(miss.json().ok).toBe(false)
    expect(miss.json().matched).toBe(0)
    expect(String(miss.json().reason)).toContain('no element matched')
  })

  it('answers 400 without any query key, 405 on GET, 500 on session refusals', async () => {
    const routes = setupRoutes({
      find: async () => { throw new Error('cdp: no page target is tracked') },
    })
    const handler = routes.get(CDP_FIND_ROUTE)!

    const empty = captureResponse()
    await handler(makeRequest('POST', {}), empty.res)
    expect(empty.status()).toBe(400)
    expect(String(empty.json().error)).toContain('at least one of ref, selector')

    const wrongMethod = captureResponse()
    await handler(makeRequest('GET'), wrongMethod.res)
    expect(wrongMethod.status()).toBe(405)

    const refusal = captureResponse()
    await handler(makeRequest('POST', { role: 'button' }), refusal.res)
    expect(refusal.status()).toBe(500)
    expect(String(refusal.json().error)).toContain('no page target')
  })
})
