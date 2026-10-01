/**
 * plan17-skillweb — the skill network's own contract.
 *
 * The audit this file came from asked four questions the link suite could not
 * answer:
 *
 *   KAPSAM      is every registered tool reachable from the injected body, and
 *               documented with more than its name?
 *   DOĞRULUK    does the body claim a tool/parameter/enum the source never has?
 *   ERİŞİM      can the agent get from the body to any tool in a bounded number
 *               of hops, through a route the body actually names?
 *   SPIDERWEB   does the network point both ways, and does every tool say what
 *               comes next?
 *
 * Each guard is proven RED first (the violating edit is applied, the suite is
 * watched fail, the edit is reverted) — see the plan17 audit notes. A guard that
 * has never been seen red is a comment.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../', import.meta.url))
const ASSETS = join(BUNDLE, 'assets')
const GUIDES_DIR = join(ASSETS, 'guides')
const SKILL_FILE = join(ASSETS, 'skill', 'SKILL.md')
const TOOLS_FILE = join(BUNDLE, 'src', 'tools.ts')

/**
 * Tool names `tools.ts` actually registers, read from the source rather than a
 * hand-kept list — a stale list would make every assertion below vacuous.
 * Each tool is announced by a `// N. name` numbering comment, which is also the
 * ordinal the guides cite.
 */
async function registeredTools(): Promise<{ ordinal: number; name: string }[]> {
  const src = await readFile(TOOLS_FILE, 'utf8')
  const found = [...src.matchAll(/^\s*\/\/ (\d+)\. ((?:cdp|net)_[a-z_]+)/gm)]
  expect(found.length, 'tools.ts numbering comments vanished — this suite reads the tool list from them').toBeGreaterThan(0)
  return found.map(match => ({ ordinal: Number(match[1]), name: match[2] as string }))
}

async function skillBody(): Promise<string> {
  // skill.ts strips exactly one well-formed leading `---` block before the model
  // sees the body; the audit measured what the model actually receives, so this
  // suite measures the same thing.
  return (await readFile(SKILL_FILE, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '')
}

async function guideBodies(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const name of (await readdir(GUIDES_DIR)).filter(entry => entry.endsWith('.md'))) {
    out.set(name, await readFile(join(GUIDES_DIR, name), 'utf8'))
  }
  return out
}

/**
 * Tools the guides name while telling the model they do NOT exist. These are
 * deliberate teaching statements ("`cdp_sleep` gibi tahmini bekleme yoktur"), not
 * dead references — the guard must not flag the correction it exists to protect.
 */
const DOCUMENTED_AS_ABSENT = new Set(['cdp_read', 'cdp_sleep'])

const TOOL_NAME = /\b((?:cdp|net)_[a-z_]+)\b/g

