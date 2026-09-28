// @vitest-environment jsdom
/** Image Blob ownership, media types, intrinsic rendering, and failure states. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImageBody, imageFormat, imageMediaType, paneMaxOffset, type ImageBodyProps } from '../src/client/image/ImageBody.tsx'
import { en } from '../src/client/image/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

function props(path = 'asset.png', data: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])): ImageBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/image/${path}`,
    content: { kind: 'bytes', data },
    wrap: false,
    sessionId: 'image' as SessionId,
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: (key, params) => {
      const value = translations.get(key) ?? key
      return params === undefined ? value : value.replace('{name}', String(params.name))
    },
  } as ImageBodyProps
}

describe('ImageBody', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
    ['svg', 'image/svg+xml'],
  ] as const)('assigns .%s bytes the %s Blob media type', async (extension, mediaType) => {
    const view = render(<ImageBody {...props(`asset.${extension}`)} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    expect(image.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('keeps the image unscaled and non-draggable, then shows it after decoding succeeds', async () => {
    render(<ImageBody {...props('photo.svg')} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(image.getAttribute('alt')).toBe('Image preview: photo.svg')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.getAttribute('draggable')).toBe('false')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.hasAttribute('hidden')).toBe(true)
    fireEvent.load(image)
    expect(image.hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('revokes replaced bytes and reports image decode and Blob creation failures', async () => {
    const initial = props()
    const view = render(<ImageBody {...initial} />)
    const first = await screen.findByRole('img', { hidden: true })
    fireEvent.error(first)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    const changed = props('asset.png', new Uint8Array([4, 5, 6]))
    view.rerender(<ImageBody {...changed} />)
    await screen.findByRole('img', { hidden: true })
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    create.mockImplementationOnce(() => { throw new Error('Blob unavailable') })
    view.rerender(<ImageBody {...props('changed.png', new Uint8Array([7]))} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/2')
  })

  it('rejects text delivery and an unregistered suffix without creating a Blob', () => {
    const initial = props()
    const view = render(<ImageBody {...initial} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<ImageBody {...props('asset.unknown')} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })

  it('offers the floating window only once the picture is decoded, and closes it again', async () => {
    render(<ImageBody {...props('shot.png')} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(screen.queryByRole('button', { name: en['window.open'] })).toBeNull()
    fireEvent.load(image)
    fireEvent.click(screen.getByRole('button', { name: en['window.open'] }))
    expect(screen.getByRole('dialog').getAttribute('data-image-preview-window')).toBe('true')
    fireEvent.click(screen.getByTitle(en['window.close']))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(imageMediaType('folder/PHOTO.JPEG')).toBe('image/jpeg')
    expect(imageMediaType('folder/no-extension')).toBeUndefined()
    expect(imageMediaType('folder/photo.avif')).toBeUndefined()
  })

  it('names the format the info line shows, and only for registered suffixes', () => {
    expect(imageFormat('folder/PHOTO.JPEG')).toBe('JPEG')
    expect(imageFormat('folder/shot.svg')).toBe('SVG')
    expect(imageFormat('folder/no-extension')).toBeUndefined()
    expect(imageFormat('folder/photo.avif')).toBeUndefined()
  })
})

/**
 * Give jsdom the layout the pane measures: a 500x400 frame around an 800x600
 * fitted picture, which leaves room to pan once the zoom passes the fit.
 */
async function laidOut() {
  render(<ImageBody {...props('shot.png')} />)
  const image = await screen.findByRole('img', { hidden: true })
  fireEvent.load(image)
  Object.defineProperty(image, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(image, 'offsetHeight', { configurable: true, value: 600 })
  const frame = document.querySelector('[data-image-preview]') as HTMLElement
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400 }) as DOMRect
  return { image, frame }
}

/** The scale the pane currently applies, read from the rendered transform. */
function paneScale(image: HTMLElement): number {
  return Number(/scale\(([\d.]+)\)/u.exec(image.style.transform)?.[1])
}

describe('the pane\'s own zoom and pan', () => {
  it('zooms about the pointer by a bounded step, and returns to fit on a double click', async () => {
    const { image, frame } = await laidOut()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')

    // A cursor at the frame's centre holds the offset still, so only the scale moves.
    fireEvent.wheel(frame, { deltaY: -100, clientX: 250, clientY: 200 })
    const zoomed = paneScale(image)
    expect(zoomed).toBeGreaterThan(1)

    // No single event may leap: the clamp bounds the step per event, so however
    // large one delta is, the scale moves by at most that one bounded factor.
    fireEvent.wheel(frame, { deltaY: -100_000, clientX: 250, clientY: 200 })
    expect(paneScale(image) / zoomed).toBeCloseTo(1.18, 5)

    fireEvent.doubleClick(image)
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('never zooms the pane below the fitted view', async () => {
    const { image, frame } = await laidOut()
    fireEvent.wheel(frame, { deltaY: 100_000, clientX: 250, clientY: 200 })
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('pans a zoomed picture by dragging, and stops when the pointer is released', async () => {
    const { image, frame } = await laidOut()
    fireEvent.wheel(frame, { deltaY: -100_000, clientX: 250, clientY: 200 })

    fireEvent.pointerDown(image, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 200, clientY: 150 })
    expect(image.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerUp(window)
    const panned = image.style.transform
    fireEvent.pointerMove(window, { clientX: 900, clientY: 900 })
    expect(image.style.transform).toBe(panned)
  })

  it('leaves the fitted picture alone when it is dragged', async () => {
    const { image } = await laidOut()
    fireEvent.pointerDown(image, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 200, clientY: 150 })
    fireEvent.pointerUp(window)
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('allows no travel while the scaled picture still fits the frame', () => {
    const content = { width: 500, height: 400 }
    const fitted = { width: 500, height: 400 }
    expect(paneMaxOffset(1, content, fitted)).toEqual({ x: 0, y: 0 })
    expect(paneMaxOffset(2, content, fitted)).toEqual({ x: 250, y: 200 })
    expect(paneMaxOffset(2, { width: 2000, height: 2000 }, fitted)).toEqual({ x: 0, y: 0 })
  })
})
