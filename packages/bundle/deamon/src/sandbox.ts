/**
 * @deepseek-ai/dsh-deamon — the Deamon host bridge. It owns at most one
 * Windows desktop helper (`sandbox/sandbox-host.ps1`), publishes the helper's
 * base64 JPEG stdout on two faces — a legacy `multipart/x-mixed-replace`
 * response and the WebSocket route the client tab uses, one binary message per
 * frame — and forwards viewport and quit commands through the helper's command
 * file. The helper is shared: every viewer attaches to the running process, and
 * only `POST /stop` ends it. Mouse and keyboard input, window focus/close, and
 * the window/change reads spool through per-instance files beside that command
 * file, and this module fills the change-source seam `shellbox-changes.ts`
 * exposes. The wire format is frozen in `sandbox/PROTOCOL.md`.
 * @module @deepseek-ai/dsh-deamon/sandbox
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, renameSync, writeFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import WebSocket, { WebSocketServer } from 'ws'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DeamonManager, type DaemonStream, type DeamonTransport } from './deamon-manager.ts'
import { markShellboxTouched, setShellboxChangeSource } from './shellbox-changes.ts'
import type {
  ShellboxChangeKind,
  ShellboxChangesResponse,
  ShellboxInputEvent,
  ShellboxInputResult,
  ShellboxRingEntry,
  ShellboxStateSnapshot,
  ShellboxWindowActionResult,
  ShellboxWindowInfo,
  ShellboxWindowsResponse,
} from './types.ts'

/**
 * Absolute path of the helper script, resolved from this module so the serving
 * process's working directory never enters the path. Source and built layouts
 * both place `sandbox/` one level above the module directory.
 */
const HELPER_SCRIPT = fileURLToPath(new URL('../sandbox/sandbox-host.ps1', import.meta.url))

let sharedDaemonManager: DeamonManager | undefined

/**
 * Get or initialize the shared DeamonManager for the active session.
 * @param log - diagnostic sink for the manager's daemon-lifecycle reports.
 * @returns the shared manager, or the test-seam override when one is set.
 */
export function getDeamonManager(log?: Logger): DeamonManager {
  if (internals.daemonManager !== undefined) return internals.daemonManager
  return sharedDaemonManager ??= new DeamonManager({
    transport: internals.transport,
    log: log ?? {
      info: (m: string) => { console.log(`[deamon] ${m}`) },
      warn: (m: string) => { console.warn(`[deamon] ${m}`) },
      error: (m: string) => { console.error(`[deamon] ${m}`) },
      debug: () => {},
    },
  })
}

/**
 * Test seams. The helper script path is swappable so a spec can drive the bridge
 * against a deterministic stand-in, and the shared controller can be dropped
 * between cases.
 */
export const internals = {
  helperScript: HELPER_SCRIPT,
  /** Pins the command-file path for a spec; an empty value asks for a fresh temp path. */
  commandFile: '',
  /** Whether to use the isolated Deamon microservice (defaults to true in production). */
  useDaemon: true,
  /** Transport the shared DeamonManager mounts with: `deamon.transport` in a composition. */
  transport: 'pipe' as DeamonTransport,
  /** Test seam override for daemon manager. */
  daemonManager: undefined as DeamonManager | undefined,
  resetController: async (): Promise<void> => {
    const daemonManager = sharedDaemonManager
    sharedDaemonManager = undefined
    if (daemonManager !== undefined) await daemonManager.stop()
    const manager = sharedManager
    sharedManager = undefined
    if (manager !== undefined) await manager.stopAll()
    internals.daemonManager = undefined
  },
}

/** MJPEG boundary token, repeated in the response's `boundary=` parameter and each part. */
const FRAME_BOUNDARY = 'frame'

