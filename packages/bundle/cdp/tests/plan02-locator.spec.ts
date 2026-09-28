/**
 * Plan 02 wave 1 locator-layer unit tests: normalization (directional marks,
 * NFC, whitespace), spec parsing/validation, the page-expression builders,
 * reply parsing (evaluation errors, truncation, malformed JSON, shape drift),
 * the pure text/expect verdicts, and both renderers. No browser, no sockets —
 * one input, one output everywhere.
 */

import { describe, expect, it } from 'vitest'
import {
  EXPECT_CHECKS,
  LOCATOR_DEFAULT_MAX_CHARS,
  LOCATOR_MAX_CHARS,
  LOCATOR_MAX_WAIT_MS,
  buildFocusExpression,
  buildLocatorExpression,
  buildPointExpression,
  clampMaxChars,
  clampWaitTimeout,
  evaluateExpect,
  evaluateText,
  locatorSpecFromArgs,
  normalizeText,
  parseEvidenceReply,
  parseLocatorReply,
  renderCdpExpect,
  renderCdpText,
  validateExpectOptions,
  validateLocatorSpec,
  type LocatorReply,
  type ResolvedTarget,
} from '../src/locator.ts'
import type { PageEvaluation } from '../src/page.ts'

/** One clean page evaluation carrying a JSON-string reply. */
function evaluation(payload: unknown, overrides: Partial<PageEvaluation> = {}): PageEvaluation {
  return {
    value: typeof payload === 'string' ? payload : JSON.stringify(payload),
    truncated: false,
    exception: undefined,
    hasValue: true,
    valueType: 'string',
    ...overrides,
  }
}

function target(text: string, textLength = text.length): ResolvedTarget {
  return {
    index: 0,
    tag: 'button',
    role: 'button',
    name: 'Gönder',
    ariaLabel: 'Gönder',
    id: 'send',
    rect: { x: 10, y: 20, width: 120, height: 32 },
    visible: true,
    enabled: true,
    inViewport: true,
    text,
    textLength,
  }
}

function reply(overrides: Partial<LocatorReply> = {}): LocatorReply {
  return {
    ok: true,
    found: true,
    matched: 1,
    strategy: 'css',
    candidates: [],
    url: 'https://example.com/form',
    ...overrides,
  }
}

describe('plan02: normalizeText', () => {
  it('strips directional marks so a dirty label equals its clean form', () => {
    const dirty = 'Gönder ‪(Ctrl-Enter)‬'
    expect(normalizeText(dirty)).toBe('Gönder (Ctrl-Enter)')
    expect(normalizeText(dirty)).toBe(normalizeText('Gönder (Ctrl-Enter)'))
  })

  it('applies NFC so decomposed input equals precomposed', () => {
    expect(normalizeText('Gönder')).toBe('Gönder')
    expect(normalizeText('Gönder')).toBe(normalizeText('Gönder'))
  })

  it('collapses whitespace and trims the ends', () => {
    expect(normalizeText('  a \n\t b\t\r\n c  ')).toBe('a b c')
  })
})

describe('plan02: locatorSpecFromArgs + validateLocatorSpec', () => {
  it('maps present arguments and drops empty/invalid ones', () => {
    const spec = locatorSpecFromArgs({
      css: '#send',
      role: '',
      textMatch: 'contains',
      nth: 2,
      scope: '.dialog',
      name: 'ignored-without-role',
    })
    expect(spec).toEqual({ css: '#send', name: 'ignored-without-role', textMatch: 'contains', nth: 2, scope: '.dialog' })
    // role was empty; a name without role survives parsing here and is rejected by validation.
    expect(spec.role).toBeUndefined()
    expect(spec.name).toBe('ignored-without-role')
  })

  it('drops a fractional or negative nth', () => {
    expect(locatorSpecFromArgs({ nth: 1.5 })).toEqual({})
    expect(locatorSpecFromArgs({ nth: -1 })).toEqual({})
  })

  it('rejects an empty locator, a lone scope, role without name, name without role', () => {
    expect(validateLocatorSpec({})).toContain('no locator given')
    expect(validateLocatorSpec({ scope: '.dialog' })).toContain('scope alone')
    expect(validateLocatorSpec({ role: 'button' })).toBe('role requires name')
    expect(validateLocatorSpec({ name: 'Gönder' })).toBe('name requires role')
  })

  it('rejects an invalid textMatch or nth, and accepts a sound spec', () => {
    expect(validateLocatorSpec({ text: 'x', textMatch: 'fuzzy' as never })).toContain('textMatch')
    expect(validateLocatorSpec({ css: '#a', nth: -2 })).toContain('nth')
    expect(validateLocatorSpec({ css: '#send' })).toBeUndefined()
    expect(validateLocatorSpec({ role: 'button', name: 'Gönder' })).toBeUndefined()
    expect(validateLocatorSpec({ text: 'Gönder' })).toBeUndefined()
    expect(validateLocatorSpec({ ariaLabel: 'Kapat' })).toBeUndefined()
  })
})

