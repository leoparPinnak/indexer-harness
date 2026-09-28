/**
 * Shared real-Loader boot for the Deamon bundle's specs: the shipped
 * cordis.patch.yml parsed with the include plugin's dialect, composed by its
 * `applyEntryPatches`, and booted through the Loader against a fixture row
 * that provides the external services the bridge observes.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as yaml from 'js-yaml'
import { afterEach } from 'vitest'
import * as Deamon from '../src/index.ts'

/** One `systemPrompt.section` definition the bridge registered. */
export interface PromptSection {
  name: string
  order: number
  text: () => string
}

/** One booted Deamon composition and what its registrations exposed. */
export interface DeamonComposition {
  context: Context
  /** HTTP paths the bundle registered on the fixture webServer. */
  routes: Set<string>
  /** Upgrade paths the bundle registered for WebSocket viewers. */
  upgrades: Set<string>
  /** Prompt sections the bundle registered on the fixture systemPrompt. */
  sections: PromptSection[]
  /** Diagnostics the bundle patch produced while composing. */
  warnings: string[]
}

let root: string | undefined
let savedDiscovery: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (savedDiscovery === undefined) delete process.env.DEAMON_DISCOVERY_FILE
  else process.env.DEAMON_DISCOVERY_FILE = savedDiscovery
  savedDiscovery = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the shipped Deamon bundle patch through a real Loader composition.
 *
 * @param options overrides merged over the shipped `deamon` row's config.
 * @returns the booted context plus the registrations the assertions read.
 */
export async function loadComposition(options: { surfaceContext?: boolean } = {}): Promise<DeamonComposition> {
  root = await mkdtemp(join(tmpdir(), 'dsh-deamon-loader-'))
  // The mount's disposal effect stops whatever this process discovers; keep
  // that discovery off the live machine's coordinates.
  savedDiscovery = process.env.DEAMON_DISCOVERY_FILE
  process.env.DEAMON_DISCOVERY_FILE = join(root, 'daemon-discovery.json')

  const patchFile = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const parsed: unknown = yaml.load(await readFile(patchFile, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${patchFile} must be a top-level list of patches`)
  const warnings: string[] = []
  const rows = applyEntryPatches([], parsed as PatchOptions[], (message: string, ...args: unknown[]) => {
    warnings.push([message, ...args.map(String)].join(' '))
  })
  if (options.surfaceContext !== undefined) {
    const row = rows.find(candidate => candidate.name === '@deepseek-ai/dsh-deamon') as { config?: Record<string, unknown> } | undefined
    if (row === undefined) throw new Error('the shipped patch produced no deamon row')
    row.config = { ...row.config, surfaceContext: options.surfaceContext }
  }

  const routes = new Set<string>()
  const upgrades = new Set<string>()
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
        registerUpgrade: (entry: { path: string }) => {
          upgrades.add(entry.path)
          return () => upgrades.delete(entry.path)
        },
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
      fixtureCtx.provide('connection', { requestRejection: () => undefined } as never)
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, yaml.dump([{ name: 'fixture-registries' }, ...rows]))

  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  await context.plugin(SkillRegistry)
  const modules = new Map<string, unknown>([
    ['fixture-registries', fixture],
    ['@deepseek-ai/dsh-deamon', Deamon],
    // A Host program cannot import a Client package's sources; the ui row's
    // node half is an empty apply, so the map supplies that same module shape.
    ['@deepseek-ai/dsh-client-ui-sandbox-view', {
      name: '@deepseek-ai/dsh-client-ui-sandbox-view',
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
  return { context, routes, upgrades, sections, warnings }
}
