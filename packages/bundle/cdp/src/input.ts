/**
 * @deepseek-ai/dsh-cdp — human-like input primitives dispatched as CDP `Input`
 * domain calls through a narrow connection dependency. A caller moves the
 * pointer along a curved, jittered path; hovers, clicks, double-clicks, and
 * scrolls with inertia; and types text or presses single keys and chords. Every
 * geometry shape, delay, and random choice is documented below, and every
 * random choice reads an injected source so a spec is deterministic.
 *
 * Every operation is bounded by {@link InputBounds}: a bound that is reached
 * ends the operation and is reported in that operation's `boundsHit` list, so a
 * truncated action is visible to the caller instead of silently shrinking. A
 * bound being reached never throws.
 *
 * Key events use one documented triple table ({@link KEY_DEFINITIONS} plus the
 * character and punctuation tables below) rather than per-call magic numbers.
 * @module @deepseek-ai/dsh-cdp/input
 */

/**
 * A callable returning a value in `[0, 1)`; the production default is
 * `Math.random`. Every random choice an input primitive makes reads this
 * source, and a spec injects a deterministic one.
 */
export type RandomSource = () => number

/**
 * The subset of a CDP connection the input primitives read. The connection owns
 * the socket and routes replies; this interface stays narrow so input is
 * exercised against an in-process fake.
 */
