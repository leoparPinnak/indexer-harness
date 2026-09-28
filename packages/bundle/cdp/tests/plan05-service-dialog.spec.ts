/**
 * plan05 service-level dialog tests: `peekPendingDialog`, the branch-1/branch-2
 * `guardPageDialog` contract, and `CdpService.dialog` (list/accept/dismiss/
 * policy + the no-dialog, ambiguous-target, and handle-failed refusals) over
 * a real `PageSession` driven by the in-process fake connection — internals
 * are injected through casts, so no socket or browser is used.
 */

import { describe, expect, it } from 'vitest'
import {
  CdpPageError,
  PageSession,
  type PageConnection,
} from '../src/page.ts'
import { CdpDialogOpenError } from '../src/dialog.ts'
import { CdpService, type CdpDialogResult } from '../src/service.ts'

/** Flattened session bound to target T1. */
const SESSION = 'session-1'

/** One command the fake connection was asked to send. */
interface SentCommand {
  method: string
  params: Record<string, unknown>
  sessionId: string | undefined
}

/** In-process stand-in for the CDP connection (same shape page.spec uses). */
function makeConnection(): {
  connection: PageConnection
  sent: SentCommand[]
  reply(method: string, value: unknown): void
  fail(method: string, error: Error): void
  emit(event: string, params: unknown, sessionId: string | undefined): void
} {
  const sent: SentCommand[] = []
  const replies = new Map<string, () => Promise<unknown>>()
  const listeners = new Map<string, Array<(params: unknown, sessionId: string | undefined) => void>>()
  return {
    connection: {
      send: (method, params, sessionId) => {
        sent.push({ method, params, sessionId })
        const reply = replies.get(method)
        if (reply === undefined) return Promise.reject(new Error(`no canned reply for ${method}`))
        return reply()
      },
      on: (event, listener) => {
        const registered = listeners.get(event) ?? []
        registered.push(listener)
        listeners.set(event, registered)
        return () => {
          const index = registered.indexOf(listener)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
    sent,
    reply: (method, value) => { replies.set(method, () => Promise.resolve(value)) },
    fail: (method, error) => { replies.set(method, () => Promise.reject(error)) },
    emit: (event, params, sessionId) => {
      for (const listener of listeners.get(event) ?? []) listener(params, sessionId)
    },
  }
}

/** TargetInfo rows the stub registry reports. */
interface StubTarget {
  targetId: string
  type: string
  title: string
  url: string
}

/** Service internals the tests inject directly (private fields by cast). */
interface ServiceInternals {
  connection: unknown
  registry: unknown
  sessions: Map<string, unknown>
}

/**
 * A CdpService wired to fake connections: `targets` maps each target id to a
 * fresh PageSession + fake connection, `activeId` picks the active tab.
 */
function makeService(options: {
  targets?: Array<{ targetId: string; session: PageSession; connection: ReturnType<typeof makeConnection> }>
  activeId?: string
  withRegistry?: boolean
}): { service: CdpService; internals: ServiceInternals } {
  const service = new CdpService()
  const internals = service as unknown as ServiceInternals
  const rows = options.targets ?? []
  for (const row of rows) internals.sessions.set(row.session.sessionId, row.session)

  if (options.withRegistry !== false && rows.length > 0) {
    const targetInfo: StubTarget[] = rows.map(row => ({ targetId: row.targetId, type: 'page', title: '', url: '' }))
    // attachedSession resolves target id -> flattened SESSION id (not object).
    const byTarget = new Map(rows.map(row => [row.targetId, row.session.sessionId]))
    internals.connection = { send: async () => ({}), on: () => () => {} }
    internals.registry = {
      targets: () => targetInfo,
      list: async () => {},
      attachedSession: (targetId: string) => byTarget.get(targetId),
      active: () => targetInfo.find(t => t.targetId === (options.activeId ?? targetInfo[0]?.targetId)),
      setActive: () => {},
    }
  }
  return { service, internals }
}

const OPENING_EVENT = 'Page.javascriptDialogOpening'

const opening = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'confirm',
  message: 'Sure?',
  url: 'https://example.test/page',
  ...extra,
})

/** Build one target row: a PageSession on its own fake connection. */
function makeTarget(sessionId: string): { sessionId: string; session: PageSession; connection: ReturnType<typeof makeConnection> } {
  const connection = makeConnection()
  connection.reply('Page.handleJavaScriptDialog', {})
  return { sessionId, session: new PageSession(connection.connection, sessionId), connection }
}

describe('plan05: CdpService.peekPendingDialog', () => {
  it('stays side-effect free: no registry means no peek and no attach', () => {
    const { service } = makeService({ withRegistry: false })
    expect(service.peekPendingDialog()).toBeUndefined()
    expect(service.peekPendingDialog('T1')).toBeUndefined()
  })

  it('reads only sessions that already exist and maps them to their target', () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    expect(service.peekPendingDialog()).toBeUndefined()

    target.connection.emit(OPENING_EVENT, opening(), SESSION)
    const brief = service.peekPendingDialog()
    expect(brief).toMatchObject({ targetId: 'T1', type: 'confirm', message: 'Sure?' })
    expect(brief?.answered).toBeUndefined()
    // Another target never sees T1's dialog.
    expect(service.peekPendingDialog('T2')).toBeUndefined()
  })
})

