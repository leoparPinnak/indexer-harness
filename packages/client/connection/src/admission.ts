/** Deferred-login admission seam for the Host Connection carrier. */

import type { ConnectionTrustRequest } from './rpc.ts'

/**
 * The single admission decision behind Connection's two entry points:
 * `HostConnectionService.requestRejection` consults it after the Host/Origin
 * fence, and `HostConnectionService.authorizeIndex` consults it before the
 * frontend serves `index.html`.
 *
 * No login mechanism is installed today, so every request is admitted. A
 * future login gate mounts here and only here: returning `401` starts denying
 * API and index requests alike, with no carrier code to change.
 *
 * @param _request - request facts available to the gate before dispatch.
 * @returns undefined while the request may proceed, or 401 once the gate denies it.
 */
export function admissionRejection(_request: ConnectionTrustRequest): 401 | undefined {
  // A future gate inspects its request argument; admission is unconditional.
  return undefined
}
