/**
 * plan14 — the pure engine behind `cdp_locate`: "what is AT this point?".
 *
 * The tool completes the visual loop the model cannot close on its own:
 * `cdp_screenshot` → the model names a point → `cdp_locate` proves WHAT the
 * DOM has at that point → `cdp_click` acts. This module owns the page-side
 * probe expression, the host-side reply parser, the shared hit-test failure
 * wording (`hitTestFailures`, used by `cdp_find`'s render too) and the human
 * render. It never talks to the protocol and never mutates the page.
 *
 * Honesty rules (the same envelope discipline `cdp_find` follows):
 *  - an empty point is DATA — `ok:false` + `no element at (x,y)` + a `nearest`
 *    row, never `{}` and never a fabricated node;
 *  - a node found by its BOX (the point is outside the viewport, so
 *    `elementFromPoint` returns null) is reported with `inViewport:false` and
 *    says so, instead of pretending a hit test happened;
 *  - `coveredBy` names the OCCLUDER, exactly like `cdp_find`'s field of the
 *    same name (`src/refs.ts`): it is present only when a covering layer
 *    actually sits on top, and absent when the hit test passed.
 *
 * @module @deepseek-ai/dsh-cdp/locate
 */

/** Page-side probe budget. */
export const LOCATE_EVAL_TIMEOUT_MS = 5000

/**
 * Upper bound on the page-side element sweep used to answer "nothing was hit".
 * A capped sweep is reported in `warnings` — a bounded answer is never dressed
 * up as a complete one.
 */
export const LOCATE_MAX_NEAREST_SCAN = 2000

/** Visible text carried per node (the render shows it in quotes). */
export const LOCATE_MAX_TEXT_CHARS = 120

/** Class names carried per node. */
export const LOCATE_MAX_CLASSES = 8

/** Ancestry entries carried (outermost-first, the node itself is the last). */
export const LOCATE_MAX_ANCESTRY = 4

/** Depth of the page-side sweep when no hit test succeeded. */
export const LOCATE_NEAREST_DEPTH = 2

/** Viewport box (CSS pixels). */
export interface LocateRect {
  /** Left edge, CSS pixels from the viewport origin. */
  x: number
  /** Top edge, CSS pixels from the viewport origin. */
  y: number
  /** Layout width. */
  width: number
  /** Layout height. */
  height: number
}

/** One identified element at the probed point. */
export interface LocateNode {
  /** `tag#id.class1.class2` — the render's headline selector. */
  selector: string
  /** Lowercase tag name. */
  tag: string
  /** `id` attribute (empty when absent). */
  id: string
  /** First {@link LOCATE_MAX_CLASSES} class names. */
  classes: string[]
  /** Explicit `role` attribute, else the implicit tag role, else empty. */
  role: string
  /** `aria-label`, else the text of the `aria-labelledby` targets. */
  ariaLabel: string
  /** Visible text, whitespace-collapsed and cut at {@link LOCATE_MAX_TEXT_CHARS}. */
  text: string
  /** Fresh viewport box (CSS pixels). */
  rect: LocateRect
  /** True for tags/roles/tabindex/contenteditable that take a pointer. */
  interactive: boolean
  /** False when the point (and therefore this box) is outside the viewport. */
  inViewport: boolean
  /** The occluder, when one sits on top of this node at the point. */
  coveredBy?: string
  /** Computed `z-index` ('' when `auto`). */
  zIndex: string
  /** Computed `position` ('' when `static`). */
  position: string
  /** Outermost-first, last entry is the node itself, ≤ {@link LOCATE_MAX_ANCESTRY}. */
  ancestry: string[]
  /** True when the node was identified by its box, not by a hit test. */
  byBox: boolean
}

/** The closest element to an empty point — the aim correction. */
export interface LocateNearest {
  /** `tag#id.class1.class2` of that element. */
  selector: string
  /** Lowercase tag name. */
  tag: string
  /** `id` attribute (empty when absent). */
  id: string
  /** Distance from the point to the nearest corner of the box, CSS pixels. */
  distance: number
  /** Its fresh viewport box. */
  rect: LocateRect
}