describe('plan05: CdpService.guardPageDialog', () => {
  it('branch 1: refuses before the first command when a dialog is already open', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    target.connection.emit(OPENING_EVENT, opening(), SESSION)

    let ran = false
    await expect(service.guardPageDialog(undefined, async () => { ran = true })).rejects.toBeInstanceOf(CdpDialogOpenError)
    expect(ran).toBe(false)
  })

  it('branch 2: fails an in-flight operation when the dialog opens mid-call', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })

    let settled = false
    const operation = service.guardPageDialog(undefined, () =>
      new Promise<string>((resolve) => { setTimeout(() => { settled = true; resolve('done') }, 50) }))
    // Give the guard its turn to register the waiter, then open the dialog.
    await new Promise(resolve => { setTimeout(resolve, 5) })
    target.connection.emit(OPENING_EVENT, opening(), SESSION)

    await expect(operation).rejects.toBeInstanceOf(CdpDialogOpenError)
    // The old promise keeps running but its late settle must not become an
    // unhandled rejection (the guard already detached from it).
    await new Promise(resolve => { setTimeout(resolve, 60) })
    expect(settled).toBe(true)
  })

  it('passes the result through when no dialog appears, and runs untouched without a session', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    await expect(service.guardPageDialog(undefined, async () => 42)).resolves.toBe(42)

    // No registry/connection: getPageSession throws, so run() executes with
    // its own error surface (nothing dialog-related may swallow it).
    const bare = new CdpService()
    await expect(bare.guardPageDialog(undefined, async () => 'bare')).resolves.toBe('bare')
    await expect(bare.guardPageDialog(undefined, async () => { throw new CdpPageError('own failure') }))
      .rejects.toThrow('own failure')
  })
})

