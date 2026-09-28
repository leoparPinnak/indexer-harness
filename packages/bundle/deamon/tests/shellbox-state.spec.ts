/**
 * The model-facing shellbox change-awareness half: the `shellbox_state` and
 * `shellbox_input` tools against a real ToolRuntime, the `shellbox` projection
 * cursor, the awaited pre-step pull, the `app:shellbox-changes` prompt
 * derivation, the generated event vocabulary, and the pinned model-facing
 * result copy.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Deamon from '../src/index.ts'
import {
  clearShellboxTouched,
  isShellboxTouched,
  markShellboxTouched,
  setShellboxChangeSource,
  SHELLBOX_CHANGES_LINE,
  syncShellboxChanges,
  type ShellboxChangeSource,
} from '../src/shellbox-changes.ts'
import type {
  ShellboxChangeKind,
  ShellboxInputResult,
  ShellboxRingEntry,
} from '../src/types.ts'

/** Pinned `shellbox_state` tool description. */
const STATE_DESCRIPTION = 'Read the Shellbox desktop change log for a session. Returns window and process changes since your last read and clears the desktop change warning once a complete page is read.'

/** Pinned `shellbox_input` tool description. */
const INPUT_DESCRIPTION = 'Send mouse and keyboard input into a win32 shellbox desktop session as ordered steps (move, click, wheel, key, character). The host desktop is not a target, and with no desktop helper running the result reports that input needs a running win32 desktop.'

/** Pinned `shellbox_state` result copy, one message per completion state. */
const M_STOPPED = 'Bu shellbox oturumu artık çalışmıyor; masaüstü değişiklikleri artık kaydedilmiyor.'
const M_MORE = 'Shellbox masaüstünde daha fazla değişiklik var; hepsini incelemek için shellbox_state aracıyla tekrar oku.'
const M_COMPLETE = 'Shellbox masaüstündeki değişikliklerin tamamı inceledin; masaüstü artık temiz.'
const M_NONE = 'Shellbox masaüstünde yeni değişiklik yok.'

/** Pinned `shellbox_input` result copy, one message per delivery outcome. */
const M_SENT = 'Girdi shellbox oturumuna gönderildi.'
const M_REFUSED = 'Girdi, shellbox masaüstü oturumlarına yönlendirilir; host masaüstü hedef değildir.'
const M_NO_HELPER = 'Girdi gönderilemedi: shellbox masaüstü yardımcısı şu anda çalışmıyor; fare ve klavye girdisi yalnızca çalışan win32 masaüstlerine gider.'

interface StateValue {
  ok: boolean
  active: boolean
  session: string
  cursor: number
  latest: number
  dirty: boolean
  hasMore: boolean
  truncated: boolean
  changes: ShellboxRingEntry[]
  message: string
}

interface InputValue {
  ok: boolean
  accepted?: number
  delivered?: boolean
  message: string
}

interface SourceFeed {
  reads: Array<{ session: string; instanceId: string | undefined; since: number; limit: number }>
  posts: Array<{ session: string; instanceId: string | undefined; steps: ShellboxInputResultSteps }>
  setPostResult: (next: ShellboxInputResult) => void
}

type ShellboxInputResultSteps = Parameters<ShellboxChangeSource['postInput']>[2]

function installSource(entries: ShellboxRingEntry[], active = true): SourceFeed {
  const reads: SourceFeed['reads'] = []
  const posts: SourceFeed['posts'] = []
  let postResult: ShellboxInputResult = { ok: true, accepted: 2, delivered: true }
  setShellboxChangeSource({
    async readChanges(session, instanceId, since, limit) {
      reads.push({ session, instanceId, since, limit })
      const matching = entries.filter(entry => entry.id > since)
      const page = matching.slice(0, limit)
      return {
        ok: true,
        session,
        instanceId: instanceId ?? 'all',
        active,
        ringCursor: entries.at(-1)?.id ?? 0,
        since,
        limit,
        hasMore: matching.length > page.length,
        truncated: false,
        changes: page,
      }
    },
    async postInput(session, instanceId, steps) {
      posts.push({ session, instanceId, steps })
      return postResult
    },
  })
  return {
    reads,
    posts,
    setPostResult: (next) => { postResult = next },
  }
}

function ringEntry(
  id: number,
  instanceId: string,
  kind: ShellboxChangeKind = 'window-opened',
  title = 'Untitled',
): ShellboxRingEntry {
  return {
    id,
    time: 1_700_000_000_000 + id,
    kind,
    instanceId,
    desktop: `dsh-sb-${instanceId}`,
    windowId: 100 + id,
    title,
    processId: 4_000 + id,
    process: 'notepad.exe',
  }
}

let sessionCounter = 0
let callCounter = 0

