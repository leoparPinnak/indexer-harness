// @vitest-environment jsdom
/**
 * The Plan tab body: the Current pane over the plan the host projection
 * carries, and the History pane over the plans it superseded.
 *
 * The body holds no plan state of its own, so the cases here pin what it reads
 * and renders: an absent capability equals an absent plan, the newest plan
 * renders as a document with its apply verb, the history lists every earlier
 * plan with its localized stamp, and the opened-plan mark the declared store
 * carries decides whether the Current sub-tab announces a new plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PlanPresentation, PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PlanTabBody, type PlanTabBodyProps } from '../src/client/PlanTabBody.tsx'
import { createPlanTabStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The framework-injected t seat, stubbed over the zh dictionaries (the source key set).
const t: PlanTabBodyProps['t'] = makeTranslate(zh, commonZh)

/** Local wall-clock epoch milliseconds, so the stamp assertions hold in any time zone. */
const clock = (month: number, day: number, hour: number, minute: number): number =>
  new Date(2026, month - 1, day, hour, minute).getTime()

/** One presented plan as the host fold carries it. */
const plan = (markdown: string, title: string | null, at: number): PlanPresentation => ({ plan: markdown, title, at })

/** One projection value: the newest entry is `presented`, as the host fold orders it. */
const projection = (
  history: readonly PlanPresentation[] = [],
  overrides: Partial<PlanProjection> = {},
): PlanProjection => ({ active: false, pending: false, presented: history[0] ?? null, history, ...overrides })

/**
 * Mount the body over one plan projection.
 * @param value - the projection value, or undefined for an absent capability.
 * @param applyPlan - the injected apply verb.
 * @param instance - the plan-tab store instance to mount over; pass one to keep the mark across mounts.
 * @returns the projection store, the plan-tab store instance, the verb spy, and the render handle.
 */
function setup(
  value: PlanProjection | undefined,
  applyPlan = vi.fn(() => Promise.resolve<string | null>(null)),
  instance = createPlanTabStore().create(),
) {
  const store = createSnapshotStore<{ value: PlanProjection | undefined }>({ value })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = {
    useProjection,
    useStore: bindSnapshotSelector(instance),
    actions: instance.actions,
    applyPlan,
    t,
  } as unknown as PlanTabBodyProps
  const view = render(<PlanTabBody {...props} />)
  return { store, instance, applyPlan, view }
}

const subTab = (pane: 'current' | 'history'): HTMLElement =>
  document.querySelector(`[data-plan-subtab="${pane}"]`) as HTMLElement
const marker = (): Element | null => document.querySelector('[data-plan-new]')
const badge = (): Element | null => document.querySelector('[data-plan-history-count]')
const applyButton = (): Element | null => document.querySelector('[data-plan-apply]')
const apply = (): void => { fireEvent.click(applyButton() as Element) }

