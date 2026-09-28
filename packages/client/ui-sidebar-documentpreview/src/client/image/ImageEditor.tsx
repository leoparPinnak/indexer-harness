/**
 * The annotation surface inside the preview window: the picture on a canvas, the
 * drawing tools above it, and the two save actions.
 *
 * The canvas is sized in IMAGE pixels while the element is styled to the drawn
 * size, so what a stroke records is what the export contains at the picture's own
 * resolution whatever the zoom is. Cropping replaces the base bitmap with the
 * region and moves every mark into its coordinates, so the visible surface and
 * the exported file always agree. Saving flattens the canvas to a PNG and posts
 * it to the host route, which writes it into the session workspace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  EDITOR_COLORS, EDITOR_WIDTHS, cropRectOf, hitShape, paintShapes, shapeBounds, shapeOf, toImagePoint, translateShape,
  type CropRect, type EditorTool, type Point, type Shape,
} from './annotate.ts'
import css from './ImageEditor.module.css'

/** The save route, mirroring the sandbox routes' shape. */
const WRITE_URL = '/api/server/image-write'

/** How far from a mark's outline a click still grabs it, in CSS pixels. */
const HIT_TOLERANCE = 6

/** Save outcome shown next to the buttons. */
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** Everything the editor needs from its window and its document. */
export interface ImageEditorProps {
  /** Blob URL of the picture. */
  readonly url: string
  /** CSS pixels per image pixel the picture is currently drawn at. */
  readonly scale: number
  /** Pan offset in CSS pixels. */
  readonly offset: Point
  /** Pan the picture; the editor forwards drags when the pan tool is active. */
  readonly onPan: (offset: Point) => void
  /** Maximum pan offset in CSS pixels, per axis. */
  readonly maxOffset: Point
  /** Report the picture's current pixel size: its own on load, the region's after a crop. */
  readonly onResize: (size: { readonly width: number; readonly height: number }) => void
  /** Absolute path of the file being edited, or undefined when unknown. */
  readonly absolutePath: string | undefined
  /** The Session the file belongs to. */
  readonly sessionId: string
  /** The file's own name, carried onto a downloaded PNG. */
  readonly name: string
  /** Localized copy. */
  readonly labels: EditorLabels
}

/** Localized copy for the editor's toolbar and save line. */
export interface EditorLabels {
  readonly tools: Readonly<Record<EditorTool, string>>
  readonly colors: string
  readonly width: string
  readonly cropApply: string
  readonly undo: string
  readonly clear: string
  readonly delete: string
  readonly copy: string
  readonly download: string
  readonly copied: string
  readonly copyFailed: string
  readonly save: string
  readonly saveCopy: string
  readonly saving: string
  readonly saved: string
  readonly failed: string
  readonly noPath: string
}

/** The picture's own pixel size. */
interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Clamp a value into a range.
 * @param value - candidate value.
 * @param min - smallest allowed value.
 * @param max - largest allowed value.
 * @returns the value held between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Draw one picture, annotate it, crop it, and save the result.
 * @param props - the picture, its scale and pan, and the save target.
 * @returns the tool row, the canvas, and the save line.
 */