/** Content type of stream responses. */
const STREAM_CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${FRAME_BOUNDARY}`

/** Upgrade path of the WebSocket route that carries the same frames as binary messages. */
const STREAM_WS_PATH = '/api/server/sandbox/ws'

/** Largest multipart reassembly buffer; an incomplete frame past this bound is dropped whole. */
const MAX_FRAME_BUFFER_BYTES = 16 * 1024 * 1024

/** Queued socket bytes beyond this bound drop frames until the viewer drains. */
const WS_BACKPRESSURE_BYTES = 2 * 1024 * 1024

/** Viewport the helper starts with, matching the PROTOCOL example. */
const INITIAL_VIEWPORT: Viewport = { width: 800, height: 600 }

/** Frame rate requested from the helper. */
const FRAME_RATE = 30

/**
 * Largest accepted viewport dimension, in PHYSICAL pixels: the panel sends its
 * CSS box times `devicePixelRatio`, so this bounds the helper's canvas at about
 * 5K even on a 200% display.
 */
const MAX_VIEWPORT = 5120

/**
 * Time a `quit` command gets before the helper is force-killed. The helper's own
 * shutdown stops the shell it started and then releases the desktop, which takes
 * seconds; killing it early would leave the shell holding the desktop alive.
 */
const QUIT_GRACE_MS = 8000

/** Canonical base64 line: the only stdout form that is a frame. */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/u

/** Largest input batch one `POST /api/server/sandbox/input` accepts. */
const MAX_INPUT_EVENTS = 64

/** Delivery mode of one input batch: posted messages (the default, unchanged) or opt-in real input synthesis. */
export type ShellboxInputMode = 'post' | 'send'

/** Largest node count one `uia` read may ask for; the helper clamps to the same bound. */
const MAX_UIA_NODES = 256

/** Node count a `uia` read takes when the request does not name one. */
const DEFAULT_UIA_NODES = 128

/** How long `POST /api/server/sandbox/uia` waits for the helper's sidecar answer. */
const UIA_WAIT_MS = 3000

/** Poll interval of that wait: the helper answers between frames. */
const UIA_POLL_MS = 25

/** A `.state` snapshot younger than this still counts as fresh. */
const STATE_FRESH_MS = 2000

/** Page size a `GET /api/server/sandbox/changes` read uses when it names no limit. */
const CHANGES_DEFAULT_LIMIT = 50

/** Largest page a `GET /api/server/sandbox/changes` read may request. */
const CHANGES_MAX_LIMIT = 500

/** A validated viewport request. */
interface Viewport {
  width: number
  height: number
}

/** One response attached to the shared helper. */
interface StreamClient {
  /** The response receiving frame parts. */
  res: ServerResponse
  /** True while the socket write buffer is full; frames are dropped until `drain`. */
  blocked: boolean
}

/**
 * Decode one helper stdout line into a frame.
 * @param line - one stdout line with its line ending removed.
 * @returns the JPEG bytes, or undefined for a blank or non-base64 line.
 */
function decodeFrame(line: string): Buffer | undefined {
  if (line.length === 0 || line.length % 4 !== 0 || !BASE64_LINE.test(line)) return undefined
  const frame = Buffer.from(line, 'base64')
  return frame.length === 0 ? undefined : frame
}

/**
 * Reassemble complete JPEG payloads from `multipart/x-mixed-replace` bytes.
 *
 * A frame completes when its declared `Content-Length` payload has landed:
 * parts split across chunks stay buffered, bytes before the boundary marker
 * are framing leftovers and are dropped, and a part whose declared length
 * would pass {@link MAX_FRAME_BUFFER_BYTES} — or a header block without a
 * length — resets the buffer so a malformed producer cannot grow memory.
 * @returns a parser whose `push` returns every frame completed by the chunk.
 */
export function createMultipartFrameParser(): { push(chunk: Buffer): Buffer[] } {
  const marker = Buffer.from(`--${FRAME_BOUNDARY}\r\n`, 'ascii')
  const headerEnd = Buffer.from('\r\n\r\n', 'ascii')
  const trailer = Buffer.from('\r\n', 'ascii')
  const lengthField = /content-length:\s*(\d+)/iu
  let pending: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): Buffer[] {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      const frames: Buffer[] = []
      for (;;) {
        const start = pending.indexOf(marker)
        if (start === -1) {
          // Keep only a marker-sized tail: the boundary itself may be split.
          pending = pending.length > marker.length ? pending.subarray(pending.length - marker.length) : pending
          break
        }
        if (start > 0) pending = pending.subarray(start)
        const fieldsEnd = pending.indexOf(headerEnd, marker.length)
        if (fieldsEnd === -1) {
          if (pending.length > MAX_FRAME_BUFFER_BYTES) pending = Buffer.alloc(0)
          break
        }
        const fields = pending.subarray(marker.length, fieldsEnd).toString('ascii')
        const declared = lengthField.exec(fields)
        const length = declared === null ? -1 : Number(declared[1])
        const payloadStart = fieldsEnd + headerEnd.length
        if (!Number.isSafeInteger(length) || length < 0 || length + payloadStart > MAX_FRAME_BUFFER_BYTES) {
          pending = Buffer.alloc(0)
          break
        }
        if (pending.length < payloadStart + length) break
        frames.push(pending.subarray(payloadStart, payloadStart + length))
        let next = payloadStart + length
        // One part trailer is two bytes; a stream may end without it.
        if (pending.subarray(next, next + trailer.length).equals(trailer)) next += trailer.length
        pending = pending.subarray(next)
        if (pending.length === 0) break
      }
      return frames
    },
  }
}

/**
 * Validate a parsed size-request body.
 * @param value - the parsed JSON value.
 * @returns the viewport, or undefined when either dimension is not a positive safe integer within {@link MAX_VIEWPORT}.
 */
function parseViewport(value: unknown): Viewport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!isDimension(record.width) || !isDimension(record.height)) return undefined
  return { width: record.width, height: record.height }
}

/**
 * @param value - candidate viewport dimension.
 * @returns true for a positive safe integer no larger than {@link MAX_VIEWPORT}.
 */
function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_VIEWPORT
}

/**
 * @param value - candidate number.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns true for an integer within the bounds.
 */
function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * @param value - candidate number.
 * @returns true for any integer; wheel deltas carry no protocol range.
 */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** One event's parse result: the typed event, or the violated rule's message. */
type ParsedInputEvent = { ok: true; event: ShellboxInputEvent } | { ok: false; error: string }

/**
 * Validate one entry of an input batch against the frozen wire ranges.
 * @param value - candidate event entry.
 * @param index - its position in the batch, quoted in the violation message.
 * @returns the typed event, or the first violated rule's message.
 */
function parseInputEvent(value: unknown, index: number): ParsedInputEvent {
  const at = `events[${String(index)}]`
  if (typeof value !== 'object' || value === null) return { ok: false, error: `${at} must be an object` }
  const record = value as Record<string, unknown>
  switch (record.t) {
    case 'move': {
      if (!isIntegerWithin(record.x, 0, MAX_VIEWPORT)) {
        return { ok: false, error: `${at}.x must be an integer from 0 through ${String(MAX_VIEWPORT)}` }
      }
      if (!isIntegerWithin(record.y, 0, MAX_VIEWPORT)) {
        return { ok: false, error: `${at}.y must be an integer from 0 through ${String(MAX_VIEWPORT)}` }
      }
      return { ok: true, event: { t: 'move', x: record.x, y: record.y } }
    }
    case 'button': {
      if (record.b !== 'left' && record.b !== 'right' && record.b !== 'middle') {
        return { ok: false, error: `${at}.b must be one of left, right, middle` }
      }
      if (record.p !== 'down' && record.p !== 'up') {
        return { ok: false, error: `${at}.p must be one of down, up` }
      }
      return { ok: true, event: { t: 'button', b: record.b, p: record.p } }
    }
    case 'wheel': {
      if (!isInteger(record.dx)) return { ok: false, error: `${at}.dx must be an integer` }
      if (!isInteger(record.dy)) return { ok: false, error: `${at}.dy must be an integer` }
      return { ok: true, event: { t: 'wheel', dx: record.dx, dy: record.dy } }
    }
    case 'key': {
      if (!isIntegerWithin(record.vk, 1, 254)) {
        return { ok: false, error: `${at}.vk must be an integer from 1 through 254` }
      }
      if (record.p !== 'down' && record.p !== 'up') {
        return { ok: false, error: `${at}.p must be one of down, up` }
      }
      return { ok: true, event: { t: 'key', vk: record.vk, p: record.p } }
    }
    case 'char': {
      if (!isIntegerWithin(record.c, 0, 65535)) {
        return { ok: false, error: `${at}.c must be an integer from 0 through 65535` }
      }
      return { ok: true, event: { t: 'char', c: record.c } }
    }
    default:
      return { ok: false, error: `${at}.t must be one of move, button, wheel, key, char` }
  }
}

/**
 * Validate a raw `events` JSON value into the helper's input-event union.
 * Rejects anything outside the frozen wire ranges: a non-array, more than
 * {@link MAX_INPUT_EVENTS} entries, coordinates off the {@link MAX_VIEWPORT}
 * canvas, unknown button or press names, non-integer wheel deltas, virtual
 * keys outside 1 through 254, and `char` values that are not UTF-16 code units.
 * @param body - the unparsed `events` value.
 * @returns the validated events in request order, or the first violation's message.
 */
export function parseInputEvents(body: unknown): { ok: true; events: ShellboxInputEvent[] } | { ok: false; error: string } {
  if (!Array.isArray(body)) return { ok: false, error: 'events must be an array' }
  if (body.length > MAX_INPUT_EVENTS) {
    return { ok: false, error: `events must hold at most ${String(MAX_INPUT_EVENTS)} entries` }
  }
  const events: ShellboxInputEvent[] = []
  for (let index = 0; index < body.length; index += 1) {
    const parsed = parseInputEvent(body[index], index)
    if (!parsed.ok) return parsed
    events.push(parsed.event)
  }
  return { ok: true, events }
}

/**
 * Validate a raw batch `mode` value. Absent means `post`, so an older client
 * that never sends the field keeps the posted-message path byte for byte.
 * @param value - the unparsed `mode` value.
 * @returns the delivery mode, or the violated rule's message.
 */
export function parseInputMode(value: unknown): { ok: true; mode: ShellboxInputMode } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, mode: 'post' }
  if (value === 'post' || value === 'send') return { ok: true, mode: value }
  return { ok: false, error: 'mode must be one of post, send' }
}

/**
 * Wait for a child's `close` event.
 * @param child - the process to observe.
 * @param ms - maximum wait.
 * @returns true when the child had already closed or closed within `ms`.
 */
async function closedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    function onClose(): void {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolve(false)
    }, ms)
    child.once('close', onClose)
  })
}

/**
 * Read a request body as UTF-8 text.
 * @param req - the request to drain.
 * @returns the concatenated body text.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  return (await buffer(req)).toString('utf8')
}

/**
 * Answer a request with JSON.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Minimal logging contract the sandbox controller and session manager consume. */
export interface SandboxLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

/**
 * Owner of the single sandbox helper process and of every response attached to
 * it. A helper exit detaches it, so the next stream request starts a fresh one.
 */
export class SandboxController {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly clients = new Set<StreamClient>()
  /** Partial stdout line held between chunks. */
  private pending = ''
  /** Viewport requested at helper start, kept so a restarted helper matches the last request. */
  private viewport: Viewport = { ...INITIAL_VIEWPORT }
  /** Frame rate requested at helper start, updated when setFps is called. */
  private frameRate = FRAME_RATE
  private frameTimestamps: number[] = []
  /**
   * Control channel for the current helper. Windows PowerShell cannot poll stdin
   * without blocking, so commands go through a file the helper drains per frame.
   */
  private commandFile = ''
  /** Input spool directory of the current helper: `<commandFile>.in`. */
  private inputDir = ''
  /** Monotonic spool batch sequence within one helper run, starting at 1. */
  private inputSeq = 0

  /**
   * @param log - diagnostic sink for helper stderr, lifecycle, and exit reports.
   * @param desktop - Win32 private desktop name. Defaults to 'dsh-shellbox'.
   * @param instanceId - bound virtual-instance id whose change ring this controller feeds; empty runs no diff timer.
   */
  constructor(
    private readonly log: SandboxLogger,
    readonly desktop: string = 'dsh-shellbox',
    readonly instanceId: string = '',
  ) {}

  /**
   * True while the helper child process is alive.
   * @returns whether the helper child is running.
   */
  isActive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * The current helper's command file path, whose `.state` sibling holds the
   * helper's window snapshot.
   * @returns the absolute path, or '' before any helper start.
   */
  currentCommandFile(): string {
    return this.commandFile
  }

  /**
   * Return the real-time measured frames per second over recent frames.
   * @returns instantaneous frame rate in frames per second, rounded to 1 decimal place.
   */
  getMeasuredFps(): number {
    const now = Date.now()
    this.frameTimestamps = this.frameTimestamps.filter(t => now - t <= 1500)
    if (this.frameTimestamps.length < 2) return 0
    const first = this.frameTimestamps[0]
    const last = this.frameTimestamps[this.frameTimestamps.length - 1]
    if (first === undefined || last === undefined) return 0
    const durationSec = (last - first) / 1000
    if (durationSec <= 0.05) return 0
    return Math.round(((this.frameTimestamps.length - 1) / durationSec) * 10) / 10
  }

  /**
   * Attach one response to the shared helper, starting the helper when absent.
   * The response stays open until its client disconnects or the helper exits;
   * ending one attached response never touches another.
   * @param res - the response owning the multipart body.
   */
  stream(res: ServerResponse): void {
    try {
      this.ensureStarted()
    } catch (error: unknown) {
      this.log.error(`sandbox: could not start the helper: ${String(error)}`)
      respondJson(res, 500, { ok: false, error: 'sandbox helper failed to start' })
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', STREAM_CONTENT_TYPE)
    res.setHeader('cache-control', 'no-store')
    res.flushHeaders()
    const client: StreamClient = { res, blocked: false }
    this.clients.add(client)
    const cleanup = (): void => {
      this.clients.delete(client)
    }
    res.on('close', cleanup)
    res.on('finish', cleanup)
    res.on('error', cleanup)
  }

  /**
   * Forward a viewport command to the helper's command file.
   * @param width - positive safe integer pixel width.
   * @param height - positive safe integer pixel height.
   * @returns false when no helper is running.
   */
  setViewport(width: number, height: number): boolean {
    if (!this.writeCommand(`size ${String(width)} ${String(height)}\n`)) return false
    this.viewport = { width, height }
    return true
  }

  /**
   * Return the current frame rate requested from the helper.
   * @returns frame rate in frames per second.
   */
  getFps(): number {
    return this.frameRate
  }

  /**
   * Forward an fps command to the helper's command file.
   * @param fps - frame rate between 1 and 60.
   * @returns false when no helper is running or fps is invalid.
   */
  setFps(fps: number): boolean {
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) return false
    this.frameRate = Math.round(fps)
    return this.writeCommand(`fps ${String(this.frameRate)}\n`)
  }

  /**
   * Forward a launch command to the helper's command file, starting the helper when absent.
   * @param command - command line to execute on the Shellbox desktop.
   * @returns true when the command was written to the command file.
   */
  launch(command: string): boolean {
    const trimmed = command.trim()
    if (trimmed === '') return false
    try {
      this.ensureStarted()
    } catch (error: unknown) {
      this.log.error(`sandbox: could not start the helper for launch: ${String(error)}`)
      return false
    }
    return this.writeCommand(`launch ${trimmed}\n`)
  }

  /**
   * Stop the helper: ask it to quit, then force-kill a process outliving the
   * grace period. Attached responses end first, because the helper destroys
   * its desktop as it exits. The instance's diff timer ends here and its ring
   * records a `desktop-reset`.
   * @returns true when a helper was running and is now stopped.
   */
  async stop(): Promise<boolean> {
    const child = this.child
    if (child === undefined) return false
    const commandFile = this.commandFile
    this.child = undefined
    this.pending = ''
    stopShellboxRingDiff(this.instanceId, this.desktop)
    this.endClients()
    if (child.exitCode === null && child.signalCode === null) {
      // Keep draining stdout until the helper is gone. Unhooking the stdout
      // listener first fills the pipe, blocks the helper mid-frame, and the
      // command file is only polled between frames — so `quit` would never land.
      try {
        writeFileSync(`${commandFile}.tmp`, 'quit\n')
        renameSync(`${commandFile}.tmp`, commandFile)
      } catch (error: unknown) {
        this.log.warn(`sandbox: could not write the quit command: ${String(error)}`)
      }
      if (!await closedWithin(child, QUIT_GRACE_MS)) {
        this.log.warn('sandbox: helper did not quit within the grace period; force-killing it')
        child.kill('SIGKILL')
        if (!await closedWithin(child, QUIT_GRACE_MS)) {
          this.log.warn('sandbox: helper survived a force-kill; its desktop may outlive the bridge')
        }
      }
    }
    this.detachPipes(child)
    this.removeCommandFile(commandFile)
    this.removeInputDir(`${commandFile}.in`)
    this.inputDir = ''
    this.inputSeq = 0
    return true
  }

  /** Spawn the helper when absent; a running one is shared by every stream. */
  private ensureStarted(): void {
    if (this.child !== undefined) {
      // A helper whose instance was unbound and re-attached needs its swept diff timer back.
      this.ensureRingDiffTimer()
      return
    }
    const commandFile = internals.commandFile !== ''
      ? internals.commandFile
      : join(tmpdir(), `dsh-sandbox-${randomBytes(6).toString('hex')}.cmd`)
    this.removeCommandFile(commandFile)
    const inputDir = `${commandFile}.in`
    // A restarted helper must never replay batches staged for its predecessor.
    this.removeInputDir(inputDir)
    mkdirSync(inputDir, { recursive: true })
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', internals.helperScript,
      '-Stream',
      '-Width', String(this.viewport.width),
      '-Height', String(this.viewport.height),
      '-Fps', String(this.frameRate),
      '-DesktopName', this.desktop,
      '-CommandFile', commandFile,
      '-InputDir', inputDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.commandFile = commandFile
    this.inputDir = inputDir
    this.inputSeq = 0
    this.child = child
    this.pending = ''
    this.attachPipes(child)
    this.ensureRingDiffTimer()
  }

  /**
   * Start this instance's ring diff timer once: a 1000 ms interval that runs
   * one snapshot diff pass and then sweeps stale timers, keyed by instance id
   * so helper stop and settle can clear it. A controller outside any instance
   * runs no timer.
   */
  private ensureRingDiffTimer(): void {
    if (this.instanceId === '' || shellboxDiffTimers.has(this.instanceId)) return
    const timer = setInterval(() => {
      drainShellboxStateTick(this.instanceId)
      sweepShellboxRings()
    }, RING_DIFF_TICK_MS)
    // The poller is background work; it must never hold the process open alone.
    timer.unref()
    shellboxDiffTimers.set(this.instanceId, timer)
  }

  /** Write one command for the helper to drain on its next frame. */
  private writeCommand(line: string): boolean {
    if (this.child === undefined || this.commandFile === '') return false
    return this.writeAtomically(this.commandFile, line)
  }

  /**
   * Spool one ordered batch of command lines for the running helper: a single
   * staged file renamed into `<commandFile>.in`, so the helper never observes
   * a partially written batch and drains stay ordered by the padded sequence.
   * @param lines - command lines without line endings, in delivery order.
   * @returns false when no helper is running or the batch could not be staged.
   */
  queueInput(lines: readonly string[]): boolean {
    if (!this.isActive() || this.inputDir === '') return false
    // An empty batch is already delivered: nothing to stage for the helper.
    if (lines.length === 0) return true
    this.inputSeq += 1
    const name = `${String(this.inputSeq).padStart(6, '0')}-${randomBytes(2).toString('hex')}.cmd`
    const staging = join(this.inputDir, `${name}.tmp`)
    const target = join(this.inputDir, name)
    try {
      writeFileSync(staging, lines.map(line => `${line}\n`).join(''))
      renameSync(staging, target)
      return true
    } catch (error: unknown) {
      this.log.warn(`sandbox: could not spool an input batch: ${String(error)}`)
      return false
    }
  }

  /**
   * Land a command file atomically. A plain write creates the path before its
   * bytes exist, and the helper polls that path every frame, so a half-written
   * command would be read as empty and deleted.
   */
  private writeAtomically(path: string, line: string): boolean {
    const staging = `${path}.tmp`
    try {
      writeFileSync(staging, line)
      renameSync(staging, path)
      return true
    } catch (error: unknown) {
      this.log.warn(`sandbox: could not write a command: ${String(error)}`)
      return false
    }
  }

  /** Remove a command file, tolerating an already-gone path. */
  private removeCommandFile(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch (error: unknown) {
      this.log.debug(`sandbox: could not remove ${path}: ${String(error)}`)
    }
  }

  /** Remove an input spool directory, tolerating an already-gone path. */
  private removeInputDir(path: string): void {
    if (path === '') return
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error: unknown) {
      this.log.debug(`sandbox: could not remove ${path}: ${String(error)}`)
    }
  }

  /** Wire one helper's pipes: frames to attached responses, stderr and exit to the diagnostic log. */
  private attachPipes(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.consumeStdout(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim()
      if (line !== '') this.log.info(`deamon helper: ${line}`)
    })
    // stdin writes race the helper's own exit; a closed pipe is expected then.
    child.stdin.on('error', (error: Error) => {
      this.log.debug(`sandbox: helper stdin closed: ${error.message}`)
    })
    child.once('error', (error: Error) => {
      this.settleChild(child, `could not run the helper: ${error.message}`)
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.settleChild(child, `helper exited with code ${String(code)}${signal === null ? '' : ` (${signal})`}`)
    })
  }

  /**
   * Release one helper: end attached responses and let the next request start
   * a fresh one. The instance's diff timer ends here and its ring records a
   * `desktop-reset`.
   */
  private settleChild(child: ChildProcessWithoutNullStreams, detail: string): void {
    if (this.child !== child) return
    this.child = undefined
    this.pending = ''
    stopShellboxRingDiff(this.instanceId, this.desktop)
    this.frameTimestamps = []
    // The helper is gone with its spool: removing the directory here keeps a
    // later restart from replaying batches the dead helper never drained.
    this.removeInputDir(this.inputDir)
    this.inputDir = ''
    this.inputSeq = 0
    this.log.warn(`sandbox: ${detail}`)
    this.endClients()
  }

  /** Detach every listening pipe of a helper the bridge is about to end. */
  private detachPipes(child: ChildProcessWithoutNullStreams): void {
    child.stdout.removeAllListeners()
    child.stderr.removeAllListeners()
    child.stdin.removeAllListeners()
    child.removeAllListeners()
    child.stdout.destroy()
    child.stderr.destroy()
  }

  /** Split stdout into lines and relay each frame to every attached response. */
  private consumeStdout(chunk: string): void {
    this.pending += chunk
    if (this.pending.length > 20 * 1024 * 1024) {
      this.pending = ''
      return
    }
    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      this.publish(this.pending.slice(0, newline).replace(/\r$/u, ''))
      this.pending = this.pending.slice(newline + 1)
      newline = this.pending.indexOf('\n')
    }
  }

  /** Write one frame part per attached response; a blocked socket drops frames until it drains. */
  private publish(line: string): void {
    const frame = decodeFrame(line)
    if (frame === undefined) return
    const now = Date.now()
    this.frameTimestamps.push(now)
    if (this.frameTimestamps.length > 120) {
      this.frameTimestamps.splice(0, this.frameTimestamps.length - 120)
    }
    const header = Buffer.from(
      `--${FRAME_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}\r\n\r\n`,
      'ascii',
    )
    const trailer = Buffer.from('\r\n', 'ascii')
    for (const client of this.clients) {
      const { res } = client
      if (client.blocked || res.writableEnded || res.destroyed) continue
      try {
        res.write(header)
        client.blocked = !res.write(frame)
        res.write(trailer)
        if (client.blocked) res.once('drain', () => { client.blocked = false })
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /** End every attached multipart response. */
  private endClients(): void {
    for (const client of this.clients) {
      try {
        if (!client.res.writableEnded && !client.res.destroyed) {
          client.res.end()
        }
      } catch {
        // Ignore dead socket errors
      }
    }
    this.clients.clear()
  }
}

/**
 * Record describing one virtual desktop or Hyper-V environment instance.
 */
export interface VirtualInstanceRecord {
  id: string
  ownerSessionId: string
  boundSessionIds: string[]
  type: 'win32' | 'hyperv' | 'wsl-ubuntu'
  name: string
  desktopName: string
  vmName?: string | undefined
  controller: SandboxController
  createdAt: number
}

/**
 * Whether a selection names the user's real desktop: that surface's window
 * listing stays readable, while input and window actions are refused with 403.
 * @param instanceId - requested instance id, when the caller named one.
 * @param target - requested target kind, when the caller named one.
 * @returns true for the `host-desktop` instance or a `desktop`/`host-desktop` target.
 */
function isHostDesktopTarget(instanceId?: string, target?: string): boolean {
  return target === 'desktop' || target === 'host-desktop' || instanceId === 'host-desktop'
}

/**
 * Manager coordinating session-scoped sandbox helper processes and virtual instances.
 * Each DSH session can create and bind multiple numbered virtual instances.
 * The 'default' key falls back to the original 'dsh-shellbox' desktop.
 */
export class SandboxSessionManager {
  private readonly instances = new Map<string, VirtualInstanceRecord>()
  private readonly sessionDefault = new Map<string, string>()
  private readonly persistencePath: string | false

  constructor(
    private readonly log: SandboxLogger,
    options?: { persistencePath?: string | false },
  ) {
    this.persistencePath = options?.persistencePath ?? this.getDefaultPersistencePath()
    this.loadFromDisk()
  }

  private getDefaultPersistencePath(): string | false {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined) return false
    const dataDir = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
    return join(dataDir, 'sandbox-instances.json')
  }

  private loadFromDisk(): void {
    if (this.persistencePath === false) return
    try {
      const p = this.persistencePath
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8')
        const items = JSON.parse(text) as Array<{
          id?: string
          ownerSessionId?: string
          boundSessionIds?: string[]
          type?: 'win32' | 'hyperv' | 'wsl-ubuntu'
          name?: string
          desktopName?: string
          vmName?: string | undefined
          createdAt?: number
        }>
        if (Array.isArray(items)) {
          for (const item of items) {
            if (typeof item.id === 'string' && typeof item.desktopName === 'string') {
              const controller = new SandboxController(this.log, item.desktopName, item.id)
              const rec: VirtualInstanceRecord = {
                id: item.id,
                ownerSessionId: item.ownerSessionId ?? 'default',
                boundSessionIds: Array.isArray(item.boundSessionIds) ? item.boundSessionIds : [item.ownerSessionId ?? 'default'],
                type: item.type ?? 'win32',
                name: item.name ?? item.desktopName,
                desktopName: item.desktopName,
                vmName: item.vmName,
                controller,
                createdAt: item.createdAt ?? Date.now(),
              }
              this.instances.set(rec.id, rec)
              for (const s of rec.boundSessionIds) {
                if (!this.sessionDefault.has(s)) {
                  this.sessionDefault.set(s, rec.id)
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore corrupted or missing file
    }
  }

  private saveToDisk(): void {
    if (this.persistencePath === false) return
    try {
      const p = this.persistencePath
      const d = dirname(p)
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
      const list: Array<{
        id: string
        ownerSessionId: string
        boundSessionIds: string[]
        type: 'win32' | 'hyperv' | 'wsl-ubuntu'
        name: string
        desktopName: string
        vmName?: string | undefined
        createdAt: number
      }> = []
      for (const rec of this.instances.values()) {
        if (rec.id === 'host-desktop') continue
        list.push({
          id: rec.id,
          ownerSessionId: rec.ownerSessionId,
          boundSessionIds: [...rec.boundSessionIds],
          type: rec.type,
          name: rec.name,
          desktopName: rec.desktopName,
          vmName: rec.vmName,
          createdAt: rec.createdAt,
        })
      }
      writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8')
    } catch {
      // Ignore write errors
    }
  }

  /**
   * Clean session id into safe desktop name suffix (alphanumeric only, max 16 chars).
   * @param sessionId - raw session key to sanitize.
   * @param index - 1-based instance number; 1 omits the numeric suffix.
   * @returns a safe Win32 desktop name for the session and index.
   */
  static desktopNameFor(sessionId: string, index: number = 1): string {
    const clean = sessionId.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 16)
    if (clean.length === 0) return 'dsh-shellbox'
    return index <= 1 ? `dsh-sb-${clean}` : `dsh-sb-${clean}-${String(index)}`
  }

  /**
   * Get or create controller for a session, explicit instance ID, or target type. Defaults to 'default' when empty.
   * @param sessionId - session key; empty falls back to 'default'.
   * @param instanceId - explicit instance id, when the caller named one.
   * @param target - target kind (`win32`, `hyperv`, `wsl-ubuntu`, or a host desktop).
   * @returns the matching or newly created controller.
   */
  get(sessionId?: string, instanceId?: string, target?: string): SandboxController {
    const key = sessionId?.trim() || 'default'

    // If host desktop is requested
    if (isHostDesktopTarget(instanceId, target)) {
      const hostCtrl = this.instances.get('host-desktop')
      if (hostCtrl === undefined) {
        const controller = new SandboxController(this.log, 'Default', 'host-desktop')
        const record: VirtualInstanceRecord = {
          id: 'host-desktop',
          ownerSessionId: 'global',
          boundSessionIds: ['default', key],
          type: 'win32',
          name: 'Ana Masaüstü (Salt Okunur)',
          desktopName: 'Default',
          controller,
          createdAt: Date.now(),
        }
        this.instances.set('host-desktop', record)
        return controller
      }
      return hostCtrl.controller
    }

    if (instanceId !== undefined && instanceId.trim() !== '') {
      const rec = this.instances.get(instanceId.trim())
      if (rec !== undefined) return rec.controller
    }

    // If target type is explicitly wsl-ubuntu
    if (target === 'wsl-ubuntu') {
      for (const rec of this.instances.values()) {
        if (rec.boundSessionIds.includes(key) && rec.type === 'wsl-ubuntu') {
          return rec.controller
        }
      }
      const rec = this.createInstance({ sessionId: key, type: 'wsl-ubuntu', vmName: 'Ubuntu 24.04 LTS' })
      return rec.controller
    }

    // If target type is explicitly hyperv
    if (target === 'hyperv') {
      for (const rec of this.instances.values()) {
        if (rec.boundSessionIds.includes(key) && rec.type === 'hyperv') {
          return rec.controller
        }
      }
      const rec = this.createInstance({ sessionId: key, type: 'hyperv', vmName: 'Hyper-V' })
      return rec.controller
    }

    // If target type is explicitly win32
    if (target === 'win32') {
      for (const rec of this.instances.values()) {
        if (rec.boundSessionIds.includes(key) && rec.type === 'win32') {
          return rec.controller
        }
      }
      const rec = this.createInstance({ sessionId: key, type: 'win32' })
      return rec.controller
    }

    const defId = this.sessionDefault.get(key)
    if (defId !== undefined) {
      const rec = this.instances.get(defId)
      if (rec !== undefined) return rec.controller
    }

    for (const rec of this.instances.values()) {
      if (rec.boundSessionIds.includes(key)) {
        this.sessionDefault.set(key, rec.id)
        return rec.controller
      }
    }

    const rec = this.createInstance({ sessionId: key, type: 'win32' })
    return rec.controller
  }

  /**
   * Resolve an existing instance without creating one: the read-only twin of
   * {@link get} for window reads and input delivery, which must report a
   * missing desktop instead of materializing it. Unlike `get`, an explicit
   * unknown instance id resolves to undefined rather than falling back to the
   * session default, so a read or an input batch never reaches a desktop the
   * caller did not name.
   * @param sessionId - session key; empty falls back to 'default'.
   * @param instanceId - explicit instance id, when the caller named one.
   * @param target - target kind, when the caller named one.
   * @returns the matching record, or undefined when no such desktop exists.
   */
  find(sessionId?: string, instanceId?: string, target?: string): VirtualInstanceRecord | undefined {
    const key = sessionId?.trim() || 'default'
    if (isHostDesktopTarget(instanceId, target)) return this.instances.get('host-desktop')
    if (instanceId !== undefined && instanceId.trim() !== '') {
      return this.instances.get(instanceId.trim())
    }
    if (target === 'wsl-ubuntu' || target === 'hyperv' || target === 'win32') {
      for (const rec of this.instances.values()) {
        if (rec.boundSessionIds.includes(key) && rec.type === target) return rec
      }
      return undefined
    }
    const defId = this.sessionDefault.get(key)
    if (defId !== undefined) {
      const rec = this.instances.get(defId)
      if (rec !== undefined) return rec
    }
    for (const rec of this.instances.values()) {
      if (rec.boundSessionIds.includes(key)) return rec
    }
    return undefined
  }

  /**
   * Every instance bound to a session, in registration order.
   * @param sessionId - session key; empty falls back to 'default'.
   * @returns the bound records, empty when the session owns no desktop.
   */
  boundInstances(sessionId: string): VirtualInstanceRecord[] {
    const key = sessionId.trim() || 'default'
    return Array.from(this.instances.values()).filter(rec => rec.boundSessionIds.includes(key))
  }

  /**
   * Create a new numbered instance for a session.
   * @param options - session key, optional instance type, and optional VM name.
   * @returns the created (or reused) instance record.
   */
  createInstance(options: {
    sessionId: string
    type?: 'win32' | 'hyperv' | 'wsl-ubuntu' | undefined
    vmName?: string | undefined
  }): VirtualInstanceRecord {
    const sessionKey = options.sessionId.trim() || 'default'
    const type = options.type ?? 'win32'

    let count = 0
    for (const rec of this.instances.values()) {
      if (rec.ownerSessionId === sessionKey) count++
    }
    const index = count + 1

    let id: string
    let desktopName: string
    let name: string

    if (sessionKey === 'default' && index === 1) {
      id = 'default'
      desktopName = 'dsh-shellbox'
      name = 'Shellbox Varsayılan'
    } else {
      desktopName = SandboxSessionManager.desktopNameFor(sessionKey, index)
      id = desktopName
      if (type === 'wsl-ubuntu') {
        name = options.vmName ?? 'Ubuntu 24.04 LTS'
      } else if (type === 'hyperv' && options.vmName) {
        name = options.vmName
      } else {
        name = `Masaüstü #${String(index)}`
      }
    }

    const existing = this.instances.get(id)
    if (existing !== undefined) {
      if (!existing.boundSessionIds.includes(sessionKey)) {
        existing.boundSessionIds.push(sessionKey)
      }
      this.sessionDefault.set(sessionKey, id)
      return existing
    }

    const controller = new SandboxController(this.log, desktopName, id)
    const record: VirtualInstanceRecord = {
      id,
      ownerSessionId: sessionKey,
      boundSessionIds: [sessionKey],
      type,
      name,
      desktopName,
      vmName: options.vmName,
      controller,
      createdAt: Date.now(),
    }

    this.instances.set(id, record)
    this.sessionDefault.set(sessionKey, id)
    this.saveToDisk()
    return record
  }

  /**
   * Attach an existing instance to another session.
   * @param targetSessionId - session to bind the instance to.
   * @param instanceId - existing instance id.
   * @returns whether the instance existed and is now attached.
   */
  attachInstance(targetSessionId: string, instanceId: string): boolean {
    const rec = this.instances.get(instanceId)
    if (rec === undefined) return false
    const targetKey = targetSessionId.trim()
    if (!rec.boundSessionIds.includes(targetKey)) {
      rec.boundSessionIds.push(targetKey)
    }
    this.sessionDefault.set(targetKey, rec.id)
    this.saveToDisk()
    return true
  }

  /**
   * Detach an instance from a session.
   * @param sessionId - session to unbind from.
   * @param instanceId - instance to detach.
   * @returns whether the instance existed and is now detached.
   */
  detachInstance(sessionId: string, instanceId: string): boolean {
    const rec = this.instances.get(instanceId)
    if (rec === undefined) return false
    const sessionKey = sessionId.trim()
    rec.boundSessionIds = rec.boundSessionIds.filter(id => id !== sessionKey)
    if (this.sessionDefault.get(sessionKey) === instanceId) {
      this.sessionDefault.delete(sessionKey)
    }
    this.saveToDisk()
    return true
  }

  /**
   * Terminate and cleanup an instance.
   * @param instanceId - instance to terminate and remove.
   * @returns whether the instance existed and was torn down.
   */
  async terminateInstance(instanceId: string): Promise<boolean> {
    const rec = this.instances.get(instanceId)
    if (rec === undefined) return false
    await rec.controller.stop()
    this.instances.delete(instanceId)
    for (const [sKey, defId] of this.sessionDefault.entries()) {
      if (defId === instanceId) this.sessionDefault.delete(sKey)
    }
    this.saveToDisk()
    return true
  }

  /**
   * List all instances across sessions with current status.
   * @returns every instance record paired with its live-active flag.
   */
  listInstances(): Array<Omit<VirtualInstanceRecord, 'controller'> & { active: boolean }> {
    return Array.from(this.instances.values()).map(rec => ({
      id: rec.id,
      ownerSessionId: rec.ownerSessionId,
      boundSessionIds: [...rec.boundSessionIds],
      type: rec.type,
      name: rec.name,
      desktopName: rec.desktopName,
      vmName: rec.vmName,
      createdAt: rec.createdAt,
      active: rec.controller.isActive(),
    }))
  }

  /**
   * Stop and remove session instances.
   * @param sessionId - session whose instances are stopped; empty defaults to 'default'.
   * @returns whether any instance was stopped.
   */
  async stop(sessionId?: string): Promise<boolean> {
    const key = sessionId?.trim() || 'default'
    let anyStopped = false
    for (const [id, rec] of Array.from(this.instances.entries())) {
      if (rec.boundSessionIds.includes(key)) {
        rec.boundSessionIds = rec.boundSessionIds.filter(s => s !== key)
        if (rec.boundSessionIds.length === 0 || rec.ownerSessionId === key) {
          await rec.controller.stop()
          this.instances.delete(id)
          anyStopped = true
        }
      }
    }
    this.sessionDefault.delete(key)
    return anyStopped
  }

  /** Stop all running controllers (for teardown/reset). */
  async stopAll(): Promise<void> {
    for (const rec of this.instances.values()) {
      await rec.controller.stop()
    }
    this.instances.clear()
    this.sessionDefault.clear()
  }

  /**
   * Check if a session has an active running helper.
   * @param sessionId - session to inspect; empty defaults to 'default'.
   * @returns whether any bound controller has a live helper.
   */
  hasActive(sessionId?: string): boolean {
    const key = sessionId?.trim() || 'default'
    for (const rec of this.instances.values()) {
      if (rec.boundSessionIds.includes(key) && rec.controller.isActive()) {
        return true
      }
    }
    return false
  }
}

