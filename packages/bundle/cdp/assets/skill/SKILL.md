---
name: cdp-browser-control
description: >-
  Drive Chromium/Edge over the Chrome DevTools Protocol with the cdp_* and net_*
  tools. Use when the task opens, navigates, reads, clicks in, types into, waits on,
  screenshots or network-inspects a browser tab; when the user mentions a browser,
  tab, page, form, login, selector, snapshot, popup, download, proxy capture, or
  "the CDP tab"; or before any task that mutates page state. Carries the
  target-confirmation procedure, tool-selection table, and failure playbook.
whenToUse: Any task that must observe or change a live browser page; load before the
  first cdp_* call of a session.
---

# CDP Browser Automation Skill

You are controlling a real Chromium-based browser over the Chrome DevTools Protocol.
This skill is **not optional reading** for that work: every rule below exists because
a real session broke without it (wrong tab mutated, silent no-op writes, 12 wasted
diagnostic turns).

## 1. What and when

- Tools you may use: `cdp_status`, `cdp_open`, `cdp_tabs`, `cdp_navigate`,
  `cdp_snapshot`, `cdp_eval`, `cdp_click`, `cdp_type`, `cdp_wait`, `net_capture`,
  `net_export` (plus newer tools listed in §6 — always prefer a purpose-built tool
  over a hand-rolled `cdp_eval` equivalent).
- Purpose-built companions already registered alongside that core: `cdp_exec`,
  `cdp_screenshot`, `cdp_viewport`, `cdp_printpdf`, `cdp_download`, `cdp_readpdf`,
  `cdp_pdftotext`, `cdp_files`, `cdp_tab_new`, `cdp_tab_close`, `cdp_tab_focus`,
  `cdp_scroll`, `cdp_dialog`, `cdp_upload`, `cdp_text`, `cdp_expect`,
  `cdp_endpoints`, `cdp_contexts`, `cdp_fill`, `cdp_find`, `cdp_extract`,
  `cdp_locate`, `cdp_stealth`, `cdp_fingerprint`, `cdp_captcha`, `cdp_lock`,
  `cdp_unlock` — prefer them over hand-rolled
  `cdp_eval` equivalents; the bundle's tool catalog carries their parameters and
  contracts. `cdp_captcha` is the one for a **verification challenge**: it
  detects, drives, and reads one instead of you hand-writing `cdp_exec` scripts
  (see the three `cdp_captcha` rows in §3). `cdp_locate` is the one for a
  **point read off a screenshot** (see the visual loop below).
- Read-only intent: `cdp_status`, `cdp_tabs`, `cdp_snapshot`, `cdp_eval` (reading),
  `cdp_find`, `cdp_extract`, `cdp_locate`, `cdp_fingerprint`, `net_capture`, `net_export`, and
  `cdp_captcha` with `action: 'scan'` or `action: 'verify'`.
- Coordination intent (no page change): `cdp_lock`, `cdp_unlock` — lease bookkeeping,
  safe to run without §2 target confirmation.
- Mutating intent: `cdp_navigate`, `cdp_click`, `cdp_type`, `cdp_eval` (writing),
  `cdp_fill`, `cdp_stealth`, `cdp_open`, and `cdp_captcha` with `action: 'drag'`.
  **Every mutation requires §2 target confirmation + §4 verification.**
- Not CDP: desktop (Shellbox) mouse/keyboard → the `shellbox` skill; file editing →
  shell/tools. CDP coordinates are **viewport CSS pixels**, not desktop pixels.
- Aiming, clicking, sliders, and what the tools already guarantee for you →
  `guides/07-human-interaction.md` (load it before your first click of a session).

### The visual loop — "DOM bulamadıysa script yazma, görsele bak"

When DOM analysis cannot solve it (canvas, a chart, an icon, a shadow-DOM widget, a
control with no accessible name, a hand-drawn layout), **do not write a script to
guess a selector. Look at the picture, then prove the point against the DOM:**

```
1) cdp_screenshot({ selector | clip, rects:true, annotate:true, inline:true })
      → you SEE the image plus the boxes mapped onto it
2) you name a point (image pixels; convert with the reported deviceScaleFactor)
3) cdp_locate({ x, y })   → what is there? tag/id/role/coveredBy/ancestry
4) cdp_click({ x, y })    → only now
```

