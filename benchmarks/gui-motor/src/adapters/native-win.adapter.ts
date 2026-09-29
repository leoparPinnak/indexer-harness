/**
 * The NativeWin adapter: the harness seam over the REAL engine in
 * `@deepseek-ai/dsh-deamon` (koffi/PInvoke + PowerShell). Each operation drives
 * the engine's own call surface — input batches through the sandbox input route
 * (opt-in `input mode send` = real `SendInput` synthesis on the private
 * desktop), accessibility through the sandbox UIA route (managed .NET UIA walk
 * + the engine's own `parseUiaResult` clamp), capture through the helper's
 * one-shot `-CaptureOnce` GDI path (PNG sampled here; spawn-inclusive, the
 * engine's tested capture route).
 *
 * Capability expectation measured from the mechanism: `nativeInjection=true`
 * (SendInput opt-in), `comUia=false` (managed .NET UIA, not the raw COM
 * vtable), `capturesWinRt=false` (GDI ladder, not WGC).
 *
 * Construction only records the instance — the desktop helper starts on the
 * first `launch()` (the engine's own path), and the caller owns `close()`.
 * See `benchmarks/gui-motor/README.md`, "Plugging in the real backends".
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
// Host-only adapter: the engine's local route surface has no public Node export,
// so the benchmark imports the source directly (worker precedent in this tree).
import {
  SandboxSessionManager,
  handleSandboxInputLocal,
  handleSandboxUiaLocal,
  handleSandboxWindowsLocal,
} from '../../../../packages/bundle/deamon/src/sandbox.ts'
import type { SandboxLocalResponse, SandboxLogger, ShellboxUiaNode } from '../../../../packages/bundle/deamon/src/sandbox.ts'
import type { CaptureFrame, GuiBackend, InputOp, InputReceipt, UiaElement, UiaTreeSnapshot } from '../backend.ts'
import { decodePng, sampleColor } from '../png-region.ts'

/** Region sample point, mirroring the CodexNative adapter's option shape. */
export interface NativeWinRegionSample {
  readonly name: string
  /** `window` coords sit relative to the window's outer rect; `desktop` coords are absolute pixels on the backend's desktop. */
  readonly scope: 'window' | 'desktop'
  readonly x: number
  readonly y: number
}

/** Truthful mechanism claims: SendInput opt-in, managed (non-COM) UIA, GDI capture. */
export const NATIVE_WIN_CAPABILITIES = {
  nativeInjection: true,
  comUia: false,
  capturesWinRt: false,
} as const

/** Result-table identity used by the A/B harness. */
export const NATIVE_WIN_IDENTITY = {
  id: 'nativewin',
  label: 'NativeWin (SendInput + managed UIA + GDI)',
  mock: false,
} as const

/** Options the NativeWin backend takes. */
export interface NativeWinBackendOptions {
  /** Sandbox session key owning the private desktop; defaults to a bench-local key that never collides with a user session. */
  readonly sessionId?: string
  /** Region names + sample points for `capture`; omitted, frames report no regions. */
  readonly regions?: readonly NativeWinRegionSample[]
  /** Virtual-screen size of the backend's desktop in pixels; used to map capture samples into the helper's frame. */
  readonly screenWidth: number
  readonly screenHeight: number
  /** Outer rect of the live target window on the backend's desktop (absolute desktop pixels). */
  readonly windowRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/** The backend plus the teardown the run owns. */
export interface NativeWinBackend extends GuiBackend {
  /** The private desktop name the engine instance owns. */
  readonly desktopName: string
  /** Launch a command onto the private desktop through the engine (starts the helper). */
  launch(command: string): boolean
  /** Stop the desktop helper. */
  close(): Promise<void>
}

/** Default bench-local session key: its desktop name cannot collide with a user shellbox. */
const BENCH_SESSION = 'guibench'

/** How long a window/`state` read waits for the helper's first snapshot. */
const WINDOWS_WAIT_MS = 8000
/** Poll interval for window/state/capture readiness. */
const POLL_MS = 200

/** The engine helper script, resolved from this module like the engine resolves it. */
const HELPER_SCRIPT = fileURLToPath(new URL('../../../../packages/bundle/deamon/sandbox/sandbox-host.ps1', import.meta.url))

/** Virtual-key codes for the key names the harness fixture sends. */
const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Space: 32,
  Backspace: 8,
  Shift: 16,
  Control: 17,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
}

function virtualKey(key: string): number {
  if (VIRTUAL_KEYS[key] !== undefined) return VIRTUAL_KEYS[key] ?? 0
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0)
    if (code >= 65 && code <= 90) return code
    if (code >= 48 && code <= 57) return code
  }
  throw new Error(`gui-motor: NativeWin cannot map key ${JSON.stringify(key)} to a virtual-key code.`)
}

/** Slug one node name into a stable path segment; empty names fall back to the control type. */
function slugSegment(node: ShellboxUiaNode, index: number): string {
  const base = node.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return base !== '' ? base : `${node.ct.toLowerCase()}-${String(index)}`
}

/** A fake POST/GET request stand-in: the engine routes read method, query, and body. */
function routeRequest(method: string, path: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method, url: path }) as unknown as IncomingMessage
}

/** Quiet logger: the bench never reports engine lifecycle lines. */
const quietLog: SandboxLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

