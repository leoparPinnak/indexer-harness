/**
 * @deepseek-ai/dsh-cdp/locator — plan02 wave 1: the shared locator DSL, the
 * actionability report, and the expect-check evaluator behind `cdp_text` and
 * `cdp_expect` (read-only surface; the `ref` path stays closed until plan 08).
 *
 * The module is pure data plus one page-script builder — no socket, no browser
 * call — so one input always yields one output:
 * - argument parsing/validation ({@link locatorSpecFromArgs},
 *   {@link validateLocatorSpec}, {@link validateExpectOptions}),
 * - the page-side resolver ({@link buildLocatorExpression}): an async IIFE that
 *   resolves a locator through the ladder aria-label -> role+name -> tag+text ->
 *   innerText, describes the target, measures actionability, and returns one
 *   JSON string; ambiguity is reported, never silently narrowed,
 * - reply parsing ({@link parseLocatorReply}), assertion evaluation
 *   ({@link evaluateExpect}/{@link evaluateText}) — expected conditions return
 *   in-band `ok:false`/`passed:false` verdicts instead of throwing.
 *
 * @module @deepseek-ai/dsh-cdp/locator
 */

import type { PageEvaluation } from './page.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-send bound for one locator `Runtime.evaluate` round trip. */
export const LOCATOR_EVAL_TIMEOUT_MS = 8000
/** Default character cap for `cdp_text`. */
export const LOCATOR_DEFAULT_MAX_CHARS = 2000
/** Hard upper cap for `cdp_text` characters (also the page-side cut). */
export const LOCATOR_MAX_CHARS = 4000
/** Upper cap for locator/expect wait budgets. */
export const LOCATOR_MAX_WAIT_MS = 30000
/** Pause between actionability/expect poll attempts. */
export const LOCATOR_POLL_MS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a text locator compares strings. */
export type TextMatchMode = 'exact' | 'contains'

/**
 * A locator as the model supplies it. Exactly one primary selector drives
 * resolution (`css` > `ariaLabel` > `role`+`name` > `text`); the rest act as
 * AND filters. `ref`/`frame` are intentionally absent until plan 08.
 */
export interface LocatorSpec {
  /** plan16: descend into open shadow roots while resolving (light-DOM ladders
   *  are blind to web-component pages); `cdp_deep_click` defaults this true. */
  pierceShadow?: boolean | undefined
  css?: string | undefined
  ariaLabel?: string | undefined
  /** ARIA role; requires {@link name}. */
  role?: string | undefined
  /** Accessible name; requires {@link role}. */
  name?: string | undefined
  /** Visible text resolved through the ladder. */
  text?: string | undefined
  textMatch?: TextMatchMode | undefined
  /** 0-based candidate index; mandatory when more than one element matches. */
  nth?: number | undefined
  /** CSS selector bounding the whole search. */
  scope?: string | undefined
}

/** Shape of the model-facing argument maps the tools hand to {@link locatorSpecFromArgs}. */
export interface LocatorArgs {
  /** plan16: pierce open shadow roots while resolving (see {@link LocatorSpec.pierceShadow}). */
  pierceShadow?: boolean | undefined
  css?: string | undefined
  ariaLabel?: string | undefined
  role?: string | undefined
  name?: string | undefined
  text?: string | undefined
  textMatch?: string | undefined
  nth?: number | undefined
  scope?: string | undefined
}

/** Viewport-relative box, rounded to two decimals page-side. */
export interface LocatorRect {
  x: number
  y: number
  width: number
  height: number
}

/** One resolving candidate, in filtered order — `index` is the `nth` coordinate. */
export interface LocatorCandidate {
  index: number
  tag: string
  role: string
  name: string
  ariaLabel: string
  id: string
  rect: LocatorRect
  visible: boolean
  enabled: boolean
  inViewport: boolean
}

/** The single unambiguous candidate plus its readable content. */
export interface ResolvedTarget extends LocatorCandidate {
  /** Visible text (or the form value for input/textarea/select), page-side capped. */
  text: string
  /** Uncapped text length before the page-side cut, bounded at 100000. */
  textLength: number
  /** Form control value; present only for input/textarea/select. */
  value?: string
}

/** The six actionability axes measured for a resolved target. */
export interface ActionabilityReport {
  attached: boolean
  visible: boolean
  stable: boolean
  enabled: boolean
  inViewport: boolean
  hitTarget: boolean
  /** Human-readable failures; empty when every axis passes. */
  failures: string[]
}

/** One parsed page reply. `ok` is false for not-found, ambiguity, and script errors. */
export interface LocatorReply {
  ok: boolean
  found: boolean
  matched: number
  strategy: string
  candidates: LocatorCandidate[]
  url: string
  reason?: string | undefined
  hint?: string | undefined
  warning?: string | undefined
  target?: ResolvedTarget | undefined
  actionability?: ActionabilityReport | undefined
}

/** One resolution attempt with the session target it ran under. */
export interface LocatorRun {
  reply: LocatorReply
  targetId: string
}

/** Successful pre-click resolution: the point to click and the evidence behind it. */
export interface ActionResolveSuccess {
  ok: true
  targetId: string
  url: string
  /** Viewport-space centre of the target's client rect (CSS pixels). */
  point: { x: number; y: number }
  matched: number
  strategy: string
  target: ResolvedTarget
  actionability: ActionabilityReport
}

/** Failed pre-click resolution: reason plus the candidate evidence. */
export interface ActionResolveFailure {
  ok: false
  targetId: string
  url: string
  matched: number
  strategy: string
  reason: string
  candidates: LocatorCandidate[]
}

/** Discriminated result of `service.resolveForAction` (cdp_click locator mode). */
export type ActionResolution = ActionResolveSuccess | ActionResolveFailure

/** Wait/read options for {@link service.readText}. */
export interface ReadTextOptions {
  targetId?: string | undefined
  timeoutMs?: number | undefined
  maxChars?: number | undefined
}

