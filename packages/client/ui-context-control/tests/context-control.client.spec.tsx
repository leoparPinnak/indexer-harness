// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { CompactionSessionMode } from '@deepseek-ai/dsh-compaction'
import { ContextControl } from '../src/client/ContextControl.tsx'
import type { ContextControlInjected, ContextControlProps } from '../src/client/ContextControl.tsx'
import { contextOccupancy } from '../src/client/context-occupancy.ts'
import css from '../src/client/ContextControl.module.css'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as ContextControlInjected['t']
const tEn = makeTranslate(en, commonEn) as ContextControlInjected['t']

const BREAKDOWN = { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 }
const POLICY = {
  mode: { summarizer: 'conversation' },
  modelCapacity: 128_000,
  contextBudgetTokens: 128_000,
  thresholdTokens: 102_400,
}

const segmentClass = css.segment
if (segmentClass === undefined) throw new Error('segment class missing from ContextControl.module.css')

interface Calls {
  compact: number
  saved: CompactionSessionMode[]
}

function control(
  values: Record<string, unknown>,
  translate: ContextControlInjected['t'] = t,
  locked = false,
): { view: ReturnType<typeof render>; calls: Calls } {
  const calls: Calls = { compact: 0, saved: [] }
  const view = render(
    <ContextControl
      {...{
        locked,
        sessionId: 'session-1',
        useSession: () => undefined,
      } as unknown as ContextControlProps}
      useProjection={(key: string) => values[key]}
      t={translate}
      runCompact={() => { calls.compact += 1 }}
      saveCompactionMode={(mode) => {
        calls.saved.push(mode)
        return Promise.resolve()
      }}
      loadSummarizerModels={() => Promise.resolve([{ provider: 'big', models: ['big-1'] }])}
    />,
  )
  return { view, calls }
}

const withContext = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
  contextBreakdown: BREAKDOWN,
  compactionPolicy: POLICY,
  ...extra,
})

describe('context occupancy', () => {
  it('computes occupancy only when both a numerator and capacity are known', () => {
    expect(contextOccupancy({ pressureTokens: 32_000, projectedTokens: 6_000, contextWindow: 128_000 }))
      .toEqual({ percent: 5, usedTokens: 6_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000, contextWindow: 128_000 }))
      .toEqual({ percent: 25, usedTokens: 32_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000 })).toBeNull()
    expect(contextOccupancy({ contextWindow: 128_000 })).toBeNull()
    expect(contextOccupancy(undefined)).toBeNull()
    expect(contextOccupancy({ pressureTokens: 300_000, contextWindow: 128_000 })?.percent).toBe(100)
  })
})