/**
 * Extract session ID from request URL query or JSON payload.
 * @param req - incoming request carrying the `session` query parameter.
 * @param bodyPayload - parsed JSON body, consulted first for `sessionId`.
 * @returns the trimmed session id, or undefined when absent.
 */
export function parseSessionParam(req: IncomingMessage, bodyPayload?: unknown): string | undefined {
  if (typeof bodyPayload === 'object' && bodyPayload !== null) {
    const bodySession = (bodyPayload as { sessionId?: unknown }).sessionId
    if (typeof bodySession === 'string' && bodySession.trim() !== '') {
      return bodySession.trim()
    }
  }
  if (typeof req.url === 'string') {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const querySession = parsedUrl.searchParams.get('session')
      if (querySession !== null && querySession.trim() !== '') {
        return querySession.trim()
      }
    } catch {
      // Ignore URL parse error, fallback to undefined
    }
  }
  return undefined
}

/**
 * Extract instance ID from request URL query or JSON payload.
 * @param req - incoming request carrying the `instance` query parameter.
 * @param bodyPayload - parsed JSON body, consulted first for `instanceId`.
 * @returns the trimmed instance id, or undefined when absent.
 */
export function parseInstanceParam(req: IncomingMessage, bodyPayload?: unknown): string | undefined {
  if (typeof bodyPayload === 'object' && bodyPayload !== null) {
    const bodyInstance = (bodyPayload as { instanceId?: unknown }).instanceId
    if (typeof bodyInstance === 'string' && bodyInstance.trim() !== '') {
      return bodyInstance.trim()
    }
  }
  if (typeof req.url === 'string') {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const queryInstance = parsedUrl.searchParams.get('instance')
      if (queryInstance !== null && queryInstance.trim() !== '') {
        return queryInstance.trim()
      }
    } catch {
      // Ignore URL parse error, fallback to undefined
    }
  }
  return undefined
}

