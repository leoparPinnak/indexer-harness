/**
 * The image body's floating preview window.
 *
 * The pane's own view always fits the whole picture, so reading fine detail
 * needs a surface that is not bound to the pane: this window can be moved,
 * resized, and zoomed inside one frame. Zoom is expressed in DEVICE pixels per
 * image pixel, so 100% is the picture's real resolution on the display rather
 * than a CSS-pixel count that a scaled display would double. The window is
 * portalled to the document so no pane ancestor can clip it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageEditor } from './ImageEditor.tsx'
import type { EditorLabels } from './ImageEditor.tsx'
import { ZOOM_STEP, anchoredOffset, clampZoom, wheelZoomFactor } from './zoom.ts'
import type { Point } from './zoom.ts'
import css from './ImagePreviewWindow.module.css'

/** Smallest window the reader can resize to, in CSS pixels. */
const MIN_WIDTH = 360
const MIN_HEIGHT = 240

/** Largest window the reader can resize to, in CSS pixels. */
const MAX_WIDTH = 2400
const MAX_HEIGHT = 1600

/** Padding between the window's body and the picture, in CSS pixels. */
const BODY_PADDING = 8

/** Title bar height, in CSS pixels (mirrors the sheet). */
const TITLE_BAR = 36

/** Editor chrome (the tool row) above the picture, in CSS pixels. */
const EDITOR_TOOLBAR = 33

/** One window rectangle, in CSS pixels. */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The picture's own pixel size. */
interface Size {
  width: number
  height: number
}

/** A drag in progress over the title bar or the resize grip. */
interface Drag {
  readonly kind: 'move' | 'resize'
}

/**
 * Clamp one value into a range.
 * @param value - candidate value.
 * @param min - smallest allowed value.
 * @param max - largest allowed value.
 * @returns the value held between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The window a fresh preview opens in: centred, most of the viewport, never
 * smaller than the resize minimum.
 * @returns the initial rectangle.
 */
