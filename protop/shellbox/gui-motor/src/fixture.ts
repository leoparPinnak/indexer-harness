/**
 * Deterministic GUI fixture: the target window model the runner drives and the
 * ground truth every backend result is scored against. In-process and synthetic,
 * so the mock phase needs no live desktop.
 */

import type { Bounds, InputOp } from './backend.ts'

/** One target window in the fixture. */
export interface FixtureWindow {
  readonly id: string
  readonly title: string
  readonly bounds: Bounds
  /** True when the window drops posted messages, so message injection never lands. */
  readonly ignoresPostedMessages: boolean
  /** True when elevation (UIPI) blocks input injected from a non-elevated process. */
  readonly elevated: boolean
}

/** One ground-truth element in a window's tree. */
export interface FixtureElement {
  readonly windowId: string
  /** Stable selector path comparable against `UiaElement.path`. */
  readonly path: string
  readonly name: string
  readonly bounds: Bounds
  /** Ground-truth value when the element carries one. */
  readonly value?: string
  /** False when message probing cannot retrieve the value (custom-drawn control). */
  readonly valueViaMessages?: boolean
  /** True when only a COM UIA provider exposes the element (no window-message footprint). */
  readonly comOnly?: boolean
}

/** One expected capture region of the frame. */
export interface FixtureRegion {
  readonly name: string
  readonly color: string
  /** `window` regions live in the window surface; `desktop` regions are foreign pixels. */
  readonly scope: 'window' | 'desktop'
}

/** Deterministic window world plus its ground truth. */
export interface GuiFixture {
  readonly id: string
  /** Window used for capture frames and the trailing key operation. */
  readonly primaryWindowId: string
  readonly windows: readonly FixtureWindow[]
  readonly elements: readonly FixtureElement[]
  readonly regions: readonly FixtureRegion[]
}

/** The fixture both MOCK backends simulate; fixed inputs, reviewed constants only. */
export const GUI_MOTOR_FIXTURE: GuiFixture = {
  id: 'gui-motor-deterministic-window',
  primaryWindowId: 'main',
  windows: [
    {
      id: 'main',
      title: 'gui-motor fixture',
      bounds: { x: 100, y: 80, width: 800, height: 600 },
      ignoresPostedMessages: false,
      elevated: false,
    },
    {
      id: 'kiosk',
      title: 'kiosk surface',
      bounds: { x: 200, y: 160, width: 640, height: 400 },
      ignoresPostedMessages: true,
      elevated: false,
    },
    {
      id: 'admin',
      title: 'elevated console',
      bounds: { x: 40, y: 40, width: 500, height: 320 },
      ignoresPostedMessages: true,
      elevated: true,
    },
  ],
  elements: [
    {
      windowId: 'main',
      path: '/main/edit/username',
      name: 'Username',
      value: 'metin',
      valueViaMessages: false,
      bounds: { x: 120, y: 140, width: 240, height: 28 },
    },
    { windowId: 'main', path: '/main/button/ok', name: 'OK', bounds: { x: 120, y: 180, width: 88, height: 28 } },
    { windowId: 'main', path: '/main/status', name: 'Ready', bounds: { x: 8, y: 648, width: 784, height: 24 } },
    {
      windowId: 'main',
      path: '/main/list/row-0',
      name: 'row 0',
      comOnly: true,
      bounds: { x: 24, y: 220, width: 752, height: 24 },
    },
    {
      windowId: 'main',
      path: '/main/list/row-1',
      name: 'row 1',
      comOnly: true,
      bounds: { x: 24, y: 244, width: 752, height: 24 },
    },
    {
      windowId: 'main',
      path: '/main/progress',
      name: 'Progress',
      value: '42%',
      comOnly: true,
      bounds: { x: 24, y: 280, width: 400, height: 16 },
    },
    { windowId: 'kiosk', path: '/kiosk/label', name: 'Kiosk ready', bounds: { x: 220, y: 180, width: 300, height: 32 } },
    { windowId: 'kiosk', path: '/kiosk/button/exit', name: 'Exit', bounds: { x: 480, y: 480, width: 96, height: 32 } },
    {
      windowId: 'admin',
      path: '/admin/console',
      name: 'Administrator: fixture',
      value: 'C:\\fixture>',
      valueViaMessages: false,
      bounds: { x: 56, y: 72, width: 420, height: 220 },
    },
    {
      windowId: 'admin',
      path: '/admin/button/run',
      name: 'Run as admin',
      bounds: { x: 56, y: 312, width: 140, height: 32 },
    },
  ],
  regions: [
    { name: 'titlebar', color: '#20232a', scope: 'window' },
    { name: 'client', color: '#1e1e1e', scope: 'window' },
    { name: 'accent', color: '#2b6cb0', scope: 'window' },
    { name: 'taskbar', color: '#191919', scope: 'desktop' },
    { name: 'foreign-overlay', color: '#7b2d26', scope: 'desktop' },
  ],
}

/** Find one fixture window; a missing id is a fixture/backend mismatch and fails loud. */
export function fixtureWindow(fixture: GuiFixture, windowId: string): FixtureWindow {
  const window = fixture.windows.find(candidate => candidate.id === windowId)
  if (window === undefined) throw new Error(`gui-motor: fixture ${fixture.id} has no window ${JSON.stringify(windowId)}.`)
  return window
}

/** Ground-truth elements belonging to one window. */
export function fixtureElements(fixture: GuiFixture, windowId: string): readonly FixtureElement[] {
  return fixture.elements.filter(element => element.windowId === windowId)
}

/**
 * Ordered input scenarios for one runner iteration: a move and a click at each
 * window's center, then a key on the primary window.
 */
export function inputScenarioOps(fixture: GuiFixture): readonly InputOp[] {
  const ops: InputOp[] = []
  for (const window of fixture.windows) {
    const x = window.bounds.x + Math.floor(window.bounds.width / 2)
    const y = window.bounds.y + Math.floor(window.bounds.height / 2)
    ops.push({ kind: 'mouseMove', windowId: window.id, x, y })
    ops.push({ kind: 'mouseClick', windowId: window.id, x, y, button: 'left' })
  }
  const primary = fixtureWindow(fixture, fixture.primaryWindowId)
  ops.push({ kind: 'key', windowId: primary.id, key: 'Enter' })
  return ops
}
