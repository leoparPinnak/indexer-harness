/**
 * @deepseek-ai/dsh-cdp — the self-contained PDF text extractor and the
 * print/viewer helpers around it. Built on Node built-ins only (`node:zlib`,
 * `node:buffer`): no PDF library ships at runtime. The parser is data-only —
 * PDF `/JavaScript` and `/Launch` actions are never read or honored, and the
 * only consumer of a file's bytes is the pure functions in this module.
 *
 * Pipeline: magic check → encryption detection → full-file object scan (the
 * broken-xref fallback is the primary path; government PDFs are frequently
 * malformed) → stream decompression → per-page content-stream tokenizing →
 * font/encoding decoding (ToUnicode CMap, Differences, WinAnsi, CP1254
 * heuristic, Identity-H) → budgeted, page-marked chunking.
 *
 * @module @deepseek-ai/dsh-cdp/pdf
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One extracted page inside a budget window. */
export interface ExtractedPdfPage {
  /** 1-based page number (the citation anchor). */
  readonly page: number
  /** Extracted text (cut at the budget when this page alone overruns it). */
  readonly text: string
  /** Honest page classification: text, image-only, vector-only, or empty. */
  readonly kind: 'text' | 'image' | 'vector' | 'empty'
}

/** /Info dictionary metadata, decoded best-effort. */
export interface PdfMeta {
  title?: string | undefined
  author?: string | undefined
  subject?: string | undefined
  producer?: string | undefined
  creator?: string | undefined
  creationDate?: string | undefined
}

/** One AcroForm field value. */
export interface PdfFormField {
  field: string
  value: string
}

/** Options for {@link extractPdfText}. */
export interface ExtractPdfOptions {
  /** First page to read (default 1); the continuation cursor. */
  readonly pageFrom?: number | undefined
  /** Text budget for this call (default 16000, hard max 64000). */
  readonly maxChars?: number | undefined
  /** Read only this 1-page window (bypasses cross-page budgeting up to the cap). */
  readonly page?: number | undefined
  /** Page list/range spec such as `'1-5'` or `'3,7,9-12'`. */
  readonly pages?: string | undefined
  /** Include /Info metadata (default true). */
  readonly includeMeta?: boolean | undefined
}

/** Result of {@link extractPdfText}. */
export interface ExtractPdfResult {
  pageCount: number
  encrypted: boolean
  passwordRequired: boolean
  textLayer: 'present' | 'absent' | 'mixed' | 'unknown'
  pagesWithText: number
  pageFrom: number
  pageTo: number
  nextPage?: number | undefined
  hasMore: boolean
  chars: number
  truncated: boolean
  pages: ExtractedPdfPage[]
  warnings: string[]
  meta?: PdfMeta | undefined
  forms?: PdfFormField[] | undefined
  barcode?: string | undefined
}

/** Default per-call text budget, mirroring `MAX_EVALUATE_CHARS` (page.ts). */
export const DEFAULT_PDF_MAX_CHARS = 16_000
/** Hard ceiling for one call's text, per plan §4.2. */
export const MAX_PDF_MAX_CHARS = 64_000
/** Default parse cap for one PDF file (config `maxPdfBytes`). */
export const DEFAULT_MAX_PDF_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// Byte utilities
// ---------------------------------------------------------------------------

/** ASCII whitespace per the PDF spec. */
function isWhitespace(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20
}

/** PDF delimiter characters. */
function isDelimiter(b: number): boolean {
  return b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e
    || b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d
    || b === 0x2f || b === 0x25
}

/**
 * @param src - byte buffer.
 * @param pos - index of the candidate keyword.
 * @param word - ASCII keyword to match.
 * @returns whether `word` occurs at `pos` followed by a delimiter/whitespace.
 */
function matchesWord(src: Uint8Array, pos: number, word: string): boolean {
  if (pos + word.length > src.length) return false
  for (let i = 0; i < word.length; i += 1) {
    if (src[pos + i] !== word.charCodeAt(i)) return false
  }
  const end = pos + word.length
  return end >= src.length || isWhitespace(src[end]!) || isDelimiter(src[end]!)
}

/**
 * Decode bytes as Latin-1 (a 1:1 byte mapping) — the PDF internal encoding.
 * @param bytes - raw bytes.
 * @returns the decoded string.
 */
function latin1(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

/**
 * Whether the buffer looks like a PDF: the `%PDF-` magic inside the first
 * 1024 bytes (spec allows leading garbage).
 * @param bytes - candidate file bytes.
 * @returns true when the magic is present.
 */
export function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024)
  for (let i = 0; i <= Math.max(0, limit); i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44
      && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/** One parsed PDF object value. */
export type PdfValue =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array }
  | { t: 'arr'; v: PdfValue[] }
  | { t: 'dict'; v: Record<string, PdfValue> }
  | { t: 'ref'; n: number; g: number }

/** One indirect object found by the scan. */
export interface PdfIndirectObject {
  num: number
  gen: number
  value: PdfValue
  stream: Uint8Array | undefined
}

const NULL_VALUE: PdfValue = { t: 'null' }

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Skip whitespace and `%` comments. */
function skipWs(src: Uint8Array, pos: number): number {
  let i = pos
  for (;;) {
    if (i >= src.length) return i
    const b = src[i]!
    if (isWhitespace(b)) { i += 1; continue }
    if (b === 0x25) {
      while (i < src.length && src[i] !== 0x0a && src[i] !== 0x0d) i += 1
      continue
    }
    return i
  }
}

/** Hex digit value, or -1. */
function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30
  if (b >= 0x41 && b <= 0x46) return b - 0x37
  if (b >= 0x61 && b <= 0x66) return b - 0x57
  return -1
}

/** Parse a `/Name` token at `pos` (which holds `/`). */
function parseName(src: Uint8Array, pos: number): { value: PdfValue; next: number } {
  let i = pos + 1
  let out = ''
  while (i < src.length) {
    const b = src[i]!
    if (isWhitespace(b) || isDelimiter(b)) break
    if (b === 0x23 && i + 2 < src.length) {
      const hi = hexVal(src[i + 1]!)
      const lo = hexVal(src[i + 2]!)
      if (hi >= 0 && lo >= 0) {
        out += String.fromCharCode(hi * 16 + lo)
        i += 3
        continue
      }
    }
    out += String.fromCharCode(b)
    i += 1
  }
  return { value: { t: 'name', v: out }, next: i }
}

/** Parse a `(…)` string at `pos` (which holds `(`), honoring escapes and nesting. */
function parseLiteralString(src: Uint8Array, pos: number): { bytes: Uint8Array; next: number } {
  const out: number[] = []
  let depth = 0
  let i = pos
  for (;;) {
    if (i >= src.length) break
    const b = src[i]!
    if (b === 0x5c) { // backslash
      i += 1
      if (i >= src.length) break
      const e = src[i]!
      if (e === 0x6e) out.push(0x0a)
      else if (e === 0x72) out.push(0x0d)
      else if (e === 0x74) out.push(0x09)
      else if (e === 0x62) out.push(0x08)
      else if (e === 0x66) out.push(0x0c)
      else if (e === 0x0a) { /* line continuation */ }
      else if (e === 0x0d) { if (src[i + 1] === 0x0a) i += 1 }
      else if (e >= 0x30 && e <= 0x37) {
        let oct = e - 0x30
        let n = 1
        while (n < 3 && src[i + 1] !== undefined && src[i + 1]! >= 0x30 && src[i + 1]! <= 0x37) {
          i += 1
          oct = oct * 8 + (src[i]! - 0x30)
          n += 1
        }
        out.push(oct & 0xff)
      } else out.push(e)
      i += 1
      continue
    }
    if (b === 0x28) {
      depth += 1
      if (depth === 1) { i += 1; continue } // the outer '(' opens, never joins the bytes
    }
    if (b === 0x29) {
      depth -= 1
      if (depth === 0) { i += 1; break }
    }
    out.push(b)
    i += 1
  }
  return { bytes: Uint8Array.from(out), next: i }
}

/** Parse a `<hex>` string at `pos` (which holds `<`, not `<<`). */
function parseHexString(src: Uint8Array, pos: number): { bytes: Uint8Array; next: number } {
  const digits: number[] = []
  let i = pos + 1
  while (i < src.length && src[i] !== 0x3e) {
    const v = hexVal(src[i]!)
    if (v >= 0) digits.push(v)
    i += 1
  }
  if (digits.length % 2 === 1) digits.push(0)
  const out = new Uint8Array(digits.length / 2)
  for (let k = 0; k < out.length; k += 1) out[k] = digits[k * 2]! * 16 + digits[k * 2 + 1]!
  return { bytes: out, next: Math.min(i + 1, src.length) }
}

/** Parse a number token at `pos`. */
function parseNumber(src: Uint8Array, pos: number): { value: number; next: number } {
  let i = pos
  let text = ''
  if (src[i] === 0x2b || src[i] === 0x2d) { text += String.fromCharCode(src[i]!); i += 1 }
  let seenDot = false
  while (i < src.length) {
    const b = src[i]!
    if (b >= 0x30 && b <= 0x39) { text += String.fromCharCode(b); i += 1; continue }
    if (b === 0x2e && !seenDot) { text += '.'; seenDot = true; i += 1; continue }
    break
  }
  return { value: Number.parseFloat(text), next: i }
}

