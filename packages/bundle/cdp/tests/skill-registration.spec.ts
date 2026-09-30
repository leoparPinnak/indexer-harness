/**
 * plan09 T5 — the bundle's skill registration through a real Loader
 * composition: with the registry mounted, the catalog shows exactly one
 * `cdp-browser-control` candidate whose body loads; disposing the bundle row
 * removes the provider again; and with no
 * `skills` service at all the plugin boots unaffected — apply never throws on
 * a missing registry (§5.3, the deamon philosophy).
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadComposition } from './helpers.ts'

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))

describe('cdp skill registration (plan09 T5)', () => {
  it('lists one bundled candidate and loads its body when skills is mounted', { timeout: 60_000 }, async () => {
    const { context } = await loadComposition({ skills: true })
    const candidates = await context.skills.list()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'cdp-browser-control',
      provider: 'cdp',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: ASSETS },
    })
    expect(candidates[0]?.description.length ?? 0).toBeLessThanOrEqual(500)
    const loaded = await context.skills.get('cdp-browser-control')
    expect(loaded?.content).toContain('# CDP Browser Automation Skill')
    expect(loaded?.content.startsWith('---')).toBe(false)
  })

  it('removes the provider when the bundle row is disposed', { timeout: 60_000 }, async () => {
    const { context } = await loadComposition({ skills: true })
    expect(await context.skills.list()).toHaveLength(1)
    const row = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-cdp')
    expect(row?.fiber).toBeDefined()
    await row?.fiber?.dispose()
    expect(await context.skills.list()).toEqual([])
  })

  it('boots with no skills service — apply does not throw and tools mount', { timeout: 60_000 }, async () => {
    const { context, tools, warnings } = await loadComposition()
    expect(warnings).toEqual([])
    // The fixture provides no `skills` service, so the registry is absent...
    expect(context.skills).toBeUndefined()
    // ...yet every other registration mounted: the inject stayed dormant (§5.3).
    expect([...tools]).toContain('cdp_status')
    expect([...tools]).toContain('cdp_snapshot')
  })
})
