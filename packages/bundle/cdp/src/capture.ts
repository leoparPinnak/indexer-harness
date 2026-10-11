/**
 * @deepseek-ai/dsh-cdp/capture — screenshot capture core and live viewport
 * probing (plan 06). Holds the binary budget constants, the error vocabulary,
 * `probeViewport` (the `Page.getLayoutMetrics` → `Runtime.evaluate` fallback
 * chain that replaced the old hardcoded snapshot viewport), the clip/legend
 * math, the shared `writeArtifact` disk helper, and `ScreenshotCapture`.
 * Raw CDP only: no browser automation or image library.
 *
 * @module @deepseek-ai/dsh-cdp/capture
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { annotatePng } from './png.ts'
import type { CdpSnapshot, CdpViewport, CdpWovenBox } from './snapshot.ts'

/** Largest decoded bytes one screenshot may return inline as base64; above it the tool returns the path only. */
export const MAX_SCREENSHOT_INLINE_BYTES = 65_536

/** Largest decoded bytes one capture writes to disk before failing fast (full-page ceiling). */
export const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024

/** Default inline budget; overridden per call by `inlineMaxBytes`, clamped to [0, MAX_SCREENSHOT_INLINE_BYTES]. */
export const DEFAULT_INLINE_MAX_BYTES = 65_536

/** Maximum legend rects one capture returns (the snapshot `maxNodes` precedent). */
export const MAX_SCREENSHOT_RECTS = 200

/** Age window in which a cached viewport observation is reused before re-probing (plan R-1). */
export const VIEWPORT_CACHE_MS = 2_000

/** Screenshot failed before a file existed (clip validation, capture, header parse). */
export class CdpScreenshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpScreenshotError'
  }
}

/** The `selector` argument matched no element (or an empty one) in the top document. */
export class CdpScreenshotSelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpScreenshotSelectorError'
  }
}

/** The capture buffer could not be written to its destination path. */
export class CdpScreenshotWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpScreenshotWriteError'
  }
}

/** The capture would exceed {@link MAX_SCREENSHOT_BYTES}; rejected before CDP. */
export class CdpScreenshotTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpScreenshotTooLargeError'
  }
}

/** `cdp_viewport` rejected its arguments or the emulation call failed. */
export class CdpViewportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpViewportError'
  }
}

/** One live viewport observation (single source for status/snapshot/screenshot). */
export interface ViewportObservation {
  /** Viewport width in CSS pixels; `0` when unavailable. */
  readonly width: number
  /** Viewport height in CSS pixels; `0` when unavailable. */
  readonly height: number
  /** Observed device pixel ratio; `1` when only the fallback probe failed to report one. */
  readonly deviceScaleFactor: number
  /** Whether the page reports a coarse (touch) pointer. */
  readonly mobile: boolean
  /** Where the numbers came from. */
  readonly source: 'override' | 'live-window' | 'unavailable'
}

/**
 * The observation returned when every probe step failed. Deliberately never a
 * plausible-looking default resolution: an unavailable viewport must read as
 * unavailable rather than as invented numbers.
 */
export const UNAVAILABLE_VIEWPORT: ViewportObservation = Object.freeze({
  width: 0,
  height: 0,
  deviceScaleFactor: 1,
  mobile: false,
  source: 'unavailable',
})

/** A rectangular capture region in CSS pixels. */
export interface ScreenshotClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly scale?: number
}

/** One capture request normalized from tool or route arguments. */
export interface ScreenshotRequest {
  readonly targetId?: string
  readonly fullPage: boolean
  readonly format: 'png' | 'jpeg'
  /** 0..100; ignored for png. */
  readonly quality: number
  readonly clip?: ScreenshotClip
  readonly selector?: string
  readonly saveTo?: string
  readonly inline: boolean
  readonly inlineMaxBytes: number
  readonly rects: boolean
  readonly annotate: boolean
}

/** One legend rect in image pixel coordinates. */
export interface ImageRect {
  readonly ref: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label?: string
}

/** Result handed to the tool: the image itself is always on disk. */
export interface ScreenshotResult {
  readonly ok: true
  readonly path: string
  readonly format: 'png' | 'jpeg'
  readonly byteSize: number
  /** Bitmap width in device pixels, parsed from the image header. */
  readonly width: number
  /** Bitmap height in device pixels, parsed from the image header. */
  readonly height: number
  /** Captured region width in CSS pixels. */
  readonly cssWidth: number
  /** Captured region height in CSS pixels. */
  readonly cssHeight: number
  readonly deviceScaleFactor: number
  readonly fullPage: boolean
  readonly viewport: CdpViewport
  readonly selector?: string
  /** Legend rects in image pixels; present when `rects` or `annotate` was requested. */
  readonly rects?: ImageRect[]
  readonly rectsTruncated?: boolean
  /** Coordinate space of `rects`: `viewport` (default) or `document` (fullPage). */
  readonly coordinateSpace?: 'viewport' | 'document'
  /** Base64 payload, only when `inline` was requested and it fits the budget. */
  readonly inline?: string
  readonly inlineOmitted?: boolean
  readonly durationMs: number
}

