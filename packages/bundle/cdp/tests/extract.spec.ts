/**
 * plan08 §4.3: cdp_extract — three layers:
 *  1. `parseExtractSpec` whitelist (kind/fields/from/where/regex/limit) —
 *     broken specs fail host-side with a single error line.
 *  2. the projection engine's honesty contract: data is ALWAYS an array, an
 *     empty match answers data:[] + missing, limit/truncation/visibleOnly
 *     all push complete:false with honest numbers.
 *  3. `service.extract()` over a fake connection + the tool envelope under
 *     `additionalProperties:false` (open rows!) + the REST twin route.
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
import { CDP_EXTRACT_ROUTE, registerCdpRoutes } from '../src/routes.ts'
import { buildRefIndex, type RefEvidence, type RefIndexEntry } from '../src/refs.ts'
import { type CdpDomNode } from '../src/snapshot.ts'
import {
  EXTRACT_MAX_LIMIT,
  EXTRACT_TEXT_LIMIT,
  matchExtractCandidates,
  PAGE_FIELDS_EXPRESSION,
  parseExtractSpec,
  projectExtract,
  refPathHasRole,
  type ExtractSpec,
} from '../src/extract.ts'

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

function evidenceOf(ref: string, overrides: Partial<RefEvidence> = {}): RefEvidence {
  return {
    ref,
    role: 'button',
    name: 'Kaydet',
    tag: 'button',
    id: 'save',
    ariaLabel: 'Kaydet',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    visible: true,
    enabled: true,
    inViewport: true,
    hitTarget: true,
    text: 'Kaydet',
    textLength: 6,
    frameLocal: false,
    url: 'https://example.com/',
    targetId: 'tab-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — the spec whitelist
// ---------------------------------------------------------------------------

describe('plan08: parseExtractSpec whitelist', () => {
  it('accepts the three kinds with their documented shapes', () => {
    const page = parseExtractSpec('{"kind":"page","fields":["title","url"]}')
    expect(page.ok && page.spec.kind === 'page').toBe(true)

    const list = parseExtractSpec(JSON.stringify({
      kind: 'list',
      from: { role: 'link', withinRole: 'navigation', selector: 'a', ariaLabel: 'X' },
      where: { nameMatches: '^Docs', visibleOnly: true },
      fields: { name: 'name', href: 'href', n: 'attr:data-n' },
      limit: 10,
    }))
    expect(list.ok).toBe(true)
    expect(list.ok && list.spec.kind === 'list' && list.spec.limit).toBe(10)

    const field = parseExtractSpec('{"kind":"field","field":"value","from":{"role":"textbox"}}')
    expect(field.ok && field.spec.kind === 'field').toBe(true)
  })

  it('clamps limit into [1, EXTRACT_MAX_LIMIT]', () => {
    const huge = parseExtractSpec('{"kind":"list","limit":9999}')
    expect(huge.ok && huge.spec.limit).toBe(EXTRACT_MAX_LIMIT)
    const negative = parseExtractSpec('{"kind":"list","limit":-5}')
    expect(negative.ok && negative.spec.limit).toBe(1)
  })

  it('rejects broken JSON, unknown kinds, unknown fields/sources, bad regexes', () => {
    const expectError = (raw: string, needle: string): void => {
      const parsed = parseExtractSpec(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.ok === false && parsed.error).toContain(needle)
    }
    expectError('not json', 'not valid JSON')
    expectError('[1,2]', 'must be a JSON object')
    expectError('{"kind":"table"}', "unknown kind 'table'")
    expectError('{"kind":"page","fields":["bogus"]}', "unknown page field 'bogus'")
    expectError('{"kind":"list","fields":["bogus"]}', "unknown field source 'bogus'")
    expectError('{"kind":"list","fields":{"x":"bogus"}}', "unknown source 'bogus'")
    expectError('{"kind":"list","where":{"nameMatches":"(["}}', 'not a valid regex')
    expectError('{"kind":"list","from":{"bogus":"x"}}', 'unknown from.bogus')
    expectError('{"kind":"list","where":{"bogus":true}}', 'unknown where.bogus')
    expectError('{"kind":"field"}', 'requires a valid field source')
  })
})

// ---------------------------------------------------------------------------
// Layer 1b — matching + the projection honesty contract
// ---------------------------------------------------------------------------

describe('plan08: matchExtractCandidates + refPathHasRole', () => {
  it('refPathHasRole looks at ANCESTOR steps only (the final step is the node)', () => {
    const ref = 'navigation|Menü|0 > button|Git|0'
    expect(refPathHasRole(ref, 'navigation')).toBe(true)
    expect(refPathHasRole(ref, 'main')).toBe(false)
    expect(refPathHasRole(ref, 'button')).toBe(false)
  })

  it('from.role + where.nameMatches filter the host candidates', () => {
    const idx = index()
    const spec = (where: Record<string, unknown>): ExtractSpec => {
      const parsed = parseExtractSpec(JSON.stringify({ kind: 'list', from: { role: 'button' }, where }))
      if (!parsed.ok) throw new Error(`unexpected parse failure: ${parsed.error}`)
      return parsed.spec
    }
    expect(matchExtractCandidates(idx, spec({ nameMatches: '^Kay' })).matches).toHaveLength(2)
    expect(matchExtractCandidates(idx, spec({ nameMatches: '^Zzz' })).matches).toHaveLength(0)
    expect(matchExtractCandidates(idx, spec({ visibleOnly: true })).visibleOnly).toBe(true)
  })

  it('from.withinRole keeps only candidates with a matching ancestor step', () => {
    const crafted = new Map<string, RefIndexEntry>([
      ['navigation|Menü|0 > button|Git|0', { ref: 'navigation|Menü|0 > button|Git|0', nodeId: 10, role: 'button', name: 'Git' }],
      ['button|Git|1', { ref: 'button|Git|1', nodeId: 11, role: 'button', name: 'Git' }],
    ])
    const parsed = parseExtractSpec(JSON.stringify({
      kind: 'list',
      from: { role: 'button', withinRole: 'navigation' },
      fields: ['name'],
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const matches = matchExtractCandidates(crafted, parsed.spec).matches
    expect(matches).toHaveLength(1)
    expect(matches[0]!.ref).toContain('navigation|')
  })
})

describe('plan08: projectExtract honesty', () => {
  const emptySources = (totalMatched = 0) => ({
    index: index(),
    matches: [],
    totalMatched,
    totalNodes: 5,
    resolvedNodes: 0,
  })

  it('list with no matches → data:[] + missing + complete:false (never an empty swallow)', () => {
    const parsed = parseExtractSpec('{"kind":"list","from":{"role":"link"}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const projection = projectExtract(parsed.spec, emptySources())
    expect(projection.data).toEqual([])
    expect(projection.honesty.missing).toContain('no node matched from/where')
    expect(projection.honesty.complete).toBe(false)
    expect(projection.count).toBe(0)
  })

  it('page rows answer missing per absent field and truncate long text honestly', () => {
    const parsed = parseExtractSpec('{"kind":"page","fields":["title","description","h1"]}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const long = 'x'.repeat(EXTRACT_TEXT_LIMIT + 50)
    const projection = projectExtract(parsed.spec, emptySources(), { title: 'Fixture', h1: long })
    expect(projection.data).toHaveLength(1)
    expect(projection.data[0]!.title).toBe('Fixture')
    // projectScalar cuts at EXTRACT_TEXT_LIMIT exactly (no ellipsis).
    expect(String(projection.data[0]!.h1).length).toBe(EXTRACT_TEXT_LIMIT)
    expect(projection.honesty.missing).toContainEqual(expect.stringContaining("field 'description'"))
    expect(projection.honesty.truncatedFields).toEqual(['h1'])
    expect(projection.honesty.complete).toBe(false)
  })

  // plan09-fix — an ABSENT page field must not masquerade as an empty one.
  // The page probe used to answer `""` for a missing `<h1>` / `meta[description]`
  // / `lang` attribute, so the row came back `complete:true` and a caller could
  // not tell "collected and empty" from "never there".
  it('plan09-fix: an absent page field is a missing line and complete:false, while an EMPTY one is a value', () => {
    const parsed = parseExtractSpec('{"kind":"page","fields":["title","h1","description"]}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // Absent: the probe answers null (no <h1>, no meta[description] at all).
    const absent = projectExtract(parsed.spec, emptySources(), {
      title: 'Fixture',
      h1: null,
      description: null,
    })
    expect(absent.honesty.missing).toContainEqual(expect.stringContaining("field 'h1'"))
    expect(absent.honesty.missing).toContainEqual(expect.stringContaining("field 'description'"))
    expect(absent.honesty.complete).toBe(false)
    // The absent key is NOT projected at all — a hole is not a value.
    expect(absent.data[0]).not.toHaveProperty('h1')
    expect(absent.data[0]).not.toHaveProperty('description')
    expect(absent.data[0]!.title).toBe('Fixture')

    // Present but empty: a real <h1></h1> and a content="" meta are VALUES.
    const empty = projectExtract(parsed.spec, emptySources(), {
      title: 'Fixture',
      h1: '',
      description: '',
    })
    expect(empty.honesty.missing).toEqual([])
    expect(empty.honesty.complete).toBe(true)
    expect(empty.data[0]!.h1).toBe('')
    expect(empty.data[0]!.description).toBe('')
  })

  // plan09-fix: the probe expression itself must preserve presence. This is the
  // layer that actually lied — the projection already treated null correctly.
  it('plan09-fix: PAGE_FIELDS_EXPRESSION answers null for an absent backing node, "" for an empty one', () => {
    expect(PAGE_FIELDS_EXPRESSION).toContain("return h ? (h.innerText || '') : null")
    expect(PAGE_FIELDS_EXPRESSION).toContain("return m ? (m.getAttribute('content') ?? '') : null")
    expect(PAGE_FIELDS_EXPRESSION).toContain("document.documentElement.hasAttribute('lang')")
    // The old collapsing form must be gone — that is the whole bug.
    expect(PAGE_FIELDS_EXPRESSION).not.toContain("{ innerText: '' }")
    expect(PAGE_FIELDS_EXPRESSION).not.toContain("{ content: '' }")
    expect(PAGE_FIELDS_EXPRESSION).not.toContain('document.documentElement.lang ||')
  })

  // plan09-fix: a node that simply has no form value must say so.
  it('plan09-fix: the value source reports a missing line on a node with no value', () => {
    const parsed = parseExtractSpec('{"kind":"list","from":{"selector":"section"},"fields":{"id":"attr:id","v":"value"}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const sources = {
      index: index(),
      matches: [{ ref: 'generic||0', nodeId: 4, role: 'generic', name: 'Kart' }],
      totalMatched: 1,
      totalNodes: 5,
      resolvedNodes: 1,
      // No `value` key at all: a <div>/<section> carries none, exactly like the
      // page-side evidence would not collect one.
      resolved: new Map([[
        'generic||0',
        { evidence: evidenceOf('generic||0', { attrs: { id: 'save' } }) },
      ]]),
    }
    const projection = projectExtract(parsed.spec, sources)
    expect(projection.honesty.missing).toContainEqual(
      expect.stringContaining("field 'v': node has no value"),
    )
    expect(projection.honesty.complete).toBe(false)
    // The hole is omitted, never written as a bare null.
    expect(projection.data[0]).not.toHaveProperty('v')
    expect(projection.data[0]!.id).toBe('save')
  })

  it('plan09-fix: an EMPTY form value is a value, not a missing line', () => {
    const parsed = parseExtractSpec('{"kind":"list","from":{"selector":"input"},"fields":{"v":"value"}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const sources = {
      index: index(),
      matches: [{ ref: 'textbox||0', nodeId: 6, role: 'textbox', name: '' }],
      totalMatched: 1,
      totalNodes: 5,
      resolvedNodes: 1,
      resolved: new Map([['textbox||0', { evidence: evidenceOf('textbox||0', { tag: 'input', value: '' }) }]]),
    }
    const projection = projectExtract(parsed.spec, sources)
    expect(projection.honesty.missing).toEqual([])
    expect(projection.honesty.complete).toBe(true)
    expect(projection.data[0]!.v).toBe('')
  })

  it('a host match set larger than limit reports limitApplied + honest numbers', () => {
    const parsed = parseExtractSpec('{"kind":"list","from":{"role":"button"},"fields":["name"],"limit":1}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const idx = index()
    const matches = [...idx.entries()]
      .filter(([, entry]) => entry.role === 'button')
      .map(([ref, entry]) => ({ ref, nodeId: entry.nodeId, role: entry.role, name: entry.name }))
    const resolved = new Map(matches.map(match => [match.ref, { evidence: evidenceOf(match.ref) }]))
    const projection = projectExtract(parsed.spec, {
      index: idx,
      matches: matches.slice(0, 1),
      resolved,
      totalMatched: 7,
      totalNodes: 5,
      resolvedNodes: 1,
    })
    expect(projection.data).toHaveLength(1)
    expect(projection.count).toBe(1)
    expect(projection.honesty.warnings.some(line => line.startsWith('limit 1 applied'))).toBe(true)
    expect(projection.honesty.complete).toBe(false)
  })

  it('visibleOnly removing everything says so in missing, not in silence', () => {
    const parsed = parseExtractSpec('{"kind":"list","from":{"role":"button"},"where":{"visibleOnly":true}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const idx = index()
    const matches = [...idx.entries()]
      .filter(([, entry]) => entry.role === 'button')
      .map(([ref, entry]) => ({ ref, nodeId: entry.nodeId, role: entry.role, name: entry.name }))
    const resolved = new Map(matches.map(match => [match.ref, { evidence: evidenceOf(match.ref, { visible: false }) }]))
    const projection = projectExtract(parsed.spec, {
      index: idx,
      matches,
      resolved,
      totalMatched: matches.length,
      totalNodes: 5,
      resolvedNodes: matches.length,
    })
    expect(projection.data).toEqual([])
    expect(projection.honesty.missing.join(' ')).toContain('no candidate survived')
    expect(projection.honesty.complete).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — service.extract() over a fake connection
// ---------------------------------------------------------------------------

interface HarnessOptions {
  root?: CdpDomNode
  describe?: unknown
  evaluateValue?: string
}

function bootService(options: HarnessOptions = {}): { service: CdpService, calls: string[] } {
  const calls: string[] = []
  const send = async (method: string): Promise<unknown> => {
    calls.push(method)
    if (method === 'DOM.enable') return {}
    if (method === 'DOM.getDocument') return { root: options.root ?? tinyDoc() }
    if (method === 'DOM.querySelector') return { nodeId: 0 }
    if (method === 'DOM.querySelectorAll') return { nodeIds: [] }
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
      evaluate: async () => ({
        value: options.evaluateValue ?? JSON.stringify({
          title: 'Fixture',
          url: 'https://example.com/',
          h1: 'Merhaba',
          lang: 'tr',
          openDialog: false,
        }),
        truncated: false,
        hasValue: true,
      }),
    }),
  })
  return { service, calls }
}

describe('plan08: service.extract honesty', () => {
  it('rejects a broken spec in-band WITHOUT touching the protocol', async () => {
    const { service, calls } = bootService()
    const outcome = await service.extract({ spec: 'not json' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('not valid JSON')
    expect(calls).toEqual([])
  })

  it('list with no matches → ok:true + data:[] + missing + complete:false', async () => {
    const { service } = bootService()
    const outcome = await service.extract({ spec: '{"kind":"list","from":{"role":"link"}}' })
    expect(outcome.ok).toBe(true)
    expect(outcome.kind).toBe('list')
    expect(outcome.data).toEqual([])
    expect(outcome.count).toBe(0)
    expect(outcome.complete).toBe(false)
    expect(outcome.missing).toContain('no node matched from/where')
    expect(outcome.targetId).toBe('tab-1')
    expect(outcome.title).toBe('Fixture')
  })

  it('list projects fresh rows with box + count source honesty', async () => {
    const { service } = bootService()
    const outcome = await service.extract({
      spec: '{"kind":"list","from":{"role":"button"},"fields":{"n":"name","b":"box","c":"count"}}',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.data).toHaveLength(2)
    expect(outcome.data?.[0]).toMatchObject({ n: 'Kaydet', b: { x: 10, y: 20, width: 30, height: 40 }, c: 2 })
    expect(outcome.count).toBe(2)
    expect(outcome.complete).toBe(true)
    expect(outcome.source).toEqual({ nodes: 2, totalNodes: 5 })
    expect(outcome.limitApplied).toBeUndefined()
  })

  it('limit larger than the match set sets limitApplied + complete:false', async () => {
    const { service } = bootService()
    const outcome = await service.extract({
      spec: '{"kind":"list","from":{"role":"button"},"fields":["name"],"limit":1}',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.data).toHaveLength(1)
    expect(outcome.limitApplied).toBe(true)
    expect(outcome.complete).toBe(false)
    expect(outcome.warnings?.some(line => line.includes('limit 1 applied'))).toBe(true)
  })

  it('page kind returns one row from a fresh evaluation, with truncation honesty', async () => {
    const { service } = bootService({
      evaluateValue: JSON.stringify({
        title: 'Fixture',
        url: 'https://example.com/',
        h1: 'x'.repeat(EXTRACT_TEXT_LIMIT + 10),
        lang: 'tr',
        openDialog: false,
      }),
    })
    const outcome = await service.extract({ spec: '{"kind":"page"}' })
    expect(outcome.ok).toBe(true)
    expect(outcome.kind).toBe('page')
    expect(outcome.data).toHaveLength(1)
    expect(outcome.data?.[0]?.title).toBe('Fixture')
    expect(outcome.data?.[0]?.lang).toBe('tr')
    expect(outcome.complete).toBe(false)
    expect(outcome.truncatedFields).toEqual(['h1'])
    expect(outcome.missing).toContainEqual(expect.stringContaining("field 'description'"))
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
  if (tools.size === 0) throw new Error('extract.spec: registerCdpTools registered zero tools')
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

const EXTRACT_OK = {
  ok: true,
  kind: 'list',
  targetId: 'tab-1',
  url: 'https://example.com/',
  title: 'Fixture',
  data: [{ n: 'Kaydet', href: 'https://example.com/save', box: { x: 10, y: 20, width: 30, height: 40 } }],
  count: 1,
  complete: false,
  missing: ["field 'lang': no source on this page"],
  truncatedFields: [],
  warnings: ['limit 1 applied: 7 candidates matched'],
  source: { nodes: 1, totalNodes: 5 },
  limitApplied: true,
} as const

describe('plan08: cdp_extract tool envelope', () => {
  it('validates complete AND broken envelopes under additionalProperties:false', async () => {
    const tools = await bootTools({ status: async () => ({}), extract: async () => EXTRACT_OK })
    const definition = tools.get('cdp_extract')
    expect(definition).toBeDefined()
    const ok = await execute(definition, { spec: '{"kind":"list"}' })
    expect(violationsOf(definition, ok)).toEqual([])
    // Regression: the open data rows (dynamic keys) must still validate —
    // this exact shape booted the whole composition when additionalProperties
    // was left implicit.
    expect(violationsOf(definition, EXTRACT_OK)).toEqual([])
    expect(violationsOf(definition, { ok: false, error: 'cdp_extract: spec is not valid JSON' })).toEqual([])
  })

  it('render separates COMPLETE from COMPLETE=false and never hides missing lines', async () => {
    const tools = await bootTools({ status: async () => ({}), extract: async () => EXTRACT_OK })
    const definition = tools.get('cdp_extract')
    const text = renderOf(definition, { spec: '{"kind":"list"}' }, EXTRACT_OK)
    expect(text).toContain('Extracted 1 row(s) (COMPLETE=false)')
    expect(text).toContain('from 1 of 5 nodes:')
    expect(text).toContain("missing: field 'lang'")
    expect(text).toContain('warning: limit 1 applied')
    expect(text).toContain('"n":"Kaydet"')

    const failed = renderOf(definition, { spec: 'broken' }, { ok: false, error: 'cdp_extract: spec is not valid JSON' })
    expect(failed).toContain('Extract failed:')
    expect(failed).not.toContain('Extracted')
  })

  it('forwards spec/targetId/timeoutMs verbatim', async () => {
    const seen: Record<string, unknown>[] = []
    const tools = await bootTools({
      status: async () => ({}),
      extract: async (options: Record<string, unknown>) => { seen.push(options); return EXTRACT_OK },
    })
    await execute(tools.get('cdp_extract'), { spec: '{"kind":"page"}', targetId: 'tab-9', timeoutMs: 25, bogus: 'x' })
    expect(seen[0]).toEqual({ spec: '{"kind":"page"}', targetId: 'tab-9', timeoutMs: 25 })
  })
})

// ---------------------------------------------------------------------------
// The REST twin — POST /api/server/cdp/extract
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
    url: CDP_EXTRACT_ROUTE,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

describe('plan08: POST /api/server/cdp/extract', () => {
  it('registers on the shared webServer at /api/server/cdp/extract', () => {
    const routes = setupRoutes({})
    expect(routes.has(CDP_EXTRACT_ROUTE)).toBe(true)
    expect(CDP_EXTRACT_ROUTE).toBe('/api/server/cdp/extract')
  })

  it('answers 200 for a projection (complete or empty — both are data)', async () => {
    const routes = setupRoutes({ extract: async () => EXTRACT_OK })
    const ok = captureResponse()
    await routes.get(CDP_EXTRACT_ROUTE)!(makeRequest('POST', { spec: '{"kind":"list"}' }), ok.res)
    expect(ok.status()).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true, kind: 'list', count: 1, complete: false })

    const emptyRoutes = setupRoutes({
      extract: async () => ({ ok: true, kind: 'list', data: [], count: 0, complete: false, missing: ['no node matched from/where'] }),
    })
    const empty = captureResponse()
    await emptyRoutes.get(CDP_EXTRACT_ROUTE)!(makeRequest('POST', { spec: '{"kind":"list","from":{"role":"link"}}' }), empty.res)
    expect(empty.status()).toBe(200)
    expect(empty.json().data).toEqual([])
    expect(empty.json().missing).toContain('no node matched from/where')
  })

  it('answers 400 for a missing or broken spec BEFORE any protocol call', async () => {
    let touched = 0
    const routes = setupRoutes({ extract: async () => { touched += 1; return EXTRACT_OK } })
    const handler = routes.get(CDP_EXTRACT_ROUTE)!

    const missing = captureResponse()
    await handler(makeRequest('POST', {}), missing.res)
    expect(missing.status()).toBe(400)
    expect(String(missing.json().error)).toContain('spec is required')

    const broken = captureResponse()
    await handler(makeRequest('POST', { spec: 'not json' }), broken.res)
    expect(broken.status()).toBe(400)
    expect(String(broken.json().error)).toContain('not valid JSON')

    const badKind = captureResponse()
    await handler(makeRequest('POST', { spec: '{"kind":"table"}' }), badKind.res)
    expect(badKind.status()).toBe(400)
    expect(String(badKind.json().error)).toContain('unknown kind')

    expect(touched).toBe(0)
  })

  it('answers 405 on GET and 500 on session refusals', async () => {
    const routes = setupRoutes({ extract: async () => { throw new Error('cdp: no page target is tracked') } })
    const handler = routes.get(CDP_EXTRACT_ROUTE)!

    const wrongMethod = captureResponse()
    await handler(makeRequest('GET'), wrongMethod.res)
    expect(wrongMethod.status()).toBe(405)

    const refusal = captureResponse()
    await handler(makeRequest('POST', { spec: '{"kind":"list","from":{"role":"link"}}' }), refusal.res)
    expect(refusal.status()).toBe(500)
    expect(String(refusal.json().error)).toContain('no page target')
  })
})
