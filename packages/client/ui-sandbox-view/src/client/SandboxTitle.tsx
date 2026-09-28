/**
 * The sandbox type's chip title: a monitor before the type's label. Registered
 * under `sidebar.right.pane.tab.title`; without it the chip would show the bare
 * label. The dedicated glyph lives here until the shared icon set carries a
 * display shape.
 */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SandboxBody.module.css'

/**
 * The monitor: a screen over its stand, drawn on `currentColor` so each
 * rendering picks its own ink.
 * @param props - rendered size and class.
 * @returns the monitor glyph.
 */
export function MonitorGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="1.6" y="2.6" width="12.8" height="8.8" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M 5.6 13.4 H 10.4 M 8 11.4 V 13.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the monitor followed by the tab's title text.
 */
export function SandboxTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <MonitorGlyph className={css.titleIcon} />
      {tab.title}
    </>
  )
}
