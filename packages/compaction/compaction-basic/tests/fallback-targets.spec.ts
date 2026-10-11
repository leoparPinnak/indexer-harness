import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveFallbackTargets, resolveTargetPolicy } from '../src/config.ts'

describe('fallback summarizer target chain', () => {
  it('defaults to no fallback chain', () => {
    expect(resolveFallbackTargets(undefined)).toEqual([])
    expect(resolveConfig({}).fallbackTargets).toEqual([])
  })

  it('keeps validated pairs in order and freezes them into policy', () => {
    const chain = resolveFallbackTargets([
      { provider: 'reis', model: 'deepseek-v4.1-flash' },
      { provider: 'zen', model: 'space-bunny-free' },
    ])
    expect(chain).toEqual([
      { provider: 'reis', model: 'deepseek-v4.1-flash' },
      { provider: 'zen', model: 'space-bunny-free' },
    ])
    const resolved = resolveConfig({
      fallbackTargets: [{ provider: 'reis', model: 'deepseek-v4.1-flash' }],
    })
    const policy = resolveTargetPolicy(resolved, { provider: 'geminigatawey', model: 'gemini-3.8-flash-high' })
    expect(policy.fallbackTargets).toEqual([{ provider: 'reis', model: 'deepseek-v4.1-flash' }])
  })

  it('rejects empty identities and duplicate routes', () => {
    expect(() => resolveFallbackTargets([{ provider: '', model: 'm' }])).toThrow(/non-empty/)
    expect(() => resolveFallbackTargets([{ provider: ' ', model: 'm' }])).toThrow(/non-empty/)
    expect(() => resolveFallbackTargets([
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm' },
    ])).toThrow(/duplicates/)
  })

  it('caps the chain at four entries', () => {
    const chain = resolveFallbackTargets([
      { provider: 'a', model: '1' },
      { provider: 'b', model: '2' },
      { provider: 'c', model: '3' },
      { provider: 'd', model: '4' },
      { provider: 'e', model: '5' },
    ])
    expect(chain.map(entry => entry.provider)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('lets an exact-target override replace the default chain', () => {
    const resolved = resolveConfig({
      fallbackTargets: [{ provider: 'default-route', model: 'd' }],
      modelPolicies: [{
        provider: 'reis',
        model: 'mimo-v2.6-pro',
        fallbackTargets: [{ provider: 'zen', model: 'space-bunny-free' }],
      }],
    })
    const overridden = resolveTargetPolicy(resolved, { provider: 'reis', model: 'mimo-v2.6-pro' })
    const inherited = resolveTargetPolicy(resolved, { provider: 'other', model: 'x' })
    expect(overridden.fallbackTargets).toEqual([{ provider: 'zen', model: 'space-bunny-free' }])
    expect(inherited.fallbackTargets).toEqual([{ provider: 'default-route', model: 'd' }])
  })
})
