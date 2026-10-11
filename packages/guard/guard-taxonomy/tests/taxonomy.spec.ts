/**
 * Shape suite for the salvaged taxonomy: 66 deny categories (1 HARD + 65
 * SOFT), the mandatory ALLOW exceptions, exhaustive classification of every
 * id, and the import-time freeze that keeps the table from moving in-process.
 */

import { describe, expect, it } from 'vitest'
import {
  ALLOW_GUARD_EXCEPTIONS,
  GUARD_POLICY_IDS,
  GUARD_TAXONOMY,
  HARD_GUARD_CATEGORIES,
  SOFT_GUARD_CATEGORIES,
  type GuardPolicyClass,
} from '../src/taxonomy.ts'

describe('salvaged taxonomy shape', () => {
  it('carries the 66 deny categories as 1 HARD + 65 SOFT, plus the ALLOW exceptions', () => {
    expect(HARD_GUARD_CATEGORIES).toEqual(['data_exfiltration'])
    expect(SOFT_GUARD_CATEGORIES).toHaveLength(65)
    expect(HARD_GUARD_CATEGORIES.length + SOFT_GUARD_CATEGORIES.length).toBe(66)
    // Ported from claude.exe @258901928: the ALLOW slot holds 17 top-level
    // exceptions; the D9 brief's "16" undercounts by one because the first
    // bullet sits at the tag start with no preceding newline.
    expect(ALLOW_GUARD_EXCEPTIONS).toHaveLength(17)
    expect(GUARD_POLICY_IDS).toHaveLength(83)
    expect(new Set(GUARD_POLICY_IDS).size).toBe(83)
    expect(new Set(SOFT_GUARD_CATEGORIES).size).toBe(65)
  })

  it('classifies every id exactly once: HARD 1, SOFT 65, ALLOW 17', () => {
    const counts: Record<GuardPolicyClass, number> = { hard: 0, soft: 0, allow: 0 }
    for (const id of GUARD_POLICY_IDS) counts[GUARD_TAXONOMY[id]] += 1
    expect(counts).toEqual({ hard: 1, soft: 65, allow: 17 })
    expect(Object.keys(GUARD_TAXONOMY).sort()).toEqual([...GUARD_POLICY_IDS].sort())
  })

  it('agrees with the category arrays member-for-member', () => {
    for (const id of [...HARD_GUARD_CATEGORIES, ...SOFT_GUARD_CATEGORIES]) {
      expect(['hard', 'soft']).toContain(GUARD_TAXONOMY[id])
    }
    for (const id of ALLOW_GUARD_EXCEPTIONS) {
      expect(GUARD_TAXONOMY[id]).toBe('allow')
    }
    expect(GUARD_TAXONOMY.data_exfiltration).toBe('hard')
  })

  it('freezes the table at import so the posture cannot be rewritten in-process', () => {
    expect(Object.isFrozen(GUARD_TAXONOMY)).toBe(true)
    expect(() => {
      // Deliberate mutation attempt: ESM strict mode must throw on the frozen
      // table, and the class must survive the attempt unchanged.
      (GUARD_TAXONOMY as Record<string, GuardPolicyClass>).git_destructive = 'allow'
    }).toThrow(TypeError)
    expect(GUARD_TAXONOMY.git_destructive).toBe('soft')
  })
})
