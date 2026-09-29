/**
 * Shared fixtures for the D5-EDITORTESTS cross-source contract suite.
 *
 * The backend is REAL `@deepseek-ai/dsh-fs-local` (CAS/replaceIfVersion
 * semantics are proven there, not mocked here); only the narrow io seam that
 * `runHashlineEdit` consumes is assembled by the fixture. The seam type is
 * imported from the package so the fixture cannot drift from `src/run.ts`.
 * Patch builders go through the public format helpers so the grammar lives
 * in one place.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsObservation, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { FsObservationActor } from '@deepseek-ai/dsh-fs-observation-policy'
import { expect } from 'vitest'
import { hashlineFileHash, hashlineFormatHeader, type HashlineEditIO } from '../../src/index.ts'

export type { HashlineEditIO }

export interface EditorFixture {
  ctx: Context
  fs: LocalFileSystem
  target: FsTarget
  actor: FsObservationActor
  displayPath: string
  /** Absolute path of the seeded file. */
  path: string
  /** Contents handed to `write()` — a test can assert writes never happened. */
  writes: string[]
  io: HashlineEditIO
  /** Byte-for-byte content currently on disk. */
  disk(): Promise<string>
  /** Emit `fs/observed` for the current file state (a model-side read). */
  observe(): Promise<void>
  /** Policy-backed CAS basis: the `fs/edit-intent` waterfall. */
  editIntent(): Promise<FsWriteIntent | undefined>
  dispose(): Promise<void>
}

/** Seed a real temp backend with `before` at `a.txt` and build its io seam. */
export async function fixture(before: string, opts: { policy?: boolean } = {}): Promise<EditorFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-editor-contract-'))
  const ctx = new Context()
  if (opts.policy) await ctx.plugin(FsPolicy)
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  const fs = ctx.fs as LocalFileSystem
  const displayPath = 'a.txt'
  const path = join(dir, displayPath)
  await writeFile(path, before)
  const target = await fs.resolve(displayPath)
  const actor: FsObservationActor = { agent: { session: {} } }
  const writes: string[] = []
  const io: HashlineEditIO = {
    displayPath,
    casBasis: async () => {
      const info = await fs.stat(target)
      if (!info) throw new Error('expected the seeded target to exist')
      return { kind: 'replaceIfVersion', version: info.version }
    },
    read: async () => fs.readText(target),
    write: async (content, expected) => {
      writes.push(content)
      await fs.writeText(target, content, expected)
    },
  }
  return {
    ctx,
    fs,
    target,
    actor,
    displayPath,
    path,
    writes,
    io,
    disk: () => readFile(path, 'utf8'),
    observe: async () => {
      const info = await fs.stat(target)
      if (!info) throw new Error('expected the seeded target to exist')
      const observation: FsObservation = { kind: 'present', version: info.version }
      ctx.emit('fs/observed', target, observation, actor)
    },
    editIntent: async () => {
      const intent = (await ctx.waterfall('fs/edit-intent', target, actor, () => undefined)) as
        | { version: FsVersion }
        | undefined
      return intent ? { kind: 'replaceIfVersion', version: intent.version } : undefined
    },
    dispose: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** The hashline header line for `displayPath` over `content`. */
export function headerFor(displayPath: string, content: string): string {
  return hashlineFormatHeader(displayPath, hashlineFileHash(content))
}

/** A complete patch source: header line + the raw hunk line(s). */
export function patch(displayPath: string, content: string, ...hunkLines: string[]): string {
  return `${headerFor(displayPath, content)}\n${hunkLines.join('\n')}`
}

/**
 * Assert `fn` throws a PLAIN Error — grammar/argument validation carries no
 * `code`; fs-state failures are `FsError`s and belong to the coded assertions.
 */
export function throwsPlain(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('code')
    return error as Error
  }
  throw new Error('expected a plain Error, but nothing was thrown')
}

/** Assert `promise` rejects with a PLAIN Error (no `code` property). */
export async function rejectsPlain(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('code')
    return error as Error
  }
  throw new Error('expected a plain rejection, but the promise resolved')
}