interface Harness {
  ctx: Context
  session: Session
  key: string
  agent: Agent & { session: Session }
  deamon: { dispose(): Promise<void> }
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.reflect.provide('webServer', {
    host: '127.0.0.1',
    port: 4567,
    register: () => () => {},
    registerUpgrade: () => () => {},
  })
  ctx.reflect.provide('connection', { requestRejection: () => undefined })
  const deamon = await ctx.plugin(Deamon, { surfaceContext: true })
  // Deferred inject callbacks settle one macrotask after their services resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const session = ctx.sessions.create(SessionId(`shellbox-state-${++sessionCounter}`))
  const agent = {
    id: session.id,
    session,
    options: {},
    inject: () => {},
  } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  return { ctx, session, key: String(session.id), agent, deamon }
}

function execute(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    callId: ToolCallId(`shellbox-state-${++callCounter}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...agent ? { agent } : {},
  })
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T names the asserted result shape each call site selects.
function valueOf<T>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`unexpected tool failure: ${result.error.message}`)
  return result.value as unknown as T
}

function eventsOfType(session: Session, type: 'shellbox/change' | 'shellbox/ack'): SessionEvent[] {
  return session.snapshotEvents().filter(event => event.type === type)
}

async function changesSectionText(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  return assembly.sections.find(section => section.name === 'app:shellbox-changes')?.text ?? ''
}

describe('shellbox change awareness', () => {
  it('pins the shellbox_state and shellbox_input schemas and the frozen shellbox_launch schema', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    const state = schemas.find(schema => schema.name === 'shellbox_state')
    expect(state?.description).toBe(STATE_DESCRIPTION)
    expect(state?.parameters).toEqual({
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Shellbox session id whose desktop change log to read.' },
        instanceId: { type: 'string', description: 'Restrict the read to one desktop instance; omit to read every instance bound to the session.' },
        since: { type: 'integer', description: 'Read ring changes strictly after this ring id; defaults to your last fully reviewed position.' },
        limit: { type: 'integer', description: 'Page size, 1 through 200; defaults to 50.' },
      },
      required: ['sessionId'],
    })
    const input = schemas.find(schema => schema.name === 'shellbox_input')
    expect(input?.description).toBe(INPUT_DESCRIPTION)
    expect(input?.parameters).toEqual({
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Shellbox session id whose win32 desktop receives the input.' },
        instanceId: { type: 'string', description: 'Target desktop instance; omit for the session default instance.' },
        steps: {
          type: 'array',
          description: 'Ordered input steps: move (x, y), button (b: left|right|middle, p: down|up), wheel (dx, dy), key (vk, p: down|up), char (c code point).',
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'move' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                },
                required: ['t', 'x', 'y'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'button' },
                  b: { type: 'string', enum: ['left', 'right', 'middle'] },
                  p: { type: 'string', enum: ['down', 'up'] },
                },
                required: ['t', 'b', 'p'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'wheel' },
                  dx: { type: 'number' },
                  dy: { type: 'number' },
                },
                required: ['t', 'dx', 'dy'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'key' },
                  vk: { type: 'number' },
                  p: { type: 'string', enum: ['down', 'up'] },
                },
                required: ['t', 'vk', 'p'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'char' },
                  c: { type: 'number' },
                },
                required: ['t', 'c'],
              },
            ],
          },
        },
      },
      required: ['sessionId', 'steps'],
    })
    const launch = schemas.find(schema => schema.name === 'shellbox_launch')
    expect(launch?.parameters).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Application executable and optional arguments to run on the Shellbox desktop (e.g. "notepad.exe", "calc.exe", "msedge.exe https://example.com").' },
        sessionId: { type: 'string', description: 'Optional session ID to target a specific session\'s isolated desktop. Defaults to the current session.' },
        instanceId: { type: 'string', description: 'Optional instance ID to target a specific virtual desktop instance.' },
      },
      required: ['command'],
    })
  })

  it('pulls, commits, reads, and acks a complete page in one read', async () => {
    const { ctx, session, key } = await setup()
    const feed = installSource([
      ringEntry(1, 'inst-a', 'window-opened', 'Untitled - Paint'),
      ringEntry(2, 'inst-a', 'window-closed', 'Old'),
    ])
    markShellboxTouched(key)
    const value = valueOf<StateValue>(await execute(ctx, 'shellbox_state', { sessionId: key }))
    expect(value).toMatchObject({
      ok: true,
      active: true,
      session: key,
      cursor: 0,
      latest: 2,
      dirty: false,
      hasMore: false,
      truncated: false,
    })
    expect(value.message).toBe(M_COMPLETE)
    expect(value.changes).toHaveLength(2)
    // The pre-read sync pulls with the fixed page size; the tool's own read
    // follows with the default page size.
    expect(feed.reads[0]).toEqual({ session: key, instanceId: undefined, since: 0, limit: 200 })
    expect(feed.reads[1]).toEqual({ session: key, instanceId: undefined, since: 0, limit: 50 })
    const change = eventsOfType(session, 'shellbox/change')[0]
    if (change === undefined) throw new Error('expected one committed shellbox/change event')
    expect(change.data).toEqual({
      session: key,
      instanceId: 'inst-a',
      firstRingId: 1,
      lastRingId: 2,
      count: 2,
      kinds: ['window-opened', 'window-closed'],
      changes: [
        {
          time: 1_700_000_000_001,
          kind: 'window-opened',
          instanceId: 'inst-a',
          desktop: 'dsh-sb-inst-a',
          windowId: 101,
          title: 'Untitled - Paint',
          processId: 4_001,
          process: 'notepad.exe',
        },
        {
          time: 1_700_000_000_002,
          kind: 'window-closed',
          instanceId: 'inst-a',
          desktop: 'dsh-sb-inst-a',
          windowId: 102,
          title: 'Old',
          processId: 4_002,
          process: 'notepad.exe',
        },
      ],
    })
    const ack = eventsOfType(session, 'shellbox/ack')[0]
    if (ack === undefined) throw new Error('expected one shellbox/ack event')
    expect(ack.data).toEqual({ session: key, throughSeq: change.seq, throughRingId: 2 })
    expect(change.seq).toBeLessThan(ack.seq)
  })

  it('leaves the projection dirty on a partial page and cleans it on completion, with the section line following', async () => {
    const { ctx, session, key, agent } = await setup()
    installSource([
      ringEntry(1, 'inst-a'),
      ringEntry(2, 'inst-a'),
      ringEntry(3, 'inst-a'),
    ])
    // Clean sessions contribute no section text, with an agent present or not.
    expect(await changesSectionText(ctx, agent)).toBe('')
    markShellboxTouched(key)
    const partial = valueOf<StateValue>(await execute(ctx, 'shellbox_state', { sessionId: key, limit: 2 }))
    expect(partial.hasMore).toBe(true)
    expect(partial.dirty).toBe(true)
    expect(partial.message).toBe(M_MORE)
    expect(eventsOfType(session, 'shellbox/ack')).toHaveLength(0)
    expect(await changesSectionText(ctx, agent)).toBe(SHELLBOX_CHANGES_LINE)
    const complete = valueOf<StateValue>(await execute(ctx, 'shellbox_state', { sessionId: key }))
    expect(complete.hasMore).toBe(false)
    expect(complete.dirty).toBe(false)
    expect(complete.message).toBe(M_COMPLETE)
    expect(await changesSectionText(ctx, agent)).toBe('')
  })

  it('reports a stopped session as ok with the pinned stopped message and no ack', async () => {
    const { ctx, session, key } = await setup()
    const feed = installSource([ringEntry(1, 'inst-a')], false)
    const value = valueOf<StateValue>(await execute(ctx, 'shellbox_state', { sessionId: key }))
    expect(value).toMatchObject({ ok: true, active: false, hasMore: false, changes: [] })
    expect(value.message).toBe(M_STOPPED)
    expect(eventsOfType(session, 'shellbox/ack')).toHaveLength(0)
    // An untouched, unpulled session never asks the feed to synchronize.
    expect(feed.reads).toHaveLength(1)
  })

  it('reports an empty complete read with the pinned no-changes message', async () => {
    const { ctx, session, key } = await setup()
    installSource([])
    const value = valueOf<StateValue>(await execute(ctx, 'shellbox_state', { sessionId: key }))
    expect(value).toMatchObject({ ok: true, active: true, hasMore: false, dirty: false, changes: [] })
    expect(value.message).toBe(M_NONE)
    const ack = eventsOfType(session, 'shellbox/ack')[0]
    if (ack === undefined) throw new Error('expected one shellbox/ack event')
    // Nothing was committed to review, so the ack stays at the -1 cursor.
    expect(ack.data).toEqual({ session: key, throughSeq: -1, throughRingId: 0 })
  })

  it('rejects an out-of-range limit and applies the default page size otherwise', async () => {
    const { ctx, key } = await setup()
    const feed = installSource([ringEntry(1, 'inst-a')])
    const rejected = await execute(ctx, 'shellbox_state', { sessionId: key, limit: 201 })
    if (!rejected.isError) throw new Error('expected the oversized limit to fail')
    expect(rejected.error.message).toContain('limit')
    expect(feed.reads).toHaveLength(0)
    markShellboxTouched(key)
    await execute(ctx, 'shellbox_state', { sessionId: key })
    expect(feed.reads[0]?.limit).toBe(200)
    expect(feed.reads[1]?.limit).toBe(50)
  })

  it('adds both shellbox event keys to the generated required vocabulary', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('shellbox/change')).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('shellbox/ack')).toBe(true)
  })

  it('commits log-only events with no ignorable flag and no surface operation', async () => {
    const { ctx, session, key } = await setup()
    installSource([ringEntry(1, 'inst-a')])
    markShellboxTouched(key)
    await execute(ctx, 'shellbox_state', { sessionId: key })
    const shellboxEvents = session.snapshotEvents()
      .filter(event => event.type === 'shellbox/change' || event.type === 'shellbox/ack')
    expect(shellboxEvents.length).toBeGreaterThan(0)
    for (const event of shellboxEvents) {
      expect(Object.hasOwn(event, 'ignorable')).toBe(false)
      expect(Object.hasOwn(event, 'surfaceOp')).toBe(false)
    }
  })

  it('does not re-log ring entries the pull head already committed', async () => {
    const { session, key } = await setup()
    const feed = installSource([ringEntry(1, 'inst-a'), ringEntry(2, 'inst-a')])
    markShellboxTouched(key)
    await syncShellboxChanges(session)
    expect(eventsOfType(session, 'shellbox/change')).toHaveLength(1)
    expect(feed.reads).toHaveLength(1)
    expect(isShellboxTouched(key)).toBe(false)
    markShellboxTouched(key)
    await syncShellboxChanges(session)
    expect(eventsOfType(session, 'shellbox/change')).toHaveLength(1)
    expect(feed.reads).toHaveLength(2)
    expect(isShellboxTouched(key)).toBe(false)
  })

  it('skips synchronization after clearShellboxTouched', async () => {
    const { session, key } = await setup()
    const feed = installSource([ringEntry(1, 'inst-a')])
    markShellboxTouched(key)
    clearShellboxTouched(key)
    await syncShellboxChanges(session)
    expect(feed.reads).toHaveLength(0)
    expect(eventsOfType(session, 'shellbox/change')).toHaveLength(0)
  })

  it('pulls changes during the awaited pre-step before the step proceeds', async () => {
    const { ctx, session, key, agent } = await setup()
    installSource([ringEntry(1, 'inst-a')])
    markShellboxTouched(key)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'boundary probe' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    expect(decision.kind).toBe('enter')
    expect(eventsOfType(session, 'shellbox/change')).toHaveLength(1)
  })

  it('maps every input delivery outcome to its pinned message', async () => {
    const { ctx, key } = await setup()
    const feed = installSource([])
    const steps = [
      { t: 'move' as const, x: 10, y: 20 },
      { t: 'button' as const, b: 'left' as const, p: 'down' as const },
    ]
    const sent = valueOf<InputValue>(await execute(ctx, 'shellbox_input', { sessionId: key, steps }))
    expect(sent).toEqual({ ok: true, accepted: 2, delivered: true, message: M_SENT })
    expect(feed.posts[0]).toEqual({ session: key, instanceId: undefined, steps })
    feed.setPostResult({ ok: false, status: 403, error: 'host desktop' })
    const refused = valueOf<InputValue>(await execute(ctx, 'shellbox_input', { sessionId: key, steps }))
    expect(refused).toEqual({ ok: false, message: M_REFUSED })
    feed.setPostResult({ ok: false, status: 409, error: 'helper down' })
    const noHelper = valueOf<InputValue>(await execute(ctx, 'shellbox_input', { sessionId: key, steps }))
    expect(noHelper).toEqual({ ok: false, message: M_NO_HELPER })
    feed.setPostResult({ ok: false, status: 400, error: 'bad step' })
    const failed = valueOf<InputValue>(await execute(ctx, 'shellbox_input', { sessionId: key, steps }))
    expect(failed).toEqual({ ok: false, message: 'Girdi gönderilemedi: bad step' })
    expect(feed.posts).toHaveLength(4)
  })

  it('rejects malformed input steps with a tool error result, not a throw', async () => {
    const { ctx, key } = await setup()
    installSource([])
    const unknownStep = await execute(ctx, 'shellbox_input', { sessionId: key, steps: [{ t: 'teleport', x: 1 }] })
    expect(unknownStep.isError).toBe(true)
    const nonArray = await execute(ctx, 'shellbox_input', { sessionId: key, steps: 'move' })
    expect(nonArray.isError).toBe(true)
  })

  it('removes the shellbox tools and the changes section when the bundle fiber is disposed', async () => {
    const { ctx, deamon } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['shellbox_state', 'shellbox_input']),
    )
    const sections = async () => (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(await sections()).toContain('app:shellbox-changes')
    await deamon.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('shellbox_state')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('shellbox_input')
    expect(await sections()).not.toContain('app:shellbox-changes')
  })
})
