// @vitest-environment jsdom
/**
 * The annotation editor: a drag records one shape in image pixels, undo and
 * clear take them back, and save flattens the canvas to the host route.
 *
 * jsdom has no 2D context and no `toDataURL`, so both are stubbed here; the
 * geometry itself is covered by the annotate spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImageEditor, type ImageEditorProps } from '../src/client/image/ImageEditor.tsx'
import { en } from '../src/client/image/locales.ts'

const labels: ImageEditorProps['labels'] = {
  tools: {
    pan: en['editor.pan'],
    crop: en['editor.crop'],
    select: en['editor.select'],
    pen: en['editor.pen'],
    line: en['editor.line'],
    arrow: en['editor.arrow'],
    rect: en['editor.rect'],
  },
  colors: en['editor.colors'],
  width: en['editor.width'],
  cropApply: en['editor.cropApply'],
  undo: en['editor.undo'],
  clear: en['editor.clear'],
  delete: en['editor.delete'],
  copy: en['editor.copy'],
  download: en['editor.download'],
  copied: en['editor.copied'],
  copyFailed: en['editor.copyFailed'],
  save: en['editor.save'],
  saveCopy: en['editor.saveCopy'],
  saving: en['editor.saving'],
  saved: en['editor.saved'],
  failed: en['editor.failed'],
  noPath: en['editor.noPath'],
}

const drawn = { strokes: 0, fills: 0 }
let contextDescriptor: PropertyDescriptor | undefined
let dataUrlDescriptor: PropertyDescriptor | undefined
let blobDescriptor: PropertyDescriptor | undefined
let createUrlDescriptor: PropertyDescriptor | undefined
let revokeUrlDescriptor: PropertyDescriptor | undefined
const toDataURL = vi.fn(() => 'data:image/png;base64,QUJD')
const pngBlob = new Blob(['QUJD'], { type: 'image/png' })
const toBlob = vi.fn((callback: BlobCallback) => { callback(pngBlob) })
const createObjectURL = vi.fn(() => 'blob:https://preview.invalid/png')
const revokeObjectURL = vi.fn()
/** Download names the editor asked the browser to save, in call order. */
const downloads: string[] = []

beforeEach(() => {
  drawn.strokes = 0
  drawn.fills = 0
  downloads.length = 0
  toDataURL.mockClear()
  toBlob.mockClear()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  dataUrlDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL')
  blobDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')
  createUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', { configurable: true, value: toBlob })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
      stroke: () => { drawn.strokes += 1 },
      fill: () => { drawn.fills += 1 },
      strokeRect: () => { drawn.strokes += 1 },
      save: () => {}, restore: () => {}, setLineDash: () => {},
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    }),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', { configurable: true, value: toDataURL })
})

afterEach(() => {
  try { cleanup() } finally {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'clipboard')
    if (contextDescriptor === undefined) Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
    else Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', contextDescriptor)
    if (dataUrlDescriptor === undefined) Reflect.deleteProperty(HTMLCanvasElement.prototype, 'toDataURL')
    else Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', dataUrlDescriptor)
    if (blobDescriptor === undefined) Reflect.deleteProperty(HTMLCanvasElement.prototype, 'toBlob')
    else Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', blobDescriptor)
    if (createUrlDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createUrlDescriptor)
    if (revokeUrlDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeUrlDescriptor)
  }
})

/** Records what the browser was asked to save when the editor triggers a download. */
vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
  downloads.push(this.download)
})

function open(overrides: Partial<ImageEditorProps> = {}) {
  const onPan = vi.fn()
  const onResize = vi.fn()
  const view = render(
    <ImageEditor
      url="blob:https://preview.invalid/1"
      scale={0.5}
      offset={{ x: 0, y: 0 }}
      onPan={onPan}
      maxOffset={{ x: 100, y: 100 }}
      onResize={onResize}
      absolutePath="C:/work/shot.png"
      sessionId="s-image"
      name="shot.png"
      labels={labels}
      {...overrides}
    />,
  )
  // The hidden source decodes instantly in a browser; jsdom needs the signal.
  const source = document.querySelector('[data-image-editor] img') as HTMLImageElement
  Object.defineProperty(source, 'naturalWidth', { configurable: true, value: 3600 })
  Object.defineProperty(source, 'naturalHeight', { configurable: true, value: 2400 })
  fireEvent.load(source)
  const canvas = document.querySelector('[data-image-editor-canvas]') as HTMLCanvasElement
  return { view, canvas, onPan, onResize }
}