export function ImageEditor({
  url, scale, offset, onPan, maxOffset, onResize, absolutePath, sessionId, name, labels,
}: ImageEditorProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sourceRef = useRef<HTMLImageElement | null>(null)
  /** The picture as drawn so far: the decoded file, then the cropped region. */
  const baseRef = useRef<HTMLCanvasElement | undefined>(undefined)
  const [size, setSize] = useState<Size>()
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<EditorTool>('pan')
  const [color, setColor] = useState<string>(EDITOR_COLORS[0])
  const [width, setWidth] = useState<number>(EDITOR_WIDTHS[1])
  const [shapes, setShapes] = useState<readonly Shape[]>([])
  const [selected, setSelected] = useState<number>()
  const [draft, setDraft] = useState<Shape>()
  const [crop, setCrop] = useState<CropRect>()
  const [save, setSave] = useState<SaveState>('idle')
  const [saveLine, setSaveLine] = useState('')

  /** Copy one drawn surface into a fresh offscreen canvas. */
  const offscreen = useCallback((width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context !== null) draw(context)
    return canvas
  }, [])

  /** Take the decoded file as the base bitmap and report its size. */
  const onSourceLoad = useCallback((): void => {
    const source = sourceRef.current
    if (source === null || source.naturalWidth === 0 || source.naturalHeight === 0) return
    const next = { width: source.naturalWidth, height: source.naturalHeight }
    baseRef.current = offscreen(next.width, next.height, (context) => {
      context.drawImage(source, 0, 0, next.width, next.height)
    })
    setSize(next)
    setReady(true)
    onResize(next)
  }, [offscreen, onResize])

  // Repaint whenever anything visible changes. The base is an offscreen canvas,
  // so each repaint is one blit plus the marks.
  useEffect(() => {
    const canvas = canvasRef.current
    const base = baseRef.current
    const context = canvas?.getContext('2d')
    if (canvas === null || base === undefined || context === null || context === undefined) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(base, 0, 0)
    paintShapes(context, draft === undefined ? shapes : [...shapes, draft])
    if (crop !== undefined) {
      context.save()
      context.strokeStyle = '#0a84ff'
      context.lineWidth = Math.max(1, canvas.width / 400)
      context.setLineDash([canvas.width / 150, canvas.width / 300])
      context.strokeRect(crop.x, crop.y, crop.width, crop.height)
      context.restore()
    }
    // The selected mark keeps a dashed frame so the reader can see what a drag
    // will move and what Delete will remove.
    const chosen = selected === undefined ? undefined : shapes[selected]
    if (chosen !== undefined) {
      const bounds = shapeBounds(chosen)
      context.save()
      context.strokeStyle = '#0a84ff'
      context.lineWidth = Math.max(1, canvas.width / 400)
      context.setLineDash([canvas.width / 200, canvas.width / 300])
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
      context.restore()
    }
  }, [shapes, draft, crop, selected, ready, size])

  // Delete removes the selected mark. The preview window owns Escape separately.
  useEffect(() => {
    if (selected === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      event.preventDefault()
      setShapes(previous => previous.filter((_mark, index) => index !== selected))
      setSelected(undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [selected])

  const drawing = tool !== 'pan' && tool !== 'crop'

  /** Follow one pointer on the window, so a drag survives leaving the canvas. */
  const follow = useCallback((
    onMove: (clientX: number, clientY: number) => void,
    onEnd: () => void,
  ): void => {
    const move = (event: PointerEvent): void => { onMove(event.clientX, event.clientY) }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      onEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const pointOf = (clientX: number, clientY: number): Point =>
      toImagePoint({ x: clientX - rect.left, y: clientY - rect.top }, scale)
    const start = pointOf(event.clientX, event.clientY)

    if (tool === 'pan') {
      const origin = offset
      const startX = event.clientX
      const startY = event.clientY
      follow(
        (clientX, clientY) => {
          onPan({
            x: clamp(origin.x + clientX - startX, -maxOffset.x, maxOffset.x),
            y: clamp(origin.y + clientY - startY, -maxOffset.y, maxOffset.y),
          })
        },
        () => {},
      )
      return
    }

    if (tool === 'crop') {
      const bounds = size ?? { width: 0, height: 0 }
      setCrop(cropRectOf(start, start, bounds))
      follow(
        (clientX, clientY) => { setCrop(cropRectOf(start, pointOf(clientX, clientY), bounds)) },
        () => {},
      )
      return
    }

    if (tool === 'select') {
      const index = hitShape(shapes, start, HIT_TOLERANCE / scale)
      setSelected(index)
      const target = index === undefined ? undefined : shapes[index]
      if (target === undefined) return
      follow(
        (clientX, clientY) => {
          const at = pointOf(clientX, clientY)
          setShapes(previous => previous.map((mark, position) =>
            position === index ? translateShape(target, at.x - start.x, at.y - start.y) : mark))
        },
        () => {},
      )
      return
    }

    const stroke = { color, width }
    let trail: Point[] = [start]
    let last = start
    setDraft(tool === 'pen' ? { kind: 'pen', ...stroke, points: trail } : { kind: tool, ...stroke, from: start, to: start })
    follow(
      (clientX, clientY) => {
        last = pointOf(clientX, clientY)
        if (tool === 'pen') {
          trail = [...trail, last]
          setDraft({ kind: 'pen', ...stroke, points: trail })
          return
        }
        setDraft({ kind: tool, ...stroke, from: start, to: last })
      },
      () => {
        const finished = shapeOf(tool, stroke, start, last, trail)
        if (finished !== undefined) setShapes(previous => [...previous, finished])
        setDraft(undefined)
      },
    )
  }

  /** Replace the base with the framed region and move every mark into it. */
  const applyCrop = (): void => {
    const base = baseRef.current
    if (crop === undefined || base === undefined || size === undefined) return
    const region = crop
    baseRef.current = offscreen(region.width, region.height, (context) => {
      context.drawImage(base, -region.x, -region.y)
    })
    setShapes(previous => previous.map(shape => translateShape(shape, -region.x, -region.y)))
    const next = { width: region.width, height: region.height }
    setSize(next)
    setCrop(undefined)
    onResize(next)
  }

  /** Flatten the canvas and post it to the host. */
  const submit = (mode: 'overwrite' | 'copy'): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    if (absolutePath === undefined) {
      setSave('failed')
      setSaveLine(labels.noPath)
      return
    }
    setSave('saving')
    setSaveLine(labels.saving)
    void (async () => {
      try {
        const dataUrl = canvas.toDataURL('image/png')
        const response = await fetch(WRITE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            path: absolutePath,
            mode,
            dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          }),
        })
        const result = await response.json() as { ok?: boolean; path?: string; error?: string }
        if (result.ok === true) {
          setSave('saved')
          setSaveLine(`${labels.saved} ${result.path ?? ''}`.trim())
          return
        }
        setSave('failed')
        setSaveLine(result.error ?? labels.failed)
      } catch (error: unknown) {
        setSave('failed')
        setSaveLine(error instanceof Error ? error.message : labels.failed)
      }
    })()
  }

  /** Flatten the canvas to a PNG blob, or undefined when there is no canvas yet. */
  const flatten = async (): Promise<Blob | undefined> => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => { resolve(blob ?? undefined) }, 'image/png')
    })
  }

  /** Put the flattened picture on the system clipboard. */
  const copyImage = (): void => {
    void (async () => {
      try {
        // A browser without the async clipboard has no PNG clipboard item either,
        // so both refusals reach the reader as the same line.
        if (typeof ClipboardItem === 'undefined' || navigator.clipboard === undefined) {
          throw new Error(labels.copyFailed)
        }
        const blob = await flatten()
        if (blob === undefined) throw new Error(labels.copyFailed)
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setSave('saved')
        setSaveLine(labels.copied)
      } catch {
        // The clipboard refused the write or this browser cannot build the item;
        // the reader needs the same line either way, and the cause is not actionable.
        setSave('failed')
        setSaveLine(labels.copyFailed)
      }
    })()
  }

  /** Hand the flattened picture to the browser as a download. */
  const downloadImage = (): void => {
    void (async () => {
      const blob = await flatten()
      if (blob === undefined) {
        setSave('failed')
        setSaveLine(labels.failed)
        return
      }
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = `${name.replace(/\.[^./\\]+$/u, '')}.png`
      link.click()
      URL.revokeObjectURL(href)
    })()
  }

  return (
    <div className={css.editor} data-image-editor>
      <div className={css.toolbar} data-image-editor-toolbar>
        {(Object.keys(labels.tools) as EditorTool[]).map(name => (
          <button
            key={name}
            type="button"
            className={name === tool ? css.toolActive : css.tool}
            aria-pressed={name === tool}
            data-image-editor-tool={name}
            title={labels.tools[name]}
            onClick={() => { setTool(name); setCrop(undefined); setSelected(undefined) }}
          >
            {labels.tools[name]}
          </button>
        ))}
        {tool === 'crop' && (
          <button
            type="button"
            className={css.savePrimary}
            disabled={crop === undefined}
            data-image-editor-crop-apply
            title={labels.cropApply}
            onClick={applyCrop}
          >
            {labels.cropApply}
          </button>
        )}
        <span className={css.divider} />
        {EDITOR_COLORS.map(value => (
          <button
            key={value}
            type="button"
            className={value === color ? css.swatchActive : css.swatch}
            style={{ background: value }}
            aria-label={`${labels.colors} ${value}`}
            aria-pressed={value === color}
            data-image-editor-color={value}
            onClick={() => { setColor(value) }}
          />
        ))}
        <span className={css.divider} />
        {EDITOR_WIDTHS.map(value => (
          <button
            key={value}
            type="button"
            className={value === width ? css.toolActive : css.tool}
            aria-pressed={value === width}
            data-image-editor-width={value}
            title={`${labels.width} ${String(value)}`}
            onClick={() => { setWidth(value) }}
          >
            {value}
          </button>
        ))}
        <span className={css.divider} />
        <button
          type="button"
          className={css.tool}
          disabled={shapes.length === 0}
          data-image-editor-undo
          title={labels.undo}
          onClick={() => { setShapes(previous => previous.slice(0, -1)); setSelected(undefined) }}
        >
          ↶
        </button>
        <button
          type="button"
          className={css.tool}
          disabled={shapes.length === 0}
          data-image-editor-clear
          title={labels.clear}
          onClick={() => { setShapes([]); setSelected(undefined) }}
        >
          ⌫
        </button>
        <button
          type="button"
          className={css.tool}
          disabled={selected === undefined}
          data-image-editor-delete
          title={labels.delete}
          onClick={() => {
            setShapes(previous => previous.filter((_mark, index) => index !== selected))
            setSelected(undefined)
          }}
        >
          ⌦
        </button>
        <span className={css.divider} />
        <button
          type="button"
          className={css.tool}
          disabled={!ready}
          data-image-editor-copy
          title={labels.copy}
          onClick={copyImage}
        >
          ⧉
        </button>
        <button
          type="button"
          className={css.tool}
          disabled={!ready}
          data-image-editor-download
          title={labels.download}
          onClick={downloadImage}
        >
          ⤓
        </button>
        <span className={css.grow} />
        <button
          type="button"
          className={css.save}
          disabled={!ready || save === 'saving'}
          data-image-editor-save-copy
          onClick={() => { submit('copy') }}
        >
          {labels.saveCopy}
        </button>
        <button
          type="button"
          className={css.savePrimary}
          disabled={!ready || save === 'saving'}
          data-image-editor-save
          onClick={() => { submit('overwrite') }}
        >
          {labels.save}
        </button>
      </div>
      <div className={css.surface}>
        {size !== undefined && (
          <canvas
            ref={canvasRef}
            className={css.canvas}
            width={size.width}
            height={size.height}
            style={{
              width: `${String(size.width * scale)}px`,
              height: `${String(size.height * scale)}px`,
              transform: `translate(${String(offset.x)}px, ${String(offset.y)}px)`,
              cursor: tool === 'select' ? 'default' : drawing || tool === 'crop' ? 'crosshair' : 'grab',
            }}
            onPointerDown={onPointerDown}
            data-image-editor-canvas
          />
        )}
        {/* A decoded source for the base bitmap; never shown. */}
        <img
          ref={sourceRef}
          className={css.hidden}
          src={url}
          alt=""
          decoding="sync"
          onLoad={onSourceLoad}
        />
      </div>
      {saveLine !== '' && (
        <p className={save === 'failed' ? css.saveFailed : css.saveLine} role="status" data-image-editor-status>
          {saveLine}
        </p>
      )}
    </div>
  )
}