/** The error envelope every failing capture/viewport call returns. */
export interface CdpErrorEnvelope {
  readonly ok: false
  readonly error: { readonly name: string; readonly message: string }
}

/**
 * Wrap any thrown value into the shared `{ok:false, error:{name,message}}` envelope.
 * @param err - the thrown value; non-`Error` values are stringified into the message.
 * @returns the failure envelope with a non-empty name and a string message.
 */
export function errorEnvelope(err: unknown): CdpErrorEnvelope {
  if (err instanceof Error) {
    return { ok: false, error: { name: err.name.length > 0 ? err.name : 'Error', message: err.message } }
  }
  return { ok: false, error: { name: 'Error', message: String(err) } }
}

/** The subset of a CDP connection that probes and captures need. */
export interface CdpMethodSender {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Page-side fallback expression: the CSS viewport, dpr, and pointer coarseness. */
const VIEWPORT_EVALUATE_EXPRESSION = `(() => ({
  w: window.innerWidth,
  h: window.innerHeight,
  dpr: window.devicePixelRatio,
  coarse: window.matchMedia('(pointer: coarse)').matches,
}))()`

interface EvaluatedViewport {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  readonly coarse: boolean
}

async function evaluateViewport(
  sender: CdpMethodSender,
  sessionId?: string,
): Promise<EvaluatedViewport | undefined> {
  try {
    const reply = asRecord(await sender.send('Runtime.evaluate', {
      expression: VIEWPORT_EVALUATE_EXPRESSION,
      returnByValue: true,
    }, sessionId))
    const value = asRecord(asRecord(reply?.result)?.value)
    if (value === undefined) return undefined
    const width = positiveNumber(value.w)
    const height = positiveNumber(value.h)
    if (width === undefined || height === undefined) return undefined
    return {
      width,
      height,
      deviceScaleFactor: positiveNumber(value.dpr) ?? 1,
      coarse: value.coarse === true,
    }
  } catch {
    return undefined
  }
}

/**
 * Probe the live CSS viewport of one page session.
 *
 * Order: `Page.getLayoutMetrics` (cssVisualViewport/cssLayoutViewport, then
 * `visualViewport.deviceScaleFactor`) → `Runtime.evaluate` fallback →
 * `UNAVAILABLE_VIEWPORT`. Never throws, never invents the old 1280×800.
 *
 * @param sender - connection-like sender carrying `send(method, params, sessionId)`.
 * @param sessionId - page session to probe; omitted probes the default session.
 * @param options - `overrideActive` marks the observation `source: 'override'`.
 * @returns the observation, `source: 'unavailable'` when every step failed.
 */
export async function probeViewport(
  sender: CdpMethodSender,
  sessionId?: string,
  options: { readonly overrideActive?: boolean } = {},
): Promise<ViewportObservation> {
  const source: ViewportObservation['source'] = options.overrideActive === true ? 'override' : 'live-window'
  let width: number | undefined
  let height: number | undefined
  let deviceScaleFactor: number | undefined

  try {
    const reply = asRecord(await sender.send('Page.getLayoutMetrics', {}, sessionId))
    const cssVisual = asRecord(reply?.cssVisualViewport)
    const cssLayout = asRecord(reply?.cssLayoutViewport)
    const visual = asRecord(reply?.visualViewport)
    const layout = asRecord(reply?.layoutViewport)
    width = positiveNumber(cssVisual?.cssWidth)
      ?? positiveNumber(cssLayout?.clientWidth)
      ?? positiveNumber(layout?.clientWidth)
      ?? positiveNumber(visual?.cssWidth)
    height = positiveNumber(cssVisual?.cssHeight)
      ?? positiveNumber(cssLayout?.clientHeight)
      ?? positiveNumber(layout?.clientHeight)
      ?? positiveNumber(visual?.cssHeight)
    deviceScaleFactor = positiveNumber(cssVisual?.deviceScaleFactor)
      ?? positiveNumber(visual?.deviceScaleFactor)
  } catch {
    // Fall through to the page-side probe.
  }

  let coarse = false
  if (width === undefined || height === undefined || deviceScaleFactor === undefined) {
    const evaluated = await evaluateViewport(sender, sessionId)
    width ??= evaluated?.width
    height ??= evaluated?.height
    deviceScaleFactor ??= evaluated?.deviceScaleFactor
    coarse = evaluated?.coarse === true
  }

  if (width !== undefined && height !== undefined && deviceScaleFactor !== undefined) {
    return { width, height, deviceScaleFactor, mobile: coarse, source }
  }
  if (width !== undefined && height !== undefined) {
    return { width, height, deviceScaleFactor: 1, mobile: coarse, source }
  }
  return UNAVAILABLE_VIEWPORT
}

/**
 * Read pixel dimensions from an encoded image without decoding it.
 * PNG: signature + IHDR big-endian width/height. JPEG: SOF0/1/2-class marker.
 * @param buffer - encoded image bytes.
 * @param format - encoding the buffer claims to be.
 * @returns bitmap width and height in device pixels.
 */
export function readImageSize(buffer: Buffer, format: 'png' | 'jpeg'): { readonly width: number; readonly height: number } {
  if (format === 'png') {
    const hasSignature = buffer.length >= 24
      && buffer.readUInt32BE(0) === 0x89504e47
      && buffer.readUInt32BE(4) === 0x0d0a1a0a
      && buffer.toString('ascii', 12, 16) === 'IHDR'
    if (!hasSignature) throw new CdpScreenshotError('not a PNG image (missing PNG signature or IHDR)')
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    if (width <= 0 || height <= 0) throw new CdpScreenshotError('PNG IHDR reports an empty image')
    return { width, height }
  }

  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) {
    throw new CdpScreenshotError('not a JPEG image (missing SOI marker)')
  }
  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer.readUInt8(offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer.readUInt8(offset + 1)
    if (marker === 0xff) {
      offset += 2
      continue
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    if (offset + 4 > buffer.length) break
    const length = buffer.readUInt16BE(offset + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > buffer.length) break
      const height = buffer.readUInt16BE(offset + 5)
      const width = buffer.readUInt16BE(offset + 7)
      if (width > 0 && height > 0) return { width, height }
      break
    }
    if (length < 2) break
    offset += 2 + length
  }
  throw new CdpScreenshotError('could not read JPEG image dimensions (no SOF marker)')
}

