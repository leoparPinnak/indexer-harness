/**
 * Operator RESUME (the DUR-düğmesi arkasındaki operatör kontrollü çatal) over
 * the real loop: a CUT request's finalized prefix is HISTORY (interrupted
 * settlement), never a completed answer — the flow re-drives from the RESUME
 * CHECKPOINT (the last COMPLETED model request) in a continuation turn that
 * opens a fresh message series. The cut here is the MockAdapter's 'hang' entry
 * plus the operator's DUR (`cancel`), exactly the production severance shape.
 *
 * NOTE: `resume.spec.ts` beside this file covers process-RESTART resume
 * (persistence reload) — a different sense of the word; this file owns the
 * operator affordance.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    if (agent.status === 'idle') {
      resolve()
      return
    }
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function journal(agent: Agent, type: string): readonly { data: unknown }[] {
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-deprecated
  return agent.session.snapshotEvents().filter(event => event.type === type)
}

describe('operator resume', () => {
  it('re-drives from the checkpoint and keeps the SEVERED PREFIX as history, not as an answer', async () => {
    const adapter = new MockAdapter([textResponse('answer one'), 'hang', textResponse('answer two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('operator-resume-cut'), {
      provider: 'mock',
      model: 'mock',
    })

    // Completed request #1 (the checkpoint), then a request cut mid-air:
    send(agent, 'first prompt')
    await waitForIdle(ctx, agent)
    send(agent, 'second prompt')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    agent.resume()
    await waitForIdle(ctx, agent)

    // The severed prefix is durable HISTORY (`interrupted: true`) and is NOT
    // counted as a completed answer — exactly two clean settlements exist:
    const settlements = journal(agent, 'assistant/message')
    expect(settlements.filter(event => event.data.interrupted === true)).toHaveLength(1)
    expect(settlements.filter(event => event.data.interrupted !== true)).toHaveLength(2)

    // The continuation turn carries the honest marker naming the cut turn:
    expect(journal(agent, 'turn/start').at(-1)?.data)
      .toMatchObject({ continuation: { ofTurn: 2 } })

    // The continued request opens a FRESH message series — the provider answers
    // anew instead of pretending to finish the severed turn:
    expect(journal(agent, 'request/header').at(-1)?.data).toMatchObject({ reason: 'series' })

    // Rebuilt context carries the checkpoint answer AND the severed prefix as
    // past content — the trustworthy boundary is the checkpoint, and the
    // partial still replays as history:
    const rebuilt = JSON.stringify(adapter.requests.at(-1)?.messages ?? [])
    expect(rebuilt).toContain('answer one')
    expect(rebuilt).toContain('partial')
  })

  it('opens no turn and spends no model call when there is nothing to re-drive', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('operator-resume-empty'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.resume()

    // Honest NO-OP: no checkpoint precedes any cut, so no turn opens at all —
    // the Host refuses upstream with a reason before reaching this point.
    expect(adapter.requests).toHaveLength(0)
    expect(journal(agent, 'turn/start')).toHaveLength(0)
    expect(journal(agent, 'turn/end')).toHaveLength(0)
  })

  it('refuses to resume while the agent has active work', async () => {
    const adapter = new MockAdapter([textResponse('working')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('operator-resume-busy'), {
      provider: 'mock',
      model: 'mock',
    })

    send(agent, 'go')
    expect(() => { agent.resume() }).toThrow(/already has active work/u)
    await waitForIdle(ctx, agent)
  })
})