/**
 * Extract target environment type from request URL query or JSON payload.
 * @param req - incoming request carrying the `target` query parameter.
 * @param bodyPayload - parsed JSON body, consulted first for `target`.
 * @returns the trimmed target kind, or undefined when absent.
 */
export function parseTargetParam(req: IncomingMessage, bodyPayload?: unknown): string | undefined {
  if (typeof bodyPayload === 'object' && bodyPayload !== null) {
    const bodyTarget = (bodyPayload as { target?: unknown }).target
    if (typeof bodyTarget === 'string' && bodyTarget.trim() !== '') {
      return bodyTarget.trim()
    }
  }
  if (typeof req.url === 'string') {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const queryTarget = parsedUrl.searchParams.get('target')
      if (queryTarget !== null && queryTarget.trim() !== '') {
        return queryTarget.trim()
      }
    } catch {
      // Ignore URL parse error, fallback to undefined
    }
  }
  return undefined
}

/**
 * Extract frame rate parameter (1-60 fps) from request URL query or JSON payload.
 * @param req - incoming request carrying the `fps` query parameter.
 * @param bodyPayload - parsed JSON body, consulted first for `fps`.
 * @returns the rounded fps clamped to 1-60, or undefined when absent or invalid.
 */
export function parseFpsParam(req: IncomingMessage, bodyPayload?: unknown): number | undefined {
  if (typeof bodyPayload === 'object' && bodyPayload !== null) {
    const raw = (bodyPayload as { fps?: unknown }).fps
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(num) && num >= 1 && num <= 60) return Math.round(num)
  }
  if (typeof req.url === 'string') {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const query = parsedUrl.searchParams.get('fps')
      if (query !== null) {
        const num = Number(query)
        if (Number.isFinite(num) && num >= 1 && num <= 60) return Math.round(num)
      }
    } catch {
      // Ignore URL parse error, fallback to undefined
    }
  }
  return undefined
}

/**
 * Resolve well-known application aliases (msedge, chrome) to their full executable
 * paths and ensure an isolated user-data-dir is attached so Chromium processes do not
 * defer to existing instances on the interactive desktop.
 * @param command - launch command, possibly a bare app alias.
 * @param desktopName - target desktop whose user-data-dir is scoped.
 * @returns the resolved launch command.
 */
export function resolveLaunchCommand(command: string, desktopName: string): string {
  let cmd = command.trim()
  const lower = cmd.toLowerCase()
  const isEdge = lower.startsWith('msedge') || lower.startsWith('"msedge')
  const isChrome = lower.startsWith('chrome') || lower.startsWith('"chrome')

  if (
    lower.startsWith('wsl')
    || lower.startsWith('"wsl')
    || lower.startsWith('bash')
    || lower.startsWith('"bash')
    || lower.startsWith('ubuntu')
    || lower.startsWith('"ubuntu')
  ) {
    if (!lower.includes('conhost')) {
      const rest = cmd.replace(/^("?[^"\s]+"?)/, '').trim()
      const wslArgs = rest === '' ? '' : (rest.startsWith('--') ? rest : `-- ${rest}`)
      return `conhost.exe wsl.exe -d Ubuntu ${wslArgs}`.trim()
    }
    return cmd
  }

  if (isEdge || isChrome) {
    let exePath = ''
    if (isEdge) {
      const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
      for (const c of candidates) {
        if (existsSync(c)) { exePath = c; break }
      }
    } else if (isChrome) {
      const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ]
      for (const c of candidates) {
        if (existsSync(c)) { exePath = c; break }
      }
    }

    if (exePath !== '') {
      const argsPart = cmd.replace(/^("?[^"\s]+"?)/, '').trim()
      const profileDir = join(
        process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
        'shellbox-profiles',
        desktopName,
      )
      try {
        if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true })
      } catch {
        // Fallback if directory creation fails
      }

      const hasProfile = argsPart.includes('--user-data-dir')
      const profileFlag = hasProfile ? '' : `--user-data-dir="${profileDir}" --no-first-run --no-default-browser-check`
      cmd = `"${exePath}" ${profileFlag} ${argsPart}`.trim()
    }
  }
  return cmd
}

/** The manager coordinating helper controllers for this process. */
let sharedManager: SandboxSessionManager | undefined

/**
 * Reject an upgrade with a raw HTTP status before the WebSocket handshake.
 * Mirrors the mux's rejection bytes; the gateway's writer is not a dependency
 * of this bundle.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

/**
 * Queue one JPEG for the viewer as a binary message, dropping it when the
 * socket is no longer open or already holds more than
 * {@link WS_BACKPRESSURE_BYTES}: a slow viewer loses frames instead of
 * stalling the fan-out, the policy the multipart writers apply per response.
 * @param ws - accepted viewer socket.
 * @param frame - one JPEG payload.
 */
function sendFrame(ws: WebSocket, frame: Buffer): void {
  /* v8 ignore next -- the closed-socket drop needs an ordering no spec can stage without racing close. */
  if (ws.readyState !== WebSocket.OPEN) return
  /* v8 ignore next -- the backpressure drop needs a >2MiB queue that a loopback socket drains before it can be observed. */
  if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) return
  ws.send(frame, { binary: true }, (error) => {
    /* v8 ignore next -- a send failure means the peer vanished mid-queue, which the readiness arm already covers on a loopback socket. */
    if (error) ws.terminate()
  })
}

/** The controller's multipart writer retargeted at one WebSocket, with its detach hook. */
interface ControllerSink {
  /** The object `SandboxController.stream` writes multipart parts to. */
  readonly response: ServerResponse
  /** Run the controller's lifecycle cleanups once, as a viewer's socket close would. */
  release(): void
}

/**
 * Adapt the shared controller's multipart writer to one WebSocket viewer: the
 * written parts pass through {@link createMultipartFrameParser} and reach the
 * socket as binary messages. Writes always succeed — the socket applies its
 * own drop policy in {@link sendFrame}, so the controller never waits for
 * `drain`. `end()` closes the viewer with a retryable code, which is how a
 * helper exit or a start failure reaches the client's reconnect ladder.
 * @param onFrame - delivers each reassembled JPEG payload.
 * @param onEnd - runs when the controller ends the stream.
 * @returns the sink plus the detach hook for the socket's close.
 */
function createControllerSink(onFrame: (frame: Buffer) => void, onEnd: () => void): ControllerSink {
  const parser = createMultipartFrameParser()
  const cleanups: Array<() => void> = []
  let ended = false
  let dead = false
  const response = {
    statusCode: 0,
    get writableEnded(): boolean { return ended },
    get destroyed(): boolean { return dead },
    setHeader: (): void => {},
    flushHeaders: (): void => {},
    write: (chunk: Buffer): boolean => {
      for (const frame of parser.push(chunk)) onFrame(frame)
      return true
    },
    end: (): void => {
      ended = true
      dead = true
      onEnd()
    },
    on: (_event: string, listener: () => void): unknown => {
      cleanups.push(listener)
      return response
    },
  }
  return {
    response: response as unknown as ServerResponse,
    release(): void {
      dead = true
      for (const listener of cleanups.splice(0)) listener()
    },
  }
}

/**
 * Serve one viewer socket: resolve the shared frame source for the upgrade's
 * query and forward every JPEG as a binary message. A source failure closes
 * the socket —1013 while a reconnect may succeed (daemon unavailable, source
 * error status),1011 when the source itself ended — and the client's retry
 * ladder owns recovery, exactly as the HTTP stream's errors do.
 * @param ws - accepted viewer socket.
 * @param req - upgrade request carrying the stream query.
 * @param daemonManager - manager of the shared Deamon microservice.
 * @param manager - controller manager for the in-process helper path.
 */
