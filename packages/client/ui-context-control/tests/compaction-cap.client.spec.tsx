// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { CompactionCap } from '../src/client/CompactionCapSetting.tsx'
import type { CompactionCapProps } from '../src/client/CompactionCapSetting.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as CompactionCapProps['t']

describe('CompactionCap', () => {
  it('shows the deployment default greyed and writes each settled value', async () => {
    const writes: Array<number | undefined> = []
    const view = render(
      <CompactionCap
        {...({
          usePanelInfo: () => undefined,
          useSessions: () => undefined,
          useSessionPendingInteraction: () => undefined,
          useWorkspaces: () => undefined,
          useResource: () => undefined,
        } as unknown as CompactionCapProps)}
        t={t}
        readCap={() => Promise.resolve(undefined)}
        writeCap={(value) => {
          writes.push(value)
          return Promise.resolve()
        }}
      />,
    )
    const field = view.getByLabelText('压缩上限（tokens）') as HTMLInputElement
    // Unset keeps the plugin default as the greyed placeholder.
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('8192')
    fireEvent.change(field, { target: { value: '16384' } })
    await waitFor(() => { expect(writes.at(-1)).toBe(16_384) })
    // Whitespace-only clears the field back to the deployment default.
    fireEvent.change(field, { target: { value: '   ' } })
    await waitFor(() => { expect(writes).toEqual([16_384, undefined]) })
  })
})