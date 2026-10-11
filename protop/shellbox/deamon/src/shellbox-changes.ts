/**
 * Shellbox change awareness: the touched-session seam the host bridge fills in,
 * the pre-step pull that commits desktop changes to the session log, the
 * `shellbox` projection carrying the model's acknowledgment cursor, and the
 * `shellbox_state` / `shellbox_input` tools.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ShellboxChange, ShellboxInputEvent, ShellboxRingEntry } from './types.js'

/** Reads committed desktop changes and delivers input for one Shellbox session, resolved for daemon or in-process mode. */
export interface ShellboxChangeSource {
  /**
   * Pure ring page read for a session; never advances the model's ack cursor.
   * @param session - session key
   * @param instanceId - desktop instance, or undefined for every instance bound to the session
   * @param since - exclusive ring-id cursor
   * @param limit - maximum entries, 1..200
   * @returns ring page with cursor and active metadata
   */
  readChanges(session: string, instanceId: string | undefined, since: number, limit: number): Promise<import('./types.js').ShellboxChangesResponse>
  /**
   * Queues validated input events for delivery to the helper.
   * @param session - session key
   * @param instanceId - desktop instance, or undefined for the session default
   * @param events - parsed input events, at most 64
   * @returns delivery result, or a refused status with an HTTP-mappable code
   */
  postInput(session: string, instanceId: string | undefined, events: ShellboxInputEvent[]): Promise<import('./types.js').ShellboxInputResult>
}

let source: ShellboxChangeSource | undefined

/**
 * Fills the change-source seam; the host bridge calls this once its manager and daemon route exist.
 * @param next - source bound to the live manager and daemon forwarding
 */
export function setShellboxChangeSource(next: ShellboxChangeSource): void {
  source = next
}

/**
 * The registered change source; misconfiguration fails loud when the bridge never registered one.
 * @returns the live source
 */
export function shellboxChangeSource(): ShellboxChangeSource {
  if (!source) throw new Error('shellbox change source is not registered')
  return source
}

const touched = new Set<string>()

/**
 * Marks a session as having at least one live Shellbox desktop, arming pre-step change synchronization for it.
 * @param session - session key
 */
export function markShellboxTouched(session: string): void {
  touched.add(session)
}

/**
 * Whether the session was touched in this process; untouched sessions skip pre-step reads entirely.
 * @param session - session key
 * @returns true when the session has live desktops
 */
export function isShellboxTouched(session: string): boolean {
  return touched.has(session)
}

/**
 * Clears the touched mark after a successful change synchronization, so the next sync waits for a new touch or a pending continuation page.
 * @param session - session key
 */
export function clearShellboxTouched(session: string): void {
  touched.delete(session)
}

/** One physical line, pinned model-facing copy shown only while unreviewed desktop changes exist. */
export const SHELLBOX_CHANGES_LINE = 'Shellbox desktop: unreviewed changes happened on the desktop since your last shellbox_state read (a program may have been opened, closed, or renamed). Run shellbox_state to review them before acting.'

/** Ring page size of one change pull; the bridge serves at most 200 entries per read. */
const PULL_LIMIT = 200

/** Per-instance detail cap of one committed `shellbox/change` event; counts and kinds still cover the whole batch. */
const CHANGE_DETAIL_LIMIT = 50

/** Default and maximum page size of a `shellbox_state` read. */
const STATE_DEFAULT_LIMIT = 50
const STATE_MAX_LIMIT = 200

/** Pinned model-facing `shellbox_state` result copy; one message per completion state. */
const STATE_STOPPED = 'Bu shellbox oturumu artık çalışmıyor; masaüstü değişiklikleri artık kaydedilmiyor.'
const STATE_MORE = 'Shellbox masaüstünde daha fazla değişiklik var; hepsini incelemek için shellbox_state aracıyla tekrar oku.'
const STATE_COMPLETE = 'Shellbox masaüstündeki değişikliklerin tamamı inceledin; masaüstü artık temiz.'
const STATE_NONE = 'Shellbox masaüstünde yeni değişiklik yok.'

/** Pinned model-facing `shellbox_input` result copy; one message per delivery outcome. */
const INPUT_SENT = 'Girdi shellbox oturumuna gönderildi.'
const INPUT_HOST_REFUSED = 'Girdi, shellbox masaüstü oturumlarına yönlendirilir; host masaüstü hedef değildir.'
const INPUT_NO_HELPER = 'Girdi gönderilemedi: shellbox masaüstü yardımcısı şu anda çalışmıyor; fare ve klavye girdisi yalnızca çalışan win32 masaüstlerine gider.'
const INPUT_FAILED_PREFIX = 'Girdi gönderilemedi: '

