/**
 * Plan 06 PNG annotator tests (plan §8.3): builds real PNG fixtures with
 * node:zlib, verifies the header through `readImageSize`, inflates the
 * annotated IDAT to assert painted pixels and preserved dimensions, recomputes
 * every chunk CRC independently, and proves rejection cases leave the file
 * untouched.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CdpScreenshotError, readImageSize } from '../src/capture.ts'
import { annotatePng } from '../src/png.ts'
import { cleanupTempDirs, makePng, makeTempDir } from './plan06-fixtures.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface PngChunk {
  readonly type: string
  readonly data: Buffer
  readonly storedCrc: number
}

/** Minimal chunk walk: parses length/type/data/crc for every chunk. */
function walkChunks(buffer: Buffer): PngChunk[] {
  expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  const chunks: PngChunk[] = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    const storedCrc = buffer.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, storedCrc })
    offset += 12 + length
  }
  expect(offset).toBe(buffer.length)
  return chunks
}

/** Every chunk CRC must match an independent recomputation over type+data. */
function expectValidCrcs(buffer: Buffer): void {
  for (const chunk of walkChunks(buffer)) {
    const recomputed = crc32(Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data])) >>> 0
    expect(chunk.storedCrc).toBe(recomputed)
  }
}

/** Decode filter-0 rows written by annotatePng (no filtering expected). */
function decodeRgb(buffer: Buffer, width: number, height: number): Buffer[] {
  const idat = walkChunks(buffer).find(chunk => chunk.type === 'IDAT')
  expect(idat).toBeDefined()
  const raw = inflateSync(idat!.data)
  const stride = width * 3
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    expect(raw[start]).toBe(0)
    rows.push(raw.subarray(start + 1, start + 1 + stride))
  }
  return rows
}

afterEach(async () => {
  await cleanupTempDirs()
})

describe('plan06: annotatePng', () => {
  it('parses the header and paints a 2px border around the requested rects', async () => {
    const dir = await makeTempDir('dsh-plan06-png-')
    const path = join(dir, 'fixture.png')
    // 8x4 RGB fixture: width 8 -> stride 24.
    await writeFile(path, makePng(8, 4))

    const before = await readFile(path)
    expect(readImageSize(before, 'png')).toEqual({ width: 8, height: 4 })

    await annotatePng(path, [{ x: 1, y: 1, width: 3, height: 2 }])

    const after = await readFile(path)
    expect(after.equals(before)).toBe(false)
    expect(readImageSize(after, 'png')).toEqual({ width: 8, height: 4 })
    expectValidCrcs(after)

    const rows = decodeRgb(after, 8, 4)
    // Border colour is the red accent: top edge of rect (x=1..4 at y=1).
    expect(rows[1]?.subarray(3, 6)).toEqual(Buffer.from([255, 59, 48]))
    expect(rows[1]?.subarray(0, 3)).toEqual(Buffer.from([180, 90, 40]))
    // Left edge column x=1 at y=2 (bottom row of rect).
    expect(rows[2]?.subarray(3, 6)).toEqual(Buffer.from([255, 59, 48]))
    // Outside the rect the original fill stays untouched.
    expect(rows[3]?.subarray(0, 3)).toEqual(Buffer.from([180, 90, 40]))
  })

  it('preserves exact dimensions and inflates cleanly on a wider image', async () => {
    const dir = await makeTempDir('dsh-plan06-png-')
    const path = join(dir, 'wide.png')
    await writeFile(path, makePng(64, 16))

    await annotatePng(path, [
      { x: 0, y: 0, width: 64, height: 16 },
      { x: 10, y: 4, width: 20, height: 8 },
    ])

    const buffer = await readFile(path)
    expect(readImageSize(buffer, 'png')).toEqual({ width: 64, height: 16 })
    expectValidCrcs(buffer)
    const rows = decodeRgb(buffer, 64, 16)
    expect(rows).toHaveLength(16)
    expect(rows[0]?.length).toBe(192)
  })

  it('rejects a paletted png and leaves the file byte-for-byte unchanged', async () => {
    const dir = await makeTempDir('dsh-plan06-png-')
    const path = join(dir, 'palette.png')
    const fixture = makePng(4, 4, { colorType: 3 })
    await writeFile(path, fixture)

    await expect(annotatePng(path, [{ x: 1, y: 1, width: 2, height: 2 }]))
      .rejects.toBeInstanceOf(CdpScreenshotError)
    const after = await readFile(path)
    expect(after.equals(fixture)).toBe(true)
  })

  it('rejects a 16-bit png without touching the file', async () => {
    const dir = await makeTempDir('dsh-plan06-png-')
    const path = join(dir, 'deep.png')
    const fixture = makePng(4, 4, { bitDepth: 16 })
    await writeFile(path, fixture)

    await expect(annotatePng(path, [{ x: 1, y: 1, width: 2, height: 2 }]))
      .rejects.toThrowError(/8-bit/)
    expect((await readFile(path)).equals(fixture)).toBe(true)
  })
})
