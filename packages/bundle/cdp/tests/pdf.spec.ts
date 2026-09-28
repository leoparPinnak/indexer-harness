/**
 * Plan 10 §8.1 — pure extractor tests against the generated fixture matrix.
 * Fixtures are produced by `tests/fixtures/pdf/build-fixtures.mjs`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildCookieHeader,
  classifyPdfPayload,
  DEFAULT_PDF_MAX_CHARS,
  extractPdfText,
  extractFromViewer,
  flattenAxTree,
  isEncryptedPdf,
  parsePrintToPdfReply,
  planViewerStrategies,
} from '../src/pdf.ts'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pdf')
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixtureDir, name)))

describe('extractPdfText — fixture matrix', () => {
  it('hello.pdf extracts the exact single line', () => {
    const result = extractPdfText(fixture('hello.pdf'))
    expect(result.pageCount).toBe(1)
    expect(result.encrypted).toBe(false)
    expect(result.textLayer).toBe('present')
    expect(result.pagesWithText).toBe(1)
    expect(result.pages[0]?.text).toBe('Hello, CDP world!')
    expect(result.truncated).toBe(false)
    expect(result.hasMore).toBe(false)
  })

  it('flate-eol.pdf inflates even when /Length swallowed the EOL bytes', () => {
    const result = extractPdfText(fixture('flate-eol.pdf'))
    expect(result.pages[0]?.text).toBe('Flate stream OK!')
    expect(result.warnings.some(warning => /content/i.test(warning))).toBe(false)
  })

  it('turkish-cp1254.pdf picks CP1254 over the mojibake WinAnsi reading', () => {
    const result = extractPdfText(fixture('turkish-cp1254.pdf'))
    const text = result.pages.map(page => page.text).join('\n')
    expect(text).toContain('SOSYAL GÜVENLİK KURUMU BAŞKANLIĞI')
    expect(text).toContain('GÜVENLİK ve BAŞKANLIĞI yazıları')
    expect(text).not.toContain('BAÞKANLIÐI')
    expect(text).not.toContain('GÜVENLÝK')
  })

  it('cid-tounicode.pdf decodes Type0 codes through the ToUnicode CMap', () => {
    const result = extractPdfText(fixture('cid-tounicode.pdf'))
    expect(result.pages[0]?.text).toBe('Merhaba CID!')
    expect(result.warnings.some(warning => /without ToUnicode/i.test(warning))).toBe(false)
  })

  it('multipage-10.pdf reports 10 pages and budgets pages 1-4 / 5-10 / 1-10', () => {
    const bytes = fixture('multipage-10.pdf')

    const head = extractPdfText(bytes, { maxChars: 120 })
    expect(head.pageCount).toBe(10)
    expect(head.pages.map(page => page.page)).toEqual([1, 2, 3, 4])
    expect(head.pageFrom).toBe(1)
    expect(head.pageTo).toBe(4)
    expect(head.hasMore).toBe(true)
    expect(head.nextPage).toBe(5)
    expect(head.truncated).toBe(false)

    const tail = extractPdfText(bytes, { pageFrom: 5, maxChars: 200 })
    expect(tail.pages.map(page => page.page)).toEqual([5, 6, 7, 8, 9, 10])
    expect(tail.pageFrom).toBe(5)
    expect(tail.pageTo).toBe(10)
    expect(tail.hasMore).toBe(false)
    expect(tail.nextPage).toBeUndefined()

    const full = extractPdfText(bytes)
    expect(full.pages.map(page => page.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(full.pageTo).toBe(10)
    expect(full.hasMore).toBe(false)
    expect(full.pages[9]?.text).toBe('Page 10 of ten - text line 10')
  })

  it('pages: spec supports ranges and lists (plan §8.1 (d))', () => {
    const bytes = fixture('multipage-10.pdf')
    const ranged = extractPdfText(bytes, { pages: '1-4' })
    expect(ranged.pages.map(page => page.page)).toEqual([1, 2, 3, 4])
    const listed = extractPdfText(bytes, { pages: '3,7,9-10' })
    expect(listed.pages.map(page => page.page)).toEqual([3, 7, 9, 10])
    expect(() => extractPdfText(bytes, { pages: '99' })).toThrow('cdp: page 99 out of range (1-10)')
    expect(() => extractPdfText(bytes, { pages: 'abc' })).toThrow('cdp: invalid pages spec: abc')
    expect(() => extractPdfText(bytes, { page: 99 })).toThrow('cdp: page 99 out of range (1-10)')
  })

  it('scanned.pdf reports an absent text layer with an image-only warning', () => {
    const result = extractPdfText(fixture('scanned.pdf'))
    expect(result.textLayer).toBe('absent')
    expect(result.pagesWithText).toBe(0)
    expect(result.pages[0]?.text).toBe('')
    expect(result.pages[0]?.kind).toBe('image')
    expect(result.warnings).toContain('page 1: no text layer (image-only)')
  })

  it('forms.pdf surfaces AcroForm field values', () => {
    const result = extractPdfText(fixture('forms.pdf'))
    expect(result.forms).toEqual([
      { field: 'Full Name', value: 'Metin Yilmaz' },
      { field: 'Application No', value: '50152094938' },
    ])
  })

  it('encrypted.pdf is reported, not cracked (ok:true honest report)', () => {
    expect(isEncryptedPdf(fixture('encrypted.pdf'))).toBe(true)
    const result = extractPdfText(fixture('encrypted.pdf'))
    expect(result.encrypted).toBe(true)
    expect(result.passwordRequired).toBe(true)
    expect(result.pageCount).toBe(0)
    expect(result.textLayer).toBe('unknown')
    expect(result.pages).toEqual([])
    expect(result.chars).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('malformed-xref.pdf still extracts via full-file object scan', () => {
    const result = extractPdfText(fixture('malformed-xref.pdf'))
    expect(result.pages[0]?.text).toBe('Malformed xref still parses')
  })

  it('not-a-pdf.pdf rejects with the plan error envelope', () => {
    expect(() => extractPdfText(fixture('not-a-pdf.pdf'))).toThrow('cdp: not a PDF: the %PDF- header is missing')
    expect(classifyPdfPayload(fixture('not-a-pdf.pdf'))).toBe('html')
    expect(classifyPdfPayload(fixture('hello.pdf'))).toBe('pdf')
    expect(classifyPdfPayload(new Uint8Array(0))).toBe('empty')
  })

  it('oversize-page.pdf cuts at maxChars with a page cursor', () => {
    const result = extractPdfText(fixture('oversize-page.pdf'), { page: 1, maxChars: 300 })
    expect(result.truncated).toBe(true)
    expect(result.pageFrom).toBe(1)
    expect(result.pageTo).toBe(1)
    expect(result.nextPage).toBe(2)
    expect(result.hasMore).toBe(true)
    expect(result.chars).toBe(300)
    expect(result.pages[0]?.text.length).toBe(300)
  })

  it('barcode.pdf finds the token near the barkod label', () => {
    const result = extractPdfText(fixture('barcode.pdf'))
    expect(result.barcode).toBe('50152094938')
  })

  it('metadata is decoded from /Info when present', () => {
    // The generated fixtures carry no /Info; the field is simply absent.
    const result = extractPdfText(fixture('hello.pdf'))
    expect(result.meta).toBeUndefined()
    expect(DEFAULT_PDF_MAX_CHARS).toBe(16_000)
  })
})

describe('parsePrintToPdfReply', () => {
  it('decodes a multipage reply to pageCount 10 (plan §8.1 (f))', () => {
    const bytes = readFileSync(join(fixtureDir, 'multipage-10.pdf'))
    const reply = { data: bytes.toString('base64') }
    const decoded = parsePrintToPdfReply(reply)
    const result = extractPdfText(decoded)
    expect(result.pageCount).toBe(10)
    expect(result.pages).toHaveLength(10)
  })

  it('tolerates unpadded base64 and rejects empty/absent data', () => {
    const bytes = readFileSync(join(fixtureDir, 'hello.pdf'))
    const unpadded = bytes.toString('base64').replace(/=+$/, '')
    expect(extractPdfText(parsePrintToPdfReply({ data: unpadded })).pageCount).toBe(1)
    expect(() => parsePrintToPdfReply({})).toThrow('cdp: printToPDF: the reply carried no data field')
    expect(() => parsePrintToPdfReply({ data: '' })).toThrow('cdp: printToPDF: the reply carried no data field')
    expect(() => parsePrintToPdfReply({ data: 'bm90LWEtcGRm' })).toThrow('cdp: printToPDF: decoded payload is not a PDF')
  })
})

describe('viewer helpers', () => {
  it('planViewerStrategies expands auto and pins one strategy', () => {
    expect(planViewerStrategies()).toEqual(['network', 'print', 'axtree'])
    expect(planViewerStrategies('auto')).toEqual(['network', 'print', 'axtree'])
    expect(planViewerStrategies('print')).toEqual(['print'])
    expect(() => planViewerStrategies('magic')).toThrow('cdp: pdftotext: unknown strategy: magic')
  })

  it('flattenAxTree joins StaticText nodes and falls back to all names', () => {
    expect(flattenAxTree([
      { role: 'PdfRoot', name: '' },
      { role: 'StaticText', name: 'Satır bir' },
      { role: 'StaticText', name: 'Satır iki' },
    ])).toBe('Satır bir\nSatır iki')
    expect(flattenAxTree([{ role: 'document', name: 'only' }])).toBe('only')
    expect(flattenAxTree([])).toBe('')
  })

  it('extractFromViewer aggregates strategy failures (plan §6 E10)', async () => {
    const context = {
      pageUrl: async () => 'https://example.invalid/doc.pdf',
      fetchImpl: (async () => { throw new Error('network down') }) as typeof globalThis.fetch,
      getAllCookies: async () => [],
      targets: async () => [],
      attach: async () => { throw new Error('no guest') },
      send: async () => { throw new Error('never') },
      printToPdfFile: async () => { throw new Error('print unavailable') },
      savePdf: async () => { throw new Error('unused') },
    }
    await expect(extractFromViewer(context, { timeoutMs: 5_000 }))
      .rejects.toThrow(/cdp: pdftotext: all strategies failed \(/)
  })
})

describe('viewer access paths (network/print/axtree)', () => {
  it('network strategy fetches with cookies, saves the payload, and extracts', async () => {
    const bytes = fixture('hello.pdf')
    let seenInit: RequestInit | undefined
    let savedAs: string | undefined
    const context = {
      pageUrl: async () => 'https://example.com/files/hello.pdf',
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        seenInit = init
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }
      }) as unknown as typeof globalThis.fetch,
      getAllCookies: async () => [
        { name: 'session', value: 'abc123', domain: 'example.com', path: '/' },
        { name: 'other', value: 'nope', domain: 'elsewhere.test', path: '/' },
      ],
      targets: async () => [],
      attach: async () => { throw new Error('unused') },
      send: async () => { throw new Error('unused') },
      printToPdfFile: async () => { throw new Error('unused') },
      savePdf: async (name: string) => {
        savedAs = name
        return `downloads/${name}`
      },
    }
    const outcome = await extractFromViewer(context, { maxChars: 4000 })
    expect(outcome.strategy).toBe('network')
    expect(outcome.url).toBe('https://example.com/files/hello.pdf')
    expect(outcome.strategyDetail).toContain('Network.getAllCookies + direct fetch')
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1)
    expect(outcome.pages?.some(page => page.text.includes('Hello, CDP world!'))).toBe(true)
    expect(savedAs).toBe('hello.pdf')
    const headers = (seenInit?.headers ?? {}) as unknown as Record<string, string>
    expect(headers['cookie']).toContain('session=abc123')
    expect(headers['cookie']).not.toContain('other=nope')
  })

  it('an HTML (auth-expired) response falls through to the print strategy', async () => {
    const htmlBody = new TextEncoder().encode('<!DOCTYPE html><html><body>login</body></html>').buffer
    const context = {
      pageUrl: async () => 'https://auth.example.com/doc.pdf',
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        arrayBuffer: async () => htmlBody,
      })) as unknown as typeof globalThis.fetch,
      getAllCookies: async () => [],
      targets: async () => [],
      attach: async () => { throw new Error('unused') },
      send: async () => { throw new Error('unused') },
      printToPdfFile: async () => ({ path: 'print-1.pdf', data: Buffer.from(fixture('hello.pdf')), pageCount: 1 }),
      savePdf: async () => { throw new Error('unused') },
    }
    const outcome = await extractFromViewer(context, {})
    expect(outcome.strategy).toBe('print')
    expect(outcome.strategyDetail).toContain('Page.printToPDF round-trip')
    expect(outcome.pages?.some(page => page.text.includes('Hello, CDP world!'))).toBe(true)
    expect(outcome.warnings.some(warning => warning.includes('re-print'))).toBe(true)
  })

  it('the pinned axtree strategy flattens the PDFium guest tree', async () => {
    const context = {
      pageUrl: async () => 'about:blank',
      fetchImpl: (async () => { throw new Error('unused') }) as unknown as typeof globalThis.fetch,
      getAllCookies: async () => [],
      targets: async () => [{
        targetId: 'guest-1',
        type: 'page',
        title: 'PDF',
        url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
      }],
      attach: async (targetId: string) => {
        expect(targetId).toBe('guest-1')
        return 'guest-session'
      },
      send: async (method: string, _params: unknown, sessionId: unknown) => {
        expect(method).toBe('Accessibility.getFullAXTree')
        expect(sessionId).toBe('guest-session')
        return { nodes: [{ role: 'PdfRoot', name: '' }, { role: 'StaticText', name: 'AX line one' }] }
      },
      printToPdfFile: async () => { throw new Error('unused') },
      savePdf: async () => { throw new Error('unused') },
    }
    const outcome = await extractFromViewer(context, { strategy: 'axtree' })
    expect(outcome.strategy).toBe('axtree')
    expect(outcome.text).toContain('AX line one')
    expect(outcome.chars).toBe(outcome.text?.length)
    expect(outcome.strategyDetail).toContain('guest-1')
    expect(outcome.warnings.some(warning => warning.includes('no page markers'))).toBe(true)
  })

  it('classifyPdfPayload distinguishes pdf / html / empty / other', () => {
    expect(classifyPdfPayload(fixture('hello.pdf'))).toBe('pdf')
    expect(classifyPdfPayload(new TextEncoder().encode('<html><body>hi</body></html>'))).toBe('html')
    expect(classifyPdfPayload(new Uint8Array(0))).toBe('empty')
    expect(classifyPdfPayload(new Uint8Array([0x00, 0x01, 0x02, 0xff]))).toBe('other')
  })

  it('buildCookieHeader keeps only domain-matching cookies', () => {
    const header = buildCookieHeader([
      { name: 'a', value: '1', domain: 'example.com', path: '/' },
      { name: 'b', value: '2', domain: '.example.com', path: '/' },
      { name: 'c', value: '3', domain: 'evil.test', path: '/' },
    ], 'https://www.example.com/x')
    expect(header).toContain('a=1')
    expect(header).toContain('b=2')
    expect(header).not.toContain('c=3')
  })
})
