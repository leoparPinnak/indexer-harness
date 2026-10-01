/**
 * Operator STOP of a running compaction: the mandated hard-stop scenario.
 *
 * A hanging fake adapter (one that NEVER settles until its abort) proves the
 * whole chain: DURDUR -> cancelCompaction -> composed AbortSignal -> the
 * summarize call -> `ctx.llm.stream(options)` -> the ADAPTER observes
 * `signal.aborted` (and receives the abort rejection). After the stop no new
 * window/merge call may start, the durable bracket closes NEUTRALLY with
 * `compaction/end {cancelled:true}` and NO error record, no summary/checkpoint
 * is ever landed, and the live `compaction/stream` frames end in `cancelled`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  CompactionId,
  ManualCompactionError,
  isCompactCheckpointSource,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionStreamFrame } from '@deepseek-ai/dsh-compaction'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'hanging-model'

/** An adapter whose stream NEVER settles until its abort tears the call down. */
class HangingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  /** The exact rejection each hung call produced after teardown. */
  readonly rejections: unknown[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 3000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    // Prove the abort reaches the transport: reject with the signal's own
    // reason the moment the operator stop tears the request down.
    await new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (signal === undefined) {
        reject(new Error('hanging adapter expected an AbortSignal'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }).catch((error: unknown) => {
      this.rejections.push(error)
      throw error
    })
  }
}

interface LiveHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly compact: BasicCompactionEngine
  readonly adapter: HangingAdapter
  readonly frames: CompactionStreamFrame[]
}

async function liveHarness(): Promise<LiveHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new HangingAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  // Measured sizing: the six-node seed prices at ~4.5K tokens, so a 3000-token
  // window against a 256-token summary cap (budget ≈ 2.4K) forces a genuine
  // 2-window map phase (the assertion below) while leaving each window
  // dispatchable — a summary cap larger than the window makes every window
  // budget negative and the run refuses before the first call.
  const compact = new BasicCompactionEngine(ctx, { auto: false, maxTokens: 256 })
  const frames: CompactionStreamFrame[] = []
  ctx.on('compaction/stream', (frame) => { frames.push(frame) })
  const agent = await ctx.agentLoop.create(SessionId('stop-compaction'), {
    provider: MODEL,
    model: MODEL,
  })
  return { ctx, agent, compact, adapter, frames }
}

/**
 * Seed three closed text turns sized to force a windowed map phase (2+
 * windows). The history is written DIRECTLY onto the surface: a seeding
 * `followup` would dispatch its own model call into the hanging adapter and
 * never settle — only the compaction's own summarize calls may hang here.
 */
