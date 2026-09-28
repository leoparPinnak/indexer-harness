/**
 * @deepseek-ai/dsh-cdp/captcha — plan11: the PURE engine behind `cdp_captcha`.
 *
 * Three actions, one tool (`00-RAPOR-DEGERLENDIRME.md` §3.1):
 * - `scan`  (Katman A) — classify first-party verification candidates, attach
 *   deep-DOM evidence to each (rect → scrollIntoView → FRESH re-measure →
 *   `elementFromPoint` hit-test), inventory overlays and traps, and return a
 *   third-party verdict. A third-party provider is a VERDICT, never a door.
 * - `drag`  (Katman B) — the press-move-release protocol a slider needs, built
 *   from a READ track geometry (no fixed coordinates), with the K4 approach
 *   path, overshoot + pull-back, and a mandatory fresh re-measure before
 *   `mouseup`. The delivery guarantee is a read-back, never a "dispatched".
 * - `verify` (Katman A/B) — read the solution state in one call: `aria-checked`,
 *   `data-solved`/`data-confirmed`, slider value vs `data-target`, badge text,
 *   and the fixture's own counters (`wrongClicks` / `decoyClicks` /
 *   `honeypotHit`). A counter the page does not expose is OMITTED, never
 *   invented.
 *
 * Nothing here talks to the protocol. The page-side scanners are plain
 * JavaScript expression strings (evaluated by the service) that RETURN a JSON
 * string, and every decision — classification, honeypot/overlay triage, slider
 * geometry, solution verdicts — is a pure function over that data, so a spec
 * pins the whole engine without a browser.
 *
 * This module classifies first-party verification challenges and reports
 * third-party provider frames (reCAPTCHA / hCaptcha / Turnstile): cross-origin
 * frames are not readable from the page context, so `thirdPartyVerdict` names
 * them and the walk continues with same-origin candidates.
 *
 * @module @deepseek-ai/dsh-cdp/captcha
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Viewport box in CSS pixels, exactly as `getBoundingClientRect` reports it. */
export interface CaptchaRect {
  /** Left edge in viewport CSS pixels. */
  readonly x: number
  /** Top edge in viewport CSS pixels. */
  readonly y: number
  /** Width in CSS pixels. */
  readonly width: number
  /** Height in CSS pixels. */
  readonly height: number
}

/** A point in viewport CSS pixels. */
export interface CaptchaPoint {
  /** Horizontal offset. */
  readonly x: number
  /** Vertical offset. */
  readonly y: number
}

/** Every verification shape `scan` can name. `unknown` is an honest fallback. */
export type CaptchaCandidateKind =
  | 'checkbox'
  | 'slider'
  | 'image-select'
  | 'form-field'
  | 'delayed-confirm'
  | 'multi-step'
  | 'iframe-internal'
  | 'decoy'
  | 'dynamic-target'
  | 'visible-honeypot'
  | 'unknown'

/** The three actions `cdp_captcha` dispatches. */
export type CaptchaAction = 'scan' | 'drag' | 'verify'

/** Canonical action list; also the tool parameter enum. */
export const CAPTCHA_ACTIONS: readonly CaptchaAction[] = ['scan', 'drag', 'verify']

/** Hit-test verdict attached to every candidate (K3). */
export type CaptchaHitVerdict =
  | 'pass'
  | 'not-visible'
  | 'not-in-viewport'
  | 'covered'
  | 'pointer-events-blocked'

/** Page-side measurement of one element, read fresh at answer time. */
export interface CaptchaScanRecord {
  /** Short, stable CSS-ish path the host reports as `selector`. */
  readonly selector: string
  /** Lowercase tag name. */
  readonly tag: string
  /** Element id (empty when absent). */
  readonly id: string
  /** ARIA role attribute (empty when absent). */
  readonly role: string
  /** aria-label or a short text snippet. */
  readonly name: string
  /** Fresh border-box rect. */
  readonly rect: CaptchaRect
  /** Occupies visible space. */
  readonly visible: boolean
  /** Intersects the viewport. */
  readonly inViewport: boolean
  /** Topmost element at the centre is the target or one of its descendants. */
  readonly hitIsTarget: boolean
  /** Tag (+`#id`) of whatever sits at the centre instead. */
  readonly hitTag: string
  /** `pointer-events` computed value on the target. */
  readonly pointerEvents: string
  /** `position` computed value. */
  readonly position: string
  /** `opacity` computed value (1 when unset). */
  readonly opacity: number
  /** `tabindex` attribute parsed as a number (0 when absent). */
  readonly tabIndex: number
  /** `aria-hidden` attribute. */
  readonly ariaHidden: boolean
  /** Frame the element lives in: `top` or `frame:<label>`. */
  readonly frame: string
  /** `aria-checked` value when present. */
  readonly ariaChecked: string
  /** `data-solved` value when present. */
  readonly dataSolved: string
  /** `data-confirmed` value when present. */
  readonly dataConfirmed: string
  /** `data-target` value when present. */
  readonly dataTarget: string
  /** `data-done` value when present. */
  readonly dataDone: string
  /** `data-answer` value when present. */
  readonly dataAnswer: string
  /** `data-label` value when present. */
  readonly dataLabel: string
  /** `data-variant` value when present. */
  readonly dataVariant: string
  /** `data-fake-solved`/`data-decoy` presence — the fake-success trap. */
  readonly decoy: boolean
  /** The element declares a `left` offset AND reads as a target — dynamic. */
  readonly dynamicTarget: boolean
  /** Inside a `<form>` (or is one). */
  readonly inForm: boolean
  /** `input[type=range]` or an explicit slider role/value. */
  readonly rangeInput: boolean
  /** `input[type=checkbox]` / `input[type=radio]` without an explicit role. */
  readonly checkboxInput: boolean
  /** A `[class*=cover|overlay|modal|backdrop]` signature on this element. */
  readonly coverLike: boolean
  /** Ancestor/descendant carries a `data-done` step marker. */
  readonly chainStep: boolean
  /** Another candidate's centre is blocked by this element. */
  readonly covers: number
  /** How many fresh candidates this element's trap rules name. */
  readonly trapHits: number
  /** Rule ids that fired (from {@link HONEYPOT_RULES}). */
  readonly trapRuleIds: readonly string[]
  /** `left` was ≤ -1000px or the box collapsed — the classic parking spot. */
  readonly offscreen: boolean
  /** `aria-hidden=true` plus a trap rule — an announced-as-absent field. */
  readonly announcedAbsent: boolean
  /** Pixels the box moved between the first and the post-scroll measurement. */
  readonly driftPx: number
  /**
   * plan11-fix-scan-rect: the `view.scrollY` {@link CaptchaScanRecord.rect} is
   * valid at. A rect is a VIEWPORT (client) coordinate, so this offset is part
   * of its meaning — without it a box measured while the probe scrolled reads
   * as a live viewport position and an agent clicks whatever sits there now.
   */
  readonly measuredAtScrollY?: number
  /**
   * plan11-fix-scan-rect: false when the scan could not put the page back
   * where it found it, so the rect describes an offset the page is still on.
   */
  readonly scrollRestored?: boolean
}

/** One classified candidate with its deep-DOM evidence. */
export interface CaptchaCandidate {
  /** Classified shape. */
  readonly kind: CaptchaCandidateKind
  /** Host-side path hint for the element. */
  readonly selector: string
  /** Lowercase tag name. */
  readonly tag: string
  /** Element id. */
  readonly id: string
  /** ARIA role attribute. */
  readonly role: string
  /** aria-label or short text snippet. */
  readonly name: string
  /** Fresh border-box rect (post-scroll re-measure). */
  readonly rect: CaptchaRect
  /** Occupies visible space. */
  readonly visible: boolean
  /** Intersects the viewport. */
  readonly inViewport: boolean
  /** Hit-test verdict (K3). */
  readonly hitTest: CaptchaHitVerdict
  /** Topmost element at the centre was the target. */
  readonly hitIsTarget: boolean
  /** Whatever sat on top instead (`''` when nothing did). */
  readonly blockedBy: string
  /** Frame the element lives in. */
  readonly frame: string
  /** Signature rules that fired, in precedence order — greppable evidence. */
  evidence: string[]
  /** Pixels the box moved across the scroll/re-measure round trip. */
  readonly driftPx: number
  /** `data-target` when the element declares one. */
  readonly dataTarget?: string
  /**
   * plan11-fix-scan-rect: the `scrollY` this {@link CaptchaCandidate.rect} is
   * valid at. A value other than the page's current offset (or a false
   * {@link CaptchaCandidate.scrollRestored}) means the box is STALE for a click:
   * re-measure before aiming at it.
   */
  readonly measuredAtScrollY?: number
  /** plan11-fix-scan-rect: false when the scan left the page scrolled. */
  readonly scrollRestored?: boolean
}

/** One overlay/cover layer that can sit above a target. */
export interface CaptchaOverlay {
  /** Host-side path hint. */
  readonly selector: string
  /** Lowercase tag name. */
  readonly tag: string
  /** Element id. */
  readonly id: string
  /** `position` computed value. */
  readonly position: string
  /** `z-index` computed value (`'auto'` when unset). */
  readonly zIndex: string
  /** Fresh box. */
  readonly rect: CaptchaRect
  /** How it was found: a class/attribute signature or the computed-style pass. */
  readonly source: 'signature' | 'computed'
  /** True when it currently blocks at least one candidate. */
  readonly blocking: boolean
}

/** How a trap was classified. `visible-honeypot` is the T7 axis. */
export type CaptchaHoneypotClass = 'hidden-trap' | 'visible-honeypot'

/** One trap field, with the rules that named it. */
export interface CaptchaHoneypot {
  /** Classification. */
  readonly kind: CaptchaHoneypotClass
  /** Host-side path hint. */
  readonly selector: string
  /** Element id. */
  readonly id: string
  /** Lowercase tag name. */
  readonly tag: string
  /** The `name` attribute, when the field has one. */
  readonly name: string
  /** Fresh box. */
  readonly rect: CaptchaRect
  /** Rule ids that fired. */
  rules: string[]
  /** Human labels of the fired rules. */
  reasons: string[]
  /** A visible trap is fillable AND focusable — the naive scan misses it. */
  readonly focusable: boolean
}

/** One iframe seen on the page. */
export interface CaptchaFrame {
  /** `src` attribute as authored. */
  readonly src: string
  /** Element id. */
  readonly id: string
  /** `title` attribute. */
  readonly title: string
  /** True when the document could be read (same-origin). */
  readonly accessible: boolean
  /** First-party ⇢ third-party classification of the source. */
  readonly origin: 'first-party' | 'third-party' | 'about' | 'data' | 'unknown'
  /** Verbatim host for third-party frames. */
  readonly host?: string
}

/** The third-party verdict — a gate, never a door. */
export interface CaptchaThirdParty {
  /** `first-party` only when no third-party iframe is present. */
  readonly verdict: 'first-party' | 'third-party-present'
  /** Every iframe the scan saw. */
  iframes: CaptchaFrame[]
  /** Why `scan` is blocked; absent on a first-party verdict. */
  readonly reason?: string
  /** Providers recognised by host (reCAPTCHA / hCaptcha / Turnstile / Cloudflare). */
  providers: string[]
}

/** Honesty envelope for the `scan` action. */
export interface CaptchaScanOutcome {
  /** Which action produced this envelope — always `scan`. */
  readonly action: 'scan'
  /** False when nothing was found or the page-side scan failed. */
  readonly ok: boolean
  /** Candidates found (always present, `0` with a `reason` when empty). */
  readonly found: number
  /** Classified candidates in document order. */
  candidates: CaptchaCandidate[]
  /** Overlay inventory. */
  overlays: CaptchaOverlay[]
  /** Trap inventory. */
  honeypots: CaptchaHoneypot[]
  /** Third-party verdict. */
  readonly thirdParty: CaptchaThirdParty
  /** Page URL at answer time. */
  readonly url: string
  /** Resolved tab. */
  readonly targetId: string
  /** Honest caution lines. */
  warnings: string[]
  /** Failure line when `ok` is false. */
  readonly reason?: string
}

/** Honesty envelope for the `drag` action. */
export interface CaptchaDragOutcome {
  /** Which action produced this envelope — always `drag`. */
  readonly action: 'drag'
  /** True only when the read-back reached the target AND something changed. */
  readonly ok: boolean
  /**
   * The gesture reached the page AND the read-back PROVED it: the value landed
   * on the requested percent and something observable changed. plan11-fix-drag-
   * deliver: a collapsed (≈0px) gesture is never `true`, whatever the page
   * published.
   */
  readonly delivered: boolean
  /** Press point (thumb centre) X. */
  readonly startX: number
  /** Press point (thumb centre) Y. */
  readonly startY: number
  /** Release point X (computed from a FRESH track/thumb re-measure). */
  readonly targetX: number
  /** Release point Y. */
  readonly targetY: number
  /** Percent read back from the thumb AFTER the release. */
  readonly finalValue: number
  /** Percent the geometry said the release should produce. */
  readonly expectedValue: number
  /** Percent read back BEFORE the press (the change is the proof). */
  readonly beforeValue: number
  /** Whether the read-back landed within {@link SLIDER_TOLERANCE_PCT}. */
  readonly matched: boolean
  /** Which independent observation proved the delivery. */
  readonly verifiedBy: DragVerdictSource
  /**
   * The page's own state differences (`data-done: 0 → 1`, …). EMPTY is honest
   * and ambiguous on purpose: either nothing changed, or the page publishes no
   * state at all — read `verifiedBy` to tell those apart.
   */
  readonly stateDiffs: string[]
  /** Milliseconds the gesture took, per the injected clock. */
  readonly deltaMs: number
  /** How many press-move-release gestures were dispatched (1 on success). */
  readonly attempts: number
  /** Page URL at answer time. */
  readonly url: string
  /** Resolved tab. */
  readonly targetId: string
  /** Honest caution lines. */
  warnings: string[]
  /** Failure line when `ok` is false. */
  readonly reason?: string
}

