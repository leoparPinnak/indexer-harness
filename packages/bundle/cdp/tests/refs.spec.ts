/**
 * plan08: the ref path — three layers:
 *  1. `buildRefIndex` is weaver-identical: every ref `cdp_snapshot` prints
 *     is indexed 1:1 in document order, and a missing ref is a stale-ref.
 *  2. `resolveRefOn`'s protocol sequence (fresh document → `DOM.resolveNode`
 *     → `Runtime.callFunctionOn`) plus every stale refusal it raises.
 *  3. the five tools' ref/stale-ref output fields under
 *     `additionalProperties:false`, the x/y relaxation, render honesty, the
 *     untouched plan02 ladder, and the `POST /api/server/cdp/ref` route.
 *
 * All of it is plain data + fake connections: no browser needed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpService } from '../src/service.ts'
import { registerCdpTools } from '../src/tools.ts'
import {
  CDP_REF_ROUTE,
  registerCdpRoutes,
} from '../src/routes.ts'
import { weaveSnapshot, type CdpDomNode } from '../src/snapshot.ts'
import { matchFindCandidates } from '../src/find.ts' /* plan08-fix */
import {
  REF_RENAMED_PREFIX,
  REF_STALE_PREFIX,
  RefStaleError,
  buildRefIndex,
  centerOf,
  clearRefOrigins,
  collectElementIds,
  isRefRenamedReason,
  isRefStaleError,
  isStaleRefReason,
  refFailureRun,
  refLocatorRun,
  renameNote,
  resolveRefOn,
  type RefEvidence,
  type RefRename,
} from '../src/refs.ts'

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

interface RecordedPage {
  title: string
  url: string
  viewport: { width: number, height: number }
  document: DomNode
}

const RECORDED = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-page.json', import.meta.url), 'utf8'),
) as RecordedPage

/** The fixture document as the weaver/ref path consume it. */
const rootDoc = (): CdpDomNode => structuredClone(RECORDED.document) as unknown as CdpDomNode

/** A tiny hand-built document: two identically-labelled buttons + an input. */
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

