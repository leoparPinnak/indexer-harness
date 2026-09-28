/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button,
  ConnectionIndicator,
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
  Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

function IconPowerOutline16({ size = 16, className }: { size?: number | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 4.5A5.5 5.5 0 1 0 11.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog focuses the close button; the root restores its trigger on close.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const [shuttingDown, setShuttingDown] = useState(false)
  const [shutdownComplete, setShutdownComplete] = useState(false)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])

  const isOperating = shuttingDown

  const closePowerModal = useCallback(() => {
    if (isOperating) return
    setShutdownOpen(false)
    setShutdownComplete(false)
  }, [isOperating])

  const handleShutdown = useCallback(async () => {
    setShuttingDown(true)
    try {
      await fetch('/api/server/shutdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      setShutdownComplete(true)
    } catch {
      setShutdownComplete(true)
    } finally {
      setShuttingDown(false)
    }
  }, [])

  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting') {
    connectionIndicator = 'connecting'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        <button
          ref={triggerButton}
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={t('trigger')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          {renderSlot('settings.trigger', { wide })}
        </button>
        <ConnectionIndicator
          state={wide ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          reconnectLabel={t('connection.retry')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
        <Tooltip label={t('shutdown.trigger')} delayMs={500} disabled={false}>
          <button
            type="button"
            className={clsx(css.shutdownTrigger, !wide && css.rail)}
            aria-label={t('shutdown.trigger')}
            onClick={() => { setShutdownOpen(true) }}
          >
            <IconPowerOutline16 size={wide ? 16 : 18} />
          </button>
        </Tooltip>
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      <Modal
        open={shutdownOpen}
        onClose={closePowerModal}
        title={t('shutdown.title')}
        closeLabel={t('shutdown.cancel')}
        footer={
          !shutdownComplete ? (
            <Button
              variant="outline"
              onClick={closePowerModal}
            >
              {t('shutdown.cancel')}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={closePowerModal}
            >
              {t('close')}
            </Button>
          )
        }
      >
        {shutdownComplete ? (
          <p className={css.shutdownDesc}>
            {t('shutdown.completed')}
          </p>
        ) : (
          <div className={css.powerModalContent}>
            <div className={css.powerOptions}>
              <button
                type="button"
                className={clsx(css.powerCard, css.powerCardDanger)}
                onClick={() => { void handleShutdown() }}
                disabled={shuttingDown}
              >
                <div className={css.powerCardIcon}>
                  <IconPowerOutline16 size={16} />
                </div>
                <div className={css.powerCardText}>
                  <div className={css.powerCardTitle}>
                    {shuttingDown ? t('shutdown.shuttingDown') : t('shutdown.trigger')}
                  </div>
                  <div className={css.powerCardDesc}>{t('shutdown.description')}</div>
                </div>
              </button>
            </div>
          </div>
        )}
      </Modal>
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