async function serveSandboxFrames(
  ws: WebSocket,
  req: IncomingMessage,
  daemonManager: DeamonManager,
  manager: SandboxSessionManager,
): Promise<void> {
  const state = { closed: false }
  let upstream: DaemonStream | undefined
  const finish = (): void => {
    state.closed = true
    upstream?.destroy()
  }
  ws.once('close', finish)
  ws.once('error', finish)
  try {
    if (internals.useDaemon) {
      await daemonManager.ensureRunning()
      if (state.closed) return
      /* v8 ignore next -- an upgraded request always carries a parsed target; the default only satisfies the `string | undefined` type. */
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').search
      const parser = createMultipartFrameParser()
      const endStream = (): void => {
        finish()
        ws.close(1011, 'sandbox stream ended')
      }
      let source: DaemonStream
      try {
        // Same byte stream as the HTTP face, whichever transport carried it.
        source = await daemonManager.openStream(`/stream${query}`)
      } catch {
        /* v8 ignore next -- an error landing after the close already destroyed the request races that close on the event loop. */
        if (state.closed) return
        finish()
        ws.close(1013, 'sandbox daemon unavailable')
        return
      }
      upstream = source
      /* v8 ignore next 4 -- a response from the same tick must not reattach after the close; no spec can order those two events. */
      if (state.closed) {
        source.destroy()
        return
      }
      if (source.statusCode >= 400) {
        finish()
        source.destroy()
        ws.close(1013, 'sandbox stream unavailable')
        return
      }
      source.on('error', endStream)
      source.on('end', endStream)
      source.on('data', (chunk: Buffer) => {
        for (const frame of parser.push(chunk)) sendFrame(ws, frame)
      })
      return
    }
    const controller = manager.get(parseSessionParam(req), parseInstanceParam(req), parseTargetParam(req))
    const fps = parseFpsParam(req)
    if (fps !== undefined) controller.setFps(fps)
    const sink = createControllerSink(
      (frame) => { sendFrame(ws, frame) },
      () => { ws.close(1011, 'sandbox helper stopped') },
    )
    ws.once('close', () => { sink.release() })
    controller.stream(sink.response)
  } catch {
    // ensureRunning refused or the manager failed: retry from a fresh socket.
    finish()
    ws.close(1013, 'sandbox stream unavailable')
  }
}

/**
 * Spool one ordered batch of helper command lines for an instance's running
 * helper through that instance's `<commandFile>.in` directory.
 * @param instance - instance whose helper receives the batch.
 * @param lines - command lines without line endings, in delivery order.
 * @returns false when the helper is not running or the batch could not be staged.
 */
export function queueShellboxCommands(instance: VirtualInstanceRecord, lines: readonly string[]): boolean {
  return instance.controller.queueInput(lines)
}

/**
 * Read an instance's `.state` snapshot beside its command file. The helper
 * renames complete snapshots into place, but a read racing any writer can
 * still see a missing or half-written file: a stat, read, JSON, or shape
 * failure reports nothing rather than a partial desktop.
 * @param instance - instance whose helper owns the snapshot.
 * @returns the parsed snapshot with its file age in milliseconds, or undefined when unreadable.
 */
export function readShellboxState(instance: VirtualInstanceRecord): { snapshot: ShellboxStateSnapshot; ageMs: number } | undefined {
  const commandFile = instance.controller.currentCommandFile()
  if (commandFile === '') return undefined
  try {
    const stat = statSync(`${commandFile}.state`)
    const parsed = JSON.parse(readFileSync(`${commandFile}.state`, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as ShellboxStateSnapshot).windows)) {
      return undefined
    }
    return { snapshot: parsed as ShellboxStateSnapshot, ageMs: Date.now() - stat.mtimeMs }
  } catch {
    // A missing or half-written snapshot is an ordinary race, not an error.
    return undefined
  }
}

/** What a local sandbox route handler hands back for the route to write with `respondJson`. */
export interface SandboxLocalResponse {
  /** HTTP status code the response carries. */
  status: number
  /** JSON-serializable response body. */
  body: unknown
}

/** Refusal body of input, window-action, accessibility, and paging routes: `ok:false` with the echoed status. */
type ShellboxRefusal = Extract<ShellboxInputResult, { readonly ok: false }>

/**
 * @param status - HTTP status the route answers with.
 * @param error - machine-readable reason echoed in the body.
 * @returns the `ok:false` refusal body.
 */
function refuse(status: number, error: string): ShellboxRefusal {
  return { ok: false, status, error }
}

/**
 * A trimmed non-empty string field of a parsed JSON body.
 * @param payload - the parsed body.
 * @param key - field name.
 * @returns the value, or undefined when absent or not a usable string.
 */
function bodyParam(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Resolve the session key a request targets for the touched-session mark: a
 * JSON body `session`, then the shared `sessionId`/`?session=` resolution, then
 * the manager's `default` key.
 * @param req - the incoming request.
 * @param raw - its body text when the route already read it.
 * @returns the resolved session key.
 */
function resolveRequestSession(req: IncomingMessage, raw?: string): string {
  if (raw !== undefined) {
    try {
      const payload: unknown = JSON.parse(raw)
      const direct = bodyParam(payload, 'session')
      if (direct !== undefined) return direct
      const shared = parseSessionParam(req, payload)
      if (shared !== undefined) return shared
    } catch {
      // Invalid JSON carries no session; the query fallback below still can.
    }
  }
  return parseSessionParam(req) ?? 'default'
}

/**
 * The parsed query of a request; a malformed or absent URL contributes no parameters.
 * @param req - the request to read.
 * @returns its search parameters.
 */
function queryParams(req: IncomingMessage): URLSearchParams {
  if (typeof req.url !== 'string') return new URLSearchParams()
  try {
    return new URL(req.url, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Render validated events in the helper's spool grammar, one line per event in
 * delivery order. A `send` batch is opened by its `input mode send` line, which
 * is the only grammar addition: batches that do not ask for synthesis emit the
 * exact `input …` lines they always did, and the helper starts every spool file
 * back in post mode.
 * @param events - events accepted by {@link parseInputEvents}.
 * @param mode - batch delivery mode; defaults to `post`.
 * @returns the `input …` lines without line endings.
 */
export function shellboxInputLines(
  events: readonly ShellboxInputEvent[],
  mode: ShellboxInputMode = 'post',
): string[] {
  const lines = events.map((event): string => {
    switch (event.t) {
      case 'move': return `input move ${String(event.x)} ${String(event.y)}`
      case 'button': return `input button ${event.b} ${event.p}`
      case 'wheel': return `input wheel ${String(event.dx)} ${String(event.dy)}`
      case 'key': return `input key ${String(event.vk)} ${event.p}`
      case 'char': return `input char ${String(event.c)}`
    }
  })
  return mode === 'send' ? ['input mode send', ...lines] : lines
}

/**
 * Deliver one input batch to the target desktop, enforcing the route's status
 * precedence: malformed events (400) before host-desktop refusal (403) before a
 * missing helper (409).
 * @param manager - the session/instance manager holding the desktops.
 * @param session - requested session key, or undefined for 'default'.
 * @param instance - requested instance id, or undefined for the session default.
 * @param target - requested target kind, or undefined.
 * @param events - raw `events` value; {@link parseInputEvents} validates it.
 * @returns the delivery result with its HTTP-mappable status.
 */
function deliverShellboxInput(
  manager: SandboxSessionManager,
  session: string | undefined,
  instance: string | undefined,
  target: string | undefined,
  events: unknown,
  mode: unknown,
): ShellboxInputResult {
  const parsed = parseInputEvents(events)
  if (!parsed.ok) return refuse(400, parsed.error)
  const parsedMode = parseInputMode(mode)
  if (!parsedMode.ok) return refuse(400, parsedMode.error)
  if (isHostDesktopTarget(instance, target)) return refuse(403, 'host desktop input is directed to the shellbox desktop')
  const record = manager.find(session, instance, target)
  if (record === undefined || !record.controller.isActive()) {
    return refuse(409, 'shellbox helper is not running')
  }
  if (!queueShellboxCommands(record, shellboxInputLines(parsed.events, parsedMode.mode))) {
    return refuse(500, 'could not queue input commands for the shellbox helper')
  }
  return { ok: true, accepted: parsed.events.length, delivered: true }
}

/**
 * Spool one window action for the target desktop, enforcing the same status
 * precedence as input delivery.
 * @param manager - the session/instance manager holding the desktops.
 * @param session - requested session key, or undefined for 'default'.
 * @param instance - requested instance id, or undefined for the session default.
 * @param target - requested target kind, or undefined.
 * @param action - `focus` spools `focus <hwnd>`, `close` spools `wmclose <hwnd>`.
 * @param hwnd - raw `hwnd` value; a positive safe integer is required.
 * @returns `{ok:true, delivered:true}` once staged, or the refusal with its status.
 */
function deliverShellboxWindowAction(
  manager: SandboxSessionManager,
  session: string | undefined,
  instance: string | undefined,
  target: string | undefined,
  action: 'focus' | 'close',
  hwnd: unknown,
): ShellboxWindowActionResult | ShellboxRefusal {
  if (typeof hwnd !== 'number' || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
    return refuse(400, 'hwnd must be a positive integer')
  }
  if (isHostDesktopTarget(instance, target)) return refuse(403, 'host desktop input is directed to the shellbox desktop')
  const record = manager.find(session, instance, target)
  if (record === undefined || !record.controller.isActive()) {
    return refuse(409, 'shellbox helper is not running')
  }
  const line = action === 'focus' ? `focus ${String(hwnd)}` : `wmclose ${String(hwnd)}`
  if (!queueShellboxCommands(record, [line])) {
    return refuse(500, 'could not queue the window action for the shellbox helper')
  }
  return { ok: true, delivered: true }
}

/** One node of a helper accessibility document after host-side clamping. */
export interface ShellboxUiaNode {
  readonly ct: string
  readonly name: string
  readonly cls: string
  readonly value: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly enabled: boolean
  readonly offscreen: boolean
  readonly hwnd: number
}

/** Largest string one accessibility node carries; the helper truncates first. */
const UIA_STRING_LIMIT = 200

/**
 * @param value - candidate text field from the helper's document.
 * @returns the text as a string, cut to {@link UIA_STRING_LIMIT}.
 */
function clampUiaText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length > UIA_STRING_LIMIT ? value.slice(0, UIA_STRING_LIMIT) : value
}

/**
 * @param value - candidate coordinate field from the helper's document.
 * @returns the value as an integer clamped into the protocol's 0..5120 range, else 0.
 */
function clampUiaCoord(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_VIEWPORT, Math.max(0, Math.round(value)))
}

/**
 * Parse and clamp the helper's `uia` sidecar document. The helper already
 * bounds the walk, but the route treats it as untrusted input: a broken or
 * hostile document must still answer a shape the protocol promises — capped
 * node count, clamped coordinates, bounded strings.
 * @param raw - the sidecar file's text.
 * @param maxNodes - the cap the request asked for.
 * @returns the bounded tree, or the parse/refusal message.
 */
export function parseUiaResult(raw: string, maxNodes: number): { ok: true; hwnd: number; truncated: boolean; nodes: ShellboxUiaNode[] } | { ok: false; error: string } {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'helper accessibility document is not valid JSON' }
  }
  if (typeof doc !== 'object' || doc === null) {
    return { ok: false, error: 'helper accessibility document is not an object' }
  }
  const record = doc as Record<string, unknown>
  if (record.ok !== true) {
    const message = typeof record.error === 'string' && record.error !== '' ? record.error : 'helper refused the accessibility read'
    return { ok: false, error: message }
  }
  const cap = Math.min(Math.max(Math.round(maxNodes), 1), MAX_UIA_NODES)
  const rawNodes: unknown[] = Array.isArray(record.nodes) ? record.nodes : []
  const nodes: ShellboxUiaNode[] = []
  for (const rawNode of rawNodes) {
    if (nodes.length >= cap) break
    if (typeof rawNode !== 'object' || rawNode === null) continue
    const node = rawNode as Record<string, unknown>
    nodes.push({
      ct: clampUiaText(node.ct),
      name: clampUiaText(node.name),
      cls: clampUiaText(node.cls),
      value: clampUiaText(node.value),
      x: clampUiaCoord(node.x),
      y: clampUiaCoord(node.y),
      w: clampUiaCoord(node.w),
      h: clampUiaCoord(node.h),
      enabled: node.enabled === true,
      offscreen: node.offscreen === true,
      hwnd: typeof node.hwnd === 'number' && Number.isSafeInteger(node.hwnd) ? node.hwnd : 0,
    })
  }
  const truncated = record.truncated === true || rawNodes.length > cap
  const hwnd = typeof record.hwnd === 'number' && Number.isSafeInteger(record.hwnd) ? record.hwnd : 0
  return { ok: true, hwnd, truncated, nodes }
}

/** Reads are serialized: one helper answers one sidecar path at a time. */
let uiaQueue: Promise<void> = Promise.resolve()

/**
 * Spool `uia <hwnd> <max>` for the target desktop and wait for the helper's
 * sidecar answer, enforcing the same status precedence as input delivery and
 * a bounded wait — the helper writes between frames, so a silent helper is a
 * conflict, never a hang.
 * @param manager - the session/instance manager holding the desktops.
 * @param session - requested session key, or undefined for 'default'.
 * @param instance - requested instance id, or undefined for the session default.
 * @param target - requested target kind, or undefined.
 * @param hwnd - raw `hwnd` value; a positive safe integer is required.
 * @param maxNodes - raw `maxNodes` value; 1 through {@link MAX_UIA_NODES}, or the default.
 * @returns the bounded tree, or the refusal with its status.
 */
