/**
 * Claude edit-safety trio counter-scenarios (claude.exe @257744673, errorCode
 * patterns 6/8): read-before-write, stale-read, and ambiguous match must keep
 * their errorCodes at the hashline layer.
 *
 * Claude originals:
 * - errorCode 6: "File has not been read yet. Read it first before writing to it."
 * - errorCode 10: "File has been modified since read, either by the user or by a
 *   linter. Read it again before attempting to write it."
 * - errorCode 8: "String to replace not found in file." / "Found N matches of the
 *   string to replace, but replace_all is false … provide more context to uniquely
 *   identify the instance."
 *
 * DSH mapping (existing vocabulary, no new codes): read requirement →
 * `FS_NOT_OBSERVED` (observation policy owns it), stale-read → `FS_STALE_VERSION`
 * (header hash + CAS), ambiguous → `FS_AMBIGUOUS_EDIT`.
 */
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHashlineEdit } from '../../src/index.ts'
import { fixture, patch, type EditorFixture } from './harness.ts'

const BEFORE = 'export function main() {\n  run()\n}\n'
const AFTER = 'export function main() {\n  run({ strict: true })\n}\n'
const HUNK = [
  '@@ 1',
  ' 1| export function main() {',
  '-2|   run()',
  '+2|   run({ strict: true })',
  ' 3| }',
]
/** A block that appears twice — the line evidence must pick one or reject. */
const DUPLICATE = 'const a = 1\nconst b = 2\nconst a = 1\nconst b = 2\n'

let x: EditorFixture
beforeEach(async () => {
  x = await fixture(BEFORE, { policy: true })
  x.io.casBasis = x.editIntent
})
afterEach(async () => {
  await x.dispose()
})

describe('Claude pattern 6: read requirement (FS_NOT_OBSERVED)', () => {
  it('rejects a hashline edit on a file that was never read', async () => {
    const src = patch(x.displayPath, BEFORE, ...HUNK)
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(BEFORE)
  })

  it('the remedy (read, then retry) makes the same patch succeed', async () => {
    const src = patch(x.displayPath, BEFORE, ...HUNK)
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await x.observe() // model-side Read refreshes the observation
    const result = await runHashlineEdit(x.io, src)
    expect(result.replacements).toBe(1)
    expect(await x.disk()).toBe(AFTER)
  })
})

describe('Claude pattern 10: stale read (FS_STALE_VERSION)', () => {
  it('a patch built over a pre-edit read is rejected as stale, file untouched', async () => {
    await x.observe()
    const src = patch(x.displayPath, BEFORE, ...HUNK)
    // Linter/user rewrites the file after the read (Claude's stale-read trigger).
    await writeFile(x.path, 'export function main() {\n  run() // formatted\n}\n')
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(x.writes).toHaveLength(0)
    // The stale write never landed: disk still holds the linter's bytes.
    expect(await x.disk()).toBe('export function main() {\n  run() // formatted\n}\n')
  })

  it('CAS basis captured before a concurrent write rejects the loser (stale version)', async () => {
    await x.observe()
    const basis = await x.editIntent()
    // A concurrent writer commits between the CAS basis and our write.
    await writeFile(x.path, 'export function main() {\n  run() // concurrent\n}\n')
    x.io.casBasis = async () => basis
    const src = patch(x.displayPath, 'export function main() {\n  run() // concurrent\n}\n', '@@ 1', ' 1| export function main() {', '-2|   run() // concurrent', '+2|   run({ strict: true })', ' 3| }')
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await x.disk()).toBe('export function main() {\n  run() // concurrent\n}\n')
  })
})

describe('Claude pattern 8: ambiguous match (FS_AMBIGUOUS_EDIT)', () => {
  it('a duplicate block whose line evidence picks no single match is ambiguous', async () => {
    await writeFile(x.path, DUPLICATE) // the fixture seeds BEFORE; re-seed the duplicate-block file
    await x.observe()
    // Evidence claims line 9 — neither occurrence lives there, so neither wins.
    const src = patch(x.displayPath, DUPLICATE, '@@ 9', ' 9| const a = 1', '-10| const b = 2', '+10| const b = 3')
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(DUPLICATE)
  })

  it('a duplicate block whose line evidence names one occurrence applies there', async () => {
    await writeFile(x.path, DUPLICATE)
    await x.observe()
    // Evidence claims line 3 — the second occurrence — so ambiguity resolves.
    const src = patch(x.displayPath, DUPLICATE, '@@ 3', ' 3| const a = 1', '-4| const b = 2', '+4| const b = 3')
    const result = await runHashlineEdit(x.io, src)
    expect(result.replacements).toBe(1)
    expect(await x.disk()).toBe('const a = 1\nconst b = 2\nconst a = 1\nconst b = 3\n')
  })

  it('a context block absent from the file is not-found (Claude errorCode 8 first arm)', async () => {
    await writeFile(x.path, DUPLICATE)
    await x.observe()
    const src = patch(x.displayPath, DUPLICATE, '@@ 1', ' 1| const missing = 0', '-2| const b = 2', '+2| const b = 3')
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(DUPLICATE)
  })
})
