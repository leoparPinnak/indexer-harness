/**
 * plan07 (F3) — stealth profile derivation and the deterministic-noise contracts.
 *
 * Every noise generator is seeded with a FIXED value (plan07 §8.3): the same
 * seed must yield byte-identical canvas/audio/rect/WebGL results in a FRESH
 * sandbox (simulating a separate page load), a repeat read inside one load must
 * be idempotent, and a different seed must change the output. Per-load
 * randomness would be a stronger tell than a stable fingerprint, so these
 * tests pin determinism across loads.
 *
 * The sandbox also proves the g9–g26 patches end-to-end against stubbed
 * browser globals: UA-CH coherence, window/screen coherence, connection,
 * cdc-vars removal, matchMedia/dpr coherence, and native-code toString.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { STEALTH_PATCH_NAMES, stealthScript } from '../src/stealth.ts'
import {
  DEFAULT_STEALTH_PROFILE,
  STEALTH_PROFILE_NAMES,
  WINDOWS_CHROME_PROFILE,
  deriveAcceptLanguage,
  deriveLaunchArgs,
  deriveStealthOptions,
  resolveStealthProfile,
} from '../src/stealth-profiles.ts'

const PAGE_WIDTH = 8
const PAGE_HEIGHT = 6
const PIXEL_COUNT = PAGE_WIDTH * PAGE_HEIGHT * 4
const UA_131 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Fixed source pixels — identical on every run, like one real page's canvas. */
function sourcePixels(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(PIXEL_COUNT)
  for (let index = 0; index < PIXEL_COUNT; index += 1) pixels[index] = (index * 7 + 13) % 256
  return pixels
}

interface PageSandbox {
  navigator: Record<string, any>
  document: Record<string, any>
  screen: Record<string, any>
  window: Record<string, any>
  matchMedia: (query: string) => { matches: boolean, media: string }
  makeCanvas: () => any
  makeElement: (x: number, y: number) => any
  makeAudioBuffer: (length: number) => any
  gl: any
  run: (code: string) => any
}

/**
 * Build a fresh "document": stub globals, apply the stealth script, and hand
 * back page-side constructors. Each call = one independent page load.
 * @param script - the script under test.
 * @returns handles into the sandbox.
 */