/** One snapshot box mapped into the capture, in the clip's coordinate space. */
export interface LegendEntry {
  readonly ref: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label?: string
}

/** A built legend: image-space rects plus the truncation flag. */
export interface LegendOutcome {
  /** Paint-space rects; mutable so a capture can publish them directly. */
  readonly rects: ImageRect[]
  readonly truncated: boolean
}

/**
 * Map CSS-space rects onto image pixels: `imageX = (cssX - clip.x) * (imageWidth / clip.width)`.
 * The ratio already absorbs the device pixel ratio, so the formula holds at any dpr.
 * @param entries - rects in the same coordinate space as `clip`.
 * @param clip - captured CSS region.
 * @param imageWidth - bitmap width in device pixels.
 * @param imageHeight - bitmap height in device pixels.
 * @param maxRects - ceiling; the outcome reports `truncated` past it.
 * @returns image-space rects and the truncation flag.
 */
export function buildLegend(
  entries: readonly LegendEntry[],
  clip: ScreenshotClip,
  imageWidth: number,
  imageHeight: number,
  maxRects: number = MAX_SCREENSHOT_RECTS,
): LegendOutcome {
  const scaleX = clip.width > 0 ? imageWidth / clip.width : 0
  const scaleY = clip.height > 0 ? imageHeight / clip.height : 0
  const kept = entries.slice(0, Math.max(0, maxRects))
  const rects: ImageRect[] = kept.map(entry => ({
    ref: entry.ref,
    x: (entry.x - clip.x) * scaleX,
    y: (entry.y - clip.y) * scaleY,
    width: entry.width * scaleX,
    height: entry.height * scaleY,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  }))
  return { rects, truncated: entries.length > kept.length }
}

let artifactSequence = 0

/**
 * Default destination for one capture: `screenshots/<ISO-ish epoch>-<n>.<ext>`
 * under the working directory, collision-free and sortable.
 * @param baseDir - directory the `screenshots/` folder sits under.
 * @param ext - file extension without the dot.
 * @returns absolute destination path.
 */
export function defaultArtifactPath(baseDir: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  artifactSequence = (artifactSequence + 1) % 1_000_000
  return resolve(baseDir, 'screenshots', `${stamp}-${String(artifactSequence)}.${ext}`)
}

/**
 * Resolve a `saveTo` argument: absolute paths pass through, relative paths
 * resolve under the working directory (the workspace fallback), and an absent
 * path falls back to {@link defaultArtifactPath}.
 * @param saveTo - optional destination from the caller.
 * @param ext - default file extension without the dot.
 * @returns absolute destination path.
 */
export function resolveArtifactPath(saveTo: string | undefined, ext: string): string {
  if (saveTo !== undefined && saveTo.length > 0) {
    return isAbsolute(saveTo) ? saveTo : resolve(process.cwd(), saveTo)
  }
  return defaultArtifactPath(process.cwd(), ext)
}

/**
 * Write one capture buffer to disk atomically: `mkdir -p`, write a sibling
 * `.tmp` file, then `rename` over the destination.
 *
 * Shared helper (plan 06 §10.3): workstream 10 imports this for its file
 * results. `// plan10 bodySink extension point:` a future streaming body sink
 * for large network bodies lands right here — everything above this comment
 * stays byte-buffer oriented.
 *
 * @param path - absolute destination path.
 * @param data - full encoded payload.
 * @returns the byte count written.
 */
export async function writeArtifact(path: string, data: Buffer): Promise<number> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
    await writeFile(tmp, data)
    await rename(tmp, path)
    return data.byteLength
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new CdpScreenshotWriteError(`could not write ${path}: ${detail}`)
  }
}

