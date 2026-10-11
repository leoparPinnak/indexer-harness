/**
 * CAS race counter-scenario (briefing item 4): two concurrent hashline edits
 * over the same base version — exactly one may win, the loser must fail with an
 * explicit error, and the winner's bytes must be verified.
 *
 * This is DSH's "verify the winner" primitive (session-persistence-jsonl
 * generation.ts / retry-jitter.ts: identical bytes → accept, different bytes →
 * real conflict). The race runs against the REAL `LocalFileSystem` so
 * replaceIfVersion semantics are the ones fs-local already proved — not a fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHashlineEdit } from '../../src/index.ts'
import { fixture, patch, type EditorFixture } from './harness.ts'

const BEFORE = 'export function main() {\n  run()\n}\n'
const AFTER_ONE = 'export function main() {\n  run({ strict: true })\n}\n'
const AFTER_TWO = 'export function main() {\n  run({ verbose: true })\n}\n'
const HUNK_ONE = [
  '@@ 1',
  ' 1| export function main() {',
  '-2|   run()',
  '+2|   run({ strict: true })',
  ' 3| }',
]
const HUNK_TWO = [
  '@@ 1',
  ' 1| export function main() {',
  '-2|   run()',
  '+2|   run({ verbose: true })',
  ' 3| }',
]

let x: EditorFixture
beforeEach(async () => {
  x = await fixture(BEFORE)
})
afterEach(async () => {
  await x.dispose()
})

describe('CAS race: one winner, explicit loser, verified bytes', () => {
  it('two concurrent edits from the same base: one wins, one FS_STALE_VERSION', async () => {
    // Barrier: both runs capture their CAS basis and read BEFORE either writes,
    // so the race really lands on the compare-and-swap step.
    let reads = 0
    let releaseReads!: () => void
    const readBarrier = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const baseIo = x.io
    const racingIo = {
      ...baseIo,
      casBasis: async () => {
        const basis = await baseIo.casBasis()
        if (++reads === 2) releaseReads()
        await readBarrier
        return basis
      },
    }

    const one = runHashlineEdit(racingIo, patch(x.displayPath, BEFORE, ...HUNK_ONE))
    const two = runHashlineEdit(racingIo, patch(x.displayPath, BEFORE, ...HUNK_TWO))
    const results = await Promise.allSettled([one, two])

    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser fails explicitly — never a silent overwrite or a lost update.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })

    // The winner's content is on disk, byte for byte (verify-the-winner).
    const winner = fulfilled[0] as PromiseFulfilledResult<{ after: string }>
    const onDisk = await x.disk()
    expect(onDisk).toBe(winner.value.after)
    expect([AFTER_ONE, AFTER_TWO]).toContain(onDisk)

    // Both write attempts were made; exactly one committed.
    expect(x.writes).toHaveLength(2)
  })

  it('the loser may re-read and retry with a fresh basis (recovery is possible)', async () => {
    const results = await Promise.allSettled([
      runHashlineEdit(x.io, patch(x.displayPath, BEFORE, ...HUNK_ONE)),
      runHashlineEdit(x.io, patch(x.displayPath, BEFORE, ...HUNK_TWO)),
    ])
    const loser = results.find(result => result.status === 'rejected')
    expect(loser).toBeDefined()
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })

    // Fresh read + fresh hash + fresh CAS basis: the retry succeeds.
    // The winner's content differs per race outcome, so derive the hunk from
    // what is actually on disk rather than assuming which patch won.
    const current = await x.disk()
    const winnerLine = current.split('\n')[1] ?? ''
    const retry = patch(x.displayPath, current, '@@ 1', ' 1| export function main() {', `-2| ${winnerLine}`, '+2|   run({ strict: true })', ' 3| }')
    const result = await runHashlineEdit(x.io, retry)
    expect(result.after).toBe(AFTER_ONE)
    expect(await x.disk()).toBe(AFTER_ONE)
  })
})
