import { describe, expect, it } from 'vitest'
import { searchEventLines, searchTextOf } from '../src/search-sessions.ts'

/** One stored event line. */
function line(seq: number, type: string, text: string, role?: string): string {
  return JSON.stringify({
    seq,
    type,
    data: {
      ...(role !== undefined ? { role } : {}),
      message: { content: [{ type: 'text', text }] },
    },
  })
}

describe('searchTextOf: what recall sees', () => {
  it('gathers text blocks and tool names, leaving structured noise out', () => {
    const text = searchTextOf({
      type: 'tool/result',
      data: { toolName: 'write_file', content: [{ type: 'text', text: 'İÇERİK METNİ' }] },
    })
    expect(text).toContain('İÇERİK METNİ')
    expect(text).toContain('write_file')
  })
})

describe('searchEventLines: linear recall with an anchored window', () => {
  const lines = [
    line(1, 'user/message', 'Kullanıcı fibonacci fonksiyonu istiyor', 'user'),
    line(2, 'assistant/message', 'fibonacci tanımı yazıldı', 'assistant'),
    line(3, 'tool/result', 'testler yeşil', undefined),
    line(4, 'user/message', 'şimdi fibonacci için memoization ekle', 'user'),
  ]

  it('finds hits in session order with match counts', () => {
    const hits = searchEventLines(lines, /fibonacci/i)
    expect(hits.map(hit => hit.seq)).toEqual([1, 2, 4])
    expect(hits[1]?.matches).toBe(1)
  })

  it('the hit carries its ANCHORED window (before+after) for a resume', () => {
    const hits = searchEventLines(lines, /fibonacci/i, { before: 1, after: 1 })
    const second = hits[1]
    expect(second?.context.map(each => each.seq)).toEqual([1, 3]) // 1 before, 1 after
  })

  it('CLIPS snippets at both ends with honest … marks', () => {
    const long = line(9, 'user/message', `${'A'.repeat(500)} hedef_kelime ${'B'.repeat(500)}`, 'user')
    const [hit] = searchEventLines([long], /hedef_kelime/, { snippetChars: 40 })
    expect(hit?.snippet.startsWith('…')).toBe(true)
    expect(hit?.snippet.endsWith('…')).toBe(true)
    expect(hit?.snippet).toContain('hedef_kelime')
    expect(hit?.snippet.length).toBeLessThan(120)
  })

  it('respects the result cap and ignores unparsable rows honestly', () => {
    const noisy = [
      '{ bozuk json',
      ...Array.from({ length: 10 }, (_, i) => line(i, 'user/message', 'tekrar kelimesi')),
    ]
    const hits = searchEventLines(noisy, /tekrar/, { limit: 3 })
    expect(hits).toHaveLength(3)
  })

  it('a global-flag query behaves the same (flags are normalized)', () => {
    const hits = searchEventLines(lines, /fibonacci/gi)
    expect(hits.map(hit => hit.seq)).toEqual([1, 2, 4])
  })
})