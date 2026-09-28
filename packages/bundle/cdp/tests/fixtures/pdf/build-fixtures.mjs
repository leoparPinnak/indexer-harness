/**
 * Fixture generator for the Plan 10 PDF extractor tests (plan §8.2).
 *
 * Plain Node, no dependencies: literal PDFs are assembled byte-by-byte and
 * written next to this script. Run with `node build-fixtures.mjs`. The
 * fixtures are committed; re-run only when the spec's expectations change.
 *
 * Fixture matrix (plan §6 F1): hello, flate-eol, turkish-cp1254,
 * cid-tounicode, multipage-10, scanned, forms, encrypted, malformed-xref,
 * not-a-pdf, oversize-page, barcode.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(here, { recursive: true })

/** Reverse CP1254 table for writing Turkish bytes. */
const cp1254Decoder = new TextDecoder('windows-1254')
const cp1254 = new Map()
for (let b = 0; b < 256; b += 1) cp1254.set(cp1254Decoder.decode(Uint8Array.of(b)), b)

function encodeCp1254(text) {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const byte = cp1254.get(text[i])
    if (byte === undefined) throw new Error(`character ${text[i]} is not CP1254-representable`)
    out[i] = byte
  }
  return out
}

/** Escape a Latin-1/CP1254 byte sequence for a PDF literal string. */
function literalString(bytes) {
  const parts = []
  for (const byte of bytes) {
    if (byte === 0x5c || byte === 0x28 || byte === 0x29) parts.push(`\\${String.fromCharCode(byte)}`)
    else if (byte === 0x0a) parts.push('\\n')
    else if (byte === 0x0d) parts.push('\\r')
    else parts.push(String.fromCharCode(byte))
  }
  return `(${parts.join('')})`
}

const latin1Bytes = (text) => Buffer.from(text, 'latin1')

class Builder {
  constructor() {
    this.bodies = []
  }

  add(body) {
    this.bodies.push(body)
    return this.bodies.length
  }

  /** Stream object body: dict entries (without /Length), raw data bytes. */
  static stream(dictEntries, data, { lengthIncludesEol = false } = {}) {
    return {
      stream: { dictEntries, data, lengthIncludesEol },
    }
  }