describe('plan02: validateExpectOptions', () => {
  it('rejects unknown checks and missing expected values', () => {
    expect(validateExpectOptions('hover', { css: '#a' })).toContain('unknown check')
    expect(validateExpectOptions('textEquals', { css: '#a' })).toContain('requires expected')
    expect(validateExpectOptions('textContains', { css: '#a' })).toContain('requires expected')
    expect(validateExpectOptions('urlMatches', {})).toContain('requires expected')
  })

  it('rejects an uncompilable urlMatches regex but allows it without a locator', () => {
    expect(validateExpectOptions('urlMatches', {}, '([')).toContain('invalid regular expression')
    expect(validateExpectOptions('urlMatches', {}, '^https://example\\.com/')).toBeUndefined()
  })

  it('requires a valid locator for the locator-backed checks', () => {
    expect(validateExpectOptions('exists', {})).toContain('no locator given')
    expect(validateExpectOptions('visible', { role: 'button' })).toContain('role requires name')
    expect(validateExpectOptions('exists', { css: '#send' })).toBeUndefined()
    expect(validateExpectOptions('enabled', { role: 'button', name: 'Gönder' })).toBeUndefined()
  })

  it('exposes exactly the six shipped checks', () => {
    expect([...EXPECT_CHECKS]).toEqual(['exists', 'visible', 'enabled', 'textEquals', 'textContains', 'urlMatches'])
  })
})

describe('plan02: page expression builders', () => {
  it('embeds the spec as JSON inside an async IIFE with no template literals', () => {
    const expression = buildLocatorExpression({ css: '#send', textMatch: 'contains' })
    expect(expression.startsWith('(async () => {')).toBe(true)
    expect(expression.endsWith('})()')).toBe(true)
    expect(expression).toContain('const spec = {"css":"#send","textMatch":"contains"}')
    expect(expression).not.toContain('`')
    expect(expression).not.toContain('${')
    // The ladder, ambiguity refusal, and hit testing all live in-page.
    expect(expression).toContain('ambiguous')
    expect(expression).toContain('elementFromPoint')
    expect(expression).toContain('role+name')
    expect(expression).toContain('tag+text')
  })

  it('probes URL-only when the spec is null', () => {
    expect(buildLocatorExpression(null)).toContain('const spec = null')
  })

  it('builds point and focus evidence expressions', () => {
    const point = buildPointExpression(12, 34)
    expect(point).toContain('document.elementFromPoint(12, 34)')
    expect(point).toContain('hit')
    expect(point).not.toContain('`')
    const focus = buildFocusExpression()
    expect(focus).toContain('document.activeElement')
    expect(focus).toContain('focused')
    expect(focus).not.toContain('`')
  })
})

