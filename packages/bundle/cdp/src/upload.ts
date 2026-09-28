/**
 * @deepseek-ai/dsh-cdp/upload — plan05 file-upload primitives: the host path
 * policy that decides whether a file may be handed to the browser, and the
 * DOM command sequence that binds files onto a file input (or into an open
 * file chooser) with a read-back verification. Pure logic plus protocol
 * commands: it takes a `send` callback, never constructs the connection.
 * @module @deepseek-ai/dsh-cdp/upload
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'

/** Largest file list one `cdp_upload` call may bind. */
export const DEFAULT_MAX_UPLOAD_FILES = 10

/** Upload path policy: allow-listed roots, or the explicit escape hatch. */
export interface UploadPolicy {
  /** Absolute roots (cwd, downloads dir, configured extras); realpath compared. */
  readonly roots: readonly string[]
  /** When true, skips the root check entirely. */
  readonly allowAnyPath: boolean
}

/** One validated, absolute, on-disk file handed to the browser. */
export interface UploadFileBrief {
  /** Realpath-resolved absolute path sent to `DOM.setFileInputFiles`. */
  readonly path: string
  /** File name as the page will see it. */
  readonly name: string
  /** Size in bytes from `stat`. */
  readonly size: number
}

/** Machine codes the host path policy can reject with. */
export type UploadPathCode = 'path-not-absolute' | 'file-not-found' | 'path-forbidden'

/** Outcome of validating one requested path against {@link UploadPolicy}. */
export type UploadPathOutcome =
  | { readonly ok: true; readonly file: UploadFileBrief }
  | { readonly ok: false; readonly code: UploadPathCode; readonly message: string; readonly path: string }

/**
 * @param error - caught exception.
 * @returns its message, or a stringified fallback for non-Error values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate one requested upload path: absolute, resolves on disk to a regular
 * file, and — unless `allowAnyPath` — inside one of the policy roots after
 * realpath, with a separator-boundary comparison so `root2` can never match a
 * path under `root`.
 * @param rawPath - the caller-provided path, typically from the model.
 * @param policy - roots and escape hatch.
 * @returns the validated file brief, or the rejection code and message.
 */
export async function validateUploadPath(rawPath: string, policy: UploadPolicy): Promise<UploadPathOutcome> {
  if (rawPath === '') {
    return { ok: false, code: 'file-not-found', message: 'cdp_upload: an empty path was requested', path: rawPath }
  }
  if (!isAbsolute(rawPath)) {
    return { ok: false, code: 'path-not-absolute', message: `cdp_upload: path must be absolute, got "${rawPath}"`, path: rawPath }
  }
  const resolved = resolve(rawPath)
  let real: string
  try {
    real = await realpath(resolved)
  } catch (error) {
    return { ok: false, code: 'file-not-found', message: `cdp_upload: path does not resolve on disk: ${resolved} (${errorMessage(error)})`, path: resolved }
  }
  const stats = await stat(real).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) {
    return { ok: false, code: 'file-not-found', message: `cdp_upload: not a regular file: ${real}`, path: real }
  }
  const file: UploadFileBrief = { path: real, name: basename(real), size: stats.size }
  if (policy.allowAnyPath) return { ok: true, file }
  for (const root of policy.roots) {
    const resolvedRoot = resolve(root)
    const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot)
    const withBoundary = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    if (real === realRoot || real.startsWith(withBoundary)) return { ok: true, file }
  }
  return {
    ok: false,
    code: 'path-forbidden',
    message: `cdp_upload: ${real} is outside every allowed root: ${policy.roots.join(', ')}`,
    path: real,
  }
}

/** The protocol sender a bind step runs over (session-scoped in the service). */
export type UploadSender = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Machine codes the DOM binding sequence can fail with. */
export type UploadBindCode =
  | 'missing-locator'
  | 'no-input'
  | 'not-file-input'
  | 'too-many-files'
  | 'dom-error'
  | 'verify-failed'

/** What the bound input looked like, read back from the live DOM. */
export interface UploadInputInfo {
  /** Lowercase tag name of the bound element (`input`), or `unknown` when unverifiable. */
  readonly tag: string
  /** The element's `accept` attribute; absent when the input has none. */
  readonly accept?: string
  /** Whether the element accepts multiple files. */
  readonly multiple: boolean
  /** True only when the read-back confirmed `input.files` matches the request. */
  readonly verified: boolean
  /** File names reported by the page after binding (empty when unverified). */
  readonly fileList: string[]
}

/** Outcome of the DOM file-input binding sequence. */
export type UploadBindOutcome =
  | { readonly ok: true; readonly input: UploadInputInfo }
  | { readonly ok: false; readonly code: UploadBindCode; readonly message: string }

