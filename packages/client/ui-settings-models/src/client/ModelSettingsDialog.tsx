/**
 * Per-model settings window: everything `settings.yml` carries for one model
 * row — capacities, input modalities, and reasoning efforts — with the
 * adapter's own defaults shown greyed when a field is unset. The window edits
 * the row's draft; ModelListEditor mirrors each settled change straight into
 * `settings.yml`.
 */

import { useState, type ReactNode } from 'react'
import type { ModelDraft } from './ModelListEditor.tsx'
import styles from './ModelsSection.module.css'

/** Modality names the window always offers, whatever the row lists. */
const MODALITIES = [
  { key: 'text', label: 'modelInputText' },
  { key: 'image', label: 'modelInputImage' },
  { key: 'audio', label: 'modelInputAudio' },
  { key: 'video', label: 'modelInputVideo' },
] as const

/**
 * Magnitudes a capacity slider steps through, doubling each stop; the text
 * field stays free-form for values off this ladder.
 */
const CAPACITY_STEPS = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304]

/** Effort names a row carries before its own list is written. */
const DEFAULT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Nearest slider stop for one stored count.
 * @param value - stored count, or undefined when unset.
 * @returns the stop index the slider rests at.
 */
function nearestStep(value: number | undefined): number {
  if (value === undefined) return 0
  let best = 0
  for (let index = 1; index < CAPACITY_STEPS.length; index += 1) {
    const candidate = CAPACITY_STEPS[index] ?? 0
    const resting = CAPACITY_STEPS[best] ?? 0
    if (Math.abs(Math.log2(candidate / value)) < Math.abs(Math.log2(resting / value))) best = index
  }
  return best
}

/** Adapter route-level fallback magnitudes, spelled the way a person would. */
const FALLBACK: Readonly<Record<'contextWindow' | 'maxTokens', string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

/**
 * Spell a stored count as K/M-suffixed text; empty for an unset field.
 * @param value - stored count.
 * @returns the field text.
 */
