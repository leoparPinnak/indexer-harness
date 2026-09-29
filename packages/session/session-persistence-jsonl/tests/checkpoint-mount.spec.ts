import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointRecorderAt } from '../src/checkpoint-mount.ts'
import type { CheckpointToolCall, CheckpointToolTaps } from '../src/checkpoint-recorder.ts'

function fakeTaps(): CheckpointToolTaps & { firePre(call: CheckpointToolCall): void } {
  const pres = new Set<(c: CheckpointToolCall) => void>()
  const posts = new Set<(c: CheckpointToolCall, ok: boolean) => void>()
  return {
    pre: listener => { pres.add(listener); return () => { pres.delete(listener) } },
    post: listener => { posts.add(listener); return () => { posts.delete(listener) } },
    firePre: call => { for (const each of pres) each(call) },
  }
}

describe('checkpointRecorderAt: the dir-bound factory', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('binds one journal DIRECTORY — closure travels without package imports', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dsh-ck-mount-')), 'checkpoints')
    dirs.push(dir.slice(0, dir.length - 'checkpoints'.length - 1))
    const attach = checkpointRecorderAt(dir, {
      paths: call => (call.name === 'edit' ? ['a.ts'] : null),
      creates: () => [],
      read: () => 'ÖN',
    })
    const taps = fakeTaps()
    const dispose = attach(taps)
    taps.firePre({ callId: '7', name: 'edit' })
    dispose()
    // The journal landed in the BOUND dir (blob + jsonl durable).
    expect(readFileSync(join(dir, 'b1-0.txt'), 'utf8')).toBe('ÖN')
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toContain('"label":"edit#7"')
  })
})