/**
 * Envelope `cdp_text` returns; only `ok` is required. Optional keys omit
 * `| undefined` to match the tool-runtime inference under exactOptionalPropertyTypes.
 */
export interface TextOutcome {
  ok: boolean
  matched: number
  strategy: string
  candidates: LocatorCandidate[]
  waitedMs: number
  target?: ResolvedTarget
  actionability?: ActionabilityReport
  text?: string
  truncated?: boolean
  reason?: string
  warning?: string
  targetId?: string
  url?: string
}

/** The `cdp_expect` checks plan 02 ships in wave 1. */
export type ExpectCheck =
  | 'exists'
  | 'visible'
  | 'enabled'
  | 'textEquals'
  | 'textContains'
  | 'urlMatches'

/** Canonical check list; also the tool parameter enum. */
export const EXPECT_CHECKS = [
  'exists',
  'visible',
  'enabled',
  'textEquals',
  'textContains',
  'urlMatches',
] as const

/** Options for {@link service.expectCheck}. */
export interface ExpectOptions {
  check: ExpectCheck
  spec?: LocatorSpec | undefined
  expected?: string | undefined
  timeoutMs?: number | undefined
  targetId?: string | undefined
}

/**
 * Envelope `cdp_expect` returns; only `ok` is required. Optional keys omit
 * `| undefined` to match the tool-runtime inference under exactOptionalPropertyTypes.
 */
export interface ExpectOutcome {
  ok: boolean
  check: ExpectCheck
  passed: boolean
  matched: number
  strategy: string
  candidates: LocatorCandidate[]
  waitedMs: number
  target?: ResolvedTarget
  actionability?: ActionabilityReport
  expected?: string
  actual?: string
  reason?: string
  // plan08-fix-ref-rename: "resolved, but read this first" — a ref that matched
  // by node identity after an accessible-name change travels here.
  warning?: string
  targetId?: string
  url?: string
}

/** Pure verdict of one text read attempt. */
export interface TextVerdict {
  ok: boolean
  text?: string | undefined
  truncated?: boolean | undefined
  reason?: string | undefined
}

/** Pure verdict of one expect attempt. */
export interface ExpectVerdict {
  passed: boolean
  actual?: string | undefined
  reason?: string | undefined
}

/** Lightweight description of whatever sits at a point or holds focus. */
export interface HitInfo {
  tag: string
  role: string
  name: string
}

/** Coordinate-mode evidence for `cdp_click`. */
export interface PointEvidence {
  targetId: string
  url: string
  hit?: HitInfo
}

/** Focus evidence for `cdp_type`. */
export interface FocusEvidence {
  targetId: string
  url: string
  focused?: HitInfo
}

/**
 * plan02-fix-type-focus: the focus gate verdict `cdp_type` reads after its
 * click. `holds === false` is the only value that changes behaviour — it means
 * the resolved element is no longer the document's active element, so a typed
 * string would be dispatched to whatever swallowed it.
 */
export interface TypeFocusCheck {
  /** True when the armed element (or a relative) is `document.activeElement`. */
  holds: boolean
  /** Page URL measured at check time. */
  url: string
  /** What holds focus instead; absent when the page could not describe it. */
  active?: HitInfo
}

/** Parsed shape behind both evidence expressions. */
export interface EvidenceReply {
  url: string
  info?: HitInfo | undefined
}

// ---------------------------------------------------------------------------
// Normalization and validation
// ---------------------------------------------------------------------------

/**
 * Normalization both sides agree on: NFC, directional marks
 * (U+202A–U+202E, U+2066–U+2069, U+200E–U+200F) removed, whitespace
 * collapsed, ends trimmed. Makes `'Gönder ‪(Ctrl-Enter)‬'` equal
 * `'Gönder (Ctrl-Enter)'`.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[‪-‮⁦-⁩‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Build a locator spec from tool arguments; empty/invalid values are dropped. */
export function locatorSpecFromArgs(args: LocatorArgs): LocatorSpec {
  const spec: LocatorSpec = {}
  if (typeof args.css === 'string' && args.css !== '') spec.css = args.css
  if (typeof args.ariaLabel === 'string' && args.ariaLabel !== '') spec.ariaLabel = args.ariaLabel
  if (typeof args.role === 'string' && args.role !== '') spec.role = args.role
  if (typeof args.name === 'string' && args.name !== '') spec.name = args.name
  if (typeof args.text === 'string' && args.text !== '') spec.text = args.text
  if (args.textMatch === 'exact' || args.textMatch === 'contains') spec.textMatch = args.textMatch
  if (typeof args.nth === 'number' && Number.isInteger(args.nth) && args.nth >= 0) spec.nth = args.nth
  if (typeof args.scope === 'string' && args.scope !== '') spec.scope = args.scope
  if (args.pierceShadow === true) spec.pierceShadow = true
  return spec
}

/**
 * Structural validation before any round trip. Returns a failure reason or
 * `undefined` when the spec can be sent to the page.
 */
export function validateLocatorSpec(spec: LocatorSpec): string | undefined {
  const hasCss = spec.css !== undefined
  const hasAria = spec.ariaLabel !== undefined
  const hasText = spec.text !== undefined
  const hasRole = spec.role !== undefined
  const hasName = spec.name !== undefined
  if (!hasCss && !hasAria && !hasText && !hasRole && !hasName) {
    return spec.scope !== undefined
      ? 'scope alone is not a locator (pass css, ariaLabel, text, or role+name)'
      : 'no locator given (pass css, ariaLabel, text, or role+name)'
  }
  if (hasRole && !hasName) return 'role requires name'
  if (hasName && !hasRole) return 'name requires role'
  if (spec.textMatch !== undefined && spec.textMatch !== 'exact' && spec.textMatch !== 'contains') {
    return `textMatch must be exact or contains (got ${String(spec.textMatch)})`
  }
  if (spec.nth !== undefined && (!Number.isInteger(spec.nth) || spec.nth < 0)) {
    return `nth must be a non-negative integer (got ${String(spec.nth)})`
  }
  return undefined
}