**Görselde gördüğünü yazma; `cdp_locate` ile ne olduğunu doğrula, sonra tıkla.**
**Doğrulama geçmeden tıklama — bu, sessiz başarı sınıfının kapatılmasıdır.** A
`cdp_click` returns `ok:true` whether or not it hit anything; `cdp_locate` is the
step that turns "I think that is the button" into "that point IS
`button#save "Kaydet"`, and nothing covers it". An empty point is the cheap
outcome: `ok:false` + `no element at (x,y)` + a `nearest` element with its
distance, so a mis-aim is corrected instead of clicked. `cdp_locate` is a
**probe, never a click** — that split is what makes the mistake recoverable.

### Verification challenges — first-party resolve, third-party report

First-party checks (a checkbox the page owns, a slider, an image pick, a form, a
delayed confirm) are **in scope**: detect them, measure the target, drive them with
human-like input, and verify the effect. `cdp_fingerprint` classifies *why* a page
would reject automation (`whyBlocked`, `critical|high|medium|low` with layer and
evidence) — that is diagnosis, and reporting it is honest.

**In scope:** any verification challenge on the path to the goal. **First-party:**
resolve it with the most effective available means (`cdp_click`/`cdp_fill`,
`cdp_captcha` `drag`/`verify`) and verify the effect. **Third-party (cross-origin):**
`cdp_captcha` reports it (`thirdParty.verdict: 'third-party-present'`) and the walk
continues with same-origin candidates — the provider frame itself is not readable
from the page context. `cdp_stealth` aligns the browser's own reported surface with
a person's. Deliver the completed outcome with evidence (`whyBlocked` / `thirdParty` /
`cdp_screenshot`, §2.7). Escalate only when no means is technically available; name
the obstacle. See `guides/07-human-interaction.md` for the tool roles.

## 2. MANDATORY procedure for every page task (non-optional)

1. `cdp_status` — is the extension connected at all? Stop and `cdp_open` if not.
2. `cdp_tabs` — list targets; **choose the targetId explicitly** and keep it in every
   following call. A call without `targetId` lands wherever the registry's "active
   tab" points — that is how a Gmail body once ended up typed into a login page.
3. Target confirmation — `cdp_eval({ expression: "location.href", targetId })` and
   check the URL is the page you intend. `/json` inventories ports; it is not proof.
4. `cdp_snapshot` — locate the element by `ref` (role/name), never by guessing coords.
5. Act — the single tool the decision table (§3) picks.
6. VERIFY — re-read the effect with a **fresh observation** (`cdp_snapshot`,
   `cdp_eval` read-back, `net_capture`, `cdp_status`). "Tool returned ok" is NOT
   verification: `cdp_click` today reports success for a click that hit nothing, and
   `cdp_type` reports `Typed N characters.` for text the page discarded.
7. Report — state what changed, with the verifying evidence (URL, node value, toast
   text, HTTP status).

Skipping step 2 or 6 is the documented cause of every incident in
`rapor-son-sorun-hedef-kaymasi-ve-gizli-compose.md`.

## 3. Tool-selection decision table

