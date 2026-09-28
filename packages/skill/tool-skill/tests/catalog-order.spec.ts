import { describe, expect, it } from 'vitest'
import { catalogSourceEntries, digestCatalogEntries } from '../src/index.ts'
import type { SkillSummary } from '../src/index.ts'

function skill(name: string): SkillSummary {
  return { name, description: `${name} açıklaması` } as SkillSummary
}

describe('plan16-cache: catalog order is input-order independent', () => {
  it('two shuffles of the same skills produce IDENTICAL entries and digest', () => {
    const one = catalogSourceEntries([skill('zeta'), skill('alpha'), skill('mid')], 500)
    const two = catalogSourceEntries([skill('mid'), skill('zeta'), skill('alpha')], 500)
    expect(two).toEqual(one)
    expect(digestCatalogEntries(two)).toBe(digestCatalogEntries(one))
  })

  it('orders by CODE UNIT — uppercase before lowercase, locale never consulted', () => {
    const entries = catalogSourceEntries([skill('apple'), skill('Zed'), skill('zed')], 500)
    // 'Z'(0x5A) < 'a'(0x61) < 'z'(0x7A): a locale-aware sort would often give
    // apple,Zed,zed or apple,zed,Zed — the point is ONE answer everywhere.
    expect(entries.map(e => e.name)).toEqual(['Zed', 'apple', 'zed'])
  })

  it('digest is SET identity — permuted input digests equal (canonicalized inside)', () => {
    const a = digestCatalogEntries([{ name: 'x', description: 'd' }, { name: 'y', description: 'e' }])
    const b = digestCatalogEntries([{ name: 'y', description: 'e' }, { name: 'x', description: 'd' }])
    expect(a).toBe(b)
    // …while a changed description changes the digest (no false "nothing new").
    const c = digestCatalogEntries([{ name: 'x', description: 'd' }, { name: 'y', description: 'E!' }])
    expect(c).not.toBe(a)
  })
})