/** Unwrap a local route response or throw its refusal loudly. */
function expectOk(response: SandboxLocalResponse): Record<string, unknown> {
  const body = response.body as Record<string, unknown>
  if (response.status !== 200 || body.ok !== true) {
    throw new Error(`gui-motor: NativeWin route refused (${String(response.status)}): ${String(body.error ?? 'unknown error')}`)
  }
  return body
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Build the real NativeWin backend over a bench-local engine instance.
 * @param options - session key, capture regions, and the live window/screen geometry for sampling.
 * @returns the backend implementing `GuiBackend` plus `launch`/`close`.
 */
export function createNativeWinBackend(options: NativeWinBackendOptions): NativeWinBackend {
  const sessionId = options.sessionId ?? BENCH_SESSION
  const regions = options.regions ?? []
  const manager = new SandboxSessionManager(quietLog, { persistencePath: false })
  const record = manager.createInstance({ sessionId, type: 'win32' })

  async function resolveHwnd(windowId: string): Promise<number> {
    const deadline = Date.now() + WINDOWS_WAIT_MS
    const windowsPath = `/api/server/sandbox/windows?session=${encodeURIComponent(sessionId)}`
    for (;;) {
      const response = await handleSandboxWindowsLocal(manager, routeRequest('GET', windowsPath))
      const body = expectOk(response)
      const windows = (body.windows ?? []) as Array<{ hwnd: number; title?: string }>
      const found = windows.find(window => window.title === windowId)
        ?? windows.find(window => window.title?.toLowerCase() === windowId.toLowerCase())
      if (found !== undefined) return found.hwnd
      if (Date.now() >= deadline) {
        throw new Error(`gui-motor: NativeWin found no window ${JSON.stringify(windowId)} on ${record.desktopName}.`)
      }
      await delay(POLL_MS)
    }
  }

  return {
    ...NATIVE_WIN_IDENTITY,
    capabilities: { ...NATIVE_WIN_CAPABILITIES },
    desktopName: record.desktopName,
    launch: command => record.controller.launch(command),

    async sendInput(op: InputOp): Promise<InputReceipt> {
      // The engine's input grammar is raw desktop coordinates: resolve the
      // target first so a blind batch never scores as delivered.
      await resolveHwnd(op.windowId)
      let events: Array<Record<string, unknown>>
      if (op.kind === 'mouseMove') {
        events = [{ t: 'move', x: op.x, y: op.y }]
      } else if (op.kind === 'mouseClick') {
        events = [
          { t: 'move', x: op.x, y: op.y },
          { t: 'button', b: op.button, p: 'down' },
          { t: 'button', b: op.button, p: 'up' },
        ]
      } else {
        const vk = virtualKey(op.key)
        events = [
          { t: 'key', vk, p: 'down' },
          { t: 'key', vk, p: 'up' },
        ]
      }
      const response = await handleSandboxInputLocal(
        manager,
        routeRequest('POST', '/api/server/sandbox/input'),
        JSON.stringify({ session: sessionId, events, mode: 'send' }),
      )
      const body = response.body as Record<string, unknown>
      if (response.status !== 200 || body.ok !== true) {
        return { delivered: false, detail: `${String(body.error ?? 'input refused')} (status ${String(response.status)})` }
      }
      return {
        delivered: body.delivered === true,
        detail: `SendInput batch staged on ${record.desktopName} (${String(body.accepted)} event(s))`,
      }
    },

    async readUia(selector): Promise<UiaTreeSnapshot> {
      const hwnd = await resolveHwnd(selector.windowId)
      const response = await handleSandboxUiaLocal(
        manager,
        routeRequest('POST', '/api/server/sandbox/uia'),
        JSON.stringify({ session: sessionId, hwnd, maxNodes: 256 }),
      )
      const body = expectOk(response)
      const nodes = (body.nodes ?? []) as ShellboxUiaNode[]
      const seen = new Map<string, number>()
      const elements: UiaElement[] = nodes.map((node, index) => {
        const segment = index === 0 ? '' : `/${slugSegment(node, index)}`
        const base = `/${selector.windowId}${segment}`
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        const path = count === 0 ? base : `${base}-${String(index)}`
        const element: UiaElement = {
          path,
          name: node.name,
          bounds: { x: node.x, y: node.y, width: node.w, height: node.h },
        }
        return node.value !== '' ? { ...element, value: node.value } : element
      })
      return { elements }
    },

    async capture(target): Promise<CaptureFrame> {
      await resolveHwnd(target.windowId)
      const dir = mkdtempSync(join(tmpdir(), 'gui-motor-capture-'))
      try {
        const pngPath = join(dir, 'frame.png')
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          HELPER_SCRIPT,
          '-CaptureOnce',
          '-DesktopName',
          record.desktopName,
          '-Out',
          pngPath,
          '-Width',
          String(options.screenWidth),
          '-Height',
          String(options.screenHeight),
        ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
        const frame = decodePng(readFileSync(pngPath))
        // The helper may scale the desktop into the requested frame; map through the ratio.
        const scaleX = frame.width / options.screenWidth
        const scaleY = frame.height / options.screenHeight
        const sampled: Record<string, string> = {}
        for (const region of regions) {
          const originX = region.scope === 'window' ? options.windowRect.x + region.x : region.x
          const originY = region.scope === 'window' ? options.windowRect.y + region.y : region.y
          sampled[region.name] = sampleColor(frame, originX * scaleX, originY * scaleY)
        }
        return { width: frame.width, height: frame.height, regions: sampled }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },

    async close(): Promise<void> {
      await record.controller.stop()
    },
  }
}