/**
 * Model-facing acknowledgment cursor folded from the shellbox change log:
 * `lastSeq` is the seq of the newest committed `shellbox/change`, `ackedSeq`
 * the `throughSeq` of the newest accepted `shellbox/ack`, and `lastRingId` the
 * highest ring id covered by a completed read (the default `since` cursor).
 * Dirty means `lastSeq > ackedSeq`.
 */
export interface ShellboxChangeState {
  /** Seq of the newest committed `shellbox/change` event, -1 before the first one (session seqs start at 0). */
  lastSeq: number
  /** `throughSeq` of the newest accepted `shellbox/ack` event, -1 when no change has been read yet. */
  ackedSeq: number
  /** Highest ring id a completed read covered; the next default `since` cursor. */
  lastRingId: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host shellbox acknowledgment cursor; the key's absence means the deamon bundle is not composed. */
    shellbox: ShellboxChangeState
  }
}

/** The projection schema the registry parses restored state with (`stateSchema.parse`). */
const shellboxStateSchema: z<ShellboxChangeState> = z.object({
  lastSeq: z.number(),
  ackedSeq: z.number(),
  lastRingId: z.number(),
})

/**
 * Projection of the committed shellbox change log: registers host-only (no
 * client wire view), so the key exists only while the deamon bundle is
 * composed.
 */
export const shellboxProjectionDefinition = {
  key: 'shellbox',
  stateVersion: 1,
  // The registry's runtime contract is `stateSchema.parse()`; the declared
  // `ZodType` face belongs to zod, which this bundle does not depend on.
  stateSchema: shellboxStateSchema as unknown as ProjectionDefinition<'shellbox', ShellboxChangeState>['stateSchema'],
  // -1 matches the registry's own pre-first-event cursor: the first committed
  // change carries seq 0, so a 0 sentinel could never report it as unreviewed.
  init: () => ({ lastSeq: -1, ackedSeq: -1, lastRingId: 0 }),
  apply: (state, event) => {
    // Only shellbox events move the cursor; acked/lastRingId stay put until a
    // completed read accepts them.
    if (event.type === 'shellbox/change') return { ...state, lastSeq: event.seq }
    if (event.type === 'shellbox/ack') {
      return { ...state, ackedSeq: event.data.throughSeq, lastRingId: event.data.throughRingId }
    }
    return state
  },
} satisfies ProjectionDefinition<'shellbox', ShellboxChangeState>

/**
 * The shellbox projection's current cursor state for one session.
 * @param ctx - context used to read the global projection registry.
 * @param session - session whose cursor state is read.
 * @returns the live folded state, or undefined when the projection is not registered.
 */
export function shellboxChangeState(ctx: Context, session: Session): ShellboxChangeState | undefined {
  return ctx.get('sessionProjections')?.stateOf(session, 'shellbox')
}

/** Per-session pull cursor: the log-writer's dedup head plus a due continuation page. */
interface ShellboxPullCursor {
  /** Highest ring id already committed to the log; reads are exclusive of it. */
  head: number
  /** True while the last read reported more pages, which the next sync must keep draining. */
  pending: boolean
}

const pullCursors = new Map<string, ShellboxPullCursor>()

function pullCursorOf(session: Session, key: string): ShellboxPullCursor {
  const existing = pullCursors.get(key)
  if (existing !== undefined) return existing
  let head = 0
  // Two cursors stay deliberately distinct: the projection's lastRingId is the
  // MODEL's acknowledgment cursor (what has been reviewed), while this pull
  // head is the LOG-WRITER's dedup cursor (what has been committed). Seeding
  // the head from the same log the projection folds lets a resumed process
  // never re-commit ring ids it already holds.
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read to rebuild the writer cursor at first use.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'shellbox/change' && event.data.lastRingId > head) head = event.data.lastRingId
  }
  const cursor: ShellboxPullCursor = { head, pending: false }
  pullCursors.set(key, cursor)
  return cursor
}

function toShellboxChange(entry: ShellboxRingEntry): ShellboxChange {
  return {
    time: entry.time,
    kind: entry.kind,
    instanceId: entry.instanceId,
    desktop: entry.desktop,
    ...entry.windowId === undefined ? {} : { windowId: entry.windowId },
    ...entry.title === undefined ? {} : { title: entry.title },
    ...entry.processId === undefined ? {} : { processId: entry.processId },
    ...entry.process === undefined ? {} : { process: entry.process },
  }
}

/**
 * Pull one change page for a touched (or continuation-pending) session and
 * commit every new entry to the session log as one `shellbox/change` event per
 * desktop instance, then clear the touched mark. Fresh untouched sessions skip
 * entirely; a pending continuation stays due across the touched flag.
 * @param session - live session whose desktops are synchronized.
 * @returns a promise that resolves after the log commits, or rejects loudly when the seam or log refuses.
 */