function initialRect(): Rect {
  const width = clamp(Math.round(window.innerWidth * 0.7), MIN_WIDTH, MAX_WIDTH)
  const height = clamp(Math.round(window.innerHeight * 0.7), MIN_HEIGHT, MAX_HEIGHT)
  return {
    x: Math.max(0, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(0, Math.round((window.innerHeight - height) / 2)),
    width,
    height,
  }
}

/** Props of the floating preview. */
export interface ImagePreviewWindowProps {
  /** Blob URL of the picture to draw. */
  readonly url: string
  /** The file's name, shown in the title bar. */
  readonly name: string
  /** Size of the file as it was loaded, in bytes. */
  readonly byteLength: number
  /** The file's format as the info line spells it, e.g. `PNG`. */
  readonly format: string
  /** Absolute path of the file the editor saves to, or undefined when unknown. */
  readonly absolutePath: string | undefined
  /** The Session the file belongs to. */
  readonly sessionId: string
  /** Accessible name of the picture and localized control copy. */
  readonly labels: {
    readonly preview: string
    readonly close: string
    readonly zoomIn: string
    readonly zoomOut: string
    readonly fit: string
    readonly actual: string
    readonly percent: string
    readonly dimensions: string
  }
  /** Localized copy for the annotation toolbar and its save line. */
  readonly editor: EditorLabels
  /** Close the window. */
  readonly onClose: () => void
}

/**
 * Draw one picture in a movable, resizable, zoomable window.
 * @param props - the picture, its copy, the editor labels, and the close callback.
 * @returns the window, portalled to the document.
 */
export function ImagePreviewWindow({
  url, name, byteLength, format, absolutePath, sessionId, labels, editor: editorLabels, onClose,
}: ImagePreviewWindowProps): ReactNode {
  const [rect, setRect] = useState<Rect>(initialRect)
  const [size, setSize] = useState<Size>()
  const [zoom, setZoom] = useState<number>()
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1

  // The editor reports the picture's size on load and after every crop, and a
  // new size refits: a cropped picture larger than the frame stays readable.
  const onResize = useCallback((next: Size): void => {
    setSize(next)
    setZoom(undefined)
    setOffset({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  /** Body area available to the picture, in CSS pixels. */
  const viewport = {
    width: Math.max(1, rect.width - BODY_PADDING * 2),
    height: Math.max(1, rect.height - TITLE_BAR - EDITOR_TOOLBAR - BODY_PADDING * 2),
  }
  const fitZoom = size === undefined
    ? 1
    : Math.min(
      (viewport.width * ratio) / size.width,
      (viewport.height * ratio) / size.height,
    )
  const effectiveZoom = zoom ?? fitZoom
  /**
   * How far the picture may be panned at one zoom, per axis.
   *
   * The drawn size in CSS pixels is image pixels times the zoom divided by the
   * display ratio, so one image pixel covers `zoom` device pixels.
   * @param at - the zoom to measure.
   * @returns the largest offset the picture supports on each axis.
   */
  const maxOffsetAt = (at: number): Point => size === undefined
    ? { x: 0, y: 0 }
    : {
      x: Math.max(0, (size.width * at / ratio - viewport.width) / 2),
      y: Math.max(0, (size.height * at / ratio - viewport.height) / 2),
    }
  const maxOffset = maxOffsetAt(effectiveZoom)
  const shownOffset = {
    x: clamp(offset.x, -maxOffset.x, maxOffset.x),
    y: clamp(offset.y, -maxOffset.y, maxOffset.y),
  }
  const percent = Math.round(effectiveZoom * 100)

  /** The explicit controls refit: a pan the new zoom cannot hold would be lost anyway. */
  const applyZoom = (next: number): void => {
    setZoom(clampZoom(next))
    setOffset({ x: 0, y: 0 })
  }

  const bodyRef = useRef<HTMLDivElement | null>(null)

  // The wheel is listened for natively because React registers `onWheel` as a
  // passive listener at the root, and cancelling the event is what keeps the page
  // behind the window from scrolling. The zoom follows the pointer, so the detail
  // under the cursor stays under it however far the reader zooms.
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const next = clampZoom(effectiveZoom * wheelZoomFactor(event.deltaY, event.deltaMode, viewport.height))
      if (next === effectiveZoom) return
      const bounds = body.getBoundingClientRect()
      const held = anchoredOffset(
        {
          x: event.clientX - bounds.left - BODY_PADDING,
          y: event.clientY - bounds.top - BODY_PADDING,
        },
        viewport,
        shownOffset,
        effectiveZoom / ratio,
        next / ratio,
      )
      const limit = maxOffsetAt(next)
      setZoom(next)
      setOffset({ x: clamp(held.x, -limit.x, limit.x), y: clamp(held.y, -limit.y, limit.y) })
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => { body.removeEventListener('wheel', onWheel) }
  })

  /**
   * Follow one pointer until it is released.
   *
   * The listeners live on the window rather than the handle, so a fast drag that
   * leaves the title bar keeps moving the window instead of stopping at its edge.
   * @param onMove - called with each pointer position.
   */
  const followPointer = (onMove: (clientX: number, clientY: number) => void): void => {
    const move = (moveEvent: PointerEvent): void => { onMove(moveEvent.clientX, moveEvent.clientY) }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const startDrag = (kind: Drag['kind'], startX: number, startY: number): void => {
    const origin = rect
    followPointer((clientX, clientY) => {
      const dx = clientX - startX
      const dy = clientY - startY
      if (kind === 'move') {
        setRect({
          ...origin,
          x: clamp(origin.x + dx, -origin.width + 120, window.innerWidth - 120),
          y: clamp(origin.y + dy, 0, window.innerHeight - TITLE_BAR),
        })
        return
      }
      setRect({
        ...origin,
        width: clamp(origin.width + dx, MIN_WIDTH, MAX_WIDTH),
        height: clamp(origin.height + dy, MIN_HEIGHT, MAX_HEIGHT),
      })
    })
  }

  const onPointerDown = (kind: Drag['kind']) => (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    startDrag(kind, event.clientX, event.clientY)
  }

  return createPortal(
    <div
      className={css.window}
      style={{ left: `${String(rect.x)}px`, top: `${String(rect.y)}px`, width: `${String(rect.width)}px`, height: `${String(rect.height)}px` }}
      role="dialog"
      aria-label={labels.preview}
      data-image-preview-window
    >
      <div
        className={css.titleBar}
        onPointerDown={onPointerDown('move')}
        data-image-preview-drag
      >
        <span className={css.title} title={name}>{name}</span>
        <div className={css.info} data-image-preview-info>
          {size !== undefined && (
            <span data-image-preview-dimensions>
              {labels.dimensions.replace('{width}', String(size.width)).replace('{height}', String(size.height))}
            </span>
          )}
          <span data-image-preview-size>{fileSizeText(byteLength)}</span>
          <span data-image-preview-format>{format}</span>
        </div>
        <div className={css.controls}>
          <button type="button" className={css.control} aria-label={labels.zoomOut} title={labels.zoomOut} data-image-preview-zoom-out onClick={() => { applyZoom(effectiveZoom / ZOOM_STEP) }}>−</button>
          <span className={css.percent} data-image-preview-percent>{labels.percent.replace('{percent}', String(percent))}</span>
          <button type="button" className={css.control} aria-label={labels.zoomIn} title={labels.zoomIn} data-image-preview-zoom-in onClick={() => { applyZoom(effectiveZoom * ZOOM_STEP) }}>+</button>
          <button type="button" className={css.controlWide} title={labels.fit} data-image-preview-fit onClick={() => { applyZoom(fitZoom) }}>{labels.fit}</button>
          <button type="button" className={css.controlWide} title={labels.actual} data-image-preview-actual onClick={() => { applyZoom(1) }}>{labels.actual}</button>
          <button type="button" className={css.control} aria-label={labels.close} title={labels.close} data-image-preview-close onClick={onClose}>✕</button>
        </div>
      </div>
      <div className={css.body} ref={bodyRef} data-image-preview-body>
        <ImageEditor
          url={url}
          scale={effectiveZoom / ratio}
          offset={shownOffset}
          onPan={setOffset}
          maxOffset={maxOffset}
          onResize={onResize}
          absolutePath={absolutePath}
          sessionId={sessionId}
          name={name}
          labels={editorLabels}
        />
      </div>
      <div
        className={css.grip}
        onPointerDown={onPointerDown('resize')}
        data-image-preview-grip
      />
    </div>,
    document.body,
  )
}