/** Drag one shape across the canvas, in CSS pixels relative to the canvas. */
function drag(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  fireEvent.pointerDown(canvas, { clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(window)
}

const undo = () => document.querySelector('[data-image-editor-undo]') as HTMLButtonElement

/** The delete-mark control, enabled only while a mark is selected. */
const remove = () => document.querySelector('[data-image-editor-delete]') as HTMLButtonElement

describe('ImageEditor', () => {
  it('records one shape per drag and takes it back with undo and clear', () => {
    const { canvas } = open()
    expect(undo().disabled).toBe(true)

    fireEvent.click(screen.getByTitle(en['editor.line']))
    drag(canvas, { x: 10, y: 10 }, { x: 60, y: 40 })
    expect(undo().disabled).toBe(false)
    expect(drawn.strokes).toBeGreaterThan(0)

    const clear = document.querySelector('[data-image-editor-clear]') as HTMLButtonElement
    fireEvent.click(clear)
    expect(undo().disabled).toBe(true)
  })

  it('paints a pen trail across the drag and an arrow head as a fill', () => {
    const { canvas } = open()
    fireEvent.click(screen.getByTitle(en['editor.pen']))
    drag(canvas, { x: 5, y: 5 }, { x: 40, y: 40 })
    expect(drawn.strokes).toBeGreaterThan(0)

    drawn.fills = 0
    fireEvent.click(screen.getByTitle(en['editor.arrow']))
    drag(canvas, { x: 0, y: 0 }, { x: 80, y: 20 })
    expect(drawn.fills).toBeGreaterThan(0)
  })

  it('pans with the move tool instead of drawing', () => {
    const { canvas, onPan } = open()
    drag(canvas, { x: 10, y: 10 }, { x: 60, y: 40 })
    expect(onPan).toHaveBeenCalledWith({ x: 50, y: 30 })
    expect(drawn.strokes).toBe(0)
    expect(undo().disabled).toBe(true)
  })

  it('grabs a mark with the select tool and translates it instead of drawing a second one', () => {
    const { canvas } = open()
    fireEvent.click(screen.getByTitle(en['editor.line']))
    // Scale 0.5: this drag draws image pixels 20..220 along y=20.
    drag(canvas, { x: 10, y: 10 }, { x: 110, y: 10 })

    expect(remove().disabled).toBe(true)
    fireEvent.click(screen.getByTitle(en['editor.select']))
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 10 })
    fireEvent.pointerUp(window)
    expect(remove().disabled).toBe(false)

    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 })
    fireEvent.pointerUp(window)

    // One undo empties the picture, so the drag moved the mark rather than
    // adding another: a second mark would survive the single undo.
    fireEvent.click(undo())
    expect(undo().disabled).toBe(true)
    expect(remove().disabled).toBe(true)
  })

  it('removes the selected mark from the toolbar', () => {
    const { canvas } = open()
    fireEvent.click(screen.getByTitle(en['editor.line']))
    drag(canvas, { x: 10, y: 10 }, { x: 110, y: 10 })
    fireEvent.click(screen.getByTitle(en['editor.select']))
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 10 })
    fireEvent.pointerUp(window)

    fireEvent.click(remove())
    expect(remove().disabled).toBe(true)
    expect(undo().disabled).toBe(true)
  })

  it('removes the selected mark from the keyboard and drops it when the tool changes', () => {
    const { canvas } = open()
    fireEvent.click(screen.getByTitle(en['editor.line']))
    drag(canvas, { x: 10, y: 10 }, { x: 110, y: 10 })
    fireEvent.click(screen.getByTitle(en['editor.select']))
    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 10 })
    fireEvent.pointerUp(window)
    expect(remove().disabled).toBe(false)

    fireEvent.keyDown(window, { key: 'Delete' })
    expect(remove().disabled).toBe(true)
    expect(undo().disabled).toBe(true)
  })

  it('selects nothing when the select tool is dragged over empty space', () => {
    const { canvas } = open()
    fireEvent.click(screen.getByTitle(en['editor.line']))
    drag(canvas, { x: 10, y: 10 }, { x: 110, y: 10 })
    fireEvent.click(screen.getByTitle(en['editor.select']))

    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400 })
    fireEvent.pointerMove(window, { clientX: 500, clientY: 500 })
    fireEvent.pointerUp(window)
    expect(remove().disabled).toBe(true)
    // The mark it never grabbed is still there.
    expect(undo().disabled).toBe(false)

    fireEvent.pointerDown(canvas, { clientX: 60, clientY: 10 })
    fireEvent.pointerUp(window)
    expect(remove().disabled).toBe(false)
    fireEvent.click(screen.getByTitle(en['editor.pen']))
    expect(remove().disabled).toBe(true)
  })

  it('flattens the canvas and posts it to the host in the chosen mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, path: 'C:/work/shot.png' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    open()

    fireEvent.click(screen.getByText(en['editor.save']))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('C:/work/shot.png') })
    expect(toDataURL).toHaveBeenCalledWith('image/png')
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('/api/server/image-write')
    expect(JSON.parse(init.body)).toEqual({
      sessionId: 's-image',
      path: 'C:/work/shot.png',
      mode: 'overwrite',
      dataBase64: 'QUJD',
    })
  })

  it('copies beside the original when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, path: 'C:/work/shot.annotated.png' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    open()
    fireEvent.click(screen.getByText(en['editor.saveCopy']))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect((JSON.parse(init.body) as { mode: string }).mode).toBe('copy')
  })

  it('puts the flattened picture on the clipboard', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: unknown) {} })
    open()

    fireEvent.click(screen.getByTitle(en['editor.copy']))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en['editor.copied']) })
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reports a clipboard that refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: unknown) {} })
    open()

    fireEvent.click(screen.getByTitle(en['editor.copy']))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en['editor.copyFailed']) })
  })

  it('reports a browser that cannot build a PNG clipboard item at all', async () => {
    open()
    fireEvent.click(screen.getByTitle(en['editor.copy']))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en['editor.copyFailed']) })
  })

  it('hands the flattened picture to the browser as a PNG download', async () => {
    open()
    fireEvent.click(screen.getByTitle(en['editor.download']))
    await waitFor(() => { expect(downloads).toEqual(['shot.png']) })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://preview.invalid/png')
  })

  it('reports the picture size on load and after a crop replaces the base', () => {
    const { canvas, onResize } = open()
    expect(onResize).toHaveBeenLastCalledWith({ width: 3600, height: 2400 })
    expect([canvas.width, canvas.height]).toEqual([3600, 2400])

    fireEvent.click(screen.getByTitle(en['editor.crop']))
    const apply = document.querySelector('[data-image-editor-crop-apply]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    // Scale 0.5: a drag from (100,100) to (500,300) frames image pixels 200..1000 x 200..600.
    drag(canvas, { x: 100, y: 100 }, { x: 500, y: 300 })
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    expect(onResize).toHaveBeenLastCalledWith({ width: 800, height: 400 })
    const cropped = document.querySelector('[data-image-editor-canvas]') as HTMLCanvasElement
    expect([cropped.width, cropped.height]).toEqual([800, 400])
  })

  it('moves every mark into the cropped coordinates', () => {
    const { canvas, onResize } = open()
    fireEvent.click(screen.getByTitle(en['editor.line']))
    drag(canvas, { x: 100, y: 100 }, { x: 200, y: 200 })
    fireEvent.click(screen.getByTitle(en['editor.crop']))
    drag(canvas, { x: 80, y: 80 }, { x: 400, y: 400 })
    fireEvent.click(document.querySelector('[data-image-editor-crop-apply]') as HTMLButtonElement)
    // The frame is image pixels 160..800, so the mark that started at 200 now
    // starts at 40 — it stays in the same place on the picture.
    expect(onResize).toHaveBeenLastCalledWith({ width: 640, height: 640 })
    expect(document.querySelector('[data-image-editor-undo]')).not.toBeNull()
  })

  it('reports a refused save and refuses to guess a path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'path is outside the session workspace' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    open()
    fireEvent.click(screen.getByText(en['editor.save']))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('path is outside the session workspace') })

    cleanup()
    open({ absolutePath: undefined })
    fireEvent.click(screen.getByText(en['editor.save']))
    expect(screen.getByRole('status').textContent).toBe(en['editor.noPath'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
