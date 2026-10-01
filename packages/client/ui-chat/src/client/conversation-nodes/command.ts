import type { Context } from '@deepseek-ai/cordis'
import type {
  CommandNode, CompactionLiveView, CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ManualCompactionChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'
import { foldCompactionLive } from './compaction-live-state.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary slash-command lifecycle. */
    command: CommandNode
    /** Manual compact command combined with its compaction transaction. */
    'manual-compaction': ManualCompactionChatData
  }
}

type CommandId = CommandNode['commandId']

const COMPACT_PLUGIN: CompactionCheckpointSource['plugin'] = 'compact'

interface CommandState {
  readonly command: CommandNode
  readonly start?: ConversationMatch
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
  readonly windows?: ConversationMatch
  readonly end?: ConversationMatch
}

interface CompactionEvidence {
  readonly start?: ConversationMatch
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
  readonly windows?: ConversationMatch
  readonly end?: ConversationMatch
  /** Live streaming presentation folded from transient compaction frames. */
  readonly live?: CompactionLiveView
}

function commandFromRun(match: ConversationMatch): CommandNode {
  if (match.event.type !== 'command/run') throw new Error('command start requires command/run')
  const data = match.event.data
  return {
    kind: 'command',
    seq: match.event.seq,
    time: match.event.time,
    commandId: data.commandId,
    name: data.name,
    args: data.args ?? null,
    outcome: null,
  }
}

function commandFromDone(match: ConversationMatch, previous?: CommandNode): CommandNode {
  if (match.event.type !== 'command/done') throw new Error('command update requires command/done')
  const data = match.event.data
  const sourceEventSeq = data.kind === 'success'
    && data.sourceEventSeq !== undefined
    && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
    ? data.sourceEventSeq
    : undefined
  return {
    kind: 'command',
    seq: previous?.seq ?? match.event.seq,
    time: previous?.time ?? match.event.time,
    commandId: data.commandId,
    name: previous?.name ?? null,
    args: previous?.args ?? null,
    outcome: {
      kind: data.kind,
      ...data.text === undefined ? {} : { text: data.text },
      ...sourceEventSeq === undefined ? {} : { sourceEventSeq },
    },
  }
}

/**
 * Read correlation identity from a compaction replacement checkpoint.
 * @param event - candidate Session event.
 * @returns correlated compaction and optional command identity.
 */
function compactSource(event: Parameters<ConversationNodeDefinition['match']>[0]): {
  compactionId: string
  sourceCommandId?: CommandId
} | undefined {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return undefined
  const source = event.data.source as unknown as {
    kind?: unknown
    plugin?: unknown
    compactionId?: unknown
    sourceCommandId?: CommandId
  }
  if (source.kind !== 'plugin' || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== 'string') return undefined
  return {
    compactionId: source.compactionId,
    ...source.sourceCommandId === undefined ? {} : { sourceCommandId: source.sourceCommandId },
  }
}

/** Read a non-negative integer count, or null when the field is absent or malformed. */
function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

/** Read a finite ratio inside [0, 1], or null when the field is absent or malformed. */
function ratio(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null
}

/**
 * Build the visible compaction marker from optional lifecycle evidence.
 * @param state - correlated compaction Matches for one transaction.
 * @returns final compaction summary Node data, anchored on the newest evidence.
 */
function compactSummary(state: CompactionEvidence): CompactionSummaryNode {
  const anchor = state.checkpoint?.event ?? state.end?.event ?? state.windows?.event
    ?? state.summary?.event ?? state.start?.event
  if (anchor === undefined) throw new Error('compaction marker requires one lifecycle event')
  let summary: string | null = null
  let shadowedItemCount: number | null = null
  let shadowedTokenCount: number | null = null
  let replacementTokenCount: number | null = null
  let reductionRatio: number | null = null
  let summaryProvider: string | null = null
  let summaryModel: string | null = null
  if (state.summary?.event.type === 'compaction/summary') {
    const data = state.summary.event.data
    if (Array.isArray(data.summary)) {
      const text = data.summary
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      summary = text.trim() === '' ? null : text
    }
    shadowedItemCount = Array.isArray(data.shadowedSeqs)
      && data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      ? data.shadowedSeqs.length
      : null
    shadowedTokenCount = tokenCount(data.shadowedTokenCount)
    replacementTokenCount = tokenCount(data.replacementTokenCount)
    reductionRatio = ratio(data.reductionRatio)
    summaryProvider = typeof data.provider === 'string' && data.provider !== '' ? data.provider : null
    summaryModel = typeof data.model === 'string' && data.model !== '' ? data.model : null
  }
  // The start marker announces the route and the incoming context size before
  // the model answers, so a still-running row is already informative.
  let startProvider: string | null = null
  let startModel: string | null = null
  let contextTotalTokens: number | null = null
  if (state.start?.event.type === 'compaction/start') {
    const data = state.start.event.data
    startProvider = typeof data.provider === 'string' && data.provider !== '' ? data.provider : null
    startModel = typeof data.model === 'string' && data.model !== '' ? data.model : null
    contextTotalTokens = tokenCount(data.contextTotalTokens)
  }
  const failed = state.end?.event.type === 'compaction/end' && state.end.event.data.error !== undefined
  // An operator stop closes the bracket with `cancelled` and no error: the row
  // is NEUTRAL and never presents as a failure.
  const cancelled = state.end?.event.type === 'compaction/end' && state.end.event.data.cancelled === true
  const windows = state.windows?.event.type === 'compaction/windows'
    && Number.isSafeInteger(state.windows.event.data.windows)
    && state.windows.event.data.windows >= 1
    ? state.windows.event.data.windows
    : null
  return {
    kind: 'compaction',
    seq: anchor.seq,
    time: anchor.time,
    status: state.checkpoint !== undefined ? 'landed' : cancelled ? 'cancelled' : failed ? 'failed' : 'running',
    summary,
    summaryEventSeq: state.summary?.event.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount,
    contextTotalTokens,
    // The summary event is authoritative once it exists; the start announcement
    // only fills the gap while the run is still in flight.
    provider: summaryProvider ?? startProvider,
    model: summaryModel ?? startModel,
    replacementTokenCount,
    reductionRatio,
    windows,
    ...state.live === undefined ? {} : { live: state.live },
  }
}