function spelling(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${String(Math.round(value / 100) / 10)}K`
  return `${String(Math.round(value / 100_000) / 10)}M`
}

/**
 * Parse K/M-suffixed or plain text into a stored count.
 * @param text - field text.
 * @returns the count, or undefined for empty or unreadable text.
 */
function parse(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase()
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(trimmed)
  if (match === null) return undefined
  const amount = Number(match[1])
  const scale = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  const value = Math.round(amount * scale)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The modalities a row lists, from either field name the adapters use. */
function modalitiesOf(model: ModelDraft): readonly string[] {
  const listed = model['input'] ?? model['inputModalities']
  return Array.isArray(listed) ? listed.filter(entry => typeof entry === 'string') : ['text']
}

/** One model row's settings window. */
export interface ModelSettingsDialogProps {
  /** The row being edited; unknown keys ride through untouched. */
  model: ModelDraft
  /** The provider's own `defaultContextWindow` / `defaultMaxTokens`, when set. */
  defaults: { contextWindow?: number; maxTokens?: number }
  /** Whether the whole form refuses interaction. */
  disabled: boolean
  /** Dictionary seat of the settings.models namespace. */
  t: (key: string) => string
  /** Patch the row; cleared fields leave the profile. */
  onPatch: (next: Record<string, string | number | boolean | string[] | Record<string, string> | undefined>) => void
  /** Close the window. */
  onClose: () => void
}

/**
 * Render one model's complete settings window.
 * @param props - the row, its adapter defaults, and the edit callbacks.
 * @returns the settings window.
 */
export function ModelSettingsDialog(props: ModelSettingsDialogProps): ReactNode {
  const { model, defaults, disabled, t, onPatch, onClose } = props
  const [effortDraft, setEffortDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const efforts = model['reasoningEfforts']
  const effortsOff = efforts === false
  const effortMap: Record<string, string> = effortsOff || efforts === undefined || Array.isArray(efforts)
    ? {}
    : efforts as Record<string, string>
  const modalities = modalitiesOf(model)
  const contextWindow = typeof model['contextWindow'] === 'number' ? model['contextWindow'] : undefined
  const maxTokens = typeof model['maxTokens'] === 'number' ? model['maxTokens'] : undefined
  const effectiveWindow = contextWindow ?? defaults.contextWindow
  const effectiveCap = maxTokens ?? defaults.maxTokens
  const inputCapacity = effectiveWindow === undefined || effectiveCap === undefined
    ? undefined
    : Math.max(0, effectiveWindow - effectiveCap)

  const capacityField = (key: 'contextWindow' | 'maxTokens', label: string): ReactNode => {
    const rawVal = typeof model[key] === 'number' ? model[key] as number : undefined
    const currentVal = rawVal ?? defaults[key]
    const currentSpelling = spelling(rawVal)
    const placeholderSpelling = defaults[key] === undefined ? FALLBACK[key] : spelling(defaults[key])
    const displayBadge = currentSpelling !== '' ? currentSpelling : placeholderSpelling

    return (
      <div className={styles['capacityCard']}>
        <div className={styles['capacityHeader']}>
          <span className={styles['capacityLabel']}>{t(label)}</span>
          <span className={styles['capacityBadge']}>{displayBadge}</span>
        </div>
        <input
          className={styles['slider']}
          type="range"
          min={0}
          max={CAPACITY_STEPS.length - 1}
          step={1}
          value={nearestStep(currentVal)}
          aria-label={`${t(label)} ${String(model['id'] ?? '')} slider`}
          disabled={disabled}
          onChange={(event) => { onPatch({ [key]: CAPACITY_STEPS[Number(event.target.value)] }) }}
        />
        <div className={styles['capacityInputRow']}>
          <input
            className={styles['input']}
            type="text"
            inputMode="numeric"
            value={currentSpelling}
            placeholder={placeholderSpelling}
            aria-label={`${t(label)} ${String(model['id'] ?? '')}`}
            disabled={disabled}
            onChange={(event) => { onPatch({ [key]: parse(event.target.value) }) }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={styles['dialogScrim']} role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
    >
      <div className={styles['dialog']} role="dialog" aria-label={`${t('modelSettings')} ${String(model['id'] ?? '')}`}>
        <div className={styles['dialogHead']}>
          <span className={styles['dialogTitle']}>{`${t('modelSettings')} — ${String(model['id'] ?? '')}`}</span>
          <button type="button" className={styles['iconButton']} aria-label={t('close')} onClick={onClose}>
            ✕
          </button>
        </div>

        {capacityField('contextWindow', 'modelContextWindow')}
        {capacityField('maxTokens', 'modelMaxTokens')}
        <div className={styles['statBanner']}>
          <span className={styles['statBannerLabel']}>{t('modelInputCapacity')}</span>
          <span className={styles['statBannerValue']}>
            {inputCapacity === undefined
              ? t('modelInputCapacityUnknown')
              : spelling(inputCapacity)}
          </span>
        </div>

        <fieldset className={styles['dialogGroup']}>
          <legend>{t('modelInputs')}</legend>
          <div className={styles['modalityGrid']}>
            {MODALITIES.map(modality => {
              const active = modalities.includes(modality.key)
              return (
                <label
                  key={modality.key}
                  className={`${styles['modalityChip']} ${active ? styles['modalityChipActive'] : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...modalities.filter(entry => entry !== modality.key), modality.key]
                        : modalities.filter(entry => entry !== modality.key)
                      onPatch({ input: next })
                    }}
                  />
                  <span>{t(modality.label)}</span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <fieldset className={styles['dialogGroup']}>
          <div className={styles['capacityHeader']}>
            <legend className={styles['groupLegend']}>{t('modelEfforts')}</legend>
            <label className={styles['checkRow']}>
              <input
                type="checkbox"
                checked={!effortsOff}
                disabled={disabled}
                onChange={(event) => {
                  onPatch({ reasoningEfforts: event.target.checked
                    ? (Object.keys(effortMap).length === 0 ? { high: 'high' } : effortMap)
                    : false })
                }}
              />
              {t('modelEffortsEnabled')}
            </label>
          </div>
          {!effortsOff && (
            <>
              {Object.entries(effortMap).length === 0
                ? (
                  <>
                    <div className={styles['effortMutedList']}>
                      {DEFAULT_EFFORTS.map(key => (
                        <div key={key} className={styles['effortMutedChip']}>{key}</div>
                      ))}
                    </div>
                    <p className={styles['fieldHint']}>{t('effortsHint')}</p>
                  </>
                )
                : (
                  <div className={styles['effortList']}>
                    {Object.entries(effortMap).map(([key, value]) => (
                      <div
                        key={key}
                        className={`${styles['effortCard']} ${model['reasoning'] === key ? styles['effortCardActive'] : ''}`}
                      >
                        <input
                          type="radio"
                          className={styles['effortRadio']}
                          name={`effort-default-${String(model['id'] ?? '')}`}
                          checked={model['reasoning'] === key}
                          aria-label={`${t('defaultEffort')} ${key}`}
                          disabled={disabled}
                          onChange={() => { onPatch({ reasoning: key }) }}
                        />
                        <span className={styles['effortName']}>{key}</span>
                        <span className={styles['effortWire']}>{value}</span>
                        <button
                          type="button"
                          className={styles['iconButton']}
                          aria-label={`${t('removeEffort')} ${key}`}
                          disabled={disabled}
                          onClick={() => {
                            const next = { ...effortMap }
                            delete next[key]
                            onPatch({
                              reasoningEfforts: next,
                              ...model['reasoning'] === key ? { reasoning: undefined } : {},
                            })
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              <div className={styles['effortRow']}>
                <button
                  type="button"
                  className={styles['linkButton']}
                  disabled={disabled}
                  onClick={() => { setAdding(true) }}
                >
                  {t('addEffortLevel')}
                </button>
              </div>
              {adding && (
                <div className={styles['effortRow']}>
                  <input
                    className={styles['input']}
                    type="text"
                    value={effortDraft}
                    placeholder={t('effortPlaceholder')}
                    aria-label={t('addEffort')}
                    disabled={disabled}
                    autoFocus
                    onChange={(event) => { setEffortDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      const key = effortDraft.trim()
                      if (key === '' || effortMap[key] !== undefined) return
                      onPatch({ reasoningEfforts: { ...effortMap, [key]: key } })
                      setEffortDraft('')
                      setAdding(false)
                    }}
                  />
                  <button
                    type="button"
                    className={styles['linkButton']}
                    disabled={disabled || effortDraft.trim() === ''}
                    onClick={() => {
                      const key = effortDraft.trim()
                      if (key === '' || effortMap[key] !== undefined) return
                      onPatch({ reasoningEfforts: { ...effortMap, [key]: key } })
                      setEffortDraft('')
                      setAdding(false)
                    }}
                  >
                    {t('addEffort')}
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
      </div>
    </div>
  )
}