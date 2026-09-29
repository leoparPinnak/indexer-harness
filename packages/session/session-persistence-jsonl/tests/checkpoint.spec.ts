import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CheckpointJournal,
  fileCheckpointIo,
  type CheckpointIo,
  type CheckpointStep,
} from '../src/checkpoint.ts'

/** In-memory seam: the tests own the truth, no disk involved. */
function memoryIo(): CheckpointIo & { lines: string[]; blobs: Map<string, string> } {
  const lines: string[] = []
  const blobs = new Map<string, string>()
  return {
    lines,
    blobs,
    appendLine: line => { lines.push(line) },
    readLines: () => [...lines],
    writeBlob: (name, content) => { blobs.set(name, content) },
    readBlob: name => blobs.get(name),
  }
}

describe('checkpoint journal: recording', () => {
  it('assigns seqs from 1 and continues after replay', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    expect(journal.record({ kind: 'write', label: 'ilk', captured: [], created: ['a.txt'] }).seq).toBe(1)
    expect(journal.record({ kind: 'edit', label: 'ikinci', captured: [], created: [] }).seq).toBe(2)
    // A fresh journal over the same store continues the numbering (idempotent ids).
    const reopened = new CheckpointJournal(io)
    expect(reopened.record({ kind: 'other', label: 'üç', captured: [], created: [] }).seq).toBe(3)
  })

  it('writes blobs first and names them inside the journal entry', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    const step = journal.record({
      kind: 'edit',
      label: 'degistir',
      captured: [{ path: 'a.ts', content: 'OLD' }],
      created: [],
    })
    expect(step.captured[0]?.blob).toBe('b1-0.txt')
    expect(io.blobs.get('b1-0.txt')).toBe('OLD')
  })

  it('a malformed journal line names the line and stops (no silent skip)', () => {
    const io = memoryIo()
    io.lines.push('{"seq":1,"label":"ok","kind":"other","captured":[],"created":[]}')
    io.lines.push('NOT JSON')
    expect(() => new CheckpointJournal(io)).toThrow(/journal line 2/)
  })
})

describe('checkpoint journal: rewind plans', () => {
  /** 3 steps: 1 creates a+b, 2 edits a (pre-image), 3 edits a again + creates c. */
  function fixture(): { journal: CheckpointJournal; io: ReturnType<typeof memoryIo> } {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({ kind: 'write', label: 'olustur', captured: [], created: ['a.txt', 'b.txt'] })
    journal.record({ kind: 'edit', label: 'a1', captured: [{ path: 'a.txt', content: 'AFTER1' }], created: [] })
    journal.record({ kind: 'edit', label: 'a2', captured: [{ path: 'a.txt', content: 'AFTER2' }], created: ['c.txt'] })
    return { journal, io }
  }

  it('restores the EARLIEST pre-image of a path across the dropped steps', () => {
    const { journal } = fixture()
    const plan = journal.rewindPlan(2) // back to BEFORE step 2 ran
    // Step 2's pre-image (AFTER1-era, blob b2-0) is the one nearest the target.
    expect(plan.restore).toEqual([{ path: 'a.txt', blob: 'b2-0.txt' }])
    expect(plan.remove).toEqual(['c.txt']) // created by step 3; b.txt was step 1 → survives
    expect(plan.dropSteps).toEqual([2, 3])
  })

  it('rewinding before the first step drops EVERYTHING created later', () => {
    const { journal } = fixture()
    const plan = journal.rewindPlan(1)
    // Everything 1..3 is undone: a and b were created in 1, c in 3 — all removed.
    expect(plan.restore).toEqual([])
    expect(plan.remove).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(plan.dropSteps).toEqual([1, 2, 3])
  })

  it('REGRESSION: a path born inside the window is REMOVED even if later steps captured it', () => {
    const { journal } = fixture()
    // Step 1 created a.txt; step 2 recorded a pre-image of that newborn file.
    // Rewinding before 1 must NOT resurrect a.txt from step 2's image — the
    // image is post-creation noise; before step 1 the file never existed.
    const plan = journal.rewindPlan(1)
    expect(plan.restore).toEqual([])
    expect(plan.remove).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('a pre-existing file is RESTORED from its earliest pre-image, never removed', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({ kind: 'edit', label: 'ilk', captured: [{ path: 'a.txt', content: 'V1' }], created: [] })
    journal.record({ kind: 'edit', label: 'ikinci', captured: [{ path: 'a.txt', content: 'V2' }], created: ['yeni.txt'] })
    const plan = journal.rewindPlan(1)
    // a.txt existed before 1 → earliest surviving pre-image wins (V1 era).
    expect(plan.restore).toEqual([{ path: 'a.txt', blob: 'b1-0.txt' }])
    expect(plan.remove).toEqual(['yeni.txt'])
  })

  it('an unknown seq names the valid range instead of guessing', () => {
    const { journal } = fixture()
    expect(() => journal.rewindPlan(9)).toThrow(/1\.\.3/)
    expect(() => journal.rewindPlan(0)).toThrow(/1\.\.3/)
  })

  it('the plan is PURE data — the same journal plans identically twice', () => {
    const { journal } = fixture()
    const first: unknown = journal.rewindPlan(2)
    const second: unknown = journal.rewindPlan(2)
    expect(second).toEqual(first)
    expect(journal.steps()).toHaveLength(3) // planning never consumes the journal
  })
})

describe('fileCheckpointIo: disk round-trip', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('journal and blobs survive a reopen (continuation contract)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-'))
    dirs.push(dir)
    const journal = new CheckpointJournal(fileCheckpointIo(dir))
    journal.record({ kind: 'write', label: 'disk', captured: [{ path: 'x.md', content: 'ESKİ' }], created: ['y.md'] })
    const reopened = new CheckpointJournal(fileCheckpointIo(dir))
    const steps: CheckpointStep[] = reopened.steps()
    expect(steps).toHaveLength(1)
    expect(steps[0]?.label).toBe('disk')
    // Blob content is readable through the seam the plan points at.
    const plan = reopened.rewindPlan(1)
    expect(plan.restore[0]?.blob).toBe('b1-0.txt')
    expect(fileCheckpointIo(dir).readBlob(plan.restore[0]!.blob)).toBe('ESKİ')
  })
})