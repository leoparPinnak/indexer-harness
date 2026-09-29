/**
 * Layered transcript recall: the linear scan stays the always-correct layer 0,
 * a derived lexical index narrows candidates ahead of it.
 *
 * Layer 0 is `searchEventLines` from the persistence-jsonl recall primitive —
 * match-centred snippets with the anchored window. Every hit this module
 * returns is built by that call, so an indexed answer and a linear answer are
 * byte-identical whenever the candidate set contains every matching session.
 *
 * Layer 1 is a derived SQLite file (node:sqlite) holding one folded row per
 * stored session, keyed on the persistence `revision` token that exists for
 * derived read-model caches: unchanged sessions are never re-read, changed
 * sessions are re-indexed, vanished sessions are dropped. The file is rebuilt
 * from persistence alone and is never authoritative. A missing, stale, or
 * corrupt file is dropped silently and the search answers from layer 0;
 * a foreign file (another application's database) is left untouched and also
 * answers from layer 0.
 *
 * Recall contract: a query contributes an index key only when its source is
 * built from literal runs separated by `.`, `^`, `$` alone (no escapes,
 * alternation, groups, classes, or quantifiers) and carries no `u`/`v` flag.
 * The key and the indexed text share {@link foldForIndex}, which folds both
 * sides through the matcher's case-insensitive comparison, so every layer-0
 * match implies the key is present — the index never loses a hit. Queries
 * outside that class skip the index entirely and scan linearly.
 *
 * Coverage is the persisted corpus: live-only sessions are outside this
 * surface, and ranking/cursors of the mounted ranked backend are untouched.
 * @module @deepseek-ai/dsh-session-query/layered-search
 */

