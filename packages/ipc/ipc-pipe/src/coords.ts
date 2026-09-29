/**
 * Gateway coordinates — the OS endpoint a DSH gateway listens on, the
 * single-instance lock beside it, and the handshake key both peers derive.
 *
 * The endpoint is a Windows named pipe (`\\.\pipe\dsh-gateway-<homehash16>`)
 * with a unix domain socket fallback of the same name under `$DSH_HOME/ipc`.
 * The 16-hex window in the name is a sha256 digest of the owning home, so two
 * homes on one machine never share an endpoint, and a spec that seeds its own
 * coordinate (see {@link GatewayCoordinateOptions.seed}) never collides with
 * the live machine's gateway.
 *
 * @module @deepseek-ai/dsh-ipc-pipe/coords
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Fixed prefix of every gateway path: `dsh-gateway-<hash>`. */
export const GATEWAY_PREFIX = 'dsh-gateway'

/** Length of the hex digest window a gateway name carries (`<homehash16>`). */
export const GATEWAY_HASH_LENGTH = 16

/** Environment override for the endpoint path itself (a spec or a deploy pinning coordinates). */
export const GATEWAY_PATH_ENV = 'DSH_GATEWAY_PATH'

/** Environment override for the handshake key (a spec supplying its own secret). */
export const GATEWAY_KEY_ENV = 'DSH_GATEWAY_KEY'

/** Resolved endpoint, lock, and key coordinates of one gateway. */
export interface GatewayCoordinates {
  /** OS endpoint: `\\.\pipe\dsh-gateway-<hash>` on Windows, `<home>/ipc/dsh-gateway-<hash>.sock` elsewhere. */
  readonly path: string
  /** Single-instance lock file beside the endpoint; the second mount refuses on it. */
  readonly lockPath: string
  /** Shared handshake key; both peers derive it from the same coordinates. */
  readonly key: string
  /** `sha256(key)` in hex — the digest carried in the first handshake message. */
  readonly digest: string
  /** The 16-hex window that names this gateway. */
  readonly hash: string
}

/** Options narrowing the coordinates; every field is an explicit override. */
export interface GatewayCoordinateOptions {
  /**
   * Digest seed. Defaults to the DSH home, so the endpoint is
   * `dsh-gateway-<homehash16>`; a spec passes its discovery coordinate (or any
   * private seed) to own a gateway the live machine never touches.
   */
  seed?: string | undefined
  /** Endpoint path override, mirroring the `DSH_GATEWAY_PATH` environment variable. */
  path?: string | undefined
  /** Handshake key override, mirroring the `DSH_GATEWAY_KEY` environment variable. */
  key?: string | undefined
  /** Home directory override; defaults to `$DSH_HOME` or `~/.dsh`. */
  home?: string | undefined
}

/**
 * Resolve the DSH home directory the gateway files live under.
 * @param override - explicit home, else `$DSH_HOME`, else `~/.dsh`.
 * @returns the absolute home path.
 */
function resolveHome(override?: string | undefined): string {
  if (override !== undefined && override !== '') return override
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Read the gateway key, creating it on first use so both peers agree without
 * plumbing a secret through the environment. The file is random bytes written
 * under `wx`; a losing writer re-reads the winner's key instead of replacing it.
 * @param dir - directory holding the key file.
 * @param hash - gateway hash naming the key file.
 * @param explicit - explicit key override (option or `DSH_GATEWAY_KEY`).
 * @returns the key material.
 */
function loadKey(dir: string, hash: string, explicit?: string | undefined): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const fromEnv = process.env[GATEWAY_KEY_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const file = join(dir, `${GATEWAY_PREFIX}-${hash}.key`)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return existing
  } catch {
    // Missing or unreadable: create it below.
  }
  const fresh = randomBytes(32).toString('hex')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${fresh}\n`, { flag: 'wx', mode: 0o600 })
  } catch {
    // Another process won the create; read its key rather than racing it.
  }
  try {
    const winner = readFileSync(file, 'utf8').trim()
    if (winner !== '') return winner
  } catch {
    // The winner vanished between create and read: fall back to our own bytes.
  }
  return fresh
}

/**
 * Resolve the endpoint, lock, and key coordinates of one gateway.
 * @param options - explicit overrides; omitted fields fall back to the home.
 * @returns the coordinates both peers derive identically.
 */
export function gatewayCoordinates(options: GatewayCoordinateOptions = {}): GatewayCoordinates {
  const home = resolveHome(options.home)
  const seed = options.seed !== undefined && options.seed !== '' ? options.seed : home
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, GATEWAY_HASH_LENGTH)
  const dir = join(home, 'ipc')
  const key = loadKey(dir, hash, options.key)
  const pathOverride = options.path !== undefined && options.path !== '' ? options.path : process.env[GATEWAY_PATH_ENV]
  const path = pathOverride !== undefined && pathOverride !== ''
    ? pathOverride
    : process.platform === 'win32'
      ? `\\\\.\\pipe\\${GATEWAY_PREFIX}-${hash}`
      : join(dir, `${GATEWAY_PREFIX}-${hash}.sock`)
  return {
    path,
    lockPath: join(dir, `${GATEWAY_PREFIX}-${hash}.lock`),
    key,
    digest: createHash('sha256').update(key).digest('hex'),
    hash,
  }
}

/**
 * Compare two handshake digests without leaking their bytes through `===` timing.
 * @param expected - the digest the local side derived from the key.
 * @param actual - the digest the remote side sent.
 * @returns true when both are the same lowercase hex string of equal length.
 */
export function digestMatches(expected: string, actual: string): boolean {
  if (expected.length !== actual.length || expected.length === 0) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'))
}
