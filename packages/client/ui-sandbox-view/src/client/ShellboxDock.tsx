/**
 * The Shellbox dock entry in the conversation composer dock row (`conversation.composer.dock`).
 * Displays a virtualization toggle chip and opens the VirtualizationDashboard.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from './locales.ts'
import { VirtualizationDashboard } from './VirtualizationDashboard.tsx'
import css from './ShellboxDock.module.css'

export type ShellboxDockProps =
  & PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'sandboxView'>
  & { readonly openSidebarShellbox?: ((sessionId?: string) => void) | undefined }

function MonitorIcon({ size = 13, className }: { size?: number | undefined; className?: string | undefined }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v8a1.5 1.5 0 0 1-1.5 1.5h-4.5v1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h2V12H2.5A1.5 1.5 0 0 1 1 10.5v-8zm1.5-.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5h-11z" />
    </svg>
  )
}

export function ShellboxDock({
  sessionId,
  useSessions,
  t,
  openSidebarShellbox,
}: ShellboxDockProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [activeCount, setActiveCount] = useState<number | undefined>(undefined)
  const sessionsById = useSessions(s => s.byId)

  useEffect(() => {
    let cancelled = false
    const checkCount = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/server/sandbox/instances?session=${encodeURIComponent(sessionId)}`)
        if (res.ok && !cancelled) {
          const data = await res.json() as { ok: boolean; instances: Array<{ boundSessionIds: string[] }> }
          if (data.ok && Array.isArray(data.instances)) {
            const myCount = data.instances.filter(i => i.boundSessionIds.includes(sessionId)).length
            setActiveCount(myCount)
          }
        }
      } catch {
        // Ignore network errors
      }
    }
    void checkCount()
    return () => { cancelled = true }
  }, [sessionId, open])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const countDisplay = typeof activeCount === 'number' && activeCount > 0
    ? ` (${String(activeCount)})`
    : ''

  return (
    <div className={css.dock} data-shellbox-dock>
      <button
        type="button"
        className={open ? css.chipActive : css.chip}
        aria-pressed={open}
        aria-label={t('dock.tooltip')}
        title={t('dock.tooltip')}
        onClick={() => { setOpen(!open) }}
      >
        <MonitorIcon size={13} className={css.icon} />
        <span>{t('dock.label')}{countDisplay}</span>
      </button>

      {open ? (
        <VirtualizationDashboard
          sessionId={sessionId}
          sessionsById={sessionsById}
          t={t}
          onClose={() => { setOpen(false) }}
          onOpenSidebar={openSidebarShellbox}
        />
      ) : null}
    </div>
  )
}