describe('plan02: parseLocatorReply', () => {
  it('parses a full success reply, target included', () => {
    const run = parseLocatorReply(evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'aria-label',
      candidates: [],
      url: 'https://example.com/',
      target: target('Gönder'),
      actionability: {
        attached: true,
        visible: true,
        stable: true,
        enabled: true,
        inViewport: true,
        hitTarget: true,
        failures: [],
      },
    }), 'TARGET-1')
    expect(run.targetId).toBe('TARGET-1')
    expect(run.reply.ok).toBe(true)
    expect(run.reply.strategy).toBe('aria-label')
    expect(run.reply.target?.text).toBe('Gönder')
    expect(run.reply.actionability?.failures).toEqual([])
  })

  it('keeps an in-band ambiguity failure with candidates and hint', () => {
    const run = parseLocatorReply(evaluation({
      ok: false,
      found: true,
      matched: 3,
      strategy: 'text',
      candidates: [
        { index: 0, tag: 'button', role: 'button', name: 'Kaydet', ariaLabel: '', id: 'a', rect: { x: 0, y: 0, width: 1, height: 1 }, visible: true, enabled: true, inViewport: true },
        { index: 1, tag: 'button', role: 'button', name: 'Kaydet', ariaLabel: '', id: 'b', rect: { x: 0, y: 0, width: 1, height: 1 }, visible: true, enabled: true, inViewport: true },
        { index: 2, tag: 'button', role: 'button', name: 'Kaydet', ariaLabel: '', id: 'c', rect: { x: 0, y: 0, width: 1, height: 1 }, visible: true, enabled: true, inViewport: true },
      ],
      url: 'https://example.com/',
      reason: 'ambiguous: 3 candidates',
      hint: 'pass nth or narrow with scope/ariaLabel',
    }), '')
    expect(run.reply.ok).toBe(false)
    expect(run.reply.matched).toBe(3)
    expect(run.reply.candidates).toHaveLength(3)
    expect(run.reply.reason).toBe('ambiguous: 3 candidates')
    expect(run.reply.hint).toContain('nth')
  })

  it('collapses evaluation errors, truncation, and missing values into reasons', () => {
    const errored = parseLocatorReply(evaluation('', {
      hasValue: false,
      error: { kind: 'timeout', message: 'send bound exceeded' },
    }), 'T')
    expect(errored.reply.ok).toBe(false)
    expect(errored.reply.reason).toContain('evaluation failed')
    expect(errored.reply.reason).toContain('timeout')

    const cut = parseLocatorReply(evaluation('{"ok":true', { truncated: true }), 'T')
    expect(cut.reply.ok).toBe(false)
    expect(cut.reply.reason).toContain('evaluation bound')

    const empty = parseLocatorReply(evaluation('', { hasValue: false }), 'T')
    expect(empty.reply.ok).toBe(false)
    expect(empty.reply.reason).toContain('no locator reply')
  })

  it('rejects malformed and non-object replies without throwing', () => {
    const junk = parseLocatorReply(evaluation('{oops', {}), 'T')
    expect(junk.reply.ok).toBe(false)
    expect(junk.reply.reason).toContain('unparseable')

    const scalar = parseLocatorReply(evaluation('42'), 'T')
    expect(scalar.reply.ok).toBe(false)
    expect(scalar.reply.reason).toContain('malformed')

    const flagless = parseLocatorReply(evaluation({ found: true }), 'T')
    expect(flagless.reply.ok).toBe(false)
  })

  it('drops candidate rows that do not match the declared shape', () => {
    const run = parseLocatorReply(evaluation({
      ok: false,
      found: true,
      matched: 2,
      strategy: 'css',
      candidates: [{ index: 0, tag: 'button' }, 'nonsense'],
      url: 'https://example.com/',
      reason: 'ambiguous: 2 candidates',
    }), 'T')
    expect(run.reply.candidates).toEqual([])
    expect(run.reply.matched).toBe(2)
  })

  it('keeps the form value when the target carries one', () => {
    const run = parseLocatorReply(evaluation({
      ok: true,
      found: true,
      matched: 1,
      strategy: 'css',
      candidates: [],
      url: 'https://example.com/',
      target: { ...target('alice', 5), tag: 'input', role: 'textbox', value: 'alice' },
      actionability: { attached: true, visible: true, stable: true, enabled: true, inViewport: true, hitTarget: true, failures: [] },
    }), 'T')
    expect(run.reply.target?.value).toBe('alice')
    expect(run.reply.target?.text).toBe('alice')
  })
})