export async function syncShellboxChanges(session: Session): Promise<void> {
  const key = String(session.id)
  const cursor = pullCursors.get(key)
  if (!isShellboxTouched(key) && (cursor === undefined || !cursor.pending)) return
  const pull = cursor ?? pullCursorOf(session, key)
  const response = await shellboxChangeSource().readChanges(key, undefined, pull.head, PULL_LIMIT)
  const retained = response.changes.filter(entry => entry.id > pull.head)
  const groups = new Map<string, { firstRingId: number; lastRingId: number; entries: ShellboxRingEntry[] }>()
  for (const entry of retained) {
    const group = groups.get(entry.instanceId)
    if (group === undefined) {
      groups.set(entry.instanceId, { firstRingId: entry.id, lastRingId: entry.id, entries: [entry] })
    } else {
      group.lastRingId = entry.id
      group.entries.push(entry)
    }
  }
  let committed = 0
  for (const [instanceId, group] of groups) {
    const detail = group.entries.slice(0, CHANGE_DETAIL_LIMIT)
    session.append('shellbox/change', {
      session: key,
      instanceId,
      firstRingId: group.firstRingId,
      lastRingId: group.lastRingId,
      count: group.entries.length,
      kinds: [...new Set(group.entries.map(entry => entry.kind))],
      changes: detail.map(entry => toShellboxChange(entry)),
      ...group.entries.length > CHANGE_DETAIL_LIMIT ? { overflow: true as const } : {},
    })
    committed += group.entries.length
  }
  if (committed !== retained.length) {
    // A pulled entry that reached no committed event would silently vanish
    // from change awareness; the log and the feed must never diverge.
    throw new Error(`shellbox: committed ${String(committed)} of ${String(retained.length)} pulled change entries`)
  }
  if (response.hasMore) {
    const highest = retained.reduce((max, entry) => Math.max(max, entry.id), pull.head)
    pull.head = Math.max(pull.head, highest)
    pull.pending = true
  } else {
    pull.head = Math.max(pull.head, response.ringCursor)
    pull.pending = false
  }
  clearShellboxTouched(key)
}

/**
 * Registers the change-awareness pieces: the awaited `agent/pre-step` pull and
 * the host-only `shellbox` projection registration.
 * @param ctx - plugin context.
 */
export function registerShellboxChangeTracking(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await syncShellboxChanges(agent.session)
    return next()
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(shellboxProjectionDefinition)
  })
}

/** The live Session behind a tool's session id, or undefined when no store entry exists. */
function resolveSession(ctx: Context, sessionId: string): Session | undefined {
  return ctx.get('sessions')?.get(SessionId(sessionId))
}

/** The registered cursor state; composed-without-projection fails loud before any pull. */
function requireShellboxState(ctx: Context, session: Session): ShellboxChangeState {
  const state = shellboxChangeState(ctx, session)
  if (state === undefined) throw new Error('shellbox_state requires the registered shellbox session projection')
  return state
}

/** Whether uncommitted-to-review changes exist at this moment. */
function shellboxDirty(ctx: Context, session: Session): boolean {
  const state = shellboxChangeState(ctx, session)
  return state !== undefined && state.lastSeq > state.ackedSeq
}

/**
 * Registers the model-facing `shellbox_state` change-log reader and
 * `shellbox_input` desktop-input sender when the `tools` service is present.
 * @param ctx - plugin context.
 */
