/**
 * Plan 02 Faz 2 (§4.4): `cdp_fill` — framework-safe form filling.
 *
 * One page evaluate does resolve → actionability → write → read-back:
 * `<input>/<textarea>` go through the native value setter + `input`/`change`
 * events (React/Vue/Angular keep their state), `<select>` picks the matching
 * option, `contenteditable` uses `Selection` + `document.execCommand` (no
 * HTML sink, Trusted-Types safe), and file inputs refuse loudly. When the
 * read-back disagrees (the framework reverted the write), the page focuses
 * and selects the element so the host can fall back to `Input.insertText`
 * and verify again — a silent swallow is impossible.
 */

import {
  LOCATOR_EVAL_TIMEOUT_MS,
  LOCATOR_POLL_MS,
  asLocatorReply,
  clampWaitTimeout,
  locatorPageCore,
  locatorSpecFromArgs,
  sleep,
  validateLocatorSpec,
  type ActionabilityReport,
  type LocatorCandidate,
  type LocatorReply,
  type LocatorSpec,
  type ResolvedTarget,
} from './locator.ts'
import type { PageEvaluation } from './page.ts'

/** Resolve/write budget when `timeoutMs` is absent (action-tool default, §4.3). */
export const FILL_DEFAULT_TIMEOUT_MS = 5_000

/** Reason prefixes that make a fill attempt final instead of pollable. */
const FILL_FATAL = /^(file inputs|element cannot be filled|no option matches|fill script failed|evaluation failed|locator script failed|locator reply exceeded|page returned no|unparseable|malformed|no locator given|scope not found)/

/**
 * True when a failure reason can never improve with another attempt —
 * element-kind rejections and script/parse failures stop the poll loop.
 */
export function isFillFatal(reason: string): boolean {
  return FILL_FATAL.test(reason)
}

/** Verification block attached to every fill outcome. */
export interface FillPostReport {
  checked: boolean
  passed: boolean
  condition: string
  expected: string
  actual: string
  reason?: string
}

/** One parsed page reply for a fill (locator reply + write verification). */
export interface FillReply extends LocatorReply {
  post?: FillPostReport
  fallbackNeeded?: boolean
  fallbackKind?: 'value' | 'contenteditable'
}

/** One fill resolution attempt with the session target it ran under. */
export interface FillRun {
  reply: FillReply
  targetId: string
}

/** Options for {@link service.fill}. */
export interface FillOptions {
  clear?: boolean
  verify?: boolean
  timeoutMs?: number
  targetId?: string
}

/** Envelope `cdp_fill` returns; `ok`, `action`, and `length` are required. */
export interface FillOutcome {
  ok: boolean
  action: 'fill'
  length: number
  matched?: number
  strategy?: string
  candidates?: LocatorCandidate[]
  target?: ResolvedTarget
  actionability?: ActionabilityReport
  post?: FillPostReport
  fallbackUsed?: boolean
  targetId?: string
  url?: string
  reason?: string
}

/** Input shape the renderer accepts (mirrors the tool's output schema). */
export interface FillRenderTarget {
  tag: string
  id?: string
  name?: string
  role?: string
}

/** Input shape the renderer accepts (mirrors the tool's output schema). */
export interface FillRenderInput {
  ok: boolean
  strategy?: string | undefined
  matched?: number | undefined
  target?: { tag: string, id?: string | undefined, name?: string | undefined, role?: string | undefined } | undefined
  post?: FillPostReport | undefined
  reason?: string | undefined
}

/** Output schema for the `post` verification block. */
export const FILL_POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checked: { type: 'boolean', required: true },
    passed: { type: 'boolean', required: true },
    condition: { type: 'string', required: true },
    expected: { type: 'string', required: true },
    actual: { type: 'string', required: true },
    reason: { type: 'string' },
  },
} as const

/**
 * Validate `cdp_fill` arguments in-band: a string `value` plus the shared
 * locator rules (at least one locator field, role/name pairing, textMatch,
 * nth).
 */
export function validateFillArgs(spec: LocatorSpec, value: unknown): string | undefined {
  if (typeof value !== 'string') return 'value must be a string'
  return validateLocatorSpec(spec)
}

/** Convenience over args → spec, mirroring the other locator tools. */
export function fillSpecFromArgs(args: Parameters<typeof locatorSpecFromArgs>[0]): LocatorSpec {
  return locatorSpecFromArgs(args)
}

