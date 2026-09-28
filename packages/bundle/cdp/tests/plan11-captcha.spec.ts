/**
 * plan11: the `cdp_captcha` PURE engine — classification, trap triage, the
 * third-party gate, slider geometry, and solution signals. No browser, no
 * service, no protocol: every assertion here is a function over plain data,
 * which is what makes the three test reports' findings (T6's 5/5 detection,
 * the T7 visible-honeypot axis, T3's "the gesture never reached the page")
 * assertable at all.
 *
 * The third-party verdict is exercised as REPORTING: nothing in this file
 * reads a provider frame — the suite pins that `scan` reports and continues.
 */

import { describe, expect, it } from 'vitest'
import {
  APPROACH_MAX_PX,
  APPROACH_MIN_PX,
  CAPTCHA_PROVIDER_HOSTS,
  HONEYPOT_MIN_RULES,
  HONEYPOT_RULES,
  SLIDER_TOLERANCE_PCT,
  buildDragPlan,
  classifyCandidates,
  classifyHoneypot,
  classifyHoneypots,
  classifyOverlays,
  classifyRecord,
  clampDragSteps,
  clampTargetPct,
  collectSolutionSignals,
  declaredTargetPct,
  dragSeedNumber,
  hitVerdictOf,
  honeypotRule,
  judgeDrag,
  matchHoneypotRules,
  normalizeScanRecord,
  parseDragMeasureReply,
  parseScanReply,
  parseVerifyReply,
  releaseXFor,
  renderCaptcha,
  seededSource,
  sliderInset,
  stateDifferences,
  thumbPercent,
  thirdPartyVerdict,
  type CaptchaScanRecord,
  type HoneypotSignals,
  type SliderGeometry,
  type SliderStateSignature,
} from '../src/captcha.ts'

// ---------------------------------------------------------------------------
// Fixtures — the T6/T7 shapes as plain records
// ---------------------------------------------------------------------------

/** A record with the T6 defaults; each test overrides only what it proves. */
function record(overrides: Partial<CaptchaScanRecord> = {}): CaptchaScanRecord {
  return normalizeScanRecord({
    selector: 'div#v1-box',
    tag: 'div',
    id: 'v1-box',
    role: 'checkbox',
    name: 'Onay kutusu',
    rect: { x: 82, y: 228, width: 657, height: 56 },
    visible: true,
    inViewport: true,
    hitIsTarget: true,
    hitTag: 'div#v1-box',
    pointerEvents: 'auto',
    position: 'relative',
    opacity: 1,
    tabIndex: 0,
    ariaHidden: false,
    frame: 'top',
    ...overrides,
  })
}

/** T6's V2/V6 slider: a 664px track with a 34px thumb and a 3px inset. */
const TRACK_GEOMETRY: SliderGeometry = {
  track: { x: 66, y: 300, width: 664, height: 40 },
  thumb: { x: 69, y: 303, width: 34, height: 34 },
  currentPct: 0,
  viewport: { width: 754, height: 480 },
}

// ---------------------------------------------------------------------------
// Layer 1 — classification
// ---------------------------------------------------------------------------

