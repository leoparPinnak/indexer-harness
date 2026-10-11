/**
 * The CodexNative adapter: the harness seam over the REAL backend from
 * `@deepseek-ai/dsh-experimental-cua-native` (native SendInput + raw COM UIA +
 * WGC through a spawned NDJSON helper). Construction spawns the helper; the
 * caller owns `backend.client.close()` when the run ends — steady-state
 * per-op latency is what the runner samples (spawn + pipe setup excluded).
 *
 * Capability expectation measured from the mechanism: `nativeInjection=true`
 * (SendInput), `comUia=true` (native COM UIA vtable), `capturesWinRt=true`
 * (WGC Direct3D11CaptureFramePool).
 *
 * See `protop/shellbox/gui-motor/README.md`, "Plugging in the real backends".
 */

import { createCodexNativeBackend as createCuaBackend } from '@deepseek-ai/dsh-experimental-cua-native'
import type { CodexNativeBackend, CreateCodexNativeBackendOptions } from '@deepseek-ai/dsh-experimental-cua-native'
import type { GuiBackend } from '../backend.ts'

/** The real CodexNative backend as the harness consumes it: the contract plus the client teardown. */
export type CodexNativeBackendHandle = GuiBackend & Pick<CodexNativeBackend, 'client'>

/**
 * Create the real CodexNative backend.
 * @param options - helper path, timeouts, capture regions/mode; defaults spawn the prebuilt helper.
 * @returns the backend implementing `GuiBackend` (plus `client` for teardown).
 */
export function createCodexNativeBackend(options?: CreateCodexNativeBackendOptions): CodexNativeBackendHandle {
  return createCuaBackend(options)
}
