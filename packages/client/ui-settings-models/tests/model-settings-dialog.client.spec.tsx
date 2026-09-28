// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { ModelSettingsDialog } from '../src/client/ModelSettingsDialog.tsx'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as (key: string) => string

const MODEL: ModelDraft = {
  id: 'mimo-v2.6-pro',
  contextWindow: 1_048_576,
  maxTokens: 32_768,
  input: ['text', 'image'],
  reasoningEfforts: { minimal: 'minimal', high: 'high', superx: 'superx' },
  reasoning: 'high',
}

function dialog(over: Partial<Parameters<typeof ModelSettingsDialog>[0]> = {}, translate: (key: string) => string = t) {
  const patches: Array<Record<string, unknown>> = []
  const view = render(
    <ModelSettingsDialog
      model={over.model ?? MODEL}
      defaults={over.defaults ?? { contextWindow: 262_144, maxTokens: 32_768 }}
      disabled={false}
      t={translate}
      onPatch={(next) => { patches.push(next) }}
      onClose={() => {}}
    />,
  )
  return { view, patches }
}

describe('ModelSettingsDialog', () => {
  it('marks the designated default effort and moves the designation on click', () => {
    const { view, patches } = dialog()
    const selected = view.getByLabelText('默认等级 high') as HTMLInputElement
    expect(selected.checked).toBe(true)
    fireEvent.click(view.getByLabelText('默认等级 superx'))
    expect(patches.at(-1)).toEqual({ reasoning: 'superx' })
  })

  it('adds an effort row through the add flow instead of a standing input', () => {
    const { view, patches } = dialog()
    // The standing field is behind the add button now.
    expect(view.queryByPlaceholderText('例如 superx')).toBeNull()
    fireEvent.click(view.getByText('添加等级'))
    fireEvent.change(view.getByPlaceholderText('例如 superx'), { target: { value: 'ultra' } })
    fireEvent.click(view.getByText('添加'))
    expect(patches.at(-1)).toEqual({ reasoningEfforts: { minimal: 'minimal', high: 'high', superx: 'superx', ultra: 'ultra' } })
  })

  it('shows the designating default on the greyed list for an unwritten row', () => {
    const { view } = dialog({ model: { id: 'fresh' } })
    // Unset efforts show the deployment's level set greyed with the hint.
    for (const key of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(view.getByText(key)).toBeTruthy()
    }
    expect(view.getByText('未设置时使用提供方声明的等级。')).toBeTruthy()
  })
})