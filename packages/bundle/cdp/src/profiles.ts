/**
 * @deepseek-ai/dsh-cdp — plan13-profile: persistent browser PROFILES.
 *
 * Before plan13 every `cdp_open` launch minted a throwaway
 * `mkdtempSync(tmpdir(), 'dsh-cdp-')` user-data directory, so cookies, logins,
 * and site permissions died with the process. This module owns the named,
 * durable alternative: `cdp_open({ profile: 'assistant' })` resolves to
 * `$DSH_HOME/profiles/assistant/` and hands the SAME directory to the launcher
 * on every call, so a signed-in session the user established by hand in their
 * own browser window survives every restart.
 *
 * Three rules this module enforces, and nothing else may:
 *
 *  1. **Name validation.** A profile name becomes a path segment. Only
 *     `[A-Za-z0-9_-]{1,64}` is accepted; `..`, `/`, `\`, and every other
 *     traversal shape are refused BEFORE any filesystem call, so a caller
 *     can never steer the directory out of the profiles root.
 *  2. **No deletion.** Nothing here ever removes a profile directory. The
 *     session is the whole point; garbage collection would silently sign the
 *     user out. Cleanup is the user's decision, made with their own tools.
 *  3. **Honest locking.** Chromium takes an exclusive lock on a user-data
 *     directory. Two browsers cannot share one profile, and a silent fallback
 *     to a temporary profile is the single worst answer available (the user
 *     would ask "where did my login go?"). The lock is therefore REPORTED,
 *     with the artifacts that prove it, never worked around.
 *
 * This module stores nothing but Chromium's own on-disk profile; the user
 * signs in from their own browser window.
 *
 * @module @deepseek-ai/dsh-cdp/profiles
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** plan13-profile: the directory name, under `$DSH_HOME`, holding every profile. */
export const PROFILES_DIR_NAME = 'profiles'

/** The only profile-name shape accepted; anything else is refused. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The human-readable rule, quoted verbatim in every refusal. */
export const PROFILE_NAME_RULE = 'letters, digits, "_" and "-" only, 1-64 characters'

/** Prefix of a throwaway `cdp_open` profile directory. */
export const EPHEMERAL_PROFILE_PREFIX = 'dsh-cdp-'

/** Directory name a DSH-launched throwaway profile reports as. */
export const EPHEMERAL_PROFILE_NAME = 'ephemeral'

/** Profile name reported for a browser DSH attached to but did not launch. */
export const EXTERNAL_PROFILE_NAME = 'external'

/**
 * Filesystem artifacts Chromium leaves inside a user-data directory while a
 * browser holds it. `SingletonLock` is the POSIX symlink (its target carries
 * `host-pid`); `lockfile` is the Windows equivalent. Their mere presence is the
 * lock signal — reading the pid is a bonus for the message, never a decision.
 */
export const PROFILE_LOCK_ARTIFACTS: readonly string[] = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
]

/** plan13-profile: why a profile name or directory was refused. */
export class CdpProfileError extends Error {
  /** The offending name, exactly as the caller passed it. */
  readonly profile: string
  /** Short machine-stable reason code. */
  readonly code: 'INVALID_NAME' | 'LOCKED'

  /**
   * @param message - the honest one-line reason.
   * @param profile - the name the caller asked for.
   * @param code - the reason code.
   */
  constructor(message: string, profile: string, code: 'INVALID_NAME' | 'LOCKED') {
    super(message)
    this.name = 'CdpProfileError'
    this.profile = profile
    this.code = code
  }
}

/**
 * Validate one profile name against {@link PROFILE_NAME_PATTERN}.
 *
 * The pattern alone is the security contract: a name that cannot express a
 * path separator, a drive letter, a `..` segment, or a NUL can only ever name
 * one directory directly under the profiles root.
 *
 * @param name - candidate profile name.
 * @returns the reason it was refused, or `undefined` when the name is usable.
 */
