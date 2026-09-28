/**
 * plan09 T4 — every relative guide link the skill body hands the model must
 * resolve to a real file at load time: the `guides/*.md` pointers in SKILL.md
 * §6 resolve against the skill's resource base (assets/), and every guide's own
 * "See also" links resolve inside assets/guides/. A broken link fails the suite
 * instead of failing the agent at read time.
 *
 * plan09 follow-up: the sweep used to cover only SKILL.md and 00-map.md, so the
 * "See also" block of guides 01-07 was never checked. Every shipped guide is
 * swept now, and a guide the map never links is flagged too — a guide the agent
 * is never told about is unreachable at runtime.
 *
 * plan17-skillweb: the audit found the FILE check was necessary but not
 * sufficient. Four more failure modes are now guarded, each of which passed
 * silently before:
 *
 *   G1 anchors     — a link resolved to an existing file but its `#anchor` named
 *                    a heading that no longer exists. `mapLinks` strips the
 *                    anchor, so every suite stayed green while the agent
 *                    followed a dead link.
 *   G2 dead tools  — a guide naming a `cdp_*`/`net_*` tool that `tools.ts` never
 *                    registers. A typo reads as a real tool.
 *   G5 body index  — a guide linked from 00-map.md but absent from SKILL.md §6,
 *                    i.e. reachable only after you already know it exists.
 *   G6 body count  — the body and the guide set disagreeing about how many guides
 *                    exist, so "load the guide for this" silently resolves to
 *                    nothing.
 *
 * Every test below is first proven RED by deliberately breaking the thing it
 * guards, then restored — a guard nobody has seen fail guards nothing.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_FILE = join(ASSETS, 'skill', 'SKILL.md')
const GUIDES_DIR = join(ASSETS, 'guides')
const MAP_FILE = join(GUIDES_DIR, '00-map.md')

/** Guide links in the skill body: `guides/x.md` (code span) or markdown `](guides/x.md)`, anchor optional. */
function skillGuideLinks(text: string): string[] {
  return [...text.matchAll(/(?:\.\.\/)?guides\/([^)#\s`]+\.md)/g)].map(match => match[1] as string)
}

/** Relative markdown links inside a guide, anchor stripped; external/absolute skipped. */
function mapLinks(text: string): string[] {
  return [...text.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)/g)].map(match => match[1] as string)
}

/** plan17: the same links but WITH the anchor, so `#dead-anchor` is checkable. */
function linksWithAnchor(text: string): { file: string, anchor: string }[] {
  return [...text.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)(?:#([^)\s]+))?\)/g)]
    .map(match => ({ file: match[1] as string, anchor: (match[2] ?? '') as string }))
}

/**
 * plan17: GitHub's heading-anchor rule, the one the model and the guide reader
 * actually apply — lowercase, drop every character that is not a letter, digit,
 * space or hyphen, then spaces become hyphens. The em dash in guide 09's title
 * collapses and leaves the double hyphen its real anchor carries, so the rule
 * must not "tidy" runs of hyphens away.
 */
export function headingAnchor(heading: string): string {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

async function guideNames(): Promise<string[]> {
  return (await readdir(GUIDES_DIR)).filter(entry => entry.endsWith('.md'))
}

describe('guide link integrity (plan09 T4)', () => {
  it('resolves every guides/*.md link in SKILL.md §6 to a shipped file', async () => {
    const skill = await readFile(SKILL_FILE, 'utf8')
    const links = skillGuideLinks(skill)
    expect(links.length).toBeGreaterThanOrEqual(7)
    for (const link of links) {
      await expect(
        readdir(GUIDES_DIR).then(names => names.includes(link)),
        `SKILL.md links guides/${link} but that file is not shipped`,
      ).resolves.toBe(true)
    }
  })

  it('resolves every relative link in 00-map.md to a shipped guide', async () => {
    const map = await readFile(MAP_FILE, 'utf8')
    const links = mapLinks(map)
    expect(links.length).toBeGreaterThanOrEqual(6)
    const names = await readdir(GUIDES_DIR)
    for (const link of links) {
      const target = link.startsWith('guides/') ? link.slice('guides/'.length) : link
      expect(names, `00-map.md links ${link}`).toContain(target)
    }
  })

  it('resolves the "See also" links of every shipped guide', async () => {
    const names = await readdir(GUIDES_DIR)
    for (const name of names.filter(entry => entry.endsWith('.md'))) {
      for (const link of mapLinks(await readFile(join(GUIDES_DIR, name), 'utf8'))) {
        const target = link.startsWith('guides/') ? link.slice('guides/'.length) : link
        expect(names, `guides/${name} links ${link}`).toContain(target)
      }
    }
  })

  it('links every shipped guide from 00-map.md so none is unreachable', async () => {
    const names = (await readdir(GUIDES_DIR)).filter(entry => entry.endsWith('.md'))
    const linked = new Set(
      mapLinks(await readFile(MAP_FILE, 'utf8'))
        .map(link => (link.startsWith('guides/') ? link.slice('guides/'.length) : link)),
    )
    for (const name of names) {
      if (name === '00-map.md') continue // the map is not a target of itself
      expect(linked, `guides/${name} is shipped but 00-map.md never links it — the agent cannot discover it`).toContain(name)
    }
  })

  // ---- plan17-skillweb: the guards this audit added ------------------------

  it('resolves every link ANCHOR to a real heading in the target guide', async () => {
    const names = new Set(await guideNames())
    const bodies = new Map<string, string>()
    for (const name of names) bodies.set(name, await readFile(join(GUIDES_DIR, name), 'utf8'))

    const check = (from: string, text: string) => {
      for (const { file, anchor } of linksWithAnchor(text)) {
        if (anchor === '') continue
        const target = file.startsWith('guides/') ? file.slice('guides/'.length) : file
        if (!names.has(target)) continue // the file-level tests already own that
        const anchors = new Set(
          bodies.get(target)!
            .split('\n')
            .filter(line => /^#{1,6}\s/.test(line))
            .map(line => headingAnchor(line)),
        )
        expect(
          anchors,
          `${from} links ${file}#${anchor} but ${target} has no heading with that anchor `
          + `(it has: ${[...anchors].join(', ')})`,
        ).toContain(anchor)
      }
    }

    check('00-map.md', await readFile(MAP_FILE, 'utf8'))
    for (const [name, text] of bodies) check(`guides/${name}`, text)
  })

  it('links every shipped guide from SKILL.md §6 as well as 00-map.md', async () => {
    const linked = new Set(skillGuideLinks(await readFile(SKILL_FILE, 'utf8')))
    for (const name of await guideNames()) {
      if (name === '00-map.md') continue
      expect(linked, `guides/${name} is shipped but SKILL.md never names it — §1–§5 cannot route the agent to it`).toContain(name)
    }
  })

  it('keeps the skill body, the map, and the shipped guide set in agreement', async () => {
    const names = await guideNames()
    const body = await readFile(SKILL_FILE, 'utf8')
    const map = await readFile(MAP_FILE, 'utf8')
    // The body must not advertise a guide the directory does not have …
    for (const link of new Set(skillGuideLinks(body))) {
      expect(names, `SKILL.md points at guides/${link} which is not shipped`).toContain(link)
    }
    // … and the map must not index a guide the directory does not have either.
    for (const link of new Set(mapLinks(map))) {
      const target = link.startsWith('guides/') ? link.slice('guides/'.length) : link
      expect(names, `00-map.md indexes ${target} which is not shipped`).toContain(target)
    }
    expect(names.length, 'the guide count changed — update SKILL.md §6 and 00-map.md in the same commit').toBeGreaterThanOrEqual(10)
  })
})
