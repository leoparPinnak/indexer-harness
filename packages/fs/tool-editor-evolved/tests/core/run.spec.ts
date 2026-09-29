/**
 * The stateful hashline runner over the real local backend: compare-and-swap races,
 * read-back byte verification (including a write that silently drops bytes), and the
 * ordering guarantee that malformed input never reaches the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { hashlineFileHash, hashlineFormatHeader, runHashlineEdit } from '../../src/index.ts'

const ORIGINAL = 'one\ntwo\nthree'

let dir: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Fiber
let target: FsTarget

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** The version the backend reports for the resolved target right now. */
async function versionOf(current: FsTarget): Promise<FsVersion> {
  const info = await fs.stat(current)
  if (info === undefined) throw new Error(`expected ${current.displayPath} to exist`)
  return info.version
}

/** Header for `a.txt` hashing whatever content the caller read. */
function headerFor(content: string): string {
  return hashlineFormatHeader('a.txt', hashlineFileHash(content))
}

/** Build the `one/two/three` patch body that replaces line two. */
function replaceTwoBody(replacement: string): string {
  return `@@ 1\n 1| one\n-2| two\n+${replacement}\n 3| three`
}

describe('runHashlineEdit', () => {
  it('applies a patch through the guarded write and verifies the persisted bytes', async () => {
    await writeFile(join(dir, 'a.txt'), ORIGINAL, 'utf8')
    target = await fs.resolve('a.txt')

    const result = await runHashlineEdit(
      {
        displayPath: target.displayPath,
        casBasis: async () => ({ kind: 'replaceIfVersion', version: await versionOf(target) }),
        read: async () => fs.readText(target),
        write: async (content, expected) => {
          await fs.writeText(target, content, expected)
        },
      },
      `${headerFor(ORIGINAL)}\n${replaceTwoBody('TWO')}`,
    )

    expect(result).toEqual({
      path: target.displayPath,
      before: ORIGINAL,
      after: 'one\nTWO\nthree',
      replacements: 1,
    })
    await expect(fs.readText(target)).resolves.toBe('one\nTWO\nthree')
  })

  it('refuses the second writer when both edits took the same CAS basis', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo', 'utf8')
    target = await fs.resolve('a.txt')
    const contestedBasis = await versionOf(target)
    const header = headerFor('one\ntwo')
    const ioOver = (read: () => Promise<string>) => ({
      displayPath: target.displayPath,
      casBasis: async (): Promise<FsWriteIntent> => ({ kind: 'replaceIfVersion', version: contestedBasis }),
      read,
      write: async (content: string, expected: FsWriteIntent | undefined) => {
        await fs.writeText(target, content, expected)
      },
    })

    const winner = await runHashlineEdit(
      ioOver(async () => fs.readText(target)),
      `${header}\n@@ 1\n 1| one\n-2| two\n+SECOND`,
    )
    expect(winner.after).toBe('one\nSECOND')

    // The loser still holds the content it read before the winner wrote, so the header
    // hash passes and only the compare-and-swap guard can stop the overwrite.
    await expect(runHashlineEdit(
      ioOver(async () => 'one\ntwo'),
      `${header}\n@@ 1\n 1| one\n-2| two\n+OTHER`,
    )).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.readText(target)).resolves.toBe('one\nSECOND')
  })

  it('rejects a stale header hash without writing', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree', 'utf8')
    target = await fs.resolve('a.txt')
    const staleHeader = headerFor('one\ntwo')

    await expect(runHashlineEdit(
      {
        displayPath: target.displayPath,
        casBasis: async () => ({ kind: 'replaceIfVersion', version: await versionOf(target) }),
        read: async () => fs.readText(target),
        write: async (content, expected) => {
          await fs.writeText(target, content, expected)
        },
      },
      `${staleHeader}\n@@ 1\n 1| one\n-2| two\n+TWO\n 3| three`,
    )).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.readText(target)).resolves.toBe(ORIGINAL)
  })

  it('reports a write that did not persist the patched bytes', async () => {
    await writeFile(join(dir, 'a.txt'), ORIGINAL, 'utf8')
    target = await fs.resolve('a.txt')

    await expect(runHashlineEdit(
      {
        displayPath: target.displayPath,
        casBasis: async () => ({ kind: 'replaceIfVersion', version: await versionOf(target) }),
        read: async () => fs.readText(target),
        write: async (content) => {
          // A write that silently drops the tail of the content it was given.
          await writeFile(join(dir, 'a.txt'), content.slice(0, content.length - 2), 'utf8')
        },
      },
      `${headerFor(ORIGINAL)}\n${replaceTwoBody('TWO')}`,
    )).rejects.toThrow(/Re-read the file and try again/)
  })

  it('fails on malformed input before any filesystem access', async () => {
    const casBasis = vi.fn()
    const read = vi.fn()
    const write = vi.fn()

    await expect(runHashlineEdit({ displayPath: 'a.txt', casBasis, read, write }, 'not a patch'))
      .rejects.toThrow(/file header/)
    expect(casBasis).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