/** Failure reply with the shared never-throw envelope. */
function failedFill(reason: string): FillReply {
  return { ok: false, found: false, matched: 0, strategy: 'none', candidates: [], url: '', reason }
}

function asPost(raw: unknown): FillPostReport | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  // Shape drift in a REQUIRED field collapses the whole block — a half-typed
  // post must never drive the verify verdict.
  if (
    typeof record.checked !== 'boolean'
    || typeof record.passed !== 'boolean'
    || typeof record.condition !== 'string'
    || typeof record.expected !== 'string'
    || typeof record.actual !== 'string'
  ) return undefined
  return {
    checked: record.checked,
    passed: record.passed,
    condition: record.condition,
    expected: record.expected,
    actual: record.actual,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  }
}

/**
 * Parse one fill evaluation into a typed run. Never throws: evaluation
 * errors, truncation, malformed JSON, and shape drift collapse into
 * `ok:false` with a reason, exactly like {@link parseLocatorReply}.
 */
export function parseFillReply(evaluation: PageEvaluation, targetId: string): FillRun {
  if (evaluation.error !== undefined) {
    return { targetId, reply: failedFill(`evaluation failed: ${evaluation.error.kind}: ${evaluation.error.message}`) }
  }
  if (evaluation.truncated) {
    return { targetId, reply: failedFill('fill reply exceeded the evaluation bound; narrow the locator (scope, css)') }
  }
  if (!evaluation.hasValue || evaluation.value === '') {
    return { targetId, reply: failedFill('page returned no fill reply') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(evaluation.value)
  } catch {
    return { targetId, reply: failedFill(`unparseable fill reply: ${evaluation.value.slice(0, 120)}`) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { targetId, reply: failedFill('malformed fill reply: expected an object with ok:boolean') }
  }
  const base = asLocatorReply(parsed as Record<string, unknown>)
  if (base === undefined) {
    return { targetId, reply: failedFill('malformed fill reply: expected an object with ok:boolean') }
  }
  const record = parsed as Record<string, unknown>
  const post = asPost(record.post)
  const fallbackKind = record.fallbackKind === 'contenteditable' ? 'contenteditable' as const
    : record.fallbackKind === 'value' ? 'value' as const : undefined
  return {
    targetId,
    reply: {
      ...base,
      ...(post !== undefined ? { post } : {}),
      ...(record.fallbackNeeded === true ? { fallbackNeeded: true } : {}),
      ...(fallbackKind !== undefined ? { fallbackKind } : {}),
    },
  }
}

/**
 * The page-side fill script: the shared locator core (early returns hand
 * resolution failures straight back), then the write + read-back per element
 * kind. Expects `spec`, `value`, `clear`, `verify`, `MAX_*`, and `DIRTY` in
 * scope the way the locator expression sets them up.
 */
export function buildFillExpression(spec: LocatorSpec, options: FillOptions & { value: string }): string {
  const clear = options.clear !== false
  const verify = options.verify !== false
  return String.raw`(async () => {
  const spec = ${JSON.stringify(spec)};
  const value = ${JSON.stringify(options.value)};
  const clear = ${clear ? 'true' : 'false'};
  const verify = ${verify ? 'true' : 'false'};
  const MAX_NAME = 160;
  const MAX_TEXT = 4000;
  const MAX_CAND = 51;
  const MAX_REPORT = 5;
  const out = { ok: false, found: false, matched: 0, strategy: 'none', candidates: [], url: String(location.href) };
  try {
    const DIRTY = /[‪-‮⁦-⁩‎‏]/g;
${locatorPageCore()}
    {
    /* plan02-fix */ // F3/T3+T6: this block is deliberate — the shared core above already
    // declares 'failures', 'before', 'target'… at IIFE top level, and a
    // duplicate 'const' in the same scope is a *parse* error that killed the
    // whole fill script ("Identifier 'failures' has already been declared").
    // A nested block lets the fill body shadow core names legally.
    const failures = (out.actionability && out.actionability.failures) || [];
    if (failures.length > 0) {
      out.ok = false;
      out.reason = 'not actionable: ' + failures.join('; ');
      return JSON.stringify(out);
    }
    const el = selected;
    const tag = out.target.tag;
    if (!el) {
      out.ok = false;
      out.reason = 'locator resolved but carried no element';
      return JSON.stringify(out);
    }
    if (tag === 'input' && String(el.type || 'text').toLowerCase() === 'file') {
      out.ok = false;
      out.reason = 'file inputs cannot be filled via locator layer';
      return JSON.stringify(out);
    }
    const before = (tag === 'input' || tag === 'textarea')
      ? String(el.value || '')
      : tag === 'select' ? '' : String(el.textContent || '');
    let kind = 'other';
    let execOk = true;
    if (tag === 'input' || tag === 'textarea') {
      kind = 'value';
      const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const next = clear ? value : String(el.value || '') + value;
      if (desc && typeof desc.set === 'function') desc.set.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'select') {
      kind = 'select';
      const optionList = Array.prototype.slice.call(el.options || []);
      let hitOption = null;
      for (let i = 0; i < optionList.length; i++) {
        if (optionList[i].value === value || norm(optionList[i].textContent) === norm(value)) { hitOption = optionList[i]; break; }
      }
      if (hitOption === null) {
        out.ok = false;
        out.reason = 'no option matches value: ' + cut(value, 80);
        return JSON.stringify(out);
      }
      if (clear) { for (let i = 0; i < optionList.length; i++) optionList[i].selected = false; }
      hitOption.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable === true || el.getAttribute('contenteditable') === 'true') {
      kind = 'contenteditable';
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!clear) range.collapse(false);
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      try { execOk = document.execCommand('insertText', false, value); } catch (err) { execOk = false; }
    } else {
      out.ok = false;
      out.reason = 'element cannot be filled: <' + tag + '> accepts no value (only input/textarea/select/contenteditable)';
      return JSON.stringify(out);
    }
    const expected = clear ? value : before + value;
    const actual = (kind === 'value' || kind === 'select')
      ? String(el.value === null || el.value === undefined ? '' : el.value)
      : String(el.textContent || '');
    out.post = {
      checked: verify === true,
      passed: verify !== true || actual === expected,
      condition: kind === 'contenteditable' ? 'textContent === expected' : 'value === expected',
      expected: expected,
      actual: actual,
    };
    if (verify === true && out.post.passed === false) {
      if (kind === 'value' && clear) {
        try { el.focus(); el.select(); } catch (focusError) { /* focus is best-effort */ }
        out.fallbackNeeded = true;
        out.fallbackKind = 'value';
        out.ok = false;
        return JSON.stringify(out);
      }
      if (kind === 'contenteditable' && execOk !== true) {
        try {
          el.focus();
          const retrySelection = window.getSelection();
          const retryRange = document.createRange();
          retryRange.selectNodeContents(el);
          if (retrySelection) { retrySelection.removeAllRanges(); retrySelection.addRange(retryRange); }
        } catch (focusError) { /* focus is best-effort */ }
        out.fallbackNeeded = true;
        out.fallbackKind = 'contenteditable';
        out.ok = false;
        return JSON.stringify(out);
      }
      out.post.reason = 'value not accepted by framework (react state override suspected)';
      out.ok = false;
      return JSON.stringify(out);
    }
    out.ok = true;
    }
  } catch (error) {
    out.ok = false;
    out.reason = 'fill script failed: ' + (error && error.message ? error.message : String(error));
  }
  return JSON.stringify(out);
})()`
}

/**
 * Tiny read-back probe used after the `Input.insertText` fallback: the
 * element is already focused + selected by the fill script, so
 * `document.activeElement` is the field itself.
 */
export function buildFillReadExpression(kind: 'value' | 'contenteditable'): string {
  const read = kind === 'value'
    ? `String(el.value === null || el.value === undefined ? '' : el.value)`
    : `String(el.textContent || '')`
  return String.raw`(() => {
  try {
    const el = document.activeElement;
    if (!el) return JSON.stringify({ url: String(location.href) });
    const actual = ${read};
    return JSON.stringify({ url: String(location.href), actual: String(actual) });
  } catch (error) {
    return JSON.stringify({ url: String(location.href), error: String(error && error.message ? error.message : error) });
  }
})()`
}

/** Extract the fallback read-back value; undefined when the probe failed. */
export function parseFillRead(evaluation: PageEvaluation): { url: string, actual?: string } | undefined {
  if (evaluation.error !== undefined || !evaluation.hasValue || evaluation.value === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(evaluation.value)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const url = typeof record.url === 'string' ? record.url : ''
  if (typeof record.actual !== 'string') return { url }
  return { url, actual: record.actual }
}

/** Map a parsed page reply to the tool envelope (shared by the poll loop). */
export function fillOutcomeFromReply(reply: FillReply, targetId: string, length: number): FillOutcome {
  return {
    ok: reply.ok,
    action: 'fill',
    length,
    ...(reply.matched > 0 ? { matched: reply.matched } : {}),
    ...(reply.strategy !== 'none' ? { strategy: reply.strategy } : {}),
    ...(reply.candidates.length > 0 ? { candidates: reply.candidates } : {}),
    ...(reply.target !== undefined ? { target: reply.target } : {}),
    ...(reply.actionability !== undefined ? { actionability: reply.actionability } : {}),
    ...(reply.post !== undefined ? { post: reply.post } : {}),
    ...(reply.fallbackNeeded === true ? { fallbackUsed: false } : {}),
    targetId,
    url: reply.url,
    ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
  }
}

/**
 * Build the final fallback outcome after `Input.insertText`: re-read the
 * element, settle `post.passed`, and state the framework-revert reason
 * when the value still did not stick.
 */
export function fillFallbackOutcome(
  reply: FillReply,
  targetId: string,
  length: number,
  actual: string | undefined,
  url: string,
): FillOutcome {
  const previous = reply.post
  const expected = previous !== undefined ? previous.expected : ''
  const post: FillPostReport = {
    checked: true,
    passed: actual !== undefined && actual === expected,
    condition: previous?.condition ?? 'value === expected',
    expected,
    actual: actual ?? previous?.actual ?? '',
    ...(actual !== undefined && actual === expected
      ? {}
      : { reason: 'value not accepted by framework (react state override suspected)' }),
  }
  return {
    ok: post.passed,
    action: 'fill',
    length,
    ...(reply.matched > 0 ? { matched: reply.matched } : {}),
    ...(reply.strategy !== 'none' ? { strategy: reply.strategy } : {}),
    ...(reply.candidates.length > 0 ? { candidates: reply.candidates } : {}),
    ...(reply.target !== undefined ? { target: reply.target } : {}),
    ...(reply.actionability !== undefined ? { actionability: reply.actionability } : {}),
    post,
    fallbackUsed: true,
    targetId,
    url: url !== '' ? url : reply.url,
    ...(post.passed ? {} : { reason: post.reason ?? 'value not accepted by framework (react state override suspected)' }),
  }
}

/** `<tag#id "name">` subject line shared by the renderers. */
export function targetLabel(target: FillRenderInput['target']): string | undefined {
  if (target === undefined) return undefined
  const id = typeof target.id === 'string' && target.id !== '' ? `#${target.id}` : ''
  const name = typeof target.name === 'string' && target.name !== ''
    ? ` "${target.name}"`
    : typeof target.role === 'string' && target.role !== '' ? `[role=${target.role}]` : ''
  return `<${target.tag}${id}${name}>`
}

/**
 * Render one `cdp_fill` outcome: success names the subject, strategy, and
 * verification; failure leads with what could not be filled and why.
 */
export function renderFill(value: FillRenderInput, written?: string): string {
  const subject = targetLabel(value.target) ?? 'element'
  const post = value.post
  if (value.ok === false) {
    if (post !== undefined && post.passed === false) {
      return `FAILED to fill ${subject}: value not accepted (expected "${post.expected}", actual "${post.actual}"). ${post.reason ?? 'Framework reverted the value.'}`
    }
    const reason = value.reason ?? (post !== undefined && post.reason !== undefined ? post.reason : 'fill failed')
    return `FAILED to fill ${subject}: ${reason}`
  }
  const strategy = value.strategy ?? 'none'
  const matched = value.matched ?? 0
  const payload = written ?? post?.expected ?? ''
  const verified = post?.checked === true
    ? `; verified: ${post.passed ? 'value matches' : `value differs (actual "${post.actual}")`}`
    : ''
  return `Filled ${subject} with "${payload}" (strategy=${strategy}, matched=${matched})${verified}.`
}

/** Internal: re-exported so service.ts's poll loop shares the same budget knobs. */
export const FILL_POLL_MS = LOCATOR_POLL_MS

/** Internal: evaluation budget for the fill script. */
export const FILL_EVAL_TIMEOUT_MS = LOCATOR_EVAL_TIMEOUT_MS

/** Internal: clamp helper re-export for the service poll loop. */
export const clampFillTimeout = clampWaitTimeout

/** Internal: one poll delay, shared with the locator loops. */
export const fillSleep = sleep
