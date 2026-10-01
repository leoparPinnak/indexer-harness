import type { Context } from '@deepseek-ai/cordis'
import type {
  CompactionLiveView, CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { chatNode } from './common.ts'
import { compactSource, compactSummary, updateCompactionState } from './command.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Automatic compaction checkpoint marker. */
    compaction: CompactionSummaryNode
  }
}

interface CompactionState {
  readonly start?: ConversationMatch
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
  readonly windows?: ConversationMatch
  readonly end?: ConversationMatch
  /** Live streaming presentation folded from transient compaction frames. */
  readonly live?: CompactionLiveView
}

function fallbackState(context: ConversationNodeContext<CompactionState>): CompactionState {
  const start = context.matches.find(match => match.event.type === 'compaction/start')
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const windows = context.matches.find(match => match.event.type === 'compaction/windows')
  const end = context.matches.find(match => match.event.type === 'compaction/end')
  return {
    ...start === undefined ? {} : { start },
    ...summary === undefined ? {} : { summary },
    ...checkpoint === undefined ? {} : { checkpoint },
    ...windows === undefined ? {} : { windows },
    ...end === undefined ? {} : { end },
  }
}

/** Automatic compaction lifecycle and landed checkpoint Definition. */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) {
      return { id: checkpoint.compactionId, role: 'update' }
    }
    if (event.type === 'compaction/live-chunk') {
      if (event.data.sourceCommandId !== undefined) return null
      return { id: String(event.data.compactionId), role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/windows'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId: unknown = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    return null
  },
  start: (_context, match) => (match.event.type === 'compaction/start'
    ? { start: match }
    : {}),
  update: (context, match) => updateCompactionState(context.state, match),
  // Live stream frames repaint on animation frames so streaming text stays
  // smooth instead of repainting per provider chunk.
  publication: match => (match.event.type === 'compaction/live-chunk' ? 'animation-frame' : 'immediate'),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    // A bare start marker still renders: it is the live row that names the
    // summarizer and the incoming context while the model is working. It is
    // dropped only when no lifecycle event of any kind reached the window.
    if (state.start === undefined
      && state.checkpoint === undefined
      && state.summary === undefined
      && state.windows === undefined
      && state.end === undefined) return null
    const marker = compactSummary(state)
    return chatNode(context, 'compaction', marker.seq, marker)
  },
}

/**
 * Register the automatic-compaction business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionDefinition)
}
