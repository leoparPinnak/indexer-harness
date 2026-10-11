/**
 * Host guard for the operator RESUME remote: every refusal maps the shared
 * `evaluateResumeState` verdict to an honest error code, and dispatch runs the
 * agent's continuation gate. Mirrors the client button's truth by construction
 * — one fold, two readers.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'

const SESSION = SessionId('resume-session')

interface JournalEvent {
  readonly type: string
  readonly data: unknown
}

function agentOver(events: readonly JournalEvent[], status = 'idle'): Agent {
  return {
    id: SESSION,
    status,
    resume: vi.fn(),
    session: { snapshotEvents: vi.fn(() => events) },
  } as unknown as Agent
}

function controllerFor(agent: Agent): SessionCommandController {
  const agents = {
    resolveAgent: vi.fn(async () => ({ agent })),
  } as unknown as ApiSessionAgentController
  return new SessionCommandController(new Context(), agents, '/workspace')
}

const CUT_WITH_CHECKPOINT: readonly JournalEvent[] = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: 'user' } } },
]

describe('SessionCommandController.resume', () => {
  it('dispatches the continuation when the cut has a completed request before it', async () => {
    const agent = agentOver(CUT_WITH_CHECKPOINT)
    const controller = controllerFor(agent)

    await expect(controller.resume({ sessionId: SESSION })).resolves.toEqual({ resumed: true })
    expect(agent.resume).toHaveBeenCalledTimes(1)
  })

  it('refuses BUSY while a turn is open', async () => {
    const agent = agentOver([
      { type: 'turn/start', data: { turn: 3 } },
    ])
    const controller = controllerFor(agent)

    await expect(controller.resume({ sessionId: SESSION })).rejects.toThrow(/a turn is still open/u)
    expect(agent.resume).not.toHaveBeenCalled()
  })

  it('refuses NOT-CUT after a normally ended turn', async () => {
    const agent = agentOver([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const controller = controllerFor(agent)

    await expect(controller.resume({ sessionId: SESSION })).rejects.toThrow(/ended normally/u)
  })

  it('refuses NO-CHECKPOINT honestly when no completed request precedes the cut', async () => {
    const agent = agentOver([
      { type: 'turn/start', data: { turn: 1 } },
      // The severed prefix is history, not a completed answer:
      {
        type: 'assistant/message',
        data: { turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } } },
    ])
    const controller = controllerFor(agent)

    await expect(controller.resume({ sessionId: SESSION }))
      .rejects.toThrow(/no completed model request precedes the cut/u)
    expect(agent.resume).not.toHaveBeenCalled()
  })

  it('refuses BUSY when the agent is not idle even though the journal is quiet', async () => {
    const agent = agentOver(CUT_WITH_CHECKPOINT, 'running')
    const controller = controllerFor(agent)

    await expect(controller.resume({ sessionId: SESSION })).rejects.toThrow(/not idle/u)
    expect(agent.resume).not.toHaveBeenCalled()
  })
})
