/**
 * Layered recall core invariants: the indexed answer equals the linear answer
 * byte-for-byte, the index refreshes incrementally, and every index failure
 * degrades silently to layer 0 on a real JSONL corpus.
 *
 * @module @deepseek-ai/dsh-session-query/tests/layered-search
 */

import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { searchEventLines } from '@deepseek-ai/dsh-session-persistence-jsonl/src/search-sessions.ts'
import {
  LayeredSessionRecall,
  foldForIndex,
  linearSessionRecall,
  recallKeyOf,
} from '../src/layered-search.ts'
import type { LayeredRecallMode, LayeredRecallOptions } from '../src/layered-search.ts'
import {
  cleanupRecallFixtures,
  persistSession,
  recallEvent,
  recallFixture,
  recallHeader,
} from './recall-fixture.ts'
import type { RecallFixture } from './recall-fixture.ts'

afterEach(async () => {
  await cleanupRecallFixtures()
})

/** The deterministic parity corpus, persisted newest-last to prove the order. */
async function parityCorpus(fixture: RecallFixture): Promise<void> {
  await persistSession(fixture.ctx, recallHeader('epsilon', 5), [
    'ςigma step completes',
    'İstanbulışıklar evening',
  ])
  await persistSession(fixture.ctx, recallHeader('gamma', 10), [
    'nothing relevant here',
    'gamma notes without matches',
  ])
  await persistSession(fixture.ctx, recallHeader('zeta', 15), [
    'before neighbour',
    `${'A'.repeat(500)} needleword ${'B'.repeat(500)}`,
    'after neighbour',
  ])
  await persistSession(fixture.ctx, recallHeader('beta', 20), [
    'BETA channel ships Fibonacci optimizer',
    'FIBONACCI ship list updated',
    'companion entry without needle',
  ])
  await persistSession(fixture.ctx, recallHeader('alpha', 30), [
    'Alpha release notes',
    'fibonacci regression fixed in build 501',
  ])
  await persistSession(fixture.ctx, recallHeader('delta', 40), [
    'alpha.beta pipeline documented',
    'repeated alpha wording alpha again',
  ])
}

/** One parity case: the query, the layer expected to answer, and hit ids. */
interface ParityCase {
  readonly query: RegExp
  readonly mode: LayeredRecallMode
  readonly ids?: readonly string[]
  readonly options?: LayeredRecallOptions
}

const PARITY_CASES: readonly ParityCase[] = [
  { query: /fibonacci/i, mode: 'index', ids: ['alpha', 'beta'] },
  { query: /FIBONACCI/, mode: 'index', ids: ['beta'] },
  { query: /alpha.beta/, mode: 'index', ids: ['delta'] },
  { query: /fib|alpha/, mode: 'linear' },
  { query: /\d+/, mode: 'linear', ids: ['alpha'] },
  { query: /σ/i, mode: 'index', ids: ['epsilon'] },
  { query: new RegExp('ışık', 'ui'), mode: 'linear', ids: ['epsilon'] },
  { query: /^Alpha/m, mode: 'index', ids: ['alpha'] },
  { query: /nothing/, mode: 'index', ids: ['gamma'] },
  { query: /noSuchNeedle/, mode: 'index', ids: [] },
  { query: /e+/, mode: 'linear' },
  { query: /alpha/i, mode: 'index', ids: ['delta', 'alpha'] },
  { query: /needleword/i, mode: 'index', ids: ['zeta'] },
  { query: /beta/y, mode: 'index', ids: ['delta'] },
  {
    query: /alpha/i,
    mode: 'index',
    ids: ['delta', 'alpha'],
    options: { before: 0, after: 0, snippetChars: 12, limit: 1 },
  },
]

/** One physical line that stores an event record rather than metadata. */
function isPackedEventLine(line: string): boolean {
  try {
    const record = JSON.parse(line) as { seq?: unknown }
    return typeof record.seq === 'number'
  } catch {
    return false
  }
}