import { mkdir, open as openFile, rm } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, resolve as resolvePath } from 'node:path'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import {
  searchEventLines,
  searchTextOf,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/search-sessions.ts'
import type {
  SessionSearchHit,
  SessionSearchOptions,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/search-sessions.ts'
import { SessionQueryError } from './config.ts'
import { compareSessionHeaders } from './corpus.ts'

/** Derived-index file schema version; a mismatch drops the file and rebuilds. */
export const SESSION_LAYERED_SCHEMA_VERSION = 1

/** Indexed-text fold-format version; a mismatch drops the file and rebuilds. */
export const SESSION_LAYERED_FOLD_VERSION = 1

/** SQLite application id reserving the derived file for layered recall. */
export const SESSION_LAYERED_APPLICATION_ID = 0x44534852

/** User tables the current schema owns; anything else marks a foreign file. */
const RECALL_TABLES: Record<string, true> = { meta: true, sessions: true }

/**
 * Source characters that end literal-run extraction. Each one changes what the
 * pattern matches (class, quantifier, group, alternation, escape), so a query
 * carrying any of them takes the linear fallback instead of guessing a key.
 * `.`, `^`, and `$` are deliberately absent: they only separate runs, and both
 * neighbouring runs still appear verbatim in any matching text.
 */
const RECALL_UNSAFE_CHARACTERS: Record<string, true> = {
  '\\': true,
  '[': true,
  ']': true,
  '(': true,
  ')': true,
  '*': true,
  '+': true,
  '?': true,
  '{': true,
  '}': true,
  '|': true,
}

/** One stored session's refresh work as written during a refresh. */
interface IndexedSessionRow {
  readonly sessionId: string
  readonly revision: string
  readonly eventCount: number
  readonly textFold: string
}

/** Raised when the candidate index file belongs to another application. */
class ForeignIndexFileError extends Error {}

/** Options accepted by one layered or linear recall search. */
export interface LayeredRecallOptions extends SessionSearchOptions {
  /** Optional cancellation observed by listing, refresh work, and session reads. */
  readonly signal?: AbortSignal
}

/** Construction options of one layered recall owner. */
export interface LayeredSessionRecallOptions {
  /**
   * Absolute or cwd-relative path of the derived index file. Defaults to the
   * DSH cache location (`~/.dsh/cache/session-recall/index.sqlite`), the
   * house convention for data that persistence can rebuild.
   */
  readonly indexPath?: string
}

/** Which layer selected the sessions layer 0 read. */
export type LayeredRecallMode = 'index' | 'linear'

/** One stored session's hits inside one search result. */
export interface LayeredRecallSessionHit {
  /** Stored session that produced the hits. */
  readonly sessionId: SessionId
  /** Layer-0 hits in session order, byte-identical to the linear scan. */
  readonly hits: readonly SessionSearchHit[]
}

/** Result of one layered or linear recall search. */
export interface LayeredRecallResult {
  /** Layer that selected the sessions layer 0 read. */
  readonly mode: LayeredRecallMode
  /** Sessions with at least one hit, in deterministic newest-first corpus order. */
  readonly sessions: readonly LayeredRecallSessionHit[]
  /** Sessions handed to layer 0 (the whole corpus in linear mode). */
  readonly candidates: number
  /** Sessions the index re-read and re-indexed during this search. */
  readonly refreshed: number
}

/**
 * Fold indexed and query text the way the matcher compares characters.
 *
 * `toUpperCase` merges every case variant the non-`u`/`v` matcher treats as
 * equal (`ς`/`σ`, `ı`/`i`, `ſ`/`s`, …), so a case-insensitive match always
 * lands inside the folded text; the case variants it merges beyond the
 * matcher only add harmless candidates that layer 0 re-checks. Queries
 * carrying `u` or `v` fold differently (for example `ß` against `ẞ`) and are
 * routed to layer 0 by {@link recallKeyOf}.
 * @param text - raw extracted event text or a literal query run.
 * @returns the folded representation stored in and searched by the index.
 */
export function foldForIndex(text: string): string {
  return text.toUpperCase()
}

/**
 * Derive the index recall key of one query, or `undefined` when the query
 * must scan linearly.
 *
 * The key is the longest literal run of the pattern source. Any literal run
 * of a matching pattern appears verbatim in the matching text, so the run is
 * a complete (never losing) recall filter; separators `.`, `^`, `$` only split
 * runs, while escapes, classes, groups, alternation, and quantifiers can make a
 * run optional or one-of-many and force the linear path.
 * @param query - the caller's pattern; flags are inspected as written.
 * @returns the folded recall key, or `undefined` for linear-only queries.
 */
export function recallKeyOf(query: RegExp): string | undefined {
  if (query.flags.includes('u') || query.flags.includes('v')) return undefined
  let best = ''
  let run = ''
  for (const character of query.source) {
    // An unsafe character can make a literal run optional or one-of-many, so
    // the whole query falls back instead of guessing a weakened key.
    if (RECALL_UNSAFE_CHARACTERS[character] === true) return undefined
    const endsRun = character === '.' || character === '^' || character === '$'
    if (endsRun) {
      if (run.length > best.length) best = run
      run = ''
      continue
    }
    run += character
  }
  if (run.length > best.length) best = run
  return best === '' ? undefined : foldForIndex(best)
}

/**
 * Run the always-correct layer-0 scan over the whole persisted corpus.
 *
 * This is the reference answer every layered search must reproduce
 * byte-for-byte, and the fallback the layered path degrades to whenever the
 * index is missing, stale, corrupt, foreign, or inapplicable.
 * @param persistence - mounted persistence service supplying the stored corpus.
 * @param query - the recall pattern, passed to layer 0 unchanged.
 * @param options - window, snippet, limit, and cancellation options.
 * @returns corpus hits with `mode: 'linear'` and no index refresh.
 */
export async function linearSessionRecall(
  persistence: SessionPersistence,
  query: RegExp,
  options: LayeredRecallOptions = {},
): Promise<LayeredRecallResult> {
  const corpus = await loadCorpus(persistence, options.signal)
  const { sessions } = await refineCorpus(persistence, corpus, query, options)
  return { mode: 'linear', sessions, candidates: corpus.length, refreshed: 0 }
}

/**
 * Layered recall owner: lazy index build, incremental refresh, explicit
 * rebuild, and silent degradation to the linear fallback.
 *
 * One instance owns one derived index file. Searches are serialized against
 * each other for index work; session reads for layer 0 run per search. Call
 * {@link LayeredSessionRecall.close} only after in-flight searches settled.
 */
export class LayeredSessionRecall {
  private readonly _persistence: SessionPersistence
  private readonly _indexPath: string
  private _db: DatabaseSync | null = null
  private _work: Promise<unknown> = Promise.resolve()

  /**
   * Bind recall to one persistence service and one derived index path.
   * Nothing is opened or built until the first search — the constructor is
   * free of `node:sqlite` imports and filesystem work.
   * @param persistence - mounted persistence service supplying the stored corpus.
   * @param options - index file path override.
   */
  constructor(persistence: SessionPersistence, options: LayeredSessionRecallOptions = {}) {
    this._persistence = persistence
    this._indexPath = resolvePath(options.indexPath ?? dshCachePath('session-recall', 'index.sqlite'))
  }

  /**
   * Search the stored corpus through the layered path.
   *
   * The index is opened, validated, and refreshed lazily on first use;
   * every hit is then built by the same layer-0 call the linear fallback
   * uses, in the same corpus order, with the same options.
   * @param query - the recall pattern.
   * @param options - window, snippet, limit, and cancellation options.
   * @returns corpus hits plus the layer, candidate, and refresh telemetry.
   * @throws {SessionQueryError} when cancellation aborts the search; index
   *   failures never throw, they degrade silently to `mode: 'linear'`.
   */
  async search(query: RegExp, options: LayeredRecallOptions = {}): Promise<LayeredRecallResult> {
    const corpus = await loadCorpus(this._persistence, options.signal)
    let mode: LayeredRecallMode = 'linear'
    let refreshed = 0
    let selected: readonly SessionPersistenceSnapshot[] = corpus
    const key = recallKeyOf(query)
    if (key !== undefined) {
      try {
        const count = await this._enqueue(() => this._refresh(corpus, options.signal))
        if (count !== null) {
          const candidates = selectCandidates(this._requireDb(), key)
          mode = 'index'
          refreshed = count
          selected = corpus.filter(snapshot => candidates.has(snapshot.header.id))
        }
      } catch (error: unknown) {
        if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') throw error
        // Any other failure inside the index path drops the derived file; the
        // layer-0 refinement below surfaces the same truth the linear path would.
        await this._drop()
      }
    }
    const { sessions } = await refineCorpus(this._persistence, selected, query, options)
    return { mode, sessions, candidates: selected.length, refreshed }
  }

  /**
   * Drop the derived index and rebuild it from persistence alone.
   * @throws when the index file cannot be created — an explicit maintenance
   *   call reports its failure, unlike searches, which degrade silently.
   */
  async rebuild(): Promise<void> {
    await this._enqueue(async () => {
      await this._drop()
      const corpus = await loadCorpus(this._persistence, undefined)
      const refreshed = await this._refresh(corpus, undefined)
      if (refreshed === null) {
        throw new Error(`layered recall index could not be created at "${this._indexPath}"`)
      }
    })
  }

  /**
   * Close the derived index handle; in-flight searches must have settled.
   * Later searches reopen lazily and reuse the file as it stands.
   */
  close(): void {
    if (this._db === null) return
    this._db.close()
    this._db = null
  }

  /** Serialize index work so concurrent searches never interleave writes. */
  private _enqueue<Value>(task: () => Promise<Value>): Promise<Value> {
    const run = this._work.then(task)
    this._work = run.catch(() => undefined)
    return run
  }

  /** Lazily open (creating when missing) the validated derived index. */
  private async _open(): Promise<DatabaseSync | null> {
    if (this._db !== null) return this._db
    try {
      this._db = await openRecallDatabase(this._indexPath)
      return this._db
    } catch (error: unknown) {
      if (error instanceof ForeignIndexFileError) return null
      // Our file, unreadable or stale: drop it (best effort) and answer from layer 0.
      await removeIndexFiles(this._indexPath)
      return null
    }
  }

  /** The open database after a successful refresh, or an internal error. */
  private _requireDb(): DatabaseSync {
    if (this._db === null) throw new Error('layered recall index is not open')
    return this._db
  }

  /**
   * Refresh index rows for changed or new sessions and drop vanished ones.
   * @param corpus - the ordered stored corpus from one listing.
   * @param signal - optional cancellation for listing reads.
   * @returns sessions re-indexed, or `null` when the index is unavailable.
   */
  private async _refresh(
    corpus: readonly SessionPersistenceSnapshot[],
    signal: AbortSignal | undefined,
  ): Promise<number | null> {
    const db = await this._open()
    if (db === null) return null
    const known = readRevisions(db)
    const seen = new Set<string>()
    const changed: IndexedSessionRow[] = []
    for (const snapshot of corpus) {
      assertNotAborted(signal)
      const sessionId = snapshot.header.id
      seen.add(sessionId)
      if (known.get(sessionId) === snapshot.revision) continue
      const events = await readStoredEvents(this._persistence, sessionId, signal)
      changed.push({
        sessionId,
        revision: snapshot.revision,
        eventCount: events.length,
        textFold: foldForIndex(events.map(searchTextOf).join('\n')),
      })
    }
    const vanished = [...known.keys()].filter(sessionId => !seen.has(sessionId))
    writeSessions(db, changed, vanished)
    return changed.length
  }

  /** Close the handle and remove our derived file trio; foreign files stay. */
  private async _drop(): Promise<void> {
    if (this._db !== null) {
      try {
        this._db.close()
      } catch {
        // A broken handle cannot close cleanly; the file removal below owns recovery.
      }
      this._db = null
    }
    await removeIndexFiles(this._indexPath)
  }
}

/** Read one listing and order it into the shared deterministic corpus order. */
async function loadCorpus(
  persistence: SessionPersistence,
  signal: AbortSignal | undefined,
): Promise<SessionPersistenceSnapshot[]> {
  assertNotAborted(signal)
  const options = signal === undefined ? undefined : { signal }
  const snapshots = await persistence.list(options)
  return [...snapshots].sort((a, b) => compareSessionHeaders(a.header, b.header))
}

/**
 * Layer 0: read each selected session and build its hits with the linear
 * recall primitive, in corpus order.
 * @param persistence - mounted persistence service supplying stored sessions.
 * @param corpus - ordered sessions handed to layer 0.
 * @param query - the recall pattern, passed to layer 0 unchanged.
 * @param options - window, snippet, limit, and cancellation options.
 * @returns hits per matching session and the candidate count.
 */
async function refineCorpus(
  persistence: SessionPersistence,
  corpus: readonly SessionPersistenceSnapshot[],
  query: RegExp,
  options: LayeredRecallOptions,
): Promise<{ sessions: LayeredRecallSessionHit[] }> {
  const sessions: LayeredRecallSessionHit[] = []
  for (const snapshot of corpus) {
    assertNotAborted(options.signal)
    const events = await readStoredEvents(persistence, snapshot.header.id, options.signal)
    const lines = events.map(event => JSON.stringify(event))
    const hits = searchEventLines(lines, query, options)
    if (hits.length > 0) sessions.push({ sessionId: snapshot.header.id, hits })
  }
  return { sessions }
}

/**
 * Read one stored session completely through a short-lived read handle.
 * @param persistence - mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for open and read.
 * @returns the stored events in ascending seq order.
 */
async function readStoredEvents(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<readonly SessionEvent[]> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let events: readonly SessionEvent[]
  try {
    ({ events } = await handle.read(0, undefined, options))
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // The read failure is the actionable cause; a close failure adds nothing.
    }
    throw error
  }
  await handle.close()
  return events
}

/** Refuse work after cancellation with the shared session-query taxonomy. */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError('layered session recall aborted', 'SESSION_QUERY_ABORTED')
}

