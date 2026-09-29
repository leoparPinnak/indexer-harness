import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { attachSessionCheckpoints } from '../src/index.ts'

/** Minimal duck runtime: a persistence seam, waterfall taps, one agent session. */
function fakeRuntime(sessionId: unknown): {
  ctx: Context
  mounts: { id: string; cwd: string | undefined }[]
  firePre(name: string, args: Record<string, unknown>): void
} {
  const mounts: { id: string; cwd: string | undefined }[] = []
  const pres = new Set<(call: unknown) => void>()
  const service = {
    checkpointRecorderFor: (id: string, cwd: string | undefined, plan: {
      paths: (c: { name: string; args?: Record<string, unknown> }) => readonly string[] | null
      creates: (c: { name: string; args?: Record<string, unknown> }) => readonly string[]
      read: (p: string) => string | undefined
    }) => {
      mounts.push({ id, cwd })
      return (taps: { pre: (l: (c: unknown) => void) => () => void }) => {
        taps.pre(call => { void plan })
        return () => {}
      }
    },
  }
  const ctx = {
    get: (name: string) => (name === 'sessionPersistence' ? service : undefined),
    logger: { warn: () => {} },
    on: (event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'tools/pre-execute') pres.add(listener as unknown as (c: unknown) => void)
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    mounts,
    firePre: (name, args) => {
      for (const each of pres) each({ rootCallId: '1', name, arguments: args, agent: { session: { id: sessionId, header: { cwd: 'C:\\ws' } } } }, async () => undefined)
    },
  }
}

describe('attachSessionCheckpoints: the cross-package bridge', () => {
  it('mounts through the duck-read service with the session id and cwd', () => {
    const runtime = fakeRuntime('sess-1')
    const agent = { session: { id: 'sess-1', header: { cwd: 'C:\\ws' } } } as never
    const dispose = attachSessionCheckpoints(runtime.ctx, agent)
    expect(dispose).toBeInstanceOf(Function)
    expect(runtime.mounts).toEqual([{ id: 'sess-1', cwd: 'C:\\ws' }])
  })

  it('returns undefined (never throws) when the capability is absent', () => {
    const runtime = fakeRuntime('sess-1')
    runtime.ctx.get = () => undefined as never
    const agent = { session: { id: 'sess-1', header: { cwd: 'C:\\ws' } } } as never
    expect(attachSessionCheckpoints(runtime.ctx, agent)).toBeUndefined()
  })

  it('returns undefined when the session id is unresolvable (honest skip)', () => {
    const runtime = fakeRuntime({ wey: true })
    const agent = { session: { id: { wey: true }, header: { cwd: 'C:\\ws' } } } as never
    expect(attachSessionCheckpoints(runtime.ctx, agent)).toBeUndefined()
    expect(runtime.mounts).toHaveLength(0)
  })
})