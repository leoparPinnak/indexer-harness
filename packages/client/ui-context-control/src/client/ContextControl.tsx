import { memo, useEffect, useMemo, useRef, useState } from 'react'
// Type-only: the compactionPolicy / contextPressure / contextBreakdown / modelSelection key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { CompactionSessionMode } from '@deepseek-ai/dsh-compaction'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { contextOccupancy } from './context-occupancy.ts'
import type { ContextControlKey } from './locales.ts'
import css from './ContextControl.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`). A NUL code point built
 * programmatically keeps the source free of a literal control character.
 */
const READING_SLOT = String.fromCharCode(0)

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

/** Delay between the last slider move and the durable mode write. */
const SAVE_DEBOUNCE_MS = 300

/** Provider-grouped model names offered to the dedicated-summarizer pickers. */
export interface SummarizerModelGroup {
  provider: string
  models: readonly string[]
}

/** Catalog-derived capacities behind the fresh-session occupancy fallback. */
export interface ModelCatalogContexts {
  /** Deployment default selection: what an unconfigured session runs. */
  default: { provider: string; model: string }
  /** Every catalog model beside the route capacity its adapter reports. */
  models: readonly { provider: string; model: string; contextWindow?: number }[]
}

/** Registrant-supplied operations and copy for the context control. */
export interface ContextControlInjected {
  /** Context-control locale seat. */
  t: (key: ContextControlKey, params?: Readonly<Record<string, string | number>>) => string
  /** Submit the compact command for this Session; rejects when the host refuses. */
  runCompact: () => Promise<void>
  /** Install one whole-value compaction mode for this Session. */
  saveCompactionMode: (mode: CompactionSessionMode) => Promise<void>
  /** Provider-grouped routable model names for the dedicated pickers. */
  loadSummarizerModels: () => Promise<readonly SummarizerModelGroup[]>
  /** Model capacities and the default selection, for the meter before a request. */
  loadModelContexts: () => Promise<ModelCatalogContexts>
}

/** Full props of the composer context control. */
export type ContextControlProps =
  PropsRuntime<'conversation.input.context'>
  & InjectFace<ContextControlInjected>

/**
 * Format a token count for the compact context panel.
 * @param value - token count.
 * @param t - context-control locale seat with compact-number templates.
 * @returns Compact localized count using K or M when needed.
 */
function formatTokens(
  value: number,
  t: ContextControlInjected['t'],
): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

/**
 * Draft of the compaction-mode form. The sliders address their figure as a
 * percentage of the model capacity and of the effective budget, so moving one
 * keeps the other meaningful; the auto switches leave the field out of the
 * durable mode entirely.
 */
interface ModeDraft {
  dedicated: boolean
  provider: string
  model: string
  budgetAuto: boolean
  budgetPercent: number
  thresholdAuto: boolean
  thresholdPercent: number
  capAuto: boolean
  capValue: number
  imagesAuto: boolean
  imagesValue: number
}

const percentOf = (part: number, whole: number | null | undefined, fallback: number): number =>
  whole === null || whole === undefined || whole <= 0
    ? fallback
    : Math.min(100, Math.max(0, Math.round(part / whole * 100)))

const draftOf = (
  mode: CompactionSessionMode | null | undefined,
  view: {
    contextBudgetTokens: number | null
    thresholdTokens: number | null
    modelCapacity: number | null
    maxTokens?: number
  } | undefined,
): ModeDraft => {
  const budget = view?.contextBudgetTokens ?? null
  const threshold = view?.thresholdTokens ?? null
  return {
    dedicated: mode?.summarizer === 'dedicated',
    provider: mode?.summarizer === 'dedicated' ? mode.provider : '',
    model: mode?.summarizer === 'dedicated' ? mode.model : '',
    budgetAuto: mode?.contextBudgetTokens === undefined,
    budgetPercent: percentOf(budget ?? view?.modelCapacity ?? 0, view?.modelCapacity, 100),
    thresholdAuto: mode?.thresholdTokens === undefined,
    thresholdPercent: percentOf(threshold ?? 0, budget, 80),
    capAuto: mode?.maxTokens === undefined,
    capValue: mode?.maxTokens ?? view?.maxTokens ?? 8192,
    // `0` is the mode validator's "replay no images" window; the default
    // follows the deployment (the newest ONE image rides inline).
    imagesAuto: mode?.keepLatestImages === undefined,
    imagesValue: mode?.keepLatestImages ?? 1,
  }
}

/**
 * Assemble one whole-value mode from the form draft.
 * @param draft - current form values.
 * @param capacity - routed model capacity, the budget slider base.
 * @returns the mode to install.
 */