/** Fresh evidence as the service hands it to the tools. */
function evidenceOf(ref: string, overrides: Partial<RefEvidence> = {}): RefEvidence {
  return {
    ref,
    role: 'button',
    name: 'Kaydet',
    tag: 'button',
    id: 'save',
    ariaLabel: 'Kaydet',
    rect: { x: 100, y: 100, width: 80, height: 30 },
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
// Layer 1 — the ref index is the snapshot weaver
// ---------------------------------------------------------------------------

describe('plan08: buildRefIndex mirrors the snapshot weaver', () => {
  it('indexes every woven ref 1:1 with the same role/name and element node', () => {
    const page = RECORDED
    const woven = weaveSnapshot({
      document: page.document as unknown as CdpDomNode,
      viewport: page.viewport,
      title: page.title,
      url: page.url,
    }).nodes
    const root = rootDoc()
    const index = buildRefIndex(root)
    const ids = collectElementIds(root)
    // The index runs with raised display caps, so it is at least the woven
    // list — never shorter (a ref the model sees must always resolve).
    expect(index.size).toBeGreaterThanOrEqual(woven.length)
    expect(ids.length).toBeGreaterThanOrEqual(woven.length)
    for (const [position, node] of woven.entries()) {
      const entry = index.get(node.ref)
      expect(entry, `ref "${node.ref}" must be indexed`).toBeDefined()
      expect(entry!.role).toBe(node.role)
      expect(entry!.name).toBe(node.name)
      // Zip check: the entry's node id is the element at the same DFS slot.
      expect(entry!.nodeId).toBe(ids[position])
    }
  })

  it('ordinal-disambiguates duplicate buttons and keeps both resolvable', () => {
    const index = buildRefIndex(tinyDoc())
    // html, body, two buttons, input — every element is indexed.
    expect(index.size).toBe(5)
    const byNode = new Map([...index.entries()].map(([ref, entry]) => [entry.nodeId, ref]))
    const first = byNode.get(4)!
    const second = byNode.get(5)!
    // Same parent, same role|name: the ordinals (|0 vs |1) separate them.
    expect(first.endsWith('|0')).toBe(true)
    expect(second.endsWith('|1')).toBe(true)
    expect(first.slice(0, first.length - 1)).toBe(second.slice(0, second.length - 1))
    expect(index.get(first)!.nodeId).toBe(4)
    expect(index.get(second)!.nodeId).toBe(5)
  })

  it('a ref the document does not carry is a stale-ref RefStaleError', async () => {
    const stale = await resolveRefOn(
      { send: async () => ({}) },
      's-1',
      'nobody|nowhere|7',
      rootDoc(),
    ).catch((error: unknown) => error)
    expect(isRefStaleError(stale)).toBe(true)
    expect(stale).toBeInstanceOf(RefStaleError)
    expect((stale as Error).message.startsWith(REF_STALE_PREFIX)).toBe(true)
    expect((stale as Error).message).toContain('cdp_snapshot again')
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — resolveRefOn's protocol sequence and stale refusals
// ---------------------------------------------------------------------------

interface SendCall {
  method: string
  params: Record<string, unknown>
  sessionId?: string | undefined
}

function fakeConnection(behaviour: {
  resolve?: () => Promise<unknown> | unknown
  describe?: () => Promise<unknown> | unknown
} = {}): { calls: SendCall[], send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown> } {
  const calls: SendCall[] = []
  return {
    calls,
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId })
      if (method === 'DOM.resolveNode') {
        if (behaviour.resolve !== undefined) return await behaviour.resolve()
        return { object: { objectId: 'o-1' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        if (behaviour.describe !== undefined) return await behaviour.describe()
        return {
          result: {
            value: {
              ok: true,
              tag: 'button',
              id: 'save',
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
    },
  }
}

const staleOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a RefStaleError, got success')
}

describe('plan08: resolveRefOn protocol sequence', () => {
  it('resolves in order: resolveNode(nodeId) → callFunctionOn(objectId), same session', async () => {
    const connection = fakeConnection()
    const root = tinyDoc()
    const index = buildRefIndex(root)
    const ref = [...index.keys()][0]!
    const evidence = await resolveRefOn(connection, 's-tab', ref, root)
    expect(connection.calls.map(call => call.method)).toEqual(['DOM.resolveNode', 'Runtime.callFunctionOn'])
    expect(connection.calls[0]!.params.nodeId).toBe(index.get(ref)!.nodeId)
    expect(connection.calls[0]!.sessionId).toBe('s-tab')
    expect(connection.calls[1]!.params.objectId).toBe('o-1')
    expect(connection.calls[1]!.params.returnByValue).toBe(true)
    expect(connection.calls[1]!.sessionId).toBe('s-tab')
    // Role/name come from the woven index; geometry from the page.
    expect(evidence).toMatchObject({
      ref,
      role: index.get(ref)!.role,
      tag: 'button',
      rect: { x: 10, y: 20, width: 30, height: 40 },
      visible: true,
      hitTarget: true,
      frameLocal: false,
    })
  })

  it('DOM.resolveNode refusing the node is a stale-ref naming the refusal', async () => {
    const connection = fakeConnection({
      resolve: () => { throw new Error('No node with given id found') },
    })
    const root = tinyDoc()
    const ref = [...buildRefIndex(root).keys()][0]!
    const error = await staleOf(resolveRefOn(connection, 's', ref, root))
    expect(error).toBeInstanceOf(RefStaleError)
    expect(error.message).toContain('DOM.resolveNode refused')
    expect(error.message.startsWith(REF_STALE_PREFIX)).toBe(true)
  })

  it('a describe failure or empty box is a stale-ref with the page detail', async () => {
    const root = tinyDoc()
    const ref = [...buildRefIndex(root).keys()][0]!
    const failed = await staleOf(resolveRefOn(
      fakeConnection({ describe: () => ({ result: { value: { ok: false, error: 'detached' } } }) }),
      's', ref, root,
    ))
    expect(failed.message).toContain('detached')
    expect(failed.message.startsWith(REF_STALE_PREFIX)).toBe(true)

    const empty = await staleOf(resolveRefOn(
      fakeConnection({ describe: () => ({ result: { value: { ok: true, rect: { x: 0, y: 0, width: 0, height: 0 }, text: '' } } }) }),
      's', ref, root,
    ))
    expect(empty.message).toContain('empty bounding box')
  })

  it('a frame-local rect propagates honestly instead of failing', async () => {
    const connection = fakeConnection({
      describe: () => ({
        result: {
          value: {
            ok: true,
            tag: 'a',
            rect: { x: 1, y: 2, width: 10, height: 10 },
            visible: true,
            enabled: true,
            inViewport: true,
            hitTarget: true,
            frameLocal: true,
            text: 'x',
            textLength: 1,
            url: 'https://frame.test/',
          },
        },
      }),
    })
    const root = tinyDoc()
    const ref = [...buildRefIndex(root).keys()][0]!
    const evidence = await resolveRefOn(connection, 's', ref, root)
    expect(evidence.frameLocal).toBe(true)
  })

  it('centerOf clamps into the viewport and rounds', () => {
    expect(centerOf({ x: 100, y: 100, width: 80, height: 30 })).toEqual({ x: 140, y: 115 })
    expect(centerOf({ x: 780, y: 585, width: 40, height: 30 }, 800, 600)).toEqual({ x: 799, y: 599 })
    expect(centerOf({ x: -50, y: -20, width: 40, height: 30 }, 800, 600)).toEqual({ x: 0, y: 0 })
  })

  it('wraps evidence into a strategy:ref locator run and flags stale reasons', () => {
    const run = refLocatorRun(evidenceOf('button|Kaydet|0'), 'tab-1')
    expect(run.reply.ok).toBe(true)
    expect(run.reply.strategy).toBe('ref')
    expect(run.reply.matched).toBe(1)
    expect(run.reply.target?.text).toBe('Kaydet')
    expect(run.reply.actionability?.failures).toEqual([])

    const hidden = refLocatorRun(evidenceOf('button|Kaydet|0', { visible: false }), 'tab-1')
    expect(hidden.reply.actionability?.visible).toBe(false)
    expect(hidden.reply.actionability?.failures).toContain('not visible')

    const failure = refFailureRun('x|y|0', 'tab-1', `${REF_STALE_PREFIX}: gone`)
    expect(failure.reply.ok).toBe(false)
    expect(failure.reply.strategy).toBe('ref')
    expect(failure.reply.reason).toBe(`${REF_STALE_PREFIX}: gone`)

    expect(isStaleRefReason(`${REF_STALE_PREFIX}: gone (timed out after 10ms)`)).toBe(true)
    expect(isStaleRefReason('element resolved but is not visible')).toBe(false)
    expect(isStaleRefReason(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — the five tools against a stand-in service
// ---------------------------------------------------------------------------

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function bootTools(service: unknown): Promise<Map<string, ToolDefinition>> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  // plan02's mount recipe: reflect.provide + one macrotask, because inject
  // callbacks settle after their services resolve.
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    guard: () => () => {},
  })
  registerCdpTools(ctx, service as CdpService)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  if (tools.size === 0) throw new Error('refs.spec: registerCdpTools registered zero tools')
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

const STALE_REASON = `${REF_STALE_PREFIX}: no element carries this reference in the current document (the page re-rendered or navigated; call cdp_snapshot again)`

/** A service whose ref/locator surface answers from the fixtures above. */
function fakeService(overrides: Record<string, unknown> = {}): { service: CdpService, seen: Record<string, unknown[][]> } {
  const seen: Record<string, unknown[][]> = { readText: [], expectCheck: [], readTextByRef: [], expectCheckByRef: [] }
  const base = {
    status: () => ({
      ok: true,
      version: '0.0.0',
      targets: 1,
      proxy: { active: false },
      connectionState: 'connected',
      openTabs: [],
      activeTargetId: 'tab-1',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1, source: 'live-window' },
    }),
    resolveRef: async (ref: string): Promise<RefEvidence> => evidenceOf(ref),
    describePoint: async () => undefined,
    describeFocus: async () => undefined,
    guardPageDialog: async (_targetId: unknown, fn: () => Promise<unknown>): Promise<unknown> => await fn(),
    click: async () => ({}),
    type: async () => ({ typed: 5 }),
    snapshot: async () => ({
      title: 'T',
      url: 'https://example.com/',
      viewport: { width: 800, height: 600 },
      nodes: [{ ref: 'button|Kaydet|0', role: 'button', name: 'Kaydet' }],
    }),
    readText: async (spec: unknown) => {
      seen.readText!.push([spec])
      return { ok: true, matched: 1, strategy: 'css', candidates: [], waitedMs: 0, text: 'ladder', truncated: false, targetId: 'tab-1', url: 'u' }
    },
    readTextByRef: async (ref: string) => {
      seen.readTextByRef!.push([ref])
      return { ok: false, matched: 0, strategy: 'ref', candidates: [], waitedMs: 0, reason: STALE_REASON, ref, staleRef: true, targetId: 'tab-1', url: 'u' }
    },
    expectCheck: async (options: Record<string, unknown>) => {
      seen.expectCheck!.push([options])
      return { ok: true, check: options.check, passed: true, matched: 1, strategy: 'none', candidates: [], waitedMs: 0, targetId: 'tab-1', url: 'u' }
    },
    expectCheckByRef: async (ref: string, options: Record<string, unknown>) => {
      seen.expectCheckByRef!.push([ref, options])
      return { ok: false, check: options.check, passed: false, matched: 0, strategy: 'ref', candidates: [], waitedMs: 0, reason: STALE_REASON, ref, staleRef: true, targetId: 'tab-1', url: 'u' }
    },
    ...overrides,
  }
  return { service: base as unknown as CdpService, seen }
}

describe('plan08: cdp_click ref path', () => {
  it('clicks the fresh centre of a resolved ref and stays schema-clean', async () => {
    const { service } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const result = await execute(definition, { ref: 'button|Kaydet|0' })
    expect(result).toMatchObject({ ok: true, ref: 'button|Kaydet|0', staleRef: false, resolvedBy: 'ref' })
    expect(violationsOf(definition, result)).toEqual([])
    expect(renderOf(definition, { ref: 'x' }, result)).toBe('Click dispatched successfully.')
  })

  it('a stale ref answers ok:false + staleRef with the stale-ref reason, not a click', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => { throw new RefStaleError(ref, STALE_REASON) },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const result = await execute(definition, { ref: 'button|Gone|0' })
    expect(result.ok).toBe(false)
    expect(result.staleRef).toBe(true)
    expect(result.resolvedBy).toBe('ref')
    expect(String(result.reason).startsWith(REF_STALE_PREFIX)).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
    // The renderer must not claim success for a failed click.
    expect(renderOf(definition, { ref: 'x' }, result)).toContain('Click failed')
  })

  it('refuses frame-local refs in-band (staleRef false, honest reason)', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => evidenceOf(ref, { frameLocal: true }),
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const result = await execute(definition, { ref: 'a|b|0' })
    expect(result.ok).toBe(false)
    expect(result.staleRef).toBe(false)
    expect(String(result.reason)).toContain('frame-local')
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('without ref it demands x AND y in-band (x/y are no longer schema-required)', async () => {
    const { service } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const missing = await execute(definition, {})
    expect(missing.ok).toBe(false)
    expect(String(missing.reason)).toContain('pass ref, or pass both x and y')
    expect(violationsOf(definition, missing)).toEqual([])
    const half = await execute(definition, { x: 10 })
    expect(half.ok).toBe(false)
    expect(violationsOf(definition, half)).toEqual([])
  })

  it('plan03 session refusals still THROW (only stale-refs answer in-band)', async () => {
    const { service } = fakeService({
      resolveRef: async (): Promise<RefEvidence> => { throw new Error('cdp: no page target is tracked for this session') },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    await expect(execute(definition, { ref: 'a|b|0' })).rejects.toThrow('no page target is tracked')
  })
})

describe('plan08: cdp_type ref path', () => {
  it('focuses by clicking the fresh centre, then types', async () => {
    const { service } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_type')
    const result = await execute(definition, { text: 'Merhaba', ref: 'input|Merhaba|0' })
    expect(result).toMatchObject({ ok: true, typedCharacters: 5, ref: 'input|Merhaba|0', staleRef: false, resolvedBy: 'ref' })
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('a stale ref answers ok:false with typedCharacters 0, schema-clean', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => { throw new RefStaleError(ref, STALE_REASON) },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_type')
    const result = await execute(definition, { text: 'x', ref: 'a|b|0' })
    expect(result).toMatchObject({ ok: false, typedCharacters: 0, staleRef: true, resolvedBy: 'ref' })
    expect(violationsOf(definition, result)).toEqual([])
    expect(renderOf(definition, {}, result)).toContain('Typing failed')
  })
})

describe('plan08: cdp_snapshot ref verification', () => {
  it('verifies a fresh ref beside the snapshot (rect echo, schema-clean)', async () => {
    const { service } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_snapshot')
    const result = await execute(definition, { ref: 'button|Kaydet|0' })
    expect(result).toMatchObject({ ok: true, ref: 'button|Kaydet|0', staleRef: false })
    expect(result.refRect).toMatchObject({ x: 100, y: 100, width: 80, height: 30 })
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('a stale ref keeps the snapshot but flags staleRef + refReason', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => { throw new RefStaleError(ref, STALE_REASON) },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_snapshot')
    const result = await execute(definition, { ref: 'a|b|0' })
    expect(result.ok).toBe(true) // the snapshot itself succeeded
    expect(result.staleRef).toBe(true)
    expect(String(result.refReason).startsWith(REF_STALE_PREFIX)).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
    expect(renderOf(definition, {}, result)).toContain('REF STALE')
    // Without ref the answer carries none of the ref fields (schema-clean too).
    const plain = await execute(definition, {})
    expect(plain.ref).toBeUndefined()
    expect(violationsOf(definition, plain)).toEqual([])
  })
})

describe('plan08: cdp_text / cdp_expect ref paths', () => {
  it('cdp_text with a ref goes through readTextByRef and echoes ref/staleRef', async () => {
    const { service, seen } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_text')
    const result = await execute(definition, { ref: 'button|Kaydet|0', timeoutMs: 50 })
    expect(seen.readTextByRef).toHaveLength(1)
    expect(seen.readText).toHaveLength(0) // the ladder never ran
    expect(result).toMatchObject({ ok: false, strategy: 'ref', ref: 'button|Kaydet|0', staleRef: true })
    expect(String(result.reason).startsWith(REF_STALE_PREFIX)).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('cdp_text without a ref still runs the plan02 ladder untouched', async () => {
    const { service, seen } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_text')
    const result = await execute(definition, { css: '.save' })
    expect(seen.readTextByRef).toHaveLength(0)
    expect(seen.readText).toHaveLength(1)
    expect((seen.readText![0]![0] as { css?: string }).css).toBe('.save')
    expect(result.ok).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('cdp_expect with a ref goes through expectCheckByRef; missing expected fails in-band first', async () => {
    const { service, seen } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_expect')
    const invalid = await execute(definition, { check: 'textEquals', ref: 'a|b|0' })
    expect(invalid.ok).toBe(false)
    expect(String(invalid.reason)).toContain('requires expected')
    expect(invalid.ref).toBe('a|b|0')
    expect(invalid.staleRef).toBe(false)
    expect(seen.expectCheckByRef).toHaveLength(0)
    expect(violationsOf(definition, invalid)).toEqual([])

    const result = await execute(definition, { check: 'visible', ref: 'a|b|0' })
    expect(seen.expectCheckByRef).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, passed: false, strategy: 'ref', ref: 'a|b|0', staleRef: true })
    expect(violationsOf(definition, result)).toEqual([])
  })

  it('urlMatches keeps its URL-only path even when a ref is passed', async () => {
    const { service, seen } = fakeService()
    const tools = await bootTools(service)
    const definition = tools.get('cdp_expect')
    const result = await execute(definition, { check: 'urlMatches', expected: 'dashboard', ref: 'a|b|0' })
    expect(seen.expectCheckByRef).toHaveLength(0)
    expect(seen.expectCheck).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// plan08-fix-ref-rename — a NAME change is not a NODE change
//
// The reported bug: an "Onayla" button that renames itself to "Onayla ✓"
// after the click was refused as `stale-ref`, which told the model the page
// had re-rendered and sent it into a snapshot loop on a page that never
// re-rendered. A ref IS a name, so the name change loses the ref — but the
// DOM node (backendNodeId 40) is still right there, and that is what decides.
// ---------------------------------------------------------------------------

const PAGE_URL = 'https://example.com/verify'

/** A confirm page whose button's accessible name IS its text child. */
function confirmDoc(label: string): CdpDomNode {
  return {
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    nodeValue: '',
    children: [
      {
        nodeId: 2,
        backendNodeId: 2,
        nodeType: 1,
        nodeName: 'HTML',
        localName: 'html',
        children: [
          {
            nodeId: 3,
            backendNodeId: 3,
            nodeType: 1,
            nodeName: 'BODY',
            localName: 'body',
            children: [
              {
                nodeId: 4,
                backendNodeId: 40,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                attributes: ['id', 'confirm'],
                children: [
                  { nodeId: 7, backendNodeId: 70, nodeType: 3, nodeName: '#text', nodeValue: label },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as CdpDomNode
}

/** The same page AFTER the button really left the DOM (nodeId 4 no longer exists). */
function confirmDocAfterRemoval(): CdpDomNode {
  const doc = confirmDoc('Onayla') as unknown as { children: Array<{ children: Array<{ children: unknown[] }> }> }
  doc.children[0]!.children[0]!.children = [
    {
      nodeId: 5,
      backendNodeId: 50,
      nodeType: 1,
      nodeName: 'INPUT',
      localName: 'input',
      attributes: ['value', 'Merhaba'],
      children: [],
    },
  ]
  return doc as unknown as CdpDomNode
}

/**
 * A real `CdpService` whose connection/session seams answer from a page the
 * test can rewrite between the snapshot and the action — no browser needed.
 */
function wireRefService(document: CdpDomNode): {
  service: CdpService
  page: { document: CdpDomNode }
  described: { text: string }
  resolvedNodeIds: number[]
} {
  const page = { document }
  const described = { text: 'Onayla' }
  const resolvedNodeIds: number[] = []
  const service = new CdpService()
  const seams = service as unknown as {
    connection: unknown
    getPageSession: (targetId?: string) => Promise<unknown>
  }
  seams.connection = {
    connected: true,
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument') return { root: page.document }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1 } }
      }
      if (method === 'DOM.resolveNode') {
        const nodeId = Number(params?.nodeId)
        resolvedNodeIds.push(nodeId)
        return { object: { objectId: `o-${String(nodeId)}` } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              ok: true,
              tag: 'button',
              id: 'confirm',
              ariaLabel: '',
              text: described.text,
              textLength: described.text.length,
              rect: { x: 10, y: 20, width: 80, height: 30 },
              visible: true,
              enabled: true,
              inViewport: true,
              hitTarget: true,
              frameLocal: false,
              url: PAGE_URL,
            },
          },
        }
      }
      return {}
    },
  }
  seams.getPageSession = async () => ({
    sessionId: 'sess-1',
    title: async () => 'Dogrulama',
    url: async () => PAGE_URL,
  })
  return { service, page, described, resolvedNodeIds }
}

/** The button's ref in a fresh snapshot, or a hard failure (never a silent skip). */
function buttonRefOf(nodes: readonly { ref: string, role: string }[]): string {
  const found = nodes.find(node => node.role === 'button')
  expect(found, 'the snapshot must carry the confirm button').toBeDefined()
  return found!.ref
}

describe('plan08-fix-ref-rename: a rename is delivered, a removal is stale', () => {
  beforeEach(() => {
    // The origin registry is module state by design; each case starts clean.
    clearRefOrigins()
  })

  it('branch 1 — snapshot → the button renames itself → the ref is DELIVERED with an honest reason', async () => {
    const { service, page, described, resolvedNodeIds } = wireRefService(confirmDoc('Onayla'))
    const snapshot = await service.snapshot()
    const ref = buttonRefOf(snapshot.nodes)
    expect(ref).toContain('button|Onayla|0')

    // The page answers the click: same node (4/40), new accessible name.
    described.text = 'Onayla ✓'
    page.document = confirmDoc('Onayla ✓')

    const evidence = await service.resolveRef(ref)
    // Delivered: the SAME node answered, and its geometry is live evidence.
    expect(evidence.name).toBe('Onayla ✓')
    expect(evidence.rect).toEqual({ x: 10, y: 20, width: 80, height: 30 })
    expect(evidence.visible).toBe(true)
    expect(resolvedNodeIds).toEqual([4])
    // …and the reason is a rename, never a re-render claim.
    expect(evidence.renamed).toMatchObject({
      fromRef: ref,
      fromRole: 'button',
      fromName: 'Onayla',
      toName: 'Onayla ✓',
      nodeId: 4,
    })
    const note = renameNote(evidence.renamed as RefRename)
    expect(note.startsWith(`${REF_RENAMED_PREFIX}:`)).toBe(true)
    expect(note).toContain('"Onayla"')
    expect(note).toContain('"Onayla ✓"')
    expect(note).toContain('the element is still there')
    expect(isRefRenamedReason(note)).toBe(true)
    // A rename must never be mistaken for either other refusal class.
    expect(isStaleRefReason(note)).toBe(false)
  })

  it('branch 2 — snapshot → the node leaves the DOM → the ref is still an honest stale-ref', async () => {
    const { service, page, resolvedNodeIds } = wireRefService(confirmDoc('Onayla'))
    const snapshot = await service.snapshot()
    const ref = buttonRefOf(snapshot.nodes)

    page.document = confirmDocAfterRemoval()

    const error = await service.resolveRef(ref).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RefStaleError)
    const message = (error as Error).message
    expect(message.startsWith(`${REF_STALE_PREFIX}:`)).toBe(true)
    expect(message).toContain('cdp_snapshot again')
    expect(message).not.toContain(REF_RENAMED_PREFIX)
    // Nothing was resolved, so nothing was clicked at recycled coordinates.
    expect(resolvedNodeIds).toEqual([])
  })

  it('branch 3 — snapshot → nothing changed → the ref resolves with no note at all', async () => {
    const { service, resolvedNodeIds } = wireRefService(confirmDoc('Onayla'))
    const snapshot = await service.snapshot()
    const ref = buttonRefOf(snapshot.nodes)

    const evidence = await service.resolveRef(ref)
    expect(evidence.name).toBe('Onayla')
    expect(evidence.renamed).toBeUndefined()
    expect(resolvedNodeIds).toEqual([4])
    // …and the same ref resolves again on the very next action.
    expect((await service.resolveRef(ref)).name).toBe('Onayla')
  })

  it('a navigation between snapshot and action keeps the honest stale-ref', async () => {
    const index = buildRefIndex(confirmDoc('Onayla'))
    const ref = [...index.keys()].find(key => key.includes('button|Onayla|0'))!
    const entry = index.get(ref)!
    const connection = fakeConnection({
      describe: () => ({
        result: {
          value: {
            ok: true,
            tag: 'button',
            text: 'Onayla ✓',
            textLength: 8,
            rect: { x: 0, y: 0, width: 10, height: 10 },
            url: 'https://example.com/next',
          },
        },
      }),
    })
    // A recycled node id in ANOTHER document proves nothing, so the fallback
    // must refuse instead of claiming "same element, new name". The fresh page
    // already renamed the button (that is why the name lookup missed) and now
    // reports a different URL — a navigation, not a rename.
    const error = await staleOf(resolveRefOn(connection, 's', ref, confirmDoc('Onayla ✓'), {
      origin: {
        ref,
        nodeId: entry.nodeId,
        ...(entry.backendNodeId !== undefined ? { backendNodeId: entry.backendNodeId } : {}),
        role: entry.role,
        name: entry.name,
        url: PAGE_URL,
      },
    }))
    expect(error.message).toContain('the page navigated since this ref was issued')
    expect(error.message.startsWith(REF_STALE_PREFIX)).toBe(true)
  })

  it('cdp_click delivers to a renamed target and reports ref-target-renamed, not a failure', async () => {
    const clicked: Array<{ x: number, y: number }> = []
    const rename: RefRename = {
      fromRef: 'button|Onayla|0',
      fromRole: 'button',
      fromName: 'Onayla',
      toRef: 'button|Onayla ✓|0',
      toRole: 'button',
      toName: 'Onayla ✓',
      nodeId: 4,
    }
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => evidenceOf(ref, {
        name: 'Onayla ✓',
        text: 'Onayla ✓',
        renamed: rename,
      }),
      click: async (point: { x: number, y: number }): Promise<unknown> => {
        clicked.push(point)
        return { delivered: true }
      },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const result = await execute(definition, { ref: 'button|Onayla|0' })
    // The action reached the element; only the name moved.
    expect(result).toMatchObject({ ok: true, staleRef: false, resolvedBy: 'ref' })
    expect(clicked).toHaveLength(1)
    expect(String(result.refNote)).toContain(REF_RENAMED_PREFIX)
    expect(violationsOf(definition, result)).toEqual([])
    expect(renderOf(definition, {}, result)).toContain('REF RENAMED')
  })

  it('cdp_snapshot verifies a renamed ref as fresh (staleRef false) and prints the note', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => evidenceOf(ref, {
        name: 'Onayla ✓',
        renamed: {
          fromRef: 'button|Onayla|0',
          fromRole: 'button',
          fromName: 'Onayla',
          toRef: 'button|Onayla ✓|0',
          toRole: 'button',
          toName: 'Onayla ✓',
          nodeId: 4,
        },
      }),
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_snapshot')
    const result = await execute(definition, { ref: 'button|Onayla|0' })
    expect(result).toMatchObject({ ok: true, staleRef: false })
    expect(String(result.refNote)).toContain(REF_RENAMED_PREFIX)
    expect(violationsOf(definition, result)).toEqual([])
    const rendered = renderOf(definition, {}, result)
    expect(rendered).toContain('REF RENAMED')
    expect(rendered).not.toContain('REF STALE')
  })

  it('refLocatorRun carries the rename note as a warning on an ok:true run', () => {
    const run = refLocatorRun(evidenceOf('button|Onayla ✓|0', {
      renamed: {
        fromRef: 'button|Onayla|0',
        fromRole: 'button',
        fromName: 'Onayla',
        toRef: 'button|Onayla ✓|0',
        toRole: 'button',
        toName: 'Onayla ✓',
        nodeId: 4,
      },
    }), 'tab-1')
    expect(run.reply.ok).toBe(true)
    expect(run.reply.reason).toBeUndefined()
    expect(String(run.reply.warning)).toContain(REF_RENAMED_PREFIX)
  })
})

// ---------------------------------------------------------------------------
// The REST twin — POST /api/server/cdp/ref
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
    url: '/api/server/cdp/ref',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

describe('plan08: POST /api/server/cdp/ref', () => {
  it('registers on the shared webServer next to the other cdp routes', () => {
    const routes = setupRoutes({})
    expect(routes.has(CDP_REF_ROUTE)).toBe(true)
    expect(CDP_REF_ROUTE).toBe('/api/server/cdp/ref')
  })

  it('answers 200 with evidence on success, 200 + staleRef for a stale ref', async () => {
    const routes = setupRoutes({
      resolveRef: async (ref: string): Promise<RefEvidence> => evidenceOf(ref),
    })
    const handler = routes.get(CDP_REF_ROUTE)!
    const ok = captureResponse()
    await handler(makeRequest('POST', { ref: 'button|Kaydet|0' }), ok.res)
    expect(ok.status()).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true, resolvedBy: 'ref', ref: 'button|Kaydet|0' })

    const stale = setupRoutes({
      resolveRef: async (ref: string): Promise<RefEvidence> => { throw new RefStaleError(ref, STALE_REASON) },
    })
    const staleHandler = stale.get(CDP_REF_ROUTE)!
    const staleRes = captureResponse()
    await staleHandler(makeRequest('POST', { ref: 'a|b|0' }), staleRes.res)
    expect(staleRes.status()).toBe(200) // a stale ref is data, not an HTTP failure
    expect(staleRes.json()).toMatchObject({ ok: false, staleRef: true, ref: 'a|b|0' })
    expect(String(staleRes.json().reason).startsWith(REF_STALE_PREFIX)).toBe(true)
  })

  it('answers 400 for a missing ref, 405 for the wrong method, 500 for refusals', async () => {
    const routes = setupRoutes({
      resolveRef: async (): Promise<RefEvidence> => { throw new Error('cdp: no page target is tracked') },
    })
    const handler = routes.get(CDP_REF_ROUTE)!

    const empty = captureResponse()
    await handler(makeRequest('POST', {}), empty.res)
    expect(empty.status()).toBe(400)
    expect(empty.json().ok).toBe(false)

    const wrongMethod = captureResponse()
    await handler(makeRequest('GET'), wrongMethod.res)
    expect(wrongMethod.status()).toBe(405)

    const refusal = captureResponse()
    await handler(makeRequest('POST', { ref: 'a|b|0' }), refusal.res)
    expect(refusal.status()).toBe(500)
    expect(String(refusal.json().error)).toContain('no page target')
  })
})

// ---------------------------------------------------------------------------
// plan08-fix (T3 F2 / T6 §3.5) — the round-trip seam. Two independent test
// agents reported "find says actionable, every consumer says stale-ref" on an
// unchanged page: the renders decorated refs (`@ref`, `#1 @ref`) and models
// copied the decoration verbatim. Production and resolution now meet at ONE
// seam (resolveRefOn), the seam tolerates our own artifact, and a string that
// was never a ref answers `unresolved-ref:` instead of blaming the page.
// ---------------------------------------------------------------------------

describe('plan08-fix: ref round-trip through the single seam', () => {
  it("tolerates our own render decoration: a leading '@' still resolves", async () => {
    const root = tinyDoc()
    const ref = [...buildRefIndex(root).keys()].find((key) => key.includes('button|'))!
    const evidence = await resolveRefOn(fakeConnection(), 's-1', `@${ref}`, root)
    expect(evidence.ref).toBe(ref) // the NORMALIZED key resolved
    expect(evidence.role).toBe('button')
    expect(evidence.rect.width).toBeGreaterThan(0)
  })

  it('accepts a bare role|name|ordinal step as secondary (first in document order)', async () => {
    const root = tinyDoc()
    const canonical = [...buildRefIndex(root).keys()].find((key) => key.includes('button|'))!
    const short = canonical.slice(canonical.lastIndexOf('>') + 1)
    expect(short).toBe('button|Kaydet|0')
    const evidence = await resolveRefOn(fakeConnection(), 's-1', short, root)
    expect(evidence.ref).toBe(canonical) // echoes the CANONICAL path that resolved
    expect(evidence.role).toBe('button')
    // Same rule in cdp_find's ref query — production and resolution agree.
    const matches = matchFindCandidates(buildRefIndex(root), { ref: short })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.ref).toBe(canonical)
  })

  it('a string that was never a ref answers unresolved-ref, not stale-ref', async () => {
    const noConnection = { send: async () => ({}) }
    const formatError = await staleOf(resolveRefOn(noConnection, 's-1', 'not-a-ref', tinyDoc()))
    expect(formatError.message.startsWith('unresolved-ref:')).toBe(true)
    expect(formatError.message).toContain("expected '<role>|<name>|<ordinal>' steps joined by '>'")
    expect(isStaleRefReason(formatError.message)).toBe(false)
    // T3 transcribed `@html‖0>…`: no ASCII `|<ordinal>` tail → same honest class.
    const unicode = await staleOf(resolveRefOn(noConnection, 's-1', 'html‖0>button‖0', tinyDoc()))
    expect(unicode.message.startsWith('unresolved-ref:')).toBe(true)
    expect(isStaleRefReason(unicode.message)).toBe(false)
  })

  it('a well-formed ref the document lacks keeps the stale-ref contract', async () => {
    const error = await staleOf(resolveRefOn({ send: async () => ({}) }, 's-1', 'button|Gone|9', tinyDoc()))
    expect(error.message.startsWith(REF_STALE_PREFIX)).toBe(true)
    expect(isStaleRefReason(error.message)).toBe(true)
    expect(error.message).toContain('cdp_snapshot again')
  })

  it('rendered refs are copy-paste safe: quoted, never decorated', async () => {
    const { service } = fakeService()
    const tools = await bootTools(service)
    const ref = [...buildRefIndex(tinyDoc()).keys()].find((key) => key.includes('button|'))!

    const snapshotText = renderOf(tools.get('cdp_snapshot'), {}, {
      ok: true,
      title: 'T',
      url: 'https://example.com/',
      viewport: { width: 800, height: 600 },
      nodeCount: 1,
      nodes: [{ ref, role: 'button', name: 'Kaydet' }],
    })
    expect(snapshotText).toContain(`"${ref}"`)
    expect(snapshotText).not.toContain(`@${ref}`)

    const findText = renderOf(tools.get('cdp_find'), { nth: 0 }, {
      ok: true,
      matched: 2,
      targetId: 'tab-1',
      url: 'https://example.com/',
      warnings: [],
      chosen: {
        ref,
        role: 'button',
        name: 'Kaydet',
        rawName: 'Kaydet',
        box: { x: 1, y: 2, width: 30, height: 40 },
        visible: true,
        inViewport: true,
        frameLocal: false,
      },
      actionable: { connected: true, visible: true, inViewport: true, enabled: true, hitTarget: true },
    })
    expect(findText).toContain(`"${ref}"`)
    expect(findText).not.toContain(`@${ref}`)
    expect(findText).not.toContain('#1 @')

    // THE T3/T6 regression: copy the ref out of the RENDER text and resolve it.
    const copied = findText.match(/"([^"]+)"/)?.[1]
    expect(copied).toBe(ref)
    const evidence = await resolveRefOn(fakeConnection(), 's-1', copied!, tinyDoc())
    expect(evidence.ref).toBe(ref)
  })

  it('cdp_click labels an unresolved-ref honestly (staleRef false, not stale)', async () => {
    const { service } = fakeService({
      resolveRef: async (ref: string): Promise<RefEvidence> => {
        throw new RefStaleError(
          ref,
          `unresolved-ref: ${JSON.stringify(ref)} is not a snapshot reference `
          + `(expected '<role>|<name>|<ordinal>' steps joined by '>'); `
          + `copy the ref exactly from cdp_snapshot or cdp_find`,
        )
      },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_click')
    const result = await execute(definition, { ref: 'not-a-ref' })
    expect(result.ok).toBe(false)
    expect(result.staleRef).toBe(false) // classification comes from the PREFIX
    expect(String(result.reason).startsWith('unresolved-ref:')).toBe(true)
    expect(violationsOf(definition, result)).toEqual([])
    expect(renderOf(definition, { ref: 'x' }, result)).toContain('Click failed')
  })

  it('cdp_find accepts css as an alias of selector (T6 §3.8)', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { service } = fakeService({
      find: async (options: Record<string, unknown>) => {
        calls.push(options)
        return { ok: false, matched: 0, targetId: 'tab-1', url: 'u', warnings: [], reason: 'no element matched selector="h2" (waited 0ms)' }
      },
    })
    const tools = await bootTools(service)
    const definition = tools.get('cdp_find')
    const result = await execute(definition, { css: 'h2' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.selector).toBe('h2')
    expect(result.ok).toBe(false) // the honest no-match envelope still holds
    expect(violationsOf(definition, result)).toEqual([])
  })
})
