/**
 * Shared real-JSONL fixture for the layered recall specs: one temp home
 * carrying a real persistence root and a derived index path, plus the small
 * session builders both specs share.
 *
 * @module @deepseek-ai/dsh-session-query/tests/recall-fixture
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryDirectories: string[] = []

/** Remove every fixture directory created since the last cleanup. */
export async function cleanupRecallFixtures(): Promise<void> {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}

/** One mounted recall fixture: real JSONL persistence plus an index path. */
export interface RecallFixture {
  /** Cordis context owning the mounted persistence service. */
  readonly ctx: Context
  /** Derived index file path inside the fixture home. */
  readonly indexPath: string
  /** Fixture home root holding the persistence directory. */
  readonly root: string
}

/** Mount a real JSONL persistence under a fresh temp home. */
export async function recallFixture(): Promise<RecallFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layered-recall-'))
  temporaryDirectories.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  return { ctx, root, indexPath: join(root, 'recall.db') }
}

/** One stored session's immutable header at a deterministic corpus position. */
export function recallHeader(id: string, createdAt: number): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false }
}

/** One stored user-message event carrying the given searchable text. */
export function recallEvent(text: string, seq: number, time: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

/** Persist one session's entries as a complete stored log. */
export async function persistSession(
  ctx: Context,
  header: SessionHeader,
  texts: readonly string[],
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header)
  await handle.append(texts.map((text, index) => recallEvent(text, index, header.createdAt + index)))
  await handle.close()
}
