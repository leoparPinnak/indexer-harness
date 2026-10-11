/**
 * Hashline core, pure surface: format roundtrip, header-hash refusal, unique-match
 * guarantees, empty-hunk and malformed-input rejection, CRLF/BOM normalization,
 * display-prefix stripping, and byte verification. No filesystem access here — the
 * compare-and-swap and read-back seam lives in `run.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  applyHashlinePatch,
  hashlineFileHash,
  hashlineFormatHeader,
  hashlineFormatNumberedLines,
  hashlineStripPrefixes,
  isHashlinePatch,
  normalizeHashlineText,
  parseHashlinePatch,
  verifyPatchedBytes,
} from '../../src/index.ts'

const FILE = 'export function main() {\n  run()\n}\n\nexport const version = 1'

/** Build a patch source whose header carries the hash of `content`. */
function patchFor(path: string, content: string, ...body: string[]): string {
  return `${hashlineFormatHeader(path, hashlineFileHash(content))}\n${body.join('\n')}`
}

/** Capture the thrown value of a synchronous expectation, or undefined when nothing throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  return undefined
}

describe('format roundtrip', () => {
  it('formats numbered context lines and parses them back verbatim', () => {
    expect(hashlineFormatNumberedLines(7, ['alpha', '', '  indented'])).toEqual([
      ' 7| alpha',
      ' 8| ',
      ' 9|   indented',
    ])

    const source = patchFor(
      'src/app.ts',
      FILE,
      '@@ 1',
      ...hashlineFormatNumberedLines(1, ['export function main() {', '  run()']),
      '-3| }',
      '+} // end',
      ...hashlineFormatNumberedLines(4, ['', 'export const version = 1']),
    )
    expect(isHashlinePatch(source)).toBe(true)

    const patch = parseHashlinePatch(source)
    expect(patch.path).toBe('src/app.ts')
    expect(patch.fileHash).toBe(hashlineFileHash(FILE))
    expect(patch.hunks).toHaveLength(1)
    const hunk = patch.hunks[0]
    expect(hunk?.startLine).toBe(1)
    expect(hunk?.lines).toEqual([
      { kind: 'context', line: 1, text: 'export function main() {' },
      { kind: 'context', line: 2, text: '  run()' },
      { kind: 'delete', line: 3, text: '}' },
      { kind: 'insert', text: '} // end' },
      { kind: 'context', line: 4, text: '' },
      { kind: 'context', line: 5, text: 'export const version = 1' },
    ])

    expect(applyHashlinePatch(FILE, patch)).toEqual({
      content: 'export function main() {\n  run()\n} // end\n\nexport const version = 1',
      replacements: 1,
    })
  })

  it('applies several hunks in one pass, ordered by position', () => {
    const content = 'alpha\nbeta\ngamma'
    const patch = parseHashlinePatch(patchFor(
      'ordered.txt',
      content,
      '@@ 3',
      '-3| gamma',
      '+GAMMA',
      '@@ 1',
      '-1| alpha',
      '+ALPHA',
    ))
    expect(applyHashlinePatch(content, patch)).toEqual({
      content: 'ALPHA\nbeta\nGAMMA',
      replacements: 2,
    })
  })

  it('keeps a literal line that merely looks like a display prefix', () => {
    const content = '12| literal\nnext'
    const patch = parseHashlinePatch(patchFor(
      'literal.txt',
      content,
      '@@ 1',
      ' 1| 12| literal',
      '-2| next',
      '+done',
    ))
    expect(applyHashlinePatch(content, patch).content).toBe('12| literal\ndone')
  })
})

describe('hash verification', () => {
  it('refuses a patch whose header hash is not the file hash', () => {
    const source = patchFor(
      'src/app.ts',
      'a completely different file',
      '@@ 1',
      '-1| export function main() {',
      '+replaced',
    )
    const error = thrownBy(() => applyHashlinePatch(FILE, parseHashlinePatch(source)))
    expect(error).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(error).toMatchObject({ message: expect.stringContaining('changed since it was read') })
    expect(error).toMatchObject({ message: expect.stringContaining('Re-read the file and try again') })
  })
})

describe('match uniqueness', () => {
  const DUPLICATE = 'value\nvalue'

  it('reports a context block that does not exist at all', () => {
    const source = patchFor('dup.txt', DUPLICATE, '@@ 1', '-1| ghost', '+x')
    const error = thrownBy(() => applyHashlinePatch(DUPLICATE, parseHashlinePatch(source)))
    expect(error).toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('applies at the line the numbered evidence names when the block repeats', () => {
    const first = parseHashlinePatch(patchFor('dup.txt', DUPLICATE, '@@ 1', '-1| value', '+A'))
    expect(applyHashlinePatch(DUPLICATE, first)).toEqual({ content: 'A\nvalue', replacements: 1 })
    const second = parseHashlinePatch(patchFor('dup.txt', DUPLICATE, '@@ 2', '-2| value', '+B'))
    expect(applyHashlinePatch(DUPLICATE, second)).toEqual({ content: 'value\nB', replacements: 1 })
  })

  it('reports ambiguity when the block repeats and the line evidence cannot pick one', () => {
    const source = patchFor('dup.txt', DUPLICATE, '@@ 9', '-9| value', '+A')
    const error = thrownBy(() => applyHashlinePatch(DUPLICATE, parseHashlinePatch(source)))
    expect(error).toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect(error).toMatchObject({ message: expect.stringContaining('lines [1, 2]') })
    expect(error).toMatchObject({ message: expect.stringContaining('Please ensure it is unique') })
  })

  it('ignores a occurrence that is not line-aligned', () => {
    const content = 'xxrun()\nrun()'
    const patch = parseHashlinePatch(patchFor('aligned.txt', content, '@@ 2', '-2| run()', '+RAN'))
    expect(applyHashlinePatch(content, patch)).toEqual({ content: 'xxrun()\nRAN', replacements: 1 })
  })

  it('rejects hunks whose located ranges overlap', () => {
    const content = 'alpha\nbeta'
    const source = patchFor('overlap.txt', content, '@@ 1', '-1| alpha', '+A', '@@ 1', '-1| alpha', '+B')
    const error = thrownBy(() => applyHashlinePatch(content, parseHashlinePatch(source)))
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: expect.stringContaining('hunks overlap') })
  })
})

describe('insert-only hunks', () => {
  const CONTENT = 'one\ntwo'

  it('anchors before the declared line and after the last line', () => {
    const head = parseHashlinePatch(patchFor('anchor.txt', CONTENT, '@@ 1', '+zero'))
    expect(applyHashlinePatch(CONTENT, head).content).toBe('zero\none\ntwo')

    const tail = parseHashlinePatch(patchFor('anchor.txt', CONTENT, '@@ 3', '+three'))
    expect(applyHashlinePatch(CONTENT, tail).content).toBe('one\ntwo\nthree')

    const separated = parseHashlinePatch(patchFor('anchor.txt', 'one\ntwo\n', '@@ 3', '+three'))
    expect(applyHashlinePatch('one\ntwo\n', separated).content).toBe('one\ntwo\nthree')
  })

  it('rejects an anchor line the file does not have', () => {
    const source = patchFor('anchor.txt', CONTENT, '@@ 9', '+nowhere')
    const error = thrownBy(() => applyHashlinePatch(CONTENT, parseHashlinePatch(source)))
    expect(error).toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(error).toMatchObject({ message: expect.stringContaining('anchors at line 9, but the file has 2 lines') })
  })
})

describe('patch shape', () => {
  it('rejects a hunk with no -/+ lines', () => {
    const source = patchFor('src/app.ts', FILE, '@@ 1', ' 1| export function main() {')
    expect(() => parseHashlinePatch(source)).toThrow(/hunk at line 1 has no/)
  })

  it('rejects a patch with no hunk at all', () => {
    expect(() => parseHashlinePatch(patchFor('src/app.ts', FILE))).toThrow(/carries no/)
  })

  it('rejects a missing or malformed header', () => {
    expect(() => parseHashlinePatch('@@ 1\n-1| x\n+y')).toThrow(/file header/)
    expect(() => parseHashlinePatch('src/app.ts:short\n@@ 1\n-1| x\n+y')).toThrow(/file header/)
  })

  it('rejects body lines before the first hunk', () => {
    const source = patchFor('src/app.ts', FILE, '-1| export function main() {', '+x')
    expect(() => parseHashlinePatch(source)).toThrow(/before any/)
  })

  it('rejects a line with no marker and a numbered line with no evidence', () => {
    expect(() => parseHashlinePatch(patchFor('src/app.ts', FILE, '@@ 1', '*** End Patch')))
      .toThrow(/must be a `@@ <line>` opener/)
    expect(() => parseHashlinePatch(patchFor('src/app.ts', FILE, '@@ 1', '-| no number')))
      .toThrow(/must be a `@@ <line>` opener/)
    expect(() => parseHashlinePatch(patchFor('src/app.ts', FILE, '@@ 1', ' plain text')))
      .toThrow(/must be a `@@ <line>` opener/)
  })

  it('recognises only header-plus-hunk input as hashline', () => {
    expect(isHashlinePatch('plain old string')).toBe(false)
    expect(isHashlinePatch('x:0123456789abcdef')).toBe(false)
    expect(isHashlinePatch('x:0123456789abcdef\n@@ 1\n-1| a\n+b')).toBe(true)
  })
})

describe('normalization', () => {
  it('folds CRLF and a leading BOM into the hashed and matched form', () => {
    expect(hashlineFileHash('\uFEFFone\r\ntwo\r\n')).toBe(hashlineFileHash('one\ntwo\n'))
    expect(normalizeHashlineText('\uFEFFa\rb')).toBe('a\nb')

    const content = 'one\r\ntwo\r\nthree'
    const source = patchFor('crlf.txt', content, '@@ 1\r\n 1| one\r\n-2| two\r\n+TWO\r\n 3| three')
    expect(isHashlinePatch(source)).toBe(true)
    expect(applyHashlinePatch(content, parseHashlinePatch(source))).toEqual({
      content: 'one\nTWO\nthree',
      replacements: 1,
    })
  })
})

describe('display prefixes', () => {
  it('strips one numbered display prefix per line and leaves plain text alone', () => {
    expect(hashlineStripPrefixes('12| foo')).toBe('foo')
    expect(hashlineStripPrefixes('#12: foo\n13|bar')).toBe('foo\nbar')
    expect(hashlineStripPrefixes('plain\ntext')).toBe('plain\ntext')
  })

  it('strips prefixes from inserted lines inside a patch', () => {
    const content = 'anchor'
    const patch = parseHashlinePatch(patchFor('prefix.txt', content, '@@ 1', '-1| anchor', '+7| inserted'))
    expect(applyHashlinePatch(content, patch).content).toBe('inserted')
  })
})

describe('verifyPatchedBytes', () => {
  it('accepts byte-identical content', () => {
    expect(() => verifyPatchedBytes('a.txt', 'abc', 'abc')).not.toThrow()
    expect(() => verifyPatchedBytes('a.txt', 'é', 'é')).not.toThrow()
  })

  it('compares bytes, not line-ending-insensitive text', () => {
    expect(() => verifyPatchedBytes('a.txt', 'a\nb', 'a\r\nb')).toThrow(/Edit verification failed for a\.txt/)
  })

  it('reports the first differing byte and the re-read remedy', () => {
    const error = thrownBy(() => verifyPatchedBytes('a.txt', 'abcd', 'abX'))
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toMatch(/^Edit verification failed for a\.txt: the file on disk does not match the patched content/)
    expect(message).toContain('first difference at byte 2')
    expect(message).toContain('Re-read the file and try again')
  })
})
