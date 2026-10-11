/**
 * Plan 10 §5.4 — browser download tracking.
 *
 * The manager subscribes to both the `Browser.download*` and the legacy
 * `Page.download*` event spellings (the plan's 500 ms feature-detect is
 * replaced by an immediate dual subscribe — behaviorally equivalent, but no
 * window in which events are missed). Chromium is switched to
 * `allowAndName`, so files land under their GUID; the manager renames them to
 * the suggested filename (auto mode) or an explicit `renameTo` (hard error
 * when that name already exists).
 */

import { existsSync } from 'node:fs'
import { copyFile, rename, stat, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  nextFreeBasename,
  resolveInsideRoot,
  validateBasename,
} from './downloads-dir.ts'

/** The narrow connection face the manager needs (browser-level CDP). */
export interface DownloadConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  on(event: string, listener: (params: Record<string, unknown>) => void): () => void
}

/** Lifecycle of one observed download. */
export type DownloadState = 'in-progress' | 'completed' | 'canceled' | 'timeout'

/** One tracked download. */
export interface DownloadRecord {
  guid: string
  url: string
  suggestedFilename: string
  receivedBytes: number
  totalBytes: number | undefined
  state: DownloadState
  /** Final location, relative to the downloads root (set on completion). */
  path: string | undefined
  /** Hard error of the finalization step, if any. */
  error: string | undefined
}

/** Options for one arm (wait-for-download) round. */
export interface ArmOptions {
  /** Wall-clock budget; default 60 s. */
  timeoutMs?: number | undefined
  /** Explicit destination basename; must be free or the arm fails hard. */
  renameTo?: string | undefined
}

/** Result of one arm round. */
export interface ArmOutcome {
  ok: boolean
  state: DownloadState
  guid: string
  suggestedFilename: string
  /** Final file path relative to the downloads root. */
  path: string | undefined
  bytes: number
  error: string | undefined
}

interface ArmWaiter {
  resolve: (outcome: ArmOutcome) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  renameTo: string | undefined
}

const EVENT_NAMES = [
  'Browser.downloadWillBegin',
  'Browser.downloadProgress',
  'Page.downloadWillBegin',
  'Page.downloadProgress',
] as const

/** Move `src` to `dest`, retrying Windows EPERM and falling back to copy. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw error
  }
  // Windows AV/indexer can hold the file briefly: retry once after 50 ms.
  await new Promise(resolve => setTimeout(resolve, 50))
  try {
    await rename(src, dest)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw error
  }
  await copyFile(src, dest)
  await unlink(src).catch(() => undefined)
}

/** True when the path exists (sync probe for the rename suffix loop). */
function exists(path: string): boolean {
  return existsSync(path)
}

/** Existence probe with promises (kept separate for clarity). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Tracks Chromium downloads for one root directory and resolves one wait at
 * a time. Create one per service; call {@link DownloadManager.dispose} on
 * teardown so listeners and timers do not outlive the connection.
 */
export class DownloadManager {
  private readonly records = new Map<string, DownloadRecord>()
  private readonly disposers: Array<() => void> = []
  private waiter: ArmWaiter | undefined
  private behaviorPromise: Promise<void> | undefined
  private disposed = false

  /**
   * @param connection - browser-level CDP connection.
   * @param root - absolute downloads root directory.
   */
  constructor(
    private readonly connection: DownloadConnection,
    private readonly root: string,
  ) {
    for (const event of EVENT_NAMES) {
      this.disposers.push(connection.on(event, params => this.onEvent(event, params)))
    }
  }

  /**
   * Every tracked download, newest first.
   * @returns a snapshot copy of the tracked records, ordered newest first.
   */
  status(): DownloadRecord[] {
    return [...this.records.values()].reverse()
  }

  /**
   * One record by GUID.
   * @param guid - the browser-assigned download GUID from the events.
   * @returns the tracked record, or undefined when the GUID is unknown.
   */
  record(guid: string): DownloadRecord | undefined {
    return this.records.get(guid)
  }

  /**
   * plan10 REST `action=configure`: arm `Browser.setDownloadBehavior` without
   * waiting for a download (cached; `arm` reuses it).
   * @returns when the browser acknowledged the behavior.
   */
  async configure(): Promise<void> {
    if (this.disposed) throw new Error('cdp: download: manager disposed')
    await this.ensureBehavior()
  }

