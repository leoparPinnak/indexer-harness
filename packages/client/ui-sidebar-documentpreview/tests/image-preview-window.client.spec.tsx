// @vitest-environment jsdom
/**
 * The floating image preview: the pane's control opens a window that draws the
 * same bytes, reports its zoom against the display's real resolution, and can be
 * moved and resized.
 *
 * The zoom cases pin the unit that matters: one image pixel covers `zoom` DEVICE
 * pixels, so 100% is the picture's real resolution rather than a CSS-pixel count
 * a scaled display would double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImagePreviewWindow, type ImagePreviewWindowProps } from '../src/client/image/ImagePreviewWindow.tsx'
import { en } from '../src/client/image/locales.ts'

let ratioDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  ratioDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  // A definite viewport keeps the window's initial rectangle deterministic.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
})

afterEach(() => {
  try { cleanup() } finally {
    if (ratioDescriptor === undefined) Reflect.deleteProperty(window, 'devicePixelRatio')
    else Object.defineProperty(window, 'devicePixelRatio', ratioDescriptor)
  }
})

const labels: ImagePreviewWindowProps['labels'] = {
  preview: 'Image preview: shot.png',
  close: en['window.close'],
  zoomIn: en['window.zoomIn'],
  zoomOut: en['window.zoomOut'],
  fit: en['window.fit'],
  actual: en['window.actual'],
  percent: en['window.percent'],
  dimensions: en['info.dimensions'],
}

const editor: ImagePreviewWindowProps['editor'] = {
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

function open(overrides: Partial<ImagePreviewWindowProps> = {}) {
  const onClose = vi.fn()
  const view = render(
    <ImagePreviewWindow
      url="blob:https://preview.invalid/1"
      name="shot.png"
      byteLength={2_447 * 1024}
      format="PNG"
      absolutePath={undefined}
      sessionId="s-image"
      labels={labels}
      editor={editor}
      onClose={onClose}
      {...overrides}
    />,
  )
  const probe = document.querySelector('[data-image-preview-body] img') as HTMLImageElement
  // jsdom never decodes: supply the natural size the load event would report.
  Object.defineProperty(probe, 'naturalWidth', { configurable: true, value: 3600 })
  Object.defineProperty(probe, 'naturalHeight', { configurable: true, value: 2400 })
  fireEvent.load(probe)
  return { view, onClose, editorCanvas: () => document.querySelector('[data-image-editor-canvas]') as HTMLCanvasElement }}

const percent = () => screen.getByText(/%$/u).textContent

describe('ImagePreviewWindow', () => {
  it('opens fitted, so the whole picture is visible before any zoom choice', () => {
    open()
    // Window 1120x700; the body loses the title bar, the tool row, and padding,
    // leaving 1104x615 CSS pixels for a 3600x2400 picture: height runs out first.
    expect(percent()).toBe('51%')
  })

  it('names the picture\'s own facts: pixel size, file size, and format', () => {
    open()
    // The size the load event reported, the bytes handed in, and the format.
    expect(screen.getByText('3600 × 2400')).toBeDefined()
    expect(screen.getByText('2.4MB')).toBeDefined()
    expect(screen.getByText('PNG')).toBeDefined()
  })

  it('reports zoom in device pixels per image pixel, so 1:1 is the real resolution', () => {
    const { editorCanvas } = open()
    fireEvent.click(screen.getByTitle(en['window.actual']))
    expect(percent()).toBe('100%')
    // 3600 image pixels at one device pixel each, on a 2x display: 1800 CSS px.
    expect(editorCanvas().style.width).toBe('1800px')
    expect(editorCanvas().style.height).toBe('1200px')
  })

  it('steps the zoom and returns to fit', () => {
    open()
    fireEvent.click(screen.getByTitle(en['window.zoomIn']))
    expect(percent()).toBe('64%')
    fireEvent.click(screen.getByTitle(en['window.zoomOut']))
    fireEvent.click(screen.getByTitle(en['window.zoomOut']))
    expect(percent()).toBe('41%')
    fireEvent.click(screen.getByTitle(en['window.fit']))
    expect(percent()).toBe('51%')
  })

  it('zooms by one bounded step per wheel event, so a single event cannot leap', () => {
    open()
    const body = document.querySelector('[data-image-preview-body]') as HTMLElement
    fireEvent.wheel(body, { deltaY: -100 })
    // exp(0.1) over the 51% fit lands near 57%, not the 64% a fixed 1.25x step gives.
    expect(percent()).toBe('57%')
  })

  it('carries a trackpad stream about as far as one mouse notch', () => {
    open()
    const body = document.querySelector('[data-image-preview-body]') as HTMLElement
    for (let step = 0; step < 20; step += 1) fireEvent.wheel(body, { deltaY: -5 })
    expect(percent()).toBe('57%')
  })

  it('keeps the pointed-at detail under the cursor while zooming', () => {
    const { editorCanvas } = open()
    const body = document.querySelector('[data-image-preview-body]') as HTMLElement
    fireEvent.wheel(body, { deltaY: -600, clientX: 552, clientY: 100 })
    expect(editorCanvas().style.transform).not.toBe('translate(0px, 0px)')
  })

  it('moves by its title bar and resizes by its grip', () => {
    open()
    const window_ = screen.getByRole('dialog')
    const before = { left: window_.style.left, width: window_.style.width }

    const bar = screen.getByTitle('shot.png')
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 160, clientY: 130 })
    fireEvent.pointerUp(window)
    expect(window_.style.left).not.toBe(before.left)

    const grip = document.querySelector('[data-image-preview-grip]') as HTMLElement
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 120, clientY: 80 })
    fireEvent.pointerUp(window)
    expect(window_.style.width).not.toBe(before.width)
  })

  it('pans a zoomed-in picture with the move tool and stops when the pointer is released', () => {
    const { editorCanvas } = open()
    fireEvent.click(screen.getByTitle(en['window.actual']))
    const canvas = editorCanvas()
    fireEvent.pointerDown(canvas, { clientX: 500, clientY: 400 })
    fireEvent.pointerMove(window, { clientX: 560, clientY: 460 })
    fireEvent.pointerUp(window)
    expect(canvas.style.transform).not.toBe('translate(0px, 0px)')
    const panned = canvas.style.transform
    fireEvent.pointerMove(window, { clientX: 900, clientY: 900 })
    expect(canvas.style.transform).toBe(panned)
  })

  it('closes from its own control and from Escape', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByTitle(en['window.close']))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