/**
 * Parse one PDF value starting at `pos` (after leading whitespace).
 * @param src - source bytes.
 * @param pos - start index.
 * @param allowRefs - whether `n g R` reference syntax is recognized.
 * @returns the parsed value and the index after it, or null for an unrecognized token.
 */
export function parseValueAt(src: Uint8Array, pos: number, allowRefs = true): { value: PdfValue; next: number } | null {
  const start = skipWs(src, pos)
  if (start >= src.length) return null
  const b = src[start]!

  if (b === 0x2f) return parseName(src, start)

  if (b === 0x28) {
    const parsed = parseLiteralString(src, start)
    return { value: { t: 'str', v: parsed.bytes }, next: parsed.next }
  }

  if (b === 0x3c) {
    if (src[start + 1] === 0x3c) {
      const dict: Record<string, PdfValue> = {}
      let i = start + 2
      for (;;) {
        i = skipWs(src, i)
        if (i + 1 < src.length && src[i] === 0x3e && src[i + 1] === 0x3e) {
          return { value: { t: 'dict', v: dict }, next: i + 2 }
        }
        if (i >= src.length) return { value: { t: 'dict', v: dict }, next: i }
        if (src[i] !== 0x2f) { // malformed key: skip one token defensively
          const skip = parseValueAt(src, i, false)
          i = skip === null ? i + 1 : skip.next
          continue
        }
        const key = parseName(src, i)
        const val = parseValueAt(src, key.next, allowRefs)
        if (val === null) { dict[key.value.t === 'name' ? key.value.v : ''] = NULL_VALUE; i = key.next; continue }
        dict[key.value.t === 'name' ? key.value.v : ''] = val.value
        i = val.next
      }
    }
    const hex = parseHexString(src, start)
    return { value: { t: 'str', v: hex.bytes }, next: hex.next }
  }

  if (b === 0x5b) {
    const items: PdfValue[] = []
    let i = start + 1
    for (;;) {
      i = skipWs(src, i)
      if (i >= src.length) return { value: { t: 'arr', v: items }, next: i }
      if (src[i] === 0x5d) return { value: { t: 'arr', v: items }, next: i + 1 }
      const item = parseValueAt(src, i, allowRefs)
      if (item === null) { i += 1; continue }
      items.push(item.value)
      i = item.next
    }
  }

  const isDigit = b >= 0x30 && b <= 0x39
  if (isDigit || b === 0x2b || b === 0x2d || b === 0x2e) {
    const num = parseNumber(src, start)
    if (!allowRefs) return { value: { t: 'num', v: num.value }, next: num.next }
    // `n g R` indirect reference: number, number, keyword R.
    const second = parseNumber(src, skipWs(src, num.next))
    if (Number.isInteger(num.value) && Number.isInteger(second.value) && second.next > num.next) {
      const afterWs = skipWs(src, second.next)
      if (matchesWord(src, afterWs, 'R')) {
        return { value: { t: 'ref', n: num.value, g: second.value }, next: afterWs + 1 }
      }
    }
    return { value: { t: 'num', v: num.value }, next: num.next }
  }

  // Keywords: true / false / null.
  if (matchesWord(src, start, 'true')) return { value: { t: 'bool', v: true }, next: start + 4 }
  if (matchesWord(src, start, 'false')) return { value: { t: 'bool', v: false }, next: start + 5 }
  if (matchesWord(src, start, 'null')) return { value: NULL_VALUE, next: start + 4 }
  return null
}

// ---------------------------------------------------------------------------
// Full-file object scan
// ---------------------------------------------------------------------------

/**
 * Scan the whole file for `n g obj` headers. This is the primary object
 * reader: classic xref tables are frequently wrong in the wild, and a linear
 * scan is O(file) which is fine under the size cap.
 * @param src - the PDF bytes.
 * @returns indirect objects keyed by object number (later generations win).
 */
export function scanObjects(src: Uint8Array): Map<number, PdfIndirectObject> {
  const objects = new Map<number, PdfIndirectObject>()
  let i = 0
  while (i < src.length - 3) {
    const b = src[i]!
    if (b < 0x30 || b > 0x39) { i += 1; continue }
    // Candidate `n g obj` header.
    let j = i
    let numText = ''
    while (j < src.length && src[j]! >= 0x30 && src[j]! <= 0x39) { numText += String.fromCharCode(src[j]!); j += 1 }
    let k = skipWs(src, j)
    let genText = ''
    while (k < src.length && src[k]! >= 0x30 && src[k]! <= 0x39) { genText += String.fromCharCode(src[k]!); k += 1 }
    if (genText === '') { i += 1; continue }
    k = skipWs(src, k)
    if (!matchesWord(src, k, 'obj')) { i += 1; continue }

    const num = Number.parseInt(numText, 10)
    const gen = Number.parseInt(genText, 10)
    const parsed = parseValueAt(src, k + 3, true)
    if (parsed === null) { i = k + 3; continue }
    let stream: Uint8Array | undefined
    let next = parsed.next
    if (parsed.value.t === 'dict') {
      const after = skipWs(src, next)
      if (matchesWord(src, after, 'stream')) {
        let dataStart = after + 6
        if (src[dataStart] === 0x0d) dataStart += 1
        if (src[dataStart] === 0x0a) dataStart += 1
        stream = readStreamData(src, dataStart, parsed.value)
        next = dataStart + (stream?.length ?? 0)
      }
    }
    objects.set(num, { num, gen, value: parsed.value, stream })
    i = next
  }
  return objects
}

/**
 * Read stream bytes using `/Length` when trustworthy, else scan to `endstream`.
 * @param src - file bytes.
 * @param dataStart - index just after the `stream` keyword and its EOL.
 * @param dict - the stream's dictionary.
 * @returns the raw (still encoded) stream bytes.
 */
function readStreamData(src: Uint8Array, dataStart: number, dict: { t: 'dict'; v: Record<string, PdfValue> }): Uint8Array {
  const lengthValue = dict.v['Length']
  if (lengthValue !== undefined && lengthValue.t === 'num' && Number.isInteger(lengthValue.v) && lengthValue.v >= 0) {
    const end = dataStart + lengthValue.v
    const probe = skipWs(src, end)
    if (matchesWord(src, probe, 'endstream')) {
      return src.subarray(dataStart, end)
    }
  }
  // Fallback: scan for the keyword.
  for (let i = dataStart; i + 9 <= src.length; i += 1) {
    if (matchesWord(src, i, 'endstream')) {
      let end = i
      // The EOL before `endstream` is not part of the data.
      if (end > dataStart && src[end - 1] === 0x0a) end -= 1
      if (end > dataStart && src[end - 1] === 0x0d) end -= 1
      return src.subarray(dataStart, end)
    }
  }
  return src.subarray(dataStart)
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Strip the trailing EOL/space bytes PDF writers put before `endstream`. */
function stripTrailingEol(data: Uint8Array): Uint8Array {
  let end = data.length
  while (end > 0 && (data[end - 1] === 0x0a || data[end - 1] === 0x0d || data[end - 1] === 0x20)) end -= 1
  return data.subarray(0, end)
}

/**
 * Inflate a FlateDecode payload with the fallback chain from plan §5.3.4:
 * `inflateSync`, EOL-stripped retry, then raw deflate both ways.
 * @param data - raw stream bytes.
 * @returns inflated bytes, or null when every attempt fails.
 */
export function inflatePdfStream(data: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const candidates: Buffer[] = [buf]
  const stripped = stripTrailingEol(data)
  if (stripped.length !== data.length) {
    candidates.push(Buffer.from(stripped.buffer, stripped.byteOffset, stripped.byteLength))
  }
  for (const candidate of candidates) {
    try { return new Uint8Array(inflateSync(candidate)) } catch { /* next */ }
  }
  for (const candidate of candidates) {
    try { return new Uint8Array(inflateRawSync(candidate)) } catch { /* next */ }
  }
  return null
}

/** ASCIIHexDecode payload → bytes. */
function decodeAsciiHex(data: Uint8Array): Uint8Array {
  const digits: number[] = []
  for (const b of data) {
    if (b === 0x3e) break
    const v = hexVal(b)
    if (v >= 0) digits.push(v)
  }
  if (digits.length % 2 === 1) digits.push(0)
  const out = new Uint8Array(digits.length / 2)
  for (let k = 0; k < out.length; k += 1) out[k] = digits[k * 2]! * 16 + digits[k * 2 + 1]!
  return out
}

/** RunLengthDecode payload → bytes. */
function decodeRunLength(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const len = data[i]!
    i += 1
    if (len === 128) break
    if (len < 128) {
      const count = len + 1
      for (let n = 0; n < count && i < data.length; n += 1) out.push(data[i]!)
      i += count
    } else {
      if (i >= data.length) break
      const byte = data[i]!
      i += 1
      for (let n = 0; n < 257 - len; n += 1) out.push(byte)
    }
  }
  return Uint8Array.from(out)
}