describe('plan05: CdpService.dialog', () => {
  it('lists on a fresh service with no session and refuses accept with no-dialog', async () => {
    const { service } = makeService({ withRegistry: false })
    const listed = await service.dialog({})
    expect(listed).toEqual({ targetId: '', pending: [], recent: [], policy: 'none', ok: true })

    const accepted = await service.dialog({ action: 'accept' })
    expect(accepted.ok).toBe(false)
    expect(accepted.error?.code).toBe('no-dialog')
    expect(accepted.error?.message).toContain('cdp_dialog')

    const dismissed = await service.dialog({ action: 'dismiss' })
    expect(dismissed.error?.code).toBe('no-dialog')
  })

  it('rejects unknown actions and a malformed policy', async () => {
    const { service } = makeService({ withRegistry: false })
    const weird = await service.dialog({ action: 'frobnicate' as never })
    expect(weird.error?.code).toBe('unknown-action')
    expect(weird.error?.message).toContain('frobnicate')

    const badPolicy = await service.dialog({ action: 'policy', policy: { action: 'maybe' as never } })
    expect(badPolicy.error?.code).toBe('unknown-action')

    const noSession = await service.dialog({ action: 'policy', policy: { action: 'accept' } })
    expect(noSession.error?.code).toBe('no-session')
  })

  it('lists a pending dialog with its owning target and answers it with evidence', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    target.connection.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'prefilled' }), SESSION)

    const listed = await service.dialog({ action: 'list' })
    expect(listed.ok).toBe(true)
    expect(listed.pending).toHaveLength(1)
    expect(listed.pending[0]).toMatchObject({ targetId: 'T1', type: 'prompt', defaultPrompt: 'prefilled' })
    expect(listed.targetId).toBe('T1')

    const accepted = await service.dialog({ action: 'accept' })
    expect(accepted.ok).toBe(true)
    expect(accepted.answered).toEqual({ action: 'accepted' })
    expect(target.connection.sent.some(row => row.method === 'Page.handleJavaScriptDialog')).toBe(true)
    expect(accepted.pending).toHaveLength(0)
    expect(accepted.recent[0]?.answered).toBe('accepted')
  })

  it('passes an explicit prompt reply through and reports it', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    target.connection.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'x' }), SESSION)
    const accepted = await service.dialog({ action: 'accept', promptText: 'typed answer' })
    expect(accepted.ok).toBe(true)
    expect(accepted.answered).toEqual({ action: 'accepted', promptText: 'typed answer' })
    expect(target.connection.sent.find(row => row.method === 'Page.handleJavaScriptDialog')?.params)
      .toEqual({ accept: true, promptText: 'typed answer' })
  })

  it('refuses accept for a target with no pending dialog, naming the pending ones', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    target.connection.emit(OPENING_EVENT, opening(), SESSION)
    const result = await service.dialog({ action: 'accept', targetId: 'T2' })
    expect(result.error?.code).toBe('no-dialog')
    expect(result.error?.message).toContain('T1')
    expect(target.connection.sent.some(row => row.method === 'Page.handleJavaScriptDialog')).toBe(false)
  })

  it('never guesses between two pending tabs: ambiguity first, then an explicit pick', async () => {
    const a = makeTarget(SESSION)
    const b = makeTarget('session-2')
    const { service } = makeService({
      targets: [
        { targetId: 'T1', session: a.session, connection: a.connection },
        { targetId: 'T2', session: b.session, connection: b.connection },
      ],
      activeId: 'T1',
    })
    a.connection.emit(OPENING_EVENT, opening({ message: 'one' }), SESSION)
    b.connection.emit(OPENING_EVENT, opening({ message: 'two' }), 'session-2')

    const ambiguous = await service.dialog({ action: 'accept' })
    expect(ambiguous.error?.code).toBe('ambiguous-target')
    expect(ambiguous.error?.message).toContain('T1')
    expect(ambiguous.error?.message).toContain('T2')
    expect(a.connection.sent).toHaveLength(0)
    expect(b.connection.sent).toHaveLength(0)

    const picked = await service.dialog({ action: 'accept', targetId: 'T2' })
    expect(picked.ok).toBe(true)
    expect(b.connection.sent.some(row => row.method === 'Page.handleJavaScriptDialog')).toBe(true)
    expect(a.connection.sent).toHaveLength(0)
  })

  it('sets the auto-answer policy per session and shows it in later snapshots', async () => {
    const target = makeTarget(SESSION)
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    const set = await service.dialog({ action: 'policy', policy: { action: 'accept' } })
    expect(set.ok).toBe(true)
    expect(set.policy).toBe('accept')

    target.connection.emit(OPENING_EVENT, opening({ type: 'prompt', defaultPrompt: 'auto' }), SESSION)
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(target.connection.sent.find(row => row.method === 'Page.handleJavaScriptDialog')?.params)
      .toEqual({ accept: true, promptText: 'auto' })
    const listed = await service.dialog({ action: 'list' })
    expect(listed.pending).toHaveLength(0)
    expect(listed.recent[0]?.answered).toBe('auto-accepted')
  })

  it('surfaces a browser refusal as handle-failed and keeps the dialog pending', async () => {
    const target = makeTarget(SESSION)
    target.connection.fail('Page.handleJavaScriptDialog', new Error('Protocol error'))
    const { service } = makeService({
      targets: [{ targetId: 'T1', session: target.session, connection: target.connection }],
      activeId: 'T1',
    })
    target.connection.emit(OPENING_EVENT, opening(), SESSION)

    const result: CdpDialogResult = await service.dialog({ action: 'accept' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('handle-failed')
    expect(result.error?.message).toContain('Protocol error')
    expect(service.peekPendingDialog()).toBeDefined()
  })
})
