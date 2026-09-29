import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  isCompactionSessionMode,
  setCompactionMode,
  type CompactionPolicyState,
  type CompactionSessionMode,
} from '@deepseek-ai/dsh-compaction'
import { compactionPolicyProjection } from '@deepseek-ai/dsh-compaction-basic/src/policy-projection.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  thresholdTokensFor,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'

/** One recorded summarizer call: its envelope and the scripted reply text. */
class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly replies: readonly string[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 4000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.replies[Math.min(this.calls.length, this.replies.length - 1)] ?? ''
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function harness(replies: readonly string[]): {
  ctx: Context
  adapter: RecordingAdapter
  meter: TokenMeter
} {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  const adapter = new RecordingAdapter(replies)
  ctx.llm.registerAdapter([MODEL], adapter)
  return { ctx, adapter, meter }
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

/** One user message priced at `chars` text characters under the fixed heuristic. */
function userText(chars: number): Message {
  return createUserMessage({
    content: [{ type: 'text', text: 'y'.repeat(chars) }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

function windowInput(count: number): { messages: Message[] } {
  return { messages: Array.from({ length: count }, () => userText(4000)) }
}

const CONFIG = { summarizationProvider: '', summarizationModel: '', maxTokens: 200 }

describe('windowed map-reduce summarizer', () => {
  it('checkpoints each window and consolidates with one merge call', async () => {
    const { ctx, adapter } = harness(['part one', 'part two', 'part three', 'CHECKPOINT'])
    const notices: number[] = []
    const result = await summarizeWithLlm(
      ctx,
      CONFIG,
      windowInput(8),
      agent(Session.create(SessionId('windowed-merge'))),
      SIGNAL,
      windows => notices.push(windows),
    )

    expect(notices).toEqual([3])
    expect(adapter.calls).toHaveLength(4)
    for (const call of adapter.calls.slice(0, 3)) {
      expect(textOf(call.messages.at(-1)!)).toContain('one section of a longer conversation')
    }
    const merge = adapter.calls[3]!
    expect(textOf(merge.messages.at(-1)!)).toContain('Consolidate them into ONE structured checkpoint')
    expect(merge.messages.filter(message => textOf(message).startsWith('<compacted-summary>'))).toHaveLength(3)
    expect(result.llmStreamCall).toBe(true)
    expect(result.summary).toEqual([{ type: 'text', text: 'CHECKPOINT' }])
    expect(result.intermediateCalls?.map(call => call.stage)).toEqual(['window', 'window', 'window'])
    expect(result.intermediateCalls?.[0]?.rawOutput).toEqual([{ type: 'text', text: 'part one' }])
  })

  it('records intermediate merge calls when consolidation needs two rounds', async () => {
    const summary = 'z'.repeat(6000)
    const { ctx, adapter } = harness([summary, summary, summary, 'merged', 'CHECKPOINT'])
    const result = await summarizeWithLlm(
      ctx,
      CONFIG,
      windowInput(8),
      agent(Session.create(SessionId('windowed-rounds'))),
      SIGNAL,
    )

    expect(adapter.calls).toHaveLength(5)
    expect(result.intermediateCalls?.map(call => call.stage))
      .toEqual(['window', 'window', 'window', 'merge'])
    expect(result.summary).toEqual([{ type: 'text', text: 'CHECKPOINT' }])
  })

  it('rejects partial checkpoints that are too large to consolidate', async () => {
    const summary = 'z'.repeat(8000)
    const { ctx, adapter } = harness([summary, summary])
    await expect(summarizeWithLlm(
      ctx,
      CONFIG,
      windowInput(5),
      agent(Session.create(SessionId('windowed-stall'))),
      SIGNAL,
    )).rejects.toThrow(/too large to consolidate/)
    expect(adapter.calls).toHaveLength(2)
  })

  it('rejects one message larger than the summarization window budget', async () => {
    const { ctx, adapter } = harness(['unused'])
    await expect(summarizeWithLlm(
      ctx,
      CONFIG,
      { messages: [userText(50_000)] },
      agent(Session.create(SessionId('windowed-oversize'))),
      SIGNAL,
    )).rejects.toThrow(/exceeds the summarization window budget/)
    expect(adapter.calls).toHaveLength(0)
  })

  it('keeps the one-shot call and skips the notice when the span fits', async () => {
    const { ctx, adapter } = harness(['CHECKPOINT'])
    const notices: number[] = []
    const result = await summarizeWithLlm(
      ctx,
      CONFIG,
      windowInput(2),
      agent(Session.create(SessionId('windowed-oneshot'))),
      SIGNAL,
      windows => notices.push(windows),
    )

    expect(notices).toEqual([])
    expect(adapter.calls).toHaveLength(1)
    expect(result.intermediateCalls).toBeUndefined()
    expect(textOf(adapter.calls[0]!.messages.at(-1)!)).toContain('Condense the conversation ABOVE')
  })

  it('routes every call to the session mode dedicated summarizer', async () => {
    const { ctx, adapter } = harness(['a', 'b', 'CHECKPOINT'])
    const session = Session.create(SessionId('windowed-dedicated'))
    setCompactionMode(session, { summarizer: 'dedicated', provider: 'big', model: 'big-1' })
    const engine = new BasicCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 200,
    })
    ctx.llm.registerAdapter(['big'], adapter)
    for (let turn = 1; turn <= 2; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'y'.repeat(4000) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'y'.repeat(4000) }],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 3 })

    const nodes = session.surface.nodes
    const result = await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, agent(session), SIGNAL)
    expect(result.summary).toEqual([{ type: 'text', text: 'CHECKPOINT' }])
    for (const call of adapter.calls) {
      expect(call.provider).toBe('big')
      expect(call.model).toBe('big-1')
    }
    const events = session.snapshotEvents()
    const windowsEvent = events.find(event => event.type === 'compaction/windows')
    expect(windowsEvent).toMatchObject({ data: { windows: 2 } })
    const summaryEvent = events.find(event => event.type === 'compaction/summary')
    expect(summaryEvent?.data.intermediateCalls?.length).toBe(2)
  })
})