/** LZWDecode payload → bytes (PDF variant: 9-bit codes, EarlyChange=1). */
function decodeLzw(data: Uint8Array): Uint8Array {
  const CLEAR = 256
  const EOD = 257
  let codeLen = 9
  let bitPos = 0
  const dictionary: Uint8Array[] = []
  const resetDict = (): void => {
    dictionary.length = 0
    for (let i = 0; i < 258; i += 1) dictionary.push(Uint8Array.of(i))
    codeLen = 9
  }
  resetDict()
  const out: number[] = []
  let prev: Uint8Array | undefined
  const readCode = (): number | null => {
    let value = 0
    for (let n = 0; n < codeLen; n += 1) {
      const byteIndex = bitPos >> 3
      if (byteIndex >= data.length) return null
      const bit = (data[byteIndex]! >> (7 - (bitPos & 7))) & 1
      value = (value << 1) | bit
      bitPos += 1
    }
    return value
  }
  for (;;) {
    const code = readCode()
    if (code === null || code === EOD) break
    if (code === CLEAR) { resetDict(); prev = undefined; continue }
    let entry: Uint8Array
    if (code < dictionary.length) {
      entry = dictionary[code]!
    } else if (prev !== undefined && code === dictionary.length) {
      entry = new Uint8Array(prev.length + 1)
      entry.set(prev, 0)
      entry[prev.length] = prev[0]!
    } else break
    for (const byte of entry) out.push(byte)
    if (prev !== undefined) {
      const added = new Uint8Array(prev.length + 1)
      added.set(prev, 0)
      added[prev.length] = entry[0]!
      dictionary.push(added)
    }
    prev = entry
    while (dictionary.length + 1 >= (1 << codeLen) && codeLen < 12) codeLen += 1
    // EarlyChange=1: grow one step early.
    if (dictionary.length >= (1 << codeLen) - 1 && codeLen < 12) codeLen += 1
  }
  return Uint8Array.from(out)
}

/** Apply a PNG predictor (bpc=8 rows) after FlateDecode. */
function applyPngPredictor(data: Uint8Array, parms: Record<string, PdfValue>): Uint8Array {
  const colors = numOr(parms['Colors'], 1)
  const columns = numOr(parms['Columns'], 1)
  const bpc = numOr(parms['BitsPerComponent'], 8)
  if (bpc !== 8) return data
  const rowLen = colors * columns
  const bpp = Math.max(1, Math.ceil(colors / 8))
  const out = new Uint8Array(data.length)
  let pos = 0
  let prevRow = new Uint8Array(rowLen)
  while (pos < data.length) {
    const filter = data[pos]!
    pos += 1
    const row = data.subarray(pos, pos + rowLen)
    pos += rowLen
    const cur = new Uint8Array(rowLen)
    for (let i = 0; i < row.length; i += 1) {
      const raw = row[i]!
      const left = i >= bpp ? cur[i - bpp]! : 0
      const up = prevRow[i]!
      const upLeft = i >= bpp ? prevRow[i - bpp]! : 0
      let val: number
      switch (filter) {
        case 0: val = raw; break
        case 1: val = raw + left; break
        case 2: val = raw + up; break
        case 3: val = raw + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const pred = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft)
          val = raw + pred
          break
        }
        default: val = raw
      }
      cur[i] = val & 0xff
    }
    out.set(cur, pos - rowLen)
    prevRow = cur
  }
  return out
}

/** Read a numeric dict entry with a fallback. */
function numOr(value: PdfValue | undefined, fallback: number): number {
  return value !== undefined && value.t === 'num' ? value.v : fallback
}

/** One named filter step. */
interface FilterStep {
  name: string
  parms: Record<string, PdfValue> | undefined
}

/**
 * Decode a content stream through its /Filter chain.
 * @param data - raw stream bytes.
 * @param dict - the stream dictionary.
 * @param warnings - collector for honest "skipped" notices.
 * @param label - stream description used in warnings.
 * @returns decoded bytes, or null when a filter cannot be decoded (the caller
 *   then reports an honest warning instead of emitting garbage).
 */
export function decodeStream(
  data: Uint8Array,
  dict: { t: 'dict'; v: Record<string, PdfValue> },
  warnings: string[],
  label: string,
): Uint8Array | null {
  const filterValue = dict.v['Filter']
  if (filterValue === undefined) return data
  const rawFilters = filterValue.t === 'arr' ? filterValue.v : [filterValue]
  const parmsValue = dict.v['DecodeParms'] ?? dict.v['DP']
  const rawParms = parmsValue === undefined
    ? []
    : parmsValue.t === 'arr' ? parmsValue.v : [parmsValue]

  const steps: FilterStep[] = []
  for (let i = 0; i < rawFilters.length; i += 1) {
    const f = rawFilters[i]!
    const p = rawParms[i]
    steps.push({
      name: f.t === 'name' ? f.v : '',
      parms: p !== undefined && p.t === 'dict' ? p.v : undefined,
    })
  }

  let current: Uint8Array | null = data
  for (const step of steps) {
    if (current === null) return null
    switch (step.name) {
      case 'FlateDecode': case 'Fl': {
        const inflated = inflatePdfStream(current)
        if (inflated === null) {
          warnings.push(`${label}: FlateDecode failed; stream skipped`)
          return null
        }
        current = inflated
        const predictor = numOr(step.parms?.['Predictor'], 1)
        if (predictor >= 10 && step.parms !== undefined) current = applyPngPredictor(current, step.parms)
        break
      }
      case 'ASCIIHexDecode': case 'AHx': current = decodeAsciiHex(current); break
      case 'RunLengthDecode': case 'RL': current = decodeRunLength(current); break
      case 'LZWDecode': case 'LZW': {
        current = decodeLzw(current)
        break
      }
      default:
        warnings.push(`${label}: unsupported filter /${step.name}; stream skipped`)
        return null
    }
  }
  return current
}

// ---------------------------------------------------------------------------
// Encodings and glyph names
// ---------------------------------------------------------------------------

const decoderCache = new Map<string, TextDecoder>()

/** A cached single-byte decoder (`windows-1252`, `windows-1254`, …). */
function decoder(encoding: string): TextDecoder {
  let found = decoderCache.get(encoding)
  if (found === undefined) {
    found = new TextDecoder(encoding)
    decoderCache.set(encoding, found)
  }
  return found
}

/** Per-byte tables built lazily (one decode per byte value, then cached). */
const tableCache = new Map<string, string[]>()

/**
 * @param encoding - TextDecoder single-byte encoding label.
 * @returns a 256-entry byte → character table.
 */
function byteTable(encoding: string): string[] {
  const cached = tableCache.get(encoding)
  if (cached !== undefined) return cached
  const dec = decoder(encoding)
  const table: string[] = []
  for (let b = 0; b < 256; b += 1) table.push(dec.decode(Uint8Array.of(b)))
  tableCache.set(encoding, table)
  return table
}

/** Decode bytes through a 256-entry table. */
function decodeWithTable(bytes: Uint8Array, table: string[]): string {
  let out = ''
  for (const b of bytes) out += table[b] ?? '�'
  return out
}

/** Common Adobe glyph name → Unicode. Unmapped names fall back to `uniXXXX`. */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', period: '.', slash: '/', zero: '0', one: '1', two: '2',
  three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
  at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quotedblleft: '“', quotedblright: '”', quoteleft: '‘', quoteright: '’',
  quotedblbase: '„', quotesinglbase: '‚', endash: '–', emdash: '—', bullet: '•',
  dagger: '†', daggerdbl: '‡', periodcentered: '·', ellipsis: '…', perthousand: '‰',
  fi: 'ﬁ', fl: 'ﬂ', fraction: '⁄', percent1: '%', deg: '°', degree: '°',
  sterling: '£', currency: '¤', yen: '¥', copyright: '©', registered: '®',
  trademark: '™', logicalnot: '¬', section: '§', paragraph: '¶',
  dieresis: '¨', cedilla: '¸', acute: '´', circumflex: '^', tilde: '~',
  macron: '¯', breve: '˘', caron: 'ˇ', dotaccent: '˙', ring: '˚', ogonek: '˛',
  doubleacute: '˝', hungarumlaut: '˙', commaaccent: 'ˇ',
  minus: '−', plusminus: '±', multiply: '×', divide: '÷',
  onesuperior: '¹', twosuperior: '²', threesuperior: '³',
  onequarter: '¼', onehalf: '½', threequarters: '¾',
  Agrave: 'À', Aacute: 'Á', Acircumflex: 'Â', Atilde: 'Ã', Adieresis: 'Ä',
  Aring: 'Å', AE: 'Æ', Ccedilla: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecircumflex: 'Ê', Edieresis: 'Ë', Igrave: 'Ì', Iacute: 'Í', Idotaccent: 'İ',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocircumflex: 'Ô', Otilde: 'Õ',
  Odieresis: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucircumflex: 'Û',
  Udieresis: 'Ü', Yacute: 'Ý', Thorn: 'Þ', germandbls: 'ß',
  agrave: 'à', aacute: 'á', acircumflex: 'â', atilde: 'ã', adieresis: 'ä',
  aring: 'å', ae: 'æ', ccedilla: 'ç', egrave: 'è', eacute: 'é',
  ecircumflex: 'ê', edieresis: 'ë', igrave: 'ì', iacute: 'í',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocircumflex: 'ô', otilde: 'õ',
  odieresis: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucircumflex: 'û',
  udieresis: 'ü', yacute: 'ý', thorn: 'þ', ydieresis: 'ÿ',
  dotlessi: 'ı', dotlessj: 'j', gbreve: 'Ğ', gdotaccent: 'ğ', idotaccent: 'İ',
  scedilla: 'ş', Scedilla: 'Ş', Lslash: 'Ł', lslash: 'ł',
  OE: 'Œ', oe: 'œ', Scaron: 'Š', scaron: 'š', Zcaron: 'Ž', zcaron: 'ž',
  quoterightbase: '’', hyphen: '-', endash2: '–',
}

