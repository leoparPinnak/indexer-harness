import { describe, expect, it } from 'vitest'
import { CheckpointJournal, type CheckpointIo, type CheckpointStep } from '../src/checkpoint.ts'
import {
  attachCheckpointRecorder,
  type CheckpointToolCall,
  type CheckpointToolTaps,
} from '../src/checkpoint-recorder.ts'

/** In-memory journal store. */
function memoryIo(): CheckpointIo {
  const lines: string[] = []
  const blobs = new Map<string, string>()
  return {
    appendLine: line => { lines.push(line) },
    readLines: () => [...lines],
    writeBlob: (name, content) => { blobs.set(name, content) },
    readBlob: name => blobs.get(name),
  }
}

/** Fake taps the tests fire by hand. */
function fakeTaps(): CheckpointToolTaps & { firePre(call: CheckpointToolCall): void; firePost(call: CheckpointToolCall, ok: boolean): void; live(): number } {
  const pres = new Set<(c: CheckpointToolCall) => void>()
  const posts = new Set<(c: CheckpointToolCall, ok: boolean) => void>()
  return {
    pre: (listener) => { pres.add(listener); return () => { pres.delete(listener) } },
    post: (listener) => { posts.add(listener); return () => { posts.delete(listener) } },
    firePre: call => { for (const each of pres) each(call) },
    firePost: (call, ok) => { for (const each of posts) each(call, ok) },
    live: () => pres.size + posts.size,
  }
}

describe('checkpoint recorder: bridging the lifecycle', () => {
  it('records ONE step per writing call, with pre-image and creations', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    const files = new Map([['a.ts', 'İÇERİK']])
    attachCheckpointRecorder(taps, journal, {
      paths: call => (call.name === 'edit' ? ['a.ts'] : null),
      creates: call => (call.name === 'write' ? ['yeni.ts'] : []),
      read: path => files.get(path),
    })
    taps.firePre({ callId: '1', name: 'edit' })
    taps.firePre({ callId: '2', name: 'write' })
    const steps: CheckpointStep[] = journal.steps()
    expect(steps).toHaveLength(2)
    expect(steps[0]?.captured).toEqual([{ path: 'a.ts', blob: 'b1-0.txt' }])
    expect(steps[0]?.label).toBe('edit#1')
    expect(steps[1]?.created).toEqual(['yeni.ts'])
  })

  it('SKIPS non-writing calls entirely (paths null, nothing created)', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    attachCheckpointRecorder(taps, journal, {
      paths: () => null,
      creates: () => [],
      read: () => undefined,
    })
    taps.firePre({ callId: 'x', name: 'read' })
    expect(journal.steps()).toHaveLength(0)
  })

  it('a missing file is not a pre-image — it rides as a birth', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    attachCheckpointRecorder(taps, journal, {
      paths: () => ['yok.ts'],
      creates: () => [],
      read: () => undefined,
    })
    taps.firePre({ callId: '1', name: 'edit' })
    const [step] = journal.steps()
    // Declared-but-missing → no blob captured; the plan treats born-in-window
    // paths as removals regardless.
    expect(step?.captured).toEqual([])
  })

  it('a recorder failure is isolated: onError fires, the tap never throws', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    const errors: unknown[] = []
    attachCheckpointRecorder(taps, journal, {
      paths: () => { throw new Error('plan patladı') },
      creates: () => [],
      read: () => undefined,
    }, { onError: error => { errors.push(error) } })
    expect(() => taps.firePre({ callId: '1', name: 'edit' })).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('even the error sink failing cannot reach the tool call', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    attachCheckpointRecorder(taps, journal, {
      paths: () => { throw new Error('plan patladı') },
      creates: () => [],
      read: () => undefined,
    }, { onError: () => { throw new Error('sink de patladı') } })
    expect(() => taps.firePre({ callId: '1', name: 'edit' })).not.toThrow()
  })

  it('dispose removes BOTH subscriptions', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    expect(taps.live()).toBe(0)
    const dispose = attachCheckpointRecorder(taps, journal, {
      paths: () => ['a.ts'],
      creates: () => [],
      read: () => 'x',
    })
    expect(taps.live()).toBe(2)
    dispose()
    expect(taps.live()).toBe(0)
    taps.firePre({ callId: '1', name: 'edit' })
    expect(journal.steps()).toHaveLength(0)
  })

  it('the post tap clears in-flight bookkeeping without touching the journal', () => {
    const journal = new CheckpointJournal(memoryIo())
    const taps = fakeTaps()
    attachCheckpointRecorder(taps, journal, {
      paths: call => (call.name === 'edit' ? ['a.ts'] : null),
      creates: () => [],
      read: () => 'önce',
    })
    taps.firePre({ callId: '1', name: 'edit' })
    taps.firePost({ callId: '1', name: 'edit' }, true)
    taps.firePost({ callId: '2', name: 'edit' }, false) // unknown id: harmless
    expect(journal.steps()).toHaveLength(1) // post never rewrites the pre-image log
  })
})