/**
 * Plan 10 §6 — the five new tools: registration, parameter pass-through,
 * error envelopes (throwing `cdp: …`), and render strings. `cdp_files` runs
 * against a real temporary downloads root (traversal, overwrite, roundtrip);
 * the browser-bound tools use a mocked service.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCdpTools } from '../src/tools.ts'
import type { CdpService } from '../src/service.ts'

const NEW_TOOLS = ['cdp_printpdf', 'cdp_download', 'cdp_readpdf', 'cdp_pdftotext', 'cdp_files'] as const

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function bootTools(service: unknown): Map<string, ToolDefinition> {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
    guard: () => () => {},
  } as never)
  registerCdpTools(ctx, service as CdpService)
  return tools
}

async function bootFilesTools(): Promise<{ tools: Map<string, ToolDefinition>, root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-tools-'))
  roots.push(root)
  const tools = bootTools({ downloadsRootPath: root })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  return { tools, root }
}

const execute = async (definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  await definition!.execute!(args, {} as never) as Record<string, unknown>

const renderOf = (definition: ToolDefinition | undefined, args: Record<string, unknown>, value: unknown): string => {
  const output = definition!.output as unknown as {
    render: (a: Record<string, unknown>, v: unknown) => Array<{ type: string, text: string }>
  }
  return output.render(args, value).map(part => part.text).join('\n')
}

describe('plan10: tool registration', () => {
  it('registers the five new tools alongside the existing set', async () => {
    const tools = bootTools({})
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (const name of NEW_TOOLS) expect([...tools.keys()]).toContain(name)
    for (const legacy of ['cdp_status', 'cdp_open', 'cdp_navigate', 'cdp_eval', 'cdp_screenshot', 'cdp_viewport']) {
      expect([...tools.keys()]).toContain(legacy)
    }
  })
})

describe('plan10: cdp_files tool (real root)', () => {
  it('roundtrips write → read → list → stat → delete inside the root', async () => {
    const { tools, root } = await bootFilesTools()
    const write = await execute(tools.get('cdp_files'), { op: 'write', path: 'notes/hello.txt', content: 'merhaba' })
    expect(write).toMatchObject({ ok: true, op: 'write', path: 'notes/hello.txt', bytes: 7 })
    expect(await readFile(join(root, 'notes', 'hello.txt'), 'utf8')).toBe('merhaba')

    const read = await execute(tools.get('cdp_files'), { op: 'read', path: 'notes/hello.txt' })
    expect(read).toMatchObject({ ok: true, content: 'merhaba', encoding: 'utf8', truncated: false })

    const list = await execute(tools.get('cdp_files'), { op: 'list' })
    const entries = list['entries'] as Array<{ name: string, type: string }>
    expect(entries.some(entry => entry.name === 'notes' && entry.type === 'dir')).toBe(true)

    const stat = await execute(tools.get('cdp_files'), { op: 'stat', path: 'notes/hello.txt' })
    expect(stat).toMatchObject({ ok: true, type: 'file', size: 7 })

    const del = await execute(tools.get('cdp_files'), { op: 'delete', path: 'notes/hello.txt' })
    expect(del).toMatchObject({ ok: true, deleted: true })
    expect(existsSync(join(root, 'notes', 'hello.txt'))).toBe(false)
  })

  it('mkdir creates directories and refuses to clobber', async () => {
    const { tools } = await bootFilesTools()
    const created = await execute(tools.get('cdp_files'), { op: 'mkdir', path: 'inbox/2026' })
    expect(created).toMatchObject({ ok: true, path: 'inbox/2026', created: true })
    await expect(execute(tools.get('cdp_files'), { op: 'mkdir', path: 'inbox/2026' }))
      .rejects.toThrow('cdp: destination exists')
  })

  it('refuses traversal and unknown ops with `cdp: …` messages', async () => {
    const { tools } = await bootFilesTools()
    await expect(execute(tools.get('cdp_files'), { op: 'list', path: '..' }))
      .rejects.toThrow('cdp: path escapes downloads root')
    await expect(execute(tools.get('cdp_files'), { op: 'read', path: '../../windows/system.ini' }))
      .rejects.toThrow('cdp: path escapes downloads root')
    await expect(execute(tools.get('cdp_files'), { op: 'frobnicate' }))
      .rejects.toThrow('cdp: files: unknown op: frobnicate')
    await expect(execute(tools.get('cdp_files'), { op: 'write', path: 'x.txt' }))
      .rejects.toThrow('cdp: write: content is required')
  })

  it('refuses silent overwrite unless asked', async () => {
    const { tools } = await bootFilesTools()
    await execute(tools.get('cdp_files'), { op: 'write', path: 'a.txt', content: '1' })
    await expect(execute(tools.get('cdp_files'), { op: 'write', path: 'a.txt', content: '2' }))
      .rejects.toThrow('cdp: destination exists')
    const over = await execute(tools.get('cdp_files'), { op: 'write', path: 'a.txt', content: '3', overwrite: true })
    expect(over).toMatchObject({ ok: true, bytes: 1 })
    expect(await readFile(join(roots[roots.length - 1]!, 'a.txt'), 'utf8')).toBe('3')
  })

  it('renders an honest one-line summary per op', async () => {
    const { tools } = await bootFilesTools()
    await execute(tools.get('cdp_files'), { op: 'write', path: 'z.txt', content: 'ab' })
    const read = await execute(tools.get('cdp_files'), { op: 'read', path: 'z.txt' })
    expect(renderOf(tools.get('cdp_files'), { op: 'read', path: 'z.txt' }, read))
      .toContain('Read z.txt (2 bytes)')
  })
})

describe('plan10: browser-bound tools (mocked service)', () => {
  it('cdp_printpdf passes options through and renders the saved path', async () => {
    let received: unknown
    const tools = bootTools({
      printToPdf: async (options: unknown) => {
        received = options
        return { path: 'print-1.pdf', bytes: 1234, pageCount: 3, data: Buffer.alloc(0) }
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const outcome = await execute(tools.get('cdp_printpdf'), { format: 'A4', landscape: true, saveTo: 'doc.pdf' })
    expect(outcome).toMatchObject({ ok: true, path: 'print-1.pdf', bytes: 1234, pageCount: 3 })
    expect(received).toMatchObject({ format: 'A4', landscape: true, saveTo: 'doc.pdf' })
    expect(renderOf(tools.get('cdp_printpdf'), {}, outcome)).toContain('3 pages')
  })

  it('cdp_download resolves a settled download and rejects a failed one', async () => {
    const tools = bootTools({
      downloadNext: async () => ({
        ok: true,
        state: 'completed',
        guid: 'g-1',
        suggestedFilename: 'file.bin',
        path: 'file.bin',
        bytes: 42,
        error: undefined,
      }),
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const ok = await execute(tools.get('cdp_download'), { timeoutMs: 100 })
    expect(ok).toMatchObject({ ok: true, path: 'file.bin', bytes: 42, guid: 'g-1' })

    const failing = bootTools({
      downloadNext: async () => ({
        ok: false,
        state: 'canceled',
        guid: 'g-2',
        suggestedFilename: 'gone.bin',
        path: undefined,
        bytes: 0,
        error: 'cdp: download: canceled: g-2',
      }),
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await expect(execute(failing.get('cdp_download'), {})).rejects.toThrow('cdp: download: canceled: g-2')
  })

  it('cdp_readpdf returns the full extraction envelope', async () => {
    const tools = bootTools({
      readPdf: async () => ({
        path: 'multipage-10.pdf',
        extracted: {
          pageCount: 10,
          encrypted: false,
          passwordRequired: false,
          textLayer: 'present',
          pagesWithText: 10,
          pageFrom: 1,
          pageTo: 4,
          hasMore: true,
          nextPage: 5,
          chars: 120,
          truncated: false,
          pages: [{ page: 1, text: 'Hello', kind: 'text' }],
          warnings: [],
          meta: { title: 'Doc' },
          forms: undefined,
          barcode: undefined,
        },
      }),
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const outcome = await execute(tools.get('cdp_readpdf'), { path: 'multipage-10.pdf', maxChars: 120 })
    expect(outcome).toMatchObject({
      ok: true,
      path: 'multipage-10.pdf',
      pageCount: 10,
      hasMore: true,
      nextPage: 5,
      chars: 120,
      textLayer: 'present',
      meta: { title: 'Doc' },
    })
    expect(outcome['pages']).toHaveLength(1)
    const text = renderOf(tools.get('cdp_readpdf'), { path: 'multipage-10.pdf' }, outcome)
    expect(text).toContain('10 pages')
    expect(text).toContain('nextPage 5')
  })

  it('cdp_readpdf propagates escape errors verbatim', async () => {
    const tools = bootTools({
      readPdf: async () => {
        throw new Error('cdp: path escapes downloads root: ../x.pdf')
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await expect(execute(tools.get('cdp_readpdf'), { path: '../x.pdf' }))
      .rejects.toThrow('cdp: path escapes downloads root: ../x.pdf')
  })

  it('cdp_pdftotext passes the strategy pin and returns the outcome', async () => {
    let received: unknown
    const tools = bootTools({
      readPdfFromViewer: async (options: unknown) => {
        received = options
        return {
          url: 'https://example.com/doc.pdf',
          strategy: 'axtree',
          strategyDetail: 'fallback: 3 pages, 210 chars',
          chars: 210,
          truncated: false,
          warnings: ['no network strategy'],
          pageCount: 3,
          textLayer: 'present',
          text: 'body text',
        }
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const outcome = await execute(tools.get('cdp_pdftotext'), { strategy: 'axtree', maxChars: 500 })
    expect(received).toMatchObject({ strategy: 'axtree', maxChars: 500 })
    expect(outcome).toMatchObject({ ok: true, strategy: 'axtree', chars: 210, text: 'body text' })
    expect(renderOf(tools.get('cdp_pdftotext'), {}, outcome)).toContain('via axtree')
  })

  it('cdp_pdftotext surfaces the aggregated all-strategies failure', async () => {
    const tools = bootTools({
      readPdfFromViewer: async () => {
        throw new Error('cdp: pdftotext: all strategies failed (network: URL returned HTML, not PDF (auth expired?); HTTP 401 — print: timed out — axtree: no accessibility tree)')
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await expect(execute(tools.get('cdp_pdftotext'), {}))
      .rejects.toThrow('cdp: pdftotext: all strategies failed')
  })
})
