/**
 * plan09 T3 — the skill provider's three directory scenarios from §5.3:
 * a default/valid base lists one bundled candidate and loads the manual body,
 * a missing base warns and lists nothing, and a base without a readable body
 * answers `undefined` — none of which throws out of plugin load.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import { createCdpSkillProvider, SKILL_BODY_RELATIVE } from '../src/skill.ts'

const EXPECTED_BODY_HEAD = '# CDP Browser Automation Skill'
const root = fileURLToPath(new URL('../assets/', import.meta.url))

/** `list()` can answer an observation instead of candidates; this base must not. */
function onlyCandidates(listed: unknown): readonly SkillCandidate[] {
  if (!Array.isArray(listed)) throw new Error('list() must answer a candidate array for a valid base')
  return listed as readonly SkillCandidate[]
}

let scratch: string | undefined
afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('createCdpSkillProvider (plan09 T3)', () => {
  it('lists one bundled candidate against the default assets directory', async () => {
    const provider = createCdpSkillProvider('')
    expect(provider.name).toBe('cdp')
    const candidates = onlyCandidates(await provider.list({}))
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]
    expect(candidate).toMatchObject({
      name: 'cdp-browser-control',
      provider: 'cdp',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: root },
    })
    expect((candidate?.description ?? '').length).toBeGreaterThan(0)
    expect((candidate?.description ?? '').length).toBeLessThanOrEqual(500)
    expect(typeof candidate?.whenToUse).toBe('string')
  })

  it('loads the manual body without its frontmatter and resolves guides at assets/', async () => {
    const provider = createCdpSkillProvider(undefined)
    const definition = await provider.get({} as never, {} as never)
    expect(definition).toBeDefined()
    const content = definition?.content ?? ''
    expect(content.startsWith('---')).toBe(false)
    expect(content).toContain(EXPECTED_BODY_HEAD)
    expect(content).toContain('## 6. Deeper guides')
    expect(content).toContain('guides/00-map.md')
  })

  it('warns and lists nothing for a missing guideAssetsDir', async () => {
    const warnings: string[] = []
    const missing = join(tmpdir(), `cdp-skill-missing-${Date.now()}`)
    const provider = createCdpSkillProvider(missing, message => warnings.push(message))
    await expect(provider.list({})).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(missing)
  })

  it('warns and lists nothing when guideAssetsDir points at a file', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cdp-skill-file-'))
    const file = join(scratch, 'SKILL.md')
    await writeFile(file, '# not a directory\n', 'utf8')
    const warnings: string[] = []
    const provider = createCdpSkillProvider(file, message => warnings.push(message))
    await expect(provider.list({})).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('answers undefined from get() when the base holds no SKILL.md', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cdp-skill-empty-'))
    const provider = createCdpSkillProvider(scratch)
    // The directory exists, so the catalog row survives...
    await expect(provider.list({})).resolves.toHaveLength(1)
    // ...but an absent body degrades to undefined instead of throwing (§5.3).
    await expect(provider.get({} as never, {} as never)).resolves.toBeUndefined()
  })

  // plan09 follow-up — the body path is single-location, so these two pin the
  // layout instead of leaving it to an intended non-match.
  it('reads the manual only from the exported body path', () => {
    expect(SKILL_BODY_RELATIVE).toBe('skill/SKILL.md')
  })

  it('loads the body from <base>/skill/SKILL.md and ignores a retired <base>/SKILL.md', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cdp-skill-shadow-'))
    await mkdir(join(scratch, 'skill'), { recursive: true })
    // The retired path carries DIFFERENT content: if it were still searched,
    // the loaded body would say 'retired shadow' and this test would fail.
    await writeFile(join(scratch, 'SKILL.md'), '# retired shadow\n', 'utf8')
    await writeFile(join(scratch, 'skill', 'SKILL.md'), `# ${EXPECTED_BODY_HEAD}\n`, 'utf8')

    const provider = createCdpSkillProvider(scratch)
    const definition = await provider.get({} as never, {} as never)
    expect(definition?.content).toContain(EXPECTED_BODY_HEAD)
    expect(definition?.content).not.toContain('retired shadow')
  })

  it('warns that the retired <base>/SKILL.md is not a search location', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cdp-skill-warn-'))
    await writeFile(join(scratch, 'SKILL.md'), '# retired shadow\n', 'utf8')
    const warnings: string[] = []
    const provider = createCdpSkillProvider(scratch, message => warnings.push(message))
    await expect(provider.list({})).resolves.toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('is NOT a search location')
    expect(warnings[0]).toContain(join(scratch, 'skill', 'SKILL.md'))
  })

  it('does not warn about the retired path when it is absent', async () => {
    const warnings: string[] = []
    const provider = createCdpSkillProvider('', message => warnings.push(message))
    await expect(provider.list({})).resolves.toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })
})