describe('plan11: candidate classification', () => {
  it('names every T6 verification shape from its signature', () => {
    expect(classifyRecord(record()).kind).toBe('checkbox')
    expect(classifyRecord(record({ dataTarget: '72' })).kind).toBe('slider')
    expect(classifyRecord(record({ rangeInput: true })).kind).toBe('slider')
    expect(classifyRecord(record({ dataLabel: 'isik', role: '', tag: 'button' })).kind).toBe('image-select')
    expect(classifyRecord(record({ dataAnswer: '1', role: '', tag: 'td' })).kind).toBe('image-select')
    expect(classifyRecord(record({ inForm: true, tag: 'input', role: '' })).kind).toBe('form-field')
    expect(classifyRecord(record({ coverLike: true, covers: 1, role: '', tag: 'div' })).kind).toBe('delayed-confirm')
    expect(classifyRecord(record({ chainStep: true, dataDone: '0', role: '', tag: 'div' })).kind).toBe('multi-step')
    expect(classifyRecord(record({ frame: 'frame:iç doğrulama' })).kind).toBe('iframe-internal')
    expect(classifyRecord(record({ decoy: true })).kind).toBe('decoy')
    expect(classifyRecord(record({ dynamicTarget: true, role: '', tag: 'div' })).kind).toBe('dynamic-target')
  })

  it('reports an unmatched element as unknown rather than dropping it', () => {
    const result = classifyRecord(record({ role: '', tag: 'div', selector: 'div#plain' }))
    expect(result.kind).toBe('unknown')
    expect(result.evidence.join(' ')).toContain('no signature matched')
  })

  it('puts slider ahead of multi-step so a track inside a chain stays a slider', () => {
    // T7 V6: the track lives inside <div class="step" data-done="0">.
    const track = record({
      selector: 'div#v6-track', tag: 'div', id: 'v6-track', role: '',
      dataTarget: '68', chainStep: true,
    })
    const { kind, evidence } = classifyRecord(track)
    expect(kind).toBe('slider')
    // The chain is still visible through the evidence list — nothing is lost.
    expect(evidence.join(' ')).toContain('data-target=68 slider')
  })

  it('never lets the fake-success decoy be classified as a real challenge', () => {
    const decoy = record({ id: 'v10-decoy', decoy: true, role: '', tag: 'div' })
    expect(classifyRecord(decoy).kind).toBe('decoy')
    expect(classifyRecord(decoy).evidence[0]).toContain('fake-success trap')
  })

  it('attaches the deep-DOM evidence each record carries', () => {
    const candidates = classifyCandidates([
      record(),
      record({ id: 'covered', hitIsTarget: false, hitTag: 'div#v5-cover' }),
    ])
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.hitTest).toBe('pass')
    expect(candidates[0]?.blockedBy).toBe('')
    expect(candidates[1]?.hitTest).toBe('covered')
    expect(candidates[1]?.blockedBy).toBe('div#v5-cover')
    expect(candidates[1]?.hitIsTarget).toBe(false)
  })

  it('names the occluder classes the reports measured: sticky header, cover, pointer-events', () => {
    expect(hitVerdictOf(record({ visible: false }))).toBe('not-visible')
    expect(hitVerdictOf(record({ inViewport: false }))).toBe('not-in-viewport')
    expect(hitVerdictOf(record({ pointerEvents: 'none' }))).toBe('pointer-events-blocked')
    expect(hitVerdictOf(record({ hitIsTarget: false, hitTag: 'header' }))).toBe('covered')
  })

  it('reports drift, the K2 evidence that a target moved across the re-measure', () => {
    const [candidate] = classifyCandidates([record({ driftPx: 74 })])
    expect(candidate?.driftPx).toBe(74)
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — trap triage (the T7 visible-honeypot axis)
// ---------------------------------------------------------------------------

describe('plan11: honeypot rules', () => {
  const laidOut = (overrides: Partial<HoneypotSignals> = {}): HoneypotSignals => ({
    offscreen: false,
    opacity: 1,
    laidOut: true,
    tabIndex: 0,
    pointerEvents: 'auto',
    ariaHidden: false,
    position: 'relative',
    ...overrides,
  })

  it('exposes one labelled rule per trap signal', () => {
    for (const rule of HONEYPOT_RULES) {
      expect(rule.label.length).toBeGreaterThan(0)
      expect(honeypotRule(rule.id)).toBe(rule)
    }
    expect(honeypotRule('nope')).toBeUndefined()
  })

  it('classifies the T6 parking spot as a hidden trap (3 rules fire)', () => {
    // left:-9978, tabindex=-1, pointer-events:none — T6's §2 finding.
    const trap = classifyHoneypot(laidOut({
      offscreen: true, tabIndex: -1, pointerEvents: 'none', position: 'absolute', ariaHidden: true,
    }))
    expect(trap?.kind).toBe('hidden-trap')
    expect(trap?.rules).toEqual(expect.arrayContaining(['offscreen', 'tabindex-removed', 'pointer-events-none']))
  })

  it('classifies the T7 VISIBLE honeypot as visible-honeypot, not hidden', () => {
    // opacity:.01 + position:static + tabindex=0 + pointer-events:auto.
    const signals = laidOut({ opacity: 0.01, position: 'static', tabIndex: 0, pointerEvents: 'auto' })
    const trap = classifyHoneypot(signals)
    expect(trap?.kind).toBe('visible-honeypot')
    expect(trap?.rules).toContain('opacity-near-zero')
    expect(trap?.rules).toContain('static-position')
    // This is the axis a naive "is it invisible?" scan misses on purpose.
    expect(matchHoneypotRules(signals)).not.toContain('offscreen')
  })

  it('needs HONEYPOT_MIN_RULES rules before calling anything a trap', () => {
    expect(classifyHoneypot(laidOut({ opacity: 0.01 }))).toBeNull()
    expect(HONEYPOT_MIN_RULES).toBe(2)
  })

  it('only inventories fillable fields — an opacity:.01 badge is not a trap', () => {
    const traps = classifyHoneypots([
      record({ selector: 'input#v11-url', tag: 'input', id: 'v11-url', role: '', opacity: 0.01, position: 'static', trapHits: 2 }),
      record({ selector: 'span.badge', tag: 'span', id: 'v6-badge', role: '', opacity: 0.01, position: 'static', trapHits: 2 }),
    ])
    expect(traps).toHaveLength(1)
    expect(traps[0]?.kind).toBe('visible-honeypot')
    expect(traps[0]?.focusable).toBe(true)
    expect(traps[0]?.reasons.length).toBe(traps[0]?.rules.length)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — overlays + the third-party verdict
// ---------------------------------------------------------------------------

describe('plan11: overlay inventory', () => {
  it('sorts the highest z-index first and flags the blocking ones', () => {
    const overlays = classifyOverlays([
      { selector: 'header', tag: 'header', id: '', position: 'sticky', zIndex: '200', rect: { x: 0, y: 0, width: 754, height: 52 }, source: 'computed', covers: 0 },
      { selector: 'div#v5-cover', tag: 'div', id: 'v5-cover', position: 'absolute', zIndex: 'auto', rect: { x: 60, y: 500, width: 640, height: 60 }, source: 'signature', covers: 1 },
      { selector: 'div.toast', tag: 'div', id: '', position: 'fixed', zIndex: '999', rect: { x: 0, y: 400, width: 200, height: 40 }, source: 'computed', covers: 0 },
    ])
    expect(overlays.map(overlay => overlay.selector)).toEqual(['div.toast', 'header', 'div#v5-cover'])
    expect(overlays.find(overlay => overlay.selector === 'div#v5-cover')?.blocking).toBe(true)
    // The T6 sticky header is found by the COMPUTED pass, not by a class name.
    const header = overlays.find(overlay => overlay.selector === 'header')
    expect(header?.source).toBe('computed')
    expect(header?.position).toBe('sticky')
    expect(header?.rect.height).toBe(52)
  })
})

describe('plan11: the third-party verdict', () => {
  it('keeps a first-party page first-party', () => {
    const verdict = thirdPartyVerdict([], 'example.test')
    expect(verdict.verdict).toBe('first-party')
    expect(verdict.reason).toBeUndefined()
    expect(verdict.providers).toEqual([])
  })

  it('treats a same-origin / about:blank / data frame as first-party', () => {
    const verdict = thirdPartyVerdict([
      { src: 'https://example.test/v8', id: 'v8-frame', title: 'iç doğrulama', accessible: true },
      { src: 'about:blank', id: '', title: '', accessible: true },
      { src: 'data:text/html,<p>hi', id: '', title: '', accessible: true },
    ], 'example.test')
    expect(verdict.verdict).toBe('first-party')
    expect(verdict.iframes.map(frame => frame.origin)).toEqual(['first-party', 'about', 'data'])
  })

  it('reports a third-party provider frame (verdict only)', () => {
    const verdict = thirdPartyVerdict([
      { src: 'https://www.google.com/recaptcha/api2/anchor', id: 'rc', title: 'reCAPTCHA', accessible: false },
    ], 'example.test')
    expect(verdict.verdict).toBe('third-party-present')
    expect(verdict.providers).toContain('recaptcha')
    expect(verdict.reason).toContain('reported alongside the candidates')
    expect(verdict.reason).toContain('cross-origin')
  })

  it('recognises every provider host the gate names', () => {
    for (const host of ['recaptcha', 'hcaptcha', 'turnstile', 'challenges.cloudflare.com']) {
      expect(CAPTCHA_PROVIDER_HOSTS.some(needle => host.includes(needle))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 4 — slider geometry + the delivery gate
// ---------------------------------------------------------------------------

describe('plan11: drag geometry', () => {
  it('reads the thumb percent from a fresh measurement (T6 V2 starts at 0)', () => {
    expect(thumbPercent(TRACK_GEOMETRY)).toBeCloseTo(0, 5)
    // The 3px inset is read exactly while the thumb is at rest.
    expect(sliderInset(TRACK_GEOMETRY)).toBe(3)
  })

  it('round-trips: releasing at releaseXFor(pct) reads back as pct', () => {
    // This is the invariant the whole drag rests on — the release point and the
    // read-back must use ONE mapping, or `delivered` measures nothing. The
    // carried inset is part of that mapping (see the test below).
    const inset = sliderInset(TRACK_GEOMETRY)
    for (const pct of [0, 25, 50, 72, 100]) {
      const x = releaseXFor(TRACK_GEOMETRY, pct)
      const after: SliderGeometry = {
        ...TRACK_GEOMETRY,
        inset,
        thumb: { ...TRACK_GEOMETRY.thumb, x: x - TRACK_GEOMETRY.thumb.width / 2 },
      }
      expect(thumbPercent(after)).toBeCloseTo(pct, 1)
    }
  })

  it('carries a measured inset into the read-back instead of re-deriving it', () => {
    // Without the carried inset a travelled thumb would claim to BE the inset,
    // and the read-back collapses to a meaningless number.
    const moved: SliderGeometry = {
      ...TRACK_GEOMETRY,
      thumb: { ...TRACK_GEOMETRY.thumb, x: 518 },
      inset: 3,
    }
    expect(thumbPercent(moved)).toBeCloseTo(72, 1)
    // EOPT: the key must be ABSENT, not present-and-undefined.
    const { inset: _dropped, ...withoutInset } = moved
    void _dropped
    expect(thumbPercent(withoutInset as SliderGeometry)).not.toBeCloseTo(72, 1)
  })

  it('derives the release X from the geometry, never from a fixed coordinate', () => {
    // Move the whole track 100px right and the release point follows it.
    const shifted: SliderGeometry = {
      ...TRACK_GEOMETRY,
      track: { ...TRACK_GEOMETRY.track, x: 166 },
      thumb: { ...TRACK_GEOMETRY.thumb, x: 169 },
    }
    expect(releaseXFor(shifted, 72) - releaseXFor(TRACK_GEOMETRY, 72)).toBe(100)
    // T6's recorded geometry (664px track, 34px thumb) puts 72% mid-track.
    const x = releaseXFor(TRACK_GEOMETRY, 72)
    expect(x).toBeGreaterThan(TRACK_GEOMETRY.track.x)
    expect(x).toBeLessThan(TRACK_GEOMETRY.track.x + TRACK_GEOMETRY.track.width)
  })

  it('is deterministic: the same seed always yields the same path', () => {
    const a = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, seed: 'fixed' })
    const b = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, seed: 'fixed' })
    const c = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, seed: 'other' })
    expect(a.dragPath).toEqual(b.dragPath)
    expect(a.approachPath).toEqual(b.approachPath)
    expect(a.dragPath).not.toEqual(c.dragPath)
  })

  it('uses the same FNV-1a seed shape as stealth.ts, never Math.random', () => {
    expect(dragSeedNumber('x', 'y')).toBe(dragSeedNumber('x', 'y'))
    expect(dragSeedNumber('x', 'y')).not.toBe(dragSeedNumber('y', 'x'))
    const source = seededSource('x', 'y')
    const values = [source(), source(), source()]
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('walks the K4 approach path and stops 12–40px short of the press point', () => {
    const plan = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, seed: 'k4' })
    expect(plan.approachPath.length).toBeGreaterThan(2)
    const last = plan.approachPath[plan.approachPath.length - 1]!
    const gap = Math.hypot(plan.start.x - last.x, plan.start.y - last.y)
    expect(gap).toBeGreaterThanOrEqual(APPROACH_MIN_PX - 0.001)
    expect(gap).toBeLessThanOrEqual(APPROACH_MAX_PX + 0.001)
    // The approach ends BEFORE the press: the pointer never teleports.
    expect(gap).toBeGreaterThan(0)
  })

  it('overshoots then pulls back, and releases exactly on target', () => {
    const plan = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, seed: 'over' })
    expect(plan.overshoot).not.toBeNull()
    expect(plan.overshoot!.x).toBeGreaterThan(plan.target.x)
    const xs = plan.dragPath.map(point => point.x)
    expect(Math.max(...xs)).toBe(plan.overshoot!.x)
    expect(plan.dragPath[plan.dragPath.length - 1]).toEqual(plan.target)
  })

  it('can be told to skip the approach and the overshoot', () => {
    const plan = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, approach: false, overshoot: false })
    expect(plan.approachPath).toEqual([])
    expect(plan.overshoot).toBeNull()
    expect(plan.dragPath[plan.dragPath.length - 1]).toEqual(plan.target)
  })

  it('spaces its steps unevenly (a hand does not travel in equal quanta)', () => {
    const plan = buildDragPlan(TRACK_GEOMETRY, { targetPct: 72, steps: 20, seed: 'uneven' })
    const deltas = plan.dragPath.slice(1).map((point, index) =>
      Math.abs(point.x - plan.dragPath[index]!.x))
    expect(new Set(deltas).size).toBeGreaterThan(3)
    expect(plan.delaysMs).toHaveLength(plan.dragPath.length)
  })

  it('warns instead of pretending when the track cannot be dragged', () => {
    const plan = buildDragPlan(
      { ...TRACK_GEOMETRY, track: { ...TRACK_GEOMETRY.track, width: 0 } },
      { targetPct: 50 },
    )
    expect(plan.warnings.join(' ')).toContain('not draggable')
  })

  it('warns when the inset had to be estimated from a mid-travel thumb', () => {
    const moved = { ...TRACK_GEOMETRY, currentPct: 48 }
    const plan = buildDragPlan(moved, { targetPct: 72 })
    expect(plan.insetEstimated).toBe(true)
    expect(plan.warnings.join(' ')).toContain('inset estimated')
  })

  it('stays quiet about the inset once it was measured and carried', () => {
    const carried: SliderGeometry = { ...TRACK_GEOMETRY, currentPct: 48, inset: 3 }
    const plan = buildDragPlan(carried, { targetPct: 72 })
    expect(plan.insetEstimated).toBe(false)
    expect(plan.warnings).toEqual([])
  })

  it('clamps steps and the target percent instead of trusting the caller', () => {
    expect(clampDragSteps(undefined)).toBe(24)
    expect(clampDragSteps(1)).toBe(4)
    expect(clampDragSteps(10_000)).toBe(200)
    expect(clampDragSteps(Number.NaN)).toBe(24)
    expect(clampTargetPct(140)).toBe(100)
    expect(clampTargetPct(-5)).toBe(0)
    expect(clampTargetPct(Number.NaN)).toBeUndefined()
  })
})

describe('plan11: the delivery gate (K5 in-tool)', () => {
  it('delivered needs BOTH — the target reached AND something observed changed', () => {
    expect(judgeDrag(0, 72, 72)).toMatchObject({ delivered: true, matched: true, verifiedBy: 'value-moved' })
    expect(judgeDrag(0, 72, 72, ['dataDone: 0 → 1'])).toMatchObject({ delivered: true, matched: true, verifiedBy: 'both' })
    expect(judgeDrag(0, 0, 72)).toMatchObject({ delivered: false, matched: false, verifiedBy: 'none' })
    // plan11-fix-drag-deliver: a page state change ALONE is not delivery. The
    // live silent success was exactly this row — a collapsed (1px) gesture, a
    // read-back that never moved, and a `data-done: 0 → 1` the page had
    // already earned on its own. The old gate called that delivered:true.
    expect(judgeDrag(0, 0, 72, ['dataDone: 0 → 1'])).toMatchObject({ delivered: false, matched: false, verifiedBy: 'state-changed' })
    // …and a thumb that moved to the WRONG place is equally not delivered.
    expect(judgeDrag(0, 67.6, 20, ['dataDone: 0 → 1'])).toMatchObject({ delivered: false, matched: false, verifiedBy: 'both' })
  })

  it('reports matched independently of delivery (T6 tolerance ±1.5)', () => {
    // Moved but missed: matched is false, and delivery needs it — the two
    // answers are separate, and only the first one gates the second.
    expect(judgeDrag(0, 30, 72).matched).toBe(false)
    expect(judgeDrag(0, 30, 72).delivered).toBe(false)
    expect(judgeDrag(0, 72 + SLIDER_TOLERANCE_PCT, 72).matched).toBe(true)
    expect(judgeDrag(0, 72 + SLIDER_TOLERANCE_PCT + 1, 72).matched).toBe(false)
  })

  it('LIFECYCLE: a moved thumb with an unchanged page state is "value-moved" alone', () => {
    // This is exactly what T7 measured live: the thumb followed the pointer and
    // the read-back matched 68, yet the page's data-done never advanced because
    // the mouseup never reached it. Geometry alone would have called it a win.
    const verdict = judgeDrag(0, 67.9, 68)
    expect(verdict.matched).toBe(true)
    expect(verdict.verifiedBy).toBe('value-moved')
    expect(verdict.stateDiffs).toEqual([])
    // The moment the page publishes the change, the answer strengthens.
    expect(judgeDrag(0, 67.9, 68, ['dataDone: 0 → 1']).verifiedBy).toBe('both')
  })

  it('lists exactly the page state fields that changed', () => {
    const before: SliderStateSignature = {
      ariaChecked: 'false', dataDone: '0', dataSolved: '', dataConfirmed: '', value: '', thumbLeft: '3px', thumbData: [],
    }
    const after: SliderStateSignature = {
      ariaChecked: 'true', dataDone: '1', dataSolved: '1', dataConfirmed: '', value: '', thumbLeft: '375.279px', thumbData: ['data-locked=false'],
    }
    const diffs = stateDifferences(before, after)
    expect(diffs).toContain('dataDone: 0 → 1')
    expect(diffs).toContain('ariaChecked: false → true')
    expect(diffs).toContain('dataSolved: (absent) → 1')
    expect(diffs).toContain('thumbLeft: 3px → 375.279px')
    expect(diffs.some(diff => diff.includes('data-locked=false appeared'))).toBe(true)
    // An unchanged state produces NO diffs — and says nothing about the page.
    expect(stateDifferences(before, before)).toEqual([])
    // An absent signature is "no observation", not "no change".
    expect(stateDifferences(undefined, after)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Layer 5 — solution signals
// ---------------------------------------------------------------------------

describe('plan11: solution signals', () => {
  const empty = {
    ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], counters: null,
  }

  it('reads a solved page from aria-checked / data-solved / slider-vs-target', () => {
    expect(collectSolutionSignals({ ...empty, ariaChecked: ['#v1-box=true'] }).solved).toBe(true)
    expect(collectSolutionSignals({ ...empty, dataSolved: ['#v11-form=1'] }).solved).toBe(true)
    expect(collectSolutionSignals({ ...empty, dataConfirmed: ['#v3=1'] }).solved).toBe(true)
    expect(collectSolutionSignals({ ...empty, sliders: ['#v2-track=72(72)'] }).solved).toBe(true)
  })

  it('reads the T6/T7 counters when the page publishes them', () => {
    const read = collectSolutionSignals({
      ...empty,
      counters: {
        chain: true, dynamic: false, iframe: false, doubleCover: false, decoyAvoid: true, visibleHoneypot: false,
        wrongClicks: 0, decoyClicks: 1, honeypotHit: false,
        resolved: { chain: 1790360184445, dynamic: 1790360303878 },
      },
    })
    expect(read.solved).toBe(true)
    expect(read.wrongClicks).toBe(0)
    expect(read.decoyClicks).toBe(1)
    expect(read.honeypotHit).toBe(false)
    expect(read.solvedAt).toBe(1790360303878)
    expect(read.signals.flags).toContain('chain=true')
    expect(read.signals.flags).toContain('dynamic=false')
    expect(read.warnings).toEqual([])
  })

  it('OMITS a counter the page does not publish instead of inventing zero', () => {
    const read = collectSolutionSignals({ ...empty, counters: { chain: true } })
    expect(read.wrongClicks).toBeUndefined()
    expect(read.decoyClicks).toBeUndefined()
    expect(read.honeypotHit).toBeUndefined()
    expect(read.warnings.join(' ')).toContain('unavailable (not zero)')
  })

  it('says so plainly when the page has no counter object at all', () => {
    const read = collectSolutionSignals(empty)
    expect(read.solved).toBe(false)
    expect(read.warnings.join(' ')).toContain('no window.__t6/__t7-style counter object')
    expect(read.wrongClicks).toBeUndefined()
  })

  it('still reads aria-checked on a page with no counters', () => {
    const read = collectSolutionSignals({ ...empty, ariaChecked: ['#box=true'] })
    expect(read.solved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Layer 6 — reply parsing (a failed page answer is never a silent [])
// ---------------------------------------------------------------------------

describe('plan11: reply parsing', () => {
  it('turns a non-JSON scan reply into an in-band refusal', () => {
    const parsed = parseScanReply('<html>not json</html>')
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain('not JSON')
    expect(parsed.records).toEqual([])
  })

  it('turns a failed page-side scan into the page\'s own reason', () => {
    const parsed = parseScanReply(JSON.stringify({ ok: false, reason: 'boom' }))
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('boom')
  })

  it('warns when the page blew the record budget', () => {
    const parsed = parseScanReply(JSON.stringify({ ok: true, url: 'u', host: 'h', records: [], overlays: [], frames: [], warnings: [], truncated: true }))
    expect(parsed.ok).toBe(true)
    expect(parsed.warnings.join(' ')).toContain('scan budget')
  })

  it('refuses a verify reply that is not JSON and keeps the honest shape', () => {
    const parsed = parseVerifyReply('nope')
    expect(parsed.ok).toBe(false)
    expect(parsed.record.counters).toBeNull()
  })

  it('parses a slider measurement and reads the declared data-target', () => {
    const raw = JSON.stringify({
      ok: true,
      track: { x: 66, y: 300, width: 664, height: 40 },
      thumb: { x: 69, y: 303, width: 34, height: 34 },
      currentPct: 0,
      declaredTarget: '72',
      viewport: { width: 754, height: 480 },
    })
    const geometry = parseDragMeasureReply(raw)
    expect(geometry?.track.width).toBe(664)
    expect(geometry?.viewport.width).toBe(754)
    expect(declaredTargetPct(raw)).toBe(72)
  })

  it('returns null when the slider has no measurable geometry', () => {
    expect(parseDragMeasureReply(JSON.stringify({ ok: true, track: { width: 0 }, thumb: { width: 0 } }))).toBeNull()
    expect(parseDragMeasureReply('{')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Layer 7 — render (an ok:false never renders a success phrase)
// ---------------------------------------------------------------------------

describe('plan11: render discipline', () => {
  it('never renders a success phrase for a failed scan', () => {
    const text = renderCaptcha({ ok: false, action: 'scan', reason: 'no first-party verification candidate matched' })[0]!.text
    expect(text).toContain('Captcha scan failed:')
    expect(text).not.toContain('candidate(s)')
  })

  it('never renders "DELIVERED" for a drag the read-back did not confirm', () => {
    const text = renderCaptcha({
      ok: false, action: 'drag', delivered: false, beforeValue: 0, finalValue: 0, expectedValue: 72,
      matched: false, deltaMs: 10, attempts: 1, startX: 0, startY: 0, targetX: 0, targetY: 0,
      reason: 'not delivered',
    })[0]!.text
    expect(text).toContain('Captcha drag failed:')
    expect(text).not.toContain('DELIVERED')
  })

  it('names the NOT DELIVERED verdict in the drag summary', () => {
    const text = renderCaptcha({
      ok: true, action: 'drag', delivered: false, beforeValue: 0, finalValue: 0, expectedValue: 72,
      matched: false, deltaMs: 12, attempts: 1, startX: 86, startY: 320, targetX: 86, targetY: 320,
    })[0]!.text
    expect(text).toContain('NOT DELIVERED')
  })

  it('states the third-party report in words and names the verdict line', () => {
    const text = renderCaptcha({
      ok: false, action: 'scan', found: 2, reason: 'cdp_captcha: third-party verification frame(s) present (www.google.com): reported alongside the candidates; cross-origin frames are not readable from the page context.',
      candidates: [
        { kind: 'checkbox', selector: 'div#v1-box', hitTest: 'pass', hitIsTarget: true, blockedBy: '', frame: 'top', rect: { x: 1, y: 2, width: 3, height: 4 } },
        { kind: 'slider', selector: 'div#v2-track', hitTest: 'covered', hitIsTarget: false, blockedBy: 'div#v5-cover', frame: 'top', rect: { x: 5, y: 6, width: 7, height: 8 } },
      ],
      overlays: [{ selector: 'div#v5-cover', position: 'absolute', zIndex: 'auto', blocking: true }],
      thirdParty: { verdict: 'third-party-present', iframes: [{ src: 'https://www.google.com/recaptcha', id: 'rc', title: '', accessible: false, origin: 'third-party', host: 'www.google.com' }], providers: ['recaptcha'] },
      warnings: [],
    })[0]!.text
    // The failure itself names the verdict — the raw data is not the only source.
    expect(text).toContain('Captcha scan failed:')
    expect(text).toContain('third-party verdict: third-party-present — reported alongside the candidates.')
    // …and the detected first-party candidates are still listed, so the report
    // never hides what the page actually holds.
    expect(text).toContain('still detected: [checkbox] div#v1-box')
    expect(text).toContain('still detected: [slider] div#v2-track')
  })

  it('lists a detected candidate with its occluder on the ok:true scan line', () => {
    const text = renderCaptcha({
      ok: true, action: 'scan', found: 2,
      candidates: [
        { kind: 'checkbox', selector: 'div#v1-box', hitTest: 'pass', hitIsTarget: true, blockedBy: '', frame: 'top', rect: { x: 82, y: 228, width: 657, height: 56 } },
        { kind: 'slider', selector: 'div#v2-track', hitTest: 'covered', hitIsTarget: false, blockedBy: 'div#v5-cover', frame: 'top', rect: { x: 66, y: 300, width: 664, height: 40 } },
      ],
      overlays: [{ selector: 'div#v5-cover', position: 'absolute', zIndex: 'auto', blocking: true }],
      honeypots: [{ kind: 'visible-honeypot', selector: 'input#v11-url', reasons: ['opacity ≤ 0.05 (looks hidden, still fillable)'] }],
      thirdParty: { verdict: 'first-party', iframes: [], providers: [] },
      warnings: [],
    })[0]!.text
    expect(text).toContain('2 first-party candidate(s) · third-party verdict: first-party')
    expect(text).toContain('[checkbox] div#v1-box · hit=pass')
    expect(text).toContain('covered by div#v5-cover')
    expect(text).toContain('honeypot [visible-honeypot]: input#v11-url')
  })

  it('says the metric is unavailable rather than zero when the page has no counters', () => {
    const text = renderCaptcha({
      ok: true, action: 'verify', solved: false,
      signals: { ariaChecked: [], dataSolved: [], dataConfirmed: [], sliders: [], badges: ['V1 · çözülmedi'], flags: [] },
      warnings: ['the page exposes no wrongClicks counter'],
    })[0]!.text
    expect(text).toContain('Captcha verify: not solved')
    expect(text).toContain('badges: V1 · çözülmedi')
    expect(text).toContain('unavailable on this page (not zero)')
  })

  it('renders the happy verify verdict with its counters', () => {
    const text = renderCaptcha({
      ok: true, action: 'verify', solved: true,
      signals: { ariaChecked: ['#v1-box=true'], dataSolved: [], dataConfirmed: [], sliders: [], badges: [], flags: ['chain=true'] },
      wrongClicks: 0, decoyClicks: 0, honeypotHit: false, solvedAt: 1790360184445,
    })[0]!.text
    expect(text).toContain('Captcha verify: SOLVED')
    expect(text).toContain('wrongClicks=0 · decoyClicks=0 · honeypotHit=false')
  })
})
