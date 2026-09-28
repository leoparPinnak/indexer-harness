/**
 * Plan 06 test fixtures: a hand-built PNG encoder on `node:zlib` and a
 * minimal JPEG header builder. Both produce real encoded bytes so tests can
 * file-assert (parse headers, inflate IDAT, verify chunk CRCs) instead of
 * trusting production code twice.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((crc32(Buffer.concat([typeBuffer, data])) >>> 0), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** Options for {@link makePng}. */
export interface MakePngOptions {
  /** PNG color type (default 2 = RGB). Use 3 to build a paletted fixture. */
  readonly colorType?: number
  /** Bits per sample (default 8). Use 16 for the rejected-fixture case. */
  readonly bitDepth?: number
  /** Fill bytes cycled per sample (default a warm brown). */
  readonly rgb?: readonly number[]
}

/** Channels for the color types the fixtures cover (3 falls back to RGB bytes). */
function channelsOf(colorType: number): number {
  if (colorType === 0) return 1
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  if (colorType === 3) return 3
  return 3
}

/**
 * Build a real PNG: signature + IHDR + one IDAT (filter-0 rows) + IEND.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param options - color type / bit depth / fill overrides.
 * @returns encoded PNG bytes.
 */
export function makePng(width = 4, height = 2, options: MakePngOptions = {}): Buffer {
  const colorType = options.colorType ?? 2
  const bitDepth = options.bitDepth ?? 8
  const channels = channelsOf(colorType)
  const fill = options.rgb ?? [180, 90, 40]
  const bytesPerSample = bitDepth === 16 ? 2 : 1
  const stride = width * channels * bytesPerSample
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw.writeUInt8(0, rowStart)
    for (let i = 0; i < stride; i++) {
      raw.writeUInt8((fill[i % fill.length] ?? 0) & 0xff, rowStart + 1 + i)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(bitDepth, 8)
  ihdr.writeUInt8(colorType, 9)
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Build a JPEG header chain `readImageSize` can parse: SOI + SOF0 + EOI.
 * The entropy data is intentionally absent; only the dimensions matter here.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @returns encoded-enough JPEG bytes for header parsing.
 */
export function makeJpeg(width: number, height: number): Buffer {
  const components = Buffer.from([
    1, 0x11, 0,
    2, 0x11, 1,
    3, 0x11, 1,
  ])
  const sofBody = Buffer.alloc(6 + components.length)
  sofBody.writeUInt8(8, 0)
  sofBody.writeUInt16BE(height, 1)
  sofBody.writeUInt16BE(width, 3)
  sofBody.writeUInt8(3, 5)
  components.copy(sofBody, 6)
  const sofLength = Buffer.alloc(2)
  sofLength.writeUInt16BE(2 + sofBody.length, 0)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0]),
    sofLength,
    sofBody,
    Buffer.from([0xff, 0xd9]),
  ])
}

/** Temp directories created by plan 06 specs, removed in their afterEach. */
const tempDirs: string[] = []

/**
 * Create one temp directory tracked for cleanup by {@link cleanupTempDirs}.
 * @param prefix - directory name prefix.
 * @returns absolute directory path.
 */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Remove every temp directory {@link makeTempDir} created in this spec. */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}
