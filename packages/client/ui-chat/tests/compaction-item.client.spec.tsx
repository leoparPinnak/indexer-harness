// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { CompactionItem } from '../src/client/chat/CompactionItem.tsx'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locale.ts'
import type { CompactionSummaryNode } from '../src/client/contract/snapshot.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as ChatViewSlotProps['t']

const marker = (over: Partial<CompactionSummaryNode> = {}): CompactionSummaryNode => ({
  kind: 'compaction',
  seq: 8,
  time: 8_000,
  status: 'landed',
  summary: 'kept facts',
  summaryEventSeq: 7,
  shadowedItemCount: 16,
  shadowedTokenCount: 11_309,
  windows: null,
  ...over,
})

const item = (node: CompactionSummaryNode) => render(<CompactionItem node={node} t={t} />)

describe('CompactionItem lifecycle phases', () => {
  it('announces a windowed run live while the transaction has not settled', () => {
    const view = item(marker({ status: 'running', summary: null, summaryEventSeq: null, windows: 3 }))
    expect(view.getByText('正在分窗口摘要（3 个窗口）…')).toBeTruthy()
  })

  it('keeps the window count on the landed marker as its own reading', () => {
    const view = item(marker({ windows: 3 }))
    expect(view.getByText('已压缩 16 条历史记录（约 11309 tokens）')).toBeTruthy()
    expect(view.getByText('已摘要 3 个窗口')).toBeTruthy()
  })

  it('reports a failed compaction instead of an empty summary placeholder', () => {
    const view = item(marker({ status: 'failed', summary: null, summaryEventSeq: null }))
    expect(view.getByText('压缩失败')).toBeTruthy()
  })

  it('prefers the command settlement text over the failure wording when supplied', () => {
    const view = render(
      <CompactionItem node={marker({ status: 'failed', summary: null, summaryEventSeq: null })} t={t} fallbackSummary="cancelled" />,
    )
    expect(view.getByText('cancelled')).toBeTruthy()
  })

  it('falls back to the plain running reading without a window count', () => {
    const view = item(marker({ status: 'running', summary: null, summaryEventSeq: null }))
    expect(view.getByText('正在压缩…')).toBeTruthy()
  })
})