  /**
   * @param opts.catalog - catalog object number.
   * @param opts.trailerExtra - extra trailer dict entries (/Info, /Encrypt…).
   * @param opts.malformedXref - write wrong xref offsets on purpose.
   */
  build(opts) {
    const header = '%PDF-1.7\n%âãÏÓ\n'
    const chunks = [header]
    const offsets = []
    let pos = Buffer.byteLength(header, 'latin1')
    this.bodies.forEach((body, index) => {
      const num = index + 1
      offsets[num] = opts.malformedXref ? 1 : pos
      let text
      if (body !== null && body.stream !== undefined) {
        const { dictEntries, data, lengthIncludesEol } = body.stream
        const eol = lengthIncludesEol ? '\r\n' : ''
        const length = data.length + (lengthIncludesEol ? eol.length : 0)
        text = `<< ${dictEntries} /Length ${length} >>\nstream\n${data.toString('latin1')}${lengthIncludesEol ? '' : '\n'}${lengthIncludesEol ? '\r\n' : ''}endstream`
        if (!lengthIncludesEol) {
          // data already followed by \n above; keep Length exact
          text = `<< ${dictEntries} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`
        }
      } else {
        text = body
      }
      const objectText = `${num} 0 obj\n${text}\nendobj\n`
      chunks.push(objectText)
      pos += Buffer.byteLength(objectText, 'latin1')
    })

    const xrefPos = pos
    const count = this.bodies.length + 1
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let num = 1; num <= this.bodies.length; num += 1) {
      xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`
    }
    const trailer = `trailer\n<< /Size ${count} /Root ${opts.catalog} 0 R${opts.trailerExtra ?? ''} >>\nstartxref\n${xrefPos}\n%%EOF\n`
    chunks.push(xref, trailer)
    return Buffer.from(chunks.join(''), 'latin1')
  }
}

/** Standard page skeleton: catalog(1) + pages(2) are created by the caller. */
function addPage(builder, { resources, contentsNum, mediabox = '[0 0 612 792]' }) {
  return builder.add(
    `<< /Type /Page /Parent 2 0 R /MediaBox ${mediabox} /Resources ${resources} /Contents ${contentsNum} 0 R >>`,
  )
}

/**
 * Splice the real page numbers into the object-2 Pages placeholder (the page
 * object number is only known after its content stream exists).
 */
function setPages(builder, pageNumbers) {
  builder.bodies[1] =
    `<< /Type /Pages /Kids [${pageNumbers.map(num => `${num} 0 R`).join(' ')}] /Count ${pageNumbers.length} >>`
}

function contentStream(builder, text, { compress = false, lengthIncludesEol = false } = {}) {
  const bytes = latin1Bytes(text)
  if (!compress) return builder.add(Builder.stream('', bytes, { lengthIncludesEol }))
  const deflated = deflateSync(bytes)
  return builder.add(Builder.stream('/Filter /FlateDecode', deflated, { lengthIncludesEol }))
}

// --- hello.pdf -------------------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('') // Pages placeholder, spliced by setPages
  const contents = contentStream(b, 'BT /F1 12 Tf 72 720 Td (Hello, CDP world!) Tj ET')
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 5 0 R >> >>', contentsNum: contents })])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  writeFileSync(join(here, 'hello.pdf'), b.build({ catalog: 1 }))
}

// --- flate-eol.pdf: /Length includes the trailing \r\n before endstream ----
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const contents = contentStream(b, 'BT /F1 11 Tf 60 700 Td (Flate stream OK!) Tj ET', {
    compress: true,
    lengthIncludesEol: true,
  })
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 5 0 R >> >>', contentsNum: contents })])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  writeFileSync(join(here, 'flate-eol.pdf'), b.build({ catalog: 1 }))
}

// --- turkish-cp1254.pdf: WinAnsi-labelled font, CP1254-encoded bytes -------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const line1 = 'SOSYAL GÜVENLİK KURUMU BAŞKANLIĞI'
  const line2 = 'GÜVENLİK ve BAŞKANLIĞI yazıları'
  const content = `BT /F1 14 Tf 40 740 Td ${literalString(encodeCp1254(line1))} Tj T* ${literalString(encodeCp1254(line2))} Tj ET`
  const contents = contentStream(b, content)
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 5 0 R >> >>', contentsNum: contents })])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  writeFileSync(join(here, 'turkish-cp1254.pdf'), b.build({ catalog: 1 }))
}

// --- cid-tounicode.pdf: Type0 + Identity-H + ToUnicode CMap ----------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('') // Pages placeholder, spliced by setPages
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <00FF>',
    'endcodespacerange',
    '12 beginbfchar',
    '<0001> <004D>',
    '<0002> <0065>',
    '<0003> <0072>',
    '<0004> <0068>',
    '<0005> <0061>',
    '<0006> <0062>',
    '<0007> <0061>',
    '<0008> <0020>',
    '<0009> <0043>',
    '<000A> <0049>',
    '<000B> <0044>',
    '<000C> <0021>',
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
    '',
  ].join('\n')
  const cmapNum = b.add(Builder.stream('', latin1Bytes(cmap)))   // object 3
  const codes = '000100020003000400050006000700080009000A000B000C'
  const contents = contentStream(b, `BT /F1 14 Tf 60 700 Td <${codes}> Tj ET`)   // 4
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 6 0 R >> >>', contentsNum: contents })]) // 5
  b.add(`<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+TestCID /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode ${cmapNum} 0 R >>`) // 6
  b.add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+TestCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>') // 7
  writeFileSync(join(here, 'cid-tounicode.pdf'), b.build({ catalog: 1 }))
}

// --- multipage-10.pdf ------------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')            // 1
  b.add('')                                             // 2 placeholder (Pages, spliced below)
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') // 3
  const contentsNums = []
  for (let n = 1; n <= 10; n += 1) {
    contentsNums.push(contentStream(b, `BT /F1 10 Tf 50 740 Td (Page ${n} of ten - text line ${n}) Tj ET`)) // 4..13
  }
  const pageNumbers = []
  for (let n = 1; n <= 10; n += 1) {
    pageNumbers.push(addPage(b, { resources: '<< /Font << /F1 3 0 R >> >>', contentsNum: contentsNums[n - 1] })) // 14..23
  }
  b.bodies[1] = `<< /Type /Pages /Kids [${pageNumbers.map(num => `${num} 0 R`).join(' ')}] /Count 10 >>`
  writeFileSync(join(here, 'multipage-10.pdf'), b.build({ catalog: 1 }))
}

// --- scanned.pdf -----------------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const image = Buffer.from([0x80])
  const imageNum = b.add(Builder.stream(
    '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
    image,
  ))
  const contents = contentStream(b, `q 500 0 0 500 50 50 cm /Im${imageNum} Do Q`)
  const pageNum = b.add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im${imageNum} ${imageNum} 0 R >> >> /Contents ${contents} 0 R >>`)
  setPages(b, [pageNum])
  writeFileSync(join(here, 'scanned.pdf'), b.build({ catalog: 1 }))
}

