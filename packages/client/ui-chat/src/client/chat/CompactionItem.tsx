// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.
//
// The row is deliberately two-phase: while the summarizer is still running it
// names the model and the context size that went in, and once the checkpoint
// lands it reports what came back plus the share of context removed. Both halves
// come from the same durable lifecycle events, so a reload shows exactly what a
// live row showed. The expanded body also carries the MEDIA ACCOUNTING: how many
// images entered the compacted context, how many were withheld behind
// placeholders, the payload characters recovered (with a rough token estimate),
// and a preview strip of the images themselves.

import { memo, useEffect, useMemo, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
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
  /**
   * Session-authorized image loader for the media preview strip; absent on
   * surfaces without an image lane, in which case the figures still render.
   */
  loadImage?: ChatNodeViewProps['loadImage']
}

/** Thumbnail presentation shared by the media preview strip. */
const thumbStyle: React.CSSProperties = {
  width: 64,
  height: 64,
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid rgba(127, 127, 127, 0.35)',
}

const thumbStripStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  margin: '6px 0 10px',
}

/** One decimal place is enough to show a ratio moving and avoids false precision. */
function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`
}

type Preview = CompactionSummaryNode['media'] extends infer _
  ? NonNullable<CompactionSummaryNode['media']>['previews'][number]
  : never

/**
 * One preview thumbnail: the session image loader resolves asynchronously, so
 * the tile starts as an empty frame and fills when its URL lands. Unresolvable
 * previews stay as a labeled frame rather than a broken image.
 */
function PreviewThumb({
  preview,
  loadImage,
  t,
}: {
  preview: Preview
  loadImage: NonNullable<ChatNodeViewProps['loadImage']>
  t: ChatViewSlotProps['t']
}) {
  const [src, setSrc] = useState<string | null>(null)
  const label = preview.name ?? preview.mediaType
  useEffect(() => {
    let live = true
    void Promise.resolve(
      loadImage({
        attachmentId: preview.attachmentId,
        name: preview.name ?? undefined,
        bytes: preview.bytes,
        mediaType: preview.mediaType,
      } as unknown as Parameters<NonNullable<ChatNodeViewProps['loadImage']>>[0]),
    ).then((url) => { if (live) setSrc(url) }, () => { if (live) setSrc(null) })
    return () => { live = false }
  }, [loadImage, preview])
  const title = `${label} · ${preview.disposition === 'kept'
    ? t('message.compaction.media.kept')
    : t('message.compaction.media.pruned')}`
  return (
    <img
      src={src ?? undefined}
      alt={t('message.compaction.media.preview', { name: label })}
      title={title}
      style={{
        ...thumbStyle,
        ...(preview.disposition === 'pruned' ? { opacity: 0.55 } : {}),
        ...(src === null ? { background: 'rgba(127, 127, 127, 0.12)' } : {}),
      }}
      data-media-disposition={preview.disposition}
    />
  )
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
  loadImage,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  const expandable = node.summary !== null
  const open = expandable && expanded
  const running = node.status === 'running'
  const media = node.media ?? null
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
        {media !== null
          && (
            <span className={css.compactionStats} data-compaction-stat="media">
              {t('message.compaction.media.images', {
                images: media.images,
                pruned: media.imagesPruned,
                kept: media.imagesKept,
              })}
            </span>
          )}
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
      {open
        && (
          <div className={css.compactionBody}>
            {media !== null
              && (
                <div data-compaction-media>
                  <div>{t('message.compaction.media.title')}</div>
                  <div>
                    {t('message.compaction.media.images', {
                      images: media.images,
                      pruned: media.imagesPruned,
                      kept: media.imagesKept,
                    })}
                  </div>
                  {media.inlineRunsPruned > 0
                    && <div>{t('message.compaction.media.runs', { runs: media.inlineRunsPruned })}</div>}
                  <div>
                    {t('message.compaction.media.saved', {
                      chars: media.charactersPruned,
                      tokens: media.tokensPrunedEstimate,
                    })}
                  </div>
                  {loadImage !== undefined && media.previews.length > 0
                    && (
                      <div style={thumbStripStyle} data-compaction-media-previews>
                        {media.previews.map(preview => (
                          <PreviewThumb
                            key={`${preview.attachmentId}-${preview.disposition}`}
                            preview={preview}
                            loadImage={loadImage}
                            t={t}
                          />
                        ))}
                      </div>
                    )}
                </div>
              )}
            {node.summary !== null && <MarkdownText text={node.summary} labels={labels} />}
          </div>
        )}
    </div>
  )
})
