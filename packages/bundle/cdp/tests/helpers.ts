/**
 * Shared real-Loader boot for the CDP bundle's specs: the shipped
 * cordis.patch.yml parsed with the include plugin's dialect, composed by its
 * `applyEntryPatches`, and booted through the Loader against a fixture row that
 * provides the services the plugin observes.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
// plan09: optional real skill registry for the skill-registration spec.
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'
import { afterEach } from 'vitest'
import * as Cdp from '../src/index.ts'

/** One `systemPrompt.section` definition the plugin registered. */
export interface PromptSection {
  name: string
  order: number
  text: () => string
}

/** One booted CDP composition and what its registrations exposed. */
export interface CdpComposition {
  context: Context
  /** HTTP paths the bundle registered on the fixture webServer. */
  routes: Set<string>
  /** Tool names the bundle registered on the fixture tools registry. */
  tools: Set<string>
  /** Prompt sections the bundle registered on the fixture systemPrompt. */
  sections: PromptSection[]
  /** Diagnostics the bundle patch produced while composing. */
  warnings: string[]
}

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the shipped CDP bundle patch through a real Loader composition.
 *
 * @param options overrides merged over the shipped `cdp` row's config; the
 *   plan09 `skills` flag additionally mounts the real skill registry so the
 *   bundle's skill registration can be observed (default: fixture stays
 *   skill-less and the bundle's `ctx.inject(['skills'], …)` stays dormant).
 * @returns the booted context plus the registrations the assertions read.
 */
export async function loadComposition(options: { proxyListenPort?: number; skills?: boolean } = {}): Promise<CdpComposition> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cdp-loader-'))

  const patchFile = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const parsed: unknown = yaml.load(await readFile(patchFile, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${patchFile} must be a top-level list of patches`)
  const warnings: string[] = []
  const rows = applyEntryPatches([], parsed as PatchOptions[], (message: string, ...args: unknown[]) => {
    warnings.push([message, ...args.map(String)].join(' '))
  })
  if (options.proxyListenPort !== undefined) {
    const row = rows.find(candidate => candidate.name === '@deepseek-ai/dsh-cdp') as
      | { config?: Record<string, unknown> }
      | undefined
    if (row === undefined) throw new Error('the shipped patch produced no cdp row')
    row.config = { ...row.config, proxyListenPort: options.proxyListenPort }
  }

  const routes = new Set<string>()
  const tools = new Set<string>()
  const sections: PromptSection[] = []
  const fixture = {
    name: 'fixture-registries',
    apply(fixtureCtx: Context) {
      fixtureCtx.provide('webServer', {
        host: '127.0.0.1',
        port: 4567,
        register: (entry: { path: string }) => {
          routes.add(entry.path)
          return () => routes.delete(entry.path)
        },
      } as never)
      fixtureCtx.provide('tools', {
        register: (definition: ToolDefinition) => {
          tools.add(definition.name)
          return () => tools.delete(definition.name)
        },
        // plan05: registerCdpTools mounts a monotonic dialog guard; the real
        // registry returns a disposer, so the double mirrors that contract.
        guard: () => () => {},
      } as never)
      fixtureCtx.provide('systemPrompt', {
        getSectionOrder: (key: string) => (key === 'WEB_SURFACE' ? 100 : 0),
        section: (definition: PromptSection) => {
          sections.push(definition)
          // The real service tracks registrations on the calling fiber; this
          // fixture mirrors that by letting the returned disposer unregister.
          return () => {
            const index = sections.indexOf(definition)
            if (index !== -1) sections.splice(index, 1)
          }
        },
      } as never)
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, yaml.dump([{ name: 'fixture-registries' }, ...rows]))

  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  // plan09: opt-in real skill registry; without it no `skills` service exists
  // and the bundle's inject callback never fires (deamon's helpers pattern).
  if (options.skills === true) await context.plugin(SkillRegistry)
  const modules = new Map<string, unknown>([
    ['fixture-registries', fixture],
    ['@deepseek-ai/dsh-cdp', Cdp],
    // A Host program cannot import a Client package's sources; the ui row's
    // node half is an empty apply, so the map supplies that same module shape.
    ['@deepseek-ai/dsh-client-ui-cdp-view', {
      name: '@deepseek-ai/dsh-client-ui-cdp-view',
      apply: () => {},
    }],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  // Deferred inject callbacks settle one macrotask after their services resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { context, routes, tools, sections, warnings }
}