async function deliverShellboxUia(
  manager: SandboxSessionManager,
  session: string | undefined,
  instance: string | undefined,
  target: string | undefined,
  hwnd: unknown,
  maxNodes: unknown,
): Promise<{ ok: true; hwnd: number; truncated: boolean; nodes: ShellboxUiaNode[] } | ShellboxRefusal> {
  if (typeof hwnd !== 'number' || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
    return refuse(400, 'hwnd must be a positive integer')
  }
  let cap = DEFAULT_UIA_NODES
  if (maxNodes !== undefined) {
    if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_UIA_NODES) {
      return refuse(400, `maxNodes must be an integer from 1 through ${String(MAX_UIA_NODES)}`)
    }
    cap = maxNodes
  }
  if (isHostDesktopTarget(instance, target)) return refuse(403, 'host desktop input is directed to the shellbox desktop')
  const record = manager.find(session, instance, target)
  if (record === undefined || !record.controller.isActive()) {
    return refuse(409, 'shellbox helper is not running')
  }
  const commandFile = record.controller.currentCommandFile()
  if (commandFile === '') return refuse(409, 'shellbox helper is not running')
  const sidecar = `${commandFile}.uia`
  const previous = uiaQueue
  let release: (() => void) | undefined
  uiaQueue = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    rmSync(sidecar, { force: true })
    rmSync(`${sidecar}.tmp`, { force: true })
    if (!queueShellboxCommands(record, [`uia ${String(hwnd)} ${String(cap)}`])) {
      return refuse(500, 'could not queue the accessibility read for the shellbox helper')
    }
    const deadline = Date.now() + UIA_WAIT_MS
    while (Date.now() < deadline) {
      if (existsSync(sidecar)) {
        const raw = readFileSync(sidecar, 'utf8')
        rmSync(sidecar, { force: true })
        const parsed = parseUiaResult(raw, cap)
        if (!parsed.ok) return refuse(400, parsed.error)
        return { ok: true, hwnd: parsed.hwnd, truncated: parsed.truncated, nodes: parsed.nodes }
      }
      if (!record.controller.isActive()) return refuse(409, 'shellbox helper is not running')
      await new Promise<void>((resolve) => { setTimeout(resolve, UIA_POLL_MS) })
    }
    return refuse(504, 'accessibility read timed out')
  } finally {
    release?.()
  }
}

/** Entries retained per instance ring; the oldest entry goes once this capacity is passed. */
const SHELLBOX_RING_CAPACITY = 500

/** Interval of the per-instance diff timer started when a helper spawns. */
const RING_DIFF_TICK_MS = 1000

/** One process-wide ring-id counter, shared by every instance and starting at 1. */
let nextRingId = 1

/** Retained ring plus the diff state of one instance. */
interface ShellboxRingState {
  /** Retained entries in ascending id order, capped at {@link SHELLBOX_RING_CAPACITY}. */
  entries: ShellboxRingEntry[]
  /** Windows of the last fresh pass, keyed by hwnd. */
  lastWindows: Map<number, { pid: number; title: string }>
  /** Whether the next fresh pass only establishes the silent baseline. */
  baseline: boolean
  /** Subject hwnd of the last fresh pass; 0 when no subject was tracked. */
  subject: number
  /** Win32 desktop name stamped into this instance's entries. */
  desktop: string
}

/** Every instance's retained ring, keyed by instance id. */
const shellboxRings = new Map<string, ShellboxRingState>()

/** Live diff timers, keyed by instance id. */
const shellboxDiffTimers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Append one change to an instance's ring, creating the ring on first use and
 * dropping the oldest entry once the capacity is passed.
 * @param instanceId - instance the change belongs to.
 * @param desktop - Win32 desktop name stamped into the entry.
 * @param kind - what changed on the desktop.
 * @param facts - the concrete window/process facts the change names.
 */
function pushShellboxRingEntry(
  instanceId: string,
  desktop: string,
  kind: ShellboxChangeKind,
  facts: { windowId?: number; title?: string; processId?: number; process?: string },
): void {
  let ring = shellboxRings.get(instanceId)
  if (ring === undefined) {
    ring = { entries: [], lastWindows: new Map(), baseline: true, subject: 0, desktop }
    shellboxRings.set(instanceId, ring)
  }
  ring.entries.push({ id: nextRingId++, time: Date.now(), kind, instanceId, desktop: ring.desktop, ...facts })
  while (ring.entries.length > SHELLBOX_RING_CAPACITY) ring.entries.shift()
}

/**
 * End one instance's diff timer and record a synthetic `desktop-reset` for the
 * helper it watched; the retained ring keeps that entry readable after the
 * helper is gone.
 * @param instanceId - instance whose helper stopped; empty for a controller outside any instance.
 * @param desktop - Win32 desktop name of that helper.
 */
function stopShellboxRingDiff(instanceId: string, desktop: string): void {
  const timer = shellboxDiffTimers.get(instanceId)
  if (timer !== undefined) {
    clearInterval(timer)
    shellboxDiffTimers.delete(instanceId)
  }
  if (instanceId === '') return
  pushShellboxRingEntry(instanceId, desktop, 'desktop-reset', {})
}

/**
 * Record a fresh pass's windows and subject as the baseline the next pass
 * compares against.
 * @param ring - instance ring whose diff state is replaced.
 * @param windows - visible windows of the fresh snapshot.
 * @param subject - subject hwnd of the fresh snapshot; 0 when none is tracked.
 */
function storeShellboxWindows(
  ring: ShellboxRingState,
  windows: readonly ShellboxWindowInfo[],
  subject: number,
): void {
  const stored = new Map<number, { pid: number; title: string }>()
  for (const w of windows) stored.set(w.hwnd, { pid: w.pid, title: w.title })
  ring.lastWindows = stored
  ring.subject = subject
}

/**
 * Run one diff pass over an instance's fresh `.state` snapshot: the first pass
 * only stores a silent baseline; later passes append one entry per new, closed,
 * retitled, started, exited, or newly focused window and process. A missing or
 * stale snapshot leaves the stored windows untouched.
 * @param instanceId - instance whose snapshot is compared against its stored baseline.
 */
export function drainShellboxStateTick(instanceId: string): void {
  const manager = sharedManager
  if (manager === undefined) return
  const rec = manager.find(undefined, instanceId)
  if (rec === undefined) return
  const state = readShellboxState(rec)
  if (state === undefined || state.ageMs >= STATE_FRESH_MS) return
  const snapshot = state.snapshot
  const windows = snapshot.windows
  let ring = shellboxRings.get(instanceId)
  if (ring === undefined) {
    ring = { entries: [], lastWindows: new Map(), baseline: true, subject: 0, desktop: rec.desktopName }
    shellboxRings.set(instanceId, ring)
  }
  const nowByHwnd = new Map<number, ShellboxWindowInfo>()
  for (const w of windows) nowByHwnd.set(w.hwnd, w)
  if (ring.baseline) {
    ring.baseline = false
    storeShellboxWindows(ring, windows, snapshot.subject)
    return
  }

  const desktop = ring.desktop
  const prev = ring.lastWindows
  const nowPids = new Map<number, ShellboxWindowInfo>()
  for (const w of windows) if (!nowPids.has(w.pid)) nowPids.set(w.pid, w)
  const prevPids = new Map<number, { hwnd: number; title: string }>()
  for (const [hwnd, meta] of prev) if (!prevPids.has(meta.pid)) prevPids.set(meta.pid, { hwnd, title: meta.title })

  for (const w of windows) {
    if (!prev.has(w.hwnd)) {
      pushShellboxRingEntry(instanceId, desktop, 'window-opened', { windowId: w.hwnd, title: w.title, processId: w.pid, process: w.exe })
    }
  }
  for (const [pid, w] of nowPids) {
    if (!prevPids.has(pid)) {
      pushShellboxRingEntry(instanceId, desktop, 'process-started', { windowId: w.hwnd, title: w.title, processId: pid, process: w.exe })
    }
  }
  for (const [hwnd, meta] of prev) {
    if (!nowByHwnd.has(hwnd)) {
      pushShellboxRingEntry(instanceId, desktop, 'window-closed', { windowId: hwnd, title: meta.title, processId: meta.pid })
    }
  }
  for (const [pid, meta] of prevPids) {
    if (!nowPids.has(pid)) {
      pushShellboxRingEntry(instanceId, desktop, 'process-exited', { windowId: meta.hwnd, title: meta.title, processId: pid })
    }
  }
  for (const [hwnd, meta] of prev) {
    const w = nowByHwnd.get(hwnd)
    if (w !== undefined && w.title !== meta.title) {
      pushShellboxRingEntry(instanceId, desktop, 'window-title', { windowId: hwnd, title: w.title, processId: w.pid, process: w.exe })
    }
  }
  if (snapshot.subject !== 0 && snapshot.subject !== ring.subject) {
    const w = nowByHwnd.get(snapshot.subject)
    pushShellboxRingEntry(instanceId, desktop, 'window-focused', w === undefined
      ? { windowId: snapshot.subject }
      : { windowId: snapshot.subject, title: w.title, processId: w.pid, process: w.exe })
  }
  storeShellboxWindows(ring, windows, snapshot.subject)
}

/**
 * Clear the diff timer of every instance whose desktop is no longer running
 * and bound, recording its `desktop-reset` first, so a stop path that never
 * ran still ends with a stopped timer and a readable departure entry.
 */
function sweepShellboxRings(): void {
  const manager = sharedManager
  if (manager === undefined) return
  for (const [instanceId, timer] of [...shellboxDiffTimers]) {
    const rec = manager.find(undefined, instanceId)
    if (rec !== undefined && rec.boundSessionIds.length > 0 && rec.controller.isActive()) continue
    clearInterval(timer)
    shellboxDiffTimers.delete(instanceId)
    const ring = shellboxRings.get(instanceId)
    const desktop = ring === undefined ? rec?.desktopName : ring.desktop
    if (desktop !== undefined) {
      pushShellboxRingEntry(instanceId, desktop, 'desktop-reset', {})
    }
  }
}

/**
 * One pure ring page for the filtered desktops: a read over the retained
 * per-instance rings that advances no cursor. With no instance filter the page
 * covers every ring bound to the session key; a named instance reads its ring
 * alone. `truncated` reports a scope that hit the ring capacity and lost
 * entries between the caller's cursor and the oldest retained id.
 * @param sessionKey - resolved session key the page is scoped to.
 * @param instanceId - resolved instance id, or undefined for every bound desktop.
 * @param since - exclusive ring-id cursor.
 * @param limit - maximum entries to return.
 * @returns the retained page: cursor, overflow flags, and entries in ascending id order.
 */
function readShellboxRingPage(
  sessionKey: string,
  instanceId: string | undefined,
  since: number,
  limit: number,
): { ringCursor: number; hasMore: boolean; truncated: boolean; entries: ShellboxRingEntry[] } {
  const scoped: ShellboxRingState[] = []
  if (instanceId !== undefined) {
    const ring = shellboxRings.get(instanceId)
    if (ring !== undefined) scoped.push(ring)
  } else {
    for (const rec of sharedManager?.boundInstances(sessionKey) ?? []) {
      const ring = shellboxRings.get(rec.id)
      if (ring !== undefined) scoped.push(ring)
    }
  }
  let ringCursor = 0
  let oldestRetained = 0
  let hitCapacity = false
  const matched: ShellboxRingEntry[] = []
  for (const ring of scoped) {
    if (ring.entries.length >= SHELLBOX_RING_CAPACITY) hitCapacity = true
    for (const entry of ring.entries) {
      if (entry.id > ringCursor) ringCursor = entry.id
      if (oldestRetained === 0 || entry.id < oldestRetained) oldestRetained = entry.id
      if (entry.id > since) matched.push(entry)
    }
  }
  matched.sort((a, b) => a.id - b.id)
  const hasMore = matched.length > limit
  const truncated = hitCapacity && oldestRetained !== 0 && since + 1 < oldestRetained
  return { ringCursor, hasMore, truncated, entries: hasMore ? matched.slice(0, limit) : matched }
}

/**
 * Assemble one changes read for a session: resolve the filtered desktops,
 * report whether any of them is running, and page the ring as a pure read that
 * advances no cursor.
 * @param manager - the session/instance manager holding the desktops.
 * @param session - requested session key.
 * @param instanceId - requested instance id, or undefined for every bound desktop.
 * @param since - exclusive ring-id cursor, already validated.
 * @param limit - page size, already validated.
 * @returns the ring page with its cursor and liveness metadata.
 */
function readShellboxChanges(
  manager: SandboxSessionManager,
  session: string,
  instanceId: string | undefined,
  since: number,
  limit: number,
): ShellboxChangesResponse {
  const sessionKey = session.trim() || 'default'
  const instance = instanceId === undefined || instanceId.trim() === '' ? undefined : instanceId.trim()
  let scoped: VirtualInstanceRecord[]
  if (instance === undefined) {
    scoped = manager.boundInstances(sessionKey)
  } else {
    const rec = manager.find(sessionKey, instance)
    scoped = rec === undefined ? [] : [rec]
  }
  if (scoped.length === 0) {
    return {
      ok: true,
      session: sessionKey,
      instanceId: instance ?? 'all',
      active: false,
      ringCursor: 0,
      since,
      limit,
      hasMore: false,
      truncated: false,
      changes: [],
    }
  }
  const page = readShellboxRingPage(sessionKey, instance, since, limit)
  return {
    ok: true,
    session: sessionKey,
    instanceId: instance ?? 'all',
    active: scoped.some(rec => rec.controller.isActive()),
    ringCursor: page.ringCursor,
    since,
    limit,
    hasMore: page.hasMore,
    truncated: page.truncated,
    changes: page.entries,
  }
}

/**
 * Parse and default the `since`/`limit` cursors of a changes read.
 * @param req - the GET request carrying the query.
 * @returns the cursors, or the first violation's message.
 */