/** Session facts a capture needs; structurally satisfied by `PageSession`. */
export interface CaptureSessionRef {
  readonly sessionId: string
}

/** Everything `ScreenshotCapture` reaches outside itself. */
export interface CaptureContext {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  getPageSession(targetId?: string): Promise<CaptureSessionRef>
  /** Whether this process currently holds an explicit viewport override. */
  isViewportOverrideActive(): boolean
  /** Cache write-back so status/snapshot report the freshest observation. */
  onViewportObserved(observation: ViewportObservation): void
  /** Snapshot provider for `rects` legends (boxes arrive with workstream 08). */
  snapshot(targetId?: string): Promise<CdpSnapshot>
}

interface SelectorRect {
  /** Document coordinates (viewport rect + scroll), what the clip uses. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 80
  return Math.min(100, Math.max(0, Math.round(quality)))
}

function clampInlineBudget(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return DEFAULT_INLINE_MAX_BYTES
  return Math.min(MAX_SCREENSHOT_INLINE_BYTES, Math.round(bytes))
}

/**
 * Normalize loose tool/route arguments into a {@link ScreenshotRequest}.
 * Validation happens before any CDP call: a bad clip can never reach
 * `Page.captureScreenshot`.
 * @param raw - untrusted argument record.
 * @returns the normalized request.
 * @throws CdpScreenshotError when a value is invalid.
 */
export function normalizeScreenshotRequest(raw: Readonly<Record<string, unknown>>): ScreenshotRequest {
  const format = raw.format === undefined || raw.format === 'png'
    ? 'png'
    : raw.format === 'jpeg' || raw.format === 'jpg'
      ? 'jpeg'
      : undefined
  if (format === undefined) {
    throw new CdpScreenshotError('format must be "png" or "jpeg"')
  }

  const annotate = raw.annotate === true
  if (annotate && format !== 'png') {
    throw new CdpScreenshotError('annotate requires png; re-run with format:"png"')
  }

  let clip: ScreenshotClip | undefined
  if (raw.clip !== undefined && raw.clip !== null) {
    const record = asRecord(raw.clip)
    if (record === undefined) throw new CdpScreenshotError('clip must be an object {x, y, width, height, scale?}')
    const { x, y, width, height } = record
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      throw new CdpScreenshotError('clip requires numeric x, y, width, and height')
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new CdpScreenshotError('clip coordinates must be finite numbers')
    }
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      throw new CdpScreenshotError(`clip must have non-negative x/y and a positive width/height (got x=${String(x)}, y=${String(y)}, width=${String(width)}, height=${String(height)})`)
    }
    const scale = record.scale
    if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
      throw new CdpScreenshotError('clip.scale must be a positive number')
    }
    clip = { x, y, width, height, ...(typeof scale === 'number' ? { scale } : {}) }
  }

  const quality = raw.quality === undefined ? 80 : raw.quality
  if (typeof quality !== 'number') throw new CdpScreenshotError('quality must be a number between 0 and 100')

  const inlineMaxBytes = raw.inlineMaxBytes === undefined ? DEFAULT_INLINE_MAX_BYTES : raw.inlineMaxBytes
  if (typeof inlineMaxBytes !== 'number') throw new CdpScreenshotError('inlineMaxBytes must be a number')

  for (const key of ['targetId', 'selector', 'saveTo'] as const) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new CdpScreenshotError(`${key} must be a string`)
    }
  }
  for (const key of ['fullPage', 'inline', 'rects', 'annotate'] as const) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new CdpScreenshotError(`${key} must be a boolean`)
    }
  }

  return {
    fullPage: raw.fullPage === true,
    format,
    quality: clampQuality(quality),
    ...(clip !== undefined ? { clip } : {}),
    ...(typeof raw.selector === 'string' && raw.selector.length > 0 ? { selector: raw.selector } : {}),
    ...(typeof raw.saveTo === 'string' && raw.saveTo.length > 0 ? { saveTo: raw.saveTo } : {}),
    ...(typeof raw.targetId === 'string' && raw.targetId.length > 0 ? { targetId: raw.targetId } : {}),
    inline: raw.inline === true,
    inlineMaxBytes: clampInlineBudget(inlineMaxBytes),
    rects: raw.rects === true,
    annotate,
  }
}