/** Options for {@link bindFileInput}: a selector, the validated files, a sender. */
export interface UploadBindOptions {
  /** CSS selector matching exactly one file input. */
  readonly selector: string
  /** Validated files, already bounded by the service. */
  readonly files: readonly UploadFileBrief[]
  /** Session-scoped CDP sender. */
  readonly send: UploadSender
}

/**
 * @param value - candidate protocol reply or nested field.
 * @returns the value as a string-keyed record, or undefined for a non-object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * @param record - candidate record.
 * @param key - field to read.
 * @returns the field when it is a non-negative number, else undefined.
 */
function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Read one attribute from a `DOM.getAttributes` alternating name/value array.
 * @param attrs - the alternating attribute array.
 * @param name - attribute to find.
 * @returns its value when present, else undefined.
 */
export function readAttribute(attrs: readonly string[], name: string): string | undefined {
  for (let index = 0; index + 1 < attrs.length; index += 2) {
    if (attrs[index] === name) return attrs[index + 1]
  }
  return undefined
}

/** Read-back result of `Runtime.callFunctionOn` over `input.files`. */
interface FileListCheck {
  /** True when the page's file list matches the requested count. */
  readonly verified: boolean
  /** File names the page reported. */
  readonly fileList: string[]
  /** Why the check failed, when it did. */
  readonly message: string | undefined
}

/**
 * Resolve the bound node and read its `input.files` back through
 * `Runtime.callFunctionOn`, so the tool reports verification with evidence
 * instead of trusting the setter's silent reply.
 * @param send - session-scoped CDP sender.
 * @param locate - `{ nodeId }` or `{ backendNodeId }` addressing the bound node.
 * @param expected - how many files the page should now hold.
 * @returns the verification result.
 */
async function verifyFileList(
  send: UploadSender,
  locate: Record<string, unknown>,
  expected: number,
): Promise<FileListCheck> {
  const resolved = asRecord(await send('DOM.resolveNode', locate))
  const objectId = asRecord(resolved?.object)?.objectId
  if (typeof objectId !== 'string' || objectId === '') {
    return { verified: false, fileList: [], message: 'cdp_upload: DOM.resolveNode carried no objectId' }
  }
  const replied = asRecord(await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { return Array.prototype.map.call(this.files, function (file) { return file.name }) }',
    returnByValue: true,
  }))
  // callFunctionOn replies `{ result: { value } }`; the array lives on `.value`.
  const names = asRecord(replied?.result)?.value
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
    return { verified: false, fileList: [], message: 'cdp_upload: read-back did not return a string array' }
  }
  const fileList = names as string[]
  if (fileList.length !== expected) {
    return {
      verified: false,
      fileList,
      message: `cdp_upload: verification mismatch: expected ${String(expected)} file(s), input holds ${String(fileList.length)}`,
    }
  }
  return { verified: true, fileList, message: undefined }
}

/**
 * Bind validated files onto the file input the given locator points at, then
 * read `input.files` back. Steps: `DOM.enable` (idempotent), `DOM.getDocument`
 * (depth 0), `DOM.querySelector`, `DOM.describeNode`, `DOM.getAttributes`
 * (type/multiple/accept checks), `DOM.setFileInputFiles`, then the read-back.
 * Every failure maps to one {@link UploadBindCode}; a protocol exception
 * becomes `dom-error` rather than an unhandled throw.
 * @param options - selector, validated files, and the session-scoped sender.
 * @returns the binding result with the read-back evidence.
 */