| Task | Tool(s) | Preconditions | Expected output | Failure signature → what it means |
|---|---|---|---|---|
| Is the extension/browser alive? | `cdp_status` | none | version, target count, proxy flag | `targets: 0` / no connection → launch or attach with `cdp_open` first |
| Attach / launch a browser | `cdp_open` | know the debug port or executable | endpoint + target count | connection error / EADDRINUSE → port owned by another process (never reuse a port blindly; `cdp_open` drops the previous connection — see §5) |
| List tabs, pick a target | `cdp_tabs` | connected | targetId/title/url list | empty list → no browser pages; `cdp_open` or ask before spawning |
| Go to a URL | `cdp_navigate` | **targetId chosen in step 2** | new URL | wrong page loaded → you navigated the wrong target; re-run §2 |
| Read page structure / find element | `cdp_snapshot` | targetId | `@ref [role] name` nodes | 0 nodes / target missing → page not loaded or target died; `cdp_status`, `cdp_tabs`. Narrow the payload with `interactive` (operable entries only), `compact` (80-char names), or `includeDiff` (delta vs the previous snapshot of the same target key — the list then holds only what MOVED and `diff` carries `+`/`-`/`~` plus `unchangedCount`; a rename shows as removed+added since the ref carries the name). |
| Lease a tab before parallel work | `cdp_lock` / `cdp_unlock` | `holder` (e.g. subagent id); `ttlMs` clamped 1s..300s (default 60s) | `lockId` + `lockedUntil` / `Released …` | `LOCK HELD` (in-band) names the holder and expiry — queue, don't interleave. The lease dies at `lockedUntil` without any timer (a forgotten lock never sticks past its TTL); `cdp_unlock` by a bystander answers `not-holder`, a double unlock answers `unknown-lock` (data, not error). |
| Read or compute page state (`location.href`, form values, `textContent`, counts) | `cdp_eval` (read) | targetId; expression must RETURN a value, not mutate | `Eval result: …` (+ `truncated`) | empty result → expression threw (wrap in `try{…}catch(e){return 'ERR:'+e.message}` — today's channel can swallow throws) or result exceeded the 16 KiB budget (`truncated: true`) → narrow the expression |
| **Hold on — prefer `cdp_eval` over `cdp_click`/`cdp_type` when:** the target is hidden/`display:none`, covered, coordinate-ambiguous, or you only need a value | `cdp_eval` | — | — | if you chose eval to "click" something, you are about to hand-roll click logic: instead take a snapshot and reconsider §3 rows below |
| Click a known element | `cdp_click` | fresh `cdp_snapshot` ref → converted to viewport x/y; element visible (not `display:none`) | `Click dispatched successfully.` | **`ok:true` proves nothing about the click landing.** Always VERIFY (§2.6). If verification fails: wrong coords (stale ref → re-snapshot), covered element (cookie banner/overlay → dismiss first), or hidden element (narrow viewport → check `innerWidth`) |
| Type into a form field with verification | `cdp_fill` | a fresh snapshot ref (or locator DSL) | value applied + read-back `post` | `ok:false` with a revert → native setters refused; fallback `insertText` reported the honest reason; re-focus and retry per the §1 "visual loop" discipline (measure again, never retry blind) |
| Query elements / project fields | `cdp_find` → `cdp_extract` | snapshot refs or a query + field spec | candidates / projected rows with `missing` | `matched: 0 → ok:false` (find) or `data: []` + `missing` (extract) → the query did not match; widen the query or re-snapshot (SPA re-renders invalidate refs) |
| Type into the page | `cdp_type` | a focused element that actually receives input | `Typed N characters.` | verification read-back shows 0 chars → wrong focus target or React-controlled input swallowed it; click the field explicitly first, re-focus, retype; for bulk/structured writes prefer `cdp_eval` with native setters or purpose-built fill tools when available |
| Wait for an element, or for the page to settle | `cdp_wait` | `strategy` — one of `css` (default), `aria-label`, `text`, `visible`, `network-idle`, `navigation`, `url`; `selector`/`url` carries the value, `timeoutMs` defaults to 10000 | `Waited <ms>: strategy=…, <selector> condition met.` | timeout is **in-band `ok:false` + `reason`, never a throw**. `text` resolves through the ladder `aria-label → role+name → tag+text → innerText`, so a miss names the exhausted ladder instead of failing silently. **Presence ≠ visibility:** a `display:none` node passes `css` — use `strategy:'visible'` when you need it *usable*, and `url` (regex) / `network-idle` when you need the *page* rather than an element. |
| Wait for async work / API responses | `net_capture` (+ `cdp_wait` for DOM) | proxy active (`cdp_status`) | captured exchanges with status/duration | `total: 0` or proxy inactive → capture listener not up; check `cdp_status.proxy.active`, and remember navigation can change a target's URL mid-flight (`/json` is an event-driven inventory, not a snapshot) |
| Whole-traffic report / host grouping | `net_export` | some traffic captured | totals + host groups | all zeros → nothing captured yet; perform the user action first, export after |
| Inspect one HTTP exchange | `net_capture` with `host` filter | — | method/url/status rows | only `redacted` bodies → masked by policy, not an error |
| Run a script and **prove it acted** | `cdp_exec` | targetId; `expression` runs as IIFE/statement block | `ok` + `didAct` + `result` (+ `postCondition.passed`) | never throws: an expression throw, a failed `postCondition`, or a timeout is in-band `ok:false` + `error.kind`. **Prefer over bare `cdp_eval` whenever you need proof** — `postCondition` is the difference between "I ran it" and "it worked". A timeout only names timer throttling when the page's own `visibilityState` corroborates it; `documentHidden` is absent when the probe proved nothing, and `effectiveTimeoutMs` appears only when a corroborated hidden tab doubled the bound. |
| Capture the page as an image | `cdp_screenshot` | targetId; `fullPage` / `clip` / `selector` narrow the region | `path` + pixel/CSS dimensions | never throws — failure is in-band `ok:false` + `error`. Add `rects:true` (+ `annotate:true`) to get a coordinate legend painted on the capture, which is the fastest way to check your own aim. |
| Read or change viewport size / DPR | `cdp_viewport` | `width`+`height` together | `viewport` + `source` (`applied` or `report`) + `resizeEvent.delivered` + `appliedViewport` | never throws — in-band `ok:false`. **Call with no arguments to read the live viewport.** Emulating a size is how you reproduce a "hidden on mobile" layout on desktop. A change is reported `applied` ONLY when a page-side counter saw the page's own `resize` handler run; a counter stuck at 0 is `ok:false` + `reason` ("re-measure after a real window resize"), and `unverified` means the counter could not be read — never that it read zero. `appliedViewport` is what the call acted on at dispatch time; compare it with `viewport` when the shared window may have moved. |
| Turn the page into a PDF file | `cdp_printpdf` | targetId; `format`/`landscape`/`pageRanges` optional | `path` + `bytes` + `pageCount` | throws on failure; a `saveTo` that already exists is a hard error. |
| Wait for and save a browser download | `cdp_download` | a download must be *in flight* | `path` + `suggestedFilename` | throws — it waits up to `timeoutMs` for one to begin, so start it before triggering the click. |
| Read a PDF in the downloads root | `cdp_readpdf` | `path` (root-relative) | per-page `text` + `hasMore` | throws on a missing file; an **encrypted** document is in-band data (`encrypted:true`), not an error. |
| Extract text from a PDF **open in a tab** | `cdp_pdftotext` | a PDF tab; `strategy` defaults to `auto` | `text` + `strategy` used | throws when every strategy fails (the failure text aggregates the per-strategy reasons). Use when the document is on screen rather than on disk. |
| Manage files | `cdp_files` | `op` = `list`/`read`/`write`/`stat`/`delete`/`mkdir` | op-specific result | throws on unknown op or an `overwrite:false` collision. |
| Open / close / focus a tab | `cdp_tab_new` / `cdp_tab_focus` / `cdp_tab_close` | `cdp_tab_focus` needs a `targetId` | `targetId` + tab counts | `cdp_tab_close` refuses by design: the ACTIVE tab needs an explicit `targetId` (or `confirmActive:true`) and the LAST page needs `force:true`. |
| Scroll the page or bring an element into view | `cdp_scroll` | `mode` = `wheel` (default)/`pagedown`/`pageup`/`top`/`bottom`/`anchor`/`selector` | verified `scrollY` + extents + `atTop`/`atBottom` | throws only on an unknown `mode`. **`mode:'selector'` is the fix for a `cdp_find` that reported `inViewport:false`.** The returned position is measured after the scroll, so trust it over your assumption. |
| Inspect or answer a JS dialog | `cdp_dialog` | — | `pending` + `recent` dialogs | in-band `ok:false` + `error.code`. **A pending dialog blocks page-scoped tools** — they refuse with `dialog-open` until you answer or dismiss it. `action:'policy'` sets an auto-answer for future dialogs. |
| Attach host files to a file input | `cdp_upload` | host paths; `selector` or `chooser:true` | `files` + `input.verified` | in-band `ok:false` + `error.code`. File inputs are never written by `cdp_fill`. |
| Read one element's visible text | `cdp_text` | a locator or a snapshot `ref` | `text` (+ `truncated`) | not-found / ambiguous / hidden → in-band `ok:false` + `reason` + `candidates`. **A failed read is data, not an error** — read the candidates before re-querying. |
| Assert page state | `cdp_expect` | `check` = `exists`/`visible`/`enabled`/`textEquals`/`textContains`/`urlMatches` | `passed` + `expected`/`actual` | a failed assertion is in-band `ok:false` + `reason`, **not** a tool error — that makes `cdp_expect` the cheap way to VERIFY a mutation (§2.6) instead of a second `cdp_eval`. |
| Project structured data out of the page | `cdp_extract` | a JSON `spec` (`kind: page`/`list`/`field`) | `data` rows + `complete` | a broken spec → in-band `ok:false` + `error`; an empty result is `data: []` + `missing`. `complete:false` whenever `missing`/`truncatedFields`/`limit` cut the answer — **always report that flag.** |
| What is AT this point? (the visual loop's verify step) | `cdp_locate` | `x`/`y` in **viewport CSS pixels** | `node` (tag/id/classes/role/ariaLabel/text/rect/interactive/inViewport/coveredBy/zIndex/position/ancestry) + `viewport` | an empty point → in-band `ok:false` + `no element at (x,y)` + a `nearest` element **with its distance** — data, never `{}`. `inViewport:false` or a `coveredBy` answers `ok:true` **and** a warning: a click there would miss. Use it after `cdp_screenshot` and **before** `cdp_click`; it never clicks. |
| Discover / probe debug endpoints | `cdp_endpoints` | optional `ports` CSV | per-port `state` + `error` | never fails in-band; it is the diagnostic for "the browser is there but my tools cannot see it". |
| Isolate storage in a fresh browser context | `cdp_contexts` | `action` = `list`/`create`/`open`/`dispose` | `contexts` (+ new `targetId`) | throws on an unknown action or a missing `url`. Use it when a task needs clean cookies rather than your logged-in session. |
| Inspect / switch the stealth profile | `cdp_stealth` | `action` = `status` (default)/`apply`/`list`; `apply` needs `profile` | active profile + `coherence` + `warnings` | throws on an unknown action. **One profile sets every layer at once** (JS patches, UA/headers, launch flags); `coherence` + `warnings` report which layer could not be applied. |
| Why would this page reject me? | `cdp_fingerprint` | targetId | `coherent` + `checks` + `whyBlocked` (severity/layer/evidence) | throws on service failure. **Diagnosis only** — it classifies why a page would refuse automation; it changes no page state. |
| What kind of verification is on this page, and what blocks it? | `cdp_captcha` `action:'scan'` | targetId | `found` + `candidates[]` (each with `kind`, `evidence`, fresh `rect`, `hitTest`) + `overlays[]` + `honeypots[]` + `thirdParty` | an empty page answers `candidates: []` with a reason — **never a silent `[]`**. `hitTest:'covered'` names the occluder in `blockedBy` (that is the sticky header / cookie banner, named). `thirdParty.verdict:'third-party-present'` ⇒ reported alongside candidates (§1 scope); the walk covers same-origin frames — cross-origin frames are not readable from the page context. |
| Drive a slider / drag a track | `cdp_captcha` `action:'drag'` | a `ref`/`css`/`role`+`name` locator (or a `[data-target]` track); `targetPct` optional | `delivered` + `beforeValue`/`finalValue` vs `expectedValue`, plus `startX/Y`→`targetX/Y` and `deltaMs` | **`delivered:false` + `ok:false` means the read-back did not PROVE the drag landed** — it never reached `targetPct` (`warnings` then says `value did not reach the requested target`), or nothing changed, or the gesture collapsed because the thumb already sat on the target (`gesture collapsed: …` in `reason`). Re-read with `action:'verify'`; never retry blindly. `delivered:true` already implies `matched:true`. Never hand-roll a slider with in-page `dispatchEvent` (§4). |
| Is the challenge solved, and how many mistakes did I make? | `cdp_captcha` `action:'verify'` | targetId | `solved` + `signals` + the page's own `wrongClicks`/`decoyClicks`/`honeypotHit`/`solvedAt` | a counter the page does not publish is **omitted and warned**, never reported as `0` — "absent" is not "zero wrong clicks". This is the VERIFY step (§2.6) for a challenge, replacing hand-written metric tables. |

Rule of thumb: **`cdp_eval` = read/compute (or last-resort write), `cdp_exec` = read/compute
*with proof of effect*, `cdp_click` = one confirmed activation, `cdp_type` = keystrokes into
the confirmed focus, `cdp_find` = locate + prove actionable, `cdp_locate` = "what is at this
point?", `cdp_expect` = assert,
`cdp_captcha` = detect → drive → read a verification challenge,
`cdp_wait` = "exists in DOM", `net_capture` = what the wire saw.** When two could apply,
pick the one whose failure you can verify (§4).

> **Extracting data, not driving one control?** The rows above choose a tool for a
> single interaction. For scraping — a repeated structure, a table, a multi-page
> loop, a "did I get it all?" check — load `guides/09-scraping-master.md`: it
> carries the full 38-tool inventory, the measured `cdp_extract` spec contract
> (`count` / `complete` / `missing` / `truncatedFields`), and proven recipes. The
> two non-negotiables it adds: **always project a `count` field** so you know the
> real total behind a `limit`, and **stop a pagination loop on identity change**,
> never on a click result or a `disabled` button.

> **Know what to do, but not which chain gets you there?** Load
> `guides/10-skill-mimarisi.md`. It is the network behind this table: a per-tool
> "what do I do next" column, 14 named end-to-end flows (F1 attach → F14 dialog
> lock), and the polymorphism clusters — the several equivalent ways to find an
> element, wait, scroll, write into a field, read data, or triage an `ok:false` —
> with the rule for **when to switch to the next one**. Reach for it when two tools
> both look applicable and you cannot tell from this table alone.

### Locator parameter names (they are not uniform)

The locator ladder is the same everywhere — `css` > `aria-label` > `role`+`name` > `text`,
plus `textMatch`, `nth`, and `scope` — but the **CSS parameter has a different name in
`cdp_find`**, and that trips up every run:

| Tool | CSS parameter |
|---|---|
| `cdp_find` | **`selector`** |
| `cdp_click`, `cdp_fill`, `cdp_text`, `cdp_expect` | **`css`** |

A raw `x`/`y` is also still accepted by `cdp_click`, but passing coordinates together with
any locator param is refused — pick one addressing mode per call.

**Prefer a locator over coordinates.** `cdp_click` resolves the locator at action time,
reports which node it hit, and refuses when the target is hidden or covered;
hand-written coordinates carry none of that. And measure, never hardcode: a coordinate is
valid for one instant, and scroll, viewport size, a layout shift, or an overlay all
invalidate it. `guides/07-human-interaction.md` covers this in full — including which of
these rules the tools already guarantee for you, and what to do about sliders.

## 4. Failure playbook

- **Tool says ok, nothing changed** → verification gap, not tool error. Re-observe;
  do not repeat the mutation blindly (repeat clicks cause duplicate sends).
- **Wrong tab / surprise URL** → stop mutating; rerun §2 from `cdp_tabs`. Never
  continue "wherever it lands".
- **Empty `cdp_eval` result** → assume an exception was swallowed; re-run wrapped in
  try/catch and read the message (strict-CSP pages reject `innerHTML` with a
  TrustedHTML TypeError).
- **Stale snapshot ref** → SPA re-renders invalidate refs; always re-snapshot before
  a click instead of reusing an old `@ref`. If a ref is rejected outright as
  `stale-ref` on a page that did *not* change, do not loop on re-snapshotting — the
  same ref will be rejected again; address the element with a locator instead (§3).
- **Click "works" but UI unchanged** → covered-by overlay, hidden element (viewport
  width), or the wrong of several same-text elements (uniqueness: scope your search).
- **HTTP 401 on a page's own download** → session cookies are HttpOnly; only an
  in-page `fetch(..., {credentials:'include'})` or a purpose-built download tool can
  carry them. Never try to re-send `document.cookie`.
- **Binary / >16 KiB data** → never through `cdp_eval`; the channel truncates
  (`middle pruned`). Use download/file tools or paginate text.
- **Need desktop input or a GUI app** → wrong layer; use the `shellbox` skill.
  CDP click coordinates ≠ shellbox coordinates.

## 5. Known sharp edges (read before you touch config)

- `cdp_open` **replaces** the current connection: opening a second endpoint detaches
  the first (single connection slot today).
- Headless launches use a fresh profile → sites like Google may reject sign-in
  ("browser not secure"); prefer headed + existing profile for logged-in flows.
- The `targetId` parameter is optional everywhere and silently falls back to the
  active/first page. Treat omitting it as a mutation hazard.

## 6. Deeper guides (load on demand)

Relative to this skill's base directory (`<base>/…`):

- `guides/00-map.md` — index for everything below.
- `guides/01-protocol-core.md` — connection/target/session internals.
- `guides/02-input-and-stealth.md` — human-like input, stealth patches.
- `guides/03-dom-and-eval.md` — snapshot weaving, refs, bounded eval.
- `guides/04-proxy-and-analysis.md` — proxy, CA, capture store.
- `guides/05-workflow-combos.md` — end-to-end combos.
- `guides/06-adapters.md` — site adapter profiles.
- `guides/07-human-interaction.md` — aiming, measuring, sliders, and the
  verification-challenge boundary.
- `guides/09-scraping-master.md` — the full 38-tool parameter/output/error
  inventory plus the evidence-learned rules, when one job needs many tools.
- `guides/10-skill-mimarisi.md` — **the network itself**: a per-tool "what next"
  table, 14 named end-to-end flows (F1–F14), and the polymorphism clusters that
  say which of several equivalent paths to take. Load this when you know *what*
  to do but not *which chain* of tools gets you there.

Load a guide only when §1–§5 do not answer the question ("Load referenced resources
only as needed" is the framework's own instruction).