export interface InputConnection {
  /**
   * Send one CDP command.
   * @param method - CDP method name, for example `Input.dispatchMouseEvent`.
   * @param params - protocol parameters.
   * @param sessionId - flattened target session to route through.
   * @returns the reply's `result` object.
   */
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

/** A point in CSS pixels relative to the viewport's top-left corner. */
export interface Point {
  /** Horizontal offset in CSS pixels. */
  readonly x: number
  /** Vertical offset in CSS pixels. */
  readonly y: number
}

/** One bound an operation can reach; it is reported in the operation's result. */
export type InputBound = 'pathSteps' | 'duration' | 'characters' | 'scrollSteps'

/** Per-operation limits a {@link HumanInput} enforces. */
export interface InputBounds {
  /** Maximum pointer path samples one movement dispatches. */
  readonly maxPathSteps: number
  /** Maximum milliseconds one operation may take, including its sleeps. */
  readonly maxDurationMs: number
  /** Maximum Unicode code points one text entry dispatches. */
  readonly maxCharacters: number
  /** Maximum wheel events one scroll dispatches. */
  readonly maxScrollSteps: number
}

/** Production bounds; every field is a positive integer. */
export const DEFAULT_INPUT_BOUNDS: InputBounds = {
  maxPathSteps: 40,
  // plan16: 2s capped realistic typing at ~17 characters ("typed 17 of 28") —
  // the drain was the DURATION bound, not the character bound. 30s gives a
  // human-cadence burst room for a full form field (~500–1000 chars at the
  // documented 18–70ms/char cadence) while every op stays bounded. Long
  // bodies still route to cdp_fill (instant native setter), by design.
  maxDurationMs: 30_000,
  maxCharacters: 4_000,
  maxScrollSteps: 24,
}

/** Target distance between two path samples, in CSS pixels. */
export const DEFAULT_PATH_STEP_PX = 14

/** Fewest samples a non-zero movement uses, so a short move still curves. */
export const DEFAULT_MIN_PATH_STEPS = 3

/** Default maximum perpendicular displacement of the path's control point, in CSS pixels. */
export const DEFAULT_CURVE_PX = 24

/** Default maximum Euclidean displacement of one sample from the curve, in CSS pixels. */
export const DEFAULT_JITTER_PX = 2.5

/** Shortest pause between two pointer samples, in milliseconds. */
export const MIN_STEP_DELAY_MS = 4

/** Longest pause between two pointer samples, in milliseconds. */
export const MAX_STEP_DELAY_MS = 22

/** Shortest hover dwell, in milliseconds. */
export const MIN_DWELL_MS = 60

/** Longest hover dwell, in milliseconds. */
export const MAX_DWELL_MS = 180

/** Shortest mouse-button hold, in milliseconds. */
export const MIN_HOLD_MS = 30

/** Longest mouse-button hold, in milliseconds. */
export const MAX_HOLD_MS = 120

/** Shortest settle after a click, in milliseconds. */
export const MIN_SETTLE_MS = 30

/** Longest settle after a click, in milliseconds; a larger requested settle is capped here. */
export const MAX_SETTLE_MS = 120

/** Gap between the two clicks of a double click, in milliseconds. */
export const MIN_CLICK_GAP_MS = 40

/** Longest gap between the two clicks of a double click, in milliseconds. */
export const MAX_CLICK_GAP_MS = 90

/** Shortest pause after one typed character, in milliseconds. */
export const MIN_CHARACTER_DELAY_MS = 18

/** Longest pause after one typed character, in milliseconds. */
export const MAX_CHARACTER_DELAY_MS = 70

/** Extra pause after a character that completes a documented digraph, in milliseconds. */
export const MIN_DIGRAPH_DELAY_MS = 8

/** Longest extra pause after a digraph, in milliseconds. */
export const MAX_DIGRAPH_DELAY_MS = 40

/** Base fraction of the remaining scroll delta one wheel step carries. */
export const SCROLL_DECAY = 0.68

/** Lowest decay factor a jittered scroll step may use. */
export const MIN_SCROLL_DECAY = 0.35

/** Highest decay factor a jittered scroll step may use. */
export const MAX_SCROLL_DECAY = 0.9

/** Shortest pause between two wheel events, in milliseconds. */
export const MIN_SCROLL_DELAY_MS = 8

/** Longest pause between two wheel events, in milliseconds. */
export const MAX_SCROLL_DELAY_MS = 30

/** Remaining scroll magnitude below which inertia stops, in CSS pixels. */
export const MIN_SCROLL_STEP_DELTA = 0.5

/** Constructor options for {@link HumanInput}. */
export interface HumanInputOptions {
  /** The CDP connection every dispatched event travels through. */
  readonly connection: InputConnection
  /** Flattened target session every dispatched event is routed to. */
  readonly sessionId: string
  /** Initial cursor position; defaults to the viewport origin. */
  readonly startPoint?: Point
  /** Overrides merged over {@link DEFAULT_INPUT_BOUNDS}. */
  readonly bounds?: Partial<InputBounds>
  /** Random source for curves, jitter, and delays; defaults to `Math.random`. */
  readonly random?: RandomSource
  /** Millisecond clock used for event timestamps and duration; defaults to `Date.now`. */
  readonly now?: () => number
  /** Sleep used between steps; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Geometry and timing one pointer movement may override. */
export interface MoveOptions {
  /** Maximum perpendicular control-point displacement in CSS pixels. */
  readonly curvePx?: number
  /** Maximum per-sample displacement from the curve in CSS pixels. */
  readonly jitterPx?: number
  /** Target distance between two samples in CSS pixels. */
  readonly stepPx?: number
}

/** A generated pointer path and what the dispatch of it reported. */
export interface PointerPath {
  /** Cursor position the movement started from. */
  readonly start: Point
  /** Requested destination. */
  readonly end: Point
  /** Quadratic Bézier control point the path curves through. */
  readonly control: Point
  /**
   * Dispatched samples in order. The first is `start` and, unless a bound
   * truncated the path, the last is `end`; interior samples are jittered.
   */
  readonly points: readonly Point[]
  /** Number of samples actually dispatched. */
  readonly steps: number
  /** Bounds reached during the movement. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the movement took, per the injected clock. */
  readonly durationMs: number
}

/** Options for {@link HumanInput.hover}; `dwellMs` overrides the random dwell. */
export interface HoverOptions extends MoveOptions {
  /** Exact dwell in milliseconds, capped at {@link MAX_DWELL_MS}. */
  readonly dwellMs?: number
}

/** Outcome of one {@link HumanInput.hover}. */
export interface HoverOutcome {
  /** The movement that preceded the dwell. */
  readonly path: PointerPath
  /** Bounds reached, including any the movement reported. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the hover took, per the injected clock. */
  readonly durationMs: number
}

/** Mouse buttons the primitives can press. */
export type MouseButton = 'left' | 'right' | 'middle'

/** Options for {@link HumanInput.click} and {@link HumanInput.doubleClick}. */
export interface ClickOptions extends MoveOptions {
  /** Button to press; defaults to `left`. */
  readonly button?: MouseButton
  /** Exact hold between press and release; defaults to a random value in the documented range. */
  readonly holdMs?: number
  /** Exact settle after the click; defaults to a random value and is capped at {@link MAX_SETTLE_MS}. */
  readonly settleMs?: number
}

/** Outcome of one click or double click. */
export interface ClickOutcome {
  /** The movement that preceded the press. */
  readonly path: PointerPath
  /** Point the press used: the last sample the movement reached. */
  readonly position: Point
  /** Protocol click count of the final press. */
  readonly clickCount: number
  /** Bounds reached, including any the movement reported. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the operation took, per the injected clock. */
  readonly durationMs: number
}

/** A wheel delta in CSS pixels. */
export interface ScrollDelta {
  /** Horizontal delta; positive scrolls right. */
  readonly x: number
  /** Vertical delta; positive scrolls down. */
  readonly y: number
}

/** Outcome of one {@link HumanInput.scroll}. */
export interface ScrollOutcome {
  /** The movement to the scroll point that preceded the wheel events. */
  readonly moved: PointerPath
  /** Wheel events dispatched. */
  readonly steps: number
  /** Total horizontal delta dispatched. */
  readonly deltaX: number
  /** Total vertical delta dispatched. */
  readonly deltaY: number
  /** Bounds reached, including any the movement reported. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the scroll took, per the injected clock. */
  readonly durationMs: number
}

/** Outcome of one {@link HumanInput.typeText}. */
export interface TextEntryOutcome {
  /** Unicode code points dispatched. */
  readonly typed: number
  /** Code points the character or duration bound left untyped. */
  readonly skipped: number
  /** `Input.dispatchKeyEvent` calls dispatched. */
  readonly events: number
  /** Bounds reached. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the entry took, per the injected clock. */
  readonly durationMs: number
}

/** The protocol triple one key or chord key is dispatched as. */
export interface KeyDefinition {
  /** DOM `KeyboardEvent.key` value. */
  readonly key: string
  /** DOM `KeyboardEvent.code` value; empty when the layout cannot name it. */
  readonly code: string
  /** `Input.dispatchKeyEvent.windowsVirtualKeyCode` value; `0` when unknown. */
  readonly windowsVirtualKeyCode: number
  /** Text the key inserts, when it inserts any. */
  readonly text?: string
}

/** Outcome of one {@link HumanInput.pressKey} or {@link HumanInput.pressChord}. */
export interface KeyOutcome {
  /** Definitions dispatched, modifiers first and the main key last. */
  readonly keys: readonly KeyDefinition[]
  /** `Input.dispatchKeyEvent` calls dispatched. */
  readonly events: number
  /** Bounds reached. */
  readonly boundsHit: readonly InputBound[]
  /** Milliseconds the press took, per the injected clock. */
  readonly durationMs: number
}

/**
 * Error thrown when an input request cannot be expressed as a CDP event, for
 * example an unknown key name or a non-modifier in a chord's modifier slot.
 */
export class CdpInputError extends Error {
  /**
   * @param message - what the request failed to express.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CdpInputError'
  }
}

/**
 * Named-key triples for `Input.dispatchKeyEvent`: the DOM `key`, the DOM
 * `code`, the Windows virtual key code, and the text the key inserts when it
 * inserts any. Modifier keys map to their left-hand code because the primitives
 * never claim to know which physical key a caller means.
 */
export const KEY_DEFINITIONS: Readonly<Record<string, KeyDefinition>> = {
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', windowsVirtualKeyCode: 20 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  F1: { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
  F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
  F3: { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
  F4: { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
  F5: { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
  F6: { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
  F7: { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
  F8: { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
  F9: { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  F11: { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
  F12: { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
}

/**
 * Modifier keys and the `Input.dispatchKeyEvent.modifiers` bit each sets, as
 * documented by the DevTools Protocol: Alt `1`, Ctrl `2`, Meta `4`, Shift `8`.
 */
export const MODIFIER_BITS: Readonly<Record<string, number>> & {
  readonly Alt: number
  readonly Control: number
  readonly Meta: number
  readonly Shift: number
} = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
}

/** `Input.dispatchMouseEvent.buttons` bit for each mouse button. */
const BUTTON_BITS: Readonly<Record<MouseButton, number>> = { left: 1, right: 2, middle: 4 }

/**
 * US-layout `code` and Windows virtual key code for each printable character
 * whose DOM `key` is not a letter or digit. Kept beside the named table so no
 * input path invents a code or a virtual key code inline.
 */
const CHARACTER_KEYS: Readonly<Record<string, { code: string; windowsVirtualKeyCode: number }>> = {
  ' ': { code: 'Space', windowsVirtualKeyCode: 32 },
  '`': { code: 'Backquote', windowsVirtualKeyCode: 192 },
  '-': { code: 'Minus', windowsVirtualKeyCode: 189 },
  '=': { code: 'Equal', windowsVirtualKeyCode: 187 },
  '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219 },
  ']': { code: 'BracketRight', windowsVirtualKeyCode: 221 },
  '\\': { code: 'Backslash', windowsVirtualKeyCode: 220 },
  ';': { code: 'Semicolon', windowsVirtualKeyCode: 186 },
  "'": { code: 'Quote', windowsVirtualKeyCode: 222 },
  ',': { code: 'Comma', windowsVirtualKeyCode: 188 },
  '.': { code: 'Period', windowsVirtualKeyCode: 190 },
  '/': { code: 'Slash', windowsVirtualKeyCode: 191 },
}

/**
 * Letter pairs whose transition gets the documented longer digraph delay.
 * Lowercased before lookup, so case does not change typing rhythm.
 */
const DIGRAPHS: ReadonlySet<string> = new Set([
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar',
])

/** Modifier bits that suppress inserted text, matching `KeyboardEvent.getModifierState`. */
const TEXT_SUPPRESSING_MODIFIERS = MODIFIER_BITS.Alt + MODIFIER_BITS.Control + MODIFIER_BITS.Meta

/** One planned pointer path before any event is dispatched. */
interface PlannedPath {
  /** Samples to dispatch, endpoints exact. */
  readonly points: readonly Point[]
  /** Control point the samples were generated around. */
  readonly control: Point
  /** Bounds the planner itself reached. */
  readonly boundsHit: readonly InputBound[]
}

/**
 * Resolve one named key or single character to its protocol triple.
 *
 * A single character is resolved through {@link characterKeyDefinition}, so
 * `keyDefinition('a')` and `keyDefinition('Enter')` share one table set.
 *
 * @param name - a named key such as `Enter`, or one Unicode code point.
 * @returns the triple to dispatch.
 * @throws CdpInputError when the name is neither a table key nor a single character.
 */
export function keyDefinition(name: string): KeyDefinition {
  const named = KEY_DEFINITIONS[name]
  if (named !== undefined) return named
  if (Array.from(name).length === 1) return characterKeyDefinition(name)
  throw new CdpInputError(`cdp input: unknown key ${JSON.stringify(name)}`)
}

/**
 * Resolve one typed character to its protocol triple.
 *
 * Letters resolve to `Key<uppercase>` with the uppercase code point as the
 * Windows virtual key code; digits resolve to `Digit<n>`; punctuation resolves
 * through {@link CHARACTER_KEYS}; `\n` and `\t` resolve to the Enter and Tab
 * triples. Every other character keeps its own `key` and text with an empty
 * `code` and virtual key code `0`, because a US layout cannot name it.
 *
 * @param character - one Unicode code point, for example `a`, `\n`, or `é`.
 * @returns the triple to dispatch.
 * @throws CdpInputError when the argument is not exactly one code point.
 */
export function characterKeyDefinition(character: string): KeyDefinition {
  if (Array.from(character).length !== 1) {
    throw new CdpInputError(`cdp input: ${JSON.stringify(character)} is not a single character`)
  }
  const named = KEY_DEFINITIONS[character]
  if (named !== undefined) return named
  if (character === '\n') return keyDefinition('Enter')
  if (character === '\t') return keyDefinition('Tab')
  const punctuation = CHARACTER_KEYS[character]
  if (punctuation !== undefined) {
    return { key: character, code: punctuation.code, windowsVirtualKeyCode: punctuation.windowsVirtualKeyCode, text: character }
  }
  const upper = character.toUpperCase()
  if (upper >= 'A' && upper <= 'Z') {
    return { key: character, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: character }
  }
  if (character >= '0' && character <= '9') {
    return { key: character, code: `Digit${character}`, windowsVirtualKeyCode: character.charCodeAt(0), text: character }
  }
  return { key: character, code: '', windowsVirtualKeyCode: 0, text: character }
}

/**
 * Merge caller bounds over {@link DEFAULT_INPUT_BOUNDS}.
 * @param overrides - the fields the caller replaces.
 * @returns complete bounds.
 * @throws CdpInputError when a supplied bound is not a positive integer.
 */
function resolveBounds(overrides: Partial<InputBounds> | undefined): InputBounds {
  const bounds: InputBounds = {
    maxPathSteps: overrides?.maxPathSteps ?? DEFAULT_INPUT_BOUNDS.maxPathSteps,
    maxDurationMs: overrides?.maxDurationMs ?? DEFAULT_INPUT_BOUNDS.maxDurationMs,
    maxCharacters: overrides?.maxCharacters ?? DEFAULT_INPUT_BOUNDS.maxCharacters,
    maxScrollSteps: overrides?.maxScrollSteps ?? DEFAULT_INPUT_BOUNDS.maxScrollSteps,
  }
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new CdpInputError(`cdp input: bound ${name} must be a positive integer, got ${value}`)
    }
  }
  return bounds
}

/**
 * Cubic ease-in-out `p = t²(3 − 2t)`, the documented progress curve for a
 * pointer movement: slow at both endpoints and fastest in the middle.
 * @param t - linear fraction in `[0, 1]`.
 * @returns the eased fraction in `[0, 1]`.
 */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Evaluate a quadratic Bézier curve.
 * @param from - curve start.
 * @param control - curve control point.
 * @param to - curve end.
 * @param progress - eased fraction in `[0, 1]`.
 * @returns the curve point at `progress`.
 */
function quadraticPoint(from: Point, control: Point, to: Point, progress: number): Point {
  const inverse = 1 - progress
  return {
    x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * to.x,
    y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * to.y,
  }
}

/**
 * Human-like input over one flattened CDP session.
 *
 * The cursor position is state: {@link movePointer} starts where the previous
 * movement ended, and {@link hover}, {@link click}, {@link doubleClick}, and
 * {@link scroll} route through it first. All timing reads the injected clock
 * and sleep, so a spec runs without wall-clock waits.
 */
export class HumanInput {
  private readonly connection: InputConnection
  private readonly sessionId: string
  private readonly random: RandomSource
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly bounds: InputBounds
  private point: Point
  private lastTimestampMs = 0

  /**
   * @param options - the connection, session, bounds, and environment seams.
   * @throws CdpInputError when a supplied bound is not a positive integer.
   */
  constructor(options: HumanInputOptions) {
    this.connection = options.connection
    this.sessionId = options.sessionId
    this.random = options.random ?? Math.random
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? (ms => new Promise((resolve) => { setTimeout(resolve, ms) }))
    this.bounds = resolveBounds(options.bounds)
    this.point = options.startPoint ?? { x: 0, y: 0 }
  }

  /** The cursor position the next movement starts from. */
  get cursor(): Point {
    return this.point
  }

  /** The bounds this instance enforces. */
  get limits(): InputBounds {
    return this.bounds
  }

  /**
   * Move the pointer from the current cursor to `to` along a quadratic Bézier
   * path.
   *
   * The control point is the chord's midpoint displaced perpendicular to the
   * chord by a uniform random offset in `[-curvePx, curvePx]`. Progress follows
   * the documented cubic ease-in-out {@link easeInOut}. Interior samples are
   * displaced from the curve by a uniform random offset inside a disc of
   * radius `jitterPx`, so each sample's Euclidean displacement never exceeds
   * `jitterPx`; the first and last samples are exactly the endpoints. Each
   * sample after the first waits a random `[MIN_STEP_DELAY_MS, MAX_STEP_DELAY_MS]`
   * before it is dispatched.
   *
   * @param to - destination in CSS pixels.
   * @param options - geometry overrides for this movement.
   * @returns the dispatched path and the bounds it reached.
   */
  async movePointer(to: Point, options: MoveOptions = {}): Promise<PointerPath> {
    const started = this.now()
    const from = this.point
    const planned = this.planPath(
      from,
      to,
      options.curvePx ?? DEFAULT_CURVE_PX,
      options.jitterPx ?? DEFAULT_JITTER_PX,
      options.stepPx ?? DEFAULT_PATH_STEP_PX,
    )
    const boundsHit = new Set<InputBound>(planned.boundsHit)
    const points: Point[] = []
    for (const point of planned.points) {
      if (points.length > 0) {
        if (this.elapsed(started) >= this.bounds.maxDurationMs) {
          boundsHit.add('duration')
          break
        }
        await this.sleep(this.between(MIN_STEP_DELAY_MS, MAX_STEP_DELAY_MS))
      }
      await this.sendMouse('mouseMoved', point, { button: 'none', buttons: 0, modifiers: 0 })
      points.push(point)
    }
    const last = points[points.length - 1]
    if (last !== undefined) this.point = last
    return {
      start: from,
      end: to,
      control: planned.control,
      points,
      steps: points.length,
      boundsHit: [...boundsHit],
      durationMs: this.elapsed(started),
    }
  }

  /**
   * Move the pointer to `to` and dwell there, as hovering a control does.
   *
   * @param to - hover point in CSS pixels.
   * @param options - movement overrides plus an optional exact dwell.
   * @returns the movement and the dwell's outcome.
   */
  async hover(to: Point, options: HoverOptions = {}): Promise<HoverOutcome> {
    const started = this.now()
    const path = await this.movePointer(to, options)
    const boundsHit = new Set<InputBound>(path.boundsHit)
    const dwellMs = options.dwellMs ?? this.between(MIN_DWELL_MS, MAX_DWELL_MS)
    await this.sleep(Math.min(Math.max(dwellMs, 0), MAX_DWELL_MS))
    if (this.elapsed(started) >= this.bounds.maxDurationMs) boundsHit.add('duration')
    return { path, boundsHit: [...boundsHit], durationMs: this.elapsed(started) }
  }

  /**
   * Move the pointer to `to`, press and release a button once, then settle.
   *
   * The press holds for a random `[MIN_HOLD_MS, MAX_HOLD_MS]` unless `holdMs`
   * fixes it. The settle is `settleMs` when given, otherwise a random
   * `[MIN_SETTLE_MS, MAX_SETTLE_MS]`, and is always capped at
   * {@link MAX_SETTLE_MS}. A path-step or duration bound that stopped the
   * movement early makes the press land on the last sample the movement
   * reached, which the result reports as `position`.
   *
   * @param to - click point in CSS pixels.
   * @param options - movement, button, hold, and settle overrides.
   * @returns the movement, press position, and bounds reached.
   */
  async click(to: Point, options: ClickOptions = {}): Promise<ClickOutcome> {
    const started = this.now()
    const path = await this.movePointer(to, options)
    const boundsHit = new Set<InputBound>(path.boundsHit)
    const position = path.points[path.points.length - 1] ?? to
    await this.pressButton(position, options.button ?? 'left', 1, options.holdMs)
    await this.settle(started, options.settleMs, boundsHit)
    return { path, position, clickCount: 1, boundsHit: [...boundsHit], durationMs: this.elapsed(started) }
  }

  /**
   * Move the pointer to `to` and dispatch two press/release pairs, the second
   * carrying protocol `clickCount` `2`, as a double click does.
   *
   * @param to - click point in CSS pixels.
   * @param options - movement, button, hold, and settle overrides.
   * @returns the movement, press position, and bounds reached.
   */
  async doubleClick(to: Point, options: ClickOptions = {}): Promise<ClickOutcome> {
    const started = this.now()
    const path = await this.movePointer(to, options)
    const boundsHit = new Set<InputBound>(path.boundsHit)
    const position = path.points[path.points.length - 1] ?? to
    const button = options.button ?? 'left'
    await this.pressButton(position, button, 1, options.holdMs)
    await this.sleep(this.between(MIN_CLICK_GAP_MS, MAX_CLICK_GAP_MS))
    await this.pressButton(position, button, 2, options.holdMs)
    await this.settle(started, options.settleMs, boundsHit)
    return { path, position, clickCount: 2, boundsHit: [...boundsHit], durationMs: this.elapsed(started) }
  }

  /**
   * Move the pointer to `to`, then dispatch wheel events with inertia.
   *
   * Each step keeps a jittered {@link SCROLL_DECAY} fraction of the remaining
   * delta and dispatches the difference, so the steps sum to the requested
   * delta: inertia stops when the remaining magnitude falls below
   * {@link MIN_SCROLL_STEP_DELTA}, and any remainder a bound left unspent is
   * reported through `boundsHit`.
   *
   * @param to - point the wheel events are dispatched at, in CSS pixels.
   * @param delta - requested wheel delta in CSS pixels.
   * @param options - movement overrides for the approach to `to`.
   * @returns the movement, wheel-step totals, and bounds reached.
   */
  async scroll(to: Point, delta: ScrollDelta, options: MoveOptions = {}): Promise<ScrollOutcome> {
    const started = this.now()
    const moved = await this.movePointer(to, options)
    const boundsHit = new Set<InputBound>(moved.boundsHit)
    let remainingX = delta.x
    let remainingY = delta.y
    let deltaX = 0
    let deltaY = 0
    let steps = 0
    for (;;) {
      if (Math.hypot(remainingX, remainingY) < MIN_SCROLL_STEP_DELTA) break
      if (this.elapsed(started) >= this.bounds.maxDurationMs) {
        boundsHit.add('duration')
        break
      }
      if (steps >= this.bounds.maxScrollSteps) {
        boundsHit.add('scrollSteps')
        break
      }
      const decay = Math.min(
        MAX_SCROLL_DECAY,
        Math.max(MIN_SCROLL_DECAY, SCROLL_DECAY * this.between(0.9, 1.1)),
      )
      const nextX = remainingX * decay
      const nextY = remainingY * decay
      await this.connection.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: to.x,
        y: to.y,
        deltaX: remainingX - nextX,
        deltaY: remainingY - nextY,
        timestamp: this.timestamp(),
      }, this.sessionId)
      deltaX += remainingX - nextX
      deltaY += remainingY - nextY
      remainingX = nextX
      remainingY = nextY
      steps += 1
      await this.sleep(this.between(MIN_SCROLL_DELAY_MS, MAX_SCROLL_DELAY_MS))
    }
    return { moved, steps, deltaX, deltaY, boundsHit: [...boundsHit], durationMs: this.elapsed(started) }
  }

  /**
   * Type text one code point at a time, dispatching a down and an up event per
   * character.
   *
   * Each character holds for a random `[MIN_HOLD_MS, MAX_HOLD_MS]`, then waits
   * a random `[MIN_CHARACTER_DELAY_MS, MAX_CHARACTER_DELAY_MS]`, or the longer
   * `[MIN_DIGRAPH_DELAY_MS, MAX_DIGRAPH_DELAY_MS]` when it completes a
   * {@link DIGRAPHS} pair. The down event carries `text` when the character
   * inserts one; otherwise it is a `rawKeyDown`.
   *
   * @param text - text to type, counted in Unicode code points.
   * @returns what was typed and what a bound left untyped.
   */
  async typeText(text: string): Promise<TextEntryOutcome> {
    const started = this.now()
    const characters = Array.from(text)
    const boundsHit: InputBound[] = []
    let typed = 0
    let events = 0
    let previous = ''
    for (const character of characters) {
      if (typed >= this.bounds.maxCharacters) {
        boundsHit.push('characters')
        break
      }
      if (typed > 0 && this.elapsed(started) >= this.bounds.maxDurationMs) {
        boundsHit.push('duration')
        break
      }
      const definition = characterKeyDefinition(character)
      const inserted = definition.text
      await this.sendKey(inserted === undefined ? 'rawKeyDown' : 'keyDown', definition, 0, inserted)
      events += 1
      await this.sleep(this.between(MIN_HOLD_MS, MAX_HOLD_MS))
      await this.sendKey('keyUp', definition, 0, undefined)
      events += 1
      typed += 1
      const digraph = previous !== '' && DIGRAPHS.has((previous + character).toLowerCase())
      previous = character
      await this.sleep(digraph
        ? this.between(MIN_DIGRAPH_DELAY_MS, MAX_DIGRAPH_DELAY_MS)
        : this.between(MIN_CHARACTER_DELAY_MS, MAX_CHARACTER_DELAY_MS))
    }
    return { typed, skipped: characters.length - typed, events, boundsHit, durationMs: this.elapsed(started) }
  }

  /**
   * Press and release one key: a named key, or a single character.
   * @param key - named key such as `Enter`, or one character.
   * @returns what was dispatched and the bounds reached.
   * @throws CdpInputError when the name is unknown.
   */
  async pressKey(key: string): Promise<KeyOutcome> {
    return await this.pressChord([key])
  }

  /**
   * Press a chord: zero or more modifier keys held while a final key is pressed
   * and released, then the modifiers released in reverse order.
   *
   * Each modifier's down event carries the accumulated
   * {@link MODIFIER_BITS} mask, and the main key's down and up events carry the
   * full mask. Text is inserted only when no Ctrl, Alt, or Meta bit is set.
   *
   * @param keys - modifier names followed by the main key, in press order.
   * @returns the dispatched triples and the bounds reached.
   * @throws CdpInputError when the list is empty, a modifier slot holds a
   *   non-modifier, or the main key is unknown.
   */
  async pressChord(keys: readonly string[]): Promise<KeyOutcome> {
    const started = this.now()
    const mainName = keys[keys.length - 1]
    if (mainName === undefined) throw new CdpInputError('cdp input: pressChord requires at least one key')
    const modifierNames = keys.slice(0, -1)
    const modifierDefinitions: KeyDefinition[] = []
    const modifierBits: number[] = []
    let mask = 0
    for (const name of modifierNames) {
      const bit = MODIFIER_BITS[name]
      if (bit === undefined) {
        throw new CdpInputError(`cdp input: ${JSON.stringify(name)} is not a modifier key and cannot lead a chord`)
      }
      modifierDefinitions.push(keyDefinition(name))
      modifierBits.push(bit)
      mask |= bit
    }
    const main = keyDefinition(mainName)
    const mainBit = MODIFIER_BITS[mainName] ?? 0
    let events = 0
    let held = 0
    for (const [index, definition] of modifierDefinitions.entries()) {
      held |= modifierBits[index] ?? 0
      await this.sendKey('rawKeyDown', definition, held, undefined)
      events += 1
    }
    const inserted = (mask & TEXT_SUPPRESSING_MODIFIERS) === 0 ? main.text : undefined
    const downMask = mask | mainBit
    await this.sendKey(inserted === undefined ? 'rawKeyDown' : 'keyDown', main, downMask, inserted)
    events += 1
    await this.sleep(this.between(MIN_HOLD_MS, MAX_HOLD_MS))
    await this.sendKey('keyUp', main, mask, undefined)
    events += 1
    for (let index = modifierDefinitions.length - 1; index >= 0; index -= 1) {
      const definition = modifierDefinitions[index]
      if (definition === undefined) continue
      held &= ~(modifierBits[index] ?? 0)
      await this.sendKey('keyUp', definition, held, undefined)
      events += 1
    }
    await this.sleep(this.between(MIN_HOLD_MS, MAX_HOLD_MS))
    const boundsHit: InputBound[] = []
    if (this.elapsed(started) >= this.bounds.maxDurationMs) boundsHit.push('duration')
    return { keys: [...modifierDefinitions, main], events, boundsHit, durationMs: this.elapsed(started) }
  }

  /**
   * Plan one movement: clamp its sample count to the step bound, then generate
   * the eased, jittered samples described on {@link movePointer}.
   * @param from - cursor start.
   * @param to - requested destination.
   * @param curvePx - maximum control-point displacement.
   * @param jitterPx - maximum per-sample displacement.
   * @param stepPx - target distance between samples.
   * @returns the planned samples and the bound the planner reached.
   */
  private planPath(from: Point, to: Point, curvePx: number, jitterPx: number, stepPx: number): PlannedPath {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const distance = Math.hypot(dx, dy)
    const boundsHit: InputBound[] = []
    const natural = distance === 0 ? 1 : Math.max(DEFAULT_MIN_PATH_STEPS, Math.round(distance / stepPx))
    let samples = natural
    if (samples > this.bounds.maxPathSteps) {
      samples = this.bounds.maxPathSteps
      boundsHit.push('pathSteps')
    }
    const normalX = distance === 0 ? 0 : -dy / distance
    const normalY = distance === 0 ? 0 : dx / distance
    const bend = this.between(-curvePx, curvePx)
    const control: Point = {
      x: (from.x + to.x) / 2 + normalX * bend,
      y: (from.y + to.y) / 2 + normalY * bend,
    }
    const points: Point[] = []
    for (let index = 0; index < samples; index += 1) {
      if (index === 0) {
        points.push(from)
        continue
      }
      if (index === samples - 1) {
        points.push(to)
        continue
      }
      const ideal = quadraticPoint(from, control, to, easeInOut(index / (samples - 1)))
      const radius = jitterPx * Math.sqrt(this.random())
      const angle = this.random() * 2 * Math.PI
      points.push({ x: ideal.x + Math.cos(angle) * radius, y: ideal.y + Math.sin(angle) * radius })
    }
    return { points, control, boundsHit }
  }

  /**
   * Dispatch one mouse event with the given coordinates and extras.
   * @param type - protocol `type`, for example `mouseMoved`.
   * @param point - coordinates in CSS pixels.
   * @param extra - remaining protocol parameters.
   */
  private async sendMouse(type: string, point: Point, extra: Record<string, unknown>): Promise<void> {
    await this.connection.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      timestamp: this.timestamp(),
      ...extra,
    }, this.sessionId)
  }

  /**
   * Dispatch one keyboard event.
   * @param type - protocol `type`: `keyDown`, `rawKeyDown`, or `keyUp`.
   * @param definition - the key's triple.
   * @param modifiers - modifier mask for the event.
   * @param text - text the event inserts; omitted when it inserts none.
   */
  private async sendKey(
    type: 'keyDown' | 'rawKeyDown' | 'keyUp',
    definition: KeyDefinition,
    modifiers: number,
    text: string | undefined,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      type,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers,
      timestamp: this.timestamp(),
    }
    if (text !== undefined) {
      params.text = text
      params.unmodifiedText = text
    }
    await this.connection.send('Input.dispatchKeyEvent', params, this.sessionId)
  }

  /**
   * Press and release one button, holding for `holdMs` or a random range.
   * @param point - coordinates the press and release use.
   * @param button - button to press.
   * @param clickCount - protocol click count for both events.
   * @param holdMs - exact hold, or undefined for the random range.
   */
  private async pressButton(
    point: Point,
    button: MouseButton,
    clickCount: number,
    holdMs: number | undefined,
  ): Promise<void> {
    const buttons = BUTTON_BITS[button]
    await this.sendMouse('mousePressed', point, { button, buttons, clickCount, modifiers: 0 })
    await this.sleep(holdMs ?? this.between(MIN_HOLD_MS, MAX_HOLD_MS))
    await this.sendMouse('mouseReleased', point, { button, buttons: 0, clickCount, modifiers: 0 })
  }

  /**
   * Wait the click settle delay and record whether the duration bound was reached.
   * @param started - operation start, per the injected clock.
   * @param settleMs - exact settle, or undefined for the random range.
   * @param boundsHit - the operation's accumulated bounds.
   */
  private async settle(
    started: number,
    settleMs: number | undefined,
    boundsHit: Set<InputBound>,
  ): Promise<void> {
    const requested = settleMs ?? this.between(MIN_SETTLE_MS, MAX_SETTLE_MS)
    await this.sleep(Math.min(Math.max(requested, 0), MAX_SETTLE_MS))
    if (this.elapsed(started) >= this.bounds.maxDurationMs) boundsHit.add('duration')
  }

  /**
   * Current event timestamp in seconds, never decreasing within one instance.
   * @returns epoch milliseconds divided by 1000, as the protocol expects.
   */
  private timestamp(): number {
    const ms = this.now()
    if (ms > this.lastTimestampMs) this.lastTimestampMs = ms
    return this.lastTimestampMs / 1000
  }

  /**
   * Milliseconds elapsed since `started`, per the injected clock.
   * @param started - operation start.
   * @returns the elapsed milliseconds.
   */
  private elapsed(started: number): number {
    return this.now() - started
  }

  /**
   * Draw a uniform random value in `[min, max)`.
   * @param min - lower bound.
   * @param max - upper bound.
   * @returns the drawn value.
   */
  private between(min: number, max: number): number {
    return min + this.random() * (max - min)
  }
}