/** Solution signals read in one call. */
export interface CaptchaSignals {
  /** `aria-checked` readings as `selector=value`. */
  ariaChecked: string[]
  /** `data-solved` readings as `selector=value`. */
  dataSolved: string[]
  /** `data-confirmed` readings as `selector=value`. */
  dataConfirmed: string[]
  /** Slider readings as `selector=value(data-target)`. */
  sliders: string[]
  /** Badge/status text found on the page. */
  badges: string[]
  /** The page's own solution flags (`window.__t6.chain`, …) as `key=true`. */
  flags: string[]
}
/** Honesty envelope for the `verify` action. */
export interface CaptchaVerifyOutcome {
  /** Which action produced this envelope — always `verify`. */
  readonly action: 'verify'
  /** True when at least one solution signal reads solved. */
  readonly ok: boolean
  /** The solution verdict itself. */
  readonly solved: boolean
  /** Every signal the page exposed. */
  readonly signals: CaptchaSignals
  /** Wrong-target presses, when the page counts them. */
  readonly wrongClicks?: number
  /** Fake-success-trap presses, when the page counts them. */
  readonly decoyClicks?: number
  /** True when a trap field was filled, when the page tracks it. */
  readonly honeypotHit?: boolean
  /** Newest solution timestamp the page recorded, when it records one. */
  readonly solvedAt?: number
  /** Page URL at answer time. */
  readonly url: string
  /** Resolved tab. */
  readonly targetId: string
  /** Honest caution lines. */
  warnings: string[]
  /** Failure line when `ok` is false. */
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// Constants — selectors, trap rules, tolerances
// ---------------------------------------------------------------------------

/** Page-side element budget; a page past it answers `truncated: true`. */
export const CAPTCHA_SCAN_MAX_RECORDS = 400

/**
 * plan11-fix-scan-cap: the reason a scan that cannot fit its 16 KiB budget
 * answers with. It is the WHOLE recovery instruction — narrow the query or
 * point the tool at a smaller surface — because the alternative failure mode
 * (a reply cut mid-object) is not a partial answer at all, it is unparseable.
 */
export const CAPTCHA_SCAN_BUDGET_REASON = 'cdp_captcha: scan result exceeds the 16 KiB budget; narrow the scan or use a clip/scope'

/**
 * plan11-fix-scan-cap: what the page-side scan may spend on its candidate
 * inventory. The HOST cuts every evaluation reply at 16 KiB, and a cut JSON
 * string is not a smaller answer — it is an unparseable one, which is how a
 * page with a couple of hundred form fields used to turn a whole scan into
 * `scan reply is not JSON (… at position 16384)`.
 *
 * Measured on the T7 fixture: 19 candidates ⇒ 15,009 chars ⇒ one more form
 * field and the entire scan was lost. The page-side budget is what keeps the
 * reply inside the cut, and the numbers leave room for the envelope, the URL
 * and the warnings around them.
 */
export const CAPTCHA_SCAN_HARD_BUDGET_CHARS = 15_000

/** What the candidate inventory alone may cost. */
export const CAPTCHA_SCAN_RECORD_BUDGET_CHARS = 11_000

/** What the overlay inventory alone may cost. */
export const CAPTCHA_SCAN_OVERLAY_BUDGET_CHARS = 2_500

/** Page-side element budget for the computed-style overlay pass. */
export const CAPTCHA_OVERLAY_MAX_SCAN = 3000

/** Deepest frame nesting the scan walks (same-origin documents only). */
export const CAPTCHA_MAX_FRAME_DEPTH = 2

/**
 * Overlay signatures the scan queries directly. The computed-style pass in
 * {@link CAPTCHA_SCAN_EXPRESSION} catches the unnamed ones (a sticky header
 * with no overlay class is the T6 fixture's `header`), so this list is the
 * fast path, not the only path.
 */
export const OVERLAY_SELECTORS: readonly string[] = [
  '[class*="overlay" i]',
  '[class*="modal" i]',
  '[class*="cover" i]',
  '[class*="backdrop" i]',
  '[class*="curtain" i]',
  '[class*="scrim" i]',
  '[class*="overlay" i][style*="z-index"]',
  'dialog[open]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[data-overlay]',
  '[data-cover]',
  '[data-modal]',
]

/**
 * Candidate signatures the scan queries. Every first-party verification shape
 * the three test reports produced has at least one of them; a page that
 * matches none answers `found: 0` + a reason rather than a silent `[]`.
 */
export const CAPTCHA_CANDIDATE_SELECTOR: readonly string[] = [
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="progressbar"]',
  '[aria-checked]',
  '[aria-valuenow]',
  'input[type="range"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="url"]',
  'input[type="hidden"]',
  'button[type="submit"]',
  '[data-target]',
  '[data-label]',
  '[data-answer]',
  '[data-solved]',
  '[data-confirmed]',
  '[data-variant]',
  '[data-done]',
  '[data-fake-solved]',
  '[data-decoy]',
  'form',
  'iframe',
  // A cover/overlay is a verification artefact in its own right: T7's double
  // cover is the thing an operator has to WAIT for, so it must appear as a
  // candidate (and not only in the overlay inventory).
  '[class*="cover" i]',
  '[class*="overlay" i]',
  '[class*="backdrop" i]',
  '[data-cover]',
  '[data-overlay]',
]

/** Computed `opacity` at or below which a laid-out field reads as a trap. */
export const HONEYPOT_OPACITY_MAX = 0.05

/** `|left|` or `|top|` at or beyond which a field is "parked" off-screen. */
export const HONEYPOT_OFFSCREEN_PX = 1000

/** How many trap rules must fire before a field is called a trap. */
export const HONEYPOT_MIN_RULES = 2

/** Percent tolerance used when judging a slider's read-back. */
export const SLIDER_TOLERANCE_PCT = 1.5

/** K4: the press point is approached from this far away (CSS pixels). */
export const APPROACH_MIN_PX = 12

/** K4: …up to this far away. */
export const APPROACH_MAX_PX = 40

/** Default press-move-release step count for the drag path. */
export const DRAG_DEFAULT_STEPS = 24

/** Hard bound on the drag step count, so a request cannot melt the protocol. */
export const DRAG_MAX_STEPS = 200

/** Hosts that mean "third-party CAPTCHA provider" (reported as third-party). */
export const CAPTCHA_PROVIDER_HOSTS: readonly string[] = [
  'recaptcha',
  'hcaptcha',
  'turnstile',
  'challenges.cloudflare.com',
  'funcaptcha',
  'arkoselabs',
  'geetest',
  'datadome',
]

/** Layout facts a trap rule reads. */
export interface HoneypotSignals {
  /** The box is parked off-screen or collapsed. */
  readonly offscreen: boolean
  /** Computed `opacity`. */
  readonly opacity: number
  /** The box still occupies space (`display` is not `none`). */
  readonly laidOut: boolean
  /** Parsed `tabindex` (0 when absent). */
  readonly tabIndex: number
  /** Computed `pointer-events`. */
  readonly pointerEvents: string
  /** `aria-hidden=true`. */
  readonly ariaHidden: boolean
  /** Computed `position`. */
  readonly position: string
}

/** One named trap rule. Exported so a spec can pin each rule on its own. */
export interface HoneypotRule {
  /** Stable id, reported in `honeypots[].rules`. */
  readonly id: string
  /** Human label, reported in `honeypots[].reasons`. */
  readonly label: string
  /** Whether the rule fires for these signals. */
  test(signals: HoneypotSignals): boolean
}

/**
 * The trap rule table. Note `opacity-near-zero` and `static-position`: a field
 * at `opacity:.01` that is laid out and keeps `position:static` defeats the
 * classic `left:-9999` parking, so a naive "is it invisible?" scan calls it a
 * normal field. That is exactly the T7 `visible-honeypot` axis.
 */
export const HONEYPOT_RULES: readonly HoneypotRule[] = [
  {
    id: 'offscreen',
    label: 'parked off-screen (left/top ≤ -1000px)',
    test: signals => signals.offscreen,
  },
  {
    id: 'opacity-zero',
    label: 'opacity: 0',
    test: signals => signals.opacity <= 0,
  },
  {
    id: 'opacity-near-zero',
    label: 'opacity ≤ 0.05 (looks hidden, still fillable)',
    test: signals => signals.opacity > 0 && signals.opacity <= HONEYPOT_OPACITY_MAX,
  },
  {
    id: 'tabindex-removed',
    label: 'tabindex=-1 (out of the tab order)',
    test: signals => signals.tabIndex < 0,
  },
  {
    id: 'pointer-events-none',
    label: 'pointer-events:none (unclickable)',
    test: signals => signals.pointerEvents === 'none',
  },
  {
    id: 'aria-hidden',
    label: 'aria-hidden=true (announced as absent)',
    test: signals => signals.ariaHidden,
  },
  {
    id: 'static-position',
    label: 'position:static (defeats the left:-9999 parking)',
    test: signals => signals.position === 'static'
      && signals.laidOut
      && signals.opacity <= HONEYPOT_OPACITY_MAX,
  },
]

/** @param id - rule id. @returns the rule, or undefined. */
export function honeypotRule(id: string): HoneypotRule | undefined {
  return HONEYPOT_RULES.find(rule => rule.id === id)
}

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

/** @param signals - layout facts. @returns the ids of the rules that fire. */
export function matchHoneypotRules(signals: HoneypotSignals): string[] {
  return HONEYPOT_RULES.filter(rule => rule.test(signals)).map(rule => rule.id)
}

/**
 * Triage one field into a trap class.
 *
 * A field is a trap once {@link HONEYPOT_MIN_RULES} rules fire. A trap that is
 * still laid out, still focusable, and at `opacity ≤ 0.05` is reported as
 * `visible-honeypot` — the T7 axis a "find the invisible input" scan misses.
 * @param signals - layout facts read page-side.
 * @returns the class plus the rule ids; `null` when the field is not a trap.
 */
export function classifyHoneypot(
  signals: HoneypotSignals,
): { readonly kind: CaptchaHoneypotClass, rules: string[] } | null {
  const rules = matchHoneypotRules(signals)
  if (rules.length < HONEYPOT_MIN_RULES) return null
  const focusable = signals.laidOut && signals.tabIndex >= 0 && signals.pointerEvents !== 'none'
  const kind: CaptchaHoneypotClass = focusable && signals.opacity <= HONEYPOT_OPACITY_MAX
    ? 'visible-honeypot'
    : 'hidden-trap'
  return { kind, rules }
}

/** @param record - a scan record. @returns the layout facts the rules read. */
function signalsOf(record: CaptchaScanRecord): HoneypotSignals {
  return {
    offscreen: record.offscreen,
    opacity: record.opacity,
    laidOut: record.rect.width > 0 && record.rect.height > 0 && record.visible,
    tabIndex: record.tabIndex,
    pointerEvents: record.pointerEvents,
    ariaHidden: record.ariaHidden,
    position: record.position,
  }
}

/**
 * Classify one scan record. Precedence is fixed and documented, because a
 * record can carry several signatures at once (a slider step inside a chain,
 * a cover that also sits over a button):
 *
 * `decoy` → `visible-honeypot` → `slider` → `image-select` →
 * `delayed-confirm` → `multi-step` → `iframe-internal` → `checkbox` →
 * `dynamic-target` → `form-field` → `unknown`.
 *
 * `slider` outranks `multi-step` on purpose: a track inside a `data-done` step
 * is a slider first (that is what the operator has to solve), and the chain is
 * still visible through the candidate's `evidence` list.
 * @param record - one fresh page-side record.
 * @returns the kind plus the signature rules that fired.
 */
export function classifyRecord(
  record: CaptchaScanRecord,
): { readonly kind: CaptchaCandidateKind, evidence: string[] } {
  const evidence: string[] = []
  const inFrame = record.frame !== 'top'
  const trap = record.trapHits >= HONEYPOT_MIN_RULES
    ? classifyHoneypot(signalsOf(record))
    : null

  if (record.decoy) {
    evidence.push('data-fake-solved/data-decoy signature (fake-success trap)')
    return { kind: 'decoy', evidence }
  }
  if (trap?.kind === 'visible-honeypot') {
    evidence.push(...trap.rules)
    evidence.push('laid out + focusable at low opacity (visible honeypot)')
    return { kind: 'visible-honeypot', evidence }
  }
  if (record.rangeInput || record.dataTarget !== '') {
    evidence.push(record.dataTarget !== ''
      ? `data-target=${record.dataTarget} slider`
      : 'range input / slider role')
    return { kind: 'slider', evidence }
  }
  if (record.dataLabel !== '' || record.dataAnswer !== '') {
    evidence.push(record.dataAnswer !== '' ? 'data-answer cell' : 'data-label cell')
    return { kind: 'image-select', evidence }
  }
  if (record.coverLike) {
    evidence.push(record.covers > 0 ? 'cover blocking N candidate(s)' : 'cover/overlay signature')
    return { kind: 'delayed-confirm', evidence }
  }
  if (record.chainStep) {
    evidence.push(record.dataDone !== '' ? `data-done=${record.dataDone}` : 'inside a data-done chain step')
    return { kind: 'multi-step', evidence }
  }
  if (inFrame) {
    evidence.push(`element lives in ${record.frame}`)
    return { kind: 'iframe-internal', evidence }
  }
  if (record.role === 'checkbox' || record.role === 'switch' || record.role === 'radio'
    || record.ariaChecked !== '' || record.checkboxInput) {
    evidence.push(record.ariaChecked !== ''
      ? `aria-checked=${record.ariaChecked}`
      : `role=${record.role || 'input[type=checkbox]'}`)
    return { kind: 'checkbox', evidence }
  }
  if (record.dynamicTarget) {
    evidence.push('declared left offset + target signature (position set after load)')
    return { kind: 'dynamic-target', evidence }
  }
  if (record.inForm) {
    evidence.push('field inside a <form>')
    return { kind: 'form-field', evidence }
  }
  evidence.push('no signature matched — reported as unknown, not dropped')
  return { kind: 'unknown', evidence }
}

/** @param record - one scan record. @returns the hit-test verdict (K3). */
export function hitVerdictOf(record: CaptchaScanRecord): CaptchaHitVerdict {
  if (!record.visible) return 'not-visible'
  if (!record.inViewport) return 'not-in-viewport'
  if (record.hitIsTarget) return record.pointerEvents === 'none' ? 'pointer-events-blocked' : 'pass'
  return 'covered'
}

/**
 * Classify every record and attach the deep-DOM evidence the reports asked
 * for: fresh rect, hit-test verdict, blocking reason, drift across the
 * scroll/re-measure round trip.
 * @param records - fresh page-side records in document order.
 * @returns candidates in the same order; `[]` when nothing matched.
 */
export function classifyCandidates(records: readonly CaptchaScanRecord[]): CaptchaCandidate[] {
  return records.map((record) => {
    const { kind, evidence } = classifyRecord(record)
    return {
      kind,
      selector: record.selector,
      tag: record.tag,
      id: record.id,
      role: record.role,
      name: record.name,
      rect: record.rect,
      visible: record.visible,
      inViewport: record.inViewport,
      hitTest: hitVerdictOf(record),
      hitIsTarget: record.hitIsTarget,
      /* plan11-fix-scan-rect: an occluder is only named when the hit test ran
       * on the box the caller can see. A point probed while the page was
       * scrolled to reach an off-screen box describes a DIFFERENT position, so
       * publishing it as `blockedBy` named an element that was never in the
       * way — the silent wrong box in its worst form. `hitTest` already reads
       * `not-in-viewport`; that is the whole truth about an off-screen probe. */
      blockedBy: record.hitIsTarget || !record.inViewport || !record.visible ? '' : record.hitTag,
      frame: record.frame,
      evidence,
      driftPx: record.driftPx,
      ...(record.dataTarget !== '' ? { dataTarget: record.dataTarget } : {}),
      ...(record.measuredAtScrollY !== undefined ? { measuredAtScrollY: record.measuredAtScrollY } : {}),
      ...(record.scrollRestored !== undefined ? { scrollRestored: record.scrollRestored } : {}),
    }
  })
}

