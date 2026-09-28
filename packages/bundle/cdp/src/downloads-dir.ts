/**
 * @deepseek-ai/dsh-cdp — the one place the downloads-root path policy lives.
 * Every user-supplied path the download/print/read/file tools accept is
 * resolved here, so containment (no `..`, no absolute escape, no symlink or
 * junction hop out of the root) is enforced in a single function instead of
 * being re-invented per tool. The root is workspace-scoped
 * (`<cwd>/.dsh/cdp-downloads`) and deliberately never under `os.tmpdir()` or
 * the ephemeral browser profile.
 * @module @deepseek-ai/dsh-cdp/downloads-dir
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Relative downloads-root location used when config gives none. */
export const DEFAULT_DOWNLOADS_SUBPATH = '.dsh/cdp-downloads'

/**
 * Resolve the downloads root from optional config.
 * @param configured - config `downloadsDir`; empty/absent falls back to the
 *   workspace-scoped default `<cwd>/.dsh/cdp-downloads`.
 * @returns the absolute downloads root (not yet created).
 */
export function resolveDownloadsRoot(configured?: string | undefined): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  if (trimmed !== '') return resolve(trimmed)
  return resolve(process.cwd(), DEFAULT_DOWNLOADS_SUBPATH)
}

/**
 * Create the downloads root if it does not exist yet (idempotent).
 * @param root - absolute root to materialize.
 * @returns the same absolute root.
 */
export function ensureDownloadsDir(root: string): string {
  mkdirSync(root, { recursive: true })
  return root
}

/** Thrown when a caller-supplied path would leave the downloads root. */
export class CdpPathEscapeError extends Error {
  /** The offending user-supplied path. */
  readonly input: string

  /**
   * @param input - the path that escaped the root.
   */
  constructor(input: string) {
    super(`cdp: path escapes downloads root: ${input}`)
    this.name = 'CdpPathEscapeError'
    this.input = input
  }
}

/**
 * The deepest existing ancestor of `target`, plus the not-yet-existing suffix
 * segments that follow it.
 * @param target - absolute path that may not exist yet.
 * @returns the existing ancestor path and the remaining segments.
 */
function existingAncestor(target: string): { probe: string; suffix: string[] } {
  const suffix: string[] = []
  let probe = target
  for (;;) {
    if (existsSync(probe)) return { probe, suffix }
    const parent = resolve(probe, '..')
    if (parent === probe) return { probe, suffix }
    suffix.unshift(probe.slice(parent.length + 1))
    probe = parent
  }
}

/**
 * @param root - real path of the downloads root.
 * @param target - candidate contained path.
 * @returns whether `target` is strictly inside `root` (root itself excluded),
 *   compared case-insensitively on win32.
 */
function isInside(root: string, target: string): boolean {
  const fold = process.platform === 'win32'
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value
  const rel = relative(fold(root), fold(target))
  if (rel === '') return false
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false
  if (isAbsolute(rel)) return false
  return true
}

/**
 * Resolve one caller-supplied path inside the downloads root.
 *
 * Both relative paths (joined under the root) and absolute paths (accepted
 * only when they land inside the root) are handled. Containment is checked
 * against the *real* path of the deepest existing ancestor, so `..` segments
 * and symlink/junction hops out of the root are rejected on every platform.
 * The root itself resolves to nothing: a containment path must be non-empty.
 * @param root - absolute downloads root; must exist (see {@link ensureDownloadsDir}).
 * @param userPath - absolute or root-relative path from tool input.
 * @returns the absolute contained path (its non-existing tail is preserved as given).
 * @throws CdpPathEscapeError when the resolved path would leave the root.
 */
export function resolveInsideRoot(root: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    throw new CdpPathEscapeError(String(userPath))
  }
  const realRoot = realpathSync(root)
  const resolved = isAbsolute(userPath) ? resolve(userPath) : resolve(root, userPath)
  const { probe, suffix } = existingAncestor(resolved)
  const combined = suffix.length === 0
    ? realpathSync(probe)
    : resolve(realpathSync(probe), ...suffix)
  if (!isInside(realRoot, combined)) throw new CdpPathEscapeError(userPath)
  return resolved
}

/**
 * Validate a caller-supplied final filename: it must be a bare basename.
 * @param name - candidate filename (e.g. `renameTo`).
 * @returns the validated name.
 * @throws Error with a `cdp:` message when the name is not a safe basename.
 */
export function validateBasename(name: string): string {
  const invalid = typeof name !== 'string'
    || name === ''
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes(':')
    || name.startsWith('.')
    || /[<>:"|?*]/.test(name)
    || hasControlChars(name)
  if (invalid) throw new Error(`cdp: invalid filename: ${String(name)}`)
  return name
}

/**
 * @param value - candidate filename.
 * @returns whether the value contains an ASCII control character.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * A deterministic `name (1).ext`, `name (2).ext`, ... candidate that does not
 * yet exist per `taken`. Auto-generated names use this suffix loop; an
 * explicit `renameTo` deliberately does not (a hard error prevents a silent
 * overwrite).
 * @param base - original basename, already validated.
 * @param taken - predicate reporting whether a candidate name is occupied.
 * @returns the first free candidate.
 */
export function nextFreeBasename(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`cdp: no free filename for ${base}`)
}
