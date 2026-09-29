/**
 * Structural twin of `benchmarks/gui-motor/src/backend.ts`.
 *
 * A package source file cannot import that benchmark module directly: the
 * package project compiles with `rootDir: src` and TS6059 rejects sources
 * outside it (the benchmark program has no such restriction, so the reverse
 * import is fine). `tests/backend-contract.spec.ts` type-checks this twin
 * against the real `GuiBackend` inside the host program, which includes both
 * `benchmarks/` sources and every package test file.
 */

/** Rectangle in virtual-screen coordinates. */
export interface CuaBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Capability descriptor: what the mechanism actually is, read beside measurements. */
export interface CuaCapabilities {
  /** Input reaches the OS input queue (SendInput-class), not posted window messages. */
  readonly nativeInjection: boolean
  /** Tree reads walk COM UIA providers, not window-message probing. */
  readonly comUia: boolean
  /** Frame capture uses a capture-graph session (Windows.Graphics.Capture-class), not a GDI blit. */
  readonly capturesWinRt: boolean
}

/** Mouse button for a click operation. */
export type CuaMouseButton = 'left' | 'right'

/** One synthesized input operation against a target window. */
export type CuaInputOp =
  | { readonly kind: 'mouseMove'; readonly windowId: string; readonly x: number; readonly y: number }
  | { readonly kind: 'mouseClick'; readonly windowId: string; readonly x: number; readonly y: number; readonly button: CuaMouseButton }
  | { readonly kind: 'key'; readonly windowId: string; readonly key: string }

/** Outcome of one synthesized input round trip: the landed flag plus a detail line. */
export interface CuaInputReceipt {
  readonly delivered: boolean
  readonly detail?: string
}

/** Selector for a subtree read: the element tree rooted at one window. */
export interface CuaUiaSelector {
  readonly windowId: string
}

/** One element as reported by a tree read: stable path, name, value, and bounds. */
export interface CuaUiaElement {
  readonly path: string
  readonly name: string
  readonly value?: string
  readonly bounds: CuaBounds
}

/** Result of one subtree read: every element the walk returned. */
export interface CuaUiaTreeSnapshot {
  readonly elements: readonly CuaUiaElement[]
}

/** Target for one frame capture: the window to frame. */
export interface CuaCaptureTarget {
  readonly windowId: string
}

/** Sentinel color for a region the capture missed (a black box in the frame). */
export const CUA_CAPTURE_BLACK = '#000000'

/** Result of one frame capture: pixel size plus the observed color per region. */
export interface CuaCaptureFrame {
  readonly width: number
  readonly height: number
  readonly regions: Readonly<Record<string, string>>
}

/** The contract the A/B harness (and its mocks) implement. */
export interface CuaGuiBackend {
  readonly id: string
  readonly label: string
  readonly mock: boolean
  readonly capabilities: CuaCapabilities
  sendInput(op: CuaInputOp): Promise<CuaInputReceipt>
  readUia(selector: CuaUiaSelector): Promise<CuaUiaTreeSnapshot>
  capture(target: CuaCaptureTarget): Promise<CuaCaptureFrame>
}