export function profileNameRefusal(name: string): string | undefined {
  if (name.trim() === '') {
    return 'a profile name may not be empty'
  }
  if (name !== name.trim()) {
    return 'a profile name may not carry leading or trailing whitespace'
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    // The two shapes a caller is most likely to send by accident get their own
    // line, because "invalid character" is not a usable answer for either.
    if (name === '.' || name === '..' || name.startsWith('..')) {
      return 'a profile name may not be a path-traversal segment'
    }
    if (name.includes('/') || name.includes('\\')) {
      return 'a profile name may not contain a path separator'
    }
    return `a profile name must use ${PROFILE_NAME_RULE}`
  }
  return undefined
}

/**
 * Resolve the harness home the profiles live under: `$DSH_HOME` when it is
 * set to something non-blank, else `~/.dsh`. Resolved at CALL time (not module
 * load) so a test or a relaunched process that repoints `DSH_HOME` is honored.
 * @param env - environment mapping to read (tests inject).
 * @param home - home directory used when `DSH_HOME` is absent (tests inject).
 * @returns the absolute harness home.
 */
export function resolveDshHomeDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.trim() !== ''
    ? resolve(fromEnv.trim())
    : resolve(join(home, '.dsh'))
}

/**
 * Resolve the absolute directory of one named profile.
 *
 * Throws {@link CdpProfileError} rather than returning a partially-resolved
 * path: a caller that ignores the refusal would otherwise hand Chromium a
 * directory outside the profiles root.
 *
 * @param name - the profile name (validated by {@link profileNameRefusal}).
 * @param options - injection seams for the harness home and profiles root.
 * @returns the absolute `…/profiles/<name>` directory. Not created here.
 * @throws CdpProfileError when the name is refused.
 */
export function resolveProfileDir(
  name: string,
  options: { env?: Record<string, string | undefined> | undefined, home?: string | undefined, profilesRoot?: string | undefined } = {},
): string {
  const refusal = profileNameRefusal(name)
  if (refusal !== undefined) {
    throw new CdpProfileError(`cdp: invalid profile name "${name}" — ${refusal} (${PROFILE_NAME_RULE})`, name, 'INVALID_NAME')
  }
  const root = options.profilesRoot !== undefined && options.profilesRoot !== ''
    ? resolve(options.profilesRoot)
    : resolve(join(resolveDshHomeDir(options.env ?? process.env, options.home ?? homedir()), PROFILES_DIR_NAME))
  return join(root, name)
}

/**
 * Derive a profile's display identity from its user-data directory: the last
 * path segment, which is the profile name for a named profile and the
 * `dsh-cdp-XXXXXX` suffix for a throwaway one.
 * @param userDataDir - absolute or relative user-data directory.
 * @returns the last non-empty path segment, or `''` when there is none.
 */
export function profileNameFromUserDataDir(userDataDir: string): string {
  const parts = userDataDir.split(/[\\/]+/).filter(part => part !== '' && part !== '.' && part !== '..')
  return parts.length > 0 ? parts[parts.length - 1]! : ''
}

/**
 * The display identity a status card and an endpoint row should show for one
 * user-data directory. A named profile answers with its own name; a throwaway
 * `mkdtemp` directory answers the single word {@link EPHEMERAL_PROFILE_NAME}
 * rather than leaking a random suffix into every render.
 * @param userDataDir - the browser's user-data directory.
 * @returns the profile name, or `ephemeral` for a throwaway directory.
 */
export function profileIdentity(userDataDir: string): string {
  const name = profileNameFromUserDataDir(userDataDir)
  return name.startsWith(EPHEMERAL_PROFILE_PREFIX) ? EPHEMERAL_PROFILE_NAME : name
}

/** plan13-profile: what a profile directory's lock artifacts say, read once. */
export interface ProfileLockReport {
  /** True when at least one lock artifact exists in the directory. */
  readonly locked: boolean
  /** The artifact names found, in {@link PROFILE_LOCK_ARTIFACTS} order. */
  readonly artifacts: readonly string[]
  /** Owning process id when the artifact carried one; `''` when unknown. */
  readonly pid: string
}

