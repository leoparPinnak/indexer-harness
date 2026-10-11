/**
 * Operator STOP routing for a running compaction: the request names the owning
 * Session and the host must reach the compaction engine in THAT Session's AGENT
 * realm — the only realm whose engine holds the transaction's stop controller.
 * The Host context itself never mounts `compaction`.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'

const SESSION = SessionId('cancel-session')

/** Minimal agents facade: `cancelCompaction` resolves the Session's Agent. */
function agentsFor(agent: Agent): ApiSessionAgentController {
  return {
    resolveAgent: vi.fn(async () => ({ agent })),
  } as unknown as ApiSessionAgentController
}

describe('SessionCommandController.cancelCompaction', () => {
  it('routes the stop through the Session agent realm compaction engine', async () => {
    const engine = { cancelCompaction: vi.fn(() => true) }
    const agentCtx = new Context()
    agentCtx.provide('compaction', engine as never)
    const agent = { id: SESSION, ctx: agentCtx } as unknown as Agent
    const controller = new SessionCommandController(new Context(), agentsFor(agent), '/workspace')

    const result = await controller.cancelCompaction({ sessionId: SESSION, compactionId: 'c-1' })

    expect(result).toEqual({ cancelled: true })
    // The engine is the AGENT REALM's instance and receives the minted identity.
    expect(engine.cancelCompaction).toHaveBeenCalledWith(CompactionId('c-1'))
  })

  it('returns the engine verdict unchanged when nothing is running', async () => {
    const engine = { cancelCompaction: vi.fn(() => false) }
    const agentCtx = new Context()
    agentCtx.provide('compaction', engine as never)
    const agent = { id: SESSION, ctx: agentCtx } as unknown as Agent
    const controller = new SessionCommandController(new Context(), agentsFor(agent), '/workspace')

    await expect(controller.cancelCompaction({ sessionId: SESSION, compactionId: 'missing' }))
      .resolves.toEqual({ cancelled: false })
  })

  it('fails loudly when the Session agent realm mounts no compaction service', async () => {
    const agent = { id: SESSION, ctx: new Context() } as unknown as Agent
    const controller = new SessionCommandController(new Context(), agentsFor(agent), '/workspace')

    await expect(controller.cancelCompaction({ sessionId: SESSION, compactionId: 'c-1' }))
      .rejects.toThrow(/mounts no compaction service/u)
  })
})
