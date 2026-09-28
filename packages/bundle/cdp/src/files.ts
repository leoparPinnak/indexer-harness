/**
 * Plan 10 §5.5 — `cdp_files` operations, all confined to the downloads root.
 *
 * Every path goes through `resolveInsideRoot`, so `..`, absolute escapes, and
 * symlink hops are rejected in one place. Reads and writes are bounded; the
 * root itself is addressable (`''`, `'.'`) so the default `list` works.
 * @module @deepseek-ai/dsh-cdp/files
 */

import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  nextFreeBasename,
  resolveInsideRoot,
} from './downloads-dir.ts'

/** One directory entry. */
export interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  /** ISO-8601 modification time. */
  mtime: string
}

/** Result of a `list` operation. */
export interface FileListResult {
  path: string
  entries: FileEntry[]
}

/** Result of a `read` operation. */
export interface FileReadResult {
  path: string
  encoding: 'utf8' | 'base64'
  bytes: number
  content: string
  truncated: boolean
}

/** Result of a `write` operation. */
export interface FileWriteResult {
  path: string
  bytes: number
}

/** Result of a `stat` operation. */
export interface FileStatResult {
  path: string
  type: 'file' | 'dir'
  size: number
  mtime: string
}

/** Result of a `delete` operation. */
export interface FileDeleteResult {
  path: string
  deleted: true
}

/** Result of an `mkdir` operation. */
export interface FileMkdirResult {
  path: string
  created: true
}

/** Default read/write byte budget for text content (plan: bounded reads). */
export const MAX_FILE_READ_BYTES = 4 * 1024 * 1024

/**
 * Root-relative display path (forward slashes on every platform).
 * @param root - absolute downloads root.
 * @param target - absolute contained path.
 * @returns the relative display path (`''` for the root itself).
 */
function displayPath(root: string, target: string): string {
  const rel = relative(root, target)
  return rel === '' ? '' : rel.replaceAll('\\', '/')
}

/**
 * Resolve a caller path, letting the empty string/`'.'` mean the root itself
 * (needed by the default `list`).
 * @param root - absolute downloads root.
 * @param userPath - caller path; `''`/`'.'`/`'/'` address the root.
 * @returns the absolute target path.
 * @throws CdpPathEscapeError when the path would leave the root.
 */
function resolveTarget(root: string, userPath: string): string {
  const trimmed = userPath.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '/') return root
  return resolveInsideRoot(root, userPath)
}

/**
 * List one directory inside the root.
 * @param root - absolute downloads root.
 * @param userPath - directory path (`''` = root).
 * @returns sorted entries.
 * @throws Error `cdp: not a directory: …`.
 */