describe('plan02: parseEvidenceReply', () => {
  it('parses point and focus payloads', () => {
    expect(parseEvidenceReply(JSON.stringify({ url: 'https://example.com/', hit: { tag: 'button', role: 'button', name: 'Kaydet' } })))
      .toEqual({ url: 'https://example.com/', info: { tag: 'button', role: 'button', name: 'Kaydet' } })
    expect(parseEvidenceReply(JSON.stringify({ url: 'https://example.com/', focused: { tag: 'input', role: 'textbox', name: '' } })))
      .toEqual({ url: 'https://example.com/', info: { tag: 'input', role: 'textbox', name: '' } })
    expect(parseEvidenceReply(JSON.stringify({ url: 'https://example.com/' })))
      .toEqual({ url: 'https://example.com/' })
  })

  it('returns undefined for junk instead of throwing', () => {
    expect(parseEvidenceReply('not json')).toBeUndefined()
    expect(parseEvidenceReply('[1,2,3]')).toBeUndefined()
    expect(parseEvidenceReply(JSON.stringify({ url: 'u', hit: { tag: 1 } }))).toEqual({ url: 'u' })
  })
})

describe('plan02: evaluateText', () => {
  it('reads text from a visible resolved target and clamps to the budget', () => {
    const verdict = evaluateText(reply({ target: target('hello world', 11) }), 4000)
    expect(verdict).toEqual({ ok: true, text: 'hello world', truncated: false })
    const narrow = evaluateText(reply({ target: target('hello world', 11) }), 5)
    expect(narrow.ok).toBe(true)
    expect(narrow.text).toBe('hello')
    expect(narrow.truncated).toBe(true)
  })

  it('reports page-side truncation even when the budget is generous', () => {
    const verdict = evaluateText(reply({ target: target('cut text', 9000) }), LOCATOR_MAX_CHARS)
    expect(verdict.ok).toBe(true)
    expect(verdict.truncated).toBe(true)
  })

  it('fails resolution and visibility with the page reason', () => {
    const missing = evaluateText(reply({ ok: false, found: false, matched: 0, reason: 'not found (css matched 0 candidates)', url: '' }), 2000)
    expect(missing.ok).toBe(false)
    expect(missing.reason).toContain('not found')

    const hidden = evaluateText(reply({
      target: target('ghost'),
      actionability: {
        attached: true,
        visible: false,
        stable: false,
        enabled: true,
        inViewport: false,
        hitTarget: false,
        failures: ['not visible: no layout box or hidden by display/visibility/opacity'],
      },
    }), 2000)
    expect(hidden.ok).toBe(false)
    expect(hidden.reason).toContain('is not visible')
    expect(hidden.reason).toContain('not visible: no layout box')
  })

  it('fails when a success reply carries no target description', () => {
    const verdict = evaluateText(reply(), 2000)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('no target description')
  })
})

describe('plan02: evaluateExpect', () => {
  it('exists tracks the resolution verdict', () => {
    expect(evaluateExpect(reply(), 'exists')).toEqual({ passed: true, actual: '1 candidate(s)' })
    const failed = evaluateExpect(reply({ ok: false, found: false, matched: 0, reason: 'not found (css matched 0 candidates)' }), 'exists')
    expect(failed.passed).toBe(false)
    expect(failed.reason).toContain('not found')
  })

  it('visible and enabled read the actionability axes', () => {
    const axes = (visible: boolean, enabled: boolean) => ({
      attached: true,
      visible,
      stable: true,
      enabled,
      inViewport: visible,
      hitTarget: visible,
      failures: visible ? (enabled ? [] : ['not enabled: disabled/aria-disabled/pointer-events:none']) : ['not visible: no layout box or hidden by display/visibility/opacity'],
    })
    expect(evaluateExpect(reply({ actionability: axes(true, true) }), 'visible')).toEqual({ passed: true, actual: 'visible' })
    expect(evaluateExpect(reply({ actionability: axes(false, true) }), 'visible').passed).toBe(false)
    expect(evaluateExpect(reply({ actionability: axes(true, true) }), 'enabled')).toEqual({ passed: true, actual: 'enabled' })
    const disabled = evaluateExpect(reply({ actionability: axes(true, false) }), 'enabled')
    expect(disabled.passed).toBe(false)
    expect(disabled.reason).toContain('not enabled')
  })

  it('textEquals/textContains normalize both sides', () => {
    const dirty = 'Gönder ‪(Ctrl-Enter)‬'
    expect(evaluateExpect(reply({ target: target('Gönder (Ctrl-Enter)') }), 'textEquals', dirty).passed).toBe(true)
    expect(evaluateExpect(reply({ target: target('Gönder (Ctrl-Enter)') }), 'textEquals', 'Gönder').passed).toBe(false)
    // The dirty label sits inside a longer element text; normalization makes contains match.
    expect(evaluateExpect(reply({ target: target('Gönder ‪(Ctrl-Enter)‬ düğmesi') }), 'textContains', 'Gönder (Ctrl-Enter)').passed).toBe(true)
    const mismatch = evaluateExpect(reply({ target: target('Vazgeç') }), 'textEquals', 'Gönder')
    expect(mismatch.passed).toBe(false)
    expect(mismatch.actual).toBe('Vazgeç')
    expect(mismatch.reason).toContain('does not equal')
  })

  it('urlMatches tests the page URL and survives a bad regex', () => {
    expect(evaluateExpect(reply({ url: 'https://example.com/dashboard' }), 'urlMatches', '^https://example\\.com/').passed).toBe(true)
    const miss = evaluateExpect(reply({ url: 'https://example.com/' }), 'urlMatches', '^https://other\\.com/')
    expect(miss.passed).toBe(false)
    expect(miss.actual).toBe('https://example.com/')
    expect(miss.reason).toContain('does not match')
    const bad = evaluateExpect(reply(), 'urlMatches', '([')
    expect(bad.passed).toBe(false)
    expect(bad.reason).toContain('invalid regular expression')
  })

  it('refuses an unknown check instead of pretending it passed', () => {
    const verdict = evaluateExpect(reply(), 'hover' as never)
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toContain('unknown check')
  })
})

