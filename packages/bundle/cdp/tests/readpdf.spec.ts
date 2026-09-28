/**
 * Plan 10 §6.9 — service.readPdf over the real filesystem: root confinement,
 * byte cap, honest non-PDF rejection, and cursor pass-through (the extractor
 * itself is covered by pdf.spec.ts).
 */

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CdpService } from '../src/service.ts'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pdf')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(...fixtures: string[]): Promise<{ service: CdpService, root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-readpdf-'))
  roots.push(root)
  for (const fixture of fixtures) {
    await copyFile(join(fixtureDir, fixture), join(root, fixture))
  }
  return { service: new CdpService({ downloadsDir: root }), root }
}

describe('plan10: CdpService.readPdf', () => {
  it('resolves the configured downloads root lazily and stably', async () => {
    const { service, root } = await makeRoot()
    expect(service.downloadsRootPath).toBe(root)
    expect(service.downloadsRootPath).toBe(root)
  })

  it('reads a PDF from inside the root with the extraction envelope', async () => {
    const { service } = await makeRoot('hello.pdf')
    const { path, extracted } = await service.readPdf({ path: 'hello.pdf' })
    expect(path).toBe('hello.pdf')
    expect(extracted.pageCount).toBeGreaterThanOrEqual(1)
    expect(extracted.encrypted).toBe(false)
    expect(extracted.textLayer).toBe('present')
    expect(extracted.pages.some(page => page.text.includes('Hello, CDP world!'))).toBe(true)
  })

  it('applies the pages cursor end-to-end', async () => {
    const { service } = await makeRoot('multipage-10.pdf')
    const { extracted } = await service.readPdf({ path: 'multipage-10.pdf', pages: '3,7,9-10' })
    expect(extracted.pages.map(page => page.page)).toEqual([3, 7, 9, 10])
    expect(extracted.pageCount).toBe(10)
  })

  it('rejects traversal before touching the filesystem', async () => {
    const { service } = await makeRoot()
    await expect(service.readPdf({ path: '../outside.pdf' })).rejects.toThrow(
      'cdp: path escapes downloads root: ../outside.pdf',
    )
    await expect(service.readPdf({ path: '..\\win-escape.pdf' })).rejects.toThrow('cdp: path escapes downloads root')
    await expect(service.readPdf({ path: 'C:\\abs\\evil.pdf' })).rejects.toThrow('cdp: path escapes downloads root')
  })

  it('rejects a missing file and a directory with distinct messages', async () => {
    const { service, root } = await makeRoot('hello.pdf')
    await expect(service.readPdf({ path: 'missing.pdf' })).rejects.toThrow('cdp: not found: missing.pdf')
    await mkdir(join(root, 'sub'), { recursive: true })
    await expect(service.readPdf({ path: 'sub' })).rejects.toThrow('cdp: is a directory: sub')
  })

  it('rejects a non-PDF file with the path in the message', async () => {
    const { service } = await makeRoot('not-a-pdf.pdf')
    await expect(service.readPdf({ path: 'not-a-pdf.pdf' })).rejects.toThrow(
      'cdp: not-a-pdf.pdf: not a PDF',
    )
  })

  it('enforces the configured byte cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-cap-'))
    roots.push(root)
    await copyFile(join(fixtureDir, 'hello.pdf'), join(root, 'hello.pdf'))
    const service = new CdpService({ downloadsDir: root, maxPdfBytes: 64 })
    await expect(service.readPdf({ path: 'hello.pdf' })).rejects.toThrow(/exceeds \d+ MiB/)
  })

  it('surfaces extractor window errors verbatim', async () => {
    const { service } = await makeRoot('multipage-10.pdf')
    await expect(service.readPdf({ path: 'multipage-10.pdf', page: 99 })).rejects.toThrow(
      'cdp: page 99 out of range (1-10)',
    )
    await expect(service.readPdf({ path: 'multipage-10.pdf', pages: '1-3;x' })).rejects.toThrow(
      'cdp: invalid pages spec',
    )
  })

  it('fails loud from pdftotext when no session was ever opened', async () => {
    const { service } = await makeRoot()
    await expect(service.readPdfFromViewer({})).rejects.toThrow('cdp: no active')
  })
})
