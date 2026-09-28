/**
 * Plan 10 §6.10 — service.printToPdf against a fake connection: parameter
 * marshalling, reply decoding, saving inside the downloads root, page-count
 * parity (the print test's parity check), and honest reply/rename errors.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

interface FakeReply {
  data?: string
  errorCode?: string
}

/** Poked service: fake Page session + fake connection recording CDP calls. */
function pokedService(root: string, reply: FakeReply | (() => FakeReply)) {
  const service = new CdpService({ downloadsDir: root })
  const sent: Array<{ method: string, params: Record<string, unknown>, sessionId?: string | undefined }> = []
  const connection = {
    send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId })
      const resolved = typeof reply === 'function' ? reply() : reply
      return Promise.resolve(resolved)
    },
    on: () => () => {},
  }
  const seam = service as unknown as {
    connection: unknown
    getPageSession: (targetId?: string) => Promise<{ sessionId: string }>
  }
  seam.connection = connection
  seam.getPageSession = async () => ({ sessionId: 'print-session' })
  return { service, sent }
}

describe('plan10: CdpService.printToPdf', () => {
  it('marshals parameters, saves inside the root, and reports page parity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-print-'))
    roots.push(root)
    const pdf = readFileSync(join(fixtureDir, 'multipage-10.pdf'))
    const { service, sent } = pokedService(root, { data: pdf.toString('base64') })

    const result = await service.printToPdf({
      format: 'A4',
      landscape: true,
      scale: 0.9,
      pageRanges: '1-3',
      marginIn: { top: 0.5 },
      saveTo: 'report.pdf',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe('Page.printToPDF')
    expect(sent[0]?.sessionId).toBe('print-session')
    expect(sent[0]?.params).toMatchObject({
      paperWidth: 8.27,
      paperHeight: 11.69,
      landscape: true,
      scale: 0.9,
      pageRanges: '1-3',
      marginTop: 0.5,
      printBackground: true,
    })
    expect(result.path).toBe('report.pdf')
    expect(result.pageCount).toBe(10)
    expect(result.bytes).toBe(pdf.byteLength)
    expect(existsSync(join(root, 'report.pdf'))).toBe(true)
  })

  it('auto-names the print output with a free suffix on collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-print-'))
    roots.push(root)
    const pdf = readFileSync(join(fixtureDir, 'hello.pdf'))
    const { service } = pokedService(root, () => ({ data: pdf.toString('base64') }))
    await service.printToPdf({})
    const second = await service.printToPdf({})
    expect(second.path).toMatch(/^print-\d+( \(\d+\))?\.pdf$/)
    expect(existsSync(join(root, second.path))).toBe(true)
  })

  it('hard-errors when saveTo is occupied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-print-'))
    roots.push(root)
    const pdf = readFileSync(join(fixtureDir, 'hello.pdf'))
    const { service } = pokedService(root, { data: pdf.toString('base64') })
    await service.printToPdf({ saveTo: 'taken.pdf' })
    await expect(service.printToPdf({ saveTo: 'taken.pdf' })).rejects.toThrow('cdp: destination exists')
  })

  it('rejects a malformed reply before writing anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cdp-print-'))
    roots.push(root)
    const { service } = pokedService(root, {})
    await expect(service.printToPdf({ saveTo: 'x.pdf' })).rejects.toThrow('cdp: printToPDF:')
    expect(existsSync(join(root, 'x.pdf'))).toBe(false)
  })
})