/**
 * Build the trap inventory. Only fields the page itself describes as
 * fillable (an `input`/`textarea`/`select`, or a `form`-scoped field) are
 * considered, so an `opacity:.01` badge never becomes a "trap".
 * @param records - fresh page-side records.
 * @returns traps in document order.
 */
export function classifyHoneypots(records: readonly CaptchaScanRecord[]): CaptchaHoneypot[] {
  const traps: CaptchaHoneypot[] = []
  for (const record of records) {
    const trap = classifyHoneypot(signalsOf(record))
    if (trap === null) continue
    const fieldish = ['input', 'textarea', 'select'].includes(record.tag)
      || (record.inForm && record.tag === 'button')
    if (!fieldish) continue
    traps.push({
      kind: trap.kind,
      selector: record.selector,
      id: record.id,
      tag: record.tag,
      name: record.selector,
      rect: record.rect,
      rules: trap.rules,
      reasons: trap.rules.map(id => honeypotRule(id)?.label ?? id),
      focusable: record.tabIndex >= 0 && record.pointerEvents !== 'none',
    })
  }
  return traps
}

/** One overlay row as the page-side scan reports it. */
export interface CaptchaOverlayRecord {
  readonly selector: string
  readonly tag: string
  readonly id: string
  readonly position: string
  readonly zIndex: string
  readonly rect: CaptchaRect
  readonly source: 'signature' | 'computed'
  readonly covers: number
}

/**
 * Build the overlay inventory and name the sticky-header height the T6 report
 * measured, so a target sitting under a 52px header has a root cause instead
 * of a mystery.
 * @param records - the overlay rows the page-side pass found.
 * @returns overlays sorted by z-index (descending) then by document order.
 */
export function classifyOverlays(records: readonly CaptchaOverlayRecord[]): CaptchaOverlay[] {
  return records
    .map(record => ({
      selector: record.selector,
      tag: record.tag,
      id: record.id,
      position: record.position,
      zIndex: record.zIndex,
      rect: record.rect,
      source: record.source,
      blocking: record.covers > 0,
    }))
    .sort((a, b) => {
      const left = Number.parseInt(b.zIndex, 10)
      const right = Number.parseInt(a.zIndex, 10)
      const leftZ = Number.isFinite(left) ? left : -1
      const rightZ = Number.isFinite(right) ? right : -1
      if (leftZ !== rightZ) return leftZ - rightZ
      return a.rect.y - b.rect.y
    })
}

/** The raw page-side frame row. */
export interface CaptchaFrameRecord {
  readonly src: string
  readonly id: string
  readonly title: string
  readonly accessible: boolean
}

/**
 * @param src - the frame's `src` attribute.
 * @returns the host when the src is absolute, else undefined.
 */
function hostOf(src: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(src)
  return match?.[1]?.toLowerCase()
}

/**
 * Classifies a third-party provider frame. The verdict is informational:
 * `third-party-present` is reported alongside the candidates. Same-origin /
 * `about:` / `data:` frames stay first-party and are walked; cross-origin
 * frames are not readable from the page context.
 *
 * The page's own host is a PARAMETER because the engine has no `location`: a
 * same-origin frame must not be mistaken for a provider.
 * @param frames - the iframes the page-side pass saw.
 * @param pageHost - the top document's hostname (empty when unknown).
 * @returns the verdict plus the recognised provider hosts.
 */
