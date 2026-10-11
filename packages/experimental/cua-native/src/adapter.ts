/**
 * The CodexNative `GuiBackend`: one spawned helper, three round-trip operations.
 *
 * - `sendInput`  -> SendInput synthesis (`move`/`click`/`press_key`), receipts
 *                   carry the real landing plus the focus fact.
 * - `readUia`    -> `get_window_state` with `disableDiff` (never-diffed full
 *                   subtree), elements mapped to fixture-style paths.
 * - `capture`    -> `capture` region sampling over WGC frames (GDI fallback
 *                   reports the black miss sentinel for desktop regions).
 *
 * The helper spawns once at construction so the benchmark samples steady-state
 * round trips, never spawn cost (see protop/shellbox/gui-motor/README.md).
 */

import { CuaHelperClient, type CuaInputOutcome, type CuaWindowInfo, type CuaWindowRef } from './client.ts'
import type {
  CuaCaptureFrame,
  CuaCapabilities,
  CuaGuiBackend,
  CuaInputOp,
  CuaInputReceipt,
  CuaUiaElement,
  CuaUiaSelector,
  CuaUiaTreeSnapshot,
  CuaCaptureTarget,
} from './backend-contract.ts'

/** Truthful mechanism claims: SendInput, native COM UIA, Windows.Graphics.Capture. */
export const codexNativeCapabilities: CuaCapabilities = {
  nativeInjection: true,
  comUia: true,
  capturesWinRt: true,
}

/** Result-table identity used by the A/B harness. */
export const codexNativeBackendIdentity = {
  id: 'codex-native',
  label: 'CodexNative (COM UIA + SendInput + WGC)',
  mock: false,
} as const

/** One screen point to sample from a capture frame. */
export interface CuaRegionSample {
  readonly name: string
  /** `window` coords sit relative to the window's outer rect; `desktop` coords are absolute screen pixels. */
  readonly scope: 'window' | 'desktop'
  readonly x: number
  readonly y: number
}

/**
 * Spawn and capture options for {@link createCodexNativeBackend}: helper
 * binary and arguments, request budget, region samples, capture mode, and environment.
 */
export interface CreateCodexNativeBackendOptions {
  readonly helperPath?: string
  readonly helperArgs?: readonly string[]
  readonly timeoutMs?: number
  /** Region names + sample points for `capture`; omitted, frames report no regions. */
  readonly regions?: readonly CuaRegionSample[]
  /** Force the capture mechanism (default: WGC with automatic GDI fallback). */
  readonly captureMode?: 'wgc' | 'gdi'
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * The {@link CuaGuiBackend} the harness drives plus the live helper client;
 * the caller owns closing that client when the run ends.
 */
export interface CodexNativeBackend extends CuaGuiBackend {
  readonly client: CuaHelperClient
}

interface WindowIndex {
  list: readonly CuaWindowInfo[] | null
}

function matchWindow(list: readonly CuaWindowInfo[], windowId: string): CuaWindowInfo | undefined {
  return (
    list.find(candidate => candidate.title === windowId) ??
    list.find(candidate => candidate.app === windowId) ??
    list.find(candidate => candidate.title !== undefined && candidate.title.toLowerCase() === windowId.toLowerCase())
  )
}

async function resolveWindow(client: CuaHelperClient, index: WindowIndex, windowId: string): Promise<CuaWindowRef> {
  if (/^\d+$/.test(windowId)) return { id: Number(windowId) }
  if (index.list === null) index.list = await client.listWindows()
  let found = matchWindow(index.list, windowId)
  if (found === undefined) {
    index.list = await client.listWindows()  // one refresh: the window may have appeared after construction
    found = matchWindow(index.list, windowId)
  }
  if (found === undefined) throw new Error(`CodexNative backend has no window "${windowId}"`)
  return found.title === undefined ? { app: found.app, id: found.id } : { app: found.app, id: found.id, title: found.title }
}

function inputReceipt(outcome: CuaInputOutcome, withFocusFact: boolean): CuaInputReceipt {
  const detail = withFocusFact
    ? `${outcome.detail}; focus ${outcome.focusTransferred ? 'transferred to the target' : 'not transferred'}`
    : outcome.detail
  return { delivered: outcome.delivered, detail }
}

/**
 * Build the backend against a freshly spawned helper.
 * The caller owns `backend.client.close()` when the benchmark run ends.
 * @param options - helper binary, request budget, region samples, capture mode, and environment.
 * @returns a backend bound to one freshly spawned helper process.
 */
export function createCodexNativeBackend(options: CreateCodexNativeBackendOptions = {}): CodexNativeBackend {
  const clientOptions: ConstructorParameters<typeof CuaHelperClient>[0] = {
    ...(options.helperPath !== undefined ? { helperPath: options.helperPath } : {}),
    ...(options.helperArgs !== undefined ? { helperArgs: options.helperArgs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  }
  const client = new CuaHelperClient(clientOptions)
  const index: WindowIndex = { list: null }
  const regions = options.regions ?? []

  return {
    id: codexNativeBackendIdentity.id,
    label: codexNativeBackendIdentity.label,
    mock: codexNativeBackendIdentity.mock,
    capabilities: codexNativeCapabilities,
    client,

    async sendInput(op: CuaInputOp): Promise<CuaInputReceipt> {
      const window = await resolveWindow(client, index, op.windowId)
      switch (op.kind) {
        case 'mouseMove': {
          const outcome = await client.move(window, op.x, op.y)
          return inputReceipt(outcome, false)
        }
        case 'mouseClick': {
          const outcome = await client.click(window, { x: op.x, y: op.y, button: op.button })
          return inputReceipt(outcome, true)
        }
        case 'key': {
          const outcome = await client.pressKey(window, op.key)
          return inputReceipt(outcome, true)
        }
      }
    },

    async readUia(selector: CuaUiaSelector): Promise<CuaUiaTreeSnapshot> {
      const window = await resolveWindow(client, index, selector.windowId)
      const state = await client.getWindowState(window, { includeScreenshot: false, includeText: true, disableDiff: true })
      const accessibility = state.accessibility
      if (accessibility === undefined) throw new Error(`CodexNative: helper returned no accessibility tree for "${selector.windowId}"`)
      const elements: CuaUiaElement[] = accessibility.elements.map(element => ({
        path: `/${selector.windowId}${element.path}`,
        name: element.name,
        bounds: element.bounds,
        ...(typeof element.value === 'string' ? { value: element.value } : {}),
      }))
      return { elements }
    },

    async capture(target: CuaCaptureTarget): Promise<CuaCaptureFrame> {
      const window = await resolveWindow(client, index, target.windowId)
      const samples = regions.map(region => ({
        name: region.name,
        space: region.scope,
        x: region.x,
        y: region.y,
      }))
      const result = await client.capture(window, samples, options.captureMode)
      return { width: result.width, height: result.height, regions: result.regions }
    },
  }
}