/** The page-side reply, parsed and validated. */
export interface LocateRecord {
  /** Page URL at probe time. */
  url: string
  /** Viewport size in CSS pixels. */
  viewport: { width: number; height: number }
  /** The node at the point, or null when nothing was there. */
  node: LocateNode | null
  /** Closest element when `node` is null. */
  nearest: LocateNearest | null
  /** Page-side honesty lines (sweep cap, forced reflow, …). */
  warnings: string[]
}

/** A parsed reply, or the reason it could not be trusted. */
export type ParsedLocateReply =
  | { ok: true; record: LocateRecord }
  | { ok: false; reason: string }

/**
 * plan14: the readable name of one node — `tag#id.class1.class2`. The same
 * shape hosts the page-side probe, the `nearest` row and the ancestry chain,
 * so a model reading a failure line recognizes the same selector elsewhere.
 * @param tag - the element's tag name, or `''` for an anonymous node.
 * @param id - the element's `id`, when it has one.
 * @param classes - the element's classes, in document order, when any.
 * @returns the short selector.
 */
export function locateLabel(tag: string, id: string, classes: readonly string[] = []): string {
  const base = tag === '' ? '?' : tag
  const head = id === '' ? base : `${base}#${id}`
  const suffix = classes.length === 0 ? '' : `.${classes.join('.')}`
  return `${head}${suffix}`
}

/**
 * plan14: the shared hit-test failure wording. `cdp_find`'s render and
 * `cdp_locate`'s render both call this, so the two tools can never disagree
 * about what "covered by X" or "outside the viewport" means.
 * @param input - the measured axes (same field names as `cdp_find`'s `actionable`).
 * @returns one short phrase per failing axis, in a stable order.
 */
export function hitTestFailures(input: {
  /** Occupies visible space; when omitted the axis is not reported. */
  visible?: boolean
  /** Box intersects the viewport. */
  inViewport: boolean
  /** Topmost at the point; only meaningful when `visible` is not false. */
  hitTarget?: boolean
  /** The occluder's name, when one was measured. */
  coveredBy?: string
}): string[] {
  const failures: string[] = []
  if (input.visible === false) failures.push('not visible')
  if (input.inViewport === false) failures.push('outside the viewport')
  if (input.visible === true && input.hitTarget === false) {
    failures.push(`covered by ${input.coveredBy ?? 'another element'}`)
  } else if (input.visible === true && input.hitTarget === undefined && input.coveredBy !== undefined) {
    failures.push(`covered by ${input.coveredBy}`)
  }
  return failures
}

/**
 * plan14: the page-side probe. Two independent hit tests at the point (the
 * first identifies the node, the second is the fresh read `cdp_click` will
 * perform at action time), and — only when BOTH miss — a bounded sweep that
 * answers either "your point is on this box, off-viewport" or "here is the
 * nearest element and how far away it is".
 *
 * Read-only: no attribute is written, no handler runs, no window slot is used.
 * @param x - viewport CSS x.
 * @param y - viewport CSS y.
 * @returns the page expression returning one JSON string.
 */
