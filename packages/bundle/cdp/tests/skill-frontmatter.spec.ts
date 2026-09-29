/**
 * plan09 T1 — the shipped skill file's frontmatter is the catalog row's source:
 * it parses as YAML, carries a kebab-case `isSkillName` name, a non-empty
 * description within the framework's 500-character truncation bound, a
 * string `whenToUse`, and none of the legacy invocation keys the framework
 * does not support.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { DESCRIPTION, WHEN_TO_USE } from '../src/skill.ts'

const SKILL_FILE = fileURLToPath(new URL('../assets/skill/SKILL.md', import.meta.url))

/** Keys the framework does not support; their presence would silently do nothing. */
const LEGACY_KEYS = ['allowed-tools', 'disableModelInvocation', 'disable-model-invocation']
/** Boolean keys that are supported — if present, the type must be boolean. */
const OPTIONAL_BOOLEAN_KEYS = ['model-invocable', 'user-invocable']

/** Split one `---` frontmatter block off the body. */
function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) throw new Error('SKILL.md must start with a `---` frontmatter block')
  const parsed = yaml.load(match[1] ?? '')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SKILL.md frontmatter must parse to a YAML object')
  }
  return { data: parsed as Record<string, unknown>, body: text.slice(match[0].length) }
}

describe('assets/skill/SKILL.md frontmatter (plan09 T1)', () => {
  it('starts with a parseable YAML object and a non-empty body', async () => {
    const text = await readFile(SKILL_FILE, 'utf8')
    expect(text.startsWith('---')).toBe(true)
    const { data, body } = splitFrontmatter(text)
    expect(data).toBeTypeOf('object')
    expect(body.trim().length).toBeGreaterThan(0)
  })

  it('carries a kebab-case name the registry grammar accepts', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    expect(typeof data.name).toBe('string')
    expect(isSkillName(data.name as string)).toBe(true)
    expect(data.name).toBe('cdp-browser-control')
  })

  it('keeps description non-empty and within the 500-character bound', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    expect(typeof data.description).toBe('string')
    expect((data.description as string).length).toBeGreaterThan(0)
    expect((data.description as string).length).toBeLessThanOrEqual(500)
  })

  it('types whenToUse as a string when present', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    expect(typeof data.whenToUse).toBe('string')
  })

  // plan09 follow-up: the provider owns name/description/whenToUse in CODE, so
  // the frontmatter is a second, hand-maintained copy of the same two strings.
  // They matched when this was measured, but nothing bound them: editing one
  // would silently ship a catalog row and a manual that disagree, and only the
  // 500-char bound below would notice. Bind them here.
  it('keeps the frontmatter description byte-identical to the code DESCRIPTION', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    expect(data.description).toBe(DESCRIPTION)
  })

  it('keeps the frontmatter whenToUse byte-identical to the code WHEN_TO_USE', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    expect(data.whenToUse).toBe(WHEN_TO_USE)
  })

  it('leaves headroom under the 500-char truncation bound', async () => {
    // Truncation eats trigger words from the END, so a copy that has drifted
    // long is the failure mode this guards. 23 characters of slack today.
    expect(DESCRIPTION.length).toBeLessThanOrEqual(500)
    expect(500 - DESCRIPTION.length).toBeGreaterThanOrEqual(16)
  })

  it('carries no legacy keys and types the supported boolean keys correctly', async () => {
    const { data } = splitFrontmatter(await readFile(SKILL_FILE, 'utf8'))
    for (const key of LEGACY_KEYS) expect(Object.keys(data)).not.toContain(key)
    for (const key of OPTIONAL_BOOLEAN_KEYS) {
      if (key in data) expect(typeof data[key]).toBe('boolean')
    }
    // plan09 §4.1: allowed-tools is a framework-unsupported key — never write it.
    expect(Object.keys(data)).not.toContain('allowed-tools')
  })
})