function makeSandbox(script: string): PageSandbox {
  const sandbox: Record<string, any> = {}

  class FakeImageData {
    width: number
    height: number
    data: Uint8ClampedArray
    constructor(width: number, height: number, data: Uint8ClampedArray) {
      this.width = width
      this.height = height
      this.data = data
    }
  }

  const readRegion = (
    pixels: Uint8ClampedArray,
    canvasWidth: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(sw * sh * 4)
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const from = ((sy + y) * canvasWidth + (sx + x)) * 4
        const to = (y * sw + x) * 4
        for (let channel = 0; channel < 4; channel += 1) out[to + channel] = pixels[from + channel] ?? 0
      }
    }
    return out
  }

  class FakeCtx {
    canvas: any
    constructor(canvas: any) {
      this.canvas = canvas
    }

    drawImage(source: any): void {
      this.canvas._pixels = Uint8ClampedArray.from(source._pixels)
    }

    getImageData(sx: number, sy: number, sw: number, sh: number): FakeImageData {
      return new FakeImageData(sw, sh, readRegion(this.canvas._pixels, this.canvas.width, sx, sy, sw, sh))
    }

    putImageData(image: FakeImageData): void {
      this.canvas._pixels = Uint8ClampedArray.from(image.data)
    }
  }

  class FakeCanvas {
    width = 0
    height = 0
    _pixels: Uint8ClampedArray = new Uint8ClampedArray(0)
    toDataURL(): string {
      return 'RAW:' + Array.from(this._pixels).join(',')
    }
  }

  const makeCanvas = (): any => {
    const canvas = Object.create(FakeCanvas.prototype) as any
    canvas.width = PAGE_WIDTH
    canvas.height = PAGE_HEIGHT
    canvas._pixels = sourcePixels()
    canvas.getContext = () => new FakeCtx(canvas)
    return canvas
  }

  class FakeAudioBuffer {
    _length: number
    _channel: Float32Array | null
    constructor(length: number) {
      this._length = length
      this._channel = null
    }

    getChannelData(): Float32Array {
      if (this._channel === null) this._channel = new Float32Array(this._length).fill(0.5)
      return this._channel
    }
  }

  class FakeElement {
    _x: number
    _y: number
    constructor(x: number, y: number) {
      this._x = x
      this._y = y
    }

    getBoundingClientRect(): Record<string, number> {
      return { x: this._x, y: this._y, width: 100, height: 20, left: this._x, top: this._y }
    }

    getClientRects(): Array<Record<string, number>> {
      return [{ x: this._x, y: this._y, width: 100, height: 20 }]
    }
  }

  class FakeWebGl {
    getParameter(): string {
      return 'stub'
    }

    getSupportedExtensions(): string[] {
      return ['WEBGL_debug_renderer_info', 'FAKE_extra_extension', 'OES_vertex_array_object']
    }

    getExtension(name: string): Record<string, string> {
      return { name }
    }

    readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, pixels: Uint8Array): void {
      pixels.fill(100)
    }
  }

  // plan07-fix: interface constructors a real Chrome page can read.
  // The plugin/mime patch must produce objects that satisfy them.
  class Plugin {}

  class PluginArray {}

  class MimeType {}

  class MimeTypeArray {}

  // plan07-fix (T1 §3D): a real Chrome navigator instance carries NOTHING as
  // own properties — every patched key lives behind Navigator.prototype.
  // The stub mirrors that shape, so prototype routing is exercised exactly as
  // a detector sees it and an own-property leak fails the new assertions.
  const userAgentDataProto: Record<string, any> = {}
  const connectionProto: Record<string, any> = {}
  const navigatorProto: Record<string, any> = {
    userAgent: UA_131,
    platform: 'Win32',
    language: 'pl-PL',
    languages: ['pl-PL', 'pl'],
    // Native headless answers: the profile must replace BOTH sides equally
    // (prototype + instance), never one half of them.
    webdriver: true,
    hardwareConcurrency: 32,
    deviceMemory: 32,
    maxTouchPoints: 0,
    userAgentData: Object.assign(Object.create(userAgentDataProto), {
      mobile: false,
      platform: 'Linux',
      brands: [{ brand: 'Not_A Brand', version: '99' }],
    }),
    permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
    mediaDevices: { enumerateDevices: () => Promise.resolve([]) },
    connection: Object.assign(Object.create(connectionProto), {
      effectiveType: 'slow-2g',
      rtt: 3000,
      downlink: 0.1,
      saveData: true,
    }),
    // Native headless: an EMPTY plugin/mime list.
    plugins: Object.assign(Object.create(PluginArray.prototype), { length: 0 }),
    mimeTypes: Object.assign(Object.create(MimeTypeArray.prototype), { length: 0 }),
  }
  const navigatorStub: Record<string, any> = Object.create(navigatorProto)

  const documentStub: Record<string, any> = {
    fonts: { status: 'loading' },
    $cdc_aslflpuoagpo: { secret: true },
    createElement: (tag: string) => {
      if (tag === 'canvas') return makeCanvas()
      throw new Error('unsupported element: ' + tag)
    },
  }

  sandbox.window = sandbox
  sandbox.innerWidth = 800
  sandbox.innerHeight = 600
  sandbox.devicePixelRatio = 1
  sandbox.screen = {
    width: 800,
    height: 600,
    availWidth: 800,
    availHeight: 600,
    colorDepth: 32,
    pixelDepth: 32,
  }
  // The native answer lies (matches: true for a 2dppx minimum at dpr = 1).
  sandbox.matchMedia = (query: string) => ({ matches: true, media: query })
  sandbox.navigator = navigatorStub
  sandbox.Plugin = Plugin
  sandbox.PluginArray = PluginArray
  sandbox.MimeType = MimeType
  sandbox.MimeTypeArray = MimeTypeArray
  sandbox.document = documentStub
  sandbox.HTMLCanvasElement = FakeCanvas
  sandbox.CanvasRenderingContext2D = FakeCtx
  sandbox.AudioBuffer = FakeAudioBuffer
  sandbox.Element = FakeElement
  sandbox.WebGLRenderingContext = FakeWebGl

  const context = createContext(sandbox as object)
  runInContext(script, context)

  return {
    navigator: navigatorStub,
    document: documentStub,
    screen: sandbox.screen,
    window: sandbox,
    // Patched by hairline during runInContext — built after application.
    matchMedia: sandbox.matchMedia,
    makeCanvas,
    makeElement: (x, y) => Object.assign(Object.create(FakeElement.prototype), { _x: x, _y: y }),
    makeAudioBuffer: length => new FakeAudioBuffer(length),
    gl: new FakeWebGl(),
    run: code => runInContext(code, context),
  }
}

