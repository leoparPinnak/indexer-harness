/**
 * @deepseek-ai/dsh-cdp/png — minimal PNG reader/annotator for plan 06's
 * `annotate` mode. Hand-written IHDR parse, IDAT inflate/unfilter, rect draw,
 * filter-0 refilter, deflate, and chunk rewrite on top of Node's built-in
 * `node:zlib`. No image library, no page DOM mutation: the rects are painted
 * onto the file that is already on disk.
 *
 * Supported inputs: 8-bit greyscale (0), RGB (2), greyscale+alpha (4), and
 * RGBA (6), non-interlaced. Paletted, 16-bit, and interlaced PNGs are refused
 * with `CdpScreenshotError` and the original file stays untouched.
 *
 * @module @deepseek-ai/dsh-cdp/png
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { CdpScreenshotError } from './capture.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Rect to paint, in image pixels. */
export interface PngRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One PNG chunk as parsed from the file. */
interface PngChunk {
  readonly type: string
  readonly data: Buffer
}

interface ParsedPng {
  readonly width: number
  readonly height: number
  readonly colorType: number
  readonly channels: number
  readonly chunks: readonly PngChunk[]
  readonly idat: Buffer
}

function channelsFor(colorType: number): number | undefined {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  return undefined
}

function buildChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((crc32(Buffer.concat([typeBuffer, data])) >>> 0), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function parsePng(buffer: Buffer): ParsedPng {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new CdpScreenshotError('annotate: not a PNG file (bad signature)')
  }
  const chunks: PngChunk[] = []
  const idatParts: Buffer[] = []
  let offset = 8
  let header: { width: number, height: number, colorType: number } | undefined
  let sawEnd = false
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) {
      throw new CdpScreenshotError(`annotate: truncated PNG chunk ${type}`)
    }
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (length !== 13) throw new CdpScreenshotError('annotate: malformed IHDR')
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        colorType: buffer.readUInt8(dataStart + 9),
      }
      const bitDepth = buffer.readUInt8(dataStart + 8)
      const interlace = buffer.readUInt8(dataStart + 12)
      chunks.push({ type, data: Buffer.from(data) })
      if (bitDepth !== 8) {
        throw new CdpScreenshotError('annotate supports only 8-bit PNG files; use the rects legend instead')
      }
      if (channelsFor(header.colorType) === undefined) {
        throw new CdpScreenshotError('annotate supports only greyscale/RGB(A) PNG files (paletted PNGs are refused); use the rects legend instead')
      }
      if (interlace !== 0) {
        throw new CdpScreenshotError('annotate supports only non-interlaced PNG files; use the rects legend instead')
      }
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data))
    } else if (type === 'IEND') {
      sawEnd = true
      offset = dataEnd + 4
      break
    } else {
      chunks.push({ type, data: Buffer.from(data) })
    }
    offset = dataEnd + 4
  }
  if (header === undefined) throw new CdpScreenshotError('annotate: PNG has no IHDR')
  if (!sawEnd || idatParts.length === 0) throw new CdpScreenshotError('annotate: PNG has no IDAT/IEND')
  const channels = channelsFor(header.colorType)
  /* v8 ignore next -- parsePng already rejects unsupported color types. */
  if (channels === undefined) throw new CdpScreenshotError('annotate: unsupported PNG color type')
  return {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    channels,
    chunks,
    idat: Buffer.concat(idatParts),
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  if (pa <= pb && pa <= pc) return left
  if (pb <= pc) return up
  return upLeft
}

/** Inflate and unfilter the IDAT stream into packed rows (filter byte stripped). */
function unfilter(parsed: ParsedPng, raw: Buffer): Buffer {
  const stride = parsed.width * parsed.channels
  const expected = (stride + 1) * parsed.height
  if (raw.length < expected) {
    throw new CdpScreenshotError(`annotate: inflated IDAT is ${String(raw.length)} bytes, expected ${String(expected)}`)
  }
  const out = Buffer.alloc(stride * parsed.height)
  const bpp = parsed.channels
  for (let y = 0; y < parsed.height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw.readUInt8(rowStart)
    const srcStart = rowStart + 1
    const dstStart = y * stride
    const prevStart = dstStart - stride
    for (let i = 0; i < stride; i++) {
      const x = raw.readUInt8(srcStart + i)
      const left = i >= bpp ? out.readUInt8(dstStart + i - bpp) : 0
      const up = y > 0 ? out.readUInt8(prevStart + i) : 0
      const upLeft = y > 0 && i >= bpp ? out.readUInt8(prevStart + i - bpp) : 0
      let value: number
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + left; break
        case 2: value = x + up; break
        case 3: value = x + Math.floor((left + up) / 2); break
        case 4: value = x + paeth(left, up, upLeft); break
        default:
          throw new CdpScreenshotError(`annotate: unknown PNG filter type ${String(filter)} on row ${String(y)}`)
      }
      out.writeUInt8(value & 0xff, dstStart + i)
    }
  }
  return out
}

