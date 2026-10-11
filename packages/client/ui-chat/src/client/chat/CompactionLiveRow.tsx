// The live compaction row: one always-visible STATUS line for the running
// summarizer (stage + progress + announced model + "request sent — awaiting
// response", "summary streaming…", "stopped"), an expandable DETAIL panel that
// AUTO-OPENS while the run is live (rolling stage LOG, outgoing maxTokens, the
// model's reasoning stream, the raw summary stream), and a DURDUR (stop) button
// that cancels the transaction NEUTRALLY. Settled rows defer to the shipped
// CompactionItem / CompactionCommandCard presentations.

import { memo, useEffect, useState } from 'react'
import type {
  CompactionLiveView,
  CompactionSummaryNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import css from './MessageItem.module.css'
import rowCss from './ChatView.module.css'

/** Cancels one running compaction by its transaction identity. */
export type CancelCompaction = (compactionId: string) => void

/** Block-copy style shared by the stream panes of the detail panel. */
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

/** Keys of the chat locale seat — keeps the maps below compile-checked. */
type ChatKey = Parameters<ChatViewSlotProps['t']>[0]

/** Short phase word for the dense stage log. */
const PHASE_SHORT: Record<CompactionLiveView['phase'], ChatKey> = {
  requested: 'message.compaction.phaseShort.requested',
  streaming: 'message.compaction.phaseShort.streaming',
  done: 'message.compaction.phaseShort.done',
  failed: 'message.compaction.phaseShort.failed',
  cancelled: 'message.compaction.phaseShort.cancelled',
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

function stageLabel(
  t: ChatViewSlotProps['t'],
  stage: CompactionLiveView['call']['stage'],
): string {
  if (stage === 'window') return t('message.compaction.stage.window')
  if (stage === 'merge') return t('message.compaction.stage.merge')
  return t('message.compaction.stage.summary')
}

/** Human call position: "pencere 2/3", "birleştirme 2", "özet 1". */
function callLabel(
  t: ChatViewSlotProps['t'],
  call: CompactionLiveView['call'],
): string {
  const index = call.index + 1
  return call.total === null
    ? t('message.compaction.callSolo', { stage: stageLabel(t, call.stage), index })
    : t('message.compaction.call', { stage: stageLabel(t, call.stage), index, total: call.total })
}

/** Announced summarizer route: "provider/model", narrowed to whichever exists. */
function routeLabel(node: CompactionSummaryNode): string | null {
  if (node.model !== null && node.provider !== null) return `${node.provider}/${node.model}`
  return node.model ?? node.provider
}

/**
 * The live status line + auto-opening detail panel for one running (or stopped)
 * compaction.
 */
function CompactionLivePanel({
  node,
  t,
  cancel,
}: {
  node: CompactionSummaryNode
  t: ChatViewSlotProps['t']
  cancel?: CancelCompaction
}) {
  const [open, setOpen] = useState(false)
  const live = node.live
  const running = node.status === 'running'
  const route = routeLabel(node)
  const cancelId = live?.compactionId
    ?? (typeof node.compactionId === 'string' ? node.compactionId : null)
  // The operator asked to watch the process AS it runs: the detail panel opens
  // itself at run start. Manual toggling still wins afterwards.
  useEffect(() => {
    if (running) setOpen(true)
  }, [running])
  const logLines = (live?.log ?? []).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString()
    return `${time} · ${callLabel(t, entry.call)} · ${t(PHASE_SHORT[entry.phase])}`
  })
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
          {live !== undefined && <> · {callLabel(t, live.call)}</>}
        </span>
        {route !== null
          && <span className={css.compactionStats} data-compaction-live-model>{route}</span>}
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
      {running && cancel !== undefined && cancelId !== null
        && (
          <button
            type="button"
            className={css.compactionStats}
            data-compaction-stop
            onClick={() => { cancel(cancelId) }}
          >
            {t('message.compaction.stop')}
          </button>
        )}
      {open
        && (
          <div className={css.compactionBody} data-compaction-live-details>
            <div>{t('message.compaction.details')}</div>
            {route !== null && <div data-compaction-live-route>{t('message.compaction.model', { model: route })}</div>}
            {node.contextTotalTokens !== null
              && <div>{t('message.compaction.inTokens', { tokens: node.contextTotalTokens })}</div>}
            <div>{t('message.compaction.maxOut', { tokens: live?.maxTokens ?? node.live?.maxTokens ?? 0 })}</div>
            <div>{t('message.compaction.log')}</div>
            <pre style={streamStyle} data-compaction-live-log>
              {logLines.length === 0 ? '…' : logLines.join('\n')}
            </pre>
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
  // A running row shows its live panel even before the first frame: the stage
  // log, the announced route and STOP belong to the process, not the stream.
  return node.status === 'cancelled' || node.status === 'running'
}

/**
 * Factory: the `compaction` chat-node renderer. The stop action arrives with the
 * session-scoped node props (`cancelCompaction`), so it always targets this
 * view's own Session; the image loader rides the same lane for media previews.
 * @returns the keyed renderer component.
 */
export function createCompactionNodeView() {
  return memo(function CompactionLiveNodeView({
    node,
    t,
    cancelCompaction,
    loadImage,
  }: ChatNodeViewProps<'compaction'>) {
    const data = node.data
    if (usesLiveRow(data)) {
      return (
        <CompactionLivePanel
          node={data}
          t={t}
          {...cancelCompaction === undefined ? {} : { cancel: cancelCompaction }}
        />
      )
    }
    return (
      <CompactionItem
        node={data}
        t={t}
        {...loadImage === undefined ? {} : { loadImage }}
      />
    )
  })
}

/**
 * Factory: the `manual-compaction` chat-node renderer — the shipped command
 * card plus the live panel while the transaction runs or after an operator stop.
 * @returns the keyed renderer component.
 */
export function createManualCompactionLiveNodeView() {
  return memo(function ManualCompactionLiveNodeView({
    node,
    t,
    cancelCompaction,
    loadImage,
  }: ChatNodeViewProps<'manual-compaction'>) {
    const data = node.data
    const compaction = data.compaction
    return (
      <div className={rowCss.callRow}>
        <CompactionCommandCard
          node={data.command}
          {...compaction === null ? {} : { compaction }}
          t={t}
          {...loadImage === undefined ? {} : { loadImage }}
        />
        {compaction !== null && usesLiveRow(compaction)
          && (
            <CompactionLivePanel
              node={compaction}
              t={t}
              {...cancelCompaction === undefined ? {} : { cancel: cancelCompaction }}
            />
          )}
      </div>
    )
  })
}
