import { describe, expect, it } from 'vitest'
import { compareSkillNames } from '../src/index.ts'

describe('plan16-cache: compareSkillNames is code-unit and locale-proof', () => {
  it('sorts case-sensitively by code unit (uppercase first)', () => {
    const names = ['apple', 'Zed', 'zed', 'Alpha']
    expect([...names].sort(compareSkillNames)).toEqual(['Alpha', 'Zed', 'apple', 'zed'])
  })

  it('the Turkish dotted/dotless trap has ONE answer regardless of ICU default', () => {
    // Locale-aware (tr-TR) comparison orders 'İ' before 'i'; code units say the
    // opposite (U+0130 > U+0069). The catalog must never depend on which ICU
    // the host boots with — assert the code-unit answer explicitly.
    expect(compareSkillNames('İstanbul', 'istanbul')).toBeGreaterThan(0)
    expect(compareSkillNames('istanbul', 'İstanbul')).toBeLessThan(0)
    expect(compareSkillNames('i', 'i')).toBe(0)
  })

  it('is a total order (antisymmetric — numerically, so ±0 never sneaks a diff)', () => {
    for (const [a, b] of [['a', 'b'], ['b', 'a'], ['a', 'a'], ['', 'a'], ['A', 'a']] as const) {
      // `===` on the doubles treats -0 and +0 as equal (toBe would not).
      expect(compareSkillNames(a, b) === -compareSkillNames(b, a)).toBe(true)
    }
    expect(compareSkillNames('same', 'same')).toBe(0)
  })
})