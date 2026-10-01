// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.
//
// The row is deliberately two-phase: while the summarizer is still running it
// names the model and the context size that went in, and once the checkpoint
// lands it reports what came back plus the share of context removed. Both halves
// come from the same durable lifecycle events, so a reload shows exactly what a
// live row showed.

import { memo, useMemo, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import css from './MessageItem.module.css'

interface CompactionItemProps {
  node: CompactionSummaryNode
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/** One decimal place is enough to show a ratio moving and avoids false precision. */
function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`
}

/**
 * Renders the model-history compaction marker.
 * @param props - the marker node off the snapshot cache.
 * @returns the marker row, with the summary disclosure when one is available.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  title,
  fallbackSummary,
  t,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  const expandable = node.summary !== null
  const open = expandable && expanded
  const running = node.status === 'running'
  const summary = running
    ? (node.windows === null
      ? t('message.compaction.running')
      : t('message.compaction.windowedRunning', { windows: node.windows }))
    : node.status === 'failed'
      ? fallbackSummary ?? t('message.compaction.failed')
      : node.shadowedItemCount !== null && node.shadowedTokenCount !== null
        ? t('message.compaction.completed', {
          items: node.shadowedItemCount,
          tokens: node.shadowedTokenCount,
        })
        : fallbackSummary
          ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'))
  // The model is named from whichever lifecycle event reached the window first,
  // so a live row answers "which model is compacting" before the model replies.
  const modelLabel = node.model ?? node.provider
  // "In" is the context the model was handed; "out" is the checkpoint it wrote.
  // While running only the incoming figure is known, and the row says so rather
  // than showing a placeholder that looks like a measurement.
  const incoming = node.contextTotalTokens
  const outgoing = node.replacementTokenCount
  return (
    <div className={css.compactionRow} data-compaction-status={node.status}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutline14 />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle}>{title ?? t('message.compaction')}</span>
        {running && <span className={css.compactionSpinner} data-compaction-spinner aria-hidden />}
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{summary}</span>
        {modelLabel !== null
          && <span className={css.compactionModel} data-compaction-model>{modelLabel}</span>}
        {node.status === 'landed' && node.windows !== null
          && <span className={css.compactionSummary}>{t('message.compaction.windowedDone', { windows: node.windows })}</span>}
        {incoming !== null
          && (
            <span className={css.compactionStats} data-compaction-stat="in">
              {t('message.compaction.inTokens', { tokens: incoming })}
            </span>
          )}
        {outgoing !== null
          && (
            <span className={css.compactionStats} data-compaction-stat="out">
              {t('message.compaction.outTokens', { tokens: outgoing })}
            </span>
          )}
        {node.reductionRatio !== null
          && (
            <span
              className={css.compactionRatio}
              data-compaction-stat="ratio"
              title={t('message.compaction.ratioTitle')}
            >
              ↓{percent(node.reductionRatio)}
            </span>
          )}
      </button>
      {open && node.summary !== null
        && <div className={css.compactionBody}><MarkdownText text={node.summary} labels={labels} /></div>}
    </div>
  )
})
