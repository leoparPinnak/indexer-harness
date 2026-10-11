/**
 * Contract: Hermes two-phase atomicity + post-write byte verification.
 *
 * Sources (read-only):
 * - `Desktop/hermes/tools/patch_parser.py:253` — `apply_v4a_operations`:
 *   "Two-phase: validate everything, then apply (atomic on validation failure)";
 *   a validation failure reports `Patch validation failed (no files were modified)`
 *   and NO file is written — a half-applied multi-op patch must be impossible.
 * - `Desktop/hermes/tools/file_operations.py:1290/1311` — `_verify_patch_persisted`:
 *   re-read the target and compare bytes; on drift the patch did not persist and
 *   the error carries the `Re-read the file and try again` remedy.
 *
 * Counter-scenarios: a patch whose SECOND hunk fails validation must not write
 * the first hunk's bytes, and a silent persistence failure must surface as an
 * explicit error, never as success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHashlineEdit, verifyPatchedBytes } from '../../src/index.ts'
import { fixture, patch, rejectsPlain, type EditorFixture } from './harness.ts'

const BEFORE = 'export function main() {\n  run()\n}\nexport function tail() {\n  idle()\n}\n'
const AFTER = 'export function main() {\n  run({ strict: true })\n}\nexport function tail() {\n  idle()\n}\n'
const FIRST_HUNK = [
  '@@ 1',
  ' 1| export function main() {',
  '-2|   run()',
  '+2|   run({ strict: true })',
  ' 3| }',
]
/** Second hunk whose context block does not exist — validation must fail here. */
const BROKEN_SECOND_HUNK = [
  '@@ 9',
  ' 9| export function ghost() {',
  '-10|   vanish()',
  '+10|   appear()',
  ' 11| }',
]

let x: EditorFixture
beforeEach(async () => {
  x = await fixture(BEFORE)
})
afterEach(async () => {
  await x.dispose()
})

describe('Hermes two-phase atomicity: validation failure writes nothing', () => {
  it('a two-hunk patch whose second hunk fails validation writes neither hunk', async () => {
    const src = patch(x.displayPath, BEFORE, ...FIRST_HUNK, ...BROKEN_SECOND_HUNK)
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    // No half-applied patch: the write seam was never reached.
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(BEFORE)
  })

  it('a hash mismatch rejects before any hunk is located, leaving the file untouched', async () => {
    // Patch built over an older read: header hash no longer matches the file.
    const stale = patch(x.displayPath, 'export function main() {\n  run()\n}\nexport function tail() {\n  idle()\n}\n// drifted\n', ...FIRST_HUNK)
    await expect(runHashlineEdit(x.io, stale)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(BEFORE)
  })

  it('the fully valid multi-hunk patch applies both hunks in one write (baseline)', async () => {
    const src = patch(x.displayPath, BEFORE, ...FIRST_HUNK, '@@ 5', ' 5| export function tail() {', '-6|   idle()', '+6|   idle({ quiet: true })', ' 7| }')
    const result = await runHashlineEdit(x.io, src)
    expect(result.replacements).toBe(2)
    expect(await x.disk()).toBe(
      'export function main() {\n  run({ strict: true })\n}\nexport function tail() {\n  idle({ quiet: true })\n}\n',
    )
    expect(x.writes).toHaveLength(1)
  })
})

describe('Hermes verify contract: post-write byte comparison', () => {
  it('accepts byte-identical persistence', () => {
    expect(() => verifyPatchedBytes('a.txt', 'const a = 1\n', 'const a = 1\n')).not.toThrow()
  })

  it('rejects drift with the byte-level report and the re-read remedy', () => {
    expect(() => verifyPatchedBytes('a.txt', 'const a = 1\n', 'const a = 2\n')).toThrow(
      'Edit verification failed for a.txt: the file on disk does not match the patched content '
      + '(12 bytes persisted, 12 intended, first difference at byte 10). Re-read the file and try again.',
    )
  })

  it('rejects truncation (partial write) rather than passing it off as success', () => {
    expect(() => verifyPatchedBytes('a.txt', 'line1\nline2\nline3\n', 'line1\nline2\n')).toThrow(
      'Edit verification failed for a.txt: the file on disk does not match the patched content '
      + '(12 bytes persisted, 18 intended, first difference at byte 12). Re-read the file and try again.',
    )
  })

  it('a write that silently lands different bytes fails the run with the remedy', async () => {
    // Persistence sabotage: the guarded write succeeds but stores other bytes.
    const originalWrite = x.io.write
    x.io.write = async (content, expected) => {
      await originalWrite(`${content}// tampered\n`, expected)
    }
    const tampered = `${AFTER}// tampered\n`
    const src = patch(x.displayPath, BEFORE, ...FIRST_HUNK)
    const error = await rejectsPlain(runHashlineEdit(x.io, src))
    expect(error.message).toBe(
      'Edit verification failed for a.txt: the file on disk does not match the patched content '
      + `(${Buffer.byteLength(tampered)} bytes persisted, ${Buffer.byteLength(AFTER)} intended, `
      + `first difference at byte ${Buffer.byteLength(AFTER)}). Re-read the file and try again.`,
    )
    expect(x.writes).toHaveLength(1)
  })
})
