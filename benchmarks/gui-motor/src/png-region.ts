/**
 * Minimal PNG region sampler for the NativeWin capture path: the helper's
 * one-shot `-CaptureOnce` writes an 8-bit non-interlaced PNG (System.Drawing),
 * decoded here with `node:zlib` so `capture()` can report real region colors.
 */

import { inflateSync } from 'node:zlib'
import { CAPTURE_BLACK } from './backend.ts'

/** Bytes per pixel for the color types the helper emits (24-bit RGB, 32-bit RGBA). */
const BYTES_PER_PIXEL: Readonly<Record<number, number>> = { 2: 3, 6: 4 }

function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upperLeft)
  if (pa <= pb && pa <= pc) return left
  if (pb <= pc) return up
  return upperLeft
}

/** Undo one scanline filter in place over `line`, given the previous raw line. */
function unfilter(filter: number, line: Uint8Array, previous: Uint8Array | undefined, bytesPerPixel: number): void {
  for (let index = 0; index < line.length; index++) {
    const left = index >= bytesPerPixel ? line[index - bytesPerPixel] ?? 0 : 0
    const up = previous?.[index] ?? 0
    const upperLeft = previous !== undefined && index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0
    const value = line[index] ?? 0
    if (filter === 1) line[index] = (value + left) & 0xff
    else if (filter === 2) line[index] = (value + up) & 0xff
    else if (filter === 3) line[index] = (value + Math.floor((left + up) / 2)) & 0xff
    else if (filter === 4) line[index] = (value + paeth(left, up, upperLeft)) & 0xff
    else if (filter !== 0) throw new Error(`gui-motor: unsupported PNG filter ${String(filter)}.`)
  }
}

/** Decoded PNG: dimensions, bytes per pixel, and unfiltered row-major pixels. */
export interface DecodedPng {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  readonly bytesPerPixel: number
}

/**
 * Decode one 8-bit non-interlaced PNG into row-major pixel bytes.
 * @param bytes - the PNG file content.
 * @returns the decoded raster.
 */
export function decodePng(bytes: Buffer): DecodedPng {
  const signature = bytes.subarray(0, 8)
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('gui-motor: capture output is not a PNG.')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`gui-motor: unsupported PNG (bit depth ${String(bitDepth)}, interlace ${String(interlace)}).`)
  }
  const bytesPerPixel = BYTES_PER_PIXEL[colorType]
  if (bytesPerPixel === undefined) throw new Error(`gui-motor: unsupported PNG color type ${String(colorType)}.`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bytesPerPixel
  const pixels = new Uint8Array(stride * height)
  let source = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[source] ?? 0
    source += 1
    const line = raw.subarray(source, source + stride)
    source += stride
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined
    unfilter(filter, line, previous as Uint8Array | undefined, bytesPerPixel)
    pixels.set(line, y * stride)
  }
  return { width, height, pixels, bytesPerPixel }
}

/**
 * Average one 3x3 sample around (x, y) into a `#rrggbb` color.
 * @param png - the decoded frame.
 * @param x - sample center column in pixels.
 * @param y - sample center row in pixels.
 * @returns the averaged color, or the black sentinel when the point is outside the frame.
 */
export function sampleColor(png: DecodedPng, x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= png.width || y >= png.height) return CAPTURE_BLACK
  const centerX = Math.round(x)
  const centerY = Math.round(y)
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = centerX + dx
      const py = centerY + dy
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue
      const at = (py * png.width + px) * png.bytesPerPixel
      red += png.pixels[at] ?? 0
      green += png.pixels[at + 1] ?? 0
      blue += png.pixels[at + 2] ?? 0
      count += 1
    }
  }
  if (count === 0) return CAPTURE_BLACK
  const hex = (value: number): string => Math.round(value / count).toString(16).padStart(2, '0')
  return `#${hex(red)}${hex(green)}${hex(blue)}`
}