const DEFAULT_SCRIPT = stealthScript()

describe('plan07 deterministic noise (seeded, never per-load random)', () => {
  it('canvas noise is byte-identical across loads, ≤1 per channel, and actually applied', () => {
    const first = makeSandbox(DEFAULT_SCRIPT)
    const second = makeSandbox(DEFAULT_SCRIPT)
    const a = first.makeCanvas().getContext('2d').getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    const b = second.makeCanvas().getContext('2d').getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    expect(Array.from(b.data)).toEqual(Array.from(a.data))

    const source = sourcePixels()
    let changed = 0
    for (let index = 0; index < PIXEL_COUNT; index += 1) {
      const delta = Math.abs((a.data[index] ?? 0) - (source[index] ?? 0))
      if (delta !== 0) changed += 1
      expect(delta).toBeLessThanOrEqual(1)
    }
    expect(changed).toBeGreaterThan(0)
  })

  it('keeps getImageData, a repeat read, and toDataURL mutually coherent', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    const canvas = sb.makeCanvas()
    const ctx = canvas.getContext('2d')
    const first = ctx.getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    const second = ctx.getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    expect(Array.from(second.data)).toEqual(Array.from(first.data))
    // toDataURL goes through a temp canvas — same content, same noise.
    expect(canvas.toDataURL()).toBe('RAW:' + Array.from(first.data).join(','))
  })

  it('a different seed changes the canvas noise', () => {
    const base = makeSandbox(DEFAULT_SCRIPT)
    const other = makeSandbox(stealthScript({ noiseSeed: 'plan07-other-seed' }))
    const a = base.makeCanvas().getContext('2d').getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    const b = other.makeCanvas().getContext('2d').getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    expect(Array.from(b.data)).not.toEqual(Array.from(a.data))
  })

  it('audio noise is deterministic across loads and idempotent per buffer', () => {
    const first = makeSandbox(DEFAULT_SCRIPT)
    const second = makeSandbox(DEFAULT_SCRIPT)
    const bufferA = first.makeAudioBuffer(1024)
    const bufferB = second.makeAudioBuffer(1024)
    const once = Array.from(bufferA.getChannelData(0)) as number[]
    const twice = Array.from(bufferA.getChannelData(0)) as number[]
    const otherLoad = Array.from(bufferB.getChannelData(0)) as number[]

    expect(twice).toEqual(once)
    expect(otherLoad).toEqual(once)
    expect(once.some(value => value !== 0.5)).toBe(true)
    // Float32 storage rounds ±1e-7 to ≤1.1920929e-7.
    for (const value of once) expect(Math.abs(value - 0.5)).toBeLessThanOrEqual(1.3e-7)
  })

  it('clientRects: same box → same offset in both APIs, stable across loads', () => {
    const first = makeSandbox(DEFAULT_SCRIPT)
    const second = makeSandbox(DEFAULT_SCRIPT)
    const element = first.makeElement(100.4, 50.6)
    const rect = element.getBoundingClientRect()
    const rects = element.getClientRects()

    expect(rect.x).toBeCloseTo(rects[0].x, 10)
    expect(rect.y).toBeCloseTo(rects[0].y, 10)
    const deltaX = rect.x - 100.4
    const deltaY = rect.y - 50.6
    expect(Math.abs(deltaX)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(deltaY)).toBeLessThanOrEqual(0.5)
    expect(deltaX !== 0 || deltaY !== 0).toBe(true)

    const rectAgain = second.makeElement(100.4, 50.6).getBoundingClientRect()
    expect(rectAgain.x).toBeCloseTo(rect.x, 10)
    expect(rectAgain.y).toBeCloseTo(rect.y, 10)
  })

  it('webgl readPixels noise is deterministic; the extension list drops extras', () => {
    const first = makeSandbox(DEFAULT_SCRIPT)
    const second = makeSandbox(DEFAULT_SCRIPT)

    // Emitted in PREFERRED order (intersection keeps the profile list's order).
    expect(first.gl.getSupportedExtensions()).toEqual(['OES_vertex_array_object', 'WEBGL_debug_renderer_info'])
    expect(first.gl.getExtension('FAKE_extra_extension')).toBeNull()
    expect(first.gl.getExtension('OES_vertex_array_object')).toEqual({ name: 'OES_vertex_array_object' })

    const pixelsA = new Uint8Array(300)
    pixelsA.fill(100)
    first.gl.readPixels(0, 0, 4, 4, 1, 1, pixelsA)
    const pixelsB = new Uint8Array(300)
    pixelsB.fill(100)
    second.gl.readPixels(0, 0, 4, 4, 1, 1, pixelsB)

    expect(Array.from(pixelsB)).toEqual(Array.from(pixelsA))
    for (const value of pixelsA) {
      expect(value === 100 || value === 101).toBe(true)
    }
    expect(Array.from(pixelsA).some(value => value === 101)).toBe(true)
  })
})