describe('plan17-skillweb — skill network contract', () => {
  // ---- KAPSAM ------------------------------------------------------------

  it('registers exactly 42 tools and the guides say so', async () => {
    const tools = await registeredTools()
    expect(tools).toHaveLength(42)
    expect(tools.filter(t => t.name.startsWith('cdp_'))).toHaveLength(40)
    expect(tools.filter(t => t.name.startsWith('net_'))).toHaveLength(2)
    const body = await skillBody()
    expect(body, 'the tool count in the body is a claim that must match tools.ts').toMatch(/\b42\b/)
  })

  it('names every registered tool in the injected skill body (1-hop access)', async () => {
    const body = await skillBody()
    const missing = (await registeredTools())
      .filter(t => !new RegExp(`\\b${t.name}\\b`).test(body))
      .map(t => `${t.ordinal}. ${t.name}`)
    expect(missing, 'these tools never appear in SKILL.md — the agent cannot select them').toEqual([])
  })

  it('documents every registered tool with parameters AND a failure signature', async () => {
    const guides = await guideBodies()
    const under = (await registeredTools()).filter((t) => {
      const section = toolSection([...guides.values()].join('\n'), t.name)
      const hasParams = /Parametre|PARAMETRELER|parameters?\*?\*?:/i.test(section)
      const hasFailure = /hata|error|reason|ok:false|in-band|bant içi|başarısız|FAIL|throw|NE ZAMAN KULLANMA/i.test(section)
      return !(hasParams && hasFailure)
    }).map(t => `${t.ordinal}. ${t.name}`)
    expect(under, 'a tool documented as a bare name teaches nothing — it needs how to call it and how it fails').toEqual([])
  })

  // ---- DOĞRULUK ----------------------------------------------------------

  it('never points at a tool the source does not register', async () => {
    const registered = new Set((await registeredTools()).map(t => t.name))
    const texts = [(await skillBody()), ...(await guideBodies()).values()].join('\n')
    const named = new Set([...texts.matchAll(TOOL_NAME)].map(m => m[1] as string))
    const phantom = [...named].filter(n => !registered.has(n) && !DOCUMENTED_AS_ABSENT.has(n)).sort()
    expect(phantom, `these tool names are not registered in tools.ts and are not marked as non-existent: ${phantom.join(', ')}`).toEqual([])
  })

  it('keeps every §N cross-reference resolvable to a heading in the guide it names', async () => {
    const guides = await guideBodies()
    const skill = await skillBody()
    const headingsOf = (text: string) => text.split('\n')
      .filter(line => /^#{1,6}\s/.test(line))
      .map(line => line.replace(/^#{1,6}\s+/, '').trim())

    for (const [name, text] of guides) {
      for (const match of text.matchAll(/§(\d+(?:\.\d+)*)/g)) {
        const ref = match[1] as string
        // A reference is local unless a guide is named just before it — the
        // guides use two shorthands, "`09-scraping-master.md` §4.6" and the
        // shorter "09 §4.6"; either way the target is that guide, not this one.
        const before = `${text.slice(Math.max(0, match.index - 80), match.index)}§`
        const file = [...before.matchAll(/([a-z0-9-]+\.md)[`'")*\]]*\s*§/gi)].pop()?.[1] as string | undefined
        const short = file === undefined
          ? ([...before.matchAll(/\b(\d{2})\s*§/g)].pop()?.[1] as string | undefined)
          : undefined
        const resolved = file
          ?? (short === undefined ? undefined : [...guides.keys()].find(k => k.startsWith(`${short}-`)))
        if (resolved === undefined) {
          // Local reference: it must name a heading in THIS guide.
          expect(
            headingExists(headingsOf(text), ref),
            `guides/${name} cites §${ref} but it has no heading starting with "${ref}" — `
            + 'if it points into another guide, name it ("09 §4.6"); if it means a SKILL.md step, write "SKILL.md §2.6"',
          ).toBe(true)
          continue
        }
        if (resolved === 'SKILL.md') continue // its §2.x are numbered procedure steps
        expect(
          headingExists(headingsOf(guides.get(resolved) ?? ''), ref),
          `guides/${name} cites ${resolved} §${ref} but ${resolved} has no heading starting with "${ref}"`,
        ).toBe(true)
      }
    }
    expect(/^1\.\s/m.test(skill) && /^7\.\s/m.test(skill), 'SKILL.md §2 must keep its numbered procedure steps').toBe(true)
  })

  // ---- ERİŞİM ------------------------------------------------------------

  it('routes the body to every guide and every guide back into the network', async () => {
    const body = await skillBody()
    const guides = await guideBodies()
    for (const name of guides.keys()) {
      if (name === '00-map.md') continue
      expect(body, `SKILL.md §6 must name guides/${name} — that is the only route the agent has`).toContain(`guides/${name}`)
    }
    // Every guide's See-also block must reach at least one OTHER guide: a leaf
    // guide with no outbound edge is a dead end the agent cannot leave.
    for (const [name, text] of guides) {
      if (name === '00-map.md') continue
      const outbound = [...text.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)/g)]
        .map(m => m[1] as string)
        .filter(t => guides.has(t.replace(/^guides\//, '')))
      expect(outbound, `guides/${name} links no other guide — it is a dead end`).not.toEqual([])
    }
  })

  it('points the link network both ways (no one-way spurs)', async () => {
    const guides = await guideBodies()
    const edge = new Map<string, Set<string>>()
    for (const [name, text] of guides) {
      const targets = new Set<string>()
      for (const m of text.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)/g)) {
        const t = (m[1] as string).replace(/^guides\//, '')
        if (guides.has(t) && t !== name) targets.add(t)
      }
      edge.set(name, targets)
    }
    // 00-map is the hub: pointing out of it is its job, so it is exempt as a
    // SOURCE. Pointing out of a leaf guide without a return edge is the defect
    // the audit found — 09 was a 38-tool sink nothing linked back to, and 02/03/
    // 05/06 had no way back to the index at all.
    const spurs: string[] = []
    for (const [from, targets] of edge) {
      if (from === '00-map.md') continue
      for (const to of targets) {
        if (!edge.get(to)!.has(from)) spurs.push(`${from} → ${to} (no return edge)`)
      }
    }
    expect(spurs, `one-way links strand the agent mid-task: ${spurs.join('; ')}`).toEqual([])
  })

  it('gives every guide a way back to the index', async () => {
    const guides = await guideBodies()
    const orphans = [...guides.keys()]
      .filter(name => name !== '00-map.md')
      .filter(name => !/\]\(00-map\.md(#[^)]*)?\)/.test(guides.get(name)!))
    expect(orphans, `these guides never link back to 00-map.md, so a reader who lands on one is stuck: ${orphans.join(', ')}`).toEqual([])
  })

  // ---- SPIDERWEB ---------------------------------------------------------

  it('gives every tool a "what next" row in the architecture guide', async () => {
    const guides = await guideBodies()
    const arch = guides.get('10-skill-mimarisi.md')
    expect(arch, 'the network guide is the spiderweb hub and must ship').toBeDefined()
    // Scoped to the §1 table: the same tool names also appear in the §3
    // polymorphism tables, and a row anywhere would satisfy a loose search.
    const table = sectionOf(arch!, /^1\.\s/)
    const missing = (await registeredTools())
      .filter(t => !new RegExp(`\\|\\s*${t.ordinal}\\s*\\|\\s*\`${t.name}\`\\s*\\|\\s*\\S`).test(table))
      .map(t => `${t.ordinal}. ${t.name}`)
    expect(missing, 'these tools have no "öncesi → sonrası" row in the §1 table, so the network dead-ends at them').toEqual([])
  })

  it('names the polymorphic alternatives for every cluster it claims', async () => {
    const guides = await guideBodies()
    const arch = guides.get('10-skill-mimarisi.md')!
    // The clusters the audit found missing: each must have a heading in §3.
    for (const cluster of [
      'bir öğeyi bulma', 'sayfayı bekleme', 'kaydırma', 'alana yazma',
      'veri okuma', 'tıklama adresleme', 'hata teşhisi merdiveni',
      'sekme izolasyonu', 'kanıt biçimi',
    ]) {
      expect(
        arch.toLocaleLowerCase('tr'),
        `the ${cluster} polymorphism cluster is missing from the architecture guide`,
      ).toContain(cluster)
    }
  })
})

/**
 * The section a tool owns: the markdown block that opens with a heading naming
 * it, up to the next heading at the same or a higher level. A fixed line window
 * is not enough — it bleeds the neighbouring tool's parameters in, so deleting
 * one tool's parameter list could not turn the guard red.
 */
function toolSection(text: string, name: string): string {
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (!/^#{1,6}\s/.test(line) || !line.includes(name)) continue
    const level = levelOf(line)
    const end = lines.findIndex((later, j) => j > i && /^#{1,6}\s/.test(later) && levelOf(later) <= level)
    return lines.slice(i, end === -1 ? lines.length : end).join('\n')
  }
  // No heading owns the name (the body mentions it in prose) — fall back to the
  // neighbourhood so a guide that documents a tool in a table still counts.
  const i = lines.findIndex(line => line.includes(name))
  return i === -1 ? '' : lines.slice(Math.max(0, i - 2), i + 14).join('\n')
}

/** A `§2.1` reference matches a heading `2.1 Foo` or `2.1. Bar` — prefix match. */
function headingExists(headings: string[], ref: string): boolean {
  return headings.some(h => h === ref || h.startsWith(`${ref} `) || h.startsWith(`${ref}.`) || h.startsWith(`${ref}—`) || h.startsWith(`${ref}-`))
}

/** Heading level of a markdown line that is known to be a heading, else 1. */
function levelOf(line: string): number {
  return /^#{1,6}\s/.test(line) ? (/^#+/.exec(line)?.[0].length ?? 1) : 1
}

/** From the heading whose text starts with `match` to the next heading of the same level. */
function sectionOf(text: string, match: RegExp): string {
  const lines = text.split('\n')
  const i = lines.findIndex(line => /^#{1,6}\s/.test(line) && match.test(line.replace(/^#{1,6}\s+/, '')))
  if (i === -1) return text
  const level = levelOf(lines[i] as string)
  const end = lines.findIndex((later, j) => j > i && /^#{1,6}\s/.test(later) && levelOf(later) <= level)
  return lines.slice(i, end === -1 ? lines.length : end).join('\n')
}