describe('plan02: clamps', () => {
  it('clamps wait budgets into [0, LOCATOR_MAX_WAIT_MS]', () => {
    expect(clampWaitTimeout(undefined)).toBe(0)
    expect(clampWaitTimeout(-5)).toBe(0)
    expect(clampWaitTimeout(Number.NaN)).toBe(0)
    expect(clampWaitTimeout(250)).toBe(250)
    expect(clampWaitTimeout(10 ** 9)).toBe(LOCATOR_MAX_WAIT_MS)
  })

  it('clamps text budgets into [1, LOCATOR_MAX_CHARS] with a default', () => {
    expect(clampMaxChars(undefined)).toBe(LOCATOR_DEFAULT_MAX_CHARS)
    expect(clampMaxChars(Number.NaN)).toBe(LOCATOR_DEFAULT_MAX_CHARS)
    expect(clampMaxChars(0)).toBe(1)
    expect(clampMaxChars(10 ** 9)).toBe(LOCATOR_MAX_CHARS)
    expect(clampMaxChars(100)).toBe(100)
  })
})

describe('plan02: renderers', () => {
  it('quotes the text on success and leads with the reason on failure', () => {
    const ok = renderCdpText({
      ok: true,
      matched: 1,
      strategy: 'aria-label',
      text: 'Gönder (Ctrl-Enter)',
      truncated: false,
      target: { tag: 'button', name: 'Gönder' },
    })
    expect(ok).toContain('Text of <button "Gönder">')
    expect(ok).toContain('strategy=aria-label')
    expect(ok).toContain('Gönder (Ctrl-Enter)')

    const failed = renderCdpText({
      ok: false,
      matched: 3,
      strategy: 'text',
      reason: 'ambiguous: 3 candidates',
    })
    expect(failed).toContain('cdp_text FAILED: ambiguous: 3 candidates')
    expect(failed).toContain('matched=3')

    const long = renderCdpText({ ok: true, matched: 1, strategy: 'css', text: 'x'.repeat(400) })
    expect(long.length).toBeLessThan(500)
    expect(long).toContain('…')
  })

  it('renders PASS with the actual and FAIL with the reason', () => {
    expect(renderCdpExpect({ ok: true, check: 'visible', passed: true, actual: 'visible' }))
      .toBe('EXPECT visible -> PASS (actual: visible)')
    const fail = renderCdpExpect({
      ok: false,
      check: 'textEquals',
      passed: false,
      expected: 'Gönder',
      actual: 'Vazgeç',
      reason: 'text does not equal expected',
    })
    expect(fail).toContain('EXPECT textEquals expected="Gönder"')
    expect(fail).toContain('FAIL: text does not equal expected')
    expect(fail).toContain('actual: Vazgeç')
  })
})
