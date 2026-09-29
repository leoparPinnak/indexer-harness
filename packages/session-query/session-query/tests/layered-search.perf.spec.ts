/**
 * Layered recall performance smoke on a deterministic 500 × 50 synthetic
 * corpus: the pure-linear wall time is the baseline, the first indexed search
 * carries the lazy build, and every later search must beat the baseline.
 *
 * @module @deepseek-ai/dsh-session-query/tests/layered-search-perf
 */

import { afterEach, describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import { LayeredSessionRecall, linearSessionRecall } from '../src/layered-search.ts'
import { cleanupRecallFixtures, persistSession, recallFixture, recallHeader } from './recall-fixture.ts'

afterEach(async () => {
  await cleanupRecallFixtures()
})

const SESSION_COUNT = 500
const ENTRIES_PER_SESSION = 50
const NEEDLE_SESSIONS = [7, 131, 402]
const QUERY = /zephyrneedle/i

/** One deterministic corpus entry; the needle lands in exactly three sessions. */
function corpusEntry(session: number, entry: number): string {
  const needle = NEEDLE_SESSIONS.includes(session) && entry === 25 ? ' zephyrneedle appears here ' : ''
  return `session ${session} entry ${entry}: deterministic corpus line about foxes and rivers ${session * ENTRIES_PER_SESSION + entry}${needle}`
}

describe('layered recall performance', () => {
  it('beats the linear scan over 500 sessions × 50 entries after the first build', async () => {
    const fixture = await recallFixture()
    for (let session = 0; session < SESSION_COUNT; session++) {
      const texts = []
      for (let entry = 0; entry < ENTRIES_PER_SESSION; entry++) {
        texts.push(corpusEntry(session, entry))
      }
      await persistSession(fixture.ctx, recallHeader(`perf-${session}`, 1_000 + session), texts)
    }

    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })

    const linearStart = performance.now()
    const linear = await linearSessionRecall(fixture.ctx.sessionPersistence, QUERY)
    const linearMs = performance.now() - linearStart

    const coldStart = performance.now()
    const cold = await recall.search(QUERY)
    const coldMs = performance.now() - coldStart

    const warmStart = performance.now()
    const warm = await recall.search(QUERY)
    const warmMs = performance.now() - warmStart

    expect(linear.sessions.map(hit => hit.sessionId)).toEqual(['perf-402', 'perf-131', 'perf-7'])
    expect(cold.sessions).toEqual(linear.sessions)
    expect(warm.sessions).toEqual(linear.sessions)
    expect(cold.mode).toBe('index')
    expect(cold.refreshed).toBe(SESSION_COUNT)
    expect(cold.candidates).toBe(NEEDLE_SESSIONS.length)
    expect(warm.refreshed).toBe(0)
    expect(warm.candidates).toBe(NEEDLE_SESSIONS.length)

    // The budget: after the first build an indexed search beats the linear scan.
    expect(warmMs).toBeLessThan(linearMs)
    expect(warmMs).toBeLessThan(5_000)
    expect(coldMs).toBeLessThan(30_000)
    await expect(stat(fixture.indexPath)).resolves.toBeTruthy()

    console.log(
      `layered recall perf (500×${ENTRIES_PER_SESSION} corpus): `
      + `linear ${linearMs.toFixed(1)}ms | cold build+search ${coldMs.toFixed(1)}ms | `
      + `warm ${warmMs.toFixed(1)}ms | candidates ${warm.candidates}/${SESSION_COUNT}`,
    )
    recall.close()
  }, 60_000)
})