describe('layered recall: indexed answers equal the linear scan', () => {
  it('reproduces layer-0 hits across every query class on the real corpus', async () => {
    const fixture = await recallFixture()
    await parityCorpus(fixture)
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })

    // Lazy build: nothing touches the derived file before the first search.
    await expect(stat(fixture.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })

    for (const parityCase of PARITY_CASES) {
      const options = parityCase.options ?? {}
      const indexed = await recall.search(parityCase.query, options)
      const linear = await linearSessionRecall(fixture.ctx.sessionPersistence, parityCase.query, options)
      expect(linear.mode).toBe('linear')
      expect(indexed.mode).toBe(parityCase.mode)
      expect(indexed.sessions).toEqual(linear.sessions)
      if (parityCase.ids !== undefined) {
        expect(indexed.sessions.map(hit => hit.sessionId)).toEqual(parityCase.ids)
      }
      if (parityCase.options !== undefined) {
        expect(indexed.sessions.every(hit => hit.hits.length === 1)).toBe(true)
      }
    }

    await expect(stat(fixture.indexPath)).resolves.toBeTruthy()
    const assertionCalls = expect.getState().assertionCalls
    console.log(
      `layered parity: ${PARITY_CASES.length} query classes compared, ${assertionCalls} assertions`,
    )
    expect(assertionCalls).toBeGreaterThanOrEqual(PARITY_CASES.length * 3)
    recall.close()
  })

  it('keeps the match-centred snippet and anchored window of layer 0', async () => {
    const fixture = await recallFixture()
    await parityCorpus(fixture)
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const indexed = await recall.search(/needleword/i)
    const linear = await linearSessionRecall(fixture.ctx.sessionPersistence, /needleword/i)
    expect(indexed.sessions).toEqual(linear.sessions)
    const [zeta] = indexed.sessions
    if (zeta === undefined) throw new Error('expected the zeta session')
    expect(zeta.sessionId).toBe('zeta')
    const [hit] = zeta.hits
    if (hit === undefined) throw new Error('expected the needleword hit')
    expect(hit.seq).toBe(1)
    expect(hit.kind).toBe('user/message')
    expect(hit.role).toBe('user')
    expect(hit.matches).toBe(1)
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet).toContain('needleword')
    expect(hit.context.map(each => each.seq)).toEqual([0, 2])
    expect(hit.context[0]?.text).toBe('user/message\nbefore neighbour')
    recall.close()
  })

  it('matches the packed event lines byte-for-byte on the fixture file', async () => {
    const fixture = await recallFixture()
    await parityCorpus(fixture)
    const entries = await readdir(fixture.root, { recursive: true })
    const packedLines: string[] = []
    for (const relative of entries.filter(name => name.endsWith('.jsonl'))) {
      const text = await readFile(join(fixture.root, relative), 'utf8')
      if (!text.includes('needleword')) continue
      packedLines.push(...text.split('\n').filter(isPackedEventLine))
      break
    }
    expect(packedLines).toHaveLength(3)

    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const indexed = await recall.search(/needleword/i)
    const fromPacked = searchEventLines(packedLines, /needleword/i)
    expect(indexed.sessions[0]?.hits).toEqual(fromPacked)

    const handle = await fixture.ctx.sessionPersistence.open(SessionId('zeta'), 'read')
    const read = await handle.read(0, undefined)
    await handle.close()
    const recallInput = read.events.map(event => JSON.stringify(event))
    expect(searchEventLines(recallInput, /needleword/i)).toEqual(fromPacked)
    recall.close()
  })
})