export function buildLocateExpression(x: number, y: number): string {
  return String.raw`(() => {
  const X = ${JSON.stringify(x)}, Y = ${JSON.stringify(y)};
  const MAX_SCAN = ${String(LOCATE_MAX_NEAREST_SCAN)};
  const MAX_TEXT = ${String(LOCATE_MAX_TEXT_CHARS)};
  const MAX_CLASSES = ${String(LOCATE_MAX_CLASSES)};
  const MAX_ANCESTRY = ${String(LOCATE_MAX_ANCESTRY)};
  const out = {
    ok: true,
    url: String(location.href),
    viewport: { width: 0, height: 0 },
    node: null,
    nearest: null,
    warnings: [],
  };
  const round = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 10) / 10 : 0);
  const tagOf = (el) => String(el.localName || el.tagName || 'unknown').toLowerCase();
  const idOf = (el) => (el.id ? String(el.id) : '');
  const classesOf = (el) => {
    const out2 = [];
    try {
      const list = el.classList;
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length && out2.length < MAX_CLASSES; i++) out2.push(String(list[i]));
      }
    } catch (e) { /* classList is optional surface */ }
    return out2;
  };
  const label = (el) => {
    const tag = tagOf(el);
    const id = idOf(el);
    const cls = classesOf(el);
    return (id ? tag + '#' + id : tag) + (cls.length ? '.' + cls.join('.') : '');
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
  };
  const roleOf = (el, tag) => {
    const explicit = String(el.getAttribute && el.getAttribute('role') || '').split(/\s+/)[0];
    if (explicit) return explicit;
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'img') return 'img';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  };
  const labelTextOf = (el) => {
    const direct = String(el.getAttribute && el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (direct !== '') return direct;
    const ids = String(el.getAttribute && el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length === 0) return '';
    const parts = [];
    for (let i = 0; i < ids.length && i < 8; i++) {
      let source = null;
      try { source = el.ownerDocument.getElementById(ids[i]); } catch (e) { source = null; }
      if (source) parts.push(String(source.textContent || '').replace(/\s+/g, ' ').trim());
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const textOf = (el) => {
    let raw = '';
    try { raw = typeof el.innerText === 'string' ? el.innerText : String(el.textContent || ''); } catch (e) { raw = ''; }
    const flat = raw.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT) + '…' : flat;
  };
  const interactiveOf = (el, tag, role) => {
    if (el.hasAttribute && el.hasAttribute('onclick')) return true;
    if (el.hasAttribute && el.hasAttribute('contenteditable')) {
      const value = String(el.getAttribute('contenteditable') || '').toLowerCase();
      if (value !== 'false') return true;
    }
    if (el.tabIndex === 0) return true;
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary' || tag === 'option') return true;
    if (tag === 'label' && el.hasAttribute('for')) return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'input') return el.type !== 'hidden';
    if (tag === 'audio' || tag === 'video') return el.hasAttribute('controls');
    if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'textbox'
      || role === 'combobox' || role === 'slider' || role === 'switch' || role === 'tab' || role === 'menuitem'
      || role === 'searchbox' || role === 'spinbutton' || role === 'option') return true;
    return false;
  };
  const ancestryOf = (el) => {
    const chain = [label(el)];
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 12) {
      chain.push(label(parent));
      parent = parent.parentElement;
      depth++;
    }
    chain.reverse();
    if (chain.length > MAX_ANCESTRY) {
      const kept = chain.slice(chain.length - MAX_ANCESTRY);
      kept[0] = '…';
      return kept;
    }
    return chain;
  };
  const describe = (el, byBox) => {
    const tag = tagOf(el);
    const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    let style = null;
    try { style = view.getComputedStyle(el); } catch (e) { style = null; }
    const r = rectOf(el);
    const role = roleOf(el, tag);
    const zIndex = style ? String(style.zIndex || '') : '';
    const position = style ? String(style.position || '') : '';
    const inViewport = r.width > 0 && r.height > 0
      && r.y + r.height > 0 && r.x + r.width > 0
      && r.y < out.viewport.height && r.x < out.viewport.width
      && X >= 0 && Y >= 0 && X < out.viewport.width && Y < out.viewport.height;
    return {
      selector: label(el),
      tag: tag,
      id: idOf(el),
      classes: classesOf(el),
      role: role,
      ariaLabel: labelTextOf(el).slice(0, MAX_TEXT),
      text: textOf(el),
      rect: r,
      interactive: interactiveOf(el, tag, role),
      inViewport: inViewport,
      zIndex: zIndex === 'auto' ? '' : zIndex,
      position: position === 'static' ? '' : position,
      ancestry: ancestryOf(el),
      byBox: byBox === true,
    };
  };
  const sweep = (doc) => {
    let all = [];
    try { all = doc.querySelectorAll('*'); } catch (e) { all = []; }
    const total = all.length;
    const n = Math.min(total, MAX_SCAN);
    if (total > MAX_SCAN) {
      out.warnings.push('nearest sweep covered only the first ' + MAX_SCAN + ' of ' + total + ' elements');
    }
    let containing = null, containingArea = Infinity, near = null, nearDist = Infinity;
    for (let i = 0; i < n; i++) {
      const el = all[i];
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      const inside = X >= r.left && X <= r.right && Y >= r.top && Y <= r.bottom;
      if (inside) {
        const area = r.width * r.height;
        if (area < containingArea) { containingArea = area; containing = el; }
      }
      const dx = X < r.left ? r.left - X : (X > r.right ? X - r.right : 0);
      const dy = Y < r.top ? r.top - Y : (Y > r.bottom ? Y - r.bottom : 0);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearDist) { nearDist = d; near = el; }
    }
    return { containing: containing, nearest: near, distance: nearDist };
  };
  try {
    const doc = document;
    const view = doc.defaultView || window;
    out.viewport = { width: Number(view.innerWidth) || 0, height: Number(view.innerHeight) || 0 };
    let hit = null;
    try { hit = doc.elementFromPoint(X, Y); } catch (e) { hit = null; }
    let top = null;
    try { top = doc.elementFromPoint(X, Y); } catch (e) { top = null; }
    if (hit) {
      const node = describe(hit, false);
      if (top && top !== hit && !hit.contains(top)) {
        const cls = classesOf(top);
        const occl = tagOf(top) + (idOf(top) ? '#' + idOf(top) : '') + (cls.length ? '.' + cls.join('.') : '');
        node.coveredBy = occl;
      }
      out.node = node;
      return JSON.stringify(out);
    }
    const found = sweep(doc);
    if (found.containing) {
      out.node = describe(found.containing, true);
      out.warnings.push('no hit test at this point: the element was identified by its box, so scroll it into view before clicking');
      return JSON.stringify(out);
    }
    if (found.nearest) {
      out.nearest = {
        selector: label(found.nearest),
        tag: tagOf(found.nearest),
        id: idOf(found.nearest),
        distance: round(found.distance),
        rect: rectOf(found.nearest),
      };
    } else {
      out.warnings.push('the page exposed no element with a box, so no nearest element could be named');
    }
    return JSON.stringify(out);
  } catch (error) {
    return JSON.stringify({ ok: false, url: String(location.href), error: String(error) });
  }
})()`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    out.push(item)
    if (out.length >= cap) break
  }
  return out
}

