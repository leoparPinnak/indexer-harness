/**
 * MOCK backends: synthetic stand-ins that simulate the two candidate mechanisms
 * (koffi/message-injection + GDI vs native SendInput + COM UIA + capture session)
 * so the harness, scoring, and verdict run today while the real backends are built.
 * Latency comes from a reviewed per-op profile plus a seeded jitter stream;
 * fidelity behavior follows the declared profile against the fixture ground truth.
 */

import type { CaptureFrame, GuiBackend, GuiCapabilities, InputOp, InputReceipt, UiaSelector, UiaTreeSnapshot } from '../backend.ts'
import { CAPTURE_BLACK } from '../backend.ts'
import type { GuiFixture } from '../fixture.ts'
import { fixtureElements, fixtureWindow } from '../fixture.ts'
import type { Wait } from './clock.ts'
import { realTimerWait } from './clock.ts'

/** Synthetic latency range for one operation class, in milliseconds. */
export interface LatencyRange {
  /** Lower bound drawn every iteration. */
  readonly baseMs: number
  /** Seeded jitter added on top of `baseMs`, in `[0, jitterMs)`. */
  readonly jitterMs: number
}

/** Synthetic behavior profile behind one MOCK backend. */
export interface MockProfile {
  readonly id: string
  readonly label: string
  readonly capabilities: GuiCapabilities
  /** How synthesized input reaches the OS. */
  readonly injection: 'message' | 'input-queue'
  /** How the element tree is read. */
  readonly treeRead: 'message-probe' | 'com-uia'
  /** How frames are grabbed. */
  readonly frameGrab: 'gdi' | 'capture-session'
  readonly latency: {
    readonly sendInput: LatencyRange
    readonly readUia: LatencyRange
    readonly capture: LatencyRange
  }
}

/**
 * Interop profile: every call crosses koffi FFI / PowerShell .NET marshaling, so
 * the per-op round trip is slower than a dedicated helper, and posted-message
 * injection stays lossy on windows that drop posts or are elevated.
 */
export const KOFFI_MOCK_PROFILE: MockProfile = {
  id: 'koffi-message-mock',
  label: 'koffi P/Invoke message-injection + PowerShell UIA + GDI (MOCK)',
  capabilities: { nativeInjection: false, comUia: false, capturesWinRt: false },
  injection: 'message',
  treeRead: 'message-probe',
  frameGrab: 'gdi',
  latency: {
    sendInput: { baseMs: 5, jitterMs: 2 },
    readUia: { baseMs: 9, jitterMs: 3 },
    capture: { baseMs: 6.5, jitterMs: 2 },
  },
}

/**
 * Dedicated-helper profile: raw SendInput, COM vtable walks, and capture-session
 * frames with no marshaling or interpretation, so steady-state per-op latency is
 * faster than the interop path. Helper spawn + NDJSON pipe setup happens once at
 * construction and is never amortized into per-op samples.
 */
export const CODEX_NATIVE_MOCK_PROFILE: MockProfile = {
  id: 'codex-native-mock',
  label: 'native SendInput + COM UIA + capture session (MOCK)',
  capabilities: { nativeInjection: true, comUia: true, capturesWinRt: true },
  injection: 'input-queue',
  treeRead: 'com-uia',
  frameGrab: 'capture-session',
  latency: {
    sendInput: { baseMs: 2.5, jitterMs: 1 },
    readUia: { baseMs: 4, jitterMs: 2 },
    capture: { baseMs: 3, jitterMs: 1.5 },
  },
}

/** Injection options for a mock backend. */
export interface MockHooks {
  /** Synthetic-latency waiter; defaults to a real timer. Inject a virtual clock for deterministic runs. */
  readonly wait?: Wait
}