/** Paint one 2px border rect in the plane's own channel layout. */
function drawRect(pixels: Buffer, parsed: ParsedPng, rect: PngRect): void {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(parsed.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(parsed.height, Math.ceil(rect.y + rect.height))
  if (right <= left || bottom <= top) return
  const channels = parsed.channels
  const paint = (x: number, y: number): void => {
    const at = (y * parsed.width + x) * channels
    if (channels === 1) {
      pixels.writeUInt8(255, at)
    } else if (channels === 2) {
      pixels.writeUInt8(220, at)
      pixels.writeUInt8(255, at + 1)
    } else {
      pixels.writeUInt8(255, at)
      pixels.writeUInt8(59, at + 1)
      pixels.writeUInt8(48, at + 2)
      if (channels === 4) pixels.writeUInt8(255, at + 3)
    }
  }
  const thickness = 2
  for (let y = top; y < bottom; y++) {
    for (let t = 0; t < thickness; t++) {
      const xTop = left + t
      const xBottom = right - 1 - t
      if (xTop < right) paint(xTop, y)
      if (xBottom >= left && xBottom !== xTop) paint(xBottom, y)
    }
  }
  for (let x = left; x < right; x++) {
    for (let t = 0; t < thickness; t++) {
      const yTop = top + t
      const yBottom = bottom - 1 - t
      if (yTop < bottom) paint(x, yTop)
      if (yBottom >= top && yBottom !== yTop) paint(x, yBottom)
    }
  }
}

/** Rebuild the file: original chunks (minus IDAT/IEND) + one fresh IDAT + IEND. */
function rebuildPng(parsed: ParsedPng, idat: Buffer): Buffer {
  const parts: Buffer[] = [PNG_SIGNATURE]
  const ihdr = parsed.chunks.find(chunk => chunk.type === 'IHDR')
  /* v8 ignore next -- parsePng guarantees an IHDR chunk exists. */
  if (ihdr === undefined) throw new CdpScreenshotError('annotate: PNG has no IHDR')
  parts.push(buildChunk('IHDR', ihdr.data))
  for (const chunk of parsed.chunks) {
    if (chunk.type === 'IHDR') continue
    parts.push(buildChunk(chunk.type, chunk.data))
  }
  parts.push(buildChunk('IDAT', idat))
  parts.push(buildChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/**
 * Paint legend rects onto the PNG already on disk, in place.
 *
 * The file is parsed and validated first; any unsupported input throws before
 * a single byte is written, so the original file is never left half-rewritten.
 *
 * @param path - absolute path of the PNG to annotate.
 * @param rects - rects in image pixels (the `buildLegend` output).
 * @returns the same path after the atomic rewrite.
 */
export async function annotatePng(path: string, rects: readonly PngRect[]): Promise<string> {
  let source: Buffer
  try {
    source = await readFile(path)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new CdpScreenshotError(`annotate: could not read ${path}: ${detail}`)
  }
  const parsed = parsePng(source)
  const inflated = inflateSync(parsed.idat)
  const pixels = unfilter(parsed, inflated)
  for (const rect of rects) drawRect(pixels, parsed, rect)

  const stride = parsed.width * parsed.channels
  const refiltered = Buffer.alloc((stride + 1) * parsed.height)
  for (let y = 0; y < parsed.height; y++) {
    refiltered.writeUInt8(0, y * (stride + 1))
    pixels.copy(refiltered, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const rebuilt = rebuildPng(parsed, deflateSync(refiltered))

  const tmp = `${path}.annotate-${String(process.pid)}-${String(Date.now())}.tmp`
  try {
    await writeFile(tmp, rebuilt)
    await rename(tmp, path)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new CdpScreenshotError(`annotate: could not rewrite ${path}: ${detail}`)
  }
  return path
}