function fallbackState(context: ConversationNodeContext<CommandState>): CommandState | undefined {
  const done = context.matches.find(match => match.event.type === 'command/done')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const windows = context.matches.find(match => match.event.type === 'compaction/windows')
  const end = context.matches.find(match => match.event.type === 'compaction/end')
  if (checkpoint === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const source = compactSource(checkpoint.event)
  if (source?.sourceCommandId === undefined) return done === undefined ? undefined : { command: commandFromDone(done) }
  const fallbackCommand = done === undefined
    ? {
      kind: 'command' as const,
      seq: checkpoint.event.seq,
      time: checkpoint.event.time,
      commandId: source.sourceCommandId,
      name: 'compact',
      args: null,
      outcome: null,
    }
    : { ...commandFromDone(done), name: 'compact' }
  return {
    command: fallbackCommand,
    checkpoint,
    ...summary === undefined ? {} : { summary },
    ...windows === undefined ? {} : { windows },
    ...end === undefined ? {} : { end },
  }
}

/**
 * Fold shared compaction evidence into a Definition-owned State.
 * @param state - current business State carrying optional compaction evidence.
 * @param match - next compaction lifecycle Match.
 * @returns adopted State, preserving reference identity when the Match adds no evidence.
 */
export function updateCompactionState<State extends CompactionEvidence>(
  state: State,
  match: ConversationMatch,
): State {
  if (match.event.type === 'compaction/start') return { ...state, start: match }
  if (match.event.type === 'compaction/summary') return { ...state, summary: match }
  if (match.event.type === 'compaction/windows') return { ...state, windows: match }
  if (match.event.type === 'compaction/end') return { ...state, end: match }
  if (match.event.type === 'compaction/live-chunk') {
    return { ...state, live: foldCompactionLive(state.live, match.event.data) }
  }
  if (compactSource(match.event) !== undefined) return { ...state, checkpoint: match }
  return state
}

/** Slash-command lifecycle, including integrated manual compaction, Definition. */
export const commandDefinition: ConversationNodeDefinition<CommandState> = {
  kind: 'command',
  target: 'chat',
  match: (event) => {
    if (event.type === 'command/run') {
      return { id: String(event.data.commandId), role: 'start' }
    }
    if (event.type === 'command/done') {
      return { id: String(event.data.commandId), role: 'update' }
    }
    const checkpoint = compactSource(event)
    if (checkpoint?.sourceCommandId !== undefined) {
      return { id: String(checkpoint.sourceCommandId), role: 'update' }
    }
    if (event.type === 'compaction/live-chunk') {
      if (event.data.sourceCommandId === undefined) return null
      return { id: String(event.data.sourceCommandId), role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/windows'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) {
        return { id: String(event.data.sourceCommandId), role: 'update' }
      }
    }
    return null
  },
  start: (_context, match) => ({ command: commandFromRun(match) }),
  update: (context, match) => {
    if (match.event.type === 'command/done') {
      return { ...context.state, command: commandFromDone(match, context.state.command) }
    }
    return updateCompactionState(context.state, match)
  },
  publication: match => (match.event.type === 'compaction/live-chunk' ? 'animation-frame' : 'immediate'),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    if (state.command.name !== 'compact') {
      return chatNode(context, 'command', state.command.seq, state.command)
    }
    const compaction = state.checkpoint === undefined
      && state.windows === undefined
      && state.end === undefined
      ? null
      : compactSummary(state)
    const data: ManualCompactionChatData = { command: state.command, compaction }
    return chatNode(context, 'manual-compaction', compaction?.seq ?? state.command.seq, data)
  },
}

/**
 * Register the command lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCommandConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(commandDefinition)
}

/** Shared structural checkpoint recognizer for automatic compaction. */
export { compactSource, compactSummary }