/** Read every indexed session revision for incremental comparison. */
function readRevisions(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT session_id, revision FROM sessions').all() as Array<{
    session_id: string
    revision: string
  }>
  const revisions = new Map<string, string>()
  for (const row of rows) revisions.set(row.session_id, row.revision)
  return revisions
}

/**
 * Write one refresh: upsert changed sessions and drop vanished ones in one
 * transaction, so a torn refresh never leaves a half-indexed corpus.
 * @param db - the open derived index.
 * @param changed - sessions whose revision moved since the last refresh.
 * @param vanished - indexed sessions absent from the latest listing.
 */
function writeSessions(
  db: DatabaseSync,
  changed: readonly IndexedSessionRow[],
  vanished: readonly string[],
): void {
  if (changed.length === 0 && vanished.length === 0) return
  const upsert = db.prepare(`
    INSERT INTO sessions (session_id, revision, event_count, text_fold)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      revision = excluded.revision,
      event_count = excluded.event_count,
      text_fold = excluded.text_fold
  `)
  const remove = db.prepare('DELETE FROM sessions WHERE session_id = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of changed) upsert.run(row.sessionId, row.revision, row.eventCount, row.textFold)
    for (const sessionId of vanished) remove.run(sessionId)
    db.exec('COMMIT')
  } catch (error: unknown) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original write failure is the actionable cause.
    }
    throw error
  }
}

