/**
 * @deepseek-ai/dsh-web-app — the server log file and its tail API.
 *
 * The Web host otherwise logs only to its own console, which a headless
 * launch (a `.bat` without a visible terminal, a service wrapper) hides.
 * This installs a write-through file tee over the process console streams so
 * every line the server prints — agent loops, child-service relays,
 * uncaught exceptions — also lands in `$DSH_HOME/logs/dsh-web.log`, and
 * serves the file's tail at `GET /api/server/logs` so the settings surface
 * can show it. The file outlives the process, which is what makes a crash
 * diagnosable after a restart.
 *
 * The same file carries the process's death evidence: the exit witness
 * appends `stopping code=<code> uptime=<seconds>s` on any Node-driven stop,
 * and the alive tick prints `alive uptime=<seconds>s` once a minute. A force
 * kill runs no exit listener, so log silence next to a vanished process with
 * no stopping line is the external-kill signature, while silence beside a
 * still-running process is a hang.
 *
 * @module @deepseek-ai/dsh-web-app/server-log
 */

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** Answer a request with JSON. */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Log directory under the DSH home. */
const LOG_DIR_NAME = 'logs'

/** Live log file name. */
const LOG_FILE_NAME = 'dsh-web.log'

/** Single backup the live file rotates into. */
const LOG_BACKUP_NAME = 'dsh-web.log.1'

/** Live file size that triggers a rotation, in bytes. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Default tail length served per request, in lines. */
const DEFAULT_TAIL_LINES = 300

/** Largest tail length a request may ask for, in lines. */
const MAX_TAIL_LINES = 2000

/** Largest byte window read from the file's end per request. */
const MAX_TAIL_BYTES = 512 * 1024

/**
 * Directory holding the server log file.
 * @returns the resolved log directory.
 */
export function getServerLogDir(): string {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, LOG_DIR_NAME)
}

/**
 * Path of the live server log file.
 * @returns the live log file path.
 */
export function getServerLogPath(): string {
  return join(getServerLogDir(), LOG_FILE_NAME)
}

/** Process-wide tee state. One writer per process; the file is append-only. */
let teePath: string | undefined
let teeBytes = 0
let teeBroken = false
let originalStdoutWrite: typeof process.stdout.write | undefined
let originalStderrWrite: typeof process.stderr.write | undefined

/** The one exit listener this module registered, if any. */
let exitWitness: ((code: number) => void) | undefined

/** Test seams. Specs reset the tee between cases, point it at a temp file, and fire the exit witness without exiting the worker. */
export const serverLogInternals = {
  /** Release the patched streams, unregister the exit witness, and forget installed state. */
  reset: (): void => {
    if (exitWitness !== undefined) {
      process.off('exit', exitWitness)
      exitWitness = undefined
    }
    if (originalStdoutWrite !== undefined) {
      process.stdout.write = originalStdoutWrite
      originalStdoutWrite = undefined
    }
    if (originalStderrWrite !== undefined) {
      process.stderr.write = originalStderrWrite
      originalStderrWrite = undefined
    }
    teePath = undefined
    teeBytes = 0
    teeBroken = false
  },
  /** Run the registered exit witness; without one the call does nothing. */
  emitExit: (code: number): void => {
    exitWitness?.(code)
  },
}

/** Convert one console chunk into the text the file receives. */
function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf-8')
  return String(chunk)
}

/** Append text to the log file, rotating past the cap. Shared by the console tee and the logger exporter. */
function appendToFile(text: string): void {
  const path = teePath
  if (path === undefined || teeBroken) return
  try {
    const incoming = Buffer.byteLength(text, 'utf-8')
    if (teeBytes + incoming > MAX_LOG_BYTES) {
      renameSync(path, join(dirname(path), LOG_BACKUP_NAME))
      teeBytes = 0
    }
    appendFileSync(path, text, 'utf-8')
    teeBytes += incoming
  } catch {
    // A dead disk must never take the server down with it: stop teeing.
    teeBroken = true
  }
}

/** Append one console chunk to the log file. */
function teeChunk(chunk: unknown): void {
  appendToFile(chunkToText(chunk))
}

/** One structured logger record rendered as a log file line. */
function formatLogMessage(message: { ts: number; name: string; type: string; args: unknown[] }): string {
  const parts = message.args.map((arg) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.stack ?? arg.message
    try {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- JSON.stringify is undefined for an undefined argument.
      return JSON.stringify(arg) ?? String(arg)
    } catch {
      return String(arg)
    }
  })
  return `[${new Date(message.ts).toISOString()}] [${message.name}] [${message.type}] ${parts.join(' ')}`
}

/**
 * Install the write-through file tee over the process console streams.
 * Idempotent per process: a second call returns the installed path.
 * @param logPath - log file path. Defaults to the DSH home log file.
 * @returns the installed log path, or undefined when it cannot be created.
 */