/**
 * Map one glyph name to Unicode.
 * @param name - the glyph name from /Differences or a content stream.
 * @returns the character(s), or undefined when the name cannot be mapped.
 */
export function glyphToUnicode(name: string): string | undefined {
  if (name === '' || name === '.notdef') return undefined
  const direct = GLYPH_NAMES[name]
  if (direct !== undefined) return direct
  const uni = /^uni([0-9A-Fa-f]{4})+$/.exec(name)
  if (uni !== null) {
    const hex = uni[1]!
    let out = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16))
    }
    return out
  }
  const ucode = /^u[0-9A-Fa-f]{4,6}$/.exec(name)
  if (ucode !== null) return String.fromCodePoint(Number.parseInt(name.slice(1), 16))
  if (name.length === 1) return name
  // `aacute`-style already covered; try trailing component of `f_f_f` ligatures.
  if (name.includes('_')) {
    const parts = name.split('_').filter(part => part !== '' && part !== 'f' && part !== 'i' && part !== 'l')
    if (parts.length > 0) {
      const joined = glyphToUnicode(parts.join('_'))
      if (joined !== undefined) return joined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** Everything the decoder needs about one font resource. */
export interface FontInfo {
  /** Font resource name (e.g. `F1`), for warnings. */
  name: string
  /** Composite (Type0/Identity) font: 2-byte codes. */
  isType0: boolean
  /** Parsed /ToUnicode CMap, keyed by uppercase source-code hex. */
  tounicode: Map<string, string> | undefined
  /** Bytes per character code (1 or 2). */
  codeBytes: number
  /** /Differences overrides: byte → glyph name. */
  differences: Map<number, string> | undefined
  /** Explicit base-encoding table (WinAnsi etc.); undefined means CP1252 default. */
  base: string[] | undefined
  /** True for Identity-H/V fonts that carry no /ToUnicode at all. */
  identity: boolean
  /** CP1254 heuristic allowed (no explicit non-WinAnsi encoding, no Differences). */
  heuristicOk: boolean
}

/** Parse one ToUnicode CMap's mapping tables. */
function parseCMap(text: string): { map: Map<string, string>; codeBytes: number | undefined } {
  const map = new Map<string, string>()
  let codeBytes: number | undefined

  const decodeDstHex = (hex: string): string => {
    const clean = hex.trim()
    const bytes: number[] = []
    for (let i = 0; i + 1 < clean.length; i += 2) {
      bytes.push(Number.parseInt(clean.slice(i, i + 2), 16))
    }
    let out = ''
    for (let i = 0; i < bytes.length; i += 2) {
      const unit = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)
      if (unit >= 0xd800 && unit <= 0xdbff && i + 3 < bytes.length) {
        const low = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))
          i += 2
          continue
        }
      }
      out += String.fromCharCode(unit)
    }
    return out
  }

  const spaceRanges = /begincodespacerange([\s\S]*?)endcodespacerange/g
  let rangeMatch: RegExpExecArray | null
  while ((rangeMatch = spaceRanges.exec(text)) !== null) {
    const first = /<([0-9A-Fa-f]+)>/.exec(rangeMatch[1] ?? '')
    if (first !== null) codeBytes = Math.max(1, Math.ceil(first[1]!.length / 2))
  }

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  let charMatch: RegExpExecArray | null
  while ((charMatch = bfchar.exec(text)) !== null) {
    const pairs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let pair: RegExpExecArray | null
    while ((pair = pairs.exec(charMatch[1] ?? '')) !== null) {
      map.set(pair[1]!.toUpperCase(), decodeDstHex(pair[2]!))
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  let range: RegExpExecArray | null
  while ((range = bfrange.exec(text)) !== null) {
    const body = range[1] ?? ''
    const triplets = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g
    let tri: RegExpExecArray | null
    while ((tri = triplets.exec(body)) !== null) {
      const lo = Number.parseInt(tri[1]!, 16)
      const hi = Number.parseInt(tri[2]!, 16)
      if (!(hi - lo < 65536)) continue
      if (tri[3] !== undefined) {
        const base = decodeDstHex(tri[3])
        const baseCode = base.codePointAt(0) ?? 0
        for (let code = lo; code <= hi; code += 1) {
          map.set(code.toString(16).toUpperCase().padStart(tri[1]!.length, '0'),
            String.fromCodePoint(baseCode + (code - lo)))
        }
      } else if (tri[4] !== undefined) {
        const items = /<([0-9A-Fa-f]+)>/g
        let item: RegExpExecArray | null
        let index = 0
        while ((item = items.exec(tri[4])) !== null) {
          map.set((lo + index).toString(16).toUpperCase().padStart(tri[1]!.length, '0'),
            decodeDstHex(item[1]!))
          index += 1
        }
      }
    }
  }
  return { map, codeBytes }
}

/** Decode UTF-16BE bytes (PDF text strings). */
function decodeUtf16Be(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = (bytes[i]! << 8) | bytes[i + 1]!
    out += String.fromCharCode(unit)
  }
  return out
}

/** Decode a PDF text string (literal or hex): UTF-16BE when BOM, else Latin-1. */
function decodePdfTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Be(bytes.subarray(2))
  }
  return latin1(bytes)
}

/** Build one font's decoding state from its dictionary. */
function buildFont(
  resolved: PdfValue,
  resourceName: string,
  streamOf: (value: PdfValue) => Uint8Array | undefined,
): FontInfo {
  const dict = resolved.t === 'dict' ? resolved : { t: 'dict' as const, v: {} }
  const subtype = dict.v['Subtype']
  const isType0 = subtype !== undefined && subtype.t === 'name' && subtype.v === 'Type0'

  let tounicode: Map<string, string> | undefined
  let codeBytes = isType0 ? 2 : 1

  const toUnicodeValue = dict.v['ToUnicode']
  if (toUnicodeValue !== undefined) {
    const cmapData = streamOf(toUnicodeValue)
    if (cmapData !== undefined) {
      // ToUnicode streams arrive raw or Flate-compressed; decode best-effort.
      const inflated = inflatePdfStream(cmapData)
      const text = latin1(inflated ?? cmapData)
      const parsed = parseCMap(text)
      if (parsed.map.size > 0) tounicode = parsed.map
      if (parsed.codeBytes !== undefined) codeBytes = parsed.codeBytes
    }
  }

  let base: string[] | undefined
  let differences: Map<number, string> | undefined
  let heuristicOk = false

  const encoding = dict.v['Encoding']
  const encodingName = encoding?.t === 'name' ? encoding.v : undefined
  if (encodingName === 'Identity-H' || encodingName === 'Identity-V') codeBytes = 2

  if (encoding === undefined || encodingName === 'WinAnsiEncoding') {
    base = undefined // CP1252 default path
    heuristicOk = true
  } else if (encodingName !== undefined) {
    base = encodingName === 'MacRomanEncoding' ? byteTable('macintosh') : byteTable('windows-1252')
  } else if (encoding !== undefined && encoding.t === 'dict') {
    const baseEncoding = encoding.v['BaseEncoding']
    const baseName = baseEncoding?.t === 'name' ? baseEncoding.v : 'StandardEncoding'
    base = baseName === 'WinAnsiEncoding'
      ? byteTable('windows-1252')
      : baseName === 'MacRomanEncoding' ? byteTable('macintosh') : byteTable('windows-1252')
    heuristicOk = baseName === 'WinAnsiEncoding'
    const diffs = encoding.v['Differences']
    if (diffs !== undefined && diffs.t === 'arr') {
      differences = new Map()
      let code = 0
      for (const entry of diffs.v) {
        if (entry.t === 'num') code = entry.v
        else if (entry.t === 'name') {
          differences.set(code, entry.v)
          code += 1
        }
      }
      if (differences.size === 0) differences = undefined
      if (differences !== undefined) heuristicOk = false
    }
  }

  return { name: resourceName, isType0, tounicode, codeBytes, differences, base, identity: isType0 && tounicode === undefined, heuristicOk }
}