/**
 * Select sessions whose folded text contains the folded recall key.
 * @param db - the open derived index.
 * @param key - a folded key from {@link recallKeyOf}.
 * @returns the candidate session ids; refinement still verifies each one.
 */
function selectCandidates(db: DatabaseSync, key: string): Set<string> {
  const rows = db.prepare(
    'SELECT session_id FROM sessions WHERE instr(text_fold, ?)',
  ).all(key) as Array<{ session_id: string }>
  const candidates = new Set<string>()
  for (const row of rows) candidates.add(row.session_id)
  return candidates
}

/**
 * Open the derived index, creating it when missing and validating it when
 * present. Stale or corrupt owned files throw a plain error (the caller
 * drops them); foreign files throw {@link ForeignIndexFileError} untouched.
 * @param path - absolute derived index path.
 * @returns the open database with schema, WAL mode, and integrity verified.
 */
async function openRecallDatabase(path: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const handle = await openFile(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Static import is impossible here: `node:sqlite` is Node-experimental, and a
  // top-level import would emit its warning for every session-query consumer,
  // even ones that never search. First index open is the only load point.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as {
      application_id: number
    }
    const { user_version: userVersion } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== SESSION_LAYERED_APPLICATION_ID) {
      throw new ForeignIndexFileError(`index at "${path}" belongs to another application`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new ForeignIndexFileError(`index at "${path}" is not an empty or owned file`)
    }
    if (applicationId === 0) {
      initializeRecallSchema(db)
    } else {
      assertCurrentSchema(db, path, userVersion, userTables)
    }
    // Mutating pragmas only run after refusing foreign or stale files.
    db.exec('PRAGMA journal_mode = WAL')
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/** List non-sqlite user tables so ownership can be verified. */
function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

/** Stamp ownership before any table exists so a torn init still identifies itself. */
function initializeRecallSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${SESSION_LAYERED_APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${SESSION_LAYERED_SCHEMA_VERSION}`)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      revision   TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      text_fold  TEXT NOT NULL
    ) STRICT
  `)
  db.exec(`
    INSERT INTO meta (key, value) VALUES
      ('schema_version', '${SESSION_LAYERED_SCHEMA_VERSION}'),
      ('fold_version', '${SESSION_LAYERED_FOLD_VERSION}')
  `)
}