describe('layered recall: incremental lifecycle', () => {
  it('builds lazily, refreshes only changed sessions, and restarts warm', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('n1', 10), ['stable corpus entry'])
    await persistSession(fixture.ctx, recallHeader('n2', 20), ['stable second entry'])
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })

    await expect(stat(fixture.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const first = await recall.search(/stable/i)
    expect(first.mode).toBe('index')
    expect(first.refreshed).toBe(2)
    await expect(stat(fixture.indexPath)).resolves.toBeTruthy()

    const second = await recall.search(/stable/i)
    expect(second.refreshed).toBe(0)
    expect(second.sessions).toEqual(first.sessions)

    const absent = await recall.search(/laterneedle/i)
    expect(absent.sessions).toEqual([])
    expect(absent.refreshed).toBe(0)

    const handle = await fixture.ctx.sessionPersistence.open(SessionId('n1'), 'write')
    await handle.append([recallEvent('laterneedle appears after append', 1, 40)])
    await handle.close()
    const appended = await recall.search(/laterneedle/i)
    expect(appended.mode).toBe('index')
    expect(appended.refreshed).toBe(1)
    expect(appended.sessions.map(hit => hit.sessionId)).toEqual(['n1'])

    await persistSession(fixture.ctx, recallHeader('n3', 50), ['brandnew third session'])
    const grown = await recall.search(/brandnew/i)
    expect(grown.refreshed).toBe(1)
    expect(grown.sessions.map(hit => hit.sessionId)).toEqual(['n3'])

    recall.close()
    const restarted = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const warm = await restarted.search(/stable/i)
    expect(warm.mode).toBe('index')
    expect(warm.refreshed).toBe(0)
    // The corpus moved on (append + new session), so warm equals a fresh
    // linear run over the current corpus, not the original snapshot.
    const warmLinear = await linearSessionRecall(fixture.ctx.sessionPersistence, /stable/i)
    expect(warm.sessions).toEqual(warmLinear.sessions)
    restarted.close()
  })

  it('drops indexed sessions another store does not list', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('one', 10), ['shared needle alpha'])
    await persistSession(fixture.ctx, recallHeader('two', 20), ['shared needle beta'])
    const first = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const built = await first.search(/shared needle/i)
    expect(built.refreshed).toBe(2)
    first.close()

    const other = await recallFixture()
    await persistSession(other.ctx, recallHeader('three', 30), ['shared needle gamma'])
    const second = new LayeredSessionRecall(other.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const swapped = await second.search(/shared needle/i)
    expect(swapped.mode).toBe('index')
    expect(swapped.refreshed).toBe(1)
    expect(swapped.sessions.map(hit => hit.sessionId)).toEqual(['three'])
    second.close()

    const db = new DatabaseSync(fixture.indexPath)
    const rows = db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all() as Array<{
      session_id: string
    }>
    db.close()
    expect(rows.map(row => row.session_id)).toEqual(['three'])
  })

  it('rebuilds explicitly from persistence alone', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('r1', 10), ['rebuildme first session'])
    await persistSession(fixture.ctx, recallHeader('r2', 20), ['rebuildme second session'])
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const healthy = await recall.search(/rebuildme/i)
    expect(healthy.mode).toBe('index')
    expect(healthy.refreshed).toBe(2)
    recall.close()

    await writeFile(fixture.indexPath, 'garbage before rebuild')
    await recall.rebuild()
    const after = await recall.search(/rebuildme/i)
    expect(after.mode).toBe('index')
    expect(after.refreshed).toBe(0)
    expect(after.sessions).toEqual(healthy.sessions)
    recall.close()
  })

  it('reports cancellation through the session-query taxonomy', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('a1', 10), ['abort target text'])
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(recall.search(/abort/, { signal: controller.signal }))
      .rejects.toThrow(expect.objectContaining({ code: 'SESSION_QUERY_ABORTED' }))
    recall.close()
  })
})