/** Decode string bytes to Unicode text with the font's encoding. */
function decodeWithFont(bytes: Uint8Array, font: FontInfo, warnings: string[]): string {
  if (font.identity) {
    warnings.push(`CID font without ToUnicode; text may be approximate (font ${font.name})`)
    return ''
  }
  if (font.tounicode !== undefined) {
    let out = ''
    const width = font.codeBytes
    for (let i = 0; i + width <= bytes.length; i += width) {
      const key = Array.from(bytes.subarray(i, i + width))
        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('')
      const mapped = font.tounicode.get(key)
      if (mapped !== undefined) out += mapped
    }
    return out
  }

  const cp1254 = (): string => decodeWithTable(bytes, byteTable('windows-1254'))
  if (font.differences !== undefined) {
    let out = ''
    for (const b of bytes) {
      const glyph = font.differences.get(b)
      if (glyph !== undefined) {
        const mapped = glyphToUnicode(glyph)
        if (mapped !== undefined) out += mapped
        else warnings.push(`unmapped glyph name /${glyph} in font ${font.name}`)
      } else {
        out += (font.base ?? byteTable('windows-1252'))[b] ?? '�'
      }
    }
    return out
  }

  const table = font.base ?? byteTable('windows-1252')
  const text = decodeWithTable(bytes, table)
  if (font.heuristicOk && /[ÐÞÝ]/.test(text)) {
    // A WinAnsi-labelled PDF carrying CP1254 bytes: the CP1252 reading has
    // mojibake (BAÞKANLIÐI) while the CP1254 reading resolves Turkish letters.
    const turkish = cp1254()
    if (/[şıİğŞĞ]/.test(turkish)) return turkish
  }
  return text
}

// ---------------------------------------------------------------------------
// Content-stream text extraction
// ---------------------------------------------------------------------------

/** Six-element PDF transform matrix (a b c d e f). */
type Matrix = [number, number, number, number, number, number]

/** Matrix product m1 × m2. */
function matMul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ]
}

/** Vector-path operators (they prove the page draws something even without text). */
const VECTOR_OPERATORS = new Set([
  're', 'f', 'f*', 'S', 's', 'B', 'b', 'B*', 'b*', 'n', 'W', 'W*',
  'l', 'm', 'c', 'v', 'y', 'h', 'sh',
])

/** Result of one page's content-stream walk. */
interface ContentWalk {
  text: string
  hasTextOps: boolean
  hasVectorOps: boolean
  hasInlineImage: boolean
}

/**
 * Walk a page's content streams and emit text in reading order with newlines
 * at line moves (T-star / Td / TD / Tm Y changes).
 * @param chunks - decoded content streams, in /Contents order.
 * @param fontFor - resolve a font resource name to its decoding state.
 * @param warnings - collector (font/decode honesty notes).
 * @returns the extracted text and the operator classes seen.
 */
export function walkContent(
  chunks: Uint8Array[],
  fontFor: (name: string) => FontInfo | undefined,
  warnings: string[],
): ContentWalk {
  const pieces: string[] = []
  let tm: Matrix = [1, 0, 0, 1, 0, 0]
  let tlm: Matrix = [1, 0, 0, 1, 0, 0]
  let leading = 0
  let font: FontInfo | undefined
  let newlinePending = false
  let lastTextY: number | undefined
  let hasTextOps = false
  let hasVectorOps = false
  let hasInlineImage = false

  const emitNewline = (): void => {
    if (pieces.length > 0 && !pieces[pieces.length - 1]!.endsWith('\n')) pieces.push('\n')
  }
  const markLineMove = (newY: number): void => {
    if (lastTextY !== undefined && newY !== lastTextY) newlinePending = true
  }
  const show = (bytes: Uint8Array): void => {
    if (newlinePending) { emitNewline(); newlinePending = false }
    if (font === undefined) return
    pieces.push(decodeWithFont(bytes, font, warnings))
    lastTextY = tm[5]
  }

  const src = chunks.length === 1 ? chunks[0]! : concatBytes(chunks)
  let i = 0
  const operands: PdfValue[] = []

  while (i < src.length) {
    const b = src[i]!
    if (isWhitespace(b)) { i += 1; continue }
    if (b === 0x25) { while (i < src.length && src[i] !== 0x0a && src[i] !== 0x0d) i += 1; continue }

    if (b === 0x28) {
      const parsed = parseLiteralString(src, i)
      operands.push({ t: 'str', v: parsed.bytes })
      i = parsed.next
      continue
    }
    if (b === 0x3c) {
      if (src[i + 1] === 0x3c) {
        const dict = parseValueAt(src, i, false)
        if (dict !== null) { operands.push(dict.value); i = dict.next; continue }
        i += 1; continue
      }
      const hex = parseHexString(src, i)
      operands.push({ t: 'str', v: hex.bytes })
      i = hex.next
      continue
    }
    if (b === 0x5b) {
      const arr = parseValueAt(src, i, false)
      if (arr !== null) { operands.push(arr.value); i = arr.next; continue }
      i += 1; continue
    }
    if (b === 0x2f) {
      const name = parseName(src, i)
      operands.push(name.value)
      i = name.next
      continue
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const num = parseNumber(src, i)
      operands.push({ t: 'num', v: num.value })
      i = num.next
      continue
    }

    // Bare keyword: an operator (or boolean/null operand).
    let j = i
    while (j < src.length && !isWhitespace(src[j]!) && !isDelimiter(src[j]!)) j += 1
    const word = latin1(src.subarray(i, j))
    i = j === i ? i + 1 : j
    if (word === 'true') { operands.push({ t: 'bool', v: true }); continue }
    if (word === 'false') { operands.push({ t: 'bool', v: false }); continue }
    if (word === 'null') { operands.push(NULL_VALUE); continue }
    if (word === '') continue

    const numbers = (...idx: number[]): number[] => idx.map((idx2) => {
      const operand = operands[idx2]
      return operand !== undefined && operand.t === 'num' ? operand.v : 0
    })

    switch (word) {
      case 'BI': // inline image: skip its binary payload to EI.
        hasInlineImage = true
        i = skipInlineImage(src, i)
        operands.length = 0
        break
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0]
        tlm = tm
        break
      case 'ET':
        break
      case 'Tf': {
        const nameValue = operands[0]
        if (nameValue?.t === 'name') font = fontFor(nameValue.v)
        break
      }
      case 'Td': case 'TD': {
        const operandsNums = numbers(0, 1)
        const tx = operandsNums[0] ?? 0
        const ty = operandsNums[1] ?? 0
        if (word === 'TD') leading = -ty
        tlm = matMul([1, 0, 0, 1, tx, ty], tlm)
        tm = tlm
        if (ty !== 0) newlinePending = true
        else markLineMove(tm[5])
        break
      }
      case 'Tm': {
        const m = numbers(0, 1, 2, 3, 4, 5)
        tm = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!]
        tlm = tm
        markLineMove(tm[5])
        break
      }
      case 'T*':
        tlm = matMul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        newlinePending = true
        break
      case 'TL': leading = numbers(0)[0] ?? 0; break
      case 'Tj': {
        const str = operands[0]
        if (str?.t === 'str') { hasTextOps = true; show(str.v) }
        break
      }
      case "'": {
        tlm = matMul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        newlinePending = true
        const str = operands[0]
        if (str?.t === 'str') { hasTextOps = true; show(str.v) }
        break
      }
      case '"': {
        const str = operands[2]
        tlm = matMul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        newlinePending = true
        if (str?.t === 'str') { hasTextOps = true; show(str.v) }
        break
      }
      case 'TJ': {
        const arr = operands[0]
        if (arr?.t === 'arr') {
          hasTextOps = true
          for (const item of arr.v) {
            if (item.t === 'str') show(item.v)
            else if (item.t === 'num' && item.v <= -100) pieces.push(' ')
          }
        }
        break
      }
      case 'Do': {
        // External XObject (images are counted by the page-resource scan).
        break
      }
      default:
        if (VECTOR_OPERATORS.has(word)) hasVectorOps = true
        break
    }
    operands.length = 0
  }

  const joined = pieces.join('')
  const text = joined.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
  return { text, hasTextOps, hasVectorOps, hasInlineImage }
}

/** Skip an inline image payload: from `ID` to the first plausible `EI`. */
function skipInlineImage(src: Uint8Array, pos: number): number {
  // Find the `ID` keyword first.
  let i = pos
  for (;;) {
    if (i >= src.length) return src.length
    if (src[i] === 0x49 && src[i + 1] === 0x44 && isWhitespace(src[i + 2] ?? 0x20)) {
      i += 2
      break
    }
    i += 1
  }
  // Then to `EI` delimited by whitespace.
  while (i < src.length) {
    if (src[i] === 0x45 && src[i + 1] === 0x49) {
      const before = i > 0 ? src[i - 1]! : 0x20
      const after = src[i + 2] ?? 0x20
      if (isWhitespace(before) && (isWhitespace(after) || isDelimiter(after))) return i + 2
    }
    i += 1
  }
  return src.length
}