function modeOf(draft: ModeDraft, capacity: number | null): CompactionSessionMode {
  const budget = draft.budgetAuto || capacity === null
    ? undefined
    : Math.max(1, Math.round(capacity * draft.budgetPercent / 100))
  const effectiveBudget = budget ?? capacity
  const threshold = draft.thresholdAuto || effectiveBudget === null
    ? undefined
    : Math.max(1, Math.round(effectiveBudget * draft.thresholdPercent / 100))
  return {
    ...(draft.dedicated
      ? { summarizer: 'dedicated' as const, provider: draft.provider.trim(), model: draft.model.trim() }
      : { summarizer: 'conversation' as const }),
    ...budget === undefined ? {} : { contextBudgetTokens: budget },
    ...threshold === undefined ? {} : { thresholdTokens: threshold },
    ...draft.capAuto ? {} : { maxTokens: draft.capValue },
    ...draft.imagesAuto ? {} : { keepLatestImages: draft.imagesValue },
  }
}

/** Whether a draft's mode can be committed: the dedicated route needs both fields. */
function modeCommittable(mode: CompactionSessionMode): boolean {
  return mode.summarizer !== 'dedicated'
    || (mode.provider.length > 0 && mode.model.length > 0)
}

/**
 * Scope marker: a red chip reads as deployment-wide (the configured default),
 * a green chip as this session's own override.
 * @param props - which scope to name and the locale seat.
 * @returns the chip.
 */
function ScopeBadge(
  { global, t }: { global: boolean; t: ContextControlInjected['t'] },
) {
  return (
    <span className={`${css.scopeBadge} ${global ? css.scopeGlobal : css.scopeSession}`}>
      {global ? t('scope.global') : t('scope.session')}
    </span>
  )
}

/**
 * Composer context control: one occupancy ring that opens a panel with the
 * live figures, the per-session trigger point and context budget sliders, the
 * summarization strategy with the summary cap beside it, and the manual
 * compaction action.
 * @param props - owner share (locked, useProjection) plus the injected face.
 * @returns the ring, or nothing before both pressure and capacity are known.
 */
