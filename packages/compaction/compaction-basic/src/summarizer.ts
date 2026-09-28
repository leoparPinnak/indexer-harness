/**
 * Default summarization: one cache-reusing call, or windowed map-reduce when
 * the replayed span exceeds the summarizer's window, plus durable checkpoint
 * framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionSummaryCall } from '@deepseek-ai/dsh-compaction'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** The summarizer's role line for condensing one conversation span. */
const COMPACTION_ROLE =
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.'

/** The summarizer's role line for consolidating partial checkpoints. */
const MERGE_ROLE =
  'You are now acting as a compaction engine for this AI coding assistant. The messages ABOVE are partial checkpoints condensing consecutive sections of one conversation, in order. Consolidate them into ONE structured checkpoint that lets another model resume the work with no loss of essential context.'

/** One map pass sees a window of the conversation, not the whole span. */
const WINDOW_NOTE =
  'Note: the conversation ABOVE is one section of a longer conversation being condensed in sections. Checkpoint this section only.'

/** The exact Markdown structure and output rules every summarizer call follows. */
const STRUCTURE_AND_RULES = [
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = `${COMPACTION_ROLE}\n\n${STRUCTURE_AND_RULES}`

/** The consolidation directive for one merge call over partial checkpoints. */
const MERGE_INSTRUCTION = `${MERGE_ROLE}\n\n${STRUCTURE_AND_RULES}`

/** The map-pass directive: one conversation window is checkpointed alone. */
const WINDOW_INSTRUCTION = `${WINDOW_NOTE}\n\n${COMPACTION_INSTRUCTION}`

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input. A windowed pipeline
 * keeps the system head and tool schemas in front of every call and varies
 * only the window.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present; the leading system message of every summarizer call. */
  readonly head?: Message
  /** The shadowed region's derived messages in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
  /**
   * Map and intermediate-merge calls whose outputs the final call
   * consolidated, in call order. Absent on a one-shot summary.
   */
  intermediateCalls?: CompactionSummaryCall[]
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** One completed summarizer call: raw output, safe summary, and its envelope. */
interface SummarizerCall {
  rawOutput: ContentBlock[]
  summary: Array<Extract<ContentBlock, { type: 'text' }>>
  provider: string
  model: string
  maxTokens: number
  usage?: TokenUsage
}

/** One windowed-pipeline partial: its tagged checkpoint message and producing call. */
interface PartialCheckpoint {
  message: Message
  call: SummarizerCall
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused. When the
 * complete call would exceed the summarizer's declared window, split the
 * region into whole-message windows, checkpoint each one, and consolidate the
 * partial checkpoints into the final summary; an adapter without a declared
 * capacity keeps the one-shot call.
 * @param ctx - context providing the LLM and token-meter services.
 * @param config - resolved summarizer route and generation cap.
 * @param input - replayed conversation prefix (system head, tools, and shadowed region) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to every call.
 * @param onWindows - optional notice invoked once with the planned map-pass
 *   count when the windowed pipeline runs; never called on the one-shot path.
 * @returns safe text-only summary blocks, the exact final call envelope and
 *   output, and the intermediate window/merge calls when the pipeline ran.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
  onWindows?: (windows: number) => void,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const meter = ctx.tokenMeter
  const estimate = (message: Message): number => meter.estimateMessage(message)
  const headMessages: Message[] = input.head === undefined ? [] : [input.head]
  const toolsTokens = meter.estimateTools(input.tools)
  const headTokens = headMessages.reduce((total, message) => total + estimate(message), 0)

  const contextWindow = (await ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
  const mapInstruction = instructionMessage(WINDOW_INSTRUCTION)
  const mapBudget = contextWindow === undefined
    ? Number.POSITIVE_INFINITY
    : contextWindow - config.maxTokens - toolsTokens - headTokens - estimate(mapInstruction)
  const windows = packWindows(input.messages, mapBudget, estimate)

  if (windows.length <= 1) {
    const call = await runSummarizerCall(
      ctx,
      config,
      target,
      input.tools,
      [...headMessages, ...input.messages, instructionMessage(COMPACTION_INSTRUCTION)],
      agent,
      signal,
    )
    return finalResult(call, [])
  }

  onWindows?.(windows.length)

  const intermediateCalls: CompactionSummaryCall[] = []
  let partials: PartialCheckpoint[] = []
  for (const window of windows) {
    const call = await runSummarizerCall(
      ctx,
      config,
      target,
      input.tools,
      [...headMessages, ...window, mapInstruction],
      agent,
      signal,
    )
    intermediateCalls.push(callRecord('window', call))
    partials.push({ message: taggedCheckpointMessage(call.summary), call })
  }

  const mergeInstruction = instructionMessage(MERGE_INSTRUCTION)
  const mergeBudget = contextWindow === undefined
    ? Number.POSITIVE_INFINITY
    : contextWindow - config.maxTokens - toolsTokens - headTokens - estimate(mergeInstruction)
  for (;;) {
    const groups = packWindows(partials.map(partial => partial.message), mergeBudget, estimate)
    if (groups.length === 1) {
      const call = await runSummarizerCall(
        ctx,
        config,
        target,
        input.tools,
        [...headMessages, ...groups[0]!, mergeInstruction],
        agent,
        signal,
      )
      return finalResult(call, intermediateCalls)
    }
    const next: PartialCheckpoint[] = []
    let cursor = 0
    for (const group of groups) {
      const members = partials.slice(cursor, cursor + group.length)
      cursor += group.length
      if (members.length === 1) {
        // oxlint-disable-next-line typescript/no-non-null-assertion
        next.push(members[0]!)
        continue
      }
      const call = await runSummarizerCall(
        ctx,
        config,
        target,
        input.tools,
        [...headMessages, ...group, mergeInstruction],
        agent,
        signal,
      )
      intermediateCalls.push(callRecord('merge', call))
      next.push({ message: taggedCheckpointMessage(call.summary), call })
    }
    if (next.length >= partials.length) {
      throw new Error(
        `compaction: ${partials.length} partial checkpoints are too large to consolidate into one summary`,
      )
    }
    partials = next
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Build the user message carrying one summarizer directive. */
function instructionMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
  })
}

/** Frame one partial summary as a prior checkpoint the consolidation call recognizes. */
function taggedCheckpointMessage(summary: readonly ContentBlock[]): Message {
  return createUserMessage({
    content: [{ type: 'text', text: SUMMARY_OPEN_TAG }, ...summary, { type: 'text', text: SUMMARY_CLOSE_TAG }],
    source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
  })
}

/**
 * Split whole messages into consecutive windows under one per-call message
 * budget. A single message larger than the budget cannot be windowed and is
 * rejected explicitly — surface compaction cannot repair a single oversized
 * unit.
 * @param messages - messages to split, in order.
 * @param budget - tokens available for one window's messages.
 * @param estimate - the meter's per-message heuristic.
 * @returns consecutive non-empty windows of whole messages.
 */
function packWindows(
  messages: readonly Message[],
  budget: number,
  estimate: (message: Message) => number,
): Message[][] {
  const windows: Message[][] = []
  let current: Message[] = []
  let used = 0
  for (const message of messages) {
    const tokens = estimate(message)
    if (tokens > budget) {
      throw new Error(
        `compaction: one message (${tokens} estimated tokens) exceeds the summarization window budget (${budget} tokens)`,
      )
    }
    if (current.length > 0 && used + tokens > budget) {
      windows.push(current)
      current = []
      used = 0
    }
    current.push(message)
    used += tokens
  }
  if (current.length > 0) windows.push(current)
  return windows
}

/**
 * Run one summarizer call and project its safe summary.
 * @param ctx - context providing the LLM service.
 * @param config - resolved summarizer route and generation cap.
 * @param target - provider/model route for the call.
 * @param tools - tool schemas replayed for prefix-cache alignment.
 * @param messages - the exact call messages (head, window, instruction).
 * @param agent - supplies the session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the call's raw output, safe summary, and envelope.
 */
async function runSummarizerCall(
  ctx: Context,
  config: SummaryConfig,
  target: { provider: string; model: string },
  tools: readonly ToolSchema[] | undefined,
  messages: readonly Message[],
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummarizerCall> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [...messages],
    ...tools === undefined ? {} : { tools: [...tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    rawOutput,
    summary,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Record one intermediate call for the durable summary event. */
function callRecord(stage: CompactionSummaryCall['stage'], call: SummarizerCall): CompactionSummaryCall {
  return {
    stage,
    rawOutput: call.rawOutput,
    provider: call.provider,
    model: call.model,
    maxTokens: call.maxTokens,
    ...(call.usage === undefined ? {} : { usage: call.usage }),
  }
}

/** Assemble the SummaryResult around the final call. */
function finalResult(call: SummarizerCall, intermediateCalls: CompactionSummaryCall[]): SummaryResult {
  return {
    summary: call.summary,
    rawOutput: call.rawOutput,
    llmStreamCall: true,
    provider: call.provider,
    model: call.model,
    maxTokens: call.maxTokens,
    ...(call.usage === undefined ? {} : { usage: call.usage }),
    ...intermediateCalls.length === 0 ? {} : { intermediateCalls },
  }
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
