/**
 * Locate the prebuilt `cua-helper.exe` the client spawns.
 *
 * Resolution order:
 *   1. an explicit `helperPath` from the caller (must exist - fail loud),
 *   2. the `CUA_HELPER_PATH` environment override (must exist - fail loud),
 *   3. the package-local prebuilt copy (`bin/cua-helper.exe`),
 *   4. the repo build output (`native/cua/bin/cua-helper.exe`).
 */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The four locations {@link resolveHelperPathFrom} tests, in resolution order:
 * caller override, environment override, package bin, repo bin.
 */
export interface HelperPathCandidates {
  readonly helperPath?: string
  readonly envHelperPath?: string
  readonly packageBin?: string
  readonly repoBin?: string
}

const BUILD_HINT = 'build it offline with native/cua/build.cmd or set CUA_HELPER_PATH'

const existsAsFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Pure candidate resolver; `exists` is injected so the order stays unit-testable.
 * @param candidates - candidate paths tested in the documented order.
 * @param exists - file-existence probe injected so the order stays unit-testable.
 * @returns the first candidate that exists; a named override that is missing fails loud.
 */
export function resolveHelperPathFrom(candidates: HelperPathCandidates, exists: (path: string) => boolean): string {
  if (candidates.helperPath !== undefined) {
    if (!exists(candidates.helperPath)) throw new Error(`cua-native: helperPath does not exist: ${candidates.helperPath}`)
    return candidates.helperPath
  }
  if (candidates.envHelperPath !== undefined && candidates.envHelperPath !== '') {
    if (!exists(candidates.envHelperPath)) {
      throw new Error(`cua-native: CUA_HELPER_PATH does not exist: ${candidates.envHelperPath}`)
    }
    return candidates.envHelperPath
  }
  for (const candidate of [candidates.packageBin, candidates.repoBin]) {
    if (candidate !== undefined && exists(candidate)) return candidate
  }
  throw new Error(`cua-native: no cua-helper.exe found; ${BUILD_HINT}`)
}

/**
 * Real resolution against this package's layout and the process environment.
 * @param explicitPath - caller override; otherwise `CUA_HELPER_PATH`, the package bin, then the repo bin.
 * @returns the resolved path to `cua-helper.exe`.
 */
export function resolveHelperPath(explicitPath?: string): string {
  const envHelperPath = process.env['CUA_HELPER_PATH']
  return resolveHelperPathFrom(
    {
      ...(explicitPath !== undefined ? { helperPath: explicitPath } : {}),
      ...(envHelperPath !== undefined ? { envHelperPath } : {}),
      packageBin: fileURLToPath(new URL('../bin/cua-helper.exe', import.meta.url)),
      repoBin: fileURLToPath(new URL('../../../native/cua/bin/cua-helper.exe', import.meta.url)),
    },
    existsAsFile,
  )
}
