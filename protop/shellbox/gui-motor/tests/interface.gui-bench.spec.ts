/** Interface conformance: both MOCK backends honor `GuiBackend`, and the real-backend adapter stubs fail loud until linked. */

import { describe, expect, it } from 'vitest'
import { CAPTURE_BLACK } from '../src/backend.ts'
import { NATIVE_WIN_CAPABILITIES, NATIVE_WIN_IDENTITY, createNativeWinBackend } from '../src/adapters/native-win.adapter.ts'
import { createCodexNativeBackend } from '../src/adapters/codex-native.adapter.ts'
import { GUI_MOTOR_FIXTURE } from '../src/fixture.ts'
import { CODEX_NATIVE_MOCK_PROFILE, KOFFI_MOCK_PROFILE, createCodexNativeMockBackend, createKoffiMockBackend } from '../src/mocks/mock-backend.ts'
import { fileURLToPath } from 'node:url'

const fixture = GUI_MOTOR_FIXTURE
const koffi = createKoffiMockBackend(fixture)
const native = createCodexNativeMockBackend(fixture)

/** CodexNative's published helper stub: a cross-platform NDJSON stand-in for the prebuilt helper. */
const CUA_STUB = fileURLToPath(new URL('../../../packages/experimental/cua-native/tests/fixtures/helper-stub.mjs', import.meta.url))

describe('GuiBackend capability descriptors', () => {
  it('declares the koffi-ish mechanism as message injection with GDI frames', () => {
    expect(koffi.id).toBe('koffi-message-mock')
    expect(koffi.mock).toBe(true)
    expect(koffi.capabilities).toEqual({ nativeInjection: false, comUia: false, capturesWinRt: false })
  })

  it('declares the codex-native mechanism as native injection with COM UIA and capture sessions', () => {
    expect(native.id).toBe('codex-native-mock')
    expect(native.mock).toBe(true)
    expect(native.capabilities).toEqual({ nativeInjection: true, comUia: true, capturesWinRt: true })
  })

  it('labels both stand-ins as MOCK so a run can never pass them off as real', () => {
    expect(KOFFI_MOCK_PROFILE.label).toContain('MOCK')
    expect(CODEX_NATIVE_MOCK_PROFILE.label).toContain('MOCK')
    expect(koffi.label).toContain('MOCK')
    expect(native.label).toContain('MOCK')
  })
})

describe('GuiBackend operations against the fixture', () => {
  it('round-trips sendInput with a delivery receipt', async () => {
    const delivered = await koffi.sendInput({ kind: 'mouseMove', windowId: 'main', x: 500, y: 380 })
    expect(delivered.delivered).toBe(true)
    expect(delivered.detail).toContain('posted window message')
  })

  it('reports message-injection failure on a window that drops posted messages', async () => {
    const dropped = await koffi.sendInput({ kind: 'mouseClick', windowId: 'kiosk', x: 320, y: 200, button: 'left' })
    expect(dropped.delivered).toBe(false)
    expect(dropped.detail).toContain('drops posted messages')
    const nativeClick = await native.sendInput({ kind: 'mouseClick', windowId: 'kiosk', x: 320, y: 200, button: 'left' })
    expect(nativeClick.delivered).toBe(true)
    expect(nativeClick.detail).toContain('input queue')
  })

  it('returns a subtree snapshot whose paths match fixture ground truth', async () => {
    const snapshot = await native.readUia({ windowId: 'main' })
    const paths = snapshot.elements.map(element => element.path)
    expect(paths).toContain('/main/edit/username')
    expect(paths).toContain('/main/list/row-0')
    const username = snapshot.elements.find(element => element.path === '/main/edit/username')
    expect(username?.value).toBe('metin')
    expect(username?.bounds).toEqual({ x: 120, y: 140, width: 240, height: 28 })
  })

  it('exposes COM-only elements only to the COM UIA reader', async () => {
    const viaMessages = await koffi.readUia({ windowId: 'main' })
    expect(viaMessages.elements.map(element => element.path)).not.toContain('/main/list/row-0')
    const viaCom = await native.readUia({ windowId: 'main' })
    expect(viaCom.elements.map(element => element.path)).toContain('/main/list/row-0')
  })

  it('returns a frame covering every fixture region or the black sentinel', async () => {
    const gdiFrame = await koffi.capture({ windowId: 'main' })
    expect(gdiFrame.width).toBe(800)
    expect(gdiFrame.height).toBe(600)
    expect(gdiFrame.regions['client']).toBe('#1e1e1e')
    expect(gdiFrame.regions['taskbar']).toBe(CAPTURE_BLACK)
    const nativeFrame = await native.capture({ windowId: 'main' })
    expect(nativeFrame.regions['taskbar']).toBe('#191919')
    expect(nativeFrame.regions['foreign-overlay']).toBe('#7b2d26')
  })

  it('fails loud on an unknown window instead of guessing', async () => {
    await expect(koffi.sendInput({ kind: 'key', windowId: 'nope', key: 'A' })).rejects.toThrow(/has no window/)
  })
})

describe('real backend adapters are wired to their engines', () => {
  it('constructs the real CodexNative backend (spawn via the published helper stub)', async () => {
    const backend = createCodexNativeBackend({ helperPath: process.execPath, helperArgs: [CUA_STUB] })
    try {
      expect(backend.id).toBe('codex-native')
      expect(backend.mock).toBe(false)
      expect(backend.capabilities).toEqual({ nativeInjection: true, comUia: true, capturesWinRt: true })
      expect(typeof backend.sendInput).toBe('function')
      expect(typeof backend.readUia).toBe('function')
      expect(typeof backend.capture).toBe('function')
      expect(backend.client.pid).toBeTypeOf('number')
    } finally {
      await backend.client.close()
    }
    await backend.client.exited
  })

  it('constructs the real NativeWin backend over the deamon engine instance', async () => {
    const backend = createNativeWinBackend({
      screenWidth: 1800,
      screenHeight: 1200,
      windowRect: { x: 80, y: 80, width: 1280, height: 960 },
    })
    try {
      expect(backend.id).toBe(NATIVE_WIN_IDENTITY.id)
      expect(backend.mock).toBe(false)
      expect(backend.capabilities).toEqual({ ...NATIVE_WIN_CAPABILITIES })
      expect(backend.desktopName).toBeTypeOf('string')
      expect(typeof backend.launch).toBe('function')
      expect(typeof backend.sendInput).toBe('function')
      expect(typeof backend.readUia).toBe('function')
      expect(typeof backend.capture).toBe('function')
    } finally {
      await backend.close()
    }
  })
})