/** FNV-1a seed so each operation class draws a fixed jitter stream per profile. */
function seedFrom(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Seeded mulberry32 stream returning values in `[0, 1)`. */
function createJitterStream(profileId: string, op: 'sendInput' | 'readUia' | 'capture'): () => number {
  let state = seedFrom(`${profileId}:${op}`)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a MOCK backend that simulates `profile` against `fixture`.
 * @param profile - Synthetic mechanism and latency characteristics to simulate.
 * @param fixture - Ground-truth window world the mock reads and drives.
 * @param hooks - Injection options (waiter).
 * @returns The mock backend, labeled `MOCK`, ready for `runComparison`.
 */
export function createMockGuiBackend(profile: MockProfile, fixture: GuiFixture, hooks: MockHooks = {}): GuiBackend {
  const wait = hooks.wait ?? realTimerWait
  const jitter = {
    sendInput: createJitterStream(profile.id, 'sendInput'),
    readUia: createJitterStream(profile.id, 'readUia'),
    capture: createJitterStream(profile.id, 'capture'),
  }

  async function spend(range: LatencyRange, op: 'sendInput' | 'readUia' | 'capture'): Promise<void> {
    await wait(range.baseMs + jitter[op]() * range.jitterMs)
  }

  return {
    id: profile.id,
    label: profile.label,
    mock: true,
    capabilities: profile.capabilities,

    async sendInput(op: InputOp): Promise<InputReceipt> {
      const window = fixtureWindow(fixture, op.windowId)
      await spend(profile.latency.sendInput, 'sendInput')
      if (profile.injection === 'message' && (window.ignoresPostedMessages || window.elevated)) {
        return {
          delivered: false,
          detail: window.elevated
            ? 'posted message blocked by elevation (UIPI)'
            : 'window drops posted messages',
        }
      }
      return {
        delivered: true,
        detail: profile.injection === 'message' ? 'posted window message' : 'OS input queue (SendInput)',
      }
    },

    async readUia(selector: UiaSelector): Promise<UiaTreeSnapshot> {
      await spend(profile.latency.readUia, 'readUia')
      const elements = fixtureElements(fixture, selector.windowId)
        .filter(element => profile.treeRead === 'com-uia' || element.comOnly !== true)
        .map((element): UiaTreeSnapshot['elements'][number] => {
          const value = element.value === undefined
            ? undefined
            : profile.treeRead === 'message-probe' && element.valueViaMessages === false
              ? ''
              : element.value
          return value === undefined
            ? { path: element.path, name: element.name, bounds: element.bounds }
            : { path: element.path, name: element.name, value, bounds: element.bounds }
        })
      return { elements }
    },

    async capture(target): Promise<CaptureFrame> {
      const window = fixtureWindow(fixture, target.windowId)
      await spend(profile.latency.capture, 'capture')
      const regions: Record<string, string> = {}
      for (const region of fixture.regions) {
        regions[region.name] = profile.frameGrab === 'gdi' && region.scope === 'desktop'
          ? CAPTURE_BLACK
          : region.color
      }
      return { width: window.bounds.width, height: window.bounds.height, regions }
    },
  }
}

/**
 * The koffi-flavored MOCK backend (message injection + message-probe reads + GDI frames).
 * @param fixture - Ground-truth window world to simulate.
 * @param hooks - Injection options (waiter).
 * @returns The mock backend implementing `GuiBackend`.
 */
export function createKoffiMockBackend(fixture: GuiFixture, hooks: MockHooks = {}): GuiBackend {
  return createMockGuiBackend(KOFFI_MOCK_PROFILE, fixture, hooks)
}

/**
 * The Codex-native-flavored MOCK backend (input-queue injection + COM UIA + capture session).
 * @param fixture - Ground-truth window world to simulate.
 * @param hooks - Injection options (waiter).
 * @returns The mock backend implementing `GuiBackend`.
 */
export function createCodexNativeMockBackend(fixture: GuiFixture, hooks: MockHooks = {}): GuiBackend {
  return createMockGuiBackend(CODEX_NATIVE_MOCK_PROFILE, fixture, hooks)
}
