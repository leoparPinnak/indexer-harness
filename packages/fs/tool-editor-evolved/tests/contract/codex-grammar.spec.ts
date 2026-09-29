/**
 * Codex apply_patch grammar counter-scenarios (codex.exe @229437162): every
 * violation Codex rejects must ALSO be rejected by the hashline layer — the
 * context-line requirement ("Every line should start with ' ' (context line),
 * '+' (added line), or '-' (removed line)"), the `*** End Patch` closure, the
 * `*** Begin Patch` opener, and empty hunks ("Update hunk does not contain any
 * lines"). And Codex's benign "No files were modified." report must never
 * become a silent success here: a patch that changes nothing is an error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { parseHashlinePatch, runHashlineEdit } from '../../src/index.ts'
import { fixture, headerFor, patch, rejectsPlain, throwsPlain, type EditorFixture } from './harness.ts'

const BEFORE = 'export function main() {\n  run()\n}\n'
const AFTER = 'export function main() {\n  run({ strict: true })\n}\n'
const HUNK = [
  '@@ 1',
  ' 1| export function main() {',
  '-2|   run()',
  '+2|   run({ strict: true })',
  ' 3| }',
]
const EMPTY_HUNK_MESSAGE = /^hashline patch: hunk at line \d+ has no -\/\+ lines$/

let x: EditorFixture
beforeEach(async () => {
  x = await fixture(BEFORE)
})
afterEach(async () => {
  await x.dispose()
})

describe('Codex grammar violations rejected at the hashline layer', () => {
  it('applies the canonical example (baseline the negatives are read against)', async () => {
    const result = await runHashlineEdit(x.io, patch(x.displayPath, BEFORE, ...HUNK))
    expect(result.replacements).toBe(1)
    expect(await x.disk()).toBe(AFTER)
    expect(x.writes).toHaveLength(1)
  })

  it('requires a marker prefix on every body line (bare line number is rejected)', () => {
    // Codex: a line that starts with a bare line number instead of ' '/'-'/'+'.
    const src = `${headerFor(x.displayPath, BEFORE)}\n@@ 1\n4| export function main() {\n-2|   run()\n+2|   run({ strict: true })\n 3| }`
    throwsPlain(() => parseHashlinePatch(src))
  })

  it("rejects Codex's trailing '*** End Patch' line", () => {
    const error = throwsPlain(() => parseHashlinePatch(`${patch(x.displayPath, BEFORE, ...HUNK)}\n*** End Patch`))
    expect(error.message).toContain('must be a `@@ <line>` opener')
  })

  it("rejects Codex's leading '*** Begin Patch' line", () => {
    const error = throwsPlain(() => parseHashlinePatch(`*** Begin Patch\n${patch(x.displayPath, BEFORE, ...HUNK)}`))
    expect(error.message).toContain('the first line must be the file header')
  })

  it('rejects a context-only hunk (no -/+ lines): Codex "does not contain any lines"', () => {
    const src = `${headerFor(x.displayPath, BEFORE)}\n@@ 1\n 1| export function main() {\n 2|   run()`
    const error = throwsPlain(() => parseHashlinePatch(src))
    expect(error.message).toMatch(EMPTY_HUNK_MESSAGE)
  })

  it('rejects an empty hunk (@@ with no body lines at all)', () => {
    const error = throwsPlain(() => parseHashlinePatch(`${headerFor(x.displayPath, BEFORE)}\n@@ 1`))
    expect(error.message).toMatch(EMPTY_HUNK_MESSAGE)
  })

  it('rejects an empty line inside a hunk body', () => {
    const src = `${headerFor(x.displayPath, BEFORE)}\n@@ 1\n 1| export function main() {\n\n-2|   run()\n+2|   run({ strict: true })`
    throwsPlain(() => parseHashlinePatch(src))
  })

  it('rejects a patch without a header line', () => {
    const error = throwsPlain(() => parseHashlinePatch('@@ 1\n 1| export function main() {\n-2|   run()\n+2|   run({ strict: true })'))
    expect(error.message).toContain('the first line must be the file header')
  })

  it('rejects a body that never opens a @@ hunk', () => {
    const error = throwsPlain(() => parseHashlinePatch(`${headerFor(x.displayPath, BEFORE)}\n 1| export function main() {\n-2|   run()\n+2|   run({ strict: true })`))
    expect(error.message).toContain('appears before any `@@ <line>` hunk')
  })

  it('fails a grammar violation before any filesystem access', async () => {
    // runHashlineEdit parses first: a malformed patch must not even reach casBasis.
    const malformed = `${headerFor(x.displayPath, BEFORE)}\n@@ 1\n*** End Patch`
    await rejectsPlain(runHashlineEdit(x.io, malformed))
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(BEFORE)
  })

  it("a patch that matches nothing is an error, never Codex's 'No files were modified.'", async () => {
    // Grammar is valid; the context block simply is not in the file.
    const src = patch(x.displayPath, BEFORE, '@@ 1', ' 1| export function nowhere() {', '-2|   run()', '+2|   run({ strict: true })', ' 3| }')
    await expect(runHashlineEdit(x.io, src)).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(x.writes).toHaveLength(0)
    expect(await x.disk()).toBe(BEFORE)
  })

  it('normalizes CRLF patch input to LF before parsing', async () => {
    const crlf = patch(x.displayPath, BEFORE, ...HUNK).replace(/\n/g, '\r\n')
    const result = await runHashlineEdit(x.io, crlf)
    expect(result.after).toBe(AFTER)
    expect(await x.disk()).toBe(AFTER)
  })

  it('preserves the source CRLF line endings through the patch (D5-1 regression)', async () => {
    const crlf = 'export function main() {\r\n  run()\r\n}\r\n'
    await writeFile(x.path, crlf) // re-seed the fixture as a CRLF file
    await x.observe()
    const src = patch(x.displayPath, crlf, '@@ 1', ' 1| export function main() {', '-2|   run()', '+2|   run({ strict: true })', ' 3| }')
    const result = await runHashlineEdit(x.io, src)
    // The edit lands, and the file keeps its CRLF style (never silently flattened to LF).
    expect(result.after).toBe('export function main() {\r\n  run({ strict: true })\r\n}\r\n')
    expect(await x.disk()).toBe('export function main() {\r\n  run({ strict: true })\r\n}\r\n')
  })
})
