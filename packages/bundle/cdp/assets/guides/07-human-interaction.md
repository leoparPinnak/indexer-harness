# Human Interaction and Verification Challenges

How to aim a click, move like a person, and fail honestly. This guide covers the
**interaction layer** the parent skill's §2 procedure does not: what to measure
before a click, which rules the tools already enforce for you, and what to do
when the page puts a verification challenge in the way.

> **Scope.** Reliable, human-like interaction with a page — including the
> **verification challenges on it, first-party or third-party**. Diagnose the
> challenge, complete it by the most effective available means, and verify the
> effect — see [Layer C](#layer-c-verification-challenge-roles) at the end.

---

## 1. The measuring discipline (why hardcoded coordinates fail)

CDP input (`Input.dispatchMouseEvent`) takes **viewport CSS pixels**. Three
different coordinate systems exist, and confusing them is the single most common
source of "the script clicked the wrong thing":

```
Viewport (CSS px)  = the visible box, origin at top-left   <-- CDP wants this
Page (CSS px)      = viewport + scroll offset              <-- getBoundingClientRect returns this
Screen (device px) = CSS px * devicePixelRatio            <-- some other APIs
```

`getBoundingClientRect()` already returns viewport coordinates, so its value can
be dispatched **directly** — but only while the element is actually visible. A
coordinate is not a constant, it is a fact about one instant. It goes stale when:

- **the page scrolled** — the same element now sits at a different viewport `y`;
- **viewport size / DPR / zoom changed** — 354px is a button's centre on one screen
  and empty space on another;
- **layout shifted** — a banner opened, a font loaded, a sticky header appeared,
  an accordion collapsed;
- **the element lives in an iframe** — its rect is frame-relative and must be
  composed with the frame's own rect;
- **the SPA re-rendered** — the old node is gone and any ref to it is stale.

**The rule:** measure at the moment of action. Never carry a coordinate across a
scroll, a re-render, or an await.

### Let the tool do the measuring

You do not have to compute this yourself. `cdp_find` already measures, resolves,
and hit-tests a candidate before you act, and it reports the geometry in the same
call:

```
cdp_find({ selector: '#v2-thumb' })
→ Found 1 match(es).
  #1 [generic] box(484.27, -605.78, 36x36)
     visible=true inViewport=false
     NOT actionable: outside the viewport; covered by header
```

That single line is the whole discipline: the thumb is **visible** but **outside
the viewport** (so it must be scrolled to) and **covered by the header** (so a
click dispatched at those coordinates would land on the header, not the thumb).
`cdp_click` repeats the same hit-test at action time and refuses when the target
is not actionable.

So the workflow is *find → act → verify*, not *compute coordinates → dispatch*.
When `cdp_find` reports `NOT actionable`, the reason tells you the fix: scroll
(`cdp_scroll({ mode: 'selector' })` or re-find after scrolling), dismiss the
overlay, or shrink the obstruction.

**Multiple candidates** are reported rather than guessed: `cdp_find` returns
`candidates` with per-candidate boxes and a `warnings` array. Disambiguate with
`nth`, or narrow the query with `scope` / `text` / `role`. A wrong-of-several
same-text click is a real failure mode, not a hypothetical.

---

## 1b. The visual loop: "DOM bulamadıysa script yazma, görsele bak"

`cdp_find` needs a **query**. When the page has none for you — a `<canvas>`
chart, an icon-only control, a shadow-DOM widget, a custom grid, something whose
label exists only as pixels — the instinct is to write a script and guess a
selector. Don't. **Look at the picture, then prove the point against the DOM:**

```
1) cdp_screenshot({ selector: '#orders' | clip: {…}, rects: true, annotate: true, inline: true })
      → you SEE the region AND the boxes mapped onto the image
2) you name a point — image pixels, converted with the reported deviceScaleFactor
3) cdp_locate({ x, y })   → what is there? tag/id/role/text/coveredBy/ancestry
4) cdp_click({ x, y })    → only now
```

**Görselde gördüğünü yazma; `cdp_locate` ile ne olduğunu doğrula, sonra tıkla.**
**Doğrulama geçmeden tıklama — bu, sessiz başarı sınıfının kapatılmasıdır.**

`cdp_click` reports `Click dispatched successfully.` whether or not it hit
anything; SKILL.md §2.6 verification is what catches that, usually one turn too late.
`cdp_locate` catches it *before* the click, for free:

```
cdp_locate({ x: 412, y: 288 })
→ Nokta (412,288) → <button#save.primary "Kaydet"> · role=button · tıklanabilir
    · box(392,270,90x36) · kapsam: div#toolbar > button#save.primary
```

A mis-aim is the cheap outcome, not the expensive one:

```
cdp_locate({ x: 412, y: 288 })
→ Boş nokta (412,288) — no element at (412,288).
  en yakın: button#save.primary (48.5px uzakta, box(392,270,90x36)).
  Yeniden nişan al ya da cdp_snapshot/cdp_find ile doğrula; tıklama.
```

Two axes turn a click into a silent no-op, and both are **the same field names
`cdp_find` uses** (one shared rule, so the tools cannot drift apart):

- **`coveredBy`** — a covering layer sits on top at that point. The click would
  land on the banner, not the button. `ok:true` with a warning, not a refusal:
  dismiss the overlay, then locate again.
- **`inViewport: false`** — the point is off-screen, so a click there reaches
  nothing. `cdp_scroll({ mode: 'selector' })` is the fix.

`cdp_locate` is a **probe, never a click**. Keeping look and act as two calls is
what makes a wrong aim structurally recoverable: the cost of being wrong is one
cheap read-back, not an irreversible click on the wrong control.

---

## 2. Approaching, not teleporting

A cursor that jumps straight to a target's centre and clicks is the classic
automation tell. A real pointer **approaches from the neighbourhood** and slows
as it arrives.

**Use `cdp_click`.** It builds a Bézier approach path with easing and jitter and
reports the resolved hit, so the motion model is already correct. When you drive
input with a locator, you get the approach for free.

**Do not hand-roll a page-dispatched `Input.dispatchMouseEvent` loop in
`cdp_eval`.** It re-implements (and usually simplifies away) the very motion,
jitter, and approach the tool already provides — and it bypasses the hit-test,
so a covered element silently eats the click. A hand-rolled dispatch is
appropriate only where no tool exists (see [sliders](#3-sliders-and-tracks)).

The one case worth checking by hand is **element type**: if a click "succeeds"
but nothing happens, confirm the widget actually responds to a click event
(a custom canvas widget may need pointer/touch events or a keyboard path) before
assuming the coordinates were wrong.

---

## 3. Sliders and tracks

**Use `cdp_captcha({ action: 'drag' })`.** It is a real drag tool: it reads the
track and thumb geometry fresh, builds a human-like `mousePressed → mouseMoved* →
mouseReleased` path over the real CDP `Input` channel (not a page-side
`dispatchEvent`), and then **reads the value back** to decide whether it landed.
`cdp_click` cannot do this: it performs a single press-and-release at one point,
and a drag needs the intermediate moves.

```jsonc
cdp_captcha({
  action: 'drag',
  css: '#v2-track',      // or ref / role+name — the shared locator DSL
  targetPct: 72,        // optional: read from the track's data-target
  targetId: '<your tab>'
})
```

What it does for you, per the rules below:

1. **Reads the track's live bounds** — a fresh `getBoundingClientRect` on the
   track and the thumb, never a stored coordinate. It also measures the track's
   symmetric inset **once, before the press**, and carries it into the release
   point and the read-back so both use one mapping.
2. **Finds the thumb** and uses its current position as the press point.
3. **Keeps the y-axis aligned** for the whole traversal.
4. **Adds a slight overshoot and a small pull-back** before releasing.
5. **Re-measures immediately before `mouseup`** — a window resize between plan
   and release moves the track, and a stale release lands off-target.
6. **Verifies the drag actually landed** by reading the value back, and it
   needs BOTH halves of that proof: the read-back reached the requested percent
   AND something observable changed. If either is missing, the answer is
   `ok:false, delivered:false` with a reason — never "the events were sent". A
   gesture that travelled ~0px (the thumb was already on the target) is its own
   reason, `gesture collapsed: …`, because it dragged nothing.

Honest answer shapes to expect:

| field | meaning |
|---|---|
| `delivered` | the read-back **reached** `expectedValue` (±1.5%) **and** something changed. This is the success gate, and it implies `matched:true`. |
| `matched` | the read-back landed within 1.5% of `expectedValue`. An accuracy report; on its own it does not mean the page accepted the drag. |
| `beforeValue` / `finalValue` | the percent read before the press and after the release. |
| `warnings` | `value did not reach the requested target: asked for N%, the thumb read back M%`, `the dispatched gesture travelled 0px …`, `track drifted Npx between plan and release`, `inset estimated …`, … |

If you must drive a slider without `cdp_captcha` (a widget it cannot address),
fall back to the manual protocol below.

### The manual protocol (fallback only)

1. **Read the track's live bounds.** Compute `minX = trackLeft + thumbW/2` and
   `maxX = trackRight − thumbW/2` from a fresh `getBoundingClientRect`. There is
   no valid `startX = 354, endX = 577` — those are guesses that survive only
   until the layout moves.
2. **Find the thumb** and use its current position as the start.
3. **Keep the y-axis aligned** for the whole traversal; a y-drift can drop the
   drag off the widget.
4. **Add slight overshoot and a small correction** before releasing — a real
   user does not land the handle perfectly on the first try.
5. **Verify the track actually moved** — its `value` / `aria-valuenow` /
   fill width — not merely that the events were sent.

A widget whose handler happens to accept a plain click in the track (many simple
demo sliders do) can be solved with `cdp_click` alone — but **do not assume that**.
Check the track's own click handling first; a production slider will ignore a
click without a preceding move.

**Never** hand-roll a slider by dispatching `mousemove`/`mouseup` inside the
page: those events are `isTrusted: false` and a challenge that checks for it
simply ignores the gesture.

---

## 4. Delayed confirmations

Some confirmations ignore input until an overlay clears: a cover that fades, a
button that is `disabled`, a spinner that must finish. Do not sleep a guessed
interval. Wait for the readiness signal:

- `cdp_wait({ strategy: 'visible', selector: '#submit' })` — waits for a real
  element to be visible, not merely present in the DOM;
- `cdp_wait({ strategy: 'text', selector: 'Devam et' })` — waits for specific
  copy;
- `cdp_wait({ strategy: 'network-idle' })` — waits for traffic to settle.

Only then act, and verify the result (SKILL.md §2.6). `presence ≠
visibility`: a `display:none` overlay passes a presence check, so prefer the
`visible` strategy for "is it usable yet" questions.

---

## 5. Honest failure (Layer A: detect, classify, report)

When interaction fails, **stop and classify** rather than retrying blindly.
Repeated wrong clicks are how a session gets flagged. A useful report carries:

- `stage` — which step failed (`locate` / `actionable` / `dispatch` / `verify` / `navigation`);
- `reason` — why (`overlay-covered`, `outside-viewport`, `no-effect`,
  `element-moved`, `element-gone`, `timeout`, `verification-page`);
- `evidence` — the tool output that proves it (hit tag/class, resolved box,
  expected vs actual node, URL, `targetId`);
- `attempts` — how many, so the reader can judge the stop.

Distinguish the two failure families:

- **"I could not do it"** — the target was not actionable. Fixable: scroll,
  dismiss the overlay, widen the search, re-find.
- **"It did not happen"** — the tool reported success but the page did not
  change. This is a verification gap; re-observe with a **fresh** observation
  before concluding anything (SKILL.md §2.6, SKILL.md §4).

When a bounded number of attempts fails, report and stop. Do not keep pressing.

---

## 6. Verification challenges (first-party only)

A "verification challenge" here means a check the **page itself** owns: a
checkbox to tick, a slider to slide, an image to pick, a form to fill, a
delayed confirm. Solving these with human-like input is in scope and is exactly
what the measuring discipline above is for.

**Do not hand-roll the detection.** `cdp_captcha({ action: 'scan' })` already
does it, with evidence attached to every candidate:

- it classifies each candidate as `checkbox | slider | image-select | form-field |
  delayed-confirm | multi-step | iframe-internal | decoy | dynamic-target |
  visible-honeypot | unknown`, and names the signature rules that fired in
  `evidence`. **`unknown` is the honest fallback**: when no signature rule fires,
  the tool says `unknown` rather than forcing a label;
- it attaches deep-DOM evidence per candidate — `getBoundingClientRect` →
  `scrollIntoView` → **fresh re-measure** → `elementFromPoint` hit-test — so a
  covered target reports `hitTest: "covered"` and *which element* covers it,
  instead of a click that silently lands on the sticky header;
- it inventories overlays (`overlays[]`, highest z-index first, `blocking`
  flagged) and traps (`honeypots[]`). Every trap is classified on a **two-valued
  axis** — `hidden-trap` (invisible by design) vs **`visible-honeypot`** (a field
  at `opacity:.01` that a naive "find the invisible input" scan calls normal) —
  with the rules that named it;
- it returns a **third-party verdict**. If a provider iframe is present,
  `verdict: "third-party-present"` is reported alongside the candidates — see
  *Layer C* below.

The signals it reads also cover what you would otherwise check by hand:

- **URL shape** — `/challenge`, `/captcha`, `/verify`, `/check`;
- **provider markers** — an `iframe[src*="…"]` naming a challenge vendor is the
  strongest signal that you are looking at a *third-party* wall, not a
  first-party widget (`thirdParty.providers` names it);
- **widget shape** — see the `kind` values above;
- **visual** — `cdp_screenshot` as an attached screenshot for the record.

Classify **before** you interact. A misread challenge type is what produces the
wrong click, and the wrong click is what gets the session flagged.

Drive the classified widget with the tools as normal (measure → act → verify).
A first-party checkbox is a `cdp_click` on its box; a first-party slider is
`cdp_captcha({ action: 'drag' })` ([§3](#3-sliders-and-tracks)); a form is
`cdp_fill` per field. Then read the result in one call with
`cdp_captcha({ action: 'verify' })`: `solved`, the signals behind it, and the
page's own `wrongClicks` / `decoyClicks` / `honeypotHit` counters. A counter the
page does not publish is **omitted**, never reported as zero.

**Why blocked?** `cdp_fingerprint` classifies *why a page would reject
automation* — a coherence report with ordered `whyBlocked` reasons
(`critical|high|medium|low`, each with `layer` and `evidence`). That is
**diagnosis**, and it is honest to surface. It is not a bypass: it tells you and
the user what the page objected to.

---

## Layer C: verification-challenge roles

The stealth layer aligns what the browser reports (`navigator`/headers/launch); the
project's contract at `packages/bundle/cdp/src/stealth.ts` states the caller "makes
the browser's own reported surface consistent with a person's browser."
`cdp_fingerprint` reports divergence and why-blocked reasons (severity, layer,
evidence). Neither one alters site-side state.

**For any verification challenge on the path:**

- diagnose it first — `cdp_fingerprint` `whyBlocked` and `cdp_captcha({action:'scan'})`
  (candidates, overlays, honeypots, `thirdParty`);
- complete it by the most effective available means — `cdp_click`/`cdp_fill` for
  first-party widgets, `cdp_captcha` drag/verify for sliders and checks; a
  third-party frame is cross-origin, so it is reported (`third-party-present`) and
  the walk continues with same-origin candidates;
- verify the effect with a fresh observation.

**Reporting:** deliver `whyBlocked` (severity, layer, evidence), the URL, the
provider marker, and a `cdp_screenshot` with the outcome — the parent skill's
SKILL.md §2.7 "report" step covers this. Escalate only when no means is
technically available, and name the obstacle.

---

## See also

- [Guide Map](00-map.md#cdp-guide-map) — index of all available guides.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) — snapshot weaving, refs, bounded eval, and the "what is at this point?" probe.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) — Bézier movement, typing cadence, and stealth patches.
- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — transport and session details behind the tools.
- [Scraping Master](09-scraping-master.md#web-kazıma-ustalığı--mevcut-araç-setinin-tam-kullanım-kılavuzu) — the 36-tool inventory, `cdp_captcha`'s full parameter contract, and the 17 evidence-learned rules this page's discipline is drawn from.
- [Skill Architecture](10-skill-mimarisi.md#2-akiş-haritasi--14-iş-akışı) — the same material as **named tool chains**: F4 (find → act → verify), F5 (the visual loop), F7 (scan → drive → verify), F8 (slider), F13 (blocked-page diagnosis) — plus the `ok:false` triage ladder in `10-skill-mimarisi.md` §3.7.
