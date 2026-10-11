// Operator RESUME button — composer right cluster beside send/stop. The
// control NEVER hides silently after a cut: a `ready` verdict renders the
// active "Devam" pill (pressing continues the flow from the checkpoint in the
// NORMAL turn stream, a `turn/start.continuation`-marked turn, never a hidden
// retry); a cut with nothing to resume renders a DIMMED pill carrying the
// reason. A running turn (busy) or a normally-ended turn (not-cut) renders
// only the diagnostic span — the stop button or nothing is truthful there.
//
// The verdict arrives in EITHER form the seats use — a folded VALUE or a
// reader closure — and `resolveState` handles both. The wrapper span also
// mirrors WHICH form arrived (`data-resume-face`), so a mis-wired seat can
// never masquerade as an empty feed again.

import { memo, useEffect, useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'

/** Structural copy of the shared journal fold's verdict (see `evaluateResumeState`). */
interface ResumeStateValue {
  readonly kind: string
  readonly checkpoint?: { readonly turn: number; readonly step: number }
}

/**
 * Mirror of the conversation contract's `ComposerResumeState` face (value OR
 * recursive reader) — kept structural so the seat's assignability holds across
 * the package boundary without a cross-package source import.
 */
type ComposerResumeStateMirror =
  | { readonly kind: 'ready'; readonly checkpoint: { readonly turn: number; readonly step: number } }
  | { readonly kind: 'busy' | 'not-cut' | 'no-checkpoint' | 'unknown' }
  | (() => ComposerResumeStateMirror)

/** Dispatch result the button reports inline on failure. */
type ResumeDispatch = () => Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>

interface ResumeButtonProps {
  /** Owner-face verdict — the contract's value-or-reader union, resolved fresh per render. */
  resumeState?: ComposerResumeStateMirror | undefined
  /** Session-scoped dispatch — the binding's `resume()` closure. */
  resume?: ResumeDispatch | undefined
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

const buttonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  borderRadius: 14,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

/** Dimmed companion pill: the resume slot is spoken for, but cannot run. */
const blockedStyle: React.CSSProperties = {
  ...buttonStyle,
  cursor: 'default',
  opacity: 0.45,
  background: 'var(--dsw-alias-interactive-bg-hover-solid)',
  color: 'var(--dsw-alias-label-secondary)',
}

const errorStyle: React.CSSProperties = {
  marginLeft: 8,
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
}

/**
 * Resolve the verdict from whichever owner form supplied it. The contract's
 * reader form is itself recursive (`() => ComposerResumeState`), so unwrap
 * until a value remains.
 * @param face - a folded value or a (possibly nested) reader closure.
 * @returns the verdict value, or undefined when neither supplies one.
 */
function resolveState(face: ComposerResumeStateMirror | undefined): ResumeStateValue | undefined {
  let current: ComposerResumeStateMirror | undefined = face
  for (let hops = 0; hops < 4; hops += 1) {
    if (current === undefined) return undefined
    if (typeof current === 'function') {
      try {
        current = current()
      } catch {
        return undefined
      }
      continue
    }
    return current as ResumeStateValue
  }
  return undefined
}

/**
 * The RESUME affordance. One honest predicate (the shared journal fold), one
 * session-scoped dispatch, and a permanent visible slot after a cut.
 * @param props - owner-face verdict, dispatch closure, and locale seat.
 * @returns the resume control for the current verdict (always with diagnostics).
 */
export const ResumeButton = memo(function ResumeButton({ resumeState, resume, t }: ResumeButtonProps) {
  const [error, setError] = useState<string | null>(null)
  // LIVENESS: the verdict is folded over an event window that fills (and
  // mutates) AFTER this seat's first render — the cut lands, history pages in.
  // A render-once seat freezes `not-cut` forever (the silent-pill bug). Tick
  // while mounted so the fold re-runs against the CURRENT window; cheap
  // (one pure fold per tick) and honest (the pill is live state, not a frozen
  // guess). An event-driven subscription can replace this ticker later.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => { setTick(value => value + 1) }, 700)
    return () => { clearInterval(id) }
  }, [])
  const state = resolveState(resumeState)
  const checkpoint = state?.checkpoint
  const kind = state?.kind ?? 'unavailable'
  const faceKind = resumeState === undefined ? 'none' : typeof resumeState
  const wrap = (content: React.ReactNode): React.JSX.Element => (
    <span data-resume-state={kind} data-resume-face={faceKind}>{content}</span>
  )
  // Cut but nothing completed to re-drive: say WHY instead of vanishing.
  if (state !== undefined && state.kind === 'no-checkpoint') {
    return wrap(
      <button type="button" style={blockedStyle} disabled data-resume-blocked title={t('resume.noCheckpoint')}>
        {t('resume.blocked')}
      </button>,
    )
  }
  if (state === undefined || state.kind !== 'ready' || checkpoint === undefined || resume === undefined) {
    return wrap(null)
  }
  return wrap(
    <>
      <button
        type="button"
        style={buttonStyle}
        data-resume-button
        data-resume-checkpoint={`${String(checkpoint.turn)}.${String(checkpoint.step)}`}
        title={t('resume.tooltip')}
        onClick={() => {
          setError(null)
          resume().then(
            (result) => { if (!result.ok) setError(result.error?.message ?? 'resume failed') },
            (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) },
          )
        }}
      >
        {t('resume.button')}
      </button>
      {error !== null
        && <span style={errorStyle} role="alert" data-resume-error>{t('resume.failed', { error })}</span>}
    </>,
  )
})
