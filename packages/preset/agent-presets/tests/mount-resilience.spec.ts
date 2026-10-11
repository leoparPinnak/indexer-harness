/**
 * The standing mount's negative memoize: a failed mount is retained — with
 * its attempt count, its clock, and the file state it was made against — so
 * an immediate follow-up meets THAT failure instead of re-running the
 * attempt. The record releases when the composition file moves on or its TTL
 * elapses, and a settled success clears it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import { failureMemoTtlMs } from '../src/mount-backoff.ts'
import { livePresetMounts } from '../src/mount.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** One-row composition whose single tool is named `tool`. */
const rowFor = (tool: string): string =>
  `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: ${tool}\n`

/** A composition whose one row resolves and then refuses to apply. */
const refusing = (): string =>
  `- id: only\n  name: ${join(FIXTURES, 'plugins', 'throws.js')}\n  config:\n    message: refuses to mount\n`

/** One preset id: `{ id, path }` is all `ensureStanding` reads. */
type PresetHandle = { id: string; trust: 'user'; path: string }

/** The private failure record, reached the way mount.spec reaches `standing`. */
interface FailureRecord {
  error: unknown
  attempts: number
  failedAt: number
  stamp: { mtimeMs: number; size: number } | undefined
}

/** The roster's two private seams this file exercises. */
type Racer = {
  ensureStanding(preset: PresetHandle): Promise<{ key: unknown }>
  mountFailures: Map<string, FailureRecord>
}

const seam = (ctx: Context): Racer => ctx.agentPresets as unknown as Racer

/** The retained failure record for a preset, if one is held. */
const record = (ctx: Context, id: string): FailureRecord | undefined =>
  seam(ctx).mountFailures.get(id)

/** Move a recorded failure's clock past its TTL, without living the wait. */
function expire(ctx: Context, id: string): void {
  const held = seam(ctx).mountFailures.get(id)
  if (held === undefined) throw new Error(`no recorded failure for "${id}"`)
  held.failedAt = Date.now() - failureMemoTtlMs(held.attempts)
}

const contexts: Context[] = []
/** Every temp root created by this file, removed after its contexts settle. */
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A composition the roster can mount, a row that refuses, or both. */
async function harness(roster: Config = { default: 'standard', roots: [], includeShippedRoot: false, includeUserRoot: false }): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

/**
 * A roster over a temp root holding one preset authored as `composition`.
 * The id is per-test because `livePresetMounts()` is process-global.
 */
async function presetWith(
  id: string, composition: string,
): Promise<{ ctx: Context; path: string; preset: PresetHandle }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-memo-'))
  roots.push(root)
  await mkdir(join(root, id))
  const path = join(root, id, COMPOSITION_FILE)
  await writeFile(path, composition)
  const ctx = await harness({
    default: id, roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false,
  })
  return { ctx, path, preset: { id, trust: 'user', path } }
}

describe('the negative memo at the mount seam', () => {
  it('replays the recorded failure to an immediate follow-up instead of re-mounting', async () => {
    const { ctx } = await presetWith('memo', refusing())

    const first = await ctx.agentPresets.standingKeyFor('memo').catch(error => error)
    const second = await ctx.agentPresets.standingKeyFor('memo').catch(error => error)

    expect(first).toBeInstanceOf(Error)
    // The SAME object: a replay throws what was recorded, while a fresh
    // attempt would have built a new diagnostic and bumped the count.
    expect(second).toBe(first)
    expect(record(ctx, 'memo')?.attempts).toBe(1)
    expect(livePresetMounts().filter(mount => mount.presetId === 'memo')).toHaveLength(0)
  })

  it('releases the record for a file that moved on, and a success clears it', async () => {
    const { ctx, path } = await presetWith('repaired', refusing())
    expect(record(ctx, 'repaired')).toBeUndefined()
    await ctx.agentPresets.standingKeyFor('repaired').catch(() => undefined)
    expect(record(ctx, 'repaired')).toBeDefined()

    // The fix changes the stamp the record holds, so the fresh attempt runs
    // at once — the TTL never stands between a repaired file and its session.
    await writeFile(path, rowFor('repaired'))

    const key = await ctx.agentPresets.standingKeyFor('repaired')
    expect(key).toEqual({ agentPreset: 'repaired' })
    expect(record(ctx, 'repaired')).toBeUndefined()

    // Idempotent: the standing generation serves the second read and there is
    // no record for a success to clear again.
    expect(await ctx.agentPresets.standingKeyFor('repaired')).toBe(key)
    expect(record(ctx, 'repaired')).toBeUndefined()
  })

  it('releases the record when its TTL elapses, and counts the failure that follows', async () => {
    const { ctx } = await presetWith('patient', refusing())
    const first = await ctx.agentPresets.standingKeyFor('patient').catch(error => error)

    expire(ctx, 'patient')

    const second = await ctx.agentPresets.standingKeyFor('patient').catch(error => error)
    // A fresh attempt, not the memo — and it failed again, so the count that
    // grows the next TTL survived the release.
    expect(second).not.toBe(first)
    expect(record(ctx, 'patient')?.attempts).toBe(2)
    expect(record(ctx, 'patient')?.stamp).toBeDefined()
  })

  it('holds an unstattable file to its record and releases it when the file returns', async () => {
    const { ctx, path, preset } = await presetWith('vanishing', refusing())
    await rm(path)

    const first = await seam(ctx).ensureStanding(preset).catch(error => error)
    const second = await seam(ctx).ensureStanding(preset).catch(error => error)
    // Still gone is still the same state, so the record answers.
    expect(second).toBe(first)
    expect(record(ctx, 'vanishing')?.stamp).toBeUndefined()

    // A file that came back is a different state: fresh attempt, then cleared.
    await writeFile(path, rowFor('back'))
    const mounted = await seam(ctx).ensureStanding(preset)
    expect(mounted.key).toEqual({ agentPreset: 'vanishing' })
    expect(record(ctx, 'vanishing')).toBeUndefined()
  })

  it('releases a record whose file became unreadable, and records the new state', async () => {
    const { ctx, path, preset } = await presetWith('wiped', refusing())
    const first = await seam(ctx).ensureStanding(preset).catch(error => error)
    expect(record(ctx, 'wiped')?.stamp).toBeDefined()

    await rm(path)

    const second = await seam(ctx).ensureStanding(preset).catch(error => error)
    // The state the first failure was recorded against is gone; the fresh
    // attempt failed against the deletion instead.
    expect(second).not.toBe(first)
    expect(record(ctx, 'wiped')?.stamp).toBeUndefined()
    expect(record(ctx, 'wiped')?.attempts).toBe(2)
  })

  it('leaves nothing recorded when the mount simply succeeds, twice', async () => {
    const { ctx } = await presetWith('healthy', rowFor('healthy'))

    expect(await ctx.agentPresets.standingKeyFor('healthy')).toEqual({ agentPreset: 'healthy' })
    expect(await ctx.agentPresets.standingKeyFor('healthy')).toEqual({ agentPreset: 'healthy' })
    expect(record(ctx, 'healthy')).toBeUndefined()
  })
})
