import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

const NS = 'compaction-basic'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

interface Harness {
  ctx: Context
  engine: BasicCompactionEngine
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + session + meter + settings-file +
 * compaction-basic over one temp harness home. `watch: false` keeps every
 * change flowing through the in-process write path.
 * @param config - composition-layer plugin config (base for the section).
 * @returns the live context, engine instance, and settings fiber handle.
 */
async function boot(config: object = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-compaction-dynamic-'))
  roots.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  const engineFiber = ctx.plugin(BasicCompactionEngine, config)
  await engineFiber
  const engine = ctx.get('compaction') as BasicCompactionEngine
  return { ctx, engine, settingsFiber }
}

describe('live compaction settings', () => {
  it('publishes a committed cap write to the engine without a restart', async () => {
    const { ctx, engine } = await boot({ auto: false })
    expect(engine.config.maxTokens).toBe(8192)

    await ctx.settings.update(NS, { maxTokens: 16384 })

    expect(engine.config.maxTokens).toBe(16384)
    // The General-page row reads back exactly what it wrote.
    const section = ctx.settings.describe().find(descriptor => descriptor.ns === NS)
    expect(section?.value).toMatchObject({ maxTokens: 16384 })
  })

  it('rejects a load-time-only auto change and an invalid cap', async () => {
    const { ctx, engine } = await boot()
    await expect(ctx.settings.update(NS, { auto: false })).rejects.toThrow(/auto applies at plugin load/)
    await expect(ctx.settings.update(NS, { maxTokens: 0 })).rejects.toThrow()
    // Neither rejected write reached the layer or the file.
    expect(engine.config.maxTokens).toBe(8192)
    expect(ctx.settings.get(NS)).not.toHaveProperty('auto', false)
  })

  it('falls back to the composition entry when settings detach', async () => {
    const { ctx, engine, settingsFiber } = await boot({ auto: false, maxTokens: 4096 })
    expect(engine.config.maxTokens).toBe(4096)

    await ctx.settings.update(NS, { maxTokens: 16384 })
    expect(engine.config.maxTokens).toBe(16384)

    await settingsFiber.dispose()
    expect(engine.config.maxTokens).toBe(4096)
  })
})