export const ContextControl = memo(function ContextControl({
  locked,
  useProjection,
  t,
  runCompact,
  saveCompactionMode,
  loadSummarizerModels,
  loadModelContexts,
}: ContextControlProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const policy = useProjection('compactionPolicy')
  const selection = useProjection('modelSelection')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ModeDraft>(() => draftOf(policy?.mode, policy))
  const [status, setStatus] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [groups, setGroups] = useState<readonly SummarizerModelGroup[]>([])
  const [contexts, setContexts] = useState<ModelCatalogContexts | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const seededRef = useRef<string>('')
  const seedKeyRef = useRef<string | null>(null)
  // The meter runs on the session's own model: the queued pick, then the model
  // the last request logged, then the deployment default.
  const fallbackCapacity = useMemo(() => {
    if (contexts === null) return undefined
    const current = selection?.next ?? selection?.lastUsed ?? contexts.default
    return contexts.models.find(entry =>
      entry.provider === current.provider && entry.model === current.model)?.contextWindow
  }, [contexts, selection])
  const context = contextOccupancy(pressure, fallbackCapacity)
  const available = context !== null

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  // Outside click / Escape close, one document listener while open (Menu's pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // The form re-seeds when the panel opens and whenever the durable facts it
  // mirrors actually move. A projection identity change that carries the same
  // mode and capacity must not clobber a half-typed field or wipe the status:
  // this panel's own saves land as projection updates too.
  useEffect(() => {
    if (!open) {
      seedKeyRef.current = null
      return
    }
    const seedKey = JSON.stringify([policy?.mode ?? null, policy?.modelCapacity ?? null])
    if (seedKeyRef.current === seedKey) return
    const firstSeed = seedKeyRef.current === null
    seedKeyRef.current = seedKey
    const seeded = draftOf(policy?.mode, policy)
    const capacity = policy?.modelCapacity ?? null
    if (JSON.stringify(modeOf(seeded, capacity)) !== JSON.stringify(modeOf(draft, capacity))) {
      setDraft(seeded)
    }
    if (firstSeed) setStatus(null)
  }, [open, policy, draft])

  // The dedicated pickers load once per open: the model catalog is not part of
  // the durable mode round-trip.
  useEffect(() => {
    if (!open) return
    void loadSummarizerModels().then(setGroups, () => { setGroups([]) })
  }, [open, loadSummarizerModels])

  // Capacities feed the ring before the panel opens, so this loads on mount;
  // a refused read leaves the meter on request-reported capacity alone.
  useEffect(() => {
    void loadModelContexts().then(setContexts, () => { setContexts(null) })
  }, [loadModelContexts])

  // One durable write per settled slider move or field edit: dragging updates
  // the readouts live and the mode commits after the gesture pauses.
  useEffect(() => {
    if (!open) return
    const mode = modeOf(draft, policy?.modelCapacity ?? null)
    if (JSON.stringify(mode) === seededRef.current) return
    // An empty dedicated pair is not a valid mode; commit once both fields
    // are filled instead of sending a write the host must reject.
    if (!modeCommittable(mode)) return
    const timer = setTimeout(() => {
      seededRef.current = JSON.stringify(mode)
      saveCompactionMode(mode).then(
        () => { setStatus(t('settings.saved')) },
        (error: unknown) => {
          setStatus(t('settings.failed', { error: error instanceof Error ? error.message : String(error) }))
        },
      )
    }, SAVE_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [draft, open, policy, saveCompactionMode, t])

  const capacity = policy?.modelCapacity ?? null
  const budgetTokens = policy?.contextBudgetTokens ?? null
  const triggerTokens = policy?.thresholdTokens ?? null
  const liveBudget = draft.budgetAuto || capacity === null
    ? budgetTokens
    : Math.max(1, Math.round(capacity * draft.budgetPercent / 100))
  const liveTrigger = draft.thresholdAuto || liveBudget === null
    ? triggerTokens
    : Math.max(1, Math.round(liveBudget * draft.thresholdPercent / 100))

  if (context === null) return null
  const percent = context.percent
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())

  // The bar's overall length stays the provider-exact percent; the heuristic
  // breakdown only proportions its colored parts. A zero-width part is dropped
  // instead of rendered: `.segment`'s min-width keeps a hairline part visible,
  // which at 0% occupancy would draw a filled bar over an empty context.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)
  const slidersReady = capacity !== null && capacity > 0

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('context.aria', { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('context.aria', { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('context.used')}>
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            {/* `~`: usedTokens prefers projectedTokens, whose surface delta is
                heuristically repriced on top of the provider-anchored sample. */}
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens, t)} / ${formatTokens(context.contextWindow, t)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <dl className={css.rows}>
              {ROWS.map(row => (
                <div key={row.key} className={css.row}>
                  <dt>
                    <span className={`${css.swatch} ${row.color}`} aria-hidden />
                    {t(row.label)}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key], t)}`}</dd>
                </div>
              ))}
            </dl>
          )}

          <fieldset className={css.form}>
            <legend>{t('settings.budget')}<span className={css.figure}>
              {liveBudget === null
                ? t('settings.auto')
                : `~${formatTokens(liveBudget, t)}`}
            </span><ScopeBadge global={draft.budgetAuto} t={t} /></legend>
            <div className={css.sliderRow}>
              <input
                type="range"
                className={css.slider}
                min={10}
                max={100}
                step={1}
                disabled={draft.budgetAuto || !slidersReady}
                value={draft.budgetPercent}
                aria-label={t('settings.budget')}
                onChange={(e) => {
                  setDraft({ ...draft, budgetAuto: false, budgetPercent: Number(e.target.value) })
                }}
              />
              <label className={css.autoToggle}>
                <input
                  type="checkbox"
                  checked={draft.budgetAuto}
                  onChange={(e) => { setDraft({ ...draft, budgetAuto: e.target.checked }) }}
                />
                {t('settings.auto')}
              </label>
            </div>
          </fieldset>

          <fieldset className={css.form}>
            <legend>{t('settings.trigger')}<span className={css.figure}>
              {liveTrigger === null
                ? t('settings.auto')
                : `~${formatTokens(liveTrigger, t)}`}
            </span><ScopeBadge global={draft.thresholdAuto} t={t} /></legend>
            <div className={css.sliderRow}>
              <input
                type="range"
                className={css.slider}
                min={5}
                max={95}
                step={1}
                disabled={draft.thresholdAuto || !slidersReady}
                value={draft.thresholdPercent}
                aria-label={t('settings.threshold')}
                onChange={(e) => {
                  setDraft({ ...draft, thresholdAuto: false, thresholdPercent: Number(e.target.value) })
                }}
              />
              <label className={css.autoToggle}>
                <input
                  type="checkbox"
                  checked={draft.thresholdAuto}
                  onChange={(e) => { setDraft({ ...draft, thresholdAuto: e.target.checked }) }}
                />
                {t('settings.auto')}
              </label>
            </div>
          </fieldset>

          <fieldset className={css.form}>
            <legend>{t('settings.images')}<span className={css.figure}>
              {draft.imagesAuto
                ? t('settings.auto')
                : String(draft.imagesValue)}
            </span><ScopeBadge global={draft.imagesAuto} t={t} /></legend>
            <div className={css.sliderRow}>
              <input
                type="range"
                className={css.slider}
                min={0}
                max={16}
                step={1}
                disabled={draft.imagesAuto}
                value={draft.imagesValue}
                aria-label={t('settings.images')}
                onChange={(e) => {
                  setDraft({ ...draft, imagesAuto: false, imagesValue: Number(e.target.value) })
                }}
              />
              <label className={css.autoToggle}>
                <input
                  type="checkbox"
                  checked={draft.imagesAuto}
                  onChange={(e) => { setDraft({ ...draft, imagesAuto: e.target.checked }) }}
                />
                {t('settings.auto')}
              </label>
            </div>
          </fieldset>

          <div className={css.bottomGrid}>
            <fieldset className={css.form}>
              <legend>{t('settings.strategy')}</legend>
              <label className={css.radioRow}>
                <input
                  type="radio"
                  name="context-summarizer"
                  checked={!draft.dedicated}
                  onChange={() => { setDraft({ ...draft, dedicated: false }) }}
                />
                <span>{t('settings.strategy.conversation')}</span>
                <ScopeBadge global t={t} />
              </label>
              <label className={css.radioRow}>
                <input
                  type="radio"
                  name="context-summarizer"
                  checked={draft.dedicated}
                  onChange={() => { setDraft({ ...draft, dedicated: true }) }}
                />
                <span>{t('settings.strategy.dedicated')}</span>
                <ScopeBadge global={false} t={t} />
              </label>
              {draft.dedicated && (
                <div className={css.row}>
                  <label>
                    {t('settings.provider')}
                    <input
                      className={css.input}
                      list="context-summarizer-providers"
                      value={draft.provider}
                      onChange={(e) => { setDraft({ ...draft, provider: e.target.value }) }}
                    />
                  </label>
                  <label>
                    {t('settings.model')}
                    <input
                      className={css.input}
                      list="context-summarizer-models"
                      value={draft.model}
                      onChange={(e) => { setDraft({ ...draft, model: e.target.value }) }}
                    />
                  </label>
                  <datalist id="context-summarizer-providers">
                    {groups.map(group => <option key={group.provider} value={group.provider} />)}
                  </datalist>
                  <datalist id="context-summarizer-models">
                    {groups.flatMap(group => group.models.map(model => (
                      <option key={`${group.provider}/${model}`} value={model} />
                    )))}
                  </datalist>
                </div>
              )}
            </fieldset>

            <fieldset className={`${css.form} ${css.capField}`}>
              <legend>{t('settings.summaryCap')}<span className={css.figure}>
                {`~${formatTokens(draft.capAuto ? policy?.maxTokens ?? draft.capValue : draft.capValue, t)}`}
              </span><ScopeBadge global={draft.capAuto} t={t} /></legend>
              <div className={css.sliderRow}>
                <input
                  type="range"
                  className={css.slider}
                  min={1024}
                  max={65536}
                  step={1024}
                  disabled={draft.capAuto}
                  value={draft.capValue}
                  aria-label={t('settings.summaryCap')}
                  onChange={(e) => {
                    setDraft({ ...draft, capAuto: false, capValue: Number(e.target.value) })
                  }}
                />
                <label className={css.autoToggle}>
                  <input
                    type="checkbox"
                    checked={draft.capAuto}
                    onChange={(e) => { setDraft({ ...draft, capAuto: e.target.checked }) }}
                  />
                  {t('settings.auto')}
                </label>
              </div>
            </fieldset>
          </div>

          <div className={css.footerRow}>
            <button
              type="button"
              className={css.liquidGlassButton}
              disabled={locked || compacting}
              onClick={() => {
                if (compacting) return
                setCompacting(true)
                setStatus(t('compact.running'))
                runCompact().then(
                  () => {
                    setStatus(null)
                    setCompacting(false)
                  },
                  (error: unknown) => {
                    setStatus(t('compact.failed', { error: error instanceof Error ? error.message : String(error) }))
                    setCompacting(false)
                  },
                )
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden className={css.glassIcon}>
                <path
                  d="M8 1.5L9.6 5.8L14.5 7.5L9.6 9.2L8 14.5L6.4 9.2L1.5 7.5L8 1.5Z"
                  fill="rgba(147, 197, 253, 0.9)"
                  stroke="rgba(255, 255, 255, 0.8)"
                  strokeWidth="0.8"
                />
              </svg>
              <span className={css.glassLabel}>{t('compact.run')}</span>
            </button>
            {status !== null && <span role="status" className={css.sliderFigures}>{status}</span>}
          </div>
        </div>
      )}
    </span>
  )
})