export function thirdPartyVerdict(
  frames: readonly CaptchaFrameRecord[],
  pageHost: string,
): CaptchaThirdParty {
  const rows: CaptchaFrame[] = []
  const providers = new Set<string>()
  let thirdParty = false
  for (const frame of frames) {
    const src = frame.src
    const host = hostOf(src)
    const isAbout = src === '' || src === 'about:blank' || src.startsWith('about:')
    const isData = src.startsWith('data:') || src.startsWith('blob:')
    const third = host !== undefined && !isAbout && !isData && host !== pageHost.toLowerCase()
    if (third) thirdParty = true
    if (host !== undefined) {
      // A provider is named by its PATH as often as by its host
      // (google.com/recaptcha/api2/anchor, challenges.cloudflare.com/…/turnstile),
      // so both halves are searched.
      const haystack = `${host} ${src}`.toLowerCase()
      for (const needle of CAPTCHA_PROVIDER_HOSTS) {
        if (haystack.includes(needle)) providers.add(needle)
      }
    }
    rows.push({
      src,
      id: frame.id,
      title: frame.title,
      accessible: frame.accessible,
      origin: isAbout ? 'about' : isData ? 'data' : third ? 'third-party' : 'first-party',
      ...(third && host !== undefined ? { host } : {}),
    })
  }
  const verdict: CaptchaThirdParty['verdict'] = thirdParty ? 'third-party-present' : 'first-party'
  const thirdHosts = rows.filter(row => row.origin === 'third-party').map(row => row.host ?? row.src)
  return {
    verdict,
    iframes: rows,
    providers: [...providers],
    ...(thirdParty
      ? {
        reason: 'cdp_captcha: third-party verification frame(s) present ('
          + `${thirdHosts.join(', ')}): reported alongside the candidates; `
          + 'cross-origin frames are not readable from the page context.',
      }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Slider geometry (Katman B)
// ---------------------------------------------------------------------------

/** A track/thumb measurement the drag action reads fresh at action time. */
export interface SliderGeometry {
  /** Fresh track border box. */
  readonly track: CaptchaRect
  /** Fresh thumb border box. */
  readonly thumb: CaptchaRect
  /** Percent the thumb is at right now (`0` when it cannot be derived). */
  readonly currentPct: number
  /** Viewport size, used to keep the approach path on-screen. */
  readonly viewport: { readonly width: number, readonly height: number }
  /**
   * Symmetric track inset in CSS pixels, MEASURED ONCE before the press and
   * carried through the read-back. Without it the post-release percent would be
   * re-derived from a thumb that has already travelled — and the mapping would
   * differ between "where do I release" and "what did it read back as".
   */
  /** A carried `inset` is added by the spread, never written as `undefined`. */
  readonly inset?: number | undefined
  /**
   * The page's OWN observable state around the slider, read verbatim. This is
   * what `delivered` is judged on: a percent THIS tool derived can report
   * "moved" while the page's own completion state never advanced (a live T7 run
   * hit exactly that — the thumb followed the pointer, the step's `data-done`
   * stayed `0`, and the badge still read "çözülmedi").
   */
  readonly state?: SliderStateSignature | undefined
}

/**
 * Page-authored state, read verbatim — never derived. An empty field means the
 * page does not publish that attribute, not "false".
 */
export interface SliderStateSignature {
  /** `aria-checked` of the nearest checkbox/input around the track. */
  readonly ariaChecked: string
  /** `data-done` of the nearest chain step. */
  readonly dataDone: string
  /** `data-solved` of the nearest form/host. */
  readonly dataSolved: string
  /** `data-confirmed` of the nearest host. */
  readonly dataConfirmed: string
  /** Form `value` of the nearest input, when the track is a range input. */
  readonly value: string
  /** The thumb's INLINE `style.left` in CSS px, exactly as the page set it. */
  readonly thumbLeft: string
  /** The thumb's own `data-*` completion markers, as `name=value`. */
  readonly thumbData: string[]
}

/**
 * The slider's travel in CSS pixels (`track − thumb`), floored at zero.
 * @param geometry - fresh track/thumb measurement.
 * @returns the usable travel.
 */
export function sliderTravel(geometry: SliderGeometry): number {
  return Math.max(geometry.track.width - geometry.thumb.width, 0)
}

/**
 * The track's symmetric inset — the padding a slider leaves at each end, which
 * its pointer→percent mapping spends first.
 *
 * A measurement taken at rest (`currentPct === 0`, the normal state of an
 * untouched slider) reads it EXACTLY: the thumb's left edge sits exactly at the
 * inset. That is why the drag measures it once before the press and carries it
 * into the read-back — a value re-derived from a travelled thumb would be a
 * fiction, and the envelope would say so.
 * @param geometry - the measurement (pre-press, or one carrying `inset`).
 * @returns the inset in CSS pixels.
 */
export function sliderInset(geometry: SliderGeometry): number {
  const travel = sliderTravel(geometry)
  if (typeof geometry.inset === 'number' && Number.isFinite(geometry.inset)) {
    return Math.min(Math.max(geometry.inset, 0), travel / 2)
  }
  if (geometry.currentPct > 5) return 0
  return Math.min(Math.max(geometry.thumb.x - geometry.track.x, 0), travel / 2)
}

/**
 * Read the thumb's percent from a fresh geometry.
 *
 * The convention is the one every slider shares: the pointer sits at the
 * thumb's CENTRE, a symmetric `inset` is spent at each end, and the remaining
 * travel maps linearly onto `0..100`. The drag's release point and this
 * read-back use the same function with the same inset, so `delivered` (did the
 * value move?) is self-consistent whatever the page's own internal formula is;
 * `matched` then reports the accuracy against the declared target.
 * @param geometry - fresh track/thumb measurement carrying `inset`.
 * @returns the percent in `0..100`.
 */
export function thumbPercent(geometry: SliderGeometry): number {
  const usable = sliderTravel(geometry) - 2 * sliderInset(geometry)
  if (!(usable > 0)) return 0
  const offset = geometry.thumb.x - geometry.track.x - sliderInset(geometry)
  return Math.min(Math.max((offset / usable) * 100, 0), 100)
}

/**
 * The release X for a percent, from the SAME geometry and inset the read-back
 * uses — so releasing here and reading back is an exact round trip.
 * @param geometry - fresh track/thumb measurement carrying `inset`.
 * @param pct - the requested percent.
 * @returns the viewport X to release at.
 */
export function releaseXFor(geometry: SliderGeometry, pct: number): number {
  const travel = sliderTravel(geometry)
  const inset = sliderInset(geometry)
  const usable = travel - 2 * inset
  if (!(usable > 0)) return Math.round(geometry.thumb.x + geometry.thumb.width / 2)
  const centre = geometry.track.x + inset + geometry.thumb.width / 2 + (pct / 100) * usable
  return Math.round(centre)
}

/** Options {@link buildDragPlan} honours. */
export interface DragPlanOptions {
  /** Target percent, `0..100`. Read from `data-target`/ARIA when omitted. */
  readonly targetPct: number
  /** Press-move-release step count. */
  readonly steps?: number
  /** Emit the K4 approach path before pressing. */
  readonly approach?: boolean
  /** Overshoot the target and pull back before releasing. */
  readonly overshoot?: boolean
  /** Deterministic seed — same seed ⇒ same path, always. */
  readonly seed?: string
}

/** The pure plan a drag dispatches. */
export interface DragPlan {
  /** Thumb centre — the press point. */
  readonly start: CaptchaPoint
  /** Release point for the requested percent. */
  readonly target: CaptchaPoint
  /** Where the pointer comes from before the press (K4 origin). */
  readonly origin: CaptchaPoint
  /** Approach samples (ending 12–40px short of the press point). */
  readonly approachPath: readonly CaptchaPoint[]
  /** Press → overshoot → target samples, unevenly spaced. */
  readonly dragPath: readonly CaptchaPoint[]
  /** The overshoot waypoint, when overshoot is on. */
  readonly overshoot: CaptchaPoint | null
  /** Press-hold in milliseconds. */
  readonly holdMs: number
  /** Inter-sample pauses in milliseconds (one per drag sample). */
  readonly delaysMs: readonly number[]
  /** True when `inset` had to be estimated from a mid-travel thumb. */
  readonly insetEstimated: boolean
  /** Honest caution lines. */
  warnings: string[]
}

/** K4 default seed — deterministic, never `Math.random()`. */
export const DRAG_DEFAULT_SEED = 'dsh-cdp-captcha'

/**
 * Stable FNV-1a hash — byte-for-byte the `seedNumber` helper
 * `src/stealth.ts` uses for its canvas/WebGL/audio/rects noise, re-declared here
 * because that helper is module-private. Same seed ⇒ same drag path on every
 * run, which is what makes a drag spec assertable.
 * @param seed - the caller's seed string.
 * @param domain - separates the generators.
 * @returns a stable unsigned 32-bit number.
 */
export function dragSeedNumber(seed: string, domain: string): number {
  const text = `${seed}:${domain}`
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * A deterministic `[0, 1)` source seeded by `seedNumber` — the drag's
 * `Math.random()` replacement. Every jitter, step length, and pause in a drag
 * plan reads this, so a spec pins the exact path.
 * @param seed - the caller's seed string.
 * @param domain - separates the generators from each other.
 * @returns a source yielding `[0, 1)`.
 */
export function seededSource(seed: string, domain: string): () => number {
  let state = dragSeedNumber(seed, domain) || 1
  return () => {
    // xorshift32 — deterministic, dependency-free, never all-zero.
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/** @param value - raw step count. @returns it clamped into `1..DRAG_MAX_STEPS`. */
export function clampDragSteps(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DRAG_DEFAULT_STEPS
  return Math.min(Math.max(Math.trunc(value), 4), DRAG_MAX_STEPS)
}

/** @param value - raw target percent. @returns it clamped into `0..100`. */
export function clampTargetPct(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 100)
}

/**
 * Build the whole gesture plan from a FRESH geometry — never from a stored
 * coordinate. `approach` (K4) walks in from 12–40px away with eased, uneven
 * steps; `overshoot` passes the target and pulls back, which is what a person
 * does when they are aiming at a number.
 * @param geometry - fresh track/thumb/viewport measurement.
 * @param options - target percent and the approach/overshoot switches.
 * @returns the plan plus the warnings its geometry earned.
 */
export function buildDragPlan(geometry: SliderGeometry, options: DragPlanOptions): DragPlan {
  const warnings: string[] = []
  const travel = sliderTravel(geometry)
  if (!(travel > 0)) {
    warnings.push(`track is not draggable (track width ${String(geometry.track.width)} - thumb width ${String(geometry.thumb.width)} ≤ 0)`)
  }
  if (geometry.currentPct > 5 && geometry.inset === undefined) {
    warnings.push(`inset estimated from a thumb already at ${String(Math.round(geometry.currentPct))}% — accuracy may be ±1%`)
  }
  const pressX = Math.round(geometry.thumb.x + geometry.thumb.width / 2)
  const pressY = Math.round(geometry.thumb.y + geometry.thumb.height / 2)
  const releaseX = releaseXFor(geometry, options.targetPct)
  const start: CaptchaPoint = { x: pressX, y: pressY }
  const target: CaptchaPoint = { x: releaseX, y: pressY }

  const seed = options.seed ?? DRAG_DEFAULT_SEED
  const jitter = seededSource(seed, 'jitter')
  const timing = seededSource(seed, 'timing')
  const steps = clampDragSteps(options.steps)

  // K4: stop 12–40px short of the press point so the pointer never teleports.
  const approachGap = APPROACH_MIN_PX + jitter() * (APPROACH_MAX_PX - APPROACH_MIN_PX)
  const angle = jitter() * Math.PI * 2
  const originX = Math.min(
    Math.max(pressX + Math.cos(angle) * (approachGap + 60 + jitter() * 90), 1),
    Math.max(geometry.viewport.width - 1, 1),
  )
  const originY = Math.min(
    Math.max(pressY + Math.sin(angle) * (approachGap + 40 + jitter() * 70), 1),
    Math.max(geometry.viewport.height - 1, 1),
  )
  const origin: CaptchaPoint = { x: Math.round(originX), y: Math.round(originY) }
  const prePress: CaptchaPoint = {
    x: Math.round(pressX - Math.cos(angle) * approachGap),
    y: Math.round(pressY - Math.sin(angle) * approachGap),
  }

  const approachPath: CaptchaPoint[] = []
  if (options.approach !== false) {
    const samples = 6 + Math.floor(jitter() * 5)
    for (let index = 1; index <= samples; index += 1) {
      // ease-in: slow at the start, faster as the hand commits.
      const t = index / samples
      const eased = t * t
      const wobbleX = (jitter() - 0.5) * 6
      const wobbleY = (jitter() - 0.5) * 6
      approachPath.push({
        x: Math.round(origin.x + (prePress.x - origin.x) * eased + wobbleX),
        y: Math.round(origin.y + (prePress.y - origin.y) * eased + wobbleY),
      })
    }
    approachPath[approachPath.length - 1] = prePress
  }

  // Overshoot: 4–9px past the target, then a straight pull back.
  const overshootPx = 4 + jitter() * 5
  const overshoot: CaptchaPoint | null = options.overshoot === false
    ? null
    : { x: Math.round(releaseX + overshootPx), y: pressY }

  const dragPath: CaptchaPoint[] = []
  const delaysMs: number[] = []
  const waypoints: CaptchaPoint[] = overshoot === null
    ? [target]
    : [overshoot, target]
  const legSteps = overshoot === null ? steps : Math.max(2, Math.floor(steps * 0.7))
  for (const [legIndex, waypoint] of waypoints.entries()) {
    const from = legIndex === 0 ? start : overshoot as CaptchaPoint
    const share = legIndex === 0 ? legSteps : steps - legSteps
    let travelled = 0
    for (let index = 1; index <= share; index += 1) {
      // Uneven step sizes: a hand does not travel in equal quanta.
      const t = (index / share) * (0.9 + (jitter() * 0.2))
      const clampedT = Math.min(t, 1)
      travelled += 1
      const wobble = (jitter() - 0.5) * 2.2
      dragPath.push({
        x: Math.round(from.x + (waypoint.x - from.x) * clampedT + wobble),
        y: Math.round(from.y + (waypoint.y - from.y) * clampedT + wobble * 0.6),
      })
      delaysMs.push(Math.round(8 + timing() * 16))
    }
    void travelled
  }
  if (dragPath.length > 0) dragPath[dragPath.length - 1] = target

  return {
    start,
    target,
    origin,
    approachPath,
    dragPath,
    overshoot,
    holdMs: Math.round(30 + timing() * 90),
    delaysMs,
    insetEstimated: geometry.currentPct > 5 && geometry.inset === undefined,
    warnings,
  }
}

/**
 * The delivery gate — K5 inside the tool, and where the LIVE failure surfaced.
 * A dispatched gesture proves nothing; even a moved thumb proves only that the
 * pointer moved, because a page whose `mouseup` never arrived can still leave
 * its own completion state untouched. See {@link judgeDrag}.

// ---------------------------------------------------------------------------
// Solution signals
// ---------------------------------------------------------------------------

/** The raw page-side solution snapshot. */
export interface CaptchaVerifyRecord {
  /** `selector=ariaValue` rows. */
  ariaChecked: string[]
  /** `selector=dataSolved` rows. */
  dataSolved: string[]
  /** `selector=dataConfirmed` rows. */
  dataConfirmed: string[]
  /** `selector=value(data-target)` rows. */
  sliders: string[]
  /** Badge/status texts. */
  badges: string[]
  /** `window.__t6` / `__t7`-style counters, when present. */
  readonly counters: Readonly<Record<string, unknown>> | null
}

/** @param value - a raw counter value. @returns it when it is a finite number. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** @param value - a raw counter value. @returns it when it is a boolean. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Truthy spellings a fixture uses for "solved". */
const SOLVED_TRUE = new Set(['true', '1', 'yes', 'solved', 'ok', 'done', 'çözüldü', 'çözüldü '.trim()])

/** @param raw - a `selector=value` row. @returns the value half, lowercased. */
function valueOf(raw: string): string {
  const at = raw.lastIndexOf('=')
  return (at === -1 ? raw : raw.slice(at + 1)).trim().toLowerCase()
}

/** @param rows - `selector=value` rows. @returns true when any value is "solved". */
function anySolved(rows: readonly string[]): boolean {
  return rows.some(row => SOLVED_TRUE.has(valueOf(row)))
}

/** Where a slider row's value came from — reported, never assumed. */
export type SliderValueSource =
  | 'aria-valuenow'
  | 'input-value'
  | 'data-value'
  | 'fill-width'
  | 'derived'
  | 'unavailable'
  /** A row written before the source label existed (`#track=72(72)`). */
  | 'unknown'

/** One parsed slider row: `#v6-track=fill-width:67.9(68)`. */
export interface ParsedSliderRow {
  /** The element hint the row carries. */
  readonly id: string
  /** Which channel produced the value. */
  readonly source: SliderValueSource
  /** The value in percent, or undefined when the page publishes none. */
  readonly value: number | undefined
  /** The declared target, or undefined when none is declared. */
  readonly target: number | undefined
}

/**
 * Parse one slider row. A value or target the page does not publish comes back
 * as `undefined`, NEVER as `0` — the same rule the fixture counters follow.
 * @param row - a raw `id=source:value(target)` row.
 * @returns the parsed row, or undefined when the shape is unrecognised.
 */
export function parseSliderRow(row: string): ParsedSliderRow | undefined {
  const open = row.indexOf('(')
  const close = row.lastIndexOf(')')
  if (!row.includes('=') || open === -1 || close < open) return undefined
  const equals = row.indexOf('=')
  const id = row.slice(0, equals)
  /* plan11-fix-derived: a row is id=source:value(target), and the source used
     to be sliced all the way to the bracket — so 'derived:0' arrived AS the
     source. Every value then parsed, but `parsed.source` matched no member of
     SliderValueSource, which left the 'reconstructed from the thumb' warning
     dead code and put an anonymous 'derived:0' in the type. The split belongs
     on the FIRST colon; a row with no colon is the older id=value(target)
     shape and is reported as 'unknown', never as a channel it never named. */
  const field = row.slice(equals + 1, open)
  const colon = field.indexOf(':')
  const source = (colon === -1 ? 'unknown' : field.slice(0, colon)) as SliderValueSource
  const valueText = colon === -1 ? field : field.slice(colon + 1)
  const body = row.slice(open + 1, close)
  const target = Number.parseFloat(body)
  const value = Number.parseFloat(valueText)
  return {
    id,
    source,
    value: Number.isFinite(value) ? value : undefined,
    target: Number.isFinite(target) ? target : undefined,
  }
}

/** @param rows - `id=source:value(target)` rows. @returns true when one matches. */
function anySliderSolved(rows: readonly string[]): boolean {
  return rows.some((row) => {
    const parsed = parseSliderRow(row)
    if (parsed === undefined || parsed.value === undefined || parsed.target === undefined) return false
    return Math.abs(parsed.value - parsed.target) <= SLIDER_TOLERANCE_PCT
  })
}

/**
 * Read the solution state in one call — the metric table T6 assembled by hand.
 * Every counter the page does not expose is OMITTED from the envelope, never
 * invented: `wrongClicks` absent means "this page does not count them", not
 * "zero wrong clicks".
 * @param record - the page-side snapshot.
 * @returns the signals plus whatever counters the page actually published.
 */
export function collectSolutionSignals(record: CaptchaVerifyRecord): {
  readonly solved: boolean,
  readonly signals: CaptchaSignals,
  readonly wrongClicks?: number,
  readonly decoyClicks?: number,
  readonly honeypotHit?: boolean,
  readonly solvedAt?: number,
  warnings: string[],
} {
  const signals: CaptchaSignals = {
    ariaChecked: [...record.ariaChecked],
    dataSolved: [...record.dataSolved],
    dataConfirmed: [...record.dataConfirmed],
    sliders: [...record.sliders],
    badges: [...record.badges],
    flags: [],
  }
  const counters = record.counters
  const flags: string[] = []
  let solved = anySolved(record.ariaChecked)
    || anySolved(record.dataSolved)
    || anySolved(record.dataConfirmed)
    || anySliderSolved(record.sliders)

  let wrongClicks: number | undefined
  let decoyClicks: number | undefined
  let honeypotHit: boolean | undefined
  let solvedAt: number | undefined
  const warnings: string[] = []

  // A slider the page publishes no channel for is UNREADABLE, not zero. A live
  // T7 run read a solved slider as 0 because a thumb-rect heuristic degraded
  // on an already-travelled thumb; the fix is the source ladder in the page
  // probe, and the honesty is this warning.
  for (const row of record.sliders) {
    const parsed = parseSliderRow(row)
    if (parsed === undefined) {
      warnings.push(`slider row '${row}' is not in the documented id=source:value(target) shape and was ignored`)
      continue
    }
    if (parsed.value === undefined) {
      warnings.push(`slider ${parsed.id} publishes no readable value channel (aria-valuenow / input value / data-value / fill width) — its value is unavailable, not zero`)
    } else if (parsed.source === 'derived') {
      warnings.push(`slider ${parsed.id} value was reconstructed from the thumb's box (${String(parsed.value)}%), not read from a published channel`)
    }
    if (parsed.target === undefined) {
      warnings.push(`slider ${parsed.id} declares no target (data-target) — it cannot be judged as solved`)
    }
  }

  if (counters === null) {
    warnings.push('no window.__t6/__t7-style counter object on this page — wrongClick/decoy/honeypot metrics are unavailable (not zero)')
  } else {    wrongClicks = asNumber(counters.wrongClicks)
    decoyClicks = asNumber(counters.decoyClicks)
    honeypotHit = asBoolean(counters.honeypotHit)
    for (const [key, value] of Object.entries(counters)) {
      if (key === 'wrongClicks' || key === 'decoyClicks' || key === 'honeypotHit') continue
      if (typeof value === 'boolean') {
        if (value) {
          flags.push(`${key}=true`)
          solved = true
        } else {
          flags.push(`${key}=false`)
        }
        continue
      }
      if (key === 'resolved' || key === 'solvedAt') {
        if (typeof value === 'object' && value !== null) {
          for (const [inner, stamp] of Object.entries(value as Record<string, unknown>)) {
            const at = asNumber(stamp)
            if (at === undefined) continue
            flags.push(`${inner}@${String(at)}`)
            solved = true
            solvedAt = Math.max(solvedAt ?? at, at)
          }
        }
        continue
      }
      if (asNumber(value) !== undefined) flags.push(`${key}=${String(value)}`)
    }
    if (wrongClicks === undefined) warnings.push('the page exposes no wrongClicks counter — the wrong-press metric is unavailable (not zero)')
  }

  return {
    solved,
    signals: { ...signals, flags },
    ...(wrongClicks !== undefined ? { wrongClicks } : {}),
    ...(decoyClicks !== undefined ? { decoyClicks } : {}),
    ...(honeypotHit !== undefined ? { honeypotHit } : {}),
    ...(solvedAt !== undefined ? { solvedAt } : {}),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

/** @param value - a candidate record. @returns true when it is usable. */
function isRecord(value: unknown): value is CaptchaScanRecord {
  return typeof value === 'object' && value !== null && 'selector' in value && 'rect' in value
}

/** @param value - a candidate number. @returns it when finite, else 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** @param value - a candidate string. @returns it when a string, else ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** @param value - a candidate rect. @returns a normalized rect. */
function rectOf(value: unknown): CaptchaRect {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return { x: num(record.x), y: num(record.y), width: num(record.width), height: num(record.height) }
}

/** Normalize one page-side record; unknown fields become honest defaults. */
export function normalizeScanRecord(value: unknown): CaptchaScanRecord {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    selector: str(record.selector),
    tag: str(record.tag).toLowerCase(),
    id: str(record.id),
    role: str(record.role),
    name: str(record.name),
    rect: rectOf(record.rect),
    visible: record.visible === true,
    inViewport: record.inViewport === true,
    hitIsTarget: record.hitIsTarget === true,
    hitTag: str(record.hitTag),
    pointerEvents: str(record.pointerEvents),
    position: str(record.position),
    opacity: num(record.opacity),
    tabIndex: num(record.tabIndex),
    ariaHidden: record.ariaHidden === true,
    frame: str(record.frame) || 'top',
    ariaChecked: str(record.ariaChecked),
    dataSolved: str(record.dataSolved),
    dataConfirmed: str(record.dataConfirmed),
    dataTarget: str(record.dataTarget),
    dataDone: str(record.dataDone),
    dataAnswer: str(record.dataAnswer),
    dataLabel: str(record.dataLabel),
    dataVariant: str(record.dataVariant),
    decoy: record.decoy === true,
    dynamicTarget: record.dynamicTarget === true,
    inForm: record.inForm === true,
    rangeInput: record.rangeInput === true,
    checkboxInput: record.checkboxInput === true,
    coverLike: record.coverLike === true,
    chainStep: record.chainStep === true,
    covers: num(record.covers),
    trapHits: num(record.trapHits),
    trapRuleIds: Array.isArray(record.trapRuleIds) ? record.trapRuleIds.map(str) : [],
    offscreen: record.offscreen === true,
    announcedAbsent: record.announcedAbsent === true,
    driftPx: num(record.driftPx),
    // plan11-fix-scan-rect: carried only when the page reported them, so an
    // older page script cannot fake a scroll offset it never measured.
    ...(typeof record.measuredAtScrollY === 'number' && Number.isFinite(record.measuredAtScrollY)
      ? { measuredAtScrollY: record.measuredAtScrollY } : {}),
    ...(typeof record.scrollRestored === 'boolean' ? { scrollRestored: record.scrollRestored } : {}),
  }
}

/** The parsed page-side scan reply. */
export interface ParsedScanReply {
  readonly ok: boolean
  readonly reason: string
  readonly url: string
  readonly host: string
  readonly records: readonly CaptchaScanRecord[]
  readonly overlays: readonly CaptchaOverlayRecord[]
  readonly frames: readonly CaptchaFrameRecord[]
  warnings: string[]
}

/**
 * Parse the `scan` page-side reply. A malformed or failed reply becomes an
 * in-band `ok:false` with the page's own reason — never an empty swallow.
 * @param raw - the JSON string the page returned.
 * @returns the parsed reply; `ok:false` when the page refused or misbehaved.
 */
export function parseScanReply(raw: string): ParsedScanReply {
  const empty: ParsedScanReply = {
    ok: false,
    reason: 'cdp_captcha: the page-side scan returned no value',
    url: '',
    host: '',
    records: [],
    overlays: [],
    frames: [],
    warnings: [],
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ...empty, reason: `cdp_captcha: scan reply is not JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const reply = parsed as Record<string, unknown>
  if (reply.ok !== true) {
    return { ...empty, reason: str(reply.reason) || 'cdp_captcha: the page-side scan failed' }
  }
  const records = Array.isArray(reply.records) ? reply.records.filter(isRecord).map(normalizeScanRecord) : []
  const overlays = Array.isArray(reply.overlays) ? reply.overlays.map((value) => {
    const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    return {
      selector: str(row.selector),
      tag: str(row.tag),
      id: str(row.id),
      position: str(row.position),
      zIndex: str(row.zIndex),
      rect: rectOf(row.rect),
      source: row.source === 'computed' ? 'computed' as const : 'signature' as const,
      covers: num(row.covers),
    }
  }) : []
  const frames = Array.isArray(reply.frames) ? reply.frames.map((value) => {
    const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    return {
      src: str(row.src),
      id: str(row.id),
      title: str(row.title),
      accessible: row.accessible === true,
    }
  }) : []
  const warnings = Array.isArray(reply.warnings) ? reply.warnings.map(str) : []
  if (reply.truncated === true) {
    /* plan11-fix-scan-cap: `truncated` now means "a scan budget stopped this",
       which is either the record cap or the 16 KiB byte cap — the page's own
       warning names which, so this line only has to say the honest thing:
       whatever is listed is PARTIAL. */
    warnings.push(`the page-side scan stopped at a scan budget (${String(CAPTCHA_SCAN_MAX_RECORDS)} records or 16 KiB) — the inventory below is partial`)
  }
  return {
    ok: true,
    reason: '',
    url: str(reply.url),
    host: str(reply.host),
    records,
    overlays,
    frames,
    warnings,
  }
}

/**
 * Parse the `verify` page-side reply.
 * @param raw - the JSON string the page returned.
 * @returns the snapshot, or an empty honest one when the page refused.
 */
export function parseVerifyReply(raw: string): { ok: boolean, reason: string, record: CaptchaVerifyRecord } {
  const empty: CaptchaVerifyRecord = {
    ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], counters: null,
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `cdp_captcha: verify reply is not JSON (${error instanceof Error ? error.message : String(error)})`, record: empty }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'cdp_captcha: the page-side verify returned nothing', record: empty }
  }
  const reply = parsed as Record<string, unknown>
  if (reply.ok !== true) {
    return { ok: false, reason: str(reply.reason) || 'cdp_captcha: the page-side verify failed', record: empty }
  }
  const rows = (key: string): string[] => (Array.isArray(reply[key]) ? (reply[key] as unknown[]).map(str) : [])
  const countersRaw = reply.counters
  const counters = typeof countersRaw === 'object' && countersRaw !== null
    ? countersRaw as Record<string, unknown>
    : null
  return {
    ok: true,
    reason: '',
    record: {
      ariaChecked: rows('ariaChecked'),
      dataSolved: rows('dataSolved'),
      dataConfirmed: rows('dataConfirmed'),
      sliders: rows('sliders'),
      badges: rows('badges'),
      counters,
    },
  }
}

/**
 * Parse the drag measurement page-side reply into a fresh geometry.
 * @param raw - the JSON string the page returned.
 * @returns the geometry (plus the page's own state signature), or `null` when
 *   the track/thumb could not be read.
 */
export function parseDragMeasureReply(raw: string): (SliderGeometry & { readonly state: SliderStateSignature }) | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const reply = parsed as Record<string, unknown>
  if (reply.ok !== true) return null
  const track = rectOf(reply.track)
  const thumb = rectOf(reply.thumb)
  if (track.width <= 0 || thumb.width <= 0) return null
  const viewportRaw = typeof reply.viewport === 'object' && reply.viewport !== null
    ? reply.viewport as Record<string, unknown>
    : {}
  const stateRaw = typeof reply.state === 'object' && reply.state !== null
    ? reply.state as Record<string, unknown>
    : {}
  return {
    track,
    thumb,
    currentPct: num(reply.currentPct),
    viewport: { width: num(viewportRaw.width) || 1024, height: num(viewportRaw.height) || 768 },
    state: {
      ariaChecked: str(stateRaw.ariaChecked),
      dataDone: str(stateRaw.dataDone),
      dataSolved: str(stateRaw.dataSolved),
      dataConfirmed: str(stateRaw.dataConfirmed),
      value: str(stateRaw.value),
      thumbLeft: str(stateRaw.thumbLeft),
      thumbData: Array.isArray(stateRaw.thumbData) ? stateRaw.thumbData.map(str) : [],
    },
  }
}

/** How a drag's delivery was proven. `none` is the honest failure. */
export type DragVerdictSource = 'value-moved' | 'state-changed' | 'both' | 'none'

/**
 * @param before - the state signature read before the press.
 * @param after - the state signature read after the release.
 * @returns the fields that differ, as `name: before → after` lines; empty when
 *   the page published nothing at all (which is a DIFFERENT answer from
 *   "nothing changed" — the caller must be able to tell them apart).
 */
export function stateDifferences(
  before: SliderStateSignature | undefined,
  after: SliderStateSignature | undefined,
): string[] {
  if (before === undefined || after === undefined) return []
  const diffs: string[] = []
  for (const key of ['ariaChecked', 'dataDone', 'dataSolved', 'dataConfirmed', 'value', 'thumbLeft'] as const) {
    const from = before[key]
    const to = after[key]
    if (from !== to) diffs.push(`${key}: ${from === '' ? '(absent)' : from} → ${to === '' ? '(absent)' : to}`)
  }
  const fromFlags = new Set(before.thumbData)
  const toFlags = new Set(after.thumbData)
  for (const flag of toFlags) {
    if (!fromFlags.has(flag)) diffs.push(`thumb ${flag} appeared`)
  }
  for (const flag of fromFlags) {
    if (!toFlags.has(flag)) diffs.push(`thumb ${flag} disappeared`)
  }
  return diffs
}

/**
 * The delivery gate — K5 inside the tool. A dispatched gesture proves nothing.
 *
 * Delivery needs **TWO independent observations, and both of them**:
 *  - the read-back REACHED the requested target — `|afterValue − expected|`
 *    within {@link SLIDER_TOLERANCE_PCT};
 *  - something observable changed — the thumb's own geometry moved
 *    (`value-moved`) or the page's own completion state (`data-done`,
 *    `aria-checked`, `data-solved`, the thumb's inline `left`, …) changed
 *    (`state-changed`).
 *
 * The old gate accepted EITHER observation, and a live run showed why that is
 * the most dangerous shape a tool can have — a SILENT SUCCESS. The gesture
 * collapsed (press 464,301 → release 463,301, one pixel), the read-back never
 * moved, yet the page's `data-done` had already flipped 0→1 for its own
 * reasons, so the envelope read "DELIVERED" while the requested `targetPct:20`
 * was never applied at all. A change that proves nothing is not evidence: a
 * gesture is delivered when it got the thumb to the target AND the page
 * reacted.
 *
 * `matched` stays exactly as it was — the accuracy report — so a caller can
 * still see how far off the release was. `verifiedBy` still names which
 * observation fired; `delivered` is what requires BOTH plus the target.
 * @param beforeValue - percent before the press.
 * @param afterValue - percent after the release.
 * @param expected - percent the geometry asked for.
 * @param diffs - the page-state differences between the two reads.
 * @returns what was proven, whether it landed within tolerance, and the diffs.
 */
export function judgeDrag(
  beforeValue: number,
  afterValue: number,
  expected: number,
  diffs: readonly string[] = [],
): {
  readonly delivered: boolean
  readonly matched: boolean
  readonly verifiedBy: DragVerdictSource
  readonly stateDiffs: string[]
} {
  const valueMoved = Math.abs(afterValue - beforeValue) > 0.01
  const stateChanged = diffs.length > 0
  const verifiedBy: DragVerdictSource = valueMoved && stateChanged
    ? 'both'
    : valueMoved ? 'value-moved' : stateChanged ? 'state-changed' : 'none'
  const matched = Math.abs(afterValue - expected) <= SLIDER_TOLERANCE_PCT
  // K5b: the read-back must have LANDED, not merely moved, and something the
  // page published must have changed. A thumb that wandered elsewhere and a
  // page that flipped an unrelated flag are both "not delivered".
  const delivered = matched && verifiedBy !== 'none'
  return {
    delivered,
    matched,
    verifiedBy,
    stateDiffs: [...diffs],
  }
}

/** @param raw - a raw page-side string row. @returns the trimmed string. */
export function cleanRow(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** One rendered text part (the tool output contract). */
export interface CaptchaRenderPart {
  /** Always `text`. */
  readonly type: 'text'
  /** The rendered body. */
  readonly text: string
}

/** The loose shape a captcha envelope has at render time. */
interface RenderableCaptcha {
  ok?: unknown
  action?: unknown
  found?: unknown
  url?: unknown
  reason?: unknown
  candidates?: unknown
  overlays?: unknown
  honeypots?: unknown
  thirdParty?: unknown
  delivered?: unknown
  startX?: unknown
  startY?: unknown
  targetX?: unknown
  targetY?: unknown
  finalValue?: unknown
  expectedValue?: unknown
  beforeValue?: unknown
  matched?: unknown
  verifiedBy?: unknown
  stateDiffs?: unknown
  deltaMs?: unknown
  attempts?: unknown
  solved?: unknown
  signals?: unknown
  wrongClicks?: unknown
  decoyClicks?: unknown
  honeypotHit?: unknown
  solvedAt?: unknown
  warnings?: unknown
}

/** @param value - any render-time scalar. @returns it as a trimmed string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** @param value - a candidate list. @returns it as a record array. */
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
}

/** @param value - a string list. @returns it as a string array. */
function lines(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : []
}

/**
 * Render one `cdp_captcha` envelope.
 *
 * The envelope discipline shows up here too: an `ok:false` NEVER renders a
 * success phrase. `Captcha scan failed: …` / `Captcha drag failed: …` /
 * `Captcha verify failed: …` are the only shapes a refusal can take, and the
 * third-party verdict is stated in words, not implied by a count.
 * @param value - the envelope the tool returned.
 * @returns the text parts handed to the model.
 */
export function renderCaptcha(value: unknown): CaptchaRenderPart[] {
  const envelope = (typeof value === 'object' && value !== null ? value : {}) as RenderableCaptcha
  const action = text(envelope.action)
  const warningLines = lines(envelope.warnings)
  if (envelope.ok !== true) {
    const reason = text(envelope.reason) || 'unknown error'
    const out = [`Captcha ${action || 'scan'} failed: ${reason}`]
    // A third-party block is the single most important line of a failed scan,
    // so it is stated in the refusal itself — never left to the raw data.
    const blocked = (typeof envelope.thirdParty === 'object' && envelope.thirdParty !== null
      ? envelope.thirdParty as Record<string, unknown>
      : {}) as Record<string, unknown>
    if (text(blocked.verdict) === 'third-party-present') {
      out.push('third-party verdict: third-party-present — reported alongside the candidates.')
    }
    const found = typeof envelope.found === 'number' ? envelope.found : 0
    if (found > 0) {
      for (const candidate of rows(envelope.candidates)) {
        const rect = (typeof candidate.rect === 'object' && candidate.rect !== null
          ? candidate.rect as Record<string, unknown>
          : {}) as Record<string, unknown>
        out.push(`  still detected: [${text(candidate.kind)}] ${text(candidate.selector)} · hit=${text(candidate.hitTest)} · box(${text(rect.x)},${text(rect.y)})`)
      }
    }
    if (warningLines.length > 0) out.push(`- ${warningLines.join('\n- ')}`)
    return [{ type: 'text', text: out.join('\n') }]
  }
  if (action === 'drag') {
    const delivered = envelope.delivered === true
    const linesOut = [
      `Captcha drag: ${delivered ? 'DELIVERED' : 'NOT DELIVERED'}`
        + ` (value ${text(envelope.beforeValue)}% → ${text(envelope.finalValue)}%, target ${text(envelope.expectedValue)}%,`
        + ` matched=${String(envelope.matched === true)}, ${text(envelope.deltaMs)}ms, ${text(envelope.attempts)} attempt(s))`,
      `press (${text(envelope.startX)}, ${text(envelope.startY)}) → release (${text(envelope.targetX)}, ${text(envelope.targetY)})`
        + ` · verified by: ${text(envelope.verifiedBy) || 'none'}`,
    ]
    for (const diff of lines(envelope.stateDiffs)) linesOut.push(`state: ${diff}`)
    if (warningLines.length > 0) linesOut.push(`warnings:\n- ${warningLines.join('\n- ')}`)
    return [{ type: 'text', text: linesOut.join('\n') }]
  }
  if (action === 'verify') {
    const signals = (typeof envelope.signals === 'object' && envelope.signals !== null
      ? envelope.signals as Record<string, unknown>
      : {}) as Record<string, unknown>
    const linesOut = [`Captcha verify: ${envelope.solved === true ? 'SOLVED' : 'not solved'}`]
    for (const key of ['ariaChecked', 'dataSolved', 'dataConfirmed', 'sliders', 'badges', 'flags']) {
      const value2 = lines(signals[key])
      if (value2.length > 0) linesOut.push(`${key}: ${value2.join(', ')}`)
    }
    const metrics: string[] = []
    if (typeof envelope.wrongClicks === 'number') metrics.push(`wrongClicks=${String(envelope.wrongClicks)}`)
    if (typeof envelope.decoyClicks === 'number') metrics.push(`decoyClicks=${String(envelope.decoyClicks)}`)
    if (typeof envelope.honeypotHit === 'boolean') metrics.push(`honeypotHit=${String(envelope.honeypotHit)}`)
    if (typeof envelope.solvedAt === 'number') metrics.push(`solvedAt=${String(envelope.solvedAt)}`)
    linesOut.push(`metrics: ${metrics.length > 0 ? metrics.join(' · ') : 'unavailable on this page (not zero)'}`)
    if (warningLines.length > 0) linesOut.push(`warnings:\n- ${warningLines.join('\n- ')}`)
    return [{ type: 'text', text: linesOut.join('\n') }]
  }
  // scan
  const candidates = rows(envelope.candidates)
  const third = (typeof envelope.thirdParty === 'object' && envelope.thirdParty !== null
    ? envelope.thirdParty as Record<string, unknown>
    : {}) as Record<string, unknown>
  const verdict = text(third.verdict) || 'unknown'
  const linesOut = [
    `Captcha scan: ${text(envelope.found)} first-party candidate(s) · third-party verdict: ${verdict}`,
  ]
  for (const candidate of candidates) {
    const rect = (typeof candidate.rect === 'object' && candidate.rect !== null
      ? candidate.rect as Record<string, unknown>
      : {}) as Record<string, unknown>
    // plan11-fix-scan-rect: an empty blockedBy prints nothing. Before, a hit
    // test that could not run (the box was off-screen and the probe point was
    // clamped to a viewport edge) rendered as a confident "(covered by div)".
    const blockedBy = text(candidate.blockedBy)
    linesOut.push(
      `- [${text(candidate.kind)}] ${text(candidate.selector)}`
      + ` · hit=${text(candidate.hitTest)}`
      + (blockedBy === '' ? '' : ` (covered by ${blockedBy})`)
      + ` · box(${text(rect.x)},${text(rect.y)},${text(rect.width)}×${text(rect.height)})`
      + (candidate.frame === 'top' || !candidate.frame ? '' : ` · ${text(candidate.frame)}`),
    )
    // plan11-fix-scan-rect: a box measured at a scroll offset the page is not
    // on cannot be aimed at. Say so where the box is printed, not in a footer
    // the agent has already stopped reading.
    const measuredAt = typeof candidate.measuredAtScrollY === 'number' ? candidate.measuredAtScrollY : null
    const stale = candidate.scrollRestored === false
    if (stale || (measuredAt !== null && candidate.inViewport !== true)) {
      linesOut.push(
        `    ⚠ this box was measured at scrollY=${text(measuredAt)}`
        + (stale ? ' and the scan could NOT restore the page scroll' : ' (off the viewport — the scan scrolled to probe it)')
        + ' — RE-MEASURE before clicking: scroll the element into view and read a fresh rect, never this one.',
      )
    }
  }
  for (const overlay of rows(envelope.overlays)) {
    linesOut.push(`overlay: ${text(overlay.selector)} (${text(overlay.position)} z=${text(overlay.zIndex)}${overlay.blocking === true ? ', BLOCKING' : ''})`)
  }
  for (const trap of rows(envelope.honeypots)) {
    linesOut.push(`honeypot [${text(trap.kind)}]: ${text(trap.selector)} — ${lines(trap.reasons).join('; ')}`)
  }
  if (verdict === 'third-party-present') {
    linesOut.push(`third-party frames: ${rows(third.iframes).filter(frame => text(frame.origin) === 'third-party').map(frame => text(frame.host) || text(frame.src)).join(', ')}`)
    linesOut.push('third-party verdict: reported alongside candidates; the walk covers same-origin frames.')
  }
  if (warningLines.length > 0) linesOut.push(`warnings:\n- ${warningLines.join('\n- ')}`)
  return [{ type: 'text', text: linesOut.join('\n') }]
}

// ---------------------------------------------------------------------------
// Page-side expressions
// ---------------------------------------------------------------------------

/**
 * The page-side `scan` scanner. Returns a JSON string; every declaration lives
 * inside the IIFE (plan02 F3: an injected script must not collide with page
 * scope, so a `let failures` at top level is exactly the bug that broke
 * `cdp_fill`). It walks the top document plus same-origin frames (depth ≤
 * {@link CAPTCHA_MAX_FRAME_DEPTH}), measures every candidate FRESH, scrolls
 * off-screen ones into view, re-measures, hit-tests the centre IN THAT SCROLL
 * FRAME, then restores the scroll position it found and RE-MEASURES the box it
 * reports. plan11-fix-scan-rect: a rect and a hit-test point are both viewport
 * coordinates, so measuring scrolled and probing un-scrolled mixed two axes and
 * published a box no agent could click; the reported box is now always valid at
 * the `measuredAtScrollY` it carries, and `scrollRestored:false` says outright
 * that the page is left somewhere else.
 */
export const CAPTCHA_SCAN_EXPRESSION: string = `(() => {
  /* plan11-fix-verify: the same envelope discipline the verify script now
     has. The scan refuses a page just as often, and a swallowed error is a
     swallowed diagnosis — 'the page-side scan failed' with no cause is what a
     silent 'view is not defined' looked like from the outside. */
  const fail = (error) => {
    let message = '';
    try {
      message = (error && error.message) ? String(error.message) : String(error);
    } catch (nested) {
      try { message = 'unreadable error (' + Object.prototype.toString.call(error) + ')'; }
      catch (deeper) { message = 'unreadable error'; }
    }
    return 'cdp_captcha: the page-side scan failed (' + message + ')';
  };
  const refusal = (error) => JSON.stringify({
    ok: false, url: '', host: '', records: [], overlays: [], frames: [],
    warnings: [], truncated: false, reason: fail(error),
  });
  try {
  return JSON.stringify((() => {
  const out = { ok: true, url: '', host: '', records: [], overlays: [], frames: [], warnings: [], truncated: false };
  try {
    out.url = String(location.href);
    out.host = String(location.hostname || '');
    const CANDIDATE_SELECTOR = ${JSON.stringify(CAPTCHA_CANDIDATE_SELECTOR)};
    const OVERLAY_SELECTOR = ${JSON.stringify(OVERLAY_SELECTORS)};
    const MAX_RECORDS = ${String(CAPTCHA_SCAN_MAX_RECORDS)};
    const MAX_SCAN = ${String(CAPTCHA_OVERLAY_MAX_SCAN)};
    const MAX_DEPTH = ${String(CAPTCHA_MAX_FRAME_DEPTH)};
    const OFFSCREEN_PX = ${String(HONEYPOT_OFFSCREEN_PX)};
    const OPACITY_MAX = ${String(HONEYPOT_OPACITY_MAX)};
    /* plan11-fix-scan-cap: the reply has to survive the host's 16 KiB cut, and
       a cut JSON string is not a partial answer — it is an unparseable one. The
       three budgets below are what the page spends on its own evidence; the hard
       one is the backstop for everything else (URL, warnings, a pathological
       selector path). */
    const RECORD_BUDGET = ${String(CAPTCHA_SCAN_RECORD_BUDGET_CHARS)};
    const OVERLAY_BUDGET = ${String(CAPTCHA_SCAN_OVERLAY_BUDGET_CHARS)};
    const HARD_BUDGET = ${String(CAPTCHA_SCAN_HARD_BUDGET_CHARS)};
    const BUDGET_REASON = ${JSON.stringify(CAPTCHA_SCAN_BUDGET_REASON)};
    const sizeOf = (value) => {
      try { return JSON.stringify(value).length; } catch (error) { return 0; }
    };
    /* A record carries 39 fields and most of them are false, 0 or '' on any
       given element — roughly 280 of its ~750 bytes are key names for values
       the host already reconstructs as defaults (normalizeScanRecord maps a
       missing field to the same '' / false / 0 the page would have written).
       So the page omits what says nothing and the host fills it back in. The
       fields below are the ones a default would CHANGE, not merely restate:
       'static' position and 'auto' pointer-events are the two values the trap
       rules compare against, and the scan-rect contract is that
       measuredAtScrollY / scrollRestored are reported rather than implied. */
    const KEEP_ALWAYS = ['selector', 'tag', 'rect', 'visible', 'inViewport', 'hitIsTarget', 'hitTag', 'pointerEvents', 'position', 'frame', 'measuredAtScrollY', 'scrollRestored'];
    const compact = (row) => {
      const out = {};
      for (const key of Object.keys(row)) {
        const value = row[key];
        if (KEEP_ALWAYS.indexOf(key) !== -1) { out[key] = value; continue; }
        if (Array.isArray(value) ? value.length > 0 : value === true) { out[key] = value; continue; }
        if (typeof value === 'string' ? value !== '' : typeof value === 'number' ? value !== 0 : false) out[key] = value;
      }
      return out;
    };

    const shortText = (el) => {
      const raw = typeof el.innerText === 'string' ? el.innerText : String(el.textContent || '');
      const flat = raw.replace(/\\s+/g, ' ').trim();
      return flat.length > 80 ? flat.slice(0, 80) : flat;
    };
    // One style reader for every pass. A detached/adopted node can have no
    // ownerDocument, and a document can expose no defaultView; the inline
    // style is the honest floor rather than a thrown scan.
    const viewOf = (doc) => doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const styleOf = (doc, el) => {
      const view = viewOf(doc);
      try {
        if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
      } catch (error) { /* fall through to the inline style */ }
      return el.style || {};
    };
    const pathOf = (el) => {
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        let part = node.localName || String(node.tagName || '').toLowerCase();
        if (node.id) {
          parts.unshift(part + '#' + node.id);
          break;
        }
        const cls = String(node.className || '').trim().split(/\\s+/).filter(Boolean)[0];
        if (cls) part += '.' + cls;
        const parent = node.parentElement;
        if (parent) {
          let index = 1;
          for (const sibling of parent.children) {
            if (sibling === node) break;
            if (sibling.localName === node.localName) index += 1;
          }
          if (index > 1) part += ':nth-of-type(' + index + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
        depth += 1;
      }
      return parts.join('>');
    };
    const describe = (top) => {
      // localName, never a "tag" property: a DOM element has no .tag field, so
      // the occluder name would degrade to 'unknown' on every real page too.
      const el = top.localName ? String(top.localName).toLowerCase() : '';
      const id = top.id ? '#' + top.id : '';
      return (el || 'unknown') + id;
    };
    const trapRuleIds = (signals) => {
      const ids = [];
      if (signals.offscreen) ids.push('offscreen');
      if (signals.opacity <= 0) ids.push('opacity-zero');
      else if (signals.opacity <= OPACITY_MAX) ids.push('opacity-near-zero');
      if (signals.tabIndex < 0) ids.push('tabindex-removed');
      if (signals.pointerEvents === 'none') ids.push('pointer-events-none');
      if (signals.ariaHidden) ids.push('aria-hidden');
      if (signals.position === 'static' && signals.laidOut && signals.opacity <= OPACITY_MAX) ids.push('static-position');
      return ids;
    };

    // Every iframe on the page, with enough provenance to judge first vs third party.
    for (const frame of Array.from(document.querySelectorAll('iframe,frame'))) {
      const src = frame.getAttribute('src') || '';
      let accessible = false;
      try { accessible = !!frame.contentDocument; } catch (error) { accessible = false; }
      out.frames.push({
        src: src,
        id: String(frame.id || ''),
        title: String(frame.getAttribute('title') || ''),
        accessible: accessible,
      });
    }

    const seen = new Set();
    const measure = (doc, label, depth) => {
      let elements = [];
      try { elements = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR.join(','))); } catch (error) { return; }
      for (const el of elements) {
        if (out.records.length >= MAX_RECORDS) { out.truncated = true; return; }
        if (seen.has(el)) continue;
        seen.add(el);
        const view = viewOf(doc);
        const style = styleOf(doc, el);
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        const inViewport = rect.bottom > 0 && rect.right > 0
          && rect.top < (view.innerHeight || 0) && rect.left < (view.innerWidth || 0);
        const first = { x: rect.x, y: rect.y };
        let driftPx = 0;
        let probeRect = rect;
        /* plan11-fix-scan-rect: TWO coordinate systems were being mixed. A
         * getBoundingClientRect is a VIEWPORT (client) coordinate and so is
         * the point elementFromPoint wants — but the probe scroll was undone
         * BEFORE the hit test, so the box handed to the agent (measured while
         * scrolled) and the point the hit test probed (measured after the
         * restore) differed by the whole scroll offset. An agent aiming at that
         * box clicked a different element 3 times out of 3: #v9 was published at
         * y=416 while the element actually sat at 1117. The scroll is now
         * restored AFTER the hit test, and the box the caller gets is RE-MEASURED
         * at the offset the page is left on. */
        let reportRect = rect;
        let measuredAtScrollY = Number(view.scrollY) || 0;
        let scrollRestored = true;
        // K2: measure -> scrollIntoView -> RE-MEASURE -> hit-test -> restore.
        // A read-only scan still never leaves the page moved; the restore just
        // runs LAST, in the same frame as the point the hit test used.
        let restore = null;
        if (!inViewport && typeof el.scrollIntoView === 'function') {
          try {
            restore = { x: Number(view.scrollX) || 0, y: Number(view.scrollY) || 0 };
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            probeRect = el.getBoundingClientRect();
            driftPx = Math.round(Math.hypot(probeRect.x - first.x, probeRect.y - first.y));
          } catch (error) { restore = null; }
        }
        const cx = Math.min(Math.max(probeRect.left + probeRect.width / 2, 0), Math.max((view.innerWidth || 1) - 1, 0));
        const cy = Math.min(Math.max(probeRect.top + probeRect.height / 2, 0), Math.max((view.innerHeight || 1) - 1, 0));
        let hitIsTarget = false;
        let hitTag = '';
        try {
          const top = doc.elementFromPoint(cx, cy);
          hitIsTarget = !!top && (top === el || el.contains(top));
          if (top) hitTag = describe(top);
        } catch (error) { hitTag = 'unknown'; }
        /* plan11-fix-scan-rect: put the page back, then measure the box the
         * caller will actually click in. The reportRect is always valid AT
         * measuredAtScrollY; when the page refused to go back, that offset is
         * reported (and flagged) instead of a box that describes neither
         * position. A stale box is published as a stale box, never as a
         * plausible one. */
        if (restore !== null) {
          try {
            if (typeof view.scrollTo === 'function') view.scrollTo(restore.x, restore.y);
          } catch (error) { /* the verdict below reports the unrestored page */ }
          try {
            const settled = el.getBoundingClientRect();
            measuredAtScrollY = Number(view.scrollY) || 0;
            reportRect = settled;
            scrollRestored = Math.abs(Number(view.scrollY) - restore.y) < 0.5
              && Math.abs(Number(view.scrollX) - restore.x) < 0.5
              && Math.abs(settled.x - first.x) < 0.5
              && Math.abs(settled.y - first.y) < 0.5;
          } catch (error) { scrollRestored = false; }
        }
        const own = String(el.getAttribute('id') || '');
        const classes = String(el.className || '');
        const variant = String(el.getAttribute('data-variant') || '');
        const textAll = (own + ' ' + classes + ' ' + variant).toLowerCase();
        // ── multi-step: a step marker AND a chain ──────────────────────────
        // A bare data-done is not enough. A live T7 run against a CAPTCHA-less
        // SPA produced five 'multi-step' candidates out of 'span.line' headline
        // fragments, so a chain now needs either several sibling steps or a
        // real challenge signature inside the chain. Unsure ⇒ not a chain.
        const STEP_SELECTOR = '[data-done],[data-step],[data-stage],[aria-current]';
        const CHALLENGE_SELECTOR = '[data-target],[data-label],[data-answer],[aria-checked],[aria-valuenow],[role="checkbox"],[role="slider"],input[type="range"],[class*="cover" i],[class*="overlay" i]';
        const stepSelf = !!el.closest(STEP_SELECTOR)
          || el.hasAttribute('disabled')
          || el.hasAttribute('aria-disabled')
          || /(^|\\s)(locked|is-locked|step--locked|is-disabled)(\\s|$)/i.test(classes);
        const stepHost = el.closest(STEP_SELECTOR) || el.parentElement || el;
        const stepScope = stepHost.parentElement || stepHost;
        const stepCount = stepScope.querySelectorAll ? stepScope.querySelectorAll(STEP_SELECTOR).length : 0;
        const chainHasChallenge = stepScope.querySelector ? stepScope.querySelector(CHALLENGE_SELECTOR) !== null : false;
        const chain = stepSelf && (stepCount >= 2 || chainHasChallenge);
        // ── dynamic target: measured from the LAYOUT, not from a class name ─
        // The live V7 element carries no data-* at all: it is position:absolute
        // with an inline left in PERCENT, a 'transition: left' rule, inside a
        // relative parent — i.e. its position is declared after load and moves
        // with the viewport. getComputedStyle().left is always px, so the
        // inline declaration has to be read directly. A *-target class is only
        // an ADDITIONAL signal, never the sole one.
        const inline = String(el.getAttribute('style') || '');
        const elementPosition = String(style.position || 'static');
        const transition = String(style.transition || style.transitionProperty || '');
        const transitionsPosition = /(^|[\\s,])(left|top|right|bottom|transform|translate)([\\s,]|$)/.test(transition);
        const percentOffset = /(^|;)\\s*(left|top|right|bottom)\\s*:\\s*[^;]*%/.test(inline);
        const positioned = elementPosition === 'absolute' || elementPosition === 'sticky' || elementPosition === 'fixed';
        const nameHint = /(?:^|[\\s_-])target(?:$|[\\s_-])/.test(textAll);
        const selfDynamic = (positioned && transitionsPosition) || percentOffset
          || (nameHint && (percentOffset || positioned));
        // A dynamic target is often a CHILD of the thing worth clicking (the
        // V7 card owns the moving marker), so the host has to inherit the
        // signal. Bounded to the first 200 descendants, and still gated on a
        // name/variant that says "target" — a positioned child alone is just
        // layout, which is how a marketing page produces false positives.
        let dynamicChild = false;
        if (!selfDynamic && nameHint) {
          try {
            const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
            const bound = Math.min(kids.length, 200);
            for (let index = 0; index < bound; index += 1) {
              const child = kids[index];
              if (!child) continue;
              const childStyle = styleOf(doc, child);
              const childPos = String(childStyle.position || 'static');
              if (childPos !== 'absolute' && childPos !== 'sticky' && childPos !== 'fixed') continue;
              const childInline = String(child.getAttribute('style') || '');
              const childTrans = String(childStyle.transition || childStyle.transitionProperty || '');
              const childPct = /(^|;)\\s*(left|top|right|bottom)\\s*:\\s*[^;]*%/.test(childInline);
              if (childPct || /(^|[\\s,])(left|top|right|bottom|transform|translate)([\\s,]|$)/.test(childTrans)) {
                dynamicChild = true;
                break;
              }
            }
          } catch (error) { dynamicChild = false; }
        }
        const dynamicTarget = selfDynamic || dynamicChild;
        const formEl = el.closest ? el.closest('form') : null;
        const signals = {
          offscreen: rect.left <= -OFFSCREEN_PX || rect.top <= -OFFSCREEN_PX || rect.width <= 0,
          opacity: Number(style.opacity),
          laidOut: rect.width > 0 && rect.height > 0 && style.display !== 'none',
          tabIndex: Number(el.getAttribute('tabindex') || 0),
          pointerEvents: String(style.pointerEvents || 'auto'),
          ariaHidden: String(el.getAttribute('aria-hidden') || '') === 'true',
          position: String(style.position || 'static'),
        };
        const ruleIds = trapRuleIds(signals);
        // plan11-fix-scan-cap: compact on the way in, so the budget below is
        // spent on evidence rather than on key names for empty values.
        out.records.push(compact({
          selector: pathOf(el),
          tag: String(el.localName || '').toLowerCase(),
          id: own,
          role: String(el.getAttribute('role') || ''),
          name: String(el.getAttribute('aria-label') || shortText(el)),
          rect: { x: reportRect.x, y: reportRect.y, width: reportRect.width, height: reportRect.height },
          visible: visible,
          inViewport: inViewport || !visible,
          hitIsTarget: hitIsTarget,
          hitTag: hitTag,
          pointerEvents: signals.pointerEvents,
          position: signals.position,
          opacity: signals.opacity,
          tabIndex: signals.tabIndex,
          ariaHidden: signals.ariaHidden,
          frame: label,
          ariaChecked: String(el.getAttribute('aria-checked') || ''),
          dataSolved: String(el.getAttribute('data-solved') || ''),
          dataConfirmed: String(el.getAttribute('data-confirmed') || ''),
          dataTarget: String(el.getAttribute('data-target') || ''),
          dataDone: String(el.getAttribute('data-done') || ''),
          dataAnswer: String(el.getAttribute('data-answer') || ''),
          dataLabel: String(el.getAttribute('data-label') || ''),
          dataVariant: variant,
          decoy: el.hasAttribute('data-fake-solved') || el.hasAttribute('data-decoy') || /decoy|fake|sahte/.test(textAll),
          dynamicTarget: dynamicTarget,
          inForm: !!formEl || el.localName === 'form',
          rangeInput: el.localName === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'range',
          checkboxInput: el.localName === 'input'
            && /^(checkbox|radio)$/i.test(String(el.getAttribute('type') || '')),
          coverLike: /cover|overlay|modal|backdrop|curtain|scrim/.test(classes.toLowerCase())
            || el.hasAttribute('data-cover') || el.hasAttribute('data-overlay') || el.hasAttribute('data-modal'),
          chainStep: chain,
          covers: 0,
          trapHits: ruleIds.length,
          trapRuleIds: ruleIds,
          offscreen: signals.offscreen,
          announcedAbsent: signals.ariaHidden && ruleIds.length > 0,
          driftPx: driftPx,
          /* plan11-fix-scan-rect: the scroll offset this box is valid at, and
           * whether the page was put back. Both are what makes a box
           * clickable-or-stale decidable instead of guesswork. */
          measuredAtScrollY: measuredAtScrollY,
          scrollRestored: scrollRestored,
        }));
      }
    };

    // Overlays: a class/attribute fast path plus a computed-style pass that
    // finds the unnamed ones (a sticky header is an overlay in effect).
    const seenOverlay = new Set();
    const addOverlay = (el, source) => {
      if (out.overlays.length >= 60) return;
      if (seenOverlay.has(el)) return;
      seenOverlay.add(el);
      const doc = el.ownerDocument || document;
      const style = styleOf(doc, el);
      const rect = el.getBoundingClientRect();
      out.overlays.push({
        selector: pathOf(el),
        tag: String(el.localName || '').toLowerCase(),
        id: String(el.id || ''),
        position: String(style.position || 'static'),
        zIndex: String(style.zIndex || 'auto'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        source: source,
        covers: 0,
      });
    };
    try {
      for (const el of Array.from(document.querySelectorAll(OVERLAY_SELECTOR.join(',')))) addOverlay(el, 'signature');
    } catch (error) {
      // A failing overlay pass must be REPORTED, not swallowed: a silently
      // empty inventory reads as "this page has no overlays".
      out.warnings.push('overlay signature pass failed: ' + (error && error.message ? error.message : String(error)));
    }
    const all = Array.from(document.querySelectorAll('body *')).slice(0, MAX_SCAN);
    if (document.querySelectorAll('body *').length > MAX_SCAN) out.truncated = true;
    for (const el of all) {
      const style = styleOf(document, el);
      const position = String(style.position || 'static');
      if (position !== 'fixed' && position !== 'sticky' && position !== 'absolute') continue;
      const z = Number(style.zIndex);
      if (!Number.isFinite(z) || z < 100) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      addOverlay(el, 'computed');
    }

    measure(document, 'top', 0);
    // Same-origin frames only: cross-origin frames are not readable from the page context.
    if (MAX_DEPTH > 0) {
      for (const frame of Array.from(document.querySelectorAll('iframe,frame'))) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (error) { doc = null; }
        if (!doc) continue;
        const label = 'frame:' + String(frame.getAttribute('title') || frame.id || 'anonymous');
        measure(doc, label, 1);
      }
    }

    // Attribute "covers" on overlays: an overlay blocks a candidate when its
    // centre sits inside the overlay's box and the candidate is not in it.
    for (const record of out.records) {
      if (record.hitIsTarget) continue;
      const cx = record.rect.x + record.rect.width / 2;
      const cy = record.rect.y + record.rect.height / 2;
      for (const overlay of out.overlays) {
        if (overlay.rect.width <= 0 || overlay.rect.height <= 0) continue;
        if (cx < overlay.rect.x || cx > overlay.rect.x + overlay.rect.width) continue;
        if (cy < overlay.rect.y || cy > overlay.rect.y + overlay.rect.height) continue;
        if (overlay.selector === record.selector) continue;
        overlay.covers += 1;
        record.covers += 1;
      }
    }

    /* plan11-fix-scan-cap: spend the budget on the candidates that carry
     * signal. A tight budget used to mean "give up" — the whole scan came back
     * as an unparseable 16 KiB cut — so instead the inventory is ordered by
     * what a caller would act on (a hit-tested target, a range/checkbox input,
     * a data-target track, a decoy, a trap, a step chain) and the tail that
     * does not fit is DROPPED, loudly: the truncated flag plus a warning that
     * names how many of how many were left out. Document order is kept inside
     * the kept set so the answer still reads top-to-bottom. */
    const priorityOf = (record) => {
      let score = 0;
      if (record.hitIsTarget) score += 8;
      if (record.rangeInput || record.checkboxInput) score += 6;
      if (record.dataTarget) score += 6;
      if (record.coverLike) score += 6;
      if (record.role === 'slider' || record.role === 'checkbox' || record.role === 'switch') score += 5;
      if (record.dynamicTarget) score += 5;
      if (record.decoy) score += 4;
      if (record.trapHits > 0) score += 3;
      if (record.chainStep) score += 3;
      if (record.offscreen) score += 2;
      if (record.tag === 'form' && !record.dataSolved && !record.dataTarget) score -= 2;
      return score;
    };
    const recordSizes = [];
    for (let index = 0; index < out.records.length; index += 1) recordSizes.push(sizeOf(out.records[index]) + 1);
    const bySignal = [];
    const byRest = [];
    for (let index = 0; index < out.records.length; index += 1) {
      (priorityOf(out.records[index]) > 0 ? bySignal : byRest).push(index);
    }
    for (const list of [bySignal, byRest]) {
      list.sort((a, b) => (priorityOf(out.records[b]) - priorityOf(out.records[a])) || (a - b));
    }
    /* Two tiers, because a page with 150 identical text inputs would otherwise
       spend the whole budget on the first 25 of them and never reach the one
       slider below. Everything that carries a signature is paid for first — a
       single oversized record is skipped rather than allowed to starve the rest
       — and the no-signature tail spends only what the signal tier left, so a
       page whose candidates ALL matter is still reported whole. */
    const SIGNAL_BUDGET = RECORD_BUDGET - Math.round(RECORD_BUDGET / 4);
    let signalSpent = 0;
    let recordSpent = 0;
    const kept = [];
    for (const index of bySignal) {
      if (signalSpent + recordSizes[index] > SIGNAL_BUDGET) continue;
      signalSpent += recordSizes[index];
      recordSpent += recordSizes[index];
      kept.push(index);
    }
    for (const index of byRest) {
      if (recordSpent + recordSizes[index] > RECORD_BUDGET) break;
      recordSpent += recordSizes[index];
      kept.push(index);
    }
    if (kept.length < out.records.length) {
      const dropped = out.records.length - kept.length;
      out.truncated = true;
      out.warnings.push('the candidate inventory was cut: ' + String(dropped) + ' of '
        + String(out.records.length) + ' candidates were left out to stay inside the 16 KiB scan budget (lowest-signal first)');
      kept.sort((a, b) => a - b);
      out.records = kept.map((index) => out.records[index]);
    }
    let overlaySpent = 0;
    for (let index = out.overlays.length - 1; index >= 0; index -= 1) {
      const cost = sizeOf(out.overlays[index]) + 1;
      if (overlaySpent + cost <= OVERLAY_BUDGET) { overlaySpent += cost; continue; }
      out.overlays.splice(index, 1);
      out.truncated = true;
      out.warnings.push('the overlay inventory was cut: ' + String(out.overlays.length) + ' of '
        + String(index + 1) + ' overlays were left out to stay inside the 16 KiB scan budget');
      break;
    }
    /* The backstop for everything the two budgets above do not own — a 20 KB
     * data: URL, a pathological selector path, a page full of fat frame srcs.
     * Dropping from the tail keeps the reply parseable; when even that is not
     * enough, the envelope ANSWERS with the recovery instruction instead of
     * shipping a half-written object no host can parse.
     *
     * The frames are deliberately NOT dropped: the frame list is what the
     * third-party verdict is made of, so a page whose iframes alone
     * blow the budget gets an honest refusal rather than a clean-looking
     * "first-party" answer built on an inventory nobody read. */
    if (sizeOf(out) > HARD_BUDGET) {
      /* The URL goes first: it is the one field that can be enormous on its own
       * (a 20 KB data: URI) and the least informative to keep whole. Paying for
       * it with candidates would trade the answer for its own receipt. */
      if (out.url.length > 512) {
        out.url = out.url.slice(0, 512);
        out.truncated = true;
        out.warnings.push('the page URL itself was longer than the 16 KiB budget and was cut to 512 chars');
      }
      while (out.records.length > 0 && sizeOf(out) > HARD_BUDGET) out.records.pop();
      while (out.overlays.length > 0 && sizeOf(out) > HARD_BUDGET) out.overlays.pop();
      if (out.records.length === 0 && out.overlays.length === 0) {
        out.truncated = true;
        out.warnings.push('the inventories were dropped to stay inside the 16 KiB scan budget');
      }
      if (sizeOf(out) > HARD_BUDGET) {
        out.ok = false;
        out.records = [];
        out.overlays = [];
        out.frames = [];
        out.url = '';
        out.truncated = true;
        out.reason = BUDGET_REASON;
      }
    }
  } catch (error) {
    // plan11-fix-verify: the page's own text, never a generic refusal.
    out.ok = false;
    out.reason = fail(error);
  }
  return out;
})());
  } catch (error) {
    // plan11-fix-verify: the outer net — a throw that escapes the body still
    // reaches the envelope with its message.
    return refusal(error);
  }
})()`

/**
 * The page-side `verify` probe. Reads every solution signal the three reports
 * measured by hand, plus the fixture counters when the page publishes them.
 * Returns a JSON string; a missing counter is `null`, never `0`.
 */
export const CAPTCHA_VERIFY_EXPRESSION: string = `(() => {
  /* plan11-fix-verify: nothing in this script may throw into the protocol.
     Every page-side failure is turned into the SAME {ok:false, reason}
     envelope and it carries the page's OWN error text. A bare "the page-side
     verify failed" is exactly what hid 'view is not defined' behind three
     live runs, and an error object whose .message getter itself throws must
     not be able to break the envelope either — the fallback is the last
     honest thing this script can say. */
  const fail = (error) => {
    let message = '';
    try {
      message = (error && error.message) ? String(error.message) : String(error);
    } catch (nested) {
      try { message = 'unreadable error (' + Object.prototype.toString.call(error) + ')'; }
      catch (deeper) { message = 'unreadable error'; }
    }
    return 'cdp_captcha: the page-side verify failed (' + message + ')';
  };
  const refusal = (error) => JSON.stringify({
    ok: false, url: '', ariaChecked: [], dataSolved: [], dataConfirmed: [],
    sliders: [], badges: [], counters: null, reason: fail(error),
  });
  try {
  return JSON.stringify((() => {
  const out = {
    ok: true, url: '', ariaChecked: [], dataSolved: [], dataConfirmed: [],
    sliders: [], badges: [], counters: null,
  };
  try {
    out.url = String(location.href);
    /* plan11-fix-verify: the fill-width pass below reads a COMPUTED style
       through 'view', and this IIFE is the only scope that has one. Without
       this binding that single line throws 'view is not defined', the whole
       verify report collapses, and the collapse is CODE-PATH DEPENDENT: a
       [data-target] track only reaches it when it holds a narrow non-thumb
       child, so the bug looked like an intermittent page refusal. Same
       'document.defaultView || window' fallback the drag pass uses. */
    const view = document.defaultView || window;
    const rows = (selector, attribute) => {
      const list = [];
      for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 40)) {
        const value = el.getAttribute(attribute);
        if (value === null) continue;
        const id = el.id ? '#' + el.id : String(el.localName || '');
        list.push(id + '=' + String(value));
      }
      return list;
    };
    out.ariaChecked = rows('[aria-checked]', 'aria-checked');
    out.dataSolved = rows('[data-solved]', 'data-solved');
    out.dataConfirmed = rows('[data-confirmed]', 'data-confirmed');
    for (const el of Array.from(document.querySelectorAll('[data-target]')).slice(0, 40)) {
      const id = el.id ? '#' + el.id : String(el.localName || '');
      // The slider's own channels, in the order they are trustworthy. A live
      // T7 run is what this replaces: a slider with none of the first three
      // channels was read as 0 by a thumb-rect heuristic, while the page's real
      // value (67.9) sat in a FILL WIDTH. An unreadable slider is now reported
      // as unreadable — never as zero.
      const thumb = el.querySelector('[class*="thumb"],[class*="handle"],[role="slider"],.thumb') || null;
      let source = 'unavailable';
      let value = null;
      const ariaNow = el.getAttribute('aria-valuenow');
      if (ariaNow !== null && String(ariaNow).trim() !== '' && Number.isFinite(Number(ariaNow))) {
        source = 'aria-valuenow';
        value = Number(ariaNow);
      } else if (el.localName === 'input' && String(el.value || '') !== '' && Number.isFinite(Number(el.value))) {
        const max = Number(el.getAttribute('max') || '100');
        source = 'input-value';
        value = max > 0 ? (Number(el.value) / max) * 100 : Number(el.value);
      } else {
        const dataValue = el.getAttribute('data-value');
        if (dataValue !== null && String(dataValue).trim() !== '' && Number.isFinite(Number(dataValue))) {
          source = 'data-value';
          value = Number(dataValue);
        }
      }
      const trackRect = el.getBoundingClientRect();
      if (value === null && trackRect.width > 0) {
        // Channel 4: the FILL ratio — the widest non-thumb child smaller than
        // the track and sized in percent. This is the channel a hand-built
        // slider actually publishes.
        let bestWidth = 0;
        const kids = el.querySelectorAll ? Array.from(el.querySelectorAll('*')).slice(0, 40) : [];
        for (const child of kids) {
          if (child === thumb) continue;
          const childRect = child.getBoundingClientRect();
          if (childRect.width <= 0 || childRect.width >= trackRect.width) continue;
          const childStyle = view.getComputedStyle(child);
          const named = /fill|progress|bar/i.test(String(child.className || '') + ' #' + String(child.id || ''));
          const percent = String(childStyle.width || '').indexOf('%') !== -1;
          if (!named && !percent) continue;
          if (childRect.width > bestWidth) bestWidth = childRect.width;
        }
        if (bestWidth > 0) {
          source = 'fill-width';
          value = (bestWidth / trackRect.width) * 100;
        }
      }
      if (value === null && thumb) {
        /* plan11-fix-derived: the percent is the thumb's position INSIDE the
           track. This used to clamp the thumb's own offset into an inset and
           then subtract that same offset, so d <= travel/2 gave (d - d) = 0 and
           d > travel/2 left usable at 0 and the channel was skipped: the
           reconstruction was structurally incapable of reading a moved thumb,
           which is the exact "a solved slider reads 0" failure the file
           elsewhere refuses to accept. The inset is the TRACK's own padding
           now, never the thumb's position, so a thumb at rest still reads 0
           and a travelled thumb reads where it actually is. A track that
           admits no travel stays unavailable, not zero. */
        const thumbRect = thumb.getBoundingClientRect();
        const travel = trackRect.width - thumbRect.width;
        if (travel > 0) {
          const trackStyle = view.getComputedStyle ? view.getComputedStyle(el) : null;
          const padLeft = trackStyle ? Number.parseFloat(String(trackStyle.paddingLeft || '')) : 0;
          const padRight = trackStyle ? Number.parseFloat(String(trackStyle.paddingRight || '')) : 0;
          const inset = ((Number.isFinite(padLeft) ? padLeft : 0) + (Number.isFinite(padRight) ? padRight : 0)) / 2;
          const usable = travel - 2 * inset;
          if (usable > 0) {
            source = 'derived';
            value = Math.min(Math.max(((thumbRect.left - trackRect.left - inset) / usable) * 100, 0), 100);
          }
        }
      }
      const target = el.getAttribute('data-target');
      out.sliders.push(
        id + '=' + source + ':' + (value === null ? 'null' : String(Math.round(value * 100) / 100))
        + '(' + (target === null ? 'null' : String(target)) + ')',
      );
    }
    for (const el of Array.from(document.querySelectorAll('[class*="badge" i],[class*="status" i],[role="status"]')).slice(0, 20)) {
      const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.badges.push(text.slice(0, 120));
    }
    for (const key of ['__t6', '__t7', '__t8', '__t9', '__captcha']) {
      const counter = window[key];
      if (!counter || typeof counter !== 'object') continue;
      const copy = {};
      for (const name of Object.keys(counter)) {
        const value = counter[name];
        const type = typeof value;
        if (type === 'boolean' || type === 'number' || type === 'string') copy[name] = value;
        else if (value && type === 'object') {
          const inner = {};
          for (const innerName of Object.keys(value)) {
            const innerValue = value[innerName];
            if (typeof innerValue === 'number' || typeof innerValue === 'string' || typeof innerValue === 'boolean') {
              inner[innerName] = innerValue;
            }
          }
          copy[name] = inner;
        }
      }
      out.counters = copy;
      break;
    }
  } catch (error) {
    // plan11-fix-verify: the page's own text, never a generic refusal.
    out.ok = false;
    out.reason = fail(error);
  }
  return out;
})());
  } catch (error) {
    // plan11-fix-verify: the outer net. A throw that escapes the body above
    // (a broken JSON global, a future edit above the try) still lands in the
    // envelope with its message instead of reaching the protocol as a
    // contentless "produced no value".
    return refusal(error);
  }
})()`

/** Optional hints the drag measurement uses to pick the right slider. */
export interface DragMeasureHints {
  /** Explicit track selector (wins over every heuristic). */
  readonly trackSelector?: string
  /** Explicit thumb selector. */
  readonly thumbSelector?: string
  /** The box the locator resolved; the nearest slider to it is chosen. */
  readonly near?: CaptchaRect
}

/**
 * The page-side `drag` measurement. Reads the track, the thumb, and the
 * viewport FRESH, and computes the thumb's percent with the same convention
 * {@link thumbPercent} uses, so the read-back compares like with like. Called
 * once before the press, once before the release (K2 — T6's window resize moved
 * 74 → 72 for exactly this reason), and once after it.
 *
 * Track selection: an explicit `trackSelector` wins; otherwise the smallest
 * slider candidate NEAR the box the locator resolved (so a page with two
 * sliders still addresses the right one); otherwise the first `[data-target]`
 * or `input[type=range]`.
 * @param hints - optional selectors and a near box.
 * @returns the page-side expression.
 */
export function buildDragMeasureExpression(hints: DragMeasureHints = {}): string {
  return `JSON.stringify((() => {
    const out = {
      ok: false, track: null, thumb: null, currentPct: 0,
      declaredTarget: null, viewport: { width: 0, height: 0 }, reason: '',
      state: { ariaChecked: '', dataDone: '', dataSolved: '', dataConfirmed: '', value: '', thumbLeft: '', thumbData: [] },
    };
    try {
      const doc = document;
      const view = doc.defaultView || window;
      out.viewport = { width: Number(view.innerWidth || 0), height: Number(view.innerHeight || 0) };
      const trackSel = ${JSON.stringify(hints.trackSelector ?? null)};
      const thumbSel = ${JSON.stringify(hints.thumbSelector ?? null)};
      const near = ${JSON.stringify(hints.near ?? null)};
      const pick = (selector) => {
        if (!selector) return null;
        try { return doc.querySelector(selector); } catch (error) { return null; }
      };
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const distanceTo = (a, b) => {
        const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
        const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
        return Math.hypot(dx, dy);
      };
      let track = pick(trackSel);
      let thumb = pick(thumbSel);
      if (!track) {
        const candidates = Array.from(doc.querySelectorAll('[data-target],input[type="range"],[role="slider"],[aria-valuenow]'));
        if (candidates.length > 0) {
          if (near) {
            const cx = near.x + near.width / 2;
            const cy = near.y + near.height / 2;
            const probe = { x: cx - 1, y: cy - 1, width: 2, height: 2 };
            let best = null;
            let bestScore = Infinity;
            for (const el of candidates) {
              const box = boxOf(el);
              const contains = cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
              const score = contains ? -box.width : distanceTo(probe, box);
              if (score < bestScore) { bestScore = score; best = el; }
            }
            track = best;
          } else {
            track = candidates[0];
          }
        }
      }
      if (!track) { out.reason = 'cdp_captcha: no slider track found (pass css, or use a page with [data-target] / input[type=range])'; return out; }
      if (!thumb) {
        thumb = track.querySelector('[class*="thumb"],[role="slider"],.thumb,[class*="handle"]') || track;
      }
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      if (trackRect.width <= 0 || thumbRect.width <= 0) {
        out.reason = 'cdp_captcha: the slider has no measurable geometry (track ' + String(trackRect.width) + 'px, thumb ' + String(thumbRect.width) + 'px)';
        return out;
      }
      const travel = trackRect.width - thumbRect.width;
      const declared = track.getAttribute('data-target');
      const rangeValue = track.localName === 'input' ? String(track.value || '') : '';
      let currentPct = 0;
      if (rangeValue !== '' && Number.isFinite(Number(rangeValue))) {
        const max = Number(track.getAttribute('max') || '100');
        currentPct = max > 0 ? (Number(rangeValue) / max) * 100 : 0;
      } else if (travel > 0) {
        const inset = Math.max(thumbRect.left - trackRect.left, 0);
        const usable = travel - 2 * inset;
        currentPct = usable > 0 ? ((thumbRect.left - trackRect.left - inset) / usable) * 100 : 0;
      }
      out.ok = true;
      out.reason = declared === null ? '' : 'track declares data-target=' + String(declared);
      out.declaredTarget = declared;
      out.track = { x: trackRect.x, y: trackRect.y, width: trackRect.width, height: trackRect.height };
      out.thumb = { x: thumbRect.x, y: thumbRect.y, width: thumbRect.width, height: thumbRect.height };
      out.currentPct = currentPct;
      // The page's OWN state, read verbatim. This is what decides delivery:
      // a percent this tool derived can say "moved" while the page never
      // advanced (a live T7 run: the thumb followed, the step's data-done
      // stayed 0, the badge still read "çözülmedi").
      const around = track.closest ? (track.closest('[data-done],[data-stage],[data-step],form,section,div') || track) : track;
      const host = around.parentElement ? (around.parentElement.closest('[data-done],[data-stage],[data-step],form,section') || around.parentElement) : around;
      const box = track.closest ? (track.closest('[aria-checked],input[type=checkbox],[data-solved],[data-confirmed]') || host) : host;
      const read = (node, name) => (node && typeof node.getAttribute === 'function' ? String(node.getAttribute(name) || '') : '');
      const thumbData = [];
      if (thumb && thumb.attributes) {
        for (const attr of Array.from(thumb.attributes).slice(0, 16)) {
          if (String(attr.name || '').indexOf('data-') !== 0) continue;
          thumbData.push(String(attr.name) + '=' + String(attr.value));
        }
      }
      out.state = {
        ariaChecked: read(box, 'aria-checked'),
        dataDone: read(around, 'data-done') || read(host, 'data-done'),
        dataSolved: read(host, 'data-solved'),
        dataConfirmed: read(host, 'data-confirmed'),
        value: track.localName === 'input' ? String(track.value || '') : '',
        thumbLeft: thumb && thumb.style ? String(thumb.style.left || '') : '',
        thumbData: thumbData,
      };
    } catch (error) {
      out.ok = false;
      out.reason = 'cdp_captcha: the slider measurement failed ('
        + (error && error.message ? error.message : String(error)) + ')';
    }
    return out;
  })())`
}

/**
 * Read `data-target` (or the slider's `aria-valuenow`/value) for one element.
 * @param raw - the page-side reply string.
 * @returns the declared target percent, or undefined when none is declared.
 */
export function declaredTargetPct(raw: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>).declaredTarget
  const num = typeof value === 'string' ? Number.parseFloat(value) : (typeof value === 'number' ? value : NaN)
  return Number.isFinite(num) ? num : undefined
}