describe('session compaction mode', () => {
  const valid: CompactionSessionMode[] = [
    { summarizer: 'conversation' },
    { summarizer: 'conversation', contextBudgetTokens: 300_000, thresholdTokens: 240_000 },
    { summarizer: 'conversation', maxTokens: 4096 },
    { summarizer: 'dedicated', provider: 'p', model: 'm' },
    { summarizer: 'dedicated', provider: 'p', model: 'm', contextBudgetTokens: 1 },
  ]

  it.each(valid)('accepts %j', (mode) => {
    expect(isCompactionSessionMode(mode)).toBe(true)
    const session = Session.create(SessionId(`mode-${Math.random()}`))
    setCompactionMode(session, mode)
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'compaction/mode', data: mode })
  })

  it.each([
    undefined,
    null,
    'conversation',
    { summarizer: 'other' },
    { summarizer: 'dedicated' },
    { summarizer: 'dedicated', provider: 'p', model: '' },
    { summarizer: 'conversation', provider: 'p' },
    { summarizer: 'conversation', contextBudgetTokens: 0 },
    { summarizer: 'conversation', thresholdTokens: -1 },
    { summarizer: 'conversation', maxTokens: 0 },
  ])('rejects %j', (mode) => {
    expect(isCompactionSessionMode(mode)).toBe(false)
    const session = Session.create(SessionId('mode-invalid'))
    expect(() => setCompactionMode(session, mode as CompactionSessionMode)).toThrow(TypeError)
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})

describe('compactionPolicy projection', () => {
  const config = resolveConfig({
    thresholdRatio: 0.5,
    retainRatio: 0.25,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.75 }],
  })
  const unit = compactionPolicyProjection(() => config)

  it('folds mode and routed capacity, ignoring unrelated events', () => {
    const initial = unit.init({} as never, 0 as never)
    expect(initial).toEqual({ mode: null, route: null, modelCapacity: null })
    const mode: CompactionSessionMode = { summarizer: 'conversation', contextBudgetTokens: 100 }
    const afterMode = unit.apply(initial, { type: 'compaction/mode', seq: 1, time: 0, data: mode } as never)
    expect(afterMode).toEqual({ mode, route: null, modelCapacity: null })
    expect(unit.apply(afterMode, { type: 'turn/start', seq: 2, time: 0, data: { turn: 1 } } as never)).toBe(afterMode)
    const afterRoute = unit.apply(afterMode, {
      type: 'request/context',
      seq: 3,
      time: 0,
      data: { provider: 'p', model: 'm', contextWindow: 500 },
    } as never)
    expect(afterRoute).toEqual({ mode, route: { provider: 'p', model: 'm' }, modelCapacity: 500 })
    const afterCleared = unit.apply(afterRoute, {
      type: 'request/context',
      seq: 4,
      time: 0,
      data: { provider: 'p', model: 'm' },
    } as never)
    expect(afterCleared.modelCapacity).toBeNull()
  })

  it('derives the effective budget and trigger point from the folded facts', () => {
    const mode: CompactionSessionMode = { summarizer: 'conversation', thresholdTokens: 42 }
    const withMode: CompactionPolicyState = { mode, route: null, modelCapacity: 80 }
    expect(unit.wire.view(withMode)).toEqual({
      mode,
      modelCapacity: 80,
      contextBudgetTokens: 80,
      thresholdTokens: 42,
      maxTokens: 8192,
    })
    const routed: CompactionPolicyState = { mode: null, route: { provider: 'p', model: 'm' }, modelCapacity: 100 }
    expect(unit.wire.view(routed).thresholdTokens).toBe(75)
    const budgeted: CompactionPolicyState = {
      mode: { summarizer: 'conversation', contextBudgetTokens: 200 },
      route: null,
      modelCapacity: 100,
    }
    expect(unit.wire.view(budgeted)).toEqual({
      mode: budgeted.mode,
      modelCapacity: 100,
      contextBudgetTokens: 200,
      thresholdTokens: 100,
      maxTokens: 8192,
    })
    const empty: CompactionPolicyState = { mode: null, route: null, modelCapacity: null }
    expect(unit.wire.view(empty)).toEqual({
      mode: null,
      modelCapacity: null,
      contextBudgetTokens: null,
      thresholdTokens: null,
      maxTokens: 8192,
    })
    expect(unit.wire.viewSchema.parse(unit.wire.view(withMode))).toEqual(unit.wire.view(withMode))
  })
})

describe('per-session trigger point resolution', () => {
  const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.2 }), {
    provider: 'p',
    model: 'm',
  })

  it('prefers the override and otherwise scales the budget', () => {
    expect(thresholdTokensFor(policy, 1000)).toBe(500)
    expect(thresholdTokensFor(policy, 1000, 333)).toBe(333)
  })

  it('prices retention against the effective budget and validates the trigger point', () => {
    expect(resolveCompactSpec(policy, 1000, 900)).toMatchObject({
      contextWindow: 1000,
      thresholdTokens: 900,
      retainTokens: 200,
    })
    expect(() => resolveCompactSpec(policy, 1000, 100)).toThrow(/must be less than threshold/)
  })
})

/** Concatenate one message's text blocks the way the tests inspect instructions. */
function textOf(message: Message): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}
