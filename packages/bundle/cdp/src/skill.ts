/**
 * @deepseek-ai/dsh-cdp/skill — plan09: the bundle's single skill provider. It
 * exposes the `cdp-browser-control` skill (manual body + guide resource base)
 * through the `SkillProvider` contract: name/description/invocation live in
 * code, the body is read from disk on demand, and a missing or unreadable base
 * degrades to "skill not listed" instead of failing plugin load.
 *
 * @module @deepseek-ai/dsh-cdp/skill
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

/** Provider id registered on the skill registry. */
const PROVIDER_NAME = 'cdp'

/** Kebab-case catalog name — mirrored by assets/skill/SKILL.md's frontmatter. */
const SKILL_NAME = 'cdp-browser-control'

/**
 * The manual body's ONE location, relative to the resolved base. Exported so
 * the provider/packaging tests assert the path the provider actually reads
 * instead of re-deriving the assets layout on their own.
 */
export const SKILL_BODY_RELATIVE = 'skill/SKILL.md'

/**
 * The retired first search path. Nothing is read from here any more; the name
 * survives only so `list()` can warn if a file reappears at it.
 */
const RETIRED_BODY_RELATIVE = 'SKILL.md'

/**
 * plan09 §4.1: the catalog-row description. The framework truncates at 500
 * characters and truncation eats trigger words, so the length stays bounded
 * (T1 asserts the same string in the SKILL.md frontmatter parses ≤500, and
 * that the two copies stay byte-identical).
 */
export const DESCRIPTION = 'Drive Chrome/Edge over the DevTools protocol with the cdp_* and net_* tools. '
  + 'Use when the task opens, navigates, reads, clicks, types into, waits on, screenshots or network-inspects a tab; '
  + 'when the user mentions a browser, tab, page, form, login, selector, snapshot, popup, download, proxy capture, or "the CDP tab"; '
  + 'or before any task that mutates page state. Carries the target-confirmation procedure, tool-selection table, and failure playbook. Also covers isolation levels.'

/** Extra routing hint carried beside the description in the catalog row. */
export const WHEN_TO_USE = 'Any task that must observe or change a live browser page; load before the first cdp_* call of a session.'

/** Both invocation surfaces. */
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/**
 * plan09 §5.3/§7-1: a base that is missing or points at a file answers false so
 * `list()` can warn and return no candidate rather than throwing.
 * @param path - absolute path to probe.
 * @returns whether the path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether `path` exists as a regular file. Used only to warn when a file
 * reappears at the retired `<base>/SKILL.md` body path.
 * @param path - absolute path to probe.
 * @returns whether the path exists and is a file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * plan09 §7-6: this provider owns name/description in code, so a loaded body
 * drops one well-formed leading `---` block instead of showing raw YAML to the
 * model. A missing or unterminated block passes through unchanged — a
 * frontmatter-less or corrupt SKILL.md still loads (§5.3).
 * @param body - raw SKILL.md text.
 * @returns the body without one leading frontmatter block.
 */
function stripFrontmatter(body: string): string {
  const block = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(body)
  return block === null ? body : body.slice(block[0].length)
}

/**
 * Create the bundle's skill provider (plan09 §5.2).
 *
 * @param guideAssetsDir - `Config.guideAssetsDir`; empty/undefined resolves the
 *   published `assets/` directory beside this module (`import.meta.url`).
 * @param warn - optional warning sink; the plugin wires `ctx.logger.warn`.
 * @returns the provider `ctx.skills.registerProvider` accepts.
 */
export function createCdpSkillProvider(guideAssetsDir?: string, warn?: (message: string) => void): SkillProvider {
  // §5.2.1: apply-time directory resolution — the config dir, else assets/.
  const dir = guideAssetsDir === undefined || guideAssetsDir === ''
    ? fileURLToPath(new URL('../assets/', import.meta.url))
    : resolve(guideAssetsDir)
  const resourceBase = { kind: 'directory', path: dir } as const
  const candidate: SkillCandidate = {
    name: SKILL_NAME,
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase,
    rank: BUNDLED_SKILL_RANK,
    // Opaque handle handed back to get(): the resolved base directory.
    locator: dir,
  }
  return {
    name: PROVIDER_NAME,
    // §5.3: missing base or a path that is not a directory → warn + empty list;
    // the plugin keeps loading (no skill is not a broken feature).
    async list() {
      if (!(await isDirectory(dir))) {
        warn?.(`cdp skill: guideAssetsDir is not a readable directory: ${dir}`)
        return []
      }
      // Shadowing guard: the body path is now single-location, so a file that
      // reappears at the retired `<base>/SKILL.md` would be ignored in silence.
      // The old two-entry search made that same file silently win instead — name
      // it so the next reader knows which file the provider ignores, and why.
      if (await isFile(join(dir, RETIRED_BODY_RELATIVE))) {
        warn?.(`cdp skill: ${join(dir, RETIRED_BODY_RELATIVE)} is NOT a search location; `
          + `the manual is read only from ${join(dir, SKILL_BODY_RELATIVE)}. `
          + 'Remove the retired path or it reads as a second, ignored manual.')
      }
      return [candidate]
    },
    // §5.2.2 (single-location body): exactly one file is read — `<base>/skill/SKILL.md`.
    // The previous two-entry search listed `<base>/SKILL.md` first, but that path
    // is not shipped, so every load silently fell through to the second entry and
    // the working layout depended on an intended non-match. `resourceBase`
    // deliberately stays at `<base>/` (not the body's own directory) because the
    // body's guide links (`guides/xx.md`) resolve against the base.
    async get(): Promise<SkillDefinition | undefined> {
      try {
        const body = await readFile(join(dir, SKILL_BODY_RELATIVE), 'utf8')
        return { ...candidate, content: stripFrontmatter(body) }
      } catch {
        return undefined // §5.3: an unreadable body degrades, never throws.
      }
    },
  }
}