// --- forms.pdf -------------------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>')
  b.add('')
  const contents = contentStream(b, 'BT /F1 10 Tf 50 740 Td (Form document) Tj ET')
  const pageNum = b.add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ' + contents + ' 0 R >>')
  setPages(b, [pageNum])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  b.add('<< /Fields [7 0 R 8 0 R] >>')
  b.add('<< /Type /Annot /Subtype /Widget /T (Full Name) /V (Metin Yilmaz) >>')
  b.add('<< /Type /Annot /Subtype /Widget /T (Application No) /V (50152094938) >>')
  writeFileSync(join(here, 'forms.pdf'), b.build({ catalog: 1 }))
}

// --- encrypted.pdf ---------------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const contents = contentStream(b, 'BT /F1 10 Tf 50 740 Td (this body is encrypted) Tj ET')
  const pageNum = b.add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ' + contents + ' 0 R >>')
  setPages(b, [pageNum])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  b.add('<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00000000000000000000000000000000> /U <00000000000000000000000000000000> >>')
  writeFileSync(join(here, 'encrypted.pdf'), b.build({ catalog: 1, trailerExtra: ' /Encrypt 6 0 R' }))
}

// --- malformed-xref.pdf ----------------------------------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const contents = contentStream(b, 'BT /F1 10 Tf 50 740 Td (Malformed xref still parses) Tj ET')
  const pageNum = b.add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ' + contents + ' 0 R >>')
  setPages(b, [pageNum])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  writeFileSync(join(here, 'malformed-xref.pdf'), b.build({ catalog: 1, malformedXref: true }))
}

// --- not-a-pdf.pdf (also the classify 'html' fixture) ----------------------
{
  writeFileSync(
    join(here, 'not-a-pdf.pdf'),
    Buffer.from('<html><head><title>401 Unauthorized</title></head><body>401 Unauthorized</body></html>', 'latin1'),
  )
}

// --- oversize-page.pdf: one page whose text alone exceeds a small budget ----
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const lines = []
  for (let n = 0; n < 240; n += 1) {
    lines.push(`(${String(n).padStart(3, '0')}: repetitive body line for the oversize budget test) Tj T*`)
  }
  const contents = contentStream(b, `BT /F1 9 Tf 12 TL 40 760 Td ${lines.join(' ')} ET`)
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 5 0 R >> >>', contentsNum: contents })])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  writeFileSync(join(here, 'oversize-page.pdf'), b.build({ catalog: 1 }))
}

// --- barcode.pdf: barkod label + 11-digit token ----------------------------
{
  const b = new Builder()
  b.add('<< /Type /Catalog /Pages 2 0 R >>')
  b.add('')
  const contents = contentStream(b, 'BT /F1 11 Tf 50 740 Td (Barkod No: 50152094938) Tj ET')
  setPages(b, [addPage(b, { resources: '<< /Font << /F1 5 0 R >> >>', contentsNum: contents })])
  b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  writeFileSync(join(here, 'barcode.pdf'), b.build({ catalog: 1 }))
}

console.log('fixtures written to', here)