export function registerShellboxChangeTools(ctx: Context): void {
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'shellbox_state',
      description: 'Read the Shellbox desktop change log for a session. Returns window and process changes since your last read and clears the desktop change warning once a complete page is read.',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: 'Shellbox session id whose desktop change log to read.',
        },
        instanceId: {
          type: 'string',
          description: 'Restrict the read to one desktop instance; omit to read every instance bound to the session.',
        },
        since: {
          type: 'integer',
          description: 'Read ring changes strictly after this ring id; defaults to your last fully reviewed position.',
        },
        limit: {
          type: 'integer',
          description: 'Page size, 1 through 200; defaults to 50.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            active: { type: 'boolean', required: true },
            session: { type: 'string', required: true },
            cursor: { type: 'integer', required: true },
            latest: { type: 'integer', required: true },
            dirty: { type: 'boolean', required: true },
            hasMore: { type: 'boolean', required: true },
            truncated: { type: 'boolean', required: true },
            changes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'integer', required: true },
                  time: { type: 'integer', required: true },
                  kind: { type: 'string', required: true },
                  instanceId: { type: 'string', required: true },
                  desktop: { type: 'string', required: true },
                  windowId: { type: 'integer' },
                  title: { type: 'string' },
                  processId: { type: 'integer' },
                  process: { type: 'string' },
                },
              },
            },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        if (args.limit !== undefined && (args.limit < 1 || args.limit > STATE_MAX_LIMIT)) {
          throw new ToolArgsError([`limit must be an integer between 1 and ${String(STATE_MAX_LIMIT)}`])
        }
        if (args.since !== undefined && args.since < 0) {
          throw new ToolArgsError(['since must be at least 0'])
        }
        const session = resolveSession(toolCtx, args.sessionId)
        if (session === undefined) {
          return {
            ok: true,
            active: false,
            session: args.sessionId,
            cursor: args.since ?? 0,
            latest: 0,
            dirty: false,
            hasMore: false,
            truncated: false,
            changes: [],
            message: STATE_STOPPED,
          }
        }
        requireShellboxState(toolCtx, session)
        await syncShellboxChanges(session)
        const current = requireShellboxState(toolCtx, session)
        const since = args.since ?? current.lastRingId
        const response = await shellboxChangeSource().readChanges(args.sessionId, args.instanceId, since, args.limit ?? STATE_DEFAULT_LIMIT)
        if (!response.active) {
          return {
            ok: true,
            active: false,
            session: response.session,
            cursor: since,
            latest: response.ringCursor,
            dirty: shellboxDirty(toolCtx, session),
            hasMore: false,
            truncated: response.truncated,
            changes: [],
            message: STATE_STOPPED,
          }
        }
        if (response.hasMore) {
          return {
            ok: true,
            active: true,
            session: response.session,
            cursor: since,
            latest: response.ringCursor,
            dirty: shellboxDirty(toolCtx, session),
            hasMore: true,
            truncated: response.truncated,
            changes: [...response.changes],
            message: STATE_MORE,
          }
        }
        const ackState = requireShellboxState(toolCtx, session)
        session.append('shellbox/ack', {
          session: String(session.id),
          throughSeq: ackState.lastSeq,
          throughRingId: response.changes.at(-1)?.id ?? since,
        })
        const accepted = requireShellboxState(toolCtx, session)
        return {
          ok: true,
          active: true,
          session: response.session,
          cursor: since,
          latest: response.ringCursor,
          dirty: accepted.lastSeq > accepted.ackedSeq,
          hasMore: false,
          truncated: response.truncated,
          changes: [...response.changes],
          message: response.changes.length > 0 ? STATE_COMPLETE : STATE_NONE,
        }
      },
    })), 'deamon: shellbox_state tool')

    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'shellbox_input',
      description: 'Send mouse and keyboard input into a win32 shellbox desktop session as ordered steps (move, click, wheel, key, character). The host desktop is not a target, and with no desktop helper running the result reports that input needs a running win32 desktop.',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: 'Shellbox session id whose win32 desktop receives the input.',
        },
        instanceId: {
          type: 'string',
          description: 'Target desktop instance; omit for the session default instance.',
        },
        steps: {
          type: 'array',
          required: true,
          description: 'Ordered input steps: move (x, y), button (b: left|right|middle, p: down|up), wheel (dx, dy), key (vk, p: down|up), char (c code point).',
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'move', required: true },
                  x: { type: 'number', required: true },
                  y: { type: 'number', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'button', required: true },
                  b: { type: 'string', enum: ['left', 'right', 'middle'], required: true },
                  p: { type: 'string', enum: ['down', 'up'], required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'wheel', required: true },
                  dx: { type: 'number', required: true },
                  dy: { type: 'number', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'key', required: true },
                  vk: { type: 'number', required: true },
                  p: { type: 'string', enum: ['down', 'up'], required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  t: { type: 'string', const: 'char', required: true },
                  c: { type: 'number', required: true },
                },
              },
            ],
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            accepted: { type: 'integer' },
            delivered: { type: 'boolean' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const changeSource = shellboxChangeSource()
        const session = resolveSession(toolCtx, args.sessionId)
        if (session === undefined) return { ok: false, message: INPUT_NO_HELPER }
        const events: ShellboxInputEvent[] = [...args.steps]
        const result = await changeSource.postInput(args.sessionId, args.instanceId, events)
        if (result.ok) {
          return { ok: true, accepted: result.accepted, delivered: result.delivered, message: INPUT_SENT }
        }
        if (result.status === 403) return { ok: false, message: INPUT_HOST_REFUSED }
        if (result.status === 409) return { ok: false, message: INPUT_NO_HELPER }
        return { ok: false, message: INPUT_FAILED_PREFIX + result.error }
      },
    })), 'deamon: shellbox_input tool')
  })
}