function asRect(value: unknown): LocateRect {
  const raw = asRecord(value)
  if (raw === undefined) return { x: 0, y: 0, width: 0, height: 0 }
  return {
    x: asNumber(raw.x),
    y: asNumber(raw.y),
    width: asNumber(raw.width),
    height: asNumber(raw.height),
  }
}

/**
 * plan14: read one page-side probe reply into a validated record. Anything the
 * page did not measure is ABSENT here — a broken reply is refused with a
 * reason, never repaired with defaults that would read as findings.
 * @param value - the JSON string `buildLocateExpression` produced.
 * @returns the parsed record, or the reason it cannot be trusted.
 */
export function parseLocateReply(value: string): ParsedLocateReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, reason: 'cdp_locate: the page-side probe returned unparseable data' }
  }
  const record = asRecord(parsed)
  if (record === undefined) return { ok: false, reason: 'cdp_locate: the page-side probe returned no object' }
  if (record.ok !== true) {
    return { ok: false, reason: `cdp_locate: the page-side probe failed (${asString(record.error, 'unknown error')})` }
  }
  const viewport = asRecord(record.viewport)
  const warnings = asStringList(record.warnings, 8)
  const nodeRaw = asRecord(record.node)
  let node: LocateNode | null = null
  if (nodeRaw !== undefined) {
    const tag = asString(nodeRaw.tag)
    const classes = asStringList(nodeRaw.classes, LOCATE_MAX_CLASSES)
    node = {
      selector: asString(nodeRaw.selector) || locateLabel(tag, asString(nodeRaw.id), classes),
      tag,
      id: asString(nodeRaw.id),
      classes,
      role: asString(nodeRaw.role),
      ariaLabel: asString(nodeRaw.ariaLabel),
      text: asString(nodeRaw.text),
      rect: asRect(nodeRaw.rect),
      interactive: nodeRaw.interactive === true,
      inViewport: nodeRaw.inViewport === true,
      ...(typeof nodeRaw.coveredBy === 'string' && nodeRaw.coveredBy !== ''
        ? { coveredBy: nodeRaw.coveredBy }
        : {}),
      zIndex: asString(nodeRaw.zIndex),
      position: asString(nodeRaw.position),
      ancestry: asStringList(nodeRaw.ancestry, LOCATE_MAX_ANCESTRY),
      byBox: nodeRaw.byBox === true,
    }
  }
  const nearestRaw = asRecord(record.nearest)
  let nearest: LocateNearest | null = null
  if (nearestRaw !== undefined) {
    const tag = asString(nearestRaw.tag)
    nearest = {
      selector: asString(nearestRaw.selector) || locateLabel(tag, asString(nearestRaw.id)),
      tag,
      id: asString(nearestRaw.id),
      distance: asNumber(nearestRaw.distance),
      rect: asRect(nearestRaw.rect),
    }
  }
  return {
    ok: true,
    record: {
      url: asString(record.url),
      viewport: {
        width: viewport === undefined ? 0 : asNumber(viewport.width),
        height: viewport === undefined ? 0 : asNumber(viewport.height),
      },
      node,
      nearest,
      warnings,
    },
  }
}

