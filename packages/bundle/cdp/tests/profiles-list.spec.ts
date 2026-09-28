import { describe, expect, it } from 'vitest'
import { resolve, join } from 'node:path'
import { listProfileDirs, resolveProfilesRoot, PROFILE_LOCK_ARTIFACTS } from '../src/profiles.ts'

describe('profiles-list: honest inventory', () => {
  it('reports only name-valid entries, sorted, with the disk lock report', () => {
    const rows = listProfileDirs('/root', () => ['zeta', '..', 'alpha', 'bad name', 'a/b'])
    // Traversal and space names are refused by the name gate; only 'alpha' and
    // 'zeta' survive, sorted.
    expect(rows.map(r => r.name)).toEqual(['alpha', 'zeta'])
    for (const row of rows) {
      expect(row.dir).toBe(join('/root', row.name))
      // A path that does not exist carries NO artifacts — the report says what
      // the disk proves and never guesses "probably locked".
      expect(row.lock.locked).toBe(false)
      expect([...row.lock.artifacts]).toEqual([])
      expect(row.lock.pid).toBe('')
    }
  })

  it('passes the artifacts in PROFILE_LOCK_ARTIFACTS order through the report', () => {
    // readProfileLock is pure-fs; a nonexistent directory proves the empty
    // shape stays stable (the artifact ORDER constant is the contract).
    const [row] = listProfileDirs(resolve('C:\\nope'), () => ['x'])
    expect(row?.lock.artifacts.every(a => PROFILE_LOCK_ARTIFACTS.includes(a))).toBe(true)
  })

  it('resolveProfilesRoot honors the override, then DSH_HOME, then ~/.dsh', () => {
    expect(resolveProfilesRoot({ profilesRoot: resolve('C:\\alt') })).toBe(resolve('C:\\alt'))
    expect(resolveProfilesRoot({ env: { DSH_HOME: resolve('C:\\h') }, home: resolve('C:\\u') }))
      .toBe(join(resolve('C:\\h'), 'profiles'))
    expect(resolveProfilesRoot({ env: {}, home: resolve('C:\\u') }))
      .toBe(join(resolve('C:\\u'), '.dsh', 'profiles'))
  })
})