/** Concatenate content chunks. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/**
 * Detect an encrypted PDF: `/Encrypt` appears in a classic `trailer` dict or
 * (incremental/xref-stream files) is referenced from a dictionary that also
 * carries `/Root`. Detected files are reported, never cracked.
 * @param bytes - the PDF file bytes.
 * @returns whether an /Encrypt reference was found.
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  // Fast path: classic `trailer << … /Encrypt n g R … >>`.
  for (let i = 0; i + 7 <= bytes.length; i += 1) {
    if (matchesWord(bytes, i, 'trailer')) {
      const dict = parseValueAt(bytes, i + 7, true)
      if (dict !== null && dict.value.t === 'dict' && dict.value.v['Encrypt'] !== undefined) return true
    }
  }
  // Fallback: raw `/Encrypt n g R` reference anywhere after the header.
  const text = latin1(bytes)
  return /\/Encrypt\s+\d+\s+\d+\s+R\b/.test(text) || /\/Encrypt<</.test(text)
}

/** One page leaf plus its inherited resources. */
interface PageEntry {
  dict: Record<string, PdfValue>
  resources: Record<string, PdfValue> | undefined
}

/** The parsed document: object resolution, page tree, forms, metadata. */
class PdfDocument {
  readonly objects: Map<number, PdfIndirectObject>
  readonly warnings: string[] = []
  private readonly fontCache = new Map<string, FontInfo>()
  private pagesCache: PageEntry[] | undefined
  private catalogCache: Record<string, PdfValue> | undefined

  constructor(private readonly bytes: Uint8Array) {
    this.objects = scanObjects(bytes)
  }

  /** Follow indirect references (bounded). */
  resolve(value: PdfValue, depth = 0): PdfValue {
    let current = value
    while (current.t === 'ref' && depth < 32) {
      const obj = this.objects.get(current.n)
      if (obj === undefined) return NULL_VALUE
      current = obj.value
      depth += 1
    }
    return current
  }

  /** Resolved dictionary entry. */
  entry(dict: Record<string, PdfValue>, key: string): PdfValue | undefined {
    const value = dict[key]
    return value === undefined ? undefined : this.resolve(value)
  }

  /** Decoded content bytes of a stream reference (filters applied). */
  streamOf(value: PdfValue): Uint8Array | undefined {
    const resolved = value.t === 'ref' ? this.objects.get(value.n) : undefined
    if (resolved === undefined || resolved.stream === undefined) return undefined
    if (resolved.value.t !== 'dict') return undefined
    const decoded = decodeStream(resolved.stream, resolved.value, this.warnings, `object ${resolved.num} stream`)
    return decoded === null ? undefined : decoded
  }

  /** The document catalog (first `/Type /Catalog` object). */
  catalog(): Record<string, PdfValue> | undefined {
    if (this.catalogCache !== undefined) return this.catalogCache
    for (const obj of this.objects.values()) {
      if (obj.value.t === 'dict') {
        const type = this.resolve(obj.value.v['Type'] ?? NULL_VALUE)
        if (type.t === 'name' && type.v === 'Catalog') {
          this.catalogCache = obj.value.v
          return this.catalogCache
        }
      }
    }
    return undefined
  }

  /** Flattened page leaves with inherited /Resources (plan §5.3.10 walk). */
  pageDicts(): PageEntry[] {
    if (this.pagesCache !== undefined) return this.pagesCache
    const pages: PageEntry[] = []
    const catalog = this.catalog()
    const rootNode = catalog === undefined ? undefined : catalog['Pages']
    const walk = (nodeValue: PdfValue | undefined, inherited: Record<string, PdfValue> | undefined, depth: number): void => {
      if (nodeValue === undefined || depth > 64) return
      const node = this.resolve(nodeValue)
      if (node.t !== 'dict') return
      const resources = this.resolve(node.v['Resources'] ?? NULL_VALUE)
      const own = resources.t === 'dict' ? resources.v : undefined
      const effective = own ?? inherited
      const kids = node.v['Kids']
      if (kids !== undefined && kids.t === 'arr') {
        for (const kid of kids.v) walk(kid, effective, depth + 1)
        return
      }
      pages.push({ dict: node.v, resources: effective })
    }
    walk(rootNode, undefined, 0)
    this.pagesCache = pages
    return pages
  }

  /** /Info metadata, decoded best-effort (trailer or xref-stream dictionary). */
  meta(): PdfMeta | undefined {
    let infoValue: PdfValue | undefined
    for (let i = 0; i + 7 <= this.bytes.length && infoValue === undefined; i += 1) {
      if (matchesWord(this.bytes, i, 'trailer')) {
        const dict = parseValueAt(this.bytes, i + 7, true)
        if (dict !== null && dict.value.t === 'dict' && dict.value.v['Info'] !== undefined) {
          infoValue = dict.value.v['Info']
        }
      }
    }
    if (infoValue === undefined) {
      for (const obj of this.objects.values()) {
        if (obj.value.t === 'dict' && obj.value.v['Root'] !== undefined && obj.value.v['Info'] !== undefined) {
          infoValue = obj.value.v['Info']
          break
        }
      }
    }
    if (infoValue === undefined) return undefined
    const info = this.resolve(infoValue)
    if (info.t !== 'dict') return undefined
    const read = (key: string): string | undefined => {
      const value = this.entry(info.v, key)
      if (value === undefined) return undefined
      if (value.t === 'str') return decodePdfTextString(value.v)
      if (value.t === 'name') return value.v
      if (value.t === 'num') return String(value.v)
      return undefined
    }
    const meta: PdfMeta = {
      title: read('Title'),
      author: read('Author'),
      subject: read('Subject'),
      producer: read('Producer'),
      creator: read('Creator'),
      creationDate: read('CreationDate'),
    }
    return meta
  }

  /** AcroForm field values (`/T` name → `/V` value), terminal fields only. */
  forms(): PdfFormField[] {
    const catalog = this.catalog()
    const acroForm = catalog === undefined ? undefined : this.entry(catalog, 'AcroForm')
    if (acroForm === undefined || acroForm.t !== 'dict') return []
    const fields = this.entry(acroForm.v, 'Fields')
    if (fields === undefined || fields.t !== 'arr') return []
    const out: PdfFormField[] = []
    const visit = (nodeValue: PdfValue, depth: number): void => {
      if (depth > 16) return
      const field = this.resolve(nodeValue)
      if (field.t !== 'dict') return
      const kids = this.entry(field.v, 'Kids')
      if (kids !== undefined && kids.t === 'arr' && kids.v.length > 0) {
        for (const kid of kids.v) visit(kid, depth + 1)
        return
      }
      const nameValue = this.entry(field.v, 'T')
      if (nameValue === undefined) return
      const name = nameValue.t === 'str' ? decodePdfTextString(nameValue.v) : nameValue.t === 'name' ? nameValue.v : ''
      if (name === '') return
      const rawValue = this.entry(field.v, 'V')
      let text = ''
      if (rawValue !== undefined) {
        if (rawValue.t === 'str') text = decodePdfTextString(rawValue.v)
        else if (rawValue.t === 'name') text = rawValue.v
        else if (rawValue.t === 'num') text = String(rawValue.v)
        else if (rawValue.t === 'arr') {
          text = rawValue.v
            .map(item => item.t === 'str' ? decodePdfTextString(item.v) : item.t === 'name' ? item.v : '')
            .filter(part => part !== '')
            .join(', ')
        }
      }
      out.push({ field: name, value: text })
    }
    for (const field of fields.v) visit(field, 0)
    return out
  }

  /** Font decoding state for one page resource name (cached per page+name). */
  fontFor(page: PageEntry, index: number, name: string): FontInfo | undefined {
    const fontDictValue = page.resources?.['Font']
    if (fontDictValue === undefined) return undefined
    const fontDict = this.resolve(fontDictValue)
    if (fontDict.t !== 'dict') return undefined
    const specific = this.resolve(fontDict.v[name] ?? NULL_VALUE)
    if (specific.t !== 'dict') return undefined
    const key = `${String(index)}:${name}`
    const cached = this.fontCache.get(key)
    if (cached !== undefined) return cached
    const font = buildFont(specific, name, value => this.streamOf(value))
    this.fontCache.set(key, font)
    return font
  }

  /** Decoded content streams of one page. */
  contentChunks(page: PageEntry, pageNum: number): Uint8Array[] {
    const raw = page.dict['Contents']
    if (raw === undefined) return []
    // Keep the un-resolved value: streams are only reachable through refs.
    const resolved = this.resolve(raw)
    const items = resolved.t === 'arr' ? resolved.v : [raw]
    const chunks: Uint8Array[] = []
    for (const item of items) {
      const obj = item.t === 'ref' ? this.objects.get(item.n) : undefined
      if (obj === undefined || obj.stream === undefined || obj.value.t !== 'dict') {
        this.warnings.push(`page ${String(pageNum)}: content stream missing or undecodable`)
        continue
      }
      const decoded = decodeStream(obj.stream, obj.value, this.warnings, `page ${String(pageNum)} content`)
      if (decoded !== null) chunks.push(decoded)
    }
    return chunks
  }