describe('plan07 g9–g26 patch effects (sandbox)', () => {
  it('applies webdriver/languages/platform defaults and UA-CH coherence (G1/G3/G4/G9)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    expect(sb.navigator.webdriver).toBe(false)
    expect(sb.navigator.platform).toBe('Win32')
    expect(sb.navigator.languages).toEqual(['en-US', 'en'])
    // UA-CH platform follows the patched navigator.platform, not the stale stub.
    expect(sb.navigator.userAgentData.platform).toBe('Windows')
    expect(sb.navigator.userAgentData.brands[0]).toEqual({ brand: 'Google Chrome', version: '131' })
    // deviceInfo overrides the degenerate stub values (G11).
    expect(sb.navigator.hardwareConcurrency).toBe(8)
    expect(sb.navigator.deviceMemory).toBe(8)
    // connection story (G14).
    expect(sb.navigator.connection.effectiveType).toBe('4g')
    expect(sb.navigator.connection.rtt).toBe(50)
    expect(sb.navigator.connection.downlink).toBe(10)
  })

  it('keeps window/screen coherent while never touching the inner viewport (G10)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    expect(sb.screen === undefined || typeof sb.screen === 'object').toBe(true)
    const sandboxScreen = makeSandbox(DEFAULT_SCRIPT)
    expect(sandboxScreen.screen.width).toBe(1920)
    expect(sandboxScreen.screen.height).toBe(1080)
    expect(sandboxScreen.screen.colorDepth).toBe(32)
  })

  it('removes cdc_ variables, settles fonts status, and fixes empty device lists (G12/G13/G19)', async () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    expect(sb.document.$cdc_aslflpuoagpo).toBeUndefined()
    expect(sb.document.fonts.status).toBe('loaded')
    expect(sb.navigator.fonts).toBe(sb.document.fonts)
    const devices = await sb.navigator.mediaDevices.enumerateDevices()
    expect(devices).toHaveLength(3)
    expect(devices[2].kind).toBe('videoinput')
    expect(devices[0].label).toBe('')
  })

  it('answers resolution matchMedia queries from the live devicePixelRatio (G17)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    // dpr = 1: a min-2dppx query cannot match, although the stub said true.
    expect(sb.matchMedia('(min-resolution: 2dppx)').matches).toBe(false)
    expect(sb.matchMedia('(min-resolution: 1dppx)').matches).toBe(true)
    // Non-resolution queries keep the native answer.
    expect(sb.matchMedia('(orientation: landscape)').matches).toBe(true)
  })

  it('provides chrome extras and masks our functions as native code (G8/G20/G21)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    expect(sb.window.chrome.csi().pageT).toBe(612)
    expect(sb.window.chrome.loadTimes().connectionInfo).toBe('h2')

    // plan07-fix: the override lives on the prototype (real Chrome shape),
    // never as an instance own key.
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sb.navigator), 'webdriver') as PropertyDescriptor
    expect(Object.prototype.hasOwnProperty.call(sb.navigator, 'webdriver')).toBe(false)
    expect(typeof descriptor.get).toBe('function')
    expect(descriptor.get?.toString()).toBe('function get webdriver() { [native code] }')
    expect(sb.run('Function.prototype.toString.toString()')).toContain('[native code]')
    // A page function keeps its real source — only OUR functions are masked.
    const pageSource = sb.run('var plan07PageFn = function hello() { return 42 }; plan07PageFn.toString()')
    expect(pageSource).toContain('return 42')
    // The legacy webgl getParameter wrapper is retro-registered.
    expect(sb.gl.getParameter.toString()).toContain('[native code]')
  })

  it('applies once: a second application to the same document is a no-op', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    const before = sb.navigator.userAgentData.platform
    expect(() => makeSandbox(DEFAULT_SCRIPT)).not.toThrow()
    expect(sb.navigator.webdriver).toBe(false)
    expect(sb.navigator.userAgentData.platform).toBe(before)
  })
})

