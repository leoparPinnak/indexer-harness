import { describe, expect, it } from 'vitest'
import {
  buildSpillEnvelope,
  SPILL_HEAD_CHARS,
  SPILL_THRESHOLD_CHARS,
  SPILL_TAIL_CHARS,
  spillFileName,
  spillNote,
  spillRowsField,
  spillTextField,
} from '../src/spill.ts'

/** Recording writer: captures what would hit the disk, returns a fixed path. */
function recorder(): { calls: { name: string; content: string }[], write: (name: string, content: string) => { path: string; chars: number } } {
  const calls: { name: string; content: string }[] = []
  return {
    calls,
    write: (name, content) => {
      calls.push({ name, content })
      return { path: `/spill/${name}`, chars: content.length }
    },
  }
}

describe('spill: pure name and envelope maths', () => {
  it('names files deterministically and sanitizes the label', () => {
    expect(spillFileName(123, 'cdp_text', 'txt')).toBe('spill-123-cdp_text.txt')
    // '../evil' → every illegal char becomes '-', so `.` `.` `/` → `---evil`.
    expect(spillFileName(1, '../evil', 'json')).toBe('spill-1----evil.json')
    expect(spillFileName(1, '../evil', 'json')).not.toContain('/')
  })

  it('builds a head+tail envelope that always carries the receipt path', () => {
    const content = `${'H'.repeat(SPILL_HEAD_CHARS + 50)}MIDDLE${'T'.repeat(SPILL_TAIL_CHARS + 50)}`
    const env = buildSpillEnvelope(content, '/spill/x.txt')
    expect(env).toContain('/spill/x.txt')
    expect(env).toContain(`${String(content.length)} chars`)
    // both bookends survive and the middle is elided exactly once
    expect(env.startsWith(`[spilled ${String(content.length)}`)).toBe(true)
    expect(env.slice(0, 300)).toContain('HHH')
    expect(env.endsWith('TTT')).toBe(true)
    expect(env.split('…').length - 1).toBe(1)
  })

  it('short content produces NO mid-elision (no lies about cutting)', () => {
    const env = buildSpillEnvelope('tiny', '/spill/x.txt')
    expect(env).toContain('tiny')
    expect(env).not.toContain('…\n')
  })

  it('spillNote renders a line only for a receipt', () => {
    expect(spillNote(undefined)).toBe('')
    expect(spillNote({ path: '/p', chars: 5 })).toContain('SPILLED: /p (5 chars)')
    expect(spillNote({ path: '/p', chars: 5, rows: 9 })).toContain('9 rows')
  })
})

describe('spill: field policing', () => {
  it('string field under the budget comes back UNTOUCHED (no receipt)', () => {
    const rec = recorder()
    const value = { text: 'small' }
    expect(spillTextField('cdp_text', 'text', value, rec.write)).toBe(value)
    expect(rec.calls).toHaveLength(0)
  })

  it('string field over the budget spills the FULL text and keeps the envelope', () => {
    const rec = recorder()
    const big = 'x'.repeat(SPILL_THRESHOLD_CHARS + 1)
    const out = spillTextField('cdp_text', 'text', { ok: true, text: big }, rec.write)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.content).toBe(big) // lossless: full payload on disk
    expect((out as { text: string }).text.length).toBeLessThan(big.length)
    expect((out as { text: string }).text).toContain('/spill/')
    expect((out as { spill: { chars: number } }).spill.chars).toBe(big.length)
  })

  it('row field spills JSON with the total and keeps head+tail rows', () => {
    const rec = recorder()
    const rows = Array.from({ length: 400 }, (_, i) => ({ i, blob: 'y'.repeat(60) }))
    const out = spillRowsField('cdp_extract', 'data', { ok: true, data: rows }, rec.write)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.name.endsWith('.json')).toBe(true)
    expect(rec.calls[0]?.content.length).toBeGreaterThan(SPILL_THRESHOLD_CHARS)
    const kept = (out as { data: unknown[] }).data
    expect(kept).toHaveLength(4) // 3 head + 1 tail
    expect((out as { spill: { rows: number } }).spill.rows).toBe(400)
  })

  it('small row sets are NEVER rewritten', () => {
    const rec = recorder()
    const rows = [{ a: 1 }, { a: 2 }]
    const out = spillRowsField('cdp_extract', 'data', { data: rows }, rec.write)
    expect(rec.calls).toHaveLength(0)
    expect((out as { data: unknown[] }).data).toBe(rows)
    void SPILL_TAIL_CHARS
  })
})