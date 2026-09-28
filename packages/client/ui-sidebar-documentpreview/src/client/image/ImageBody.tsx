/** Complete image bytes fitted to the pane, with a window for real-resolution reading. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import { ImagePreviewWindow } from './ImagePreviewWindow.tsx'
import { ZOOM_MAX, anchoredOffset, wheelZoomFactor } from './zoom.ts'
import type { Point } from './zoom.ts'
import type {} from './locales.ts'
import css from './ImageBody.module.css'

/** Padding between the frame and the picture, in CSS pixels (mirrors the sheet). */
const FRAME_PADDING = 8

/**
 * Hold a value inside a range.
 * @param value - candidate value.
 * @param min - smallest allowed value.
 * @param max - largest allowed value.
 * @returns the value held between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** A width and a height, in CSS pixels. */
interface Size {
  readonly width: number
  readonly height: number
}

/**
 * How far the picture may be dragged at one scale, per axis.
 *
 * The pane scales the already-fitted picture about its centre, so the travel is
 * half of whatever the scaled picture has beyond the frame — never negative.
 * @param scale - the pane's zoom, relative to the fitted size.
 * @param content - the frame's content box, in CSS pixels.
 * @param fitted - the picture's fitted size, in CSS pixels.
 * @returns the largest offset the picture supports on each axis.
 */
export function paneMaxOffset(scale: number, content: Size, fitted: Size): Point {
  return {
    x: Math.max(0, (fitted.width * scale - content.width) / 2),
    y: Math.max(0, (fitted.height * scale - content.height) / 2),
  }
}

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
} as const

type ImageMediaType = typeof IMAGE_MEDIA_TYPES[keyof typeof IMAGE_MEDIA_TYPES]

/** Standard document props plus the image renderer's dictionary. */
export type ImageBodyProps = DocumentPreviewProps & PropsLocale<'sidebarImage'>

type ImageSource =
  | {
    readonly kind: 'ready'
    readonly data: Uint8Array<ArrayBuffer>
    readonly mediaType: ImageMediaType
    readonly url: string
  }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: ImageMediaType }

/**
 * The lowercased suffix of one workspace path.
 * @param path - decoded workspace file path.
 * @returns the text after the last dot, or the whole name when it carries none.
 */
function suffixOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  return name.slice(name.lastIndexOf('.') + 1)
}

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the image media type, or undefined for an unregistered suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[suffixOf(path) as keyof typeof IMAGE_MEDIA_TYPES]
}

/**
 * The format the preview's info line names for one supported filename.
 * @param path - decoded workspace file path.
 * @returns the uppercased suffix, or undefined for an unregistered one.
 */
export function imageFormat(path: string): string | undefined {
  const suffix = suffixOf(path)
  return IMAGE_MEDIA_TYPES[suffix as keyof typeof IMAGE_MEDIA_TYPES] === undefined
    ? undefined
    : suffix.toUpperCase()
}

/**
 * Present complete image bytes fitted to the pane, with a control that opens
 * the picture in its own window.
 *
 * The frame is the whole body: the picture is bounded by both maxima, so a
 * large screenshot scales down instead of asking for scrollbars, and the window
 * is where real-resolution reading and, later, annotation happen.
 * @param props - document bytes, resource identity, and locale.
 * @returns the fitted picture and its open-window control.
 */
export function ImageBody({ content, resourceAddress, sessionId, useResource, t }: ImageBodyProps): ReactNode {
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  // The editor saves to the absolute path the resource reports; without one it
  // can still draw, and says so instead of guessing a location.
  const absolutePath = useResource<'file'>(resourceAddress).value?.absolutePath
  const mediaType = imageMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<ImageSource>()

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, mediaType, url })
    } catch {
      setSource({ kind: 'failed', data, mediaType })
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data || source.mediaType !== mediaType) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  if (source.kind === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(path)
  return (
    <LoadedImage
      key={source.url}
      url={source.url}
      name={name}
      format={imageFormat(path) ?? ''}
      byteLength={data.byteLength}
      absolutePath={absolutePath}
      sessionId={sessionId}
      t={t}
    />
  )
}

