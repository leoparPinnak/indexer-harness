/**
 * Session Controller compaction-mode writes: the whole-value-replace remote
 * installs one durable `compaction/mode` event per accepted request, and the
 * wire boundary rejects mode values that fail the vocabulary guard without
 * touching the log.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CompactionSessionMode } from '@deepseek-ai/dsh-compaction'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
})

describe('sessions.setCompactionMode', () => {
  const modes: CompactionSessionMode[] = [
    { summarizer: 'conversation' },
    { summarizer: 'conversation', contextBudgetTokens: 300_000, thresholdTokens: 240_000 },
    { summarizer: 'dedicated', provider: 'big', model: 'big-1' },
  ]

  it.each(modes)('installs one durable whole-value-replace event for %j', async (mode) => {
    const ctx = await composed()
    const session = ctx.sessions.create(sid('mode-write'))
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)

    const written = await remote(ctx).setCompactionMode(request({ sessionId: session.id, mode }))
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.value.mode).toEqual(mode)
    const events = session.snapshotEvents().filter(event => event.type === 'compaction/mode')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual(mode)
  })

  it('rejects a mode value that fails the vocabulary guard without touching the log', async () => {
    const ctx = await composed()
    const session = ctx.sessions.create(sid('mode-invalid'))
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)

    const rejected = await remote(ctx).setCompactionMode(request({
      sessionId: session.id,
      mode: { summarizer: 'dedicated', provider: 'big', model: '' } as CompactionSessionMode,
    }))
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error).toMatchObject({
      code: 'session/compaction-mode-invalid',
      details: { sessionId: session.id },
    })
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/mode')).toHaveLength(0)
  })

  it('keeps the not-found path shared with the other session writes', async () => {
    const ctx = await composed()
    const missing = await remote(ctx).setCompactionMode(request({
      sessionId: sid('no-such-session'),
      mode: { summarizer: 'conversation' },
    }))
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toMatchObject({ code: 'session/not-found' })
  })
})