describe('plan07 stealth profiles (single source of truth)', () => {
  it('resolves built-in profiles and rejects unknown ids by name', () => {
    expect(resolveStealthProfile()).toBe(DEFAULT_STEALTH_PROFILE)
    expect(resolveStealthProfile('windows-chrome')).toBe(WINDOWS_CHROME_PROFILE)
    expect(STEALTH_PROFILE_NAMES).toEqual(['windows-chrome', 'macos-chrome', 'linux-chrome', 'windows-edge'])
    expect(() => resolveStealthProfile('netscape')).toThrow(/unknown stealth profile 'netscape'/)
    expect(() => resolveStealthProfile('netscape')).toThrow(/windows-chrome/)
  })

  it('derives Accept-Language from the ordered language list (G3/G26)', () => {
    expect(deriveAcceptLanguage(['tr-TR', 'tr'])).toBe('tr-TR,tr;q=0.9')
    expect(deriveAcceptLanguage(['en-US', 'en', 'de'])).toBe('en-US,en;q=0.9,de;q=0.8')
    expect(deriveAcceptLanguage(['en-US'])).toBe('en-US')
    expect(deriveAcceptLanguage([])).toBe('en-US')
  })

  it('projects a profile into the stealth script (UA + UA-CH + device numbers)', () => {
    const script = stealthScript(deriveStealthOptions(WINDOWS_CHROME_PROFILE))
    expect(script).toContain('Chrome/131.0.0.0')
    expect(script).toContain('"platform":"Windows"')
    expect(script).toContain('Windows NT 10.0; Win64; x64)')
    expect(script).toContain("'hardwareConcurrency', 8")
    expect(script).toContain("'deviceMemory', 8")
  })

  it('launch args disable AutomationControlled and pin the locale (G1/G26)', () => {
    const args = deriveLaunchArgs(WINDOWS_CHROME_PROFILE)
    expect(args).toContain('--disable-blink-features=AutomationControlled')
    expect(args).toContain('--lang=en-US')
  })

  it('lists every plan07 patch name in STEALTH_PATCH_NAMES', () => {
    const plan07Names = [
      'uaCh', 'chromeExtras', 'windowMetrics', 'deviceInfo', 'mediaDevices', 'fonts',
      'connection', 'webglNoise', 'canvasNoise', 'audioNoise', 'clientRects', 'hairline',
      'cdcVars', 'funcToString',
    ]
    for (const name of plan07Names) expect(STEALTH_PATCH_NAMES).toContain(name)
  })

  it('each new toggle removes exactly its own marker', () => {
    const script = stealthScript({ canvasNoise: false, hairline: false, cdcVars: false })
    expect(script).not.toContain('dsh-stealth:canvasNoise')
    expect(script).not.toContain('dsh-stealth:hairline')
    expect(script).not.toContain('dsh-stealth:cdcVars')
    expect(script).toContain('dsh-stealth:webdriver')
    expect(script).toContain('dsh-stealth:uaCh')
    expect(script).toContain('dsh-stealth:clientRects')
  })
})