describe('ContextControl', () => {
  it('renders nothing until both pressure and capacity are known', () => {
    expect(control({}).view.container.textContent).toBe('')
    expect(control({ contextPressure: { pressureTokens: 32_000 } }).view.container.textContent).toBe('')
    expect(control({ contextPressure: { contextWindow: 128_000 } }).view.container.textContent).toBe('')
  })

  it('keeps only the ring in the composer row', () => {
    const { view } = control(withContext())
    // The row is the ring alone: every action lives behind it in the panel.
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
  })

  it('shows the ring, the breakdown panel, and both live figures', () => {
    const { view } = control(withContext())
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const panel = view.container.querySelector('[role="dialog"]')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).toContain('25%')
    expect(panel.textContent).toContain('触发点')
    expect(panel.textContent).toContain('~102K')
    expect(panel.textContent).toContain('~128K')
    expect(panel.textContent).toContain('系统提示词~120')
    expect(panel.textContent).toContain('工具定义~21.5K')
    expect(panel.textContent).toContain('对话消息~477K')
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(3)
  })

  it('reads the ring from the projected figure so a compaction shows at once', () => {
    const { view } = control(withContext({
      contextPressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 },
    }))
    fireEvent.click(view.getByRole('button', { name: '上下文已用 2%' }))
    expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain('~3K / 128K')
  })

  it('draws no bar segment at zero occupancy', () => {
    const { view } = control(withContext({
      contextPressure: { pressureTokens: 0, contextWindow: 128_000 },
    }))
    fireEvent.click(view.getByRole('button', { name: '上下文已用 0%' }))
    expect(view.container.querySelector('[role="dialog"]')!.getElementsByClassName(segmentClass)).toHaveLength(0)
  })

  it('runs the compact command from the panel and refuses while the composer is locked', () => {
    const open = control(withContext())
    fireEvent.click(open.view.getByRole('button', { name: '上下文已用 25%' }))
    fireEvent.click(open.view.getByRole('button', { name: '压缩' }))
    expect(open.calls.compact).toBe(1)
    cleanup()

    const locked = control(withContext(), t, true)
    fireEvent.click(locked.view.getByRole('button', { name: '上下文已用 25%' }))
    expect((locked.view.getByRole('button', { name: '压缩' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('commits the sliders as one settled mode write, live figures included', async () => {
    const { view, calls } = control(withContext())
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))

    // Moving the budget slider leaves its auto switch and prices 75% of the
    // 128K capacity; the readout follows live.
    fireEvent.change(view.getByLabelText('上下文预算（tokens）'), { target: { value: '75' } })
    expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain('~96K')
    // Moving the trigger slider resolves 60% of that live budget.
    fireEvent.change(view.getByLabelText('触发点（tokens）'), { target: { value: '60' } })
    expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain('~57.6K')
    // The summary cap is its own absolute figure and follows the same gesture.
    fireEvent.change(view.getByLabelText('压缩上限（tokens）'), { target: { value: '16384' } })
    expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain('~16.4K')
    await waitFor(() => {
      expect(calls.saved.at(-1)).toEqual({
        summarizer: 'conversation',
        contextBudgetTokens: 96_000,
        thresholdTokens: 57_600,
        maxTokens: 16_384,
      })
    })

    // Back to the deployment default: each override leaves the durable mode.
    for (const auto of view.getAllByRole('checkbox', { name: '跟随默认值' })) {
      fireEvent.click(auto)
    }
    await waitFor(() => {
      expect(calls.saved.at(-1)).toEqual({ summarizer: 'conversation' })
    })
  })

  it('marks every slider session-scoped and only the chat-model strategy global', () => {
    const { view } = control(withContext())
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    // Only the chat-model option reads global; the three sliders and the dedicated
    // strategy write this session's mode and never a deployment setting.
    expect(view.getAllByText('全局')).toHaveLength(1)
    expect(view.getAllByText('仅本会话')).toHaveLength(4)
    fireEvent.change(view.getByLabelText('上下文预算（tokens）'), { target: { value: '75' } })
    expect(view.getAllByText('全局')).toHaveLength(1)
    expect(view.getAllByText('仅本会话')).toHaveLength(4)
  })

  it('routes the dedicated strategy with its picked provider and model', async () => {
    const { view, calls } = control(withContext())
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    fireEvent.click(view.getByLabelText(/专用摘要模型/))
    fireEvent.change(view.getByLabelText('提供商'), { target: { value: 'big' } })
    fireEvent.change(view.getByLabelText('模型'), { target: { value: 'big-1' } })
    await waitFor(() => {
      expect(calls.saved.at(-1)).toEqual({ summarizer: 'dedicated', provider: 'big', model: 'big-1' })
    })
  })

  it('lets each locale own the headline word order around the reading', () => {
    const values = withContext()
    const zhView = control(values).view
    fireEvent.click(zhView.getByRole('button', { name: '上下文已用 25%' }))
    expect(zhView.container.querySelector('[role="dialog"]')!.textContent).toMatch(/上下文已用\s*25%/)
    const enView = control(values, tEn).view
    fireEvent.click(enView.getByRole('button', { name: '25% of context used' }))
    expect(enView.container.querySelector('[role="dialog"]')!.textContent).toMatch(/25%of context used/)
  })

  it('closes on outside pointerdown and Escape — but not inside clicks', () => {
    const { view } = control(withContext())
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    const openPanel = () => {
      fireEvent.click(trigger)
      return view.container.querySelector('[role="dialog"]')!
    }
    const again = openPanel()
    fireEvent.pointerDown(again)
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
  })
})
