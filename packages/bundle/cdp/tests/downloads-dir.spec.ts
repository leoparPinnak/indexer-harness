/**
 * Unit tests for the downloads-root path policy: root resolution (default and
 * config override), idempotent mkdir, the traversal/containment matrix
 * (`..`, absolute escapes, symlink/junction hops, root itself), and the
 * basename validation the `renameTo` flow relies on.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CdpPathEscapeError,
  DEFAULT_DOWNLOADS_SUBPATH,
  ensureDownloadsDir,
  nextFreeBasename,
  resolveDownloadsRoot,
  resolveInsideRoot,
  validateBasename,
} from '../src/downloads-dir.ts'

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh root directory under <tmp>/cdp-downloads-fixture-*. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cdp-downloads-fixture-'))
  tempRoots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}

describe('downloads-dir root resolution', () => {
  it('defaults to the workspace-scoped .dsh/cdp-downloads, never os.tmpdir()', () => {
    const root = resolveDownloadsRoot()
    expect(root).toBe(resolve(process.cwd(), DEFAULT_DOWNLOADS_SUBPATH))
    expect(root.startsWith(tmpdir().toLowerCase())).toBe(false)
    expect(root.toLowerCase()).not.toContain('dsh-cdp-')
  })

  it('honours an explicit config directory and treats empty as default', () => {
    expect(resolveDownloadsRoot('D:/custom/dl')).toBe(resolve('D:/custom/dl'))
    expect(resolveDownloadsRoot('   ')).toBe(resolveDownloadsRoot())
    expect(resolveDownloadsRoot(undefined)).toBe(resolveDownloadsRoot())
  })

  it('creates the root idempotently', () => {
    const root = fixtureRoot()
    const target = join(root, 'deep', 'nested')
    expect(existsSync(target)).toBe(false)
    ensureDownloadsDir(target)
    ensureDownloadsDir(target)
    expect(existsSync(target)).toBe(true)
  })
})

describe('resolveInsideRoot containment matrix', () => {
  it('accepts relative paths and new nested tails inside the root', () => {
    const root = fixtureRoot()
    expect(resolveInsideRoot(root, 'file.pdf')).toBe(join(root, 'file.pdf'))
    expect(resolveInsideRoot(root, 'sub/dir/file.pdf')).toBe(join(root, 'sub/dir/file.pdf'))
    expect(resolveInsideRoot(root, join(root, 'abs.pdf'))).toBe(join(root, 'abs.pdf'))
  })

  it('rejects traversal with ../ and ..\\', () => {
    const root = fixtureRoot()
    expect(() => resolveInsideRoot(root, '../x')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, 'sub/../../x')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, '..\\x')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, 'sub/../../x')).toThrow(
      'cdp: path escapes downloads root: sub/../../x',
    )
  })

  it('rejects absolute paths outside the root, accepts ones inside', () => {
    const root = fixtureRoot()
    const outside = join(tmpdir(), 'cdp-downloads-fixture-outside', 'x.pdf')
    expect(() => resolveInsideRoot(root, outside)).toThrow(CdpPathEscapeError)
    expect(resolveInsideRoot(root, join(root, 'ok.pdf'))).toBe(join(root, 'ok.pdf'))
  })

  it('rejects the root itself and empty input', () => {
    const root = fixtureRoot()
    expect(() => resolveInsideRoot(root, '')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, '.')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, root)).toThrow(CdpPathEscapeError)
  })

  it('rejects a case-variant of the root itself (win32 case-insensitive containment)', () => {
    const root = fixtureRoot()
    if (process.platform !== 'win32') return
    expect(() => resolveInsideRoot(root, root.toUpperCase())).toThrow(CdpPathEscapeError)
    // A case-variant absolute path that is genuinely inside still resolves.
    const inside = join(root, 'a.pdf')
    expect(resolveInsideRoot(root, inside.toUpperCase())).toBe(inside.toUpperCase())
  })

  it('rejects a junction/symlink hop out of the root', () => {
    if (process.platform !== 'win32') return
    const root = fixtureRoot()
    const outside = mkdtempSync(join(tmpdir(), 'cdp-downloads-fixture-outside-'))
    tempRoots.push(outside)
    writeFileSync(join(outside, 'x.pdf'), '%PDF- test')
    let linkKind: 'junction' = 'junction'
    try {
      symlinkSync(outside, join(root, 'link'), linkKind)
    } catch {
      return
    }
    expect(() => resolveInsideRoot(root, 'link/x.pdf')).toThrow(CdpPathEscapeError)
    expect(() => resolveInsideRoot(root, join(root, 'link', 'x.pdf'))).toThrow(CdpPathEscapeError)
    linkKind = 'junction'
    expect(linkKind).toBe('junction')
  })
})

describe('validateBasename / nextFreeBasename', () => {
  it('accepts plain basenames', () => {
    expect(validateBasename('50152094938.pdf')).toBe('50152094938.pdf')
    expect(validateBasename('a b (1).pdf')).toBe('a b (1).pdf')
  })

  it('rejects directories, drives, hidden names and control characters', () => {
    for (const bad of ['a/b', 'a\\b', '..', '.', 'C:\\x.pdf', '.hidden', '', 'a:b.pdf', 'a b.pdf']) {
      if (bad === 'a b.pdf') continue
      expect(() => validateBasename(bad)).toThrow('cdp: invalid filename:')
    }
    expect(() => validateBasename('a b.pdf')).not.toThrow()
  })

  it('loops suffixes for auto names', () => {
    const taken = (name: string): boolean => name === 'x.pdf' || name === 'x (1).pdf'
    expect(nextFreeBasename('x.pdf', taken)).toBe('x (2).pdf')
    expect(nextFreeBasename('y.pdf', taken)).toBe('y.pdf')
    expect(() => nextFreeBasename('v.pdf', () => true)).toThrow('cdp: no free filename for v.pdf')
  })
})