async function seedWideHistory(harness: LiveHarness): Promise<void> {
  const session = harness.agent.session
  for (let turn = 0; turn < 3; turn += 1) {
    session.append('user/message', createUserMessage({
    // Word-distinct volume: a repeated single-character run prices as ONE
    // word under the message heuristic, which would fit one window and never
    // reach the map phase this test is about.
      content: [{ type: 'text', text: `turn ${String(turn)} ` + 'y '.repeat(3000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // The token meter prices assistant messages only inside a step bracket —
    // the same shape one real routed turn writes.
    session.append('step/start', { turn: turn + 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: turn + 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: turn + 1, step: 1 })
  }
}

describe('operator stop of a running compaction (hard-stop)', () => {
  it('DURDUR tears the request down at the adapter, freezes the window run, and closes neutrally', async () => {
    const harness = await liveHarness()
    await seedWideHistory(harness)
    const events: SessionEvent[] = []
    harness.ctx.on('session/event', (_session, event) => { events.push(event) })

    const controller = new AbortController()
    const run = harness.compact.compactNow(harness.agent, controller.signal, CommandId('cmd-stop'))
    const settled = run.then(
      () => undefined,
      (error: unknown) => error,
    )

    // Wait until the FIRST summarize call is in flight at the adapter, then
    // stop. A run that settles BEFORE dispatching fails fast with its own
    // outcome instead of spinning this poll until the test times out.
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (harness.adapter.calls.length >= 1) resolve()
        else setTimeout(check, 0)
      }
      void settled.then((runError) => {
        reject(new Error(`compaction settled before dispatch: ${String(runError)}`))
      })
      check()
    })
    const first = harness.adapter.calls[0]!
    expect(harness.frames[0]?.phase).toBe('requested')
    // The windowed pipeline announced its map phase before the first call.
    const windowsEvent = events.find(event => event.type === 'compaction/windows')
    expect(windowsEvent?.type === 'compaction/windows' ? windowsEvent.data.windows : 0).toBeGreaterThan(1)

    const compactionId = harness.frames[0]?.compactionId
    expect(typeof compactionId).toBe('string')
    expect(harness.compact.cancelCompaction(CompactionId(String(compactionId)))).toBe(true)

    const error = await settled
    // (1) The abort REACHED the adapter: its in-flight call saw `signal.aborted`
    // and the hung stream was torn down with the neutral cancelled reason.
    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('cancelled')
    expect(first.signal?.aborted).toBe(true)
    expect(harness.adapter.rejections).toHaveLength(1)
    expect(harness.adapter.rejections[0]).toBeInstanceOf(ManualCompactionError)
    expect((harness.adapter.rejections[0] as ManualCompactionError).code).toBe('cancelled')

    // (2) The window run is FROZEN: no window 2, no merge call ever started.
    expect(harness.adapter.calls).toHaveLength(1)

    // (3) The durable bracket closes NEUTRALLY: `cancelled` marker, no error
    // record, no summary, and NO partial checkpoint.
    const end = events.find(event => event.type === 'compaction/end')
    expect(end?.type === 'compaction/end' ? end.data.cancelled : undefined).toBe(true)
    expect(end?.type === 'compaction/end' ? end.data.error : 'missing').toBeUndefined()
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
    const session: Session = harness.agent.session
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; test assertion.
    expect(session.snapshotEvents().some(event => event.type === 'user/message'
      && isCompactCheckpointSource(event.data.source as never))).toBe(false)

    // (4) The live frames end in the neutral `cancelled` phase.
    expect(harness.frames.map(frame => frame.phase)).toEqual(['requested', 'cancelled'])
    expect(harness.frames[0]?.maxTokens).toBeGreaterThan(0)
  })

  it('streams reasoning and raw summary deltas with the outgoing maxTokens on live frames', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    const frames: CompactionStreamFrame[] = []
    ctx.on('compaction/stream', (frame) => { frames.push(frame) })

    class EmittingAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
      }
      override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'think' }
        yield { type: 'reasoning-delta', index: 0, text: 'ing' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'text-delta', index: 1, text: 'CHECK' }
        yield { type: 'text-delta', index: 1, text: 'POINT' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'CHECKPOINT' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter([MODEL], new EmittingAdapter())
    const compact = new BasicCompactionEngine(ctx, { auto: false, maxTokens: 4321 })
    const agent = await ctx.agentLoop.create(SessionId('live-frames'), { provider: MODEL, model: MODEL })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'seed ' + 'z'.repeat(1000) }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const controller = new AbortController()
    await compact.compactNow(agent, controller.signal, CommandId('cmd-live'))

    const phases = frames.map(frame => frame.phase)
    expect(phases).toEqual(['requested', 'streaming', 'streaming', 'streaming', 'streaming', 'done'])
    // The panel's three feeds: status phases (above), the raw output stream, the
    // reasoning stream, and the outgoing generation cap on every frame.
    expect(frames.filter(frame => frame.text !== undefined).map(frame => frame.text).join('')).toBe('CHECKPOINT')
    expect(frames.filter(frame => frame.reasoning !== undefined).map(frame => frame.reasoning).join('')).toBe('thinking')
    for (const frame of frames) expect(frame.maxTokens).toBe(4321)
  })
})