  /**
   * Arm browser download behavior and wait for the next download to settle.
   * @param options - timeout and optional explicit rename target.
   * @returns the settled outcome.
   * @throws Error on double-arm, disposal, or a start timeout.
   */
  async arm(options: ArmOptions = {}): Promise<ArmOutcome> {
    if (this.disposed) throw new Error('cdp: download: manager disposed')
    if (this.waiter !== undefined) throw new Error('cdp: download: another download wait is already active')
    await this.ensureBehavior()

    const timeoutMs = options.timeoutMs ?? 60_000
    if (options.renameTo !== undefined) validateBasename(options.renameTo)

    return new Promise<ArmOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        reject(new Error(`cdp: download: no download began within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = { resolve, reject, timer, renameTo: options.renameTo }
    })
  }

  /** Stop listening and fail any pending wait; idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.waiter !== undefined) {
      clearTimeout(this.waiter.timer)
      this.waiter.reject(new Error('cdp: download: interrupted — the service stopped'))
      this.waiter = undefined
    }
    for (const disposer of this.disposers.splice(0)) disposer()
    this.behaviorPromise = undefined
  }

  // -- events ---------------------------------------------------------------

  private onEvent(event: string, params: Record<string, unknown>): void {
    if (event.endsWith('downloadWillBegin')) {
      const guid = typeof params['guid'] === 'string' ? params['guid'] : ''
      if (guid === '') return
      this.records.set(guid, {
        guid,
        url: typeof params['url'] === 'string' ? params['url'] : '',
        suggestedFilename: typeof params['suggestedFilename'] === 'string' ? params['suggestedFilename'] : '',
        receivedBytes: 0,
        totalBytes: undefined,
        state: 'in-progress',
        path: undefined,
        error: undefined,
      })
      return
    }
    const guid = typeof params['guid'] === 'string' ? params['guid'] : ''
    const record = this.records.get(guid)
    if (record === undefined) return
    if (typeof params['receivedBytes'] === 'number') {
      record.receivedBytes = Math.max(record.receivedBytes, params['receivedBytes']) // monotonic
    }
    if (typeof params['totalBytes'] === 'number') record.totalBytes = params['totalBytes']
    const state = typeof params['state'] === 'string' ? params['state'] : ''
    if (state === 'completed') {
      void this.finalize(record, 'completed')
    } else if (state === 'canceled') {
      record.state = 'canceled'
      record.error = `cdp: download: canceled: ${guid}`
      this.settle(record)
    }
  }

  /** Rename the GUID file into place and resolve the waiter. */
  private async finalize(record: DownloadRecord, state: DownloadState): Promise<void> {
    const waiter = this.waiter
    try {
      const sources = [
        join(this.root, record.guid),
        join(this.root, `${record.guid}.crdownload`),
        join(this.root, `${record.guid}.part`),
      ]
      let source: string | undefined
      for (const candidate of sources) {
        if (await fileExists(candidate)) { source = candidate; break }
      }
      if (source === undefined) {
        throw new Error(`cdp: download: completed file not found for ${record.guid}`)
      }

      const explicit = waiter?.renameTo
      let destinationName: string
      if (explicit !== undefined) {
        const destination = resolveInsideRoot(this.root, explicit)
        if (await fileExists(destination)) {
          throw new Error(`cdp: destination exists: ${destination}`)
        }
        destinationName = explicit
      } else {
        const base = record.suggestedFilename === '' ? record.guid : record.suggestedFilename
        destinationName = nextFreeBasename(base, name => exists(join(this.root, name)))
      }

      const destination = resolveInsideRoot(this.root, destinationName)
      await moveFile(source, destination)
      record.path = relative(this.root, destination).replaceAll('\\', '/')
      record.state = state
      record.error = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.path = undefined
      record.state = state
      record.error = message
    }
    this.settle(record)
  }

  /** Resolve the pending waiter (if any) with this record's outcome. */
  private settle(record: DownloadRecord): void {
    const waiter = this.waiter
    if (waiter === undefined) return
    this.waiter = undefined
    clearTimeout(waiter.timer)
    const ok = record.state === 'completed' && record.error === undefined
    waiter.resolve({
      ok,
      state: record.state,
      guid: record.guid,
      suggestedFilename: record.suggestedFilename,
      path: record.path,
      bytes: record.receivedBytes,
      error: record.error,
    })
  }

  // -- behavior -------------------------------------------------------------

  /** One-time `Browser.setDownloadBehavior` for this root; cached. */
  private ensureBehavior(): Promise<void> {
    if (this.behaviorPromise === undefined) {
      this.behaviorPromise = this.connection
        .send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: this.root,
          eventsEnabled: true,
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          this.behaviorPromise = undefined
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`cdp: download: setDownloadBehavior failed: ${message}`)
        })
    }
    return this.behaviorPromise
  }
}
