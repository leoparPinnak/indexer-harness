/**
 * The pluggable `GuiBackend` seam: every GUI-automation backend (message-injection
 * or native) implements these three operations plus a capability descriptor so the
 * harness can compare mechanisms on identical inputs.
 */

/** Rectangle in virtual-screen coordinates. */
export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Capability descriptor declared by each backend. The benchmark measures actual
 * behavior; the descriptor documents the mechanism so the verdict can be read
 * against what the backend claims to be.
 */
export interface GuiCapabilities {
  /** Input reaches the OS input queue (SendInput-class), not posted window messages. */
  readonly nativeInjection: boolean
  /** Tree reads walk COM UIA providers, not window-message probing. */
  readonly comUia: boolean
  /** Frame capture uses a capture-graph session (Windows.Graphics.Capture-class), not a GDI blit. */
  readonly capturesWinRt: boolean
}

/** Mouse button for a click operation. */
export type MouseButton = 'left' | 'right'

/** One synthesized input operation against a target window. */
export type InputOp =
  | { readonly kind: 'mouseMove'; readonly windowId: string; readonly x: number; readonly y: number }
  | { readonly kind: 'mouseClick'; readonly windowId: string; readonly x: number; readonly y: number; readonly button: MouseButton }
  | { readonly kind: 'key'; readonly windowId: string; readonly key: string }

/** Outcome of one synthesized input round trip. */
export interface InputReceipt {
  /** True when the input actually landed on the target window. */
  readonly delivered: boolean
  /** Mechanism used, or the reason delivery failed, when the backend reports one. */
  readonly detail?: string
}

/** Selector for a subtree read: the element tree rooted at one window. */
export interface UiaSelector {
  readonly windowId: string
}

/** One element as reported by a tree read. */
export interface UiaElement {
  /** Stable selector path, comparable against fixture ground truth. */
  readonly path: string
  readonly name: string
  readonly value?: string
  readonly bounds: Bounds
}

/** Result of one subtree read. */
export interface UiaTreeSnapshot {
  readonly elements: readonly UiaElement[]
}

/** Target for one frame capture. */
export interface CaptureTarget {
  readonly windowId: string
}

/** Sentinel color for a region the capture missed (a black box in the frame). */
export const CAPTURE_BLACK = '#000000'

/** Result of one frame capture. */
export interface CaptureFrame {
  readonly width: number
  readonly height: number
  /** Observed color per fixture region; missed regions report `CAPTURE_BLACK`. */
  readonly regions: Readonly<Record<string, string>>
}

/**
 * The contract both real backends (NativeWin koffi/PInvoke, CodexNative COM/SendInput)
 * and the harness mocks implement.
 */
export interface GuiBackend {
  /** Stable identifier used in results, tables, and the verdict. */
  readonly id: string
  /** Human-readable table label. */
  readonly label: string
  /** True while the backend is a synthetic stand-in awaiting its real implementation. */
  readonly mock: boolean
  readonly capabilities: GuiCapabilities
  /** Round trip: synthesize one input op and report whether it landed. */
  sendInput(op: InputOp): Promise<InputReceipt>
  /** Round trip: walk the subtree rooted at the selector's window. */
  readUia(selector: UiaSelector): Promise<UiaTreeSnapshot>
  /** Round trip: grab one frame covering the target window and its desktop context. */
  capture(target: CaptureTarget): Promise<CaptureFrame>
}