function parseChangesPaging(req: IncomingMessage): { ok: true; since: number; limit: number } | { ok: false; error: string } {
  const params = queryParams(req)
  const sinceRaw = params.get('since')
  if (sinceRaw !== null && (!/^\d+$/u.test(sinceRaw) || !Number.isSafeInteger(Number(sinceRaw)))) {
    return { ok: false, error: 'since must be an integer of at least 0' }
  }
  const limitRaw = params.get('limit')
  if (limitRaw !== null) {
    if (!/^\d+$/u.test(limitRaw)) {
      return { ok: false, error: `limit must be an integer from 1 through ${String(CHANGES_MAX_LIMIT)}` }
    }
    const limit = Number(limitRaw)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANGES_MAX_LIMIT) {
      return { ok: false, error: `limit must be an integer from 1 through ${String(CHANGES_MAX_LIMIT)}` }
    }
  }
  return {
    ok: true,
    since: sinceRaw === null ? 0 : Number(sinceRaw),
    limit: limitRaw === null ? CHANGES_DEFAULT_LIMIT : Number(limitRaw),
  }
}

/**
 * Serve `GET /api/server/sandbox/windows` locally: the target desktop's
 * liveness plus its latest `.state` snapshot, with `fresh` true only while the
 * snapshot file is younger than {@link STATE_FRESH_MS}. An unknown session or
 * instance answers the documented empty success, never an error.
 * @param manager - the session/instance manager holding the desktops.
 * @param req - the GET request carrying `?session&instance&target`.
 * @returns status 200 with the window response, or 405 for another method.
 */
// oxlint-disable-next-line typescript/require-await -- the route surface answers promises, so a sync throw becomes a rejection
export async function handleSandboxWindowsLocal(
  manager: SandboxSessionManager,
  req: IncomingMessage,
): Promise<SandboxLocalResponse> {
  if (req.method !== 'GET') return { status: 405, body: refuse(405, 'method not allowed') }
  const record = manager.find(parseSessionParam(req), parseInstanceParam(req), parseTargetParam(req))
  if (record === undefined) {
    const empty: ShellboxWindowsResponse = { ok: true, active: false, fresh: false, windows: [] }
    return { status: 200, body: empty }
  }
  const state = readShellboxState(record)
  const body: ShellboxWindowsResponse = {
    ok: true,
    active: record.controller.isActive(),
    fresh: state !== undefined && state.ageMs < STATE_FRESH_MS,
    windows: state === undefined ? [] : state.snapshot.windows,
  }
  return { status: 200, body }
}

/**
 * Serve `POST /api/server/sandbox/input` locally: parse the body, then run
 * {@link deliverShellboxInput}'s status precedence unchanged.
 * @param manager - the session/instance manager holding the desktops.
 * @param req - the POST request; its query may also carry `session`/`instance`.
 * @param bodyText - the already-read request body.
 * @returns status with the `ShellboxInputResult` body.
 */
// oxlint-disable-next-line typescript/require-await -- the route surface answers promises, so a sync throw becomes a rejection
export async function handleSandboxInputLocal(
  manager: SandboxSessionManager,
  req: IncomingMessage,
  bodyText: string,
): Promise<SandboxLocalResponse> {
  if (req.method !== 'POST') return { status: 405, body: refuse(405, 'method not allowed') }
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return { status: 400, body: refuse(400, 'request body is not valid JSON') }
  }
  const session = bodyParam(payload, 'session') ?? parseSessionParam(req, payload)
  const instance = bodyParam(payload, 'instance') ?? parseInstanceParam(req, payload)
  const target = parseTargetParam(req, payload)
  const events = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).events
    : undefined
  const mode = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).mode
    : undefined
  const result = deliverShellboxInput(manager, session, instance, target, events, mode)
  return { status: result.ok ? 200 : result.status, body: result }
}

/**
 * Serve `POST /api/server/sandbox/uia` locally: parse the body, then await the
 * helper's bounded accessibility answer through {@link deliverShellboxUia}.
 * @param manager - the session/instance manager holding the desktops.
 * @param req - the POST request; its query may also carry `session`/`instance`.
 * @param bodyText - the already-read request body.
 * @returns status with the clamped tree or a refusal body.
 */
export async function handleSandboxUiaLocal(
  manager: SandboxSessionManager,
  req: IncomingMessage,
  bodyText: string,
): Promise<SandboxLocalResponse> {
  if (req.method !== 'POST') return { status: 405, body: refuse(405, 'method not allowed') }
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return { status: 400, body: refuse(400, 'request body is not valid JSON') }
  }
  const session = bodyParam(payload, 'session') ?? parseSessionParam(req, payload)
  const instance = bodyParam(payload, 'instance') ?? parseInstanceParam(req, payload)
  const target = parseTargetParam(req, payload)
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
  const result = await deliverShellboxUia(manager, session, instance, target, body?.hwnd, body?.maxNodes)
  return { status: result.ok ? 200 : result.status, body: result }
}

/**
 * Serve `POST /api/server/sandbox/windows/focus` and `.../windows/close`
 * locally: parse the body, then run {@link deliverShellboxWindowAction}.
 * @param manager - the session/instance manager holding the desktops.
 * @param req - the POST request; its query may also carry `session`/`instance`.
 * @param bodyText - the already-read request body.
 * @param action - which window command to spool for the helper.
 * @returns status with the action result or a refusal body.
 */
// oxlint-disable-next-line typescript/require-await -- the route surface answers promises, so a sync throw becomes a rejection
export async function handleSandboxWindowActionLocal(
  manager: SandboxSessionManager,
  req: IncomingMessage,
  bodyText: string,
  action: 'focus' | 'close',
): Promise<SandboxLocalResponse> {
  if (req.method !== 'POST') return { status: 405, body: refuse(405, 'method not allowed') }
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return { status: 400, body: refuse(400, 'request body is not valid JSON') }
  }
  const session = bodyParam(payload, 'session') ?? parseSessionParam(req, payload)
  const instance = bodyParam(payload, 'instance') ?? parseInstanceParam(req, payload)
  const target = parseTargetParam(req, payload)
  const hwnd = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).hwnd
    : undefined
  const result = deliverShellboxWindowAction(manager, session, instance, target, action, hwnd)
  return { status: result.ok ? 200 : result.status, body: result }
}

/**
 * Serve `GET /api/server/sandbox/changes` locally: validate the paging cursors,
 * then answer {@link readShellboxChanges}' pure ring page — no cursor of any
 * kind advances here.
 * @param manager - the session/instance manager holding the desktops.
 * @param req - the GET request carrying `?session&instance&since&limit`.
 * @returns status with the ring page, a 400 paging violation, or a 405.
 */
// oxlint-disable-next-line typescript/require-await -- the route surface answers promises, so a sync throw becomes a rejection
export async function handleSandboxChangesLocal(
  manager: SandboxSessionManager,
  req: IncomingMessage,
): Promise<SandboxLocalResponse> {
  if (req.method !== 'GET') return { status: 405, body: refuse(405, 'method not allowed') }
  const paging = parseChangesPaging(req)
  if (!paging.ok) return { status: 400, body: refuse(400, paging.error) }
  const body = readShellboxChanges(manager, parseSessionParam(req) ?? '', parseInstanceParam(req), paging.since, paging.limit)
  return { status: 200, body }
}

/** Options the sandbox route mount takes from its plugin config. */
export interface SandboxRouteOptions {
  /** Transport the bridge reaches the daemon with; `deamon.transport` in a composition. */
  transport?: DeamonTransport | undefined
}

/**
 * Register the sandbox-view routes on the Web server: `GET /stream`,
 * `POST /size`, `POST /launch`, `POST /stop`, and `GET /status`, plus the
 * `WS /ws` upgrade that carries the stream as binary frame messages and the
 * input, window, and change-awareness surface — `POST /input`,
 * `GET /windows`, `POST /windows/focus`, `POST /windows/close`, and
 * `GET /changes`. All registrations support multi-session via `?session=<id>`
 * query parameter or `sessionId` in the JSON request body (the new routes also
 * accept a body `session`/`instance`), and every entry marks its session as
 * Shellbox-touched for the pre-step change pull.
 * @param ctx - plugin context carrying the webServer service.
 * @param options - mount options; the transport selects how the bridge reaches
 * the daemon (`pipe`, the default, or the legacy `http` path).
 */