/** One named profile row of {@link listProfileDirs}. */
export interface ProfileDirRow {
  /** The directory's name — the profile name (already name-validated). */
  readonly name: string
  /** Absolute path of the user-data directory. */
  readonly dir: string
  /** Honest lock report straight from the disk artifacts; never guessed. */
  readonly lock: ProfileLockReport
}

/**
 * The absolute profiles root: an explicit `profilesRoot` override, else
 * `$DSH_HOME/profiles` (falling back to `~/.dsh/profiles`).
 * @param options - injection seams for the harness home and profiles root.
 * @returns the absolute profiles root directory.
 */
export function resolveProfilesRoot(
  options: { env?: Record<string, string | undefined> | undefined, home?: string | undefined, profilesRoot?: string | undefined } = {},
): string {
  return options.profilesRoot !== undefined && options.profilesRoot !== ''
    ? resolve(options.profilesRoot)
    : resolve(join(resolveDshHomeDir(options.env ?? process.env, options.home ?? homedir()), PROFILES_DIR_NAME))
}

/**
 * plan16-profile-list: enumerate the named profiles under `root`, sorted by
 * name. Only subdirectories whose name passes {@link profileNameRefusal} are
 * reported — stray files and traversal-shaped entries are ignored rather than
 * laundered through the inventory. Lock state comes from
 * {@link readProfileLock} and reports ONLY what the disk proves.
 * @param root - the resolved profiles root directory.
 * @param readdir - directory-name source (tests inject); defaults to `readdirSync` over subdirectories.
 * @returns one row per named profile.
 */
export function listProfileDirs(
  root: string,
  readdir: (dir: string) => string[] = defaultDirNames,
): ProfileDirRow[] {
  return readdir(root)
    .filter(name => profileNameRefusal(name) === undefined)
    .sort()
    .map(name => {
      const dir = join(root, name)
      return { name, dir, lock: readProfileLock(dir) }
    })
}

/** Default {@link listProfileDirs} source: the subdirectory names of `dir`. */
function defaultDirNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

/**
 * Read the lock state of a user-data directory.
 *
 * Reports ONLY what the filesystem proves. A stale lock file left by a crashed
 * browser is indistinguishable from a live one without cross-process probing,
 * so the caller is told what was found and left to decide — this never
 * guesses "probably fine" and never silently relocates the session.
 * @param dir - the user-data directory to inspect.
 * @returns the artifacts found and the pid when one is readable.
 */
export function readProfileLock(dir: string): ProfileLockReport {
  const artifacts: string[] = []
  for (const artifact of PROFILE_LOCK_ARTIFACTS) {
    if (existsSync(join(dir, artifact))) artifacts.push(artifact)
  }
  let pid = ''
  // POSIX writes the holder as a symlink target `hostname-PID`; Windows leaves
  // an opaque `lockfile`. Only the POSIX form carries a usable pid.
  const lockPath = join(dir, 'SingletonLock')
  if (artifacts.includes('SingletonLock')) {
    try {
      const target = readFileSync(lockPath, 'utf8')
      const tail = target.slice(target.lastIndexOf('-') + 1).trim()
      if (/^\d+$/.test(tail)) pid = tail
    } catch {
      // An unreadable lock is still a lock; the pid simply stays unknown.
    }
  }
  return { locked: artifacts.length > 0, artifacts, pid }
}

/**
 * Build the one honest refusal for a profile another browser still holds.
 * @param name - the profile the caller asked for.
 * @param dir - its absolute directory.
 * @param report - what the lock scan found.
 * @returns the message, naming the artifacts and the holder when known.
 */
export function profileLockedMessage(name: string, dir: string, report: ProfileLockReport): string {
  const artifacts = report.artifacts.join(', ')
  const holder = report.pid === ''
    ? 'the owning process id is not recorded on this platform'
    : `held by process ${report.pid}`
  return `cdp: profile "${name}" is already open in another browser (${holder}; lock artifacts: ${artifacts}). `
    + `A Chromium user-data directory cannot be shared by two browsers, so nothing was launched. `
    + `Close the window using ${dir} (or point cdp_open at a different profile) and try again — `
    + 'this bundle never falls back to a throwaway profile, because a fresh one would look logged-out.'
}