export async function bindFileInput(options: UploadBindOptions): Promise<UploadBindOutcome> {
  try {
    await options.send('DOM.enable', {})
    const doc = asRecord(await options.send('DOM.getDocument', { depth: 0 }))
    const rootId = readNumber(asRecord(doc?.root), 'nodeId')
    if (rootId === undefined) {
      return { ok: false, code: 'dom-error', message: 'cdp_upload: DOM.getDocument carried no root nodeId' }
    }
    const matched = asRecord(await options.send('DOM.querySelector', { nodeId: rootId, selector: options.selector }))
    const nodeId = readNumber(matched, 'nodeId')
    if (nodeId === undefined || nodeId === 0) {
      return { ok: false, code: 'no-input', message: `cdp_upload: no element matches selector ${options.selector}` }
    }
    const described = asRecord(await options.send('DOM.describeNode', { nodeId }))
    const nodeName = asRecord(described?.node)?.nodeName
    const tag = typeof nodeName === 'string' ? nodeName.toLowerCase() : ''
    // DOM.getAttributes replies `{ attributes: string[] }` (alternating name/value).
    const attrReply = asRecord(await options.send('DOM.getAttributes', { nodeId }))
    const attributeList = Array.isArray(attrReply?.attributes)
      ? attrReply.attributes.filter((entry): entry is string => typeof entry === 'string')
      : []
    const type = readAttribute(attributeList, 'type')
    if (tag !== 'input' || type !== 'file') {
      return {
        ok: false,
        code: 'not-file-input',
        message: `cdp_upload: selector ${options.selector} matches <${tag === '' ? 'unknown' : tag}${type !== undefined ? ` type="${type}"` : ''}> which is not a file input`,
      }
    }
    const multiple = readAttribute(attributeList, 'multiple') !== undefined
    if (options.files.length > 1 && !multiple) {
      return {
        ok: false,
        code: 'too-many-files',
        message: `cdp_upload: ${String(options.files.length)} files requested but the input has no multiple attribute`,
      }
    }
    await options.send('DOM.setFileInputFiles', { files: options.files.map(file => file.path), nodeId })
    const check = await verifyFileList(options.send, { nodeId }, options.files.length)
    if (!check.verified) {
      return { ok: false, code: 'verify-failed', message: check.message ?? 'cdp_upload: verification failed' }
    }
    const accept = readAttribute(attributeList, 'accept')
    return {
      ok: true,
      input: {
        tag,
        multiple,
        verified: true,
        fileList: check.fileList,
        ...(accept !== undefined ? { accept } : {}),
      },
    }
  } catch (error) {
    return { ok: false, code: 'dom-error', message: `cdp_upload: CDP DOM step failed: ${errorMessage(error)}` }
  }
}

/** Options for {@link bindFilePickerFiles}: the open chooser plus its files. */
export interface UploadPickerBindOptions {
  /** `selectSingle` or `selectMultiple`, as the chooser reported it. */
  readonly mode: string
  /** Backend node of the chooser's file input, when the event carried one. */
  readonly backendNodeId: number | undefined
  /** Validated files, already bounded by the service. */
  readonly files: readonly UploadFileBrief[]
  /** Session-scoped CDP sender. */
  readonly send: UploadSender
}

/**
 * Bind validated files directly into an OPEN file chooser (the intercepted
 * `Page.fileChooserOpened` path): `DOM.describeNode` + `DOM.getAttributes` for
 * the evidence fields, `DOM.setFileInputFiles` addressed by `backendNodeId`,
 * then the same read-back verification. A `selectSingle` chooser refuses a
 * multi-file request before anything is sent.
 * @param options - the open chooser's mode/node plus the validated files.
 * @returns the binding result with the read-back evidence.
 */
export async function bindFilePickerFiles(options: UploadPickerBindOptions): Promise<UploadBindOutcome> {
  if (options.backendNodeId === undefined) {
    return {
      ok: false,
      code: 'no-input',
      message: 'cdp_upload: the file chooser reported no backendNodeId, so its input cannot be targeted',
    }
  }
  if (options.mode === 'selectSingle' && options.files.length > 1) {
    return {
      ok: false,
      code: 'too-many-files',
      message: `cdp_upload: chooser accepts a single file but ${String(options.files.length)} were requested`,
    }
  }
  try {
    const described = asRecord(await options.send('DOM.describeNode', { backendNodeId: options.backendNodeId }))
    const nodeName = asRecord(described?.node)?.nodeName
    const tag = typeof nodeName === 'string' ? nodeName.toLowerCase() : 'input'
    // DOM.getAttributes replies `{ attributes: string[] }` (alternating name/value).
    const attrReply = asRecord(await options.send('DOM.getAttributes', { backendNodeId: options.backendNodeId }))
    const attributeList = Array.isArray(attrReply?.attributes)
      ? attrReply.attributes.filter((entry): entry is string => typeof entry === 'string')
      : []
    await options.send('DOM.setFileInputFiles', {
      files: options.files.map(file => file.path),
      backendNodeId: options.backendNodeId,
    })
    const check = await verifyFileList(options.send, { backendNodeId: options.backendNodeId }, options.files.length)
    if (!check.verified) {
      return { ok: false, code: 'verify-failed', message: check.message ?? 'cdp_upload: verification failed' }
    }
    const accept = readAttribute(attributeList, 'accept')
    return {
      ok: true,
      input: {
        tag,
        multiple: options.mode !== 'selectSingle',
        verified: true,
        fileList: check.fileList,
        ...(accept !== undefined ? { accept } : {}),
      },
    }
  } catch (error) {
    return { ok: false, code: 'dom-error', message: `cdp_upload: CDP DOM step failed: ${errorMessage(error)}` }
  }
}
