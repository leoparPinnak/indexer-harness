// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  PendingQuestion, planDecisionOf, type QuestionComposerProps, type QuestionWait,
} from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { en, tr, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { tr as commonTr } from '@deepseek-ai/dsh-client-locale/src/locales/tr.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)


const SID = 's1' as SessionId

const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  (key => dict[key] ?? common[key] ?? key)

type SessionState = Parameters<Parameters<QuestionComposerProps['useSession']>[0]>[0]
type ConversationState = Parameters<Parameters<QuestionComposerProps['useConversation']>[0]>[0]
type ChatState = Parameters<Parameters<QuestionComposerProps['useChat']>[0]>[0]
type TrajectoryState = Parameters<Parameters<QuestionComposerProps['useTrajectory']>[0]>[0]
type InputState = Parameters<Parameters<QuestionComposerProps['useInput']>[0]>[0]
type AttentionState = Parameters<Parameters<QuestionComposerProps['useSessionPendingInteraction']>[0]>[0]

const sessionState: SessionState = {
  sessionId: SID,
  queue: [],
  pendingSubmissions: [],
  running: false,
  subagent: null,
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
  promptAttempted: false,
  awaitingFirstTurn: false,
}
const sessionList = {
  ids: [SID],
  byId: { [SID]: { id: SID, displayTitle: 'Session', running: false, blank: false, updatedAt: 0 } },
  current: SID,
  phase: 'ready' as const,
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}
const attentionState: AttentionState = new Map()
const workspaceState = {
  items: [],
  archivedSessionIds: [],
  state: 'idle' as const,
  phase: 'ready' as const,
  error: null,
}
const conversationState: ConversationState = {
  views: { get: () => undefined },
  activeTargets: new Set(),
}
const emptyKeys: readonly string[] = []
const emptyNodeSource = { getSnapshot: () => undefined, subscribe: () => () => {} }
const chatState: ChatState = {
  order: emptyKeys,
  nodes: {
    get: () => undefined,
    source: () => emptyNodeSource,
    processSource: () => emptyNodeSource,
    values: () => [],
  },
  locations: { getTurn: () => emptyKeys, getStep: () => emptyKeys },
  navigation: { items: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: {
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
  },
}
const trajectoryState: TrajectoryState = {
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
}
const inputState: InputState = {
  draft: '',
  attachmentIds: [],
  draftRev: 0,
  phase: 'plain',
  occurrences: [],
  queue: [],
}

const questionDraftStore = createQuestionDraftStore().create(SID)

/** Framework standard-kit stubs: the panel consumes only the locale seat. */
const kit: Omit<QuestionComposerProps, 'matched'> = {
  sessionId: SID,
  session: undefined,
  pendingInteraction: undefined,
  useSession: selector => selector(sessionState),
  useSessions: selector => selector(sessionList),
  usePanelInfo, useResource,
  useSessionPendingInteraction: selector => selector(attentionState),
  useWorkspaces: selector => selector(workspaceState),
  useConversation: selector => selector(conversationState),
  useChat: selector => selector(chatState),
  useTrajectory: selector => selector(trajectoryState),
  useProjection: (() => undefined),
  useInput: selector => selector(inputState),
  inputActions: {
    setDraft: () => { throw new Error('unused') },
    addAttachments: () => { throw new Error('unused') },
    removeAttachment: () => { throw new Error('unused') },
    pruneAttachments: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  useStore: selector => selector(questionDraftStore.getSnapshot()),
  actions: questionDraftStore.actions,
  t: seatOver(zh, commonZh),
}

const PLAN = '# Ship the picker\n\n- read the store\n- render the rows\n'

/** The plan-mode request shape: one question, the plan as detail, approve named. */
const questions = (): QuestionWait['questions'] => [{
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: PLAN,
  options: [
    { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve' },
}]

/** Pending waterfall fixture with observable Client response methods. */
function wait(items: QuestionWait['questions'] = questions()) {
  const carrier = new PendingQuestion(SID, items)
  const answer = vi.spyOn(carrier, 'answer')
  const cancel = vi.spyOn(carrier, 'cancel')
  void carrier.result.catch(() => {})
  return { carrier, answer, cancel }
}

const decision = (label: string) => ({ answers: [{ id: 'plan-review', selected: [label] }] })

const REASON = 'This touches three subsystems, and the migration order matters.'

/** The plan-mode entry offer: one question, the asker's reason as detail, accept named. */
const offerQuestions = (): QuestionWait['questions'] => [{
  id: 'plan-offer',
  header: 'Plan first?',
  question: 'Plan this before implementing?',
  detail: REASON,
  options: [
    { label: 'Plan first', description: 'Enter plan mode: explore and design, then present the plan for review.' },
    { label: 'Implement now', description: 'Skip planning and carry the request out directly.' },
  ],
  intent: { kind: 'plan-offer', approve: 'Plan first' },
}]

const offerDecision = (label: string) => ({ answers: [{ id: 'plan-offer', selected: [label] }] })

describe('planDecisionOf', () => {
  it('narrows a review to its decision, plan included', () => {
    expect(planDecisionOf(questions())).toEqual({
      kind: 'plan-review',
      id: 'plan-review',
      question: 'Approve this plan and leave plan mode?',
      body: PLAN,
      approve: { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      decline: { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    })
  })

  it('narrows an offer with the same rule, naming its own intent', () => {
    expect(planDecisionOf(offerQuestions())).toEqual({
      kind: 'plan-offer',
      id: 'plan-offer',
      question: 'Plan this before implementing?',
      body: REASON,
      approve: { label: 'Plan first', description: 'Enter plan mode: explore and design, then present the plan for review.' },
      decline: { label: 'Implement now', description: 'Skip planning and carry the request out directly.' },
    })
  })

  it('leaves the decline absent when the asker offered approve alone', () => {
    const [question] = questions()
    const decision = planDecisionOf([{ ...question as object, options: [{ label: 'Approve' }] } as never])
    expect(decision?.approve).toEqual({ label: 'Approve' })
    expect(decision === undefined ? true : 'decline' in decision).toBe(false)
  })

  it.each([
    ['a batch of more than one question', () => [...questions(), ...questions()]],
    ['no intent at all', () => [{ ...questions()[0] as object, intent: undefined }]],
    ['an intent without the asker\'s body as detail', () => [{ ...questions()[0] as object, detail: undefined }]],
    ['an intent whose approve names no option', () => [{
      ...questions()[0] as object, intent: { kind: 'plan-review', approve: 'Ship it' },
    }]],
    ['an intent with no options at all', () => [{ ...questions()[0] as object, options: undefined }]],
    ['an intent this build does not render', () => [{
      ...questions()[0] as object, intent: { kind: 'review-with-someone-else', approve: 'Approve' },
    }]],
    // Two buttons cannot send a third label or a combination, and the generic
    // flow can: an intent never costs the user a reachable answer.
    ['a third option the card could not offer', () => [{
      ...questions()[0] as object,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }, { label: 'Start over' }],
    }]],
    ['a multi-select decision', () => [{ ...questions()[0] as object, multiSelect: true }]],
  ])('declines %s, leaving the request to the generic flow', (_case, build) => {
    expect(planDecisionOf(build() as never)).toBeUndefined()
  })

  it('declines an empty batch, which the generic flow reports as such', () => {
    expect(planDecisionOf([])).toBeUndefined()
  })
})

describe('DecisionCard: plan review', () => {
  it('renders the plan under a review strip, with none of the quiz affordances', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(document.querySelector('[data-plan-decision-key]')?.getAttribute('data-plan-decision-key')).toBe(carrier.key)
    expect(document.querySelector('[data-plan-decision-kind]')?.getAttribute('data-plan-decision-kind')).toBe('plan-review')
    expect(screen.getByText(zh['plan.header'])).toBeTruthy()
    // The plan renders as markdown, so its heading is a heading.
    expect(screen.getByRole('heading', { name: 'Ship the picker' })).toBeTruthy()
    expect(screen.getByText('render the rows')).toBeTruthy()
    // The question text stays as the card's accessible name rather than a title
    // that reads like a test item.
    expect(screen.getByLabelText('Approve this plan and leave plan mode?')).toBeTruthy()
    // No pager, no numbered options, no skip, no custom answer.
    expect(screen.queryByText('1 / 1')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText(zh['action.skip'])).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('answers with the asker\'s approve label and keeps its description as the tooltip', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    const approve = screen.getByRole('button', { name: zh['plan.approve'] })
    expect(approve.getAttribute('title')).toBe('Leave plan mode; the plan is carried out from the next step.')
    fireEvent.click(approve)
    expect(answer).toHaveBeenCalledWith(decision('Approve'))
    // One-shot: every action locks until the host's resolved frame lands.
    expect(approve.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: zh['plan.decline'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(approve)
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('answers with the asker\'s decline label', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.decline'] }))
    expect(answer).toHaveBeenCalledWith(decision('Keep planning'))
  })

  it('dismisses the request so the composer returns for a plain message', () => {
    const { carrier, cancel } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.discuss'] }))
    expect(cancel).toHaveBeenCalledWith()
  })

  it('omits the tooltip for an option carrying no description', () => {
    const { carrier } = wait([{
      ...questions()[0] as object,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('button', { name: zh['plan.approve'] }).hasAttribute('title')).toBe(false)
    expect(screen.getByRole('button', { name: zh['plan.decline'] }).hasAttribute('title')).toBe(false)
  })

  it('hides the decline action when the asker offered approve alone', () => {
    const { carrier } = wait([{
      ...questions()[0] as object, options: [{ label: 'Approve' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.queryByRole('button', { name: zh['plan.decline'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['plan.approve'] })).toBeTruthy()
  })

  it('re-arms the actions and says why when the decision does not land', async () => {
    const { carrier, answer } = wait()
    answer.mockRejectedValue(new Error('question response rejected: not-pending'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.approve'] }))
    const failure = await screen.findByText('question response rejected: not-pending')
    expect(failure.getAttribute('role')).toBe('status')
    // Re-armed for the retry: a lost click must not leave a dead card.
    expect(screen.getByRole('button', { name: zh['plan.approve'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['plan.approve'] }))
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('reports a non-Error transport failure as its stringified value', async () => {
    // A non-Error rejection is the case under test: a carrier can reject with
    // anything, and the panel must still show the user something.
    const { carrier, cancel } = wait()
    cancel.mockRejectedValue('socket gone')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['plan.discuss'] }))
    expect(await screen.findByText('socket gone')).toBeTruthy()
  })

  it('carries the same decision surface in English', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)

    expect(screen.getByText('Plan review')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refuse' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chat about it' })).toBeTruthy()
  })
})

describe('DecisionCard: planning offer', () => {
  it('speaks the reader\'s language while answering with the asker\'s labels', () => {
    const { carrier, answer } = wait(offerQuestions())
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(tr, commonTr)} />)

    expect(document.querySelector('[data-plan-decision-key]')?.getAttribute('data-plan-decision-key')).toBe(carrier.key)
    expect(document.querySelector('[data-plan-decision-kind]')?.getAttribute('data-plan-decision-kind')).toBe('plan-offer')
    expect(screen.getByText(tr['offer.header'])).toBeTruthy()
    // The asker's reason is the card's body, and the question stays its accessible name.
    expect(screen.getByText(REASON)).toBeTruthy()
    expect(screen.getByLabelText('Plan this before implementing?')).toBeTruthy()
    // No pager, no numbered options, no skip, no custom answer.
    expect(screen.queryByText('1 / 1')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()

    const accept = screen.getByRole('button', { name: tr['offer.accept'] })
    // The card's copy is its own, so the asker's English option description is
    // not put back on it as a tooltip.
    expect(accept.hasAttribute('title')).toBe(false)
    fireEvent.click(accept)
    expect(answer).toHaveBeenCalledWith(offerDecision('Plan first'))
    // One-shot: every action locks until the host's resolved frame lands.
    expect(accept.hasAttribute('disabled')).toBe(true)
    fireEvent.click(accept)
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('answers with the asker\'s decline label', () => {
    const { carrier, answer } = wait(offerQuestions())
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['offer.decline'] }))
    expect(answer).toHaveBeenCalledWith(offerDecision('Implement now'))
  })

  it('dismisses the offer so the composer returns for a plain message', () => {
    const { carrier, cancel } = wait(offerQuestions())
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['offer.discuss'] }))
    expect(cancel).toHaveBeenCalledWith()
  })

  it('hides the decline action when the offer asks for acceptance alone', () => {
    const { carrier } = wait([{
      ...offerQuestions()[0] as object, options: [{ label: 'Plan first' }],
    }] as never)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.queryByRole('button', { name: zh['offer.decline'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['offer.accept'] })).toBeTruthy()
  })

  it('re-arms the actions and says why when the decision does not land', async () => {
    const { carrier, answer } = wait(offerQuestions())
    answer.mockRejectedValue(new Error('question response rejected: not-pending'))
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['offer.accept'] }))
    expect(await screen.findByText('question response rejected: not-pending')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['offer.accept'] }).hasAttribute('disabled')).toBe(false)
  })

  it('reports a non-Error transport failure as its stringified value', async () => {
    // A non-Error rejection is the case under test: a carrier can reject with
    // anything, and the panel must still show the user something.
    const { carrier, cancel } = wait(offerQuestions())
    cancel.mockRejectedValue('socket gone')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('button', { name: zh['offer.discuss'] }))
    expect(await screen.findByText('socket gone')).toBeTruthy()
  })
})
