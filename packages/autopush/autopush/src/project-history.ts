/**
 * Project-level auto-push history stored at `<cwd>/.dsh/autopush-history.json`.
 *
 * Persists commit records across session deletions and reboots, and provides
 * project-level push context to the model at session start.
 *
 * @module @deepseek-ai/dsh-autopush/project-history
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One completed push record in the project history ledger. */
export interface ProjectPushRecord {
  /** Commit SHA. */
  readonly sha: string
  /** Timestamp in milliseconds since epoch. */
  readonly at: number
  /** Human-readable formatted date string (`dd.MM.yyyy HH:mm`). */
  readonly date?: string | undefined
  /** Turkish commit description. */
  readonly message: string
  /** Number of modified files. */
  readonly files: number
  /** Remote target. */
  readonly remote: string
  /** Branch target. */
  readonly branch: string
  /** Session ID that performed the push, when available. */
  readonly sessionId?: string | undefined
}

/** Complete project-level push history payload. */
export interface ProjectPushHistory {
  /** Schema version. */
  readonly version: number
  /** Project name or workspace identifier. */
  readonly project?: string | undefined
  /** Timestamp of the most recent push. */
  readonly updatedAt: number
  /** Recorded pushes, newest first. */
  readonly records: readonly ProjectPushRecord[]
}

/** Project-relative path of the auto-push history file. */
export const PROJECT_AUTOPUSH_FILE = '.dsh/autopush-history.json'

/** Maximum number of records retained in the project file. */
export const MAX_PROJECT_RECORDS = 50

/**
 * Format a timestamp into `dd.MM.yyyy HH:mm`.
 * @param at - milliseconds since the epoch.
 * @returns formatted date string.
 */
export function formatPushDate(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Read the project-level auto-push history file if it exists.
 * @param cwd - session workspace directory.
 * @returns parsed history or null when missing or unparseable.
 */
export function readProjectHistory(cwd: string): ProjectPushHistory | null {
  const filePath = join(cwd, PROJECT_AUTOPUSH_FILE)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'records' in parsed && Array.isArray(parsed.records)) {
      return parsed as ProjectPushHistory
    }
  } catch {
    // Malformed JSON or read error: treat as missing history.
  }
  return null
}

/**
 * Record one completed push to the project history file.
 * @param cwd - session workspace directory.
 * @param record - the push record to prepend.
 */
export function recordProjectHistory(cwd: string, record: ProjectPushRecord): void {
  try {
    const dir = join(cwd, '.dsh')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const current = readProjectHistory(cwd)
    const records = [record, ...(current?.records ?? [])].slice(0, MAX_PROJECT_RECORDS)
    const updated: ProjectPushHistory = {
      version: 1,
      project: current?.project,
      updatedAt: record.at,
      records,
    }
    const filePath = join(cwd, PROJECT_AUTOPUSH_FILE)
    writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  } catch {
    // Project history recording is best-effort and must not abort caller.
  }
}

/**
 * Format project auto-push history for the system prompt.
 * @param cwd - session workspace directory.
 * @param limit - maximum recent records to list (default: 5).
 * @returns formatted markdown section or empty string.
 */
export function formatProjectHistoryPrompt(cwd: string, limit = 5): string {
  const history = readProjectHistory(cwd)
  if (history === null || history.records.length === 0) return ''
  const slice = history.records.slice(0, limit)
  const lines = slice.map((rec) => {
    const datePart = rec.date !== undefined && rec.date !== '' ? ` (${rec.date})` : ''
    return `- [${rec.sha}]${datePart}: ${rec.message}`
  })
  return `Project auto-push history (${PROJECT_AUTOPUSH_FILE}):\n`
    + 'Recent changes committed and pushed in this workspace:\n'
    + lines.join('\n')
}
