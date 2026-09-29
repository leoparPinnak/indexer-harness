/**
 * ui-context-control browser half on a real SlotRegistry: the plugin occupies
 * the conversation `conversation.input.context` seat and the General settings
 * `settings.general.item` list row, and its injected faces fold RPC outcomes
 * into resolved promises or explicit rejections (never silent success);
 * teardown empties both seats (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContextControlInjected } from '../src/client/ContextControl.tsx'
import { ContextControl } from '../src/client/ContextControl.tsx'
import type { CompactionCapInjected } from '../src/client/CompactionCapSetting.tsx'
import { CompactionCap } from '../src/client/CompactionCapSetting.tsx'
import { apply, inject } from '../src/client/index.ts'

const SID = 's-context' as SessionId

interface Bench {
  ctx: Context
  slots: SlotRegistry
  sessionRemote: {
    setCompactionMode: ReturnType<typeof vi.fn>
    modelCatalog: ReturnType<typeof vi.fn>
  }
  settingsRemote: {
    describe: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    mutate: ReturnType<typeof vi.fn>
  }
  execute: ReturnType<typeof vi.fn>
}

async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.context': { kind: 'single', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const sessionRemote = {
    setCompactionMode: vi.fn(() => Promise.resolve({ ok: true, value: { mode: {} } })),
    modelCatalog: vi.fn(() => Promise.resolve({
      ok: true,
      value: { groups: [{ id: 'big', name: 'Big', models: [{ id: 'big-1', name: 'Big 1' }] }] },
    })),
  }
  const settingsRemote = {
    describe: vi.fn(() => Promise.resolve({
      ok: true,
      value: { namespaces: [{ ns: 'compaction-basic', value: { maxTokens: 16384 } }] },
    })),
    update: vi.fn(() => Promise.resolve({ ok: true, value: { ns: 'compaction-basic', value: {} } })),
    mutate: vi.fn(() => Promise.resolve({ ok: true, value: { ns: 'compaction-basic', value: {} } })),
  }
  const execute = vi.fn(() => Promise.resolve({
    ok: true,
    value: { commandId: 'c1', result: { kind: 'success' } },
  }))
  ctx.provide('remote', { session: sessionRemote, settings: settingsRemote, commands: { execute } })
  ctx.provide('remote.session', sessionRemote)
  ctx.provide('remote.settings', settingsRemote)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots, sessionRemote, settingsRemote, execute }
}

describe('ui-context-control browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['locale', 'remote', 'remote.session', 'remote.settings', 'slots'])
  })

  it('occupies both seats and unregisters them on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('conversation.input.context')).toMatchObject([
      { component: ContextControl },
    ])
    expect(b.slots.entries('settings.general.item')).toMatchObject([
      { component: CompactionCap },
    ])

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.context')).toHaveLength(0)
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
  })

  it('folds mode saves, the model catalog, and the compact command into explicit outcomes', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.context')[0]!
    const face = (entry.inject as unknown as (id: SessionId) => ContextControlInjected)(SID)

    await face.saveCompactionMode({ summarizer: 'conversation' })
    expect(b.sessionRemote.setCompactionMode).toHaveBeenCalledWith({
      sessionId: SID,
      mode: { summarizer: 'conversation' },
    })
    b.sessionRemote.setCompactionMode.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('session/compaction-mode-invalid', 'refused', { sessionId: SID }),
    } as never)
    await expect(face.saveCompactionMode({ summarizer: 'conversation' }))
      .rejects.toThrow(/session.setCompactionMode failed: session\/compaction-mode-invalid: refused/)

    await expect(face.loadSummarizerModels()).resolves.toEqual([
      { provider: 'big', models: ['big-1'] },
    ])
    b.sessionRemote.modelCatalog.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'catalog down', {}),
    } as never)
    await expect(face.loadSummarizerModels()).resolves.toEqual([])

    await expect(face.runCompact()).resolves.toBeUndefined()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/compact', [])
    b.execute.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('session/agent-busy', 'agent is busy', { reason: 'busy' }),
    } as never)
    await expect(face.runCompact()).rejects.toThrow(/compact failed: agent is busy \(session\/agent-busy\)/)
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(face.runCompact()).rejects.toThrow('unknown command: /compact')

    await fiber.dispose()
  })

  it('reads and writes the global cap through the result envelope', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('settings.general.item')[0]!
    const face = (entry.inject as unknown as () => CompactionCapInjected)()

    await expect(face.readCap()).resolves.toBe(16384)
    b.settingsRemote.describe.mockResolvedValueOnce({
      ok: true,
      value: { namespaces: [] },
    } as never)
    await expect(face.readCap()).resolves.toBeUndefined()
    b.settingsRemote.describe.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'describe down', {}),
    } as never)
    await expect(face.readCap()).resolves.toBeUndefined()

    await face.writeCap(16384)
    expect(b.settingsRemote.update)
      .toHaveBeenLastCalledWith('compaction-basic', { maxTokens: 16384 }, undefined)
    await face.writeCap(undefined)
    expect(b.settingsRemote.mutate)
      .toHaveBeenLastCalledWith('compaction-basic', [{ op: 'unset', path: ['maxTokens'] }], undefined)
    // A rejected envelope must surface, never report success.
    b.settingsRemote.update.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('settings/conflict', 'revision moved', { ns: 'compaction-basic', expected: 1, actual: 2 }),
    } as never)
    await expect(face.writeCap(32768))
      .rejects.toThrow(/settings write failed: revision moved \(settings\/conflict\)/)

    await fiber.dispose()
  })
})
