import { describe, expect, it } from 'vitest'
import { CheckpointJournal, type CheckpointIo } from '../src/checkpoint.ts'
import { applyRewindPlan, type RewindWorkspaceIo } from '../src/checkpoint-restore.ts'

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

/** In-memory workspace with call recording and poison hooks. */
function fakeWorkspace(initial: Record<string, string> = {}): RewindWorkspaceIo & {
  files: Map<string, string>
  calls: string[]
  poisonWrite: Set<string>
  poisonRead: Set<string>
} {
  const files = new Map(Object.entries(initial))
  const calls: string[] = []
  const poisonWrite = new Set<string>()
  const poisonRead = new Set<string>()
  return {
    files,
    calls,
    poisonWrite,
    poisonRead,
    write: (path, content) => {
      calls.push(`write:${path}`)
      if (poisonWrite.has(path)) throw new Error('disk dolu')
      files.set(path, content)
    },
    read: path => {
      calls.push(`read:${path}`)
      // A lying disk: the write lands, the read-back disagrees.
      return poisonRead.has(path) ? 'YANLIŞ' : files.get(path)
    },
    remove: path => {
      calls.push(`remove:${path}`)
      files.delete(path) // absent = success (idempotent)
    },
  }
}

describe('applyRewindPlan: the honest applier', () => {
  it('restores blobs VERIFIED and removes births (nothing else touched)', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({ kind: 'write', label: 'olustur', captured: [], created: ['yeni.txt'] })
    journal.record({ kind: 'edit', label: 'degistir', captured: [{ path: 'eski.txt', content: 'ÖNCEKİ' }], created: [] })
    const workspace = fakeWorkspace({ 'eski.txt': 'SONRAKİ', 'yeni.txt': 'DOGDU', 'dokunulmaz.txt': 'A' })
    // Rewind BEFORE step 1: everything 1..2 is dropped — step 1's birth dies and
    // step 2's pre-image (the earliest surviving capture of eski.txt) wins.
    const result = applyRewindPlan(journal.rewindPlan(1), io, workspace)
    expect(result.restored).toEqual(['eski.txt'])
    expect(workspace.files.get('eski.txt')).toBe('ÖNCEKİ')
    expect(result.removed).toEqual(['yeni.txt'])
    expect(workspace.files.has('yeni.txt')).toBe(false)
    // Only the planned paths were touched — the bystander is untouched and unread.
    expect(workspace.calls).toEqual(['write:eski.txt', 'read:eski.txt', 'remove:yeni.txt'])
    expect(result.dropSteps).toEqual([1, 2])
  })

  it('a missing blob is an HONEST failure — no write, not claimed restored', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({ kind: 'edit', label: 'kayip', captured: [{ path: 'a.ts', content: 'X' }], created: [] })
    io.writeBlob('b1-0.txt', '') // blob exists…
    const workspace = fakeWorkspace()
    // …then the store lies and loses it.
    const result = applyRewindPlan(journal.rewindPlan(1), { readBlob: () => undefined }, workspace)
    expect(result.restored).toEqual([])
    expect(result.failed[0]?.path).toBe('a.ts')
    expect(result.failed[0]?.reason).toContain('restore source missing')
  })

  it('VERIFY mismatch demotes the path to failed (silent partial is the enemy)', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({ kind: 'edit', label: 'yaz', captured: [{ path: 'a.ts', content: 'DOĞRU' }], created: [] })
    const workspace = fakeWorkspace()
    workspace.poisonRead.add('a.ts') // the write lands; the read-back disagrees
    const result = applyRewindPlan(journal.rewindPlan(1), io, workspace)
    expect(result.restored).toEqual([])
    expect(result.failed[0]?.reason).toBe('verify mismatch after restore')
  })

  it('one poisoned path never blocks the rest of the plan', () => {
    const io = memoryIo()
    const journal = new CheckpointJournal(io)
    journal.record({
      kind: 'edit', label: 'ikili',
      captured: [{ path: 'kirik.ts', content: '1' }, { path: 'saglam.ts', content: '2' }],
      created: ['silinir.ts'],
    })
    const workspace = fakeWorkspace()
    workspace.poisonWrite.add('kirik.ts') // write THROWS
    const result = applyRewindPlan(journal.rewindPlan(1), io, workspace)
    expect(result.restored).toEqual(['saglam.ts'])
    expect(result.failed.map(f => f.path)).toContain('kirik.ts')
    expect(result.removed).toEqual(['silinir.ts']) // removals still proceed
  })
})