/** What {@link renderLocate} needs; structurally the tool's output value. */
export interface LocateRenderInput {
  /** True only when a node was identified. */
  ok: boolean
  /** The probed point, echoed back so the render never leaves the aim implicit. */
  x?: number
  /** The probed point's y. */
  y?: number
  /** Failure line when `ok` is false. */
  reason?: string
  /** Honest caution lines. */
  warnings: string[]
  /** The identified node. */
  node?: LocateNode
  /** Closest element to an empty point. */
  nearest?: LocateNearest
}

function pointOf(input: LocateRenderInput): string {
  const x = typeof input.x === 'number' && Number.isFinite(input.x) ? input.x : 0
  const y = typeof input.y === 'number' && Number.isFinite(input.y) ? input.y : 0
  return `${String(x)},${String(y)}`
}

function head(node: LocateNode): string {
  const name = node.text === '' && node.ariaLabel === '' ? '' : `"${node.text !== '' ? node.text : node.ariaLabel}"`
  return `<${node.selector}${name === '' ? '' : ` ${name}`}>`
}

/**
 * plan14: the human render. One dense line answers "what is here", followed by
 * the ancestry (`hangi bileşende`) and, when they exist, the warnings and the
 * `nearest` aim correction — the two things that stop a model from clicking
 * the wrong place.
 * @param input - the locate outcome.
 * @returns the render text.
 */
export function renderLocate(input: LocateRenderInput): string {
  const at = `(${pointOf(input)})`
  const lines: string[] = []
  if (!input.ok || input.node === undefined) {
    const nearest = input.nearest
    const correction = nearest === undefined
      ? 'no element was found to suggest'
      : `en yakın: ${nearest.selector} (${String(nearest.distance)}px uzakta, `
        + `box(${String(nearest.rect.x)},${String(nearest.rect.y)},${String(nearest.rect.width)}x${String(nearest.rect.height)}))`
    lines.push(`Boş nokta ${at} — ${input.reason ?? 'no element at this point'}. ${correction}.`)
    lines.push('Yeniden nişan al ya da cdp_snapshot/cdp_find ile doğrula; tıklama.')
  } else {
    const node = input.node
    const bits: string[] = [
      `Nokta ${at} → ${head(node)}`,
      node.role === '' ? 'role= yok' : `role=${node.role}`,
      node.interactive ? 'tıklanabilir' : 'tıklanamaz',
      `box(${String(node.rect.x)},${String(node.rect.y)},${String(node.rect.width)}x${String(node.rect.height)})`,
    ]
    if (node.position !== '' || node.zIndex !== '') {
      bits.push(`katman: position=${node.position === '' ? 'static' : node.position} z-index=${node.zIndex === '' ? 'auto' : node.zIndex}`)
    }
    const scope = node.ancestry.join(' > ')
    if (scope !== '') bits.push(`kapsam: ${scope}`)
    lines.push(bits.join(' · '))
  }
  if (input.warnings.length > 0) {
    lines.push(`Uyarılar:\n${input.warnings.map(line => `- ${line}`).join('\n')}`)
  }
  return lines.join('\n')
}