export async function listFiles(root: string, userPath = ''): Promise<FileListResult> {
  const target = resolveTarget(root, userPath)
  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    throw new Error(`cdp: not a directory: ${displayPath(root, target)}`)
  }
  const entries: FileEntry[] = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue // hidden/system files stay invisible
    const info = await stat(join(target, dirent.name)).catch(() => undefined)
    if (info === undefined) continue
    entries.push({
      name: dirent.name,
      type: dirent.isDirectory() ? 'dir' : 'file',
      size: info.size,
      mtime: info.mtime.toISOString(),
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { path: displayPath(root, target), entries }
}

/**
 * Read a file inside the root with a hard byte budget.
 * @param root - absolute downloads root.
 * @param userPath - file path.
 * @param options - encoding and byte cap.
 * @returns the bounded content.
 * @throws Error on escape, missing file, directory, or oversize.
 */
export async function readFileUnder(
  root: string,
  userPath: string,
  options: { encoding?: 'utf8' | 'base64' | undefined; maxBytes?: number | undefined } = {},
): Promise<FileReadResult> {
  const target = resolveInsideRoot(root, userPath)
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error(`cdp: not found: ${displayPath(root, target)}`)
  if (info.isDirectory()) throw new Error(`cdp: is a directory: ${displayPath(root, target)}`)
  const maxBytes = Math.min(MAX_FILE_READ_BYTES, Math.max(1, options.maxBytes ?? MAX_FILE_READ_BYTES))
  const truncated = info.size > maxBytes
  let buffer: Buffer
  if (truncated) {
    // Bounded read: never load more than the budget, even for huge files.
    const handle = await open(target, 'r')
    try {
      buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      buffer = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } else {
    buffer = await readFile(target)
  }
  const encoding = options.encoding ?? 'utf8'
  return {
    path: displayPath(root, target),
    encoding,
    bytes: buffer.byteLength,
    content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
    truncated,
  }
}

/**
 * Write a file inside the root; parent directories are created only inside
 * the root (E15: never beyond it).
 * @param root - absolute downloads root.
 * @param userPath - file path.
 * @param content - text to write.
 * @param options - encoding and overwrite policy.
 * @returns the written path and byte size.
 * @throws Error on escape or an occupied target without `overwrite`.
 */
export async function writeFileUnder(
  root: string,
  userPath: string,
  content: string,
  options: { encoding?: 'utf8' | 'base64' | undefined; overwrite?: boolean | undefined } = {},
): Promise<FileWriteResult> {
  const target = resolveInsideRoot(root, userPath)
  const exists = await stat(target).then(() => true, () => false)
  if (exists && options.overwrite !== true) throw new Error(`cdp: destination exists: ${displayPath(root, target)}`)
  const buffer = options.encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf8')
  const parent = join(target, '..')
  await mkdir(parent, { recursive: true })
  await writeFile(target, buffer)
  return { path: displayPath(root, target), bytes: buffer.byteLength }
}

/**
 * Stat one path inside the root.
 * @param root - absolute downloads root.
 * @param userPath - target path (`''` = root).
 * @returns the entry facts.
 * @throws Error when the path is missing.
 */
export async function statFile(root: string, userPath = ''): Promise<FileStatResult> {
  const target = resolveTarget(root, userPath)
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error(`cdp: not found: ${displayPath(root, target)}`)
  return {
    path: displayPath(root, target),
    type: info.isDirectory() ? 'dir' : 'file',
    size: info.size,
    mtime: info.mtime.toISOString(),
  }
}

/**
 * Delete a file (or, with `recursive`, a directory tree) inside the root.
 * The root itself is never deletable.
 * @param root - absolute downloads root.
 * @param userPath - target path.
 * @param options - recursive flag for directories.
 * @returns the deleted path.
 * @throws Error on escape, missing target, or a non-empty dir without `recursive`.
 */
export async function deleteFile(
  root: string,
  userPath: string,
  options: { recursive?: boolean | undefined } = {},
): Promise<FileDeleteResult> {
  const target = resolveTarget(root, userPath)
  if (target === root) throw new Error('cdp: refusing to delete the downloads root')
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error(`cdp: not found: ${displayPath(root, target)}`)
  await rm(target, { recursive: options.recursive === true, force: false })
  return { path: displayPath(root, target), deleted: true }
}

/**
 * Create a directory (with parents) inside the root.
 * @param root - absolute downloads root.
 * @param userPath - directory path.
 * @returns the created path.
 * @throws Error when an existing file occupies the path.
 */
export async function mkdirUnder(root: string, userPath: string): Promise<FileMkdirResult> {
  const target = resolveInsideRoot(root, userPath)
  const exists = await stat(target).then(() => true, () => false)
  if (exists) throw new Error(`cdp: destination exists: ${displayPath(root, target)}`)
  await mkdir(target, { recursive: true })
  return { path: displayPath(root, target), created: true }
}

/**
 * Choose a non-conflicting write target: explicit names are hard-errored when
 * occupied, auto names (`undefined`) take the suggested one with a suffix loop.
 * @param root - absolute downloads root.
 * @param suggestedName - suggested basename from the caller or browser.
 * @param explicit - caller-chosen name, when given.
 * @returns the final basename.
 * @throws Error when an explicit name exists or none is free.
 */
export function chooseWriteName(root: string, suggestedName: string, explicit?: string | undefined): string {
  if (explicit !== undefined) {
    const target = resolveInsideRoot(root, explicit)
    if (existsSync(target)) throw new Error(`cdp: destination exists: ${target}`)
    return explicit
  }
  return nextFreeBasename(suggestedName, name => existsSync(join(root, name)))
}