  /** Whether the page's resources reference at least one image XObject. */
  hasImageXObject(page: PageEntry): boolean {
    const xobjects = page.resources?.['XObject']
    if (xobjects === undefined) return false
    const dict = this.resolve(xobjects)
    if (dict.t !== 'dict') return false
    for (const value of Object.values(dict.v)) {
      const xobject = this.resolve(value)
      if (xobject.t !== 'dict') continue
      const subtype = this.resolve(xobject.v['Subtype'] ?? NULL_VALUE)
      if (subtype.t === 'name' && subtype.v === 'Image') return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Budgeted extraction
// ---------------------------------------------------------------------------

/**
 * Parse a page-list spec (`'3'`, `'1-5'`, `'3,7,9-12'`) into ascending pages.
 * @param spec - the caller's spec.
 * @param pageCount - total pages in the document.
 * @returns the requested page numbers.
 * @throws Error when a page is out of range or the syntax is invalid.
 */
function parsePageSpec(spec: string, pageCount: number): number[] {
  const out = new Set<number>()
  for (const partRaw of spec.split(',')) {
    const part = partRaw.trim()
    if (part === '') continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range !== null) {
      const lo = Number.parseInt(range[1]!, 10)
      const hi = Number.parseInt(range[2]!, 10)
      for (let p = lo; p <= hi; p += 1) {
        if (p < 1 || p > pageCount) throw new Error(`cdp: page ${String(p)} out of range (1-${String(pageCount)})`)
        out.add(p)
      }
      continue
    }
    if (/^\d+$/.test(part)) {
      const p = Number.parseInt(part, 10)
      if (p < 1 || p > pageCount) throw new Error(`cdp: page ${String(p)} out of range (1-${String(pageCount)})`)
      out.add(p)
      continue
    }
    throw new Error(`cdp: invalid pages spec: ${spec}`)
  }
  const pages = [...out].sort((a, b) => a - b)
  if (pages.length === 0) throw new Error(`cdp: invalid pages spec: ${spec}`)
  return pages
}

/** Locate a barcode-shaped token near the first `/barkod/i` label. */
function findBarcode(pageTexts: string[]): string | undefined {
  const joined = pageTexts.join('\n')
  const label = /barkod/i.exec(joined)
  if (label === null) return undefined
  const tail = joined.slice(label.index, label.index + 96)
  const token = /\b[A-Za-z0-9]{10,32}\b/.exec(tail)
  return token?.[0]
}

/**
 * Extract page-marked, budget-bounded text from a PDF buffer.
 *
 * Budget policy (plan §4.2): pages are appended whole while they fit; a page
 * that alone overruns the budget is cut at `maxChars` with `truncated:true`;
 * otherwise `nextPage = pageTo + 1` resumes without overlap. Encrypted and
 * non-PDF inputs are reported honestly instead of throwing garbage.
 * @param bytes - the PDF file bytes.
 * @param opts - window and budget options.
 * @returns the extraction result (see {@link ExtractPdfResult}).
 * @throws Error when the buffer is not a PDF at all.
 */
export function extractPdfText(bytes: Uint8Array, opts: ExtractPdfOptions = {}): ExtractPdfResult {
  if (!isPdf(bytes)) {
    throw new Error('cdp: not a PDF: the %PDF- header is missing')
  }
  const requestedPage = opts.page
  const basePageFrom = Math.max(1, requestedPage ?? opts.pageFrom ?? 1)

  if (isEncryptedPdf(bytes)) {
    return {
      pageCount: 0,
      encrypted: true,
      passwordRequired: true,
      textLayer: 'unknown',
      pagesWithText: 0,
      pageFrom: basePageFrom,
      pageTo: 0,
      hasMore: false,
      chars: 0,
      truncated: false,
      pages: [],
      warnings: ['encrypted PDF — password required'],
    }
  }

  const doc = new PdfDocument(bytes)
  const warnings = doc.warnings
  const entries = doc.pageDicts()
  const pageCount = entries.length

  const allPages: ExtractedPdfPage[] = []
  let pagesWithText = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const pageNum = index + 1
    const chunks = doc.contentChunks(entry, pageNum)
    const walk = walkContent(chunks, name => doc.fontFor(entry, index, name), warnings)
    const image = doc.hasImageXObject(entry)
    let kind: ExtractedPdfPage['kind']
    if (walk.text !== '') {
      kind = 'text'
      pagesWithText += 1
    } else if (image || walk.hasInlineImage) {
      kind = 'image'
      warnings.push(`page ${String(pageNum)}: no text layer (image-only)`)
    } else if (walk.hasVectorOps) {
      kind = 'vector'
      warnings.push(`page ${String(pageNum)}: no text layer (no text-showing operators)`)
    } else {
      kind = 'empty'
      warnings.push(`page ${String(pageNum)}: no text-showing operators`)
    }
    allPages.push({ page: pageNum, text: walk.text, kind })
  }

  const textLayer: ExtractPdfResult['textLayer'] = pageCount === 0
    ? 'absent'
    : pagesWithText === pageCount ? 'present' : pagesWithText === 0 ? 'absent' : 'mixed'

  // Which pages this call reads.
  let requested: number[]
  if (requestedPage !== undefined) {
    if (requestedPage < 1 || requestedPage > pageCount) {
      throw new Error(`cdp: page ${String(requestedPage)} out of range (1-${String(pageCount)})`)
    }
    requested = [requestedPage]
  } else if (opts.pages !== undefined) {
    requested = parsePageSpec(opts.pages, pageCount)
  } else {
    requested = []
    for (let p = basePageFrom; p <= pageCount; p += 1) requested.push(p)
  }

  const maxChars = Math.min(
    MAX_PDF_MAX_CHARS,
    Math.max(1, opts.maxChars ?? (requestedPage !== undefined ? MAX_PDF_MAX_CHARS : DEFAULT_PDF_MAX_CHARS)),
  )

  const outPages: ExtractedPdfPage[] = []
  let chars = 0
  let truncated = false
  let cutInside = false
  let pageTo = Math.max(0, basePageFrom - 1)
  for (let idx = 0; idx < requested.length; idx += 1) {
    const pageNum = requested[idx]!
    const page = allPages[pageNum - 1]!
    if (chars + page.text.length <= maxChars) {
      outPages.push(page)
      chars += page.text.length
      pageTo = pageNum
      continue
    }
    if (chars === 0) {
      // The page alone overruns the budget: cut at maxChars with a cursor.
      outPages.push({ ...page, text: page.text.slice(0, maxChars) })
      chars = maxChars
      pageTo = pageNum
      truncated = true
      cutInside = true
    }
    break // stop between pages: the rest resumes at pageTo + 1
  }
  if (outPages.length > 0) pageTo = outPages[outPages.length - 1]!.page
  // hasMore: a cut inside pageTo, an unread requested page, or document pages
  // beyond the window (plan §4.2: true when there are pages beyond pageTo).
  const hasMore = cutInside || outPages.length < requested.length || pageTo < pageCount
  const nextPage = hasMore ? pageTo + 1 : undefined

  const meta = opts.includeMeta === false ? undefined : doc.meta()
  const forms = doc.forms()
  const barcode = findBarcode(allPages.map(page => page.text))

  const result: ExtractPdfResult = {
    pageCount,
    encrypted: false,
    passwordRequired: false,
    textLayer,
    pagesWithText,
    pageFrom: requested[0] ?? basePageFrom,
    pageTo,
    nextPage,
    hasMore,
    chars,
    truncated,
    pages: outPages,
    warnings,
    meta,
    forms: forms.length > 0 ? forms : undefined,
    barcode,
  }
  return result
}

// ---------------------------------------------------------------------------
// Print-to-PDF reply
// ---------------------------------------------------------------------------

/**
 * Validate a `Page.printToPDF` reply and decode its base64 payload.
 * @param reply - the raw CDP reply object.
 * @returns the decoded PDF bytes.
 * @throws Error when the reply carries no usable `data` field.
 */
export function parsePrintToPdfReply(reply: unknown): Buffer {
  const record = (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>
  const data = record['data']
  if (typeof data !== 'string' || data === '') {
    throw new Error('cdp: printToPDF: the reply carried no data field')
  }
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) {
    throw new Error('cdp: printToPDF: decoded zero bytes')
  }
  if (!isPdf(buffer)) {
    throw new Error('cdp: printToPDF: decoded payload is not a PDF')
  }
  return buffer
}

// ---------------------------------------------------------------------------
// Viewer strategies (cdp_pdftotext)
// ---------------------------------------------------------------------------

/** Extraction strategies for a page that shows a PDF, in auto order. */
export type ViewerStrategy = 'network' | 'print' | 'axtree'

/**
 * @param pin - optional strategy pin from tool input.
 * @returns the ordered strategies to attempt.
 * @throws Error on an unknown strategy name.
 */
export function planViewerStrategies(pin?: string | undefined): ViewerStrategy[] {
  if (pin === undefined || pin === 'auto') return ['network', 'print', 'axtree']
  if (pin === 'network' || pin === 'print' || pin === 'axtree') return [pin]
  throw new Error(`cdp: pdftotext: unknown strategy: ${pin}`)
}

/**
 * Classify a fetched body before any parsing is attempted.
 * @param bytes - response body bytes.
 * @returns `pdf`, `html` (the 401/login trap), `empty`, or `other`.
 */
export function classifyPdfPayload(bytes: Uint8Array): 'pdf' | 'html' | 'empty' | 'other' {
  if (bytes.length === 0) return 'empty'
  if (isPdf(bytes)) return 'pdf'
  const head = latin1(bytes.subarray(0, 256)).trimStart().toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head')) return 'html'
  if (head.startsWith('<?xml') && head.includes('<html')) return 'html'
  return 'other'
}

/** One cookie as `Network.getAllCookies` reports it. */
export interface ViewerCookie {
  name: string
  value: string
  domain?: string | undefined
  path?: string | undefined
}

/**
 * Build a `Cookie:` header value for one URL from a cookie jar (the model
 * never sees cookie values: they are passed to the request, not echoed).
 * @param cookies - the browser's cookies.
 * @param url - the request URL.
 * @returns the joined `name=value; …` header, empty when nothing matches.
 */
export function buildCookieHeader(cookies: ViewerCookie[], url: string): string {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return ''
  }
  const matches = cookies.filter((cookie) => {
    const domain = (cookie.domain ?? '').replace(/^\./, '')
    if (domain !== '') {
      const host = target.hostname
      if (host !== domain && !host.endsWith(`.${domain}`)) return false
    }
    const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
    return target.pathname.startsWith(path) || path === '/'
  })
  return matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

/** One node of an `Accessibility.getFullAXTree` reply. */
export interface AxNode {
  role?: string | undefined
  name?: string | undefined
  value?: string | undefined
}

/**
 * Flatten a PDFium accessibility tree into text: StaticText nodes joined by
 * newline, with a name-based fallback for shallow trees.
 * @param nodes - the reply's nodes.
 * @returns the flattened text ('' when the tree carries none).
 */
export function flattenAxTree(nodes: AxNode[]): string {
  const usable = nodes.filter(node => typeof node.name === 'string' && node.name.trim() !== '')
  const statics = usable.filter(node => node.role === 'StaticText')
  const source = statics.length > 0 ? statics : usable
  return source.map(node => node.name ?? '').join('\n')
}

/** Everything the strategy engine needs from the surrounding service. */
export interface ViewerContext {
  /** The tab's current URL (outer frame). */
  pageUrl(): Promise<string>
  /** Fetch implementation (injectable for tests). */
  readonly fetchImpl: typeof globalThis.fetch
  /** The browser's full cookie jar for the network strategy. */
  getAllCookies(): Promise<ViewerCookie[]>
  /** Browser-level target list (PDF viewer guest discovery). */
  targets(): Promise<Array<{ targetId: string; type: string; title: string; url: string }>>
  /** Attach to a target; returns its session id. */
  attach(targetId: string): Promise<string>
  /** Session-scoped CDP send. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  /** Produce a print-round-trip PDF already written inside the root. */
  printToPdfFile(): Promise<{ path: string; data: Buffer; pageCount: number }>
  /** Persist fetched PDF bytes inside the downloads root; returns the path. */
  savePdf(suggestedName: string, bytes: Uint8Array): Promise<string>
}

/** Options for {@link extractFromViewer}. */
export interface ViewerExtractOptions {
  strategy?: string | undefined
  maxChars?: number | undefined
  page?: number | undefined
  pageFrom?: number | undefined
  timeoutMs?: number | undefined
}

/** Result of one successful viewer extraction. */
export interface ViewerExtractOutcome {
  url: string
  strategy: ViewerStrategy
  strategyDetail: string
  chars: number
  truncated: boolean
  nextPage?: number | undefined
  pageCount?: number | undefined
  textLayer?: string | undefined
  pages?: ExtractedPdfPage[] | undefined
  text?: string | undefined
  warnings: string[]
}

/** Message of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Race a strategy against its wall-clock budget. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Suggest a safe basename from one URL path. */
function suggestedNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const raw = parsed.pathname.split('/').filter(part => part !== '').pop() ?? ''
    const decoded = decodeURIComponent(raw)
    if (decoded !== '' && decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\') && !decoded.startsWith('.')) {
      return decoded
    }
  } catch { /* fall through */ }
  return 'fetched.pdf'
}