/**
 * Validate an owned file against the current schema, fold format, and SQLite
 * page integrity. A mismatch throws so the caller drops the file and the
 * current search answers from layer 0.
 * @param db - the open derived index.
 * @param path - the file path, for failure messages.
 * @param userVersion - stamped schema version from `PRAGMA user_version`.
 * @param userTables - the file's user tables.
 */
function assertCurrentSchema(
  db: DatabaseSync,
  path: string,
  userVersion: number,
  userTables: readonly string[],
): void {
  if (userVersion !== SESSION_LAYERED_SCHEMA_VERSION) {
    throw new Error(`session-recall index at "${path}" has stale schema version ${userVersion}`)
  }
  if (userTables.some(name => RECALL_TABLES[name] !== true)) {
    throw new ForeignIndexFileError(`session-recall index at "${path}" has unrecognized tables`)
  }
  const quickCheck = db.prepare('PRAGMA quick_check').get() as { quick_check: string }
  if (quickCheck.quick_check !== 'ok') {
    throw new Error(`session-recall index at "${path}" failed quick_check`)
  }
  const schemaMeta = db.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).get() as { value: string } | undefined
  const foldMeta = db.prepare(
    "SELECT value FROM meta WHERE key = 'fold_version'",
  ).get() as { value: string } | undefined
  if (schemaMeta?.value !== `${SESSION_LAYERED_SCHEMA_VERSION}`) {
    throw new Error(`session-recall index at "${path}" has no current schema marker`)
  }
  if (foldMeta?.value !== `${SESSION_LAYERED_FOLD_VERSION}`) {
    throw new Error(`session-recall index at "${path}" has a stale fold format`)
  }
}

/** Best-effort removal of the index file trio; missing files are success. */
async function removeIndexFiles(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      await rm(`${path}${suffix}`, { force: true })
    } catch {
      // Degraded cleanup still answers from layer 0; the next open retries.
    }
  }
}
