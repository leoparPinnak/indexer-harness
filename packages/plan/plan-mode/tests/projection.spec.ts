/** Plan projection behavior. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import type { PlanPresentation, PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'

interface Bench {
  ctx: Context
  session: Session
  values(): Record<string, unknown>
}

/**
 * The plan view with no plan presented, the fold's value until the exit tool runs.
 * @param active - logged plan mode.
 * @param pending - whether a selection targets a state other than `active`.
 * @returns the expected wire value.
 */
function view(active: boolean, pending: boolean): PlanProjection {
  return { active, pending, presented: null, history: [] }
}

/**
 * The newest presented plan of one bench.
 * @param bench - the harness under test.
 * @returns the newest presentation, which the caller has already asserted exists.
 */
function presented(bench: Bench): PlanPresentation {
  const plan = bench.values().plan as PlanProjection
  if (plan.presented === null) throw new Error('expected a presented plan')
  return plan.presented
}

async function harness(withPlanMode: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlanMode) await ctx.plugin(PlanModeController, { section: 'plan policy' })
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return {
    ctx,
    session,
    values: () => ctx.sessionProjections.snapshot(session).values,
  }
}

/** Append one logged /plan selection record (the executor's command/run shape). */
function runPlanCommand(session: Session, args: string, index: number): CommandId {
  const commandId = CommandId(`plan-proj-${String(index)}`)
  session.append('command/run', {
    commandId,
    name: 'plan',
    args,
    source: { kind: 'user' },
  })
  return commandId
}

/** Append the paired settlement for one projected plan command. */
function settlePlanCommand(session: Session, commandId: CommandId, kind: 'success' | 'error'): void {
  session.append('command/done', { commandId, kind })
}

