/**
 * Signed device identity for outbound provider requests.
 *
 * The id identifies one *installation*, and it is derived from the machine it
 * runs on so it survives a wiped Harness home: the Windows MachineGuid, the
 * macOS IOPlatformUUID, or the Linux machine-id, hashed together with the
 * platform and architecture so no raw hardware value leaves the process. When
 * no platform source is readable, a random id minted under the Harness home
 * takes over.
 *
 * The id is signed with a deployment secret so a gateway can refuse a forged
 * value instead of trusting a plain header.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/device
 */

import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** Environment variable naming the shared signing secret. */
export const DEVICE_SECRET_ENV = 'DSH_DEVICE_SECRET'

/** Header carrying the installation id. */
export const DEVICE_ID_HEADER = 'x-dsh-device-id'

/** Header carrying the HMAC of that id. */
export const DEVICE_SIG_HEADER = 'x-dsh-device-sig'

/** Header naming where the id came from (`hardware` or `stored`). */
export const DEVICE_SOURCE_HEADER = 'x-dsh-device-src'

/** File carrying the shared signing secret when the environment does not. */
const SECRET_FILE = '.device-secret'

/**
 * The shared signing secret.
 *
 * `DSH_DEVICE_SECRET` wins; otherwise `$DSH_HOME/.device-secret` is read, so a
 * launcher that cannot export variables (a Windows shortcut, a service, a
 * container) still signs. Both paths are plain environment/`node:fs` access
 * and behave identically on Windows, macOS, and Linux.
 * @returns the secret, or undefined when the deployment configured none.
 */
export function deviceSecret(): string | undefined {
  const fromEnv = process.env[DEVICE_SECRET_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const fromFile = readFileSync(join(harnessHome(), SECRET_FILE), 'utf8').trim()
    if (fromFile.length > 0) return fromFile
  } catch {
    // No configured secret: the id still travels, it just cannot be verified.
  }
  return undefined
}

/** Memoized identity: resolving it spawns a process on Windows and macOS. */
let cached: { id: string, source: 'hardware' | 'stored' } | undefined

/** The Harness home this process belongs to. */
function harnessHome(): string {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.dsh')
}

/**
 * Run one platform utility without a shell, so a path with spaces or shell
 * metacharacters can never turn into a different command.
 * @param file - executable name resolved on PATH.
 * @param args - argument vector.
 * @returns the captured stdout, or undefined when the tool is absent or fails.
 */
function run(file: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(file, [...args], { encoding: 'utf8', timeout: 3000, windowsHide: true })
  } catch {
    return undefined
  }
}

/**
 * Read the platform's machine identity.
 *
 * Windows: `MachineGuid` from the registry. macOS: `IOPlatformUUID` from ioreg.
 * Linux: `/etc/machine-id`, then the older dbus file. Every path is a plain
 * executable or file read, so the same code runs on all three platforms.
 * @returns the raw platform identifier, or undefined when none is readable.
 */
function hardwareFingerprint(): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      const match = out === undefined ? null : /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out)
      return match?.[1]
    }
    if (process.platform === 'darwin') {
      const out = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      const match = out === undefined ? null : /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
      return match?.[1]
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = readFileSync(file, 'utf8').trim()
        if (value.length > 0) return value
      } catch {
        // Try the next well-known location.
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The installation identity: a hardware-derived hash when the platform exposes
 * one, otherwise a random id persisted in the Harness home.
 * @returns the id and where it came from.
 */
export function deviceIdentity(): { id: string, source: 'hardware' | 'stored' } | undefined {
  if (cached !== undefined) return cached
  const fingerprint = hardwareFingerprint()
  if (fingerprint !== undefined) {
    // Hashing keeps the raw machine identifier inside the process: the wire
    // only ever carries an opaque digest that is stable for this machine.
    const digest = createHash('sha256')
      .update(`${process.platform}:${process.arch}:${fingerprint}`)
      .digest('hex')
      .slice(0, 20)
    cached = { id: `dsh-${digest}`, source: 'hardware' }
    return cached
  }
  const file = join(harnessHome(), '.device-id')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) {
      cached = { id: existing, source: 'stored' }
      return cached
    }
  } catch {
    // No stored identity yet (or an unreadable home): mint below, then persist.
  }
  const slug = hostname().replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 32)
  const minted = `dsh-${slug}-${randomBytes(8).toString('hex')}`
  try {
    mkdirSync(harnessHome(), { recursive: true })
    writeFileSync(file, `${minted}\n`, 'utf8')
  } catch {
    // A read-only home still yields a usable in-process identity for this run.
  }
  cached = { id: minted, source: 'stored' }
  return cached
}

/**
 * The installation id alone.
 * @returns the id, or `undefined` when none could be established.
 */
export function deviceId(): string | undefined {
  return deviceIdentity()?.id
}

/**
 * Headers identifying this installation on one provider request.
 * @returns the device headers, empty when no id could be established.
 */
export function deviceHeaders(): Record<string, string> {
  const identity = deviceIdentity()
  if (identity === undefined) return {}
  const headers: Record<string, string> = {
    [DEVICE_ID_HEADER]: identity.id,
    [DEVICE_SOURCE_HEADER]: identity.source,
  }
  const secret = deviceSecret()
  if (secret !== undefined) {
    headers[DEVICE_SIG_HEADER] = createHmac('sha256', secret).update(identity.id).digest('hex')
  }
  return headers
}