describe('PlanTabBody', () => {
  it('shows the empty line while no plan is presented', () => {
    setup(undefined)
    expect(screen.getByRole('status').textContent).toBe('本次会话还没有提交过计划。')
    cleanup()
    setup(projection())
    expect(screen.getByRole('status').textContent).toBe('本次会话还没有提交过计划。')
  })

  it('omits the apply button while no plan is presented', () => {
    setup(undefined)
    expect(applyButton()).toBeNull()
    cleanup()
    setup(projection())
    expect(applyButton()).toBeNull()
  })

  it('renders the presented plan as Markdown with the apply button', () => {
    setup(projection([plan('# Loader\n\n- first\n- second', 'Loader', clock(1, 2, 3, 4))]))
    expect(screen.getByRole('heading', { name: 'Loader' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['first', 'second'])
    expect(screen.queryByRole('status')).toBeNull()
    expect(applyButton()?.textContent).toBe('应用计划')
  })

  it('follows the projection to a newer plan', async () => {
    const { store } = setup(projection([plan('# First', 'First', clock(1, 1, 9, 0))]))
    expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy()
    store.set({
      value: projection([plan('# Second', 'Second', clock(1, 1, 10, 0)), plan('# First', 'First', clock(1, 1, 9, 0))]),
    })
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy() })
    expect(screen.queryByRole('heading', { name: 'First' })).toBeNull()
  })

  it('badges the History sub-tab with the past-plan count only', () => {
    setup(projection([
      plan('# C', 'C', clock(1, 3, 9, 0)),
      plan('# B', 'B', clock(1, 2, 9, 0)),
      plan('# A', 'A', clock(1, 1, 9, 0)),
    ]))
    expect(badge()?.textContent).toBe('2')
    cleanup()
    setup(projection([plan('# Only', 'Only', clock(1, 3, 9, 0))]))
    expect(badge()).toBeNull()
    cleanup()
    setup(undefined)
    expect(badge()).toBeNull()
  })

  it('lists every earlier plan with its title and stamp, and renders the selected one', () => {
    setup(projection([
      plan('# Newest', 'Newest', clock(1, 3, 9, 5)),
      plan('# Second', 'Second', clock(1, 2, 18, 30)),
      plan('# Third', null, clock(1, 1, 7, 0)),
    ]))
    fireEvent.click(subTab('history'))
    expect([...document.querySelectorAll('[data-plan-history-row]')].map(row => row.textContent)).toEqual([
      'Second2026-1-2 18:30',
      '未命名计划2026-1-1 07:00',
    ])
    expect(screen.queryByRole('heading', { name: 'Second' })).toBeNull()

    const rows = document.querySelectorAll('[data-plan-history-row]')
    fireEvent.click(rows[1] as Element)
    expect(screen.getByRole('heading', { name: 'Third' })).toBeTruthy()
    expect(document.querySelectorAll('[data-plan-history-row]')[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('[data-plan-history-row]')[0]?.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows the history empty line when the newest plan is the only one', () => {
    setup(projection([plan('# Only', 'Only', clock(1, 3, 9, 0))]))
    fireEvent.click(subTab('history'))
    expect(document.querySelector('[data-plan-history-empty]')?.textContent).toBe('本次会话还没有更早的计划。')
    expect(document.querySelector('[data-plan-history-list]')).toBeNull()
    expect(document.querySelector('[data-plan-history-document]')).toBeNull()
  })

  it('applies the plan through the injected verb and stays silent on success', async () => {
    const { applyPlan } = setup(projection([plan('# Only', 'Only', clock(1, 3, 9, 0))]))
    apply()
    expect(applyPlan).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the injected failure line under the button', async () => {
    const applyPlan = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup(projection([plan('# Only', 'Only', clock(1, 3, 9, 0))]), applyPlan)

    apply()
    await waitFor(() => {
      expect(document.querySelector('[data-plan-apply-failed]')?.textContent).toBe('应用计划失败: host said no')
    })

    apply()
    await waitFor(() => {
      expect(document.querySelector('[data-plan-apply-failed]')?.textContent).toBe('应用计划失败: network down')
    })

    apply()
    await waitFor(() => {
      expect(document.querySelector('[data-plan-apply-failed]')?.textContent).toBe('应用计划失败: socket closed')
    })
    expect(applyPlan).toHaveBeenCalledTimes(3)
  })

  it('announces an unopened plan on the Current sub-tab and clears the mark on entry', async () => {
    const first = plan('# A', 'A', clock(1, 1, 9, 0))
    const second = plan('# B', 'B', clock(1, 2, 9, 0))
    const { store, instance } = setup(projection([first]))
    // Opening the tab on the Current pane records the newest plan as read.
    await waitFor(() => { expect(instance.getSnapshot().seenAt).toBe(first.at) })
    expect(marker()).toBeNull()

    fireEvent.click(subTab('history'))
    store.set({ value: projection([second, first]) })
    await waitFor(() => { expect(marker()?.textContent).toBe('新') })
    // A reader on the History pane has not opened the newer plan.
    expect(instance.getSnapshot().seenAt).toBe(first.at)

    fireEvent.click(subTab('current'))
    await waitFor(() => { expect(marker()).toBeNull() })
    expect(instance.getSnapshot().seenAt).toBe(second.at)

    fireEvent.click(subTab('history'))
    expect(marker()).toBeNull()
  })

  it('keeps the opened-plan mark across a remount of the body', async () => {
    const first = plan('# A', 'A', clock(1, 1, 9, 0))
    const second = plan('# B', 'B', clock(1, 2, 9, 0))
    const instance = createPlanTabStore().create()
    const opened = setup(projection([first]), undefined, instance)
    await waitFor(() => { expect(instance.getSnapshot().seenAt).toBe(first.at) })
    opened.view.unmount()

    setup(projection([second, first]), undefined, instance)
    // The remount opens on Current again, so the newer plan is recorded rather than announced.
    await waitFor(() => { expect(instance.getSnapshot().seenAt).toBe(second.at) })
    fireEvent.click(subTab('history'))
    expect(marker()).toBeNull()
  })
})