export function registerSandboxRoutes(ctx: Context, options?: SandboxRouteOptions): void {
  internals.transport = options?.transport ?? 'pipe'
  const daemonManager = getDeamonManager(ctx.logger('deamon'))
  const manager = sharedManager ??= new SandboxSessionManager(ctx.logger('deamon'))

  ctx.effect(() => () => {
    if (sharedDaemonManager !== undefined) {
      void sharedDaemonManager.stop()
      sharedDaemonManager = undefined
    }
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/stream',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      markShellboxTouched(resolveRequestSession(req))
      if (internals.useDaemon) {
        try {
          await daemonManager.ensureRunning()
        } catch (err: unknown) {
          respondJson(res, 503, {
            ok: false,
            error: `Deamon unavailable: ${String(err)}`,
            starting: true,
          })
          return
        }
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').search
        let source: DaemonStream
        try {
          // The daemon's frame feed arrives as one byte stream whichever
          // transport carried it, so the multipart body below is unchanged.
          source = await daemonManager.openStream(`/stream${query}`)
        } catch (err: unknown) {
          respondJson(res, 502, {
            ok: false,
            error: `Failed to stream from daemon: ${String(err)}`,
          })
          return
        }
        // The viewer can go away while the daemon answers (a reconnect
        // abandons the previous image request). Writing headers to a
        // dead response throws outside any try, which is an uncaught
        // exception that takes the whole web server down with it.
        try {
          res.writeHead(source.statusCode, {
            ...source.headers,
            'cache-control': 'no-store, no-cache, must-revalidate',
            'access-control-allow-origin': '*',
          })
        } catch {
          /* v8 ignore next -- only the socket-death order production observed throws this write; a spec teardown cannot stage it. */
          source.destroy()
          /* v8 ignore next -- a failed header write must not fall through to the pipe; same unstageable throw. */
          return
        }
        // A daemon that dies mid-stream errors its response. `pipe` does
        // not forward that, and an unhandled response error is an uncaught
        // exception that takes the whole web server down with it.
        source.on('error', () => { res.destroy() })
        source.pipe(res)
        res.on('close', () => {
          source.destroy()
        })
        return
      }
      const sessionId = parseSessionParam(req)
      const instanceId = parseInstanceParam(req)
      const target = parseTargetParam(req)
      const fps = parseFpsParam(req)
      const controller = manager.get(sessionId, instanceId, target)
      if (fps !== undefined) {
        controller.setFps(fps)
      }
      controller.stream(res)
    },
  }), 'deamon: GET /api/server/sandbox/stream')

  ctx.inject(['connection', 'webServer'], (wsCtx) => {
    wsCtx.effect(() => {
      const wss = new WebSocketServer({ noServer: true })
      const route: WebUpgradeRoute = {
        path: STREAM_WS_PATH,
        handler: (req, socket, head) => {
          const rejection = wsCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            rejectUpgrade(socket, rejection)
            return
          }
          markShellboxTouched(resolveRequestSession(req))
          wss.handleUpgrade(req, socket, head, (ws) => {
            void serveSandboxFrames(ws, req, daemonManager, manager)
          })
        },
      }
      const unregister = wsCtx.webServer.registerUpgrade(route)
      return () => {
        unregister()
        for (const client of wss.clients) client.terminate()
        wss.close()
      }
    }, 'deamon: WS /api/server/sandbox/ws')
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/fps',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/fps')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const fps = parseFpsParam(req, payload)
      if (fps === undefined) {
        respondJson(res, 400, { ok: false, error: 'fps must be an integer between 1 and 60' })
        return
      }
      const sessionId = parseSessionParam(req, payload)
      const instanceId = parseInstanceParam(req, payload)
      const target = parseTargetParam(req, payload)
      const controller = manager.get(sessionId, instanceId, target)
      const updated = controller.setFps(fps)
      respondJson(res, 200, { ok: true, fps, updated })
    },
  }), 'deamon: POST /api/server/sandbox/fps')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      markShellboxTouched(resolveRequestSession(req))
      if (internals.useDaemon) {
        const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
        await daemonManager.forwardJson(req, res, `/status${query}`)
        return
      }
      const sessionId = parseSessionParam(req)
      const instanceId = parseInstanceParam(req)
      const target = parseTargetParam(req)
      const controller = manager.get(sessionId, instanceId, target)
      respondJson(res, 200, {
        ok: true,
        session: sessionId ?? 'default',
        instanceId,
        target,
        active: controller.isActive(),
        desktop: controller.desktop,
        fps: controller.getMeasuredFps(),
        targetFps: controller.getFps(),
      })
    },
  }), 'deamon: GET /api/server/sandbox/status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/instances',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
        await daemonManager.forwardJson(req, res, `/instances${query}`)
        return
      }
      const sessionId = parseSessionParam(req)
      const list = manager.listInstances()
      respondJson(res, 200, {
        ok: true,
        session: sessionId ?? 'default',
        instances: list,
      })
    },
  }), 'deamon: GET /api/server/sandbox/instances')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/instances/create',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/instances/create')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
      const sessionId = parseSessionParam(req, payload) || 'default'
      const rawType = typeof rec.type === 'string' ? rec.type : undefined
      const type = rawType === 'hyperv' ? 'hyperv' : rawType === 'wsl-ubuntu' ? 'wsl-ubuntu' : 'win32'
      const vmName = typeof rec.vmName === 'string' ? rec.vmName : undefined
      const instance = manager.createInstance({ sessionId, type, vmName })
      respondJson(res, 200, {
        ok: true,
        instance: {
          id: instance.id,
          name: instance.name,
          type: instance.type,
          desktopName: instance.desktopName,
          vmName: instance.vmName,
          ownerSessionId: instance.ownerSessionId,
          boundSessionIds: instance.boundSessionIds,
          active: instance.controller.isActive(),
          createdAt: instance.createdAt,
        },
      })
    },
  }), 'deamon: POST /api/server/sandbox/instances/create')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/instances/attach',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/instances/attach')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
      const targetSessionId = typeof rec.targetSessionId === 'string' ? rec.targetSessionId : undefined
      const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
      if (targetSessionId === undefined || instanceId === undefined) {
        respondJson(res, 400, { ok: false, error: 'targetSessionId and instanceId are required' })
        return
      }
      const attached = manager.attachInstance(targetSessionId, instanceId)
      if (!attached) {
        respondJson(res, 404, { ok: false, error: `instance "${instanceId}" not found` })
        return
      }
      respondJson(res, 200, { ok: true, attached: true, instanceId, targetSessionId })
    },
  }), 'deamon: POST /api/server/sandbox/instances/attach')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/instances/detach',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/instances/detach')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
      const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : undefined
      const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
      if (sessionId === undefined || instanceId === undefined) {
        respondJson(res, 400, { ok: false, error: 'sessionId and instanceId are required' })
        return
      }
      const detached = manager.detachInstance(sessionId, instanceId)
      respondJson(res, 200, { ok: true, detached, instanceId, sessionId })
    },
  }), 'deamon: POST /api/server/sandbox/instances/detach')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/instances/terminate',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/instances/terminate')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const rec = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
      const instanceId = typeof rec.instanceId === 'string' ? rec.instanceId : undefined
      if (instanceId === undefined) {
        respondJson(res, 400, { ok: false, error: 'instanceId is required' })
        return
      }
      const terminated = await manager.terminateInstance(instanceId)
      respondJson(res, 200, { ok: true, terminated, instanceId })
    },
  }), 'deamon: POST /api/server/sandbox/instances/terminate')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/size',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/size')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
        return
      }
      const viewport = parseViewport(payload)
      if (viewport === undefined) {
        respondJson(res, 400, {
          ok: false,
          error: `width and height must be integers from 1 through ${String(MAX_VIEWPORT)}`,
        })
        return
      }
      const sessionId = parseSessionParam(req, payload)
      const instanceId = parseInstanceParam(req, payload)
      const target = parseTargetParam(req, payload)
      const controller = manager.get(sessionId, instanceId, target)
      if (!controller.setViewport(viewport.width, viewport.height)) {
        respondJson(res, 409, { ok: false, error: 'sandbox helper is not running' })
        return
      }
      const response: Record<string, unknown> = { ok: true, width: viewport.width, height: viewport.height }
      if (sessionId !== undefined) response.session = sessionId
      if (instanceId !== undefined) response.instanceId = instanceId
      if (target !== undefined) response.target = target
      respondJson(res, 200, response)
    },
  }), 'deamon: POST /api/server/sandbox/size')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/input',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let raw: string | undefined
      try {
        raw = await readBody(req)
      } catch {
        // A destroyed request body carries no session; it reaches the local
        // handler as text that cannot parse, or the bridge as its own 400.
        raw = undefined
      }
      markShellboxTouched(resolveRequestSession(req, raw))
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/input', raw)
        return
      }
      const result = await handleSandboxInputLocal(manager, req, raw ?? '')
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: POST /api/server/sandbox/input')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/uia',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let raw: string | undefined
      try {
        raw = await readBody(req)
      } catch {
        // A destroyed request body carries no session; it reaches the local
        // handler as text that cannot parse, or the bridge as its own 400.
        raw = undefined
      }
      markShellboxTouched(resolveRequestSession(req, raw))
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/uia', raw)
        return
      }
      const result = await handleSandboxUiaLocal(manager, req, raw ?? '')
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: POST /api/server/sandbox/uia')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/windows',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      markShellboxTouched(resolveRequestSession(req))
      if (internals.useDaemon) {
        const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
        await daemonManager.forwardJson(req, res, `/windows${query}`)
        return
      }
      const result = await handleSandboxWindowsLocal(manager, req)
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: GET /api/server/sandbox/windows')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/windows/focus',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let raw: string | undefined
      try {
        raw = await readBody(req)
      } catch {
        // A destroyed request body carries no session; it reaches the local
        // handler as text that cannot parse, or the bridge as its own 400.
        raw = undefined
      }
      markShellboxTouched(resolveRequestSession(req, raw))
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/windows/focus', raw)
        return
      }
      const result = await handleSandboxWindowActionLocal(manager, req, raw ?? '', 'focus')
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: POST /api/server/sandbox/windows/focus')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/windows/close',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      let raw: string | undefined
      try {
        raw = await readBody(req)
      } catch {
        // A destroyed request body carries no session; it reaches the local
        // handler as text that cannot parse, or the bridge as its own 400.
        raw = undefined
      }
      markShellboxTouched(resolveRequestSession(req, raw))
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/windows/close', raw)
        return
      }
      const result = await handleSandboxWindowActionLocal(manager, req, raw ?? '', 'close')
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: POST /api/server/sandbox/windows/close')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/changes',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      markShellboxTouched(resolveRequestSession(req))
      if (internals.useDaemon) {
        const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
        await daemonManager.forwardJson(req, res, `/changes${query}`)
        return
      }
      const result = await handleSandboxChangesLocal(manager, req)
      respondJson(res, result.status, result.body)
    },
  }), 'deamon: GET /api/server/sandbox/changes')

  const handleLaunch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end('Method Not Allowed')
      return
    }
    let raw: string | undefined
    try {
      raw = await readBody(req)
    } catch {
      // A destroyed request body carries no session and cannot parse as JSON;
      // the daemon bridge re-reads it to answer with its own read failure.
      raw = undefined
    }
    markShellboxTouched(resolveRequestSession(req, raw))
    if (internals.useDaemon) {
      await daemonManager.forwardJson(req, res, '/launch', raw)
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw ?? '')
    } catch {
      respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' })
      return
    }
    if (
      typeof payload !== 'object'
      || payload === null
      || typeof (payload as { command?: unknown }).command !== 'string'
      || (payload as { command: string }).command.trim() === ''
    ) {
      respondJson(res, 400, { ok: false, error: 'command must be a non-empty string' })
      return
    }
    const rawCommand = (payload as { command: string }).command.trim()
    const sessionId = parseSessionParam(req, payload)
    const instanceId = parseInstanceParam(req, payload)
    const target = parseTargetParam(req, payload)
    const controller = manager.get(sessionId, instanceId, target)
    const command = resolveLaunchCommand(rawCommand, controller.desktop)
    if (!controller.launch(command)) {
      respondJson(res, 500, { ok: false, error: 'could not launch command on Shellbox desktop' })
      return
    }
    const response: Record<string, unknown> = { ok: true, command }
    if (sessionId !== undefined) {
      response.session = sessionId
      response.desktop = controller.desktop
    }
    if (instanceId !== undefined) {
      response.instanceId = instanceId
    }
    if (target !== undefined) {
      response.target = target
    }
    respondJson(res, 200, response)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/launch',
    handler: handleLaunch,
  }), 'deamon: POST /api/server/sandbox/launch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/shellbox/launch',
    handler: handleLaunch,
  }), 'deamon: POST /api/server/shellbox/launch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/sandbox/stop',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      if (internals.useDaemon) {
        await daemonManager.forwardJson(req, res, '/stop')
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        // Body optional
      }
      const instanceId = parseInstanceParam(req, payload)
      if (instanceId !== undefined) {
        const stopped = await manager.terminateInstance(instanceId)
        respondJson(res, 200, { ok: true, stopped, instanceId })
        return
      }
      const sessionId = parseSessionParam(req, payload)
      const stopped = await manager.stop(sessionId)
      const response: Record<string, unknown> = { ok: true, stopped }
      if (sessionId !== undefined) response.session = sessionId
      respondJson(res, 200, response)
    },
  }), 'deamon: POST /api/server/sandbox/stop')

  // Fill the change-awareness seam: tools and the pre-step pull reach the same
  // desktops the routes serve — through the daemon's HTTP surface in isolated
  // mode, and through the in-process manager otherwise. Registering it here
  // means `shellboxChangeSource()` never answers unregistered once the plugin
  // mounted, in either mode.
  setShellboxChangeSource({
    async readChanges(session, instanceId, since, limit) {
      if (internals.useDaemon) {
        const filters = `session=${encodeURIComponent(session)}`
          + (instanceId === undefined ? '' : `&instance=${encodeURIComponent(instanceId)}`)
        return await daemonManager.fetchJson<ShellboxChangesResponse>(
          `/changes?${filters}&since=${String(since)}&limit=${String(limit)}`,
        )
      }
      return readShellboxChanges(manager, session, instanceId, since, limit)
    },
    async postInput(session, instanceId, events) {
      if (internals.useDaemon) {
        return await daemonManager.fetchJson<ShellboxInputResult>('/input', {
          method: 'POST',
          body: { session, instance: instanceId, events },
        })
      }
      // The model-facing seam predates the mode field: its batches stay on the
      // default post path, and `undefined` parses to exactly that.
      return deliverShellboxInput(manager, session, instanceId, undefined, events, undefined)
    },
  })

  registerShellboxTool(ctx, manager)
}

/**
 * Register the model-facing `shellbox_launch` tool when the `tools` service is present.
 * @param ctx - plugin context.
 * @param manager - the shared SandboxSessionManager instance.
 */
export function registerShellboxTool(ctx: Context, manager: SandboxSessionManager): void {
  const daemonManager = getDeamonManager(ctx.logger('deamon'))
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'shellbox_launch',
      description: 'Launch a GUI application on the isolated DSH Shellbox desktop (viewable live in the Shellbox tab in the right sidebar). '
        + 'Use this when you want to run an application (e.g. browser, editor, viewer, test script GUI) on the private desktop without cluttering the user\'s screen. '
        + 'IMPORTANT: The isolated Win32 desktop does NOT support hardware GPU acceleration (OpenGL/Vulkan/DirectX). Do NOT launch hardware-accelerated 3D applications or Android emulators with hardware GPU (-gpu host); use software rendering (e.g. -gpu swiftshader) or headless/CLI tools.',
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'Application executable and optional arguments to run on the Shellbox desktop (e.g. "notepad.exe", "calc.exe", "msedge.exe https://example.com").',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session ID to target a specific session\'s isolated desktop. Defaults to the current session.',
        },
        instanceId: {
          type: 'string',
          description: 'Optional instance ID to target a specific virtual desktop instance.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            command: { type: 'string', required: true },
            message: { type: 'string', required: true },
            desktop: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `[Shellbox] Uygulama başlatıldı: ${value.command}${value.desktop ? ` (${value.desktop})` : ''}. Sağ kenar çubuğundaki Shellbox sekmesinden canlı izleyebilirsiniz.`
            : `[Shellbox] Başlatılamadı: ${value.message}`,
        }],
      },
      execute: async (args) => {
        const rawCmd = typeof args.command === 'string' ? args.command : ''
        const sess = typeof args.sessionId === 'string' ? args.sessionId : undefined
        const inst = typeof args.instanceId === 'string' ? args.instanceId : undefined
        // The launch names a Shellbox desktop: arm its pre-step change pull now,
        // regardless of which delivery mode the launch itself takes below.
        markShellboxTouched(sess ?? 'default')
        if (process.platform !== 'win32') {
          return {
            ok: false,
            command: rawCmd,
            desktop: '',
            message: 'Shellbox izole masaüstü özelliği yalnızca Windows ortamında desteklenir.',
          }
        }
        if (internals.useDaemon) {
          try {
            const res = await daemonManager.fetchJson<{ ok: boolean; command: string; desktop: string }>(
              '/launch',
              {
                method: 'POST',
                body: { command: rawCmd, sessionId: sess, instanceId: inst },
              },
            )
            return {
              ok: res.ok,
              command: res.command,
              desktop: res.desktop,
              message: `Komut Shellbox masaüstüne (${res.desktop}) iletildi ve başlatıldı.`,
            }
          } catch (err: unknown) {
            return {
              ok: false,
              command: rawCmd,
              desktop: '',
              message: `Shellbox servisine ulaşılamadı: ${String(err)}`,
            }
          }
        }
        const targetSession = sess ?? 'default'
        const controller = manager.get(targetSession, inst)
        const cmd = resolveLaunchCommand(rawCmd, controller.desktop)
        const success = controller.launch(cmd)
        if (!success) {
          return {
            ok: false,
            command: cmd,
            desktop: controller.desktop,
            message: 'Shellbox yardımcı süreci başlatılamadı veya komut iletilemedi.',
          }
        }
        return {
          ok: true,
          command: cmd,
          desktop: controller.desktop,
          message: `Komut Shellbox masaüstüne (${controller.desktop}) iletildi ve başlatıldı.`,
        }
      },
    })), 'deamon: shellbox_launch tool')
  })
}
