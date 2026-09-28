/**
 * plan09 T2 — the published package must carry the skill manual and guide web:
 * `package.json.files` lists `assets` in the exact order
 * `expectedDshPackageFiles` reconstructs, the workspace checker allows the extra
 * entry, and `@deepseek-ai/dsh-skill` is declared like deamon declares it
 * (peer + dev), so the provider imports resolve from a packed install too.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))
const CONSTRAINTS = fileURLToPath(new URL('../../../../scripts/check-workspace-constraints.ts', import.meta.url))

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
}

describe('cdp package packaging (plan09 T2)', () => {
  it('publishes the assets directory in the checker-exact files order', async () => {
    const pkg = await readJson(PACKAGE_JSON)
    expect(pkg.files).toEqual(['lib/index.js', 'cordis.patch.yml', 'assets', 'lib/types/**/*.d.ts'])
  })

  it('declares @deepseek-ai/dsh-skill in both peer and dev dependencies', async () => {
    const pkg = await readJson(PACKAGE_JSON)
    expect(pkg.peerDependencies['@deepseek-ai/dsh-skill']).toBe('workspace:^')
    expect(pkg.devDependencies['@deepseek-ai/dsh-skill']).toBe('workspace:^')
  })

  it('keeps @deepseek-ai/dsh-cdp in the workspace extras allow-list', async () => {
    const checker = await readFile(CONSTRAINTS, 'utf8')
    expect(checker).toContain("'@deepseek-ai/dsh-cdp': ['assets']")
  })
})