/** Commit one plan/mode flip inside an open turn (the invariant's turn-enclosure rule). */
function commitPlanMode(session: Session, active: boolean, turn: number): void {
  session.append('turn/start', { turn })
  session.append('plan/mode', { active })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Commit one exit-tool call carrying a plan, inside an open turn.
 * @param session - the log to append to.
 * @param name - the called tool's name.
 * @param argumentsJson - the call's raw arguments string.
 * @param turn - the enclosing turn.
 * @param index - distinguishes call ids within one log.
 */
function appendToolCall(
  session: Session,
  name: string,
  argumentsJson: string,
  turn: number,
  index: number,
): void {
  session.append('turn/start', { turn })
  session.append('tool/call', {
    turn,
    step: 1,
    callId: ToolCallId(`plan-proj-call-${String(index)}`),
    name,
    arguments: argumentsJson,
  })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('plan projection unit', () => {
  it('serves inactive/not-pending for the empty log', async () => {
    const bench = await harness(true)
    expect(bench.values().plan).toEqual(view(false, false))
  })

  it('a logged /plan selection reads pending until plan/mode records it', async () => {
    const bench = await harness(true)
    const commandId = runPlanCommand(bench.session, '', 0)
    expect(bench.values().plan).toEqual(view(false, true))
    settlePlanCommand(bench.session, commandId, 'success')
    expect(bench.values().plan).toEqual(view(false, true))
    commitPlanMode(bench.session, true, 0)
    expect(bench.values().plan).toEqual(view(true, false))
  })

  it('drops a plan selection when its command settles with an error', async () => {
    const bench = await harness(true)
    commitPlanMode(bench.session, true, 0)
    const commandId = runPlanCommand(bench.session, 'off', 0)
    expect(bench.values().plan).toEqual(view(true, true))
    settlePlanCommand(bench.session, commandId, 'error')
    expect(bench.values().plan).toEqual(view(true, false))
  })

  it('folds `off` args and non-plan commands correctly, and a matching selection is not pending', async () => {
    const bench = await harness(true)
    commitPlanMode(bench.session, true, 0)
    // Another command's record never touches plan state.
    bench.session.append('command/run', {
      commandId: CommandId('other-1'), name: 'compact', args: '', source: { kind: 'user' },
    })
    expect(bench.values().plan).toEqual(view(true, false))
    // A command lifecycle with omitted input carries no plan selection.
    bench.session.append('command/run', {
      commandId: CommandId('plan-no-input'), name: 'plan', source: { kind: 'user' },
    })
    expect(bench.values().plan).toEqual(view(true, false))
    runPlanCommand(bench.session, ' off', 1)
    expect(bench.values().plan).toEqual(view(true, true))
    commitPlanMode(bench.session, false, 1)
    expect(bench.values().plan).toEqual(view(false, false))
    // Selecting the already-committed state folds to not-pending (net zero).
    runPlanCommand(bench.session, 'off', 2)
    expect(bench.values().plan).toEqual(view(false, false))
  })

  it('a /plan message-argument selection targets plan mode', async () => {
    const bench = await harness(true)
    runPlanCommand(bench.session, ' sketch the refactor first', 0)
    expect(bench.values().plan).toEqual(view(false, true))
  })

  it('freezes the active state across a request/header into activeAtLastHeader', async () => {
    const bench = await harness(true)
    commitPlanMode(bench.session, true, 0)
    expect(bench.values().plan).toEqual(view(true, false))
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'plan')?.activeAtLastHeader).toBeNull()
    bench.session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    })
    expect(bench.values().plan).toEqual(view(true, false))
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'plan')?.activeAtLastHeader).toBe(true)
    commitPlanMode(bench.session, false, 1)
    expect(bench.values().plan).toEqual(view(false, false))
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'plan')?.activeAtLastHeader).toBe(true)
    bench.session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'change',
    })
    expect(bench.values().plan).toEqual(view(false, false))
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'plan')?.activeAtLastHeader).toBe(false)
  })

  it('folds the plan a presented exit-tool call carried, with its first heading', async () => {
    const bench = await harness(true)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: '## Loader\n\n- one\n- two' }), 0, 0)
    expect(bench.values().plan).toMatchObject({
      active: false,
      pending: false,
      presented: { plan: '## Loader\n\n- one\n- two', title: 'Loader' },
      history: [{ plan: '## Loader\n\n- one\n- two', title: 'Loader' }],
    })
    // The presentation carries the tool call's own log time.
    expect(typeof presented(bench).at).toBe('number')
  })

  it('keeps every presented plan, newest first, and reads a heading-less one as untitled', async () => {
    const bench = await harness(true)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: '# First' }), 0, 0)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: 'second, no heading' }), 1, 1)
    const plan = bench.values().plan as PlanProjection
    expect(plan.presented).toMatchObject({ plan: 'second, no heading', title: null })
    expect(plan.history.map(entry => entry.title)).toEqual([null, 'First'])
    expect(plan.history.map(entry => entry.plan)).toEqual(['second, no heading', '# First'])
  })

  it('caps the wire history while the fold keeps every plan', async () => {
    const bench = await harness(true)
    for (let index = 0; index < 51; index += 1) {
      appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: `# Plan ${String(index)}` }), 0, 0)
    }
    const plan = bench.values().plan as PlanProjection
    expect(plan.history).toHaveLength(50)
    // Newest first: the cap drops the oldest plan, never the current one.
    expect(plan.history[0]?.title).toBe('Plan 50')
    expect(plan.history.at(-1)?.title).toBe('Plan 1')
    expect(plan.presented?.title).toBe('Plan 50')
  })

  it('ignores another tool\'s call and unreadable arguments, keeping the last plan', async () => {
    const bench = await harness(true)
    appendToolCall(bench.session, 'read', JSON.stringify({ plan: '# Not the exit tool' }), 0, 0)
    expect(bench.values().plan).toEqual(view(false, false))
    appendToolCall(bench.session, 'exit_plan_mode', '{"plan":', 1, 1)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ note: 'no plan field' }), 2, 2)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: '   ' }), 3, 3)
    expect(bench.values().plan).toEqual(view(false, false))
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: '# Kept' }), 4, 4)
    appendToolCall(bench.session, 'exit_plan_mode', '{', 5, 5)
    expect(bench.values().plan).toMatchObject({
      active: false,
      pending: false,
      presented: { plan: '# Kept', title: 'Kept' },
      history: [{ plan: '# Kept', title: 'Kept' }],
    })
  })

  it('cold replay recovers the presented plan from the log alone', async () => {
    const bench = await harness(true)
    appendToolCall(bench.session, 'exit_plan_mode', JSON.stringify({ plan: '# Restored' }), 0, 0)
    const cold = await harness(true)
    for (const event of bench.session.snapshotEvents()) {
      if (event.type === 'tool/call') cold.session.append('tool/call', event.data)
    }
    expect(cold.values().plan).toMatchObject({
      active: false,
      pending: false,
      presented: { plan: '# Restored', title: 'Restored' },
      history: [{ plan: '# Restored', title: 'Restored' }],
    })
  })

  it('has no plan key when plan-mode is not composed', async () => {
    const bench = await harness(false)
    expect('plan' in bench.values()).toBe(false)
  })

  it('drops the key when the plan-mode fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    const fiber = await bench.ctx.plugin(PlanModeController, { section: 'plan policy' })
    expect(bench.values().plan).toEqual(view(false, false))
    await fiber.dispose()
    expect('plan' in bench.values()).toBe(false)
  })

  it('cold replay recovers pending from the log alone (a fresh registry refolds it)', async () => {
    const bench = await harness(true)
    runPlanCommand(bench.session, '', 0)
    // A second registry over the same log (the cold-read shape): no service
    // memory involved, the fold alone answers {active:false, pending:true}.
    const cold = await harness(true)
    for (const event of bench.session.snapshotEvents()) {
      if (event.type === 'command/run' || event.type === 'command/done' || event.type === 'plan/mode') {
        cold.session.append(event.type, event.data)
      }
    }
    expect(cold.values().plan).toEqual(view(false, true))
  })
})