describe('layered recall: index failures degrade to layer 0', () => {
  it('drops a corrupt index, answers linearly, and rebuilds on the next search', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('c1', 10), ['corruptneedle first session'])
    await persistSession(fixture.ctx, recallHeader('c2', 20), ['corruptneedle second session'])
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const healthy = await recall.search(/corruptneedle/i)
    expect(healthy.mode).toBe('index')
    expect(healthy.refreshed).toBe(2)
    recall.close()

    await writeFile(fixture.indexPath, 'not a sqlite database at all')
    const degraded = await recall.search(/corruptneedle/i)
    expect(degraded.mode).toBe('linear')
    expect(degraded.sessions).toEqual(healthy.sessions)

    const rebuilt = await recall.search(/corruptneedle/i)
    expect(rebuilt.mode).toBe('index')
    expect(rebuilt.refreshed).toBe(2)
    expect(rebuilt.sessions).toEqual(healthy.sessions)
    recall.close()
  })

  it('drops a stale-schema index without waiting for corruption', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('s1', 10), ['stalenef session text'])
    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const healthy = await recall.search(/stalenef/i)
    expect(healthy.mode).toBe('index')
    recall.close()

    const db = new DatabaseSync(fixture.indexPath)
    db.exec('PRAGMA user_version = 99')
    db.close()
    const degraded = await recall.search(/stalenef/i)
    expect(degraded.mode).toBe('linear')
    expect(degraded.sessions).toEqual(healthy.sessions)

    const rebuilt = await recall.search(/stalenef/i)
    expect(rebuilt.mode).toBe('index')
    expect(rebuilt.sessions).toEqual(healthy.sessions)
    recall.close()
  })

  it('refuses a foreign database and leaves its bytes alone', async () => {
    const fixture = await recallFixture()
    await persistSession(fixture.ctx, recallHeader('f1', 10), ['foreignneedle session text'])
    const foreign = new DatabaseSync(fixture.indexPath)
    foreign.exec('PRAGMA application_id = 7')
    foreign.exec('CREATE TABLE alien (value INTEGER NOT NULL)')
    foreign.close()

    const recall = new LayeredSessionRecall(fixture.ctx.sessionPersistence, {
      indexPath: fixture.indexPath,
    })
    const first = await recall.search(/foreignneedle/i)
    expect(first.mode).toBe('linear')
    expect(first.sessions).toHaveLength(1)
    await expect(stat(fixture.indexPath)).resolves.toBeTruthy()

    const second = await recall.search(/foreignneedle/i)
    expect(second.mode).toBe('linear')
    await expect(stat(fixture.indexPath)).resolves.toBeTruthy()
    recall.close()
  })
})

describe('recall key contract', () => {
  it('extracts folded literal runs and refuses unsafe patterns', () => {
    expect(recallKeyOf(new RegExp('foo', 'i'))).toBe('FOO')
    expect(recallKeyOf(/foo.bar/)).toBe('FOO')
    expect(recallKeyOf(/foo.bart/)).toBe('BART')
    expect(recallKeyOf(/^foo$/m)).toBe('FOO')
    expect(recallKeyOf(/graß/)).toBe('GRASS')
    expect(foldForIndex('ςigma Istanbul İ ı')).toBe('ΣIGMA ISTANBUL İ I')
    for (const query of [
      /a|b/,
      /[abc]/,
      /\d+/,
      /(foo)/,
      /fo+o/,
      /fo?o/,
      /a\.b/,
      /a{2}/,
      /.*/,
      new RegExp('abc', 'u'),
      new RegExp('abc', 'v'),
      new RegExp(''),
      /\w+/,
    ]) {
      expect(recallKeyOf(query)).toBeUndefined()
    }
  })

  it('folds case variants the way the matcher compares them', () => {
    const characters = [
      'a', 'A', 'i', 'I', 'İ', 'ı', 's', 'S', 'ſ', 'σ', 'Σ', 'ς', 'k', 'K', 'K',
      'µ', 'μ', 'Å', 'Å', 'ß', 'ẞ', 'ﬁ', 'C', 'C', 'с', 'С', 'я', 'Я',
      'é', 'É', 'ê', 'Ê', 'ñ', 'Ñ', 'ü', 'Ü', 'α', 'Α', 'τ', 'Τ', 'ω', 'Ω', 'Ω',
    ]
    const flags = ['', 'i', 'mi', 'si', 'gi']
    const violations: string[] = []
    let matches = 0
    for (const flag of flags) {
      for (const query of characters) {
        for (const text of characters) {
          let matched = false
          try {
            matched = new RegExp(query, flag).test(text)
          } catch {
            continue
          }
          if (!matched) continue
          matches++
          if (foldForIndex(query) !== foldForIndex(text)) {
            violations.push(`/${query}/${flag} matched ${text} but folded apart`)
          }
        }
      }
    }
    console.log(`fold contract: ${matches} matcher hits checked across ${flags.length} flag sets`)
    expect(violations).toEqual([])
    expect(matches).toBeGreaterThan(100)
  })
})