/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, format, byteLength, absolutePath, sessionId, t }: {
  readonly url: string
  readonly name: string
  readonly format: string
  readonly byteLength: number
  readonly absolutePath: string | undefined
  readonly sessionId: string
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [preview, setPreview] = useState(false)
  const labels = {
    preview: t('preview', { name }),
    close: t('window.close'),
    zoomIn: t('window.zoomIn'),
    zoomOut: t('window.zoomOut'),
    fit: t('window.fit'),
    actual: t('window.actual'),
    percent: t('window.percent'),
    dimensions: t('info.dimensions'),
  }
  const editor = {
    tools: {
      pan: t('editor.pan'),
      crop: t('editor.crop'),
      select: t('editor.select'),
      pen: t('editor.pen'),
      line: t('editor.line'),
      arrow: t('editor.arrow'),
      rect: t('editor.rect'),
    },
    colors: t('editor.colors'),
    width: t('editor.width'),
    cropApply: t('editor.cropApply'),
    undo: t('editor.undo'),
    clear: t('editor.clear'),
    delete: t('editor.delete'),
    copy: t('editor.copy'),
    download: t('editor.download'),
    copied: t('editor.copied'),
    copyFailed: t('editor.copyFailed'),
    save: t('editor.save'),
    saveCopy: t('editor.saveCopy'),
    saving: t('editor.saving'),
    saved: t('editor.saved'),
    failed: t('editor.failed'),
    noPath: t('editor.noPath'),
  }

  const frameRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  /**
   * Measure what the pointer and the zoom are relative to.
   * @returns the frame's content box and the picture's fitted size, or undefined before layout.
   */
  const measure = (): { content: Size; fitted: Size } | undefined => {
    const frame = frameRef.current
    const image = imageRef.current
    if (frame === null || image === null) return undefined
    const rect = frame.getBoundingClientRect()
    return {
      content: {
        width: Math.max(1, rect.width - FRAME_PADDING * 2),
        height: Math.max(1, rect.height - FRAME_PADDING * 2),
      },
      fitted: { width: image.offsetWidth, height: image.offsetHeight },
    }
  }

  // The pane zooms about the pointer too. The shared body stops scrolling while an
  // image is shown, so cancelling the wheel here hides nothing from the reader.
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = measure()
      if (box === undefined) return
      const next = Math.min(
        ZOOM_MAX,
        Math.max(1, scale * wheelZoomFactor(event.deltaY, event.deltaMode, box.content.height)),
      )
      if (next === scale) return
      const bounds = frame.getBoundingClientRect()
      const held = anchoredOffset(
        { x: event.clientX - bounds.left - FRAME_PADDING, y: event.clientY - bounds.top - FRAME_PADDING },
        box.content,
        offset,
        scale,
        next,
      )
      const limit = paneMaxOffset(next, box.content, box.fitted)
      setScale(next)
      setOffset({ x: clamp(held.x, -limit.x, limit.x), y: clamp(held.y, -limit.y, limit.y) })
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => { frame.removeEventListener('wheel', onWheel) }
  })

  /** Drag the picture inside the frame; at the fitted scale there is nothing to drag. */
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const box = measure()
    if (scale === 1 || box === undefined) return
    event.preventDefault()
    const limit = paneMaxOffset(scale, box.content, box.fitted)
    const origin = offset
    const startX = event.clientX
    const startY = event.clientY
    const move = (moveEvent: PointerEvent): void => {
      setOffset({
        x: clamp(origin.x + moveEvent.clientX - startX, -limit.x, limit.x),
        y: clamp(origin.y + moveEvent.clientY - startY, -limit.y, limit.y),
      })
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setDragging(false)
    }
    setDragging(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** Double-click returns the pane to its fitted view. */
  const onDoubleClick = (): void => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  return <div className={css.frame} ref={frameRef} data-image-preview>
    {state === 'loading' && <LoadingIndicator className={css.status} label={t('loading')} />}
    {state === 'failed' && <p className={css.status} role="alert">{t('failed')}</p>}
    <img
      ref={imageRef}
      className={css.image}
      src={url}
      alt={t('preview', { name })}
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      hidden={state !== 'ready'}
      style={{
        transform: `translate(${String(offset.x)}px, ${String(offset.y)}px) scale(${String(scale)})`,
        cursor: scale === 1 ? undefined : dragging ? 'grabbing' : 'grab',
      }}
      onLoad={() => { setState('ready') }}
      onError={() => { setState('failed') }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    />
    {state === 'ready' && (
      <button
        type="button"
        className={css.openButton}
        data-image-preview-open
        onClick={() => { setPreview(true) }}
      >
        {t('window.open')}
      </button>
    )}
    {preview && (
      <ImagePreviewWindow
        url={url}
        name={name}
        byteLength={byteLength}
        format={format}
        absolutePath={absolutePath}
        sessionId={sessionId}
        labels={labels}
        editor={editor}
        onClose={() => { setPreview(false) }}
      />
    )}
  </div>
}