/** Strategy A: direct fetch with the browser's cookies. */
async function networkStrategy(ctx: ViewerContext, opts: ViewerExtractOptions): Promise<ViewerExtractOutcome> {
  const url = await ctx.pageUrl()
  if (url.startsWith('blob:')) throw new Error('blob: URL — network strategy unavailable')
  if (!/^https?:\/\//i.test(url)) throw new Error(`page URL is not http(s): ${url}`)
  const cookies = await ctx.getAllCookies()
  const cookieHeader = buildCookieHeader(cookies, url)
  const res = await ctx.fetchImpl(url, {
    redirect: 'follow',
    headers: {
      accept: 'application/pdf,*/*q=0.8',
      ...(cookieHeader === '' ? {} : { cookie: cookieHeader }),
    },
  })
  const body = new Uint8Array(await res.arrayBuffer())
  const kind = classifyPdfPayload(body)
  if (kind === 'empty') throw new Error(`empty body (0 bytes) from ${url} (HTTP ${String(res.status)})`)
  if (kind === 'html') throw new Error(`URL returned HTML, not PDF (auth expired?); HTTP ${String(res.status)}`)
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} from ${url}`)
  if (kind !== 'pdf') throw new Error(`response is not a PDF (HTTP ${String(res.status)})`)
  const path = await ctx.savePdf(suggestedNameFromUrl(url), body)
  const extracted = extractPdfText(body, {
    pageFrom: opts.pageFrom,
    maxChars: opts.maxChars,
    page: opts.page,
  })
  return {
    url,
    strategy: 'network',
    strategyDetail: `Network.getAllCookies + direct fetch (${String(body.length)} bytes, ${path})`,
    chars: extracted.chars,
    truncated: extracted.truncated,
    nextPage: extracted.nextPage,
    pageCount: extracted.pageCount,
    textLayer: extracted.textLayer,
    pages: extracted.pages,
    warnings: extracted.warnings,
  }
}

/** Strategy B: `Page.printToPDF` round trip. */
async function printStrategy(ctx: ViewerContext, opts: ViewerExtractOptions): Promise<ViewerExtractOutcome> {
  const printed = await ctx.printToPdfFile()
  const extracted = extractPdfText(printed.data, {
    pageFrom: opts.pageFrom,
    maxChars: opts.maxChars,
    page: opts.page,
  })
  return {
    url: await ctx.pageUrl(),
    strategy: 'print',
    strategyDetail: `Page.printToPDF round-trip (${String(printed.data.length)} bytes, ${printed.path})`,
    chars: extracted.chars,
    truncated: extracted.truncated,
    nextPage: extracted.nextPage,
    pageCount: extracted.pageCount,
    textLayer: extracted.textLayer,
    pages: extracted.pages,
    warnings: [
      ...extracted.warnings,
      're-print: page numbers may differ from the viewer, forms lost (Page.printToPDF)',
    ],
  }
}

/** Strategy C: flatten the PDF viewer guest's accessibility tree. */
async function axtreeStrategy(ctx: ViewerContext, opts: ViewerExtractOptions): Promise<ViewerExtractOutcome> {
  const targets = await ctx.targets()
  const guest = targets.find(target => target.type === 'page' && target.url.startsWith('chrome-extension://'))
  if (guest === undefined) throw new Error('no PDF viewer guest target (chrome-extension://...)')
  const sessionId = await ctx.attach(guest.targetId)
  const reply = await ctx.send('Accessibility.getFullAXTree', {}, sessionId) as { nodes?: unknown }
  const nodes: AxNode[] = Array.isArray(reply.nodes)
    ? reply.nodes.filter((node): node is AxNode => typeof node === 'object' && node !== null)
    : []
  const text = flattenAxTree(nodes)
  if (text.trim() === '') throw new Error('empty accessibility tree')
  void opts
  return {
    url: guest.url,
    strategy: 'axtree',
    strategyDetail: `Accessibility.getFullAXTree of PDFium guest ${guest.targetId}`,
    chars: text.length,
    truncated: false,
    text,
    warnings: ['viewer-AX extraction: no page markers, may lack reading order'],
  }
}

/**
 * Run the viewer extraction strategies in order until one succeeds.
 * @param ctx - the surrounding service's viewer context.
 * @param opts - strategy pin, budget, and timeout.
 * @returns the first strategy's outcome.
 * @throws Error `cdp: pdftotext: all strategies failed (…)` when none works.
 */
export async function extractFromViewer(ctx: ViewerContext, opts: ViewerExtractOptions = {}): Promise<ViewerExtractOutcome> {
  const strategies = planViewerStrategies(opts.strategy)
  const timeoutMs = opts.timeoutMs ?? 20_000
  const attempts: string[] = []
  for (const strategy of strategies) {
    try {
      const work = strategy === 'network'
        ? networkStrategy(ctx, opts)
        : strategy === 'print' ? printStrategy(ctx, opts) : axtreeStrategy(ctx, opts)
      return await withTimeout(work, timeoutMs, `${strategy} strategy`)
    } catch (error) {
      attempts.push(`${strategy}: ${messageOf(error)}`)
    }
  }
  throw new Error(`cdp: pdftotext: all strategies failed (${attempts.join('; ')})`)
}
