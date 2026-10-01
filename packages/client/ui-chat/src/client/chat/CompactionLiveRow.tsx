// The live compaction row: one always-visible STATUS line for the running
// summarizer ("request sent — awaiting response", "summary streaming…",
// "stopped"), an expandable DETAIL panel (outgoing maxTokens, the model's
// reasoning stream, the raw summary stream), and a DURDUR (stop) button that
// cancels the transaction NEUTRALLY. Settled rows defer to the shipped
// CompactionItem / CompactionCommandCard presentations.

import { memo, useState } from 'react'
import type { CompactionSummaryNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import css from './MessageItem.module.css'
import rowCss from './ChatView.module.css'

/** Cancels one running compaction by its transaction identity. */
export type CancelCompaction = (compactionId: string) => void

/** Block-copy style shared by the two stream panes of the detail panel. */
const streamStyle: React.CSSProperties = {
  margin: '4px 0 10px',
  padding: '6px 8px',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '11px',
  opacity: 0.85,
  borderRadius: 6,
  background: 'rgba(127, 127, 127, 0.12)',
}

function phaseLabel(
  node: CompactionSummaryNode,
  t: ChatViewSlotProps['t'],
): string {
  if (node.status === 'cancelled') return t('message.compaction.phase.cancelled')
  const phase = node.live?.phase
  if (phase === 'requested') return t('message.compaction.phase.requested')
  if (phase === 'streaming') return t('message.compaction.phase.streaming')
  if (phase === 'done') return t('message.compaction.phase.done')
  if (phase === 'failed') return t('message.compaction.failed')
  return node.windows === null
    ? t('message.compaction.running')
    : t('message.compaction.windowedRunning', { windows: node.windows })
}

/**
 * The live status line + expandable detail panel for one running (or stopped)
 * compaction.
 */
function CompactionLivePanel({
  node,
  t,
  cancel,
}: {
  node: CompactionSummaryNode
  t: ChatViewSlotProps['t']
  cancel: CancelCompaction
}) {
  const [open, setOpen] = useState(false)
  const live = node.live
  const running = node.status === 'running'
  return (
    <div className={css.compactionRow} data-compaction-status={node.status} data-compaction-live-phase={live?.phase}>
      <button
        type="button"
        className={css.compactionButton}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.compactionTitle}>{t('message.compaction')}</span>
        {running && <span className={css.compactionSpinner} data-compaction-spinner aria-hidden />}
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary} data-compaction-live-status role="status">
          {phaseLabel(node, t)}
        </span>
        {live !== undefined && live.maxTokens !== null
          && (
            <span className={css.compactionStats} data-compaction-live-maxtokens>
              {t('message.compaction.maxOut', { tokens: live.maxTokens })}
            </span>
          )}
        <span className={css.compactionDisclosureIcon} data-compaction-disclosure={open ? 'expanded' : 'collapsed'}>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {running && live !== undefined
        && (
          <button
            type="button"
            className={css.compactionStats}
            data-compaction-stop
            onClick={() => { cancel(String(live.compactionId)) }}
          >
            {t('message.compaction.stop')}
          </button>
        )}
      {open
        && (
          <div className={css.compactionBody} data-compaction-live-details>
            <div>{t('message.compaction.details')}</div>
            <div>{t('message.compaction.maxOut', { tokens: live?.maxTokens ?? node.live?.maxTokens ?? 0 })}</div>
            <div>{t('message.compaction.reasoning')}</div>
            <pre style={streamStyle} data-compaction-live-reasoning>{live?.reasoning === '' ? '…' : (live?.reasoning ?? '…')}</pre>
            <div>{t('message.compaction.output')}</div>
            <pre style={streamStyle} data-compaction-live-output>{live?.output === '' ? '…' : (live?.output ?? '…')}</pre>
          </div>
        )}
    </div>
  )
}

/** Whether this row should use the live presentation instead of the settled card. */
function usesLiveRow(node: CompactionSummaryNode): boolean {
  return node.status === 'cancelled' || (node.status === 'running' && node.live !== undefined)
}

/**
 * Factory: the `compaction` chat-node renderer with the stop action bound.
 * @param cancel - cancels one running compaction by identity.
 * @returns the keyed renderer component.
 */
export function createCompactionNodeView(cancel: CancelCompaction) {
  return memo(function CompactionLiveNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
    const data = node.data
    if (usesLiveRow(data)) return <CompactionLivePanel node={data} t={t} cancel={cancel} />
    return <CompactionItem node={data} t={t} />
  })
}

/**
 * Factory: the `manual-compaction` chat-node renderer — the shipped command
 * card plus the live panel while the transaction runs or after an operator stop.
 * @param cancel - cancels one running compaction by identity.
 * @returns the keyed renderer component.
 */
export function createManualCompactionLiveNodeView(cancel: CancelCompaction) {
  return memo(function ManualCompactionLiveNodeView({ node, t }: ChatNodeViewProps<'manual-compaction'>) {
    const data = node.data
    const compaction = data.compaction
    return (
      <div className={rowCss.callRow}>
        <CompactionCommandCard
          node={data.command}
          {...compaction === null ? {} : { compaction }}
          t={t}
        />
        {compaction !== null && usesLiveRow(compaction)
          && <CompactionLivePanel node={compaction} t={t} cancel={cancel} />}
      </div>
    )
  })
}