function selectorExpression(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    return { found: true, x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
  })()`
}

function scrollExpression(): string {
  return '({ sx: window.scrollX, sy: window.scrollY })'
}

interface PageScroll {
  readonly sx: number
  readonly sy: number
}

/**
 * Screenshot capture over raw `Page.captureScreenshot`.
 *
 * Every capture lands on disk first; the result carries the path and the
 * header-parsed dimensions, never the binary itself.
 */
export class ScreenshotCapture {
  constructor(private readonly ctx: CaptureContext) {}

  /**
   * Capture one screenshot per the normalized request.
   * @param request - normalized capture request.
   * @returns the on-disk result with dimensions and optional legend.
   */
  async capture(request: ScreenshotRequest): Promise<ScreenshotResult> {
    const startedAt = Date.now()
    const session = await this.ctx.getPageSession(request.targetId)
    const sessionId = session.sessionId

    const observation = await probeViewport(this.ctx, sessionId, {
      overrideActive: this.ctx.isViewportOverrideActive(),
    })
    this.ctx.onViewportObserved(observation)

    const layoutMetrics = asRecord(await this.ctx.send('Page.getLayoutMetrics', {}, sessionId))
    const contentSizeRecord = asRecord(layoutMetrics?.contentSize)
    const contentWidth = positiveNumber(contentSizeRecord?.width)
    const contentHeight = positiveNumber(contentSizeRecord?.height)

    let selectorRect: SelectorRect | undefined
    if (request.selector !== undefined) {
      selectorRect = await this.resolveSelectorRect(request.selector, sessionId)
    }

    // Clip decision: selector > clip > fullPage > viewport.
    let clip: ScreenshotClip | undefined
    if (selectorRect !== undefined) {
      clip = { x: selectorRect.x, y: selectorRect.y, width: selectorRect.width, height: selectorRect.height, scale: 1 }
    } else if (request.clip !== undefined) {
      clip = { ...request.clip, scale: request.clip.scale ?? 1 }
    } else if (request.fullPage) {
      if (contentWidth === undefined || contentHeight === undefined) {
        throw new CdpScreenshotError('Page.getLayoutMetrics reported no contentSize; use clip or selector instead of fullPage')
      }
      clip = { x: 0, y: 0, width: contentWidth, height: contentHeight, scale: 1 }
      const dpr = observation.deviceScaleFactor > 0 ? observation.deviceScaleFactor : 1
      const estimate = contentWidth * contentHeight * dpr * dpr * 4
      if (estimate > MAX_SCREENSHOT_BYTES) {
        throw new CdpScreenshotTooLargeError(`page is ${String(Math.round(contentWidth))}x${String(Math.round(contentHeight))} css px (≈${String(Math.round(estimate / (1024 * 1024)))} MB); use clip`)
      }
    }

    const params: Record<string, unknown> = {
      format: request.format,
      fromSurface: true,
      ...(request.format === 'jpeg' ? { quality: clampQuality(request.quality) } : {}),
      ...(clip !== undefined
        ? { clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 } }
        : {}),
      ...((request.fullPage || selectorRect !== undefined) ? { captureBeyondViewport: true } : {}),
    }

    const reply = asRecord(await this.ctx.send('Page.captureScreenshot', params, sessionId))
    const data = reply?.data
    if (typeof data !== 'string' || data.length === 0) {
      throw new CdpScreenshotError('Page.captureScreenshot returned no image data')
    }

    const buffer = Buffer.from(data, 'base64')
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new CdpScreenshotTooLargeError(`capture is ${String(buffer.byteLength)} bytes, over the ${String(MAX_SCREENSHOT_BYTES)} byte ceiling`)
    }
    if (buffer.byteLength === 0) {
      throw new CdpScreenshotError('Page.captureScreenshot returned an empty image')
    }

    const { width, height } = readImageSize(buffer, request.format)
    const cssWidth = clip !== undefined
      ? clip.width
      : observation.width > 0 ? observation.width : Math.round(width / Math.max(1, observation.deviceScaleFactor))
    const cssHeight = clip !== undefined
      ? clip.height
      : observation.height > 0 ? observation.height : Math.round(height / Math.max(1, observation.deviceScaleFactor))

    const path = resolveArtifactPath(request.saveTo, request.format === 'jpeg' ? 'jpg' : 'png')
    const byteSize = await writeArtifact(path, buffer)

    let rects: ImageRect[] | undefined
    let rectsTruncated = false
    let coordinateSpace: 'viewport' | 'document' | undefined
    if (request.rects || request.annotate) {
      const legendClip: ScreenshotClip = clip ?? await this.viewportClip(sessionId, observation)
      coordinateSpace = request.fullPage || request.clip !== undefined || selectorRect !== undefined
        ? 'document'
        : 'viewport'
      const scroll = await this.readScroll(sessionId)
      const snapshot = await this.ctx.snapshot(request.targetId)
      const entries: LegendEntry[] = []
      for (const node of snapshot.nodes) {
        const box: CdpWovenBox | undefined = node.box
        if (box === undefined) continue
        entries.push({
          ref: node.ref,
          x: box.x + scroll.sx,
          y: box.y + scroll.sy,
          width: box.width,
          height: box.height,
          label: node.name.length > 0 ? node.name : node.role,
        })
      }
      const outcome = buildLegend(entries, legendClip, width, height)
      rects = outcome.rects
      rectsTruncated = outcome.truncated
    }

    let finalPath = path
    if (request.annotate && rects !== undefined && rects.length > 0) {
      finalPath = await annotatePng(path, rects)
    }

    let inline: string | undefined
    let inlineOmitted = false
    if (request.inline) {
      if (buffer.byteLength <= request.inlineMaxBytes) {
        inline = buffer.toString('base64')
      } else {
        inlineOmitted = true
      }
    }

    return {
      ok: true,
      path: finalPath,
      format: request.format,
      byteSize,
      width,
      height,
      cssWidth: Math.round(cssWidth),
      cssHeight: Math.round(cssHeight),
      deviceScaleFactor: observation.deviceScaleFactor,
      fullPage: request.fullPage,
      viewport: { width: observation.width, height: observation.height },
      ...(request.selector !== undefined ? { selector: request.selector } : {}),
      ...(rects !== undefined ? { rects } : {}),
      ...(request.rects || request.annotate ? { rectsTruncated } : {}),
      ...(coordinateSpace !== undefined ? { coordinateSpace } : {}),
      ...(inline !== undefined ? { inline } : {}),
      ...(request.inline ? { inlineOmitted } : {}),
      durationMs: Date.now() - startedAt,
    }
  }

  /** Resolve a CSS selector to its document-space rect; empty output is never possible. */
  private async resolveSelectorRect(selector: string, sessionId: string): Promise<SelectorRect> {
    const reply = asRecord(await this.ctx.send('Runtime.evaluate', {
      expression: selectorExpression(selector),
      returnByValue: true,
    }, sessionId))
    const value = asRecord(asRecord(reply?.result)?.value)
    if (value === undefined || value.found !== true) {
      throw new CdpScreenshotSelectorError(`no match in top document for ${JSON.stringify(selector)}; the element may be inside a frame (workstream 08 frame contexts)`)
    }
    const x = typeof value.x === 'number' ? value.x : Number.NaN
    const y = typeof value.y === 'number' ? value.y : Number.NaN
    const width = typeof value.width === 'number' ? value.width : Number.NaN
    const height = typeof value.height === 'number' ? value.height : Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
      throw new CdpScreenshotSelectorError(`${JSON.stringify(selector)} matched an element with an empty box (width=${String(width)}, height=${String(height)})`)
    }
    return { x, y, width, height }
  }

  /** The viewport capture region expressed in document coordinates. */
  private async viewportClip(sessionId: string, observation: ViewportObservation): Promise<ScreenshotClip> {
    const scroll = await this.readScroll(sessionId)
    return {
      x: scroll.sx,
      y: scroll.sy,
      width: observation.width > 0 ? observation.width : 1,
      height: observation.height > 0 ? observation.height : 1,
      scale: 1,
    }
  }

  /** Current scroll offsets; legend rects arrive in viewport coordinates. */
  private async readScroll(sessionId: string): Promise<PageScroll> {
    try {
      const reply = asRecord(await this.ctx.send('Runtime.evaluate', {
        expression: scrollExpression(),
        returnByValue: true,
      }, sessionId))
      const value = asRecord(asRecord(reply?.result)?.value)
      const sx = typeof value?.sx === 'number' && Number.isFinite(value.sx) ? value.sx : 0
      const sy = typeof value?.sy === 'number' && Number.isFinite(value.sy) ? value.sy : 0
      return { sx, sy }
    } catch {
      return { sx: 0, sy: 0 }
    }
  }
}

/** plan15-viewport: the CSS-pixel metrics one viewport answer carries. */
export interface ViewportMetrics {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  readonly mobile: boolean
}

/**
 * plan15-viewport: how the page-side counter answered one viewport change.
 * `unverified` is NOT `delivered` — a probe that could not be installed or
 * read never claims the page's resize handler ran, and never fails the call
 * either: absence of evidence is not evidence of a broken resize.
 */
export type ResizeDelivery = 'delivered' | 'not-delivered' | 'unverified'

/**
 * plan15-viewport: page-side evidence that the page's OWN `resize` handler
 * really ran. This is the measurement the pre-fix tool never took: it
 * verified the override with a metrics read alone, so a viewport change that
 * the page never heard about still answered "applied" while a reflowing
 * target could move under the agent's feet.
 */
export interface ViewportResizeProbe {
  /** Whether a `resize` event provably reached the page during the change. */
  readonly delivered: ResizeDelivery
  /** How many `resize` events the page counted between the two reads. */
  readonly events?: number
  /** The page's `document.visibilityState` at the post-change read. */
  readonly visibilityState?: string
  /** The page's `document.hidden` at the post-change read. */
  readonly documentHidden?: boolean
}

/** plan15-viewport: a successful viewport change, verified against the page. */
export interface ViewportApplySuccess {
  readonly ok: true
  readonly viewport: ViewportMetrics
  readonly source: ViewportObservation['source']
  /** False when the call only reported, or the live probe did not confirm the override. */
  readonly applied: boolean
  /**
   * plan15-viewport: the viewport measured at the instant the `Emulation.*`
   * call went out. `reset` is not atomic — a parallel agent sharing the same
   * window can move it between this measurement and the dispatch — so the
   * number this call actually acted on is reported next to the number it
   * verified, instead of quietly claiming the latter.
   */
  readonly appliedViewport?: ViewportMetrics
  /** plan15-viewport: proof (or honest absence of proof) that the page resized. */
  readonly resizeEvent?: ViewportResizeProbe
}

/**
 * plan15-viewport: an honest in-band failure. `reason` names what was not
 * delivered and what to do about it; `error` carries the thrown envelope of
 * a rejected call. Both are optional because the tool layer folds a thrown
 * error into `error` while the service itself answers with `reason`.
 */
export interface ViewportApplyFailure {
  readonly ok: false
  /** plan15-viewport: what was not delivered, and what the caller should do. */
  readonly reason?: string
  /** The viewport the page ended up at, when the post-change probe could read it. */
  readonly viewport?: ViewportMetrics
  /** The viewport measured at the instant the `Emulation.*` call went out. */
  readonly appliedViewport?: ViewportMetrics
  /** plan15-viewport: the page-side counter that produced this failure. */
  readonly resizeEvent?: ViewportResizeProbe
  /** The thrown envelope of a rejected call, when the tool layer folded one. */
  readonly error?: { readonly name: string; readonly message: string }
}

/** Result of `Emulation.setDeviceMetricsOverride` / clear, verified against the live page. */
export type ViewportApplyOutcome = ViewportApplySuccess | ViewportApplyFailure

/**
 * plan15-viewport: arm the page-side resize counter.
 *
 * Installs ONE capture-phase `resize` listener on `window` (re-arming reuses
 * the existing one, so repeated viewport calls never stack listeners), zeroes
 * the counter, and mirrors the probe object onto the `window.__resizeProbe`
 * name as well as the namespaced one. The listener records the CSS size the
 * page saw at the moment it fired, so a delivered-but-empty resize is still
 * distinguishable from silence. No backticks inside: the expression travels
 * verbatim to the page and is asserted byte-for-byte by the tests.
 */
export const RESIZE_PROBE_ARM_EXPRESSION = String.raw`(() => {
  try {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return JSON.stringify({ ok: false, why: 'no-window' });
    }
    var probe = window.__dshResizeProbe;
    if (!probe || typeof probe.n !== 'number') {
      probe = { n: 0, w: 0, h: 0, fn: null };
      probe.fn = function () {
        probe.n = probe.n + 1;
        probe.w = window.innerWidth;
        probe.h = window.innerHeight;
      };
      window.__dshResizeProbe = probe;
      window.__resizeProbe = probe;
      window.addEventListener('resize', probe.fn, true);
    }
    probe.n = 0;
    return JSON.stringify({
      ok: true,
      n: 0,
      w: window.innerWidth,
      h: window.innerHeight,
      state: String(document.visibilityState || ''),
      hidden: document.hidden === true
    });
  } catch (error) {
    return JSON.stringify({ ok: false, why: 'arm-threw' });
  }
})()`

/**
 * plan15-viewport: read the armed counter back. `n` is the number of `resize`
 * events the page's own listener actually received since the arm, and
 * `liveW`/`liveH` are the CSS size the page holds right now — so a viewport
 * the browser changed without notifying the page is visible as a size change
 * with a zero counter. No backticks inside: see the arm expression.
 */
export const RESIZE_PROBE_READ_EXPRESSION = String.raw`(() => {
  try {
    var probe = window.__dshResizeProbe;
    if (!probe || typeof probe.n !== 'number') return JSON.stringify({ ok: false, why: 'not-armed' });
    return JSON.stringify({
      ok: true,
      n: probe.n,
      w: probe.w,
      h: probe.h,
      state: String(document.visibilityState || ''),
      hidden: document.hidden === true,
      liveW: window.innerWidth,
      liveH: window.innerHeight
    });
  } catch (error) {
    return JSON.stringify({ ok: false, why: 'read-threw' });
  }
})()`

/** plan15-viewport: what one page-side counter read back. */
export interface ResizeProbeReading {
  /** `resize` events the page's own listener received since the arm. */
  readonly events: number
  /** CSS width the page recorded at its last `resize` event. */
  readonly observedWidth: number
  /** CSS height the page recorded at its last `resize` event. */
  readonly observedHeight: number
  /** The page's `document.visibilityState`, when it reported one. */
  readonly visibilityState?: string
  /** The page's `document.hidden`, when it reported it. */
  readonly documentHidden?: boolean
}

/**
 * plan15-viewport: read one counter answer.
 *
 * Accepts the raw `returnByValue` payload or an already-parsed record, and
 * returns `undefined` for anything it cannot trust — a missing `ok: true`, a
 * non-numeric counter, an unparseable string. A counter this tool could not
 * read is never reported as `0`, because "I could not measure" and "the page
 * was not told" are different findings and only the second is a failure.
 * @param raw - the `returnByValue` payload, or the parsed record.
 * @returns the reading, or undefined when the answer is unusable.
 */
export function parseResizeProbeAnswer(raw: unknown): ResizeProbeReading | undefined {
  let record: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    if (raw === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    record = parsed as Record<string, unknown>
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    record = raw as Record<string, unknown>
  }
  if (record === undefined || record.ok !== true) return undefined
  if (typeof record.n !== 'number' || !Number.isFinite(record.n)) return undefined
  return {
    events: record.n,
    observedWidth: typeof record.w === 'number' ? record.w : 0,
    observedHeight: typeof record.h === 'number' ? record.h : 0,
    ...(typeof record.state === 'string' && record.state !== '' ? { visibilityState: record.state } : {}),
    ...(typeof record.hidden === 'boolean' ? { documentHidden: record.hidden } : {}),
  }
}

/**
 * plan15-viewport: the honest reason a viewport change that the browser
 * accepted but the page never heard about gets.
 *
 * The pre-fix tool reported such a change as applied, so an agent asking for
 * a "freshly measured" rect was handed a number the page had never reflowed
 * to. The reason names the page-side state that was read (unknown when it
 * could not be read) and points at the one thing that does deliver a resize
 * event. No backticks inside: the string is asserted by the tests.
 * @param probe - the counter reading that produced the failure.
 * @returns the caller-facing reason sentence.
 */
export function resizeNotDeliveredReason(probe: ViewportResizeProbe | undefined): string {
  const state = probe?.visibilityState ?? 'unknown'
  const hidden = typeof probe?.documentHidden === 'boolean' ? String(probe.documentHidden) : 'unknown'
  return `page resize event not delivered (visibilityState=${state}, document.hidden=${hidden}); re-measure after a real window resize`
}

/** plan15-viewport: `492x780 css @dpr2`, the size phrase one answer carries. */
function sizePhrase(metrics: { readonly width?: number; readonly height?: number; readonly deviceScaleFactor?: number } | undefined): string {
  if (metrics === undefined) return 'no measurement'
  return `${String(metrics.width ?? 0)}x${String(metrics.height ?? 0)} css @dpr${String(metrics.deviceScaleFactor ?? 1)}`
}

/** plan15-viewport: the page-side evidence, in one short clause. */
function resizePhrase(probe: { readonly delivered?: string; readonly events?: number } | undefined): string {
  if (probe === undefined) return 'page resize event unverified (no page-side counter)'
  if (probe.delivered === 'delivered') return `page resize delivered (${String(probe.events ?? 0)} event(s))`
  if (probe.delivered === 'not-delivered') return 'page resize NOT delivered (0 events seen by the page)'
  return 'page resize unverified (the page-side counter could not be read)'
}

/**
 * plan15-viewport: the value shape the renderer accepts.
 *
 * The tool runtime hands `render` whatever the output schema validated, not
 * the strict outcome, so the renderer reads the envelope structurally —
 * every field optional, every number defaulted. Rendering must never throw on
 * a partial value, and an absent field has to read as "unknown", not as zero.
 */
export interface RenderableViewportOutcome {
  readonly ok?: boolean
  readonly viewport?: { readonly width?: number; readonly height?: number; readonly deviceScaleFactor?: number; readonly mobile?: boolean }
  readonly source?: string
  readonly applied?: boolean
  readonly appliedViewport?: { readonly width?: number; readonly height?: number; readonly deviceScaleFactor?: number; readonly mobile?: boolean }
  readonly resizeEvent?: { readonly delivered?: string; readonly events?: number; readonly visibilityState?: string; readonly documentHidden?: boolean }
  readonly reason?: string
  readonly error?: { readonly name?: string; readonly message?: string }
}

/**
 * plan15-viewport: the model-facing line for one `cdp_viewport` outcome.
 *
 * plan15-viewport: a failure that carries a `reason` renders THAT — the
 * pre-fix render only understood `error`, so a resize the page never received
 * would have printed as an unexplained "failed with unknown error". A success
 * now names the page-side delivery and, when the number we acted on differs
 * from the number we verified, both.
 * @param outcome - the outcome to render.
 * @returns the single text block for the tool card.
 */
export function renderViewportOutcomeText(outcome: RenderableViewportOutcome): string {
  if (outcome.ok !== true) {
    if (outcome.reason !== undefined) {
      const measured = outcome.viewport === undefined ? '' : ` [measured ${sizePhrase(outcome.viewport)}]`
      const actedOn = outcome.appliedViewport === undefined ? '' : ` [acted on ${sizePhrase(outcome.appliedViewport)}]`
      return `Viewport FAILED: ${outcome.reason}${measured}${actedOn} — ${resizePhrase(outcome.resizeEvent)}.`
    }
    return `Viewport call failed: ${outcome.error?.name ?? 'Error'}: ${outcome.error?.message ?? 'unknown error'}`
  }
  const head = outcome.applied === true ? 'Viewport applied' : 'Viewport (report only)'
  const actedOn = outcome.appliedViewport === undefined
    ? ''
    : ` [acted on ${sizePhrase(outcome.appliedViewport)}]`
  return `${head}: ${sizePhrase(outcome.viewport)}${outcome.viewport?.mobile === true ? ' mobile' : ''} [${outcome.source ?? 'unavailable'}].${actedOn} ${resizePhrase(outcome.resizeEvent)}.`
}

/** Loose arguments `cdp_viewport` and its route accept. */
export interface ViewportApplyArgs {
  readonly width?: number
  readonly height?: number
  readonly deviceScaleFactor?: number
  readonly mobile?: boolean
  readonly reset?: boolean
  readonly targetId?: string
}