export function installServerLogTee(logPath: string = getServerLogPath()): string | undefined {
  if (teePath !== undefined) return teePath
  try {
    mkdirSync(dirname(logPath), { recursive: true })
  } catch {
    return undefined
  }
  try {
    const size = statSync(logPath).size
    if (size > MAX_LOG_BYTES) {
      renameSync(logPath, join(dirname(logPath), LOG_BACKUP_NAME))
      teeBytes = 0
    } else {
      teeBytes = size
    }
  } catch {
    // A missing file starts empty.
    teeBytes = 0
  }
  teePath = logPath
  originalStdoutWrite = process.stdout.write.bind(process.stdout)
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown, ...args: unknown[]): boolean => {
    teeChunk(chunk)
    return (stdoutWrite as (...callArgs: unknown[]) => boolean)(chunk, ...args)
  })
  process.stderr.write = ((chunk: unknown, ...args: unknown[]): boolean => {
    teeChunk(chunk)
    return (stderrWrite as (...callArgs: unknown[]) => boolean)(chunk, ...args)
  })
  return teePath
}

/**
 * Mirror every structured logger record into the log file. The console tee
 * alone misses them: `ctx.logger` dispatches to exporters, and the web
 * composition registers no console exporter, so logger traffic never reaches
 * the process streams.
 * @param ctx - plugin context carrying the logger service.
 * @returns the exporter's disposer.
 */
export function installLoggerExporter(ctx: Context): ReturnType<Context['logger']['exporter']> {
  return ctx.logger.exporter({
    export: (message): void => {
      appendToFile(`${formatLogMessage(message)}\n`)
    },
  })
}

/** Alive line cadence: the death-signature table reads a 60-second gap, so this is a protocol constant, not a deployment choice. */
export const ALIVE_TICK_MS = 60_000

/**
 * Append `stopping code=<code> uptime=<seconds>s` on any Node-driven exit,
 * synchronously, while exit listeners still run. A force kill runs no exit
 * listener, so the line's absence beside a fresh process start is the
 * external-kill signature. Writes through the installed tee (callers install
 * it first); registers one listener per process, a second call is a no-op.
 */
export function installExitWitness(): void {
  if (exitWitness !== undefined) return
  exitWitness = (code) => {
    appendToFile(`[${new Date().toISOString()}] [web-app] [info] stopping code=${code} uptime=${Math.round(process.uptime())}s\n`)
  }
  process.on('exit', exitWitness)
}

/**
 * Start the alive tick: `write` runs once per interval on a timer that never
 * holds the event loop open, so a healthy server prints a line per minute
 * while a wedged one shows a gap beside a still-running process.
 * @param write - emits one alive line; the Web plugin routes it through `ctx.logger`.
 * @param intervalMs - cadence; specs pass a short interval.
 * @returns the disposer that stops the tick.
 */
export function startAliveTick(write: () => void, intervalMs: number = ALIVE_TICK_MS): () => void {
  const timer = setInterval(write, intervalMs)
  timer.unref()
  return () => { clearInterval(timer) }
}

/**
 * Read the file's tail window as lines, newest last.
 * @param logPath - log file path. Defaults to the DSH home log file.
 * @param maxLines - maximum lines returned. Clamped to the request cap.
 * @returns the tail lines and whether older content exists above them.
 */
export function readServerLogTail(
  logPath: string = getServerLogPath(),
  maxLines: number = DEFAULT_TAIL_LINES,
): { lines: string[]; truncated: boolean } {
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.min(Math.floor(maxLines), MAX_TAIL_LINES) : DEFAULT_TAIL_LINES
  let fd: number | undefined
  try {
    fd = openSync(logPath, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - MAX_TAIL_BYTES)
    const window = Buffer.alloc(size - start)
    readSync(fd, window, 0, window.length, start)
    let lines = window.toString('utf-8').split(/\r?\n/u)
    if (start > 0) lines = lines.slice(1)
    if (lines[lines.length - 1] === '') lines.pop()
    const over = lines.length > limit
    if (over) lines = lines.slice(-limit)
    return { lines, truncated: start > 0 || over }
  } catch {
    // A missing or unreadable file reads as an empty log.
    return { lines: [], truncated: false }
  } finally {
    if (fd !== undefined) {
      /* v8 ignore next -- closeSync on a descriptor this call just read cannot fail short of descriptor-table exhaustion */
      try {
        closeSync(fd)
      } catch {
        // The read already settled; a close failure carries no signal.
      }
    }
  }
}

/**
 * Truncate the live log file.
 * @param logPath - log file path. Defaults to the DSH home log file.
 * @returns true when the file was truncated.
 */
export function clearServerLog(logPath: string = getServerLogPath()): boolean {
  try {
    truncateSync(logPath, 0)
    teeBytes = 0
    return true
  } catch {
    return false
  }
}

/**
 * Register the server log tail routes on the Web server: `GET /logs` and
 * `POST /logs/clear`.
 * @param ctx - plugin context carrying the webServer service.
 */
export function registerServerLogRoutes(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/logs',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end('Method Not Allowed')
        return
      }
      let limit = DEFAULT_TAIL_LINES
      try {
        const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')
        if (raw !== null) {
          const parsed = Number(raw)
          if (Number.isFinite(parsed) && parsed > 0) limit = parsed
        }
      } catch {
        // An unparseable URL still serves the default tail.
      }
      const { lines, truncated } = readServerLogTail(getServerLogPath(), limit)
      respondJson(res, 200, { ok: true, lines, truncated })
    },
  }), 'web-app: GET /api/server/logs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/server/logs/clear',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end('Method Not Allowed')
        return
      }
      respondJson(res, 200, { ok: true, cleared: clearServerLog(getServerLogPath()) })
    },
  }), 'web-app: POST /api/server/logs/clear')
}