/**
 * Validation for `cdp_expect`: the check set, the conditional `expected`
 * requirement, regex compile for `urlMatches`, and locator structure for the
 * checks that need a locator. `urlMatches` runs against the page URL and
 * therefore ignores the locator entirely.
 */
export function validateExpectOptions(
  check: string,
  spec: LocatorSpec,
  expected?: string | undefined,
): string | undefined {
  if (
    check !== 'exists' && check !== 'visible' && check !== 'enabled'
    && check !== 'textEquals' && check !== 'textContains' && check !== 'urlMatches'
  ) {
    return `unknown check: ${check} (expected exists|visible|enabled|textEquals|textContains|urlMatches)`
  }
  if (check === 'textEquals' || check === 'textContains' || check === 'urlMatches') {
    if (typeof expected !== 'string') return `${check} requires expected (string)`
  }
  if (check === 'urlMatches') {
    try {
      new RegExp(expected ?? '')
    } catch (error) {
      return `invalid regular expression for urlMatches: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }
  return validateLocatorSpec(spec)
}

/** Clamp a wait budget to [0, LOCATOR_MAX_WAIT_MS]; invalid → 0 (single attempt). */
export function clampWaitTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) return 0
  return Math.min(Math.floor(timeoutMs), LOCATOR_MAX_WAIT_MS)
}

/** Clamp a text budget to [1, LOCATOR_MAX_CHARS]; invalid → default. */
export function clampMaxChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) return LOCATOR_DEFAULT_MAX_CHARS
  return Math.max(1, Math.min(Math.floor(maxChars), LOCATOR_MAX_CHARS))
}

/** Poll delay; exported so tests and the service share one cadence. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

// ---------------------------------------------------------------------------
// Page-side resolver
// ---------------------------------------------------------------------------

/**
 * One async IIFE the page evaluates with `awaitPromise:true`. It resolves the
 * locator (ladder or primary selector + AND filters), refuses ambiguity with
 * evidence, and returns a JSON string: `{ok, found, matched, strategy,
 * candidates[≤5], url, reason?, hint?, warning?, target?, actionability?}`.
 * `spec === null` is the URL-only probe used by `urlMatches`.
 */
export function buildLocatorExpression(spec: LocatorSpec | null): string {
  return String.raw`(async () => {
  const spec = ${JSON.stringify(spec)};
  const MAX_NAME = 160;
  const MAX_TEXT = 4000;
  const MAX_CAND = 51;
  const MAX_REPORT = 5;
  const out = { ok: false, found: false, matched: 0, strategy: 'none', candidates: [], url: String(location.href) };
  try {
    if (spec === null) {
      out.ok = true;
      return JSON.stringify(out);
    }
    const DIRTY = /[‪-‮⁦-⁩‎‏]/g;
${locatorPageCore()}
    out.ok = true;
  } catch (error) {
    out.ok = false;
    out.reason = 'locator script failed: ' + (error && error.message ? error.message : String(error));
  }
  return JSON.stringify(out);
})()`
}

/**
 * Page-side resolution core shared by {@link buildLocatorExpression} and
 * `fill.ts`'s builder: normalization, the strategy ladder, disambiguation, and
 * the actionability block. The surrounding IIFE must provide `spec`, `out`,
 * `MAX_*`, and `DIRTY`; failure paths `return` the envelope straight out, while
 * a successful resolve falls through with `out.target` + `out.actionability`
 * set and `out.ok` still false — the caller decides what "ok" means.
 */
export function locatorPageCore(): string {
  return String.raw`
    const norm = (s) => String(s === null || s === undefined ? '' : s).normalize('NFC').replace(DIRTY, '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => { const v = String(s === null || s === undefined ? '' : s); return v.length > n ? v.slice(0, n) : v; };
    const mode = spec.textMatch === 'contains' ? 'contains' : 'exact';
    const matches = (hay, needle) => {
      const n = norm(needle);
      if (n === '') return false;
      const h = norm(hay);
      return mode === 'contains' ? h.indexOf(n) !== -1 : h === n;
    };
    const useDeep = spec.pierceShadow === true;
    const deepAll = (root, sel) => {
      const list = [];
      const stack = [root];
      while (stack.length) {
        const r = stack.pop();
        let found = [];
        try { found = r.querySelectorAll(sel); } catch (e) { found = []; }
        for (let i = 0; i < found.length && list.length <= MAX_CAND; i++) list.push(found[i]);
        let all = [];
        try { all = r.querySelectorAll('*'); } catch (e) { all = []; }
        for (let i = 0; i < all.length; i++) {
          if (all[i] && all[i].shadowRoot) stack.push(all[i].shadowRoot);
        }
      }
      return list;
    };
    const roots = [];
    if (spec.scope) {
      const found = useDeep ? deepAll(document, spec.scope) : Array.from(document.querySelectorAll(spec.scope));
      for (let i = 0; i < found.length; i++) roots.push(found[i]);
      if (roots.length === 0) {
        out.reason = 'scope not found: ' + spec.scope;
        return JSON.stringify(out);
      }
    } else {
      roots.push(document);
    }
    const collect = (selector) => {
      if (useDeep) {
        const list = [];
        for (let i = 0; i < roots.length && list.length <= MAX_CAND; i++) {
          const found = deepAll(roots[i], selector);
          for (let j = 0; j < found.length && list.length <= MAX_CAND; j++) list.push(found[j]);
        }
        return list;
      }
      const list = [];
      for (let i = 0; i < roots.length && list.length <= MAX_CAND; i++) {
        const found = roots[i].querySelectorAll(selector);
        for (let j = 0; j < found.length && list.length <= MAX_CAND; j++) list.push(found[j]);
      }
      return list;
    };
    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit !== null && explicit.trim() !== '') return explicit.trim().split(/\s+/)[0] || '';
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'option') return 'option';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'img') return 'img';
      return '';
    };
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria !== null && aria.trim() !== '') return aria;
      const byId = el.getAttribute('aria-labelledby');
      if (byId !== null && byId.trim() !== '') {
        const ids = byId.trim().split(/\s+/);
        let acc = '';
        for (let i = 0; i < ids.length; i++) {
          const ref = document.getElementById(ids[i]);
          if (ref !== null) acc += ' ' + String(ref.textContent || '');
        }
        if (acc.trim() !== '') return acc;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (el.id) {
          const labels = document.querySelectorAll('label[for]');
          for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            if (label.htmlFor === el.id) {
              const text = String(label.textContent || '');
              if (text.trim() !== '') return text;
              break;
            }
          }
        }
        const title = el.getAttribute('title');
        if (title !== null && title.trim() !== '') return title;
        return '';
      }
      return String(el.innerText || el.textContent || '');
    };
    const isVis = (el) => {
      if (el.isConnected === false) return false;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      const opacity = parseFloat(cs.opacity === '' ? '1' : cs.opacity);
      if (Number.isFinite(opacity) && opacity < 0.05) return false;
      return true;
    };
    const isEn = (el) => {
      if (el.disabled === true) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none') return false;
      return true;
    };
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
    };
    const inVp = (rect) => rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < (window.innerWidth || 0) && rect.y < (window.innerHeight || 0);
    const brief = (el, index) => {
      const rect = rectOf(el);
      return {
        index,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: cut(nameOf(el), MAX_NAME),
        ariaLabel: cut(el.getAttribute('aria-label') || '', MAX_NAME),
        id: String(el.id || ''),
        rect,
        visible: isVis(el),
        enabled: isEn(el),
        inViewport: inVp(rect),
      };
    };
    const describe = (el, index) => {
      const base = brief(el, index);
      const tag = base.tag;
      const isFormControl = tag === 'input' || tag === 'textarea' || tag === 'select';
      const value = isFormControl ? String(el.value === null || el.value === undefined ? '' : el.value) : '';
      const textSrc = isFormControl ? value : String(el.innerText || '');
      const target = {
        index: base.index,
        tag: base.tag,
        role: base.role,
        name: base.name,
        ariaLabel: base.ariaLabel,
        id: base.id,
        rect: base.rect,
        visible: base.visible,
        enabled: base.enabled,
        inViewport: base.inViewport,
        text: cut(textSrc, MAX_TEXT),
        textLength: textSrc.length > 100000 ? 100000 : textSrc.length,
      };
      if (isFormControl) target.value = value;
      return target;
    };
    const PRIMARY_POOL = '[role], button, a[href], input, textarea, select, summary, label, option, h1, h2, h3, h4, h5, h6, img';
    const primary = spec.css ? 'css' : spec.ariaLabel ? 'aria-label' : spec.role ? 'role+name' : spec.text ? 'text' : 'none';
    out.strategy = primary;
    let picked = [];
    const tried = [];
    if (primary === 'css') {
      picked = collect(spec.css);
    } else if (primary === 'aria-label') {
      picked = collect('[aria-label]').filter((el) => matches(el.getAttribute('aria-label') || '', spec.ariaLabel));
    } else if (primary === 'role+name') {
      picked = collect(PRIMARY_POOL).filter((el) => roleOf(el) === spec.role && matches(nameOf(el), spec.name));
    } else if (primary === 'text') {
      tried.push('aria-label');
      picked = collect('[aria-label]').filter((el) => matches(el.getAttribute('aria-label') || '', spec.text));
      if (picked.length === 0) {
        out.strategy = 'role+name';
        tried.push('role+name');
        picked = collect(PRIMARY_POOL).filter((el) => roleOf(el) !== '' && matches(nameOf(el), spec.text));
      }
      if (picked.length === 0) {
        out.strategy = 'tag+text';
        tried.push('tag+text');
        picked = collect('button, a[href], [role="button"], [role="link"], label, summary, th, option').filter((el) => matches(String(el.innerText || ''), spec.text));
      }
      if (picked.length === 0) {
        out.strategy = 'innerText';
        tried.push('innerText');
        picked = collect('*').filter((el) => matches(String(el.innerText || ''), spec.text));
        if (!spec.scope) out.warning = 'document-wide text match; prefer scope';
      }
      if (picked.length > MAX_CAND) {
        picked = picked.slice(0, MAX_CAND);
        out.warning = (out.warning ? out.warning + '; ' : '') + 'candidate cap reached';
      }
    } else {
      out.reason = 'no locator given (pass css, ariaLabel, text, or role+name)';
      return JSON.stringify(out);
    }
    const filtered = picked.filter((el) => {
      if (primary === 'css') {
        if (spec.ariaLabel && !matches(el.getAttribute('aria-label') || '', spec.ariaLabel)) return false;
        if (spec.role && roleOf(el) !== spec.role) return false;
        if (spec.role && spec.name && !matches(nameOf(el), spec.name)) return false;
        if (spec.text && !(matches(nameOf(el), spec.text) || matches(String(el.innerText || ''), spec.text))) return false;
      } else if (primary !== 'text' && spec.text) {
        if (!(matches(nameOf(el), spec.text) || matches(String(el.innerText || ''), spec.text))) return false;
      }
      return true;
    });
    out.matched = filtered.length;
    out.candidates = filtered.slice(0, MAX_REPORT).map((el, i) => brief(el, i));
    if (filtered.length === 0) {
      out.reason = primary === 'text'
        ? 'not found (strategy ladder exhausted: ' + tried.join(' -> ') + ')'
        : 'not found (' + out.strategy + ' matched 0 candidates' + (spec.scope ? ' in scope ' + spec.scope : '') + ')';
      return JSON.stringify(out);
    }
    out.found = true;
    let selected = filtered[0];
    if (filtered.length > 1) {
      if (typeof spec.nth === 'number') {
        const idx = Math.floor(spec.nth);
        if (idx >= 0 && idx < filtered.length) {
          selected = filtered[idx];
        } else {
          out.reason = 'nth out of range (matched=' + filtered.length + ', nth=' + idx + ')';
          return JSON.stringify(out);
        }
      } else {
        out.reason = 'ambiguous: ' + filtered.length + ' candidates';
        out.hint = 'pass nth or narrow with scope/ariaLabel';
        return JSON.stringify(out);
      }
    }
    const settle = () => new Promise((resolve) => {
      let fired = false;
      const done = () => { if (!fired) { fired = true; resolve(); } };
      const timer = setTimeout(done, 80);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { clearTimeout(timer); done(); });
      } else {
        clearTimeout(timer);
        done();
      }
    });
    const before = rectOf(selected);
    const wasVisible = isVis(selected);
    if (wasVisible) await settle();
    const after = rectOf(selected);
    const target = describe(selected, filtered.indexOf(selected));
    const stable = wasVisible && Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1 && Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1;
    const failures = [];
    const attached = selected.isConnected !== false;
    if (!attached) failures.push('detached: element left the document');
    if (!target.visible) failures.push('not visible: no layout box or hidden by display/visibility/opacity');
    if (!target.enabled) failures.push('not enabled: disabled/aria-disabled/pointer-events:none');
    if (!target.inViewport) failures.push('outside viewport: element is scrolled out of view');
    if (wasVisible && !stable) failures.push('unstable: rect changed between probes (element is moving)');
    let topmost = false;
    let coveredBy = null;
    if (target.visible && target.rect.width > 0 && target.rect.height > 0) {
      try {
        const hit = document.elementFromPoint(target.rect.x + target.rect.width / 2, target.rect.y + target.rect.height / 2);
        if (hit !== null && (hit === selected || selected.contains(hit))) topmost = true;
        else if (hit !== null) coveredBy = cut(hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : ''), MAX_NAME);
      } catch (err) {
        coveredBy = null;
      }
    }
    if (target.visible && !topmost) failures.push('hit-target blocked: topmost element at center is ' + (coveredBy || 'unknown'));
    out.target = target;
    out.actionability = { attached, visible: target.visible, stable, enabled: target.enabled, inViewport: target.inViewport, hitTarget: topmost, failures };
  `
}

/**
 * Point evidence for coordinate clicks: whatever sits at (x, y) plus the page
 * URL, as one JSON string. Read-only and best-effort.
 */
/**
 * plan16: page-side neighbourhood probe behind `cdp_describe` — the honest
 * stand-in for "what is in this picture": the node at the point, the boxes
 * around it (radius in CSS px), and the visible text each box carries. This is
 * DOM-SEMANTIC description, explicitly not OCR: a picture without markup can
 * still only be judged by eye (or by a vision-capable model).
 * Returns one JSON string like the other builders.
 */
export function buildDescribeExpression(x: number, y: number, radius: number): string {
  const px = Number.isFinite(x) ? x : 0
  const py = Number.isFinite(y) ? y : 0
  const pr = Number.isFinite(radius) && radius > 0 ? radius : 80
  return String.raw`(() => {
  const out = { ok: false, url: String(location.href) };
  try {
    const X = ${String(px)}, Y = ${String(py)}, R = ${String(pr)};
    const MAX_ITEM = 12, MAX_TEXT = 120;
    const cut = (s, n) => { const v = String(s === null || s === undefined ? '' : s); return v.length > n ? v.slice(0, n) : v; };
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }; };
    const roleOf = (el) => {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit !== null && explicit !== undefined && explicit.trim() !== '') return explicit.trim().split(/\s+/)[0] || '';
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); return t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : 'textbox'; }
      if (tag === 'textarea' || tag === 'select') return 'textbox';
      return '';
    };
    const nameOf = (el) => cut((el.getAttribute && el.getAttribute('aria-label')) || String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), MAX_TEXT);
    const hit = document.elementFromPoint(X, Y);
    const stack = document.elementsFromPoint(X, Y).slice(0, 6);
    const node = hit === null ? null : {
      tag: hit.tagName.toLowerCase(),
      id: String(hit.id || ''),
      role: roleOf(hit),
      name: nameOf(hit),
      rect: rectOf(hit),
      chain: (function () {
        const out = []; let el = hit;
        while (el !== null && out.length < 5) { out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')); el = el.parentElement || el.getRootNode ? (el.parentElement || null) : null; }
        return out;
      })(),
    };
    const box = { x: X - R, y: Y - R, width: R * 2, height: R * 2 };
    const intersects = (r) => !(r.x + r.width < box.x || r.x > box.x + box.width || r.y + r.height < box.y || r.y > box.y + box.height);
    const neighbors = [];
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && neighbors.length < MAX_ITEM; i++) {
      const el = all[i];
      const r = rectOf(el);
      if (r.width <= 0 || r.height <= 0 || !intersects(r)) continue;
      if (el.tagName.toLowerCase() === 'html' || el.tagName.toLowerCase() === 'body') continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      neighbors.push({ tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el), rect: r, pointer: cs.cursor === 'pointer' });
    }
    out.ok = true;
    out.point = { x: X, y: Y, radius: R };
    out.node = node;
    out.hitChain = stack.map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
    out.neighbors = neighbors;
  } catch (error) {
    out.ok = false;
    out.reason = 'describe script failed: ' + (error && error.message ? error.message : String(error));
  }
  return JSON.stringify(out);
})()`
}

/** Parsed shape behind {@link buildDescribeExpression} (plan16 neighbourhood probe). */
export interface DescribeReply {
  ok: boolean
  url: string
  reason?: string | undefined
  point?: { x: number; y: number; radius: number } | undefined
  node?: {
    tag: string
    id: string
    role: string
    name: string
    rect: LocatorRect
    chain: string[]
  } | undefined
  hitChain?: string[] | undefined
  neighbors?: Array<{
    tag: string
    role: string
    name: string
    rect: LocatorRect
    pointer: boolean
  }> | undefined
}

/**
 * Parse one describe evaluation. Returns undefined for errors/malformed JSON —
 * the same never-invent posture as {@link parseEvidenceReply}.
 */
export function parseDescribeReply(raw: string): DescribeReply | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as DescribeReply
  } catch {
    // malformed reply — caller reports the honest undefined
  }
  return undefined
}

export function buildPointExpression(x: number, y: number): string {
  return String.raw`(() => {
  try {
    const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const url = String(location.href);
    if (!el) return JSON.stringify({ url });
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    const name = String(aria !== null && aria.trim() !== '' ? aria : text).slice(0, 160);
    const role = String(el.getAttribute('role') || '').split(/\s+/)[0] || tag;
    return JSON.stringify({ url, hit: { tag, role, name } });
  } catch (e) {
    return JSON.stringify({ url: String(location.href) });
  }
})()`
}

/** Focus evidence for typing: the active element plus the page URL. */
export function buildFocusExpression(): string {
  return String.raw`(() => {
  try {
    const el = document.activeElement;
    const url = String(location.href);
    if (!el || el === document.body) return JSON.stringify({ url });
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    const name = String(aria !== null && aria.trim() !== '' ? aria : text).slice(0, 160);
    const role = String(el.getAttribute('role') || '').split(/\s+/)[0] || tag;
    return JSON.stringify({ url, focused: { tag, role, name } });
  } catch (e) {
    return JSON.stringify({ url: String(location.href) });
  }
})()`
}

/**
 * plan02-fix-type-focus: arm the focus gate — remember which node a click is
 * about to land on, BEFORE the click runs. Read-only apart from one window
 * slot (a DOM reference, no attribute and no visible mutation), so the check
 * after the click can prove focus really landed on that node instead of on
 * `document.body`.
 * @param x - viewport CSS x of the click point.
 * @param y - viewport CSS y of the click point.
 * @returns the page expression.
 */
export function buildFocusArmExpression(x: number, y: number): string {
  return String.raw`(() => {
  try {
    const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    window.__dshTypeTarget = el || null;
    return JSON.stringify({ armed: el !== null && el !== undefined });
  } catch (e) {
    return JSON.stringify({ armed: false });
  }
})()`
}

/**
 * plan02-fix-type-focus: read the focus gate. The armed node (or a relative of
 * it — a label that forwards focus to its control) must still be the document's
 * active element. `<body>`/`<html>` always lose: `body.contains(input)` is true,
 * which would otherwise read as "focus is on the field" while the page is
 * actually swallowing every keystroke.
 * @returns the page expression.
 */
export function buildFocusCheckExpression(): string {
  return String.raw`(() => {
  try {
    const url = String(location.href);
    const el = window.__dshTypeTarget || null;
    window.__dshTypeTarget = null;
    if (!el) return JSON.stringify({ known: false, url });
    const describe = (node) => {
      if (!node || !node.tagName) return null;
      const tag = String(node.tagName).toLowerCase();
      const aria = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
      const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      const name = String(aria !== null && String(aria).trim() !== '' ? aria : text).slice(0, 160);
      const roleAttr = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
      const role = String(roleAttr || '').split(/\s+/)[0] || tag;
      return { tag, role, name };
    };
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) {
      return JSON.stringify({ known: true, url, holds: false, active: describe(active) });
    }
    const holds = el === active
      || (typeof el.contains === 'function' && el.contains(active))
      || (typeof active.contains === 'function' && active.contains(el));
    return JSON.stringify({ known: true, url, holds, active: describe(active) });
  } catch (e) {
    return JSON.stringify({ known: false, url: String(location.href) });
  }
})()`
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asRect(value: unknown): LocatorRect | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const { x, y, width, height } = record
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  return { x, y, width, height }
}

function asCandidate(value: unknown): LocatorCandidate | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const rect = asRect(record.rect)
  const { index, tag, role, name, ariaLabel, id, visible, enabled, inViewport } = record
  if (
    rect === undefined
    || typeof index !== 'number' || typeof tag !== 'string' || typeof role !== 'string'
    || typeof name !== 'string' || typeof ariaLabel !== 'string' || typeof id !== 'string'
    || typeof visible !== 'boolean' || typeof enabled !== 'boolean' || typeof inViewport !== 'boolean'
  ) return undefined
  return { index, tag, role, name, ariaLabel, id, rect, visible, enabled, inViewport }
}

function asTarget(value: unknown): ResolvedTarget | undefined {
  const candidate = asCandidate(value)
  const record = asRecord(value)
  if (candidate === undefined || record === undefined) return undefined
  const { text, textLength, value: formValue } = record
  if (typeof text !== 'string' || typeof textLength !== 'number') return undefined
  return {
    ...candidate,
    text,
    textLength,
    ...(typeof formValue === 'string' ? { value: formValue } : {}),
  }
}

function asActionability(value: unknown): ActionabilityReport | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const { attached, visible, stable, enabled, inViewport, hitTarget, failures } = record
  if (
    typeof attached !== 'boolean' || typeof visible !== 'boolean' || typeof stable !== 'boolean'
    || typeof enabled !== 'boolean' || typeof inViewport !== 'boolean' || typeof hitTarget !== 'boolean'
    || !Array.isArray(failures)
  ) return undefined
  const lines: string[] = []
  for (const entry of failures) if (typeof entry === 'string') lines.push(entry)
  return { attached, visible, stable, enabled, inViewport, hitTarget, failures: lines }
}

function asCandidates(value: unknown): LocatorCandidate[] {
  if (!Array.isArray(value)) return []
  const out: LocatorCandidate[] = []
  for (const entry of value) {
    const candidate = asCandidate(entry)
    if (candidate !== undefined) out.push(candidate)
  }
  return out
}

function failedReply(reason: string): LocatorReply {
  return { ok: false, found: false, matched: 0, strategy: 'none', candidates: [], url: '', reason }
}

/**
 * Parse one page evaluation into a typed reply. Never throws: evaluation
 * errors, truncation, malformed JSON, and shape drift all collapse into
 * `ok:false` with a reason, because a locator failure is data, not an
 * exception.
 */
export function parseLocatorReply(evaluation: PageEvaluation, targetId: string): LocatorRun {
  if (evaluation.error !== undefined) {
    return { targetId, reply: failedReply(`evaluation failed: ${evaluation.error.kind}: ${evaluation.error.message}`) }
  }
  if (evaluation.truncated) {
    return { targetId, reply: failedReply('locator reply exceeded the evaluation bound; narrow the locator (scope, css)') }
  }
  if (!evaluation.hasValue || evaluation.value === '') {
    return { targetId, reply: failedReply('page returned no locator reply') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(evaluation.value)
  } catch {
    return { targetId, reply: failedReply(`unparseable locator reply: ${evaluation.value.slice(0, 120)}`) }
  }
  const record = asRecord(parsed)
  const reply = record === undefined ? undefined : asLocatorReply(record)
  if (reply === undefined) {
    return { targetId, reply: failedReply('malformed locator reply: expected an object with ok:boolean') }
  }
  return { targetId, reply }
}

/**
 * Map one already-parsed reply record to its typed form with every guard
 * (candidate shape drift, optional-field types). Returns undefined when the
 * record lacks `ok:boolean`. Shared by {@link parseLocatorReply} and
 * `fill.ts`'s richer parse.
 */
export function asLocatorReply(record: Record<string, unknown>): LocatorReply | undefined {
  if (typeof record.ok !== 'boolean') return undefined
  return {
    ok: record.ok,
    found: record.found === true,
    matched: typeof record.matched === 'number' ? record.matched : 0,
    strategy: typeof record.strategy === 'string' ? record.strategy : 'none',
    candidates: asCandidates(record.candidates),
    url: typeof record.url === 'string' ? record.url : '',
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.hint === 'string' ? { hint: record.hint } : {}),
    ...(typeof record.warning === 'string' ? { warning: record.warning } : {}),
    ...(record.target !== undefined && record.target !== null ? { target: asTarget(record.target) } : {}),
    ...(record.actionability !== undefined && record.actionability !== null
      ? { actionability: asActionability(record.actionability) }
      : {}),
  }
}

/**
 * Parse one evidence JSON string (point or focus). Returns undefined when the
 * value is not JSON or not an object — callers treat evidence as optional.
 */
export function parseEvidenceReply(value: string): EvidenceReply | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (record === undefined) return undefined
  const url = typeof record.url === 'string' ? record.url : ''
  const raw = record.hit !== undefined && record.hit !== null ? record.hit : record.focused
  const info = asRecord(raw)
  if (info === undefined) return { url }
  const { tag, role, name } = info
  if (typeof tag !== 'string' || typeof role !== 'string' || typeof name !== 'string') return { url }
  return { url, info: { tag, role, name } }
}

/**
 * plan02-fix-type-focus: parse the focus gate reply. Returns undefined when the
 * page gave no verdict (`known:false` — nothing was armed, or the document was
 * replaced between the click and the check): the caller then types exactly as
 * before, because an unknown focus state is not evidence of a lost focus.
 * @param value - the page's JSON reply.
 * @returns the verdict, or undefined when the page could not judge.
 */
export function parseFocusCheckReply(value: string): TypeFocusCheck | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (record === undefined) return undefined
  if (record.known !== true || typeof record.holds !== 'boolean') return undefined
  const info = asRecord(record.active)
  if (info === undefined) return { holds: record.holds, url: typeof record.url === 'string' ? record.url : '' }
  const { tag, role, name } = info
  if (typeof tag !== 'string' || typeof role !== 'string' || typeof name !== 'string') {
    return { holds: record.holds, url: typeof record.url === 'string' ? record.url : '' }
  }
  return {
    holds: record.holds,
    url: typeof record.url === 'string' ? record.url : '',
    active: { tag, role, name },
  }
}

// ---------------------------------------------------------------------------
// Verdicts (pure; one input, one output)
// ---------------------------------------------------------------------------

/**
 * Turn one resolution attempt into a text read. Gating order: resolution ok →
 * visible → text budget. A resolved-but-hidden element fails — innerText of a
 * hidden element is not visible text.
 */
export function evaluateText(reply: LocatorReply, maxChars: number): TextVerdict {
  if (!reply.ok) {
    return { ok: false, reason: reply.reason ?? (reply.found ? 'locator did not resolve unambiguously' : 'not found') }
  }
  const actionability = reply.actionability
  if (actionability !== undefined && !actionability.visible) {
    const detail = actionability.failures.length > 0 ? ` (${actionability.failures[0]})` : ''
    return { ok: false, reason: `element resolved but is not visible${detail}` }
  }
  const target = reply.target
  if (target === undefined) {
    return { ok: false, reason: 'locator resolved but carried no target description' }
  }
  const limit = clampMaxChars(maxChars)
  const text = target.text.length > limit ? target.text.slice(0, limit) : target.text
  return { ok: true, text, truncated: target.textLength > text.length }
}

/**
 * Evaluate one expect attempt against one resolution. Expected conditions
 * never throw: not-found, ambiguity, and mismatches come back as
 * `passed:false` with a reason.
 */
export function evaluateExpect(
  reply: LocatorReply,
  check: ExpectCheck,
  expected?: string | undefined,
): ExpectVerdict {
  switch (check) {
    case 'exists': {
      if (reply.ok) return { passed: true, actual: `${String(reply.matched)} candidate(s)` }
      return { passed: false, reason: reply.reason ?? 'locator did not resolve' }
    }
    case 'visible': {
      if (!reply.ok) return { passed: false, reason: reply.reason ?? 'locator did not resolve' }
      if (reply.actionability?.visible === true) return { passed: true, actual: 'visible' }
      const failures = reply.actionability?.failures ?? []
      return {
        passed: false,
        actual: 'not visible',
        reason: `element resolved but is not visible${failures.length > 0 ? ` (${failures[0]})` : ''}`,
      }
    }
    case 'enabled': {
      if (!reply.ok) return { passed: false, reason: reply.reason ?? 'locator did not resolve' }
      if (reply.actionability?.enabled === true) return { passed: true, actual: 'enabled' }
      const failures = reply.actionability?.failures ?? []
      return {
        passed: false,
        actual: 'not enabled',
        reason: `element resolved but is not enabled${failures.length > 0 ? ` (${failures[0]})` : ''}`,
      }
    }
    case 'textEquals': {
      if (!reply.ok) return { passed: false, reason: reply.reason ?? 'locator did not resolve' }
      const actual = reply.target?.text ?? ''
      if (normalizeText(actual) === normalizeText(expected ?? '')) return { passed: true, actual: cutForReport(actual) }
      return { passed: false, actual: cutForReport(actual), reason: 'text does not equal expected' }
    }
    case 'textContains': {
      if (!reply.ok) return { passed: false, reason: reply.reason ?? 'locator did not resolve' }
      const actual = reply.target?.text ?? ''
      if (normalizeText(actual).indexOf(normalizeText(expected ?? '')) !== -1) {
        return { passed: true, actual: cutForReport(actual) }
      }
      return { passed: false, actual: cutForReport(actual), reason: 'text does not contain expected' }
    }
    case 'urlMatches': {
      let re: RegExp
      try {
        re = new RegExp(expected ?? '')
      } catch (error) {
        return { passed: false, reason: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (re.test(reply.url)) return { passed: true, actual: reply.url }
      return { passed: false, actual: reply.url, reason: `url does not match /${String(expected ?? '')}/` }
    }
    default: {
      return { passed: false, reason: `unknown check: ${String(check)}` }
    }
  }
}

function cutForReport(value: string): string {
  return value.length > 400 ? `${value.slice(0, 400)}…` : value
}

// ---------------------------------------------------------------------------
// Renderers (tools build blocks; logic stays testable here)
// ---------------------------------------------------------------------------

/** Loose structural input so the renderer accepts the schema-inferred value. */
export interface TextRenderInput {
  ok: boolean
  matched: number
  strategy: string
  text?: string | undefined
  truncated?: boolean | undefined
  reason?: string | undefined
  warning?: string | undefined
  target?: { tag: string; name: string } | undefined
}

/** One-line render for `cdp_text`: success quotes the text, failure leads with the reason. */
export function renderCdpText(value: TextRenderInput): string {
  const label = value.target !== undefined
    ? `<${value.target.tag}${value.target.name !== '' ? ` "${value.target.name}"` : ''}>`
    : 'locator'
  if (value.ok) {
    const body = String(value.text ?? '').length > 200 ? `${String(value.text ?? '').slice(0, 200)}…` : String(value.text ?? '')
    const parts = [
      `Text of ${label} (strategy=${value.strategy}, matched=${String(value.matched)}): "${body}"`,
    ]
    if (value.truncated === true) parts.push('(truncated)')
    if (value.warning !== undefined) parts.push(`[${value.warning}]`)
    return parts.join(' ')
  }
  const evidence = value.matched > 0 ? ` (strategy=${value.strategy}, matched=${String(value.matched)})` : ''
  return `cdp_text FAILED: ${value.reason ?? 'unknown failure'}${evidence}`
}

/** Loose structural input for `cdp_expect`. */
export interface ExpectRenderInput {
  ok: boolean
  check: string
  passed: boolean
  expected?: string | undefined
  actual?: string | undefined
  reason?: string | undefined
}

/** One-line render for `cdp_expect`: PASS leads with the actual, FAIL leads with the reason. */
export function renderCdpExpect(value: ExpectRenderInput): string {
  const head = `EXPECT ${value.check}${value.expected !== undefined ? ` expected=${JSON.stringify(value.expected)}` : ''}`
  if (value.passed && value.ok) {
    return `${head} -> PASS${value.actual !== undefined ? ` (actual: ${cutForReport(value.actual)})` : ''}`
  }
  return `${head} -> FAIL: ${value.reason ?? 'assertion failed'}${value.actual !== undefined ? ` (actual: ${cutForReport(value.actual)})` : ''}`
}

// ---------------------------------------------------------------------------
// Output schemas (shared with tools.ts; every execute field must be declared)
// ---------------------------------------------------------------------------

/** `{x,y,width,height}` box schema. */
export const LOCATOR_RECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
  },
} as const

/** One candidate row, including its `index` (the `nth` coordinate). */
export const LOCATOR_CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    tag: { type: 'string', required: true },
    role: { type: 'string', required: true },
    name: { type: 'string', required: true },
    ariaLabel: { type: 'string', required: true },
    id: { type: 'string', required: true },
    rect: { ...LOCATOR_RECT_SCHEMA, required: true },
    visible: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    inViewport: { type: 'boolean', required: true },
  },
} as const

/** Candidate rows plus readable content. */
export const LOCATOR_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...LOCATOR_CANDIDATE_SCHEMA.properties,
    text: { type: 'string', required: true },
    textLength: { type: 'integer', required: true },
    value: { type: 'string' },
  },
} as const

/** The actionability axes with their failure lines. */
export const LOCATOR_ACTIONABILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attached: { type: 'boolean', required: true },
    visible: { type: 'boolean', required: true },
    stable: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    inViewport: { type: 'boolean', required: true },
    hitTarget: { type: 'boolean', required: true },
    failures: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

/** Candidate array property. */
export const LOCATOR_CANDIDATES_SCHEMA = {
  type: 'array',
  items: LOCATOR_CANDIDATE_SCHEMA,
} as const

/** `hit` / `focused` point description property (required at usage sites). */
export const HIT_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tag: { type: 'string', required: true },
    role: { type: 'string', required: true },
    name: { type: 'string', required: true },
  },
} as const