/* ── plan07-fix (T1 §3D + §4): prototype routing and real-vs-forged checks ── */

describe('plan07-fix: navigator patches live on the prototype (T1 §3D)', () => {
  const PATCHED_NAV_KEYS = [
    'webdriver', 'plugins', 'mimeTypes', 'language', 'languages', 'platform',
    'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'fonts',
  ]

  it('leaves NO patched key as an instance own property (sannysoft _.has tripwire)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    const own = Object.getOwnPropertyNames(sb.navigator)
    for (const key of PATCHED_NAV_KEYS) expect(own).not.toContain(key)
    // Real Chrome keeps the property PRESENT on the prototype: `in` sees it,
    // Object.hasOwn does not, and the value is the profile's.
    expect('webdriver' in sb.navigator).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(sb.navigator, 'webdriver')).toBe(false)
    expect(sb.navigator.webdriver).toBe(false)
    expect(sb.navigator.platform).toBe('Win32')
    expect(sb.navigator.fonts).toBeDefined()
    expect(sb.navigator.connection.effectiveType).toBe('4g')
  })

  it('prototype getter and instance read agree on hc/dm/languages (no 8 vs 32)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    const proto = Object.getPrototypeOf(sb.navigator)
    const fromProto = (key: string): unknown =>
      Object.getOwnPropertyDescriptor(proto, key)?.get?.call(sb.navigator)
    expect(fromProto('hardwareConcurrency')).toBe(8)
    expect(sb.navigator.hardwareConcurrency).toBe(8)
    expect(fromProto('deviceMemory')).toBe(8)
    expect(sb.navigator.deviceMemory).toBe(8)
    expect(fromProto('languages')).toEqual(['en-US', 'en'])
    expect(sb.navigator.languages).toEqual(['en-US', 'en'])
    expect(fromProto('languages')).toEqual(sb.navigator.languages)
    expect(sb.navigator.language).toBe('en-US')
    expect(fromProto('webdriver')).toBe(false)
  })

  it('keeps Accept-Language-style tags OUT of navigator.languages', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    const tags = Array.from(sb.navigator.languages as string[])
    expect(tags).toEqual(['en-US', 'en'])
    for (const tag of tags) expect(tag).not.toContain(';q=')
  })

  it('builds plugins as real Plugin instances (plugins[0] instanceof Plugin)', () => {
    const sb = makeSandbox(DEFAULT_SCRIPT)
    expect(sb.navigator.plugins.length).toBe(5)
    expect(sb.run('navigator.plugins[0] instanceof Plugin')).toBe(true)
    expect(sb.run('navigator.plugins instanceof PluginArray')).toBe(true)
    expect(sb.run('navigator.plugins[0].name')).toBe('PDF Viewer')
    expect(sb.navigator.mimeTypes.length).toBeGreaterThan(0)
    expect(sb.run('navigator.mimeTypes[0] instanceof MimeType')).toBe(true)
  })
})
