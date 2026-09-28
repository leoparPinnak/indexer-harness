/**
 * The bundled `shellbox` skill through a real Loader composition: the catalog
 * entry the model sees, the manual body behind it, and the removal of every
 * registry contribution when the Deamon entry's fiber is disposed.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadComposition } from './helpers.ts'

describe('shellbox skill through a real Loader composition', () => {
  it('lists the bundled candidate with a model-sized description', { timeout: 60_000 }, async () => {
    const { context } = await loadComposition()
    const candidates = await context.skills.list()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'shellbox',
      provider: 'shellbox',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../assets/', import.meta.url)) },
    })
    expect(candidates[0]?.description.length ?? 0).toBeLessThanOrEqual(500)
    const loaded = await context.skills.get('shellbox')
    expect(loaded?.content).toContain('# Shellbox — the isolated private Windows desktop')
  })

  it('removes its provider and routes when the Deamon entry fiber disposes', { timeout: 60_000 }, async () => {
    const { context, routes } = await loadComposition()
    expect(await context.skills.list()).toHaveLength(1)
    expect(routes.has('/api/server/sandbox/status')).toBe(true)
    const entry = [...context.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-deamon')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(await context.skills.list()).toEqual([])
    expect(routes.has('/api/server/sandbox/status')).toBe(false)
  })
})
