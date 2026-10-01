/**
 * plan16 — derin tarama çekirdeği: gölge-delme (pierceShadow), `force` yazma
 * kipi, `raw` yasağı, yazım bütçesi ve `cdp_describe` bölge betiği. Saf birim
 * testleri; tarayıcı yok, tek çıktı tek girdi.
 */
import { describe, expect, it } from 'vitest'

import {
  buildDescribeExpression,
  buildLocatorExpression,
  locatorSpecFromArgs,
  parseDescribeReply,
  validateLocatorSpec,
} from '../src/locator.ts'
import { buildFillExpression } from '../src/fill.ts'
import { DEFAULT_INPUT_BOUNDS } from '../src/input.ts'

describe('plan16: pierceShadow locator DSL', () => {
  it('spec carries the flag and the built script gates the shadow walk on it', () => {
    const plain = buildLocatorExpression({ css: 'button' })
    expect(plain).toContain('"css":"button"')
    // flag opts in only when true — absent key means light DOM
    expect(plain).not.toContain('"pierceShadow":true')
    // the walk machinery ships in every script, gated at runtime by useDeep
    expect(plain).toContain('useDeep')
    expect(plain).toContain('deepAll')

    const deep = buildLocatorExpression({ css: 'button', pierceShadow: true })
    expect(deep).toContain('"pierceShadow":true')
    expect(deep).toContain('deepAll')
    expect(deep).toContain('shadowRoot')
  })

  it('locatorSpecFromArgs copies pierceShadow:true and drops anything else', () => {
    expect(locatorSpecFromArgs({ css: 'x', pierceShadow: true }).pierceShadow).toBe(true)
    expect(locatorSpecFromArgs({ css: 'x' }).pierceShadow).toBeUndefined()
    // falsy values never ride along — only an explicit true opts in
    expect(locatorSpecFromArgs({ css: 'x', pierceShadow: false }).pierceShadow).toBeUndefined()
  })

  it('validateLocatorSpec tolerates the flag next to a valid locator', () => {
    expect(validateLocatorSpec({ text: 'Kaydet', pierceShadow: true })).toBeUndefined()
  })
})

describe('plan16: cdp_fill force writes past actionability', () => {
  it('declares force in the script and guards the refusal on it', () => {
    const forced = buildFillExpression({ css: 'input' }, { value: 'x', force: true })
    expect(forced).toContain('const force = true')
    expect(forced).toContain('force !== true')

    const polite = buildFillExpression({ css: 'input' }, { value: 'x' })
    expect(polite).toContain('const force = false')
  })

  it('the documented typing budget gives realistic strings room (17-char era is over)', () => {
    // 2s / ~70ms per char capped typing at ~17 characters — the famous
    // "typed 17 of 28" truncation. The duration bound is the drain, not the
    // character bound; long bodies still belong to cdp_fill.
    expect(DEFAULT_INPUT_BOUNDS.maxDurationMs).toBeGreaterThanOrEqual(30_000)
    expect(DEFAULT_INPUT_BOUNDS.maxCharacters).toBeGreaterThanOrEqual(4_000)
  })
})

describe('plan16: cdp_describe region probe', () => {
  it('builds a point+radius probe with neighbour caps and honest scope', () => {
    const expr = buildDescribeExpression(120, 40, 90)
    expect(expr).toContain('elementFromPoint')
    expect(expr).toContain('elementsFromPoint')
    expect(expr).toContain('neighbors')
    expect(expr).toContain('R = 90')
    expect(expr).toContain('MAX_ITEM = 12')
    expect(expr).toContain('describe script failed')
  })

  it('parses a shaped reply and refuses malformed JSON (never invents)', () => {
    const reply = parseDescribeReply(JSON.stringify({ ok: true, url: 'https://x.test/', node: { tag: 'button', id: '', role: 'button', name: 'Kaydet', rect: { x: 1, y: 2, width: 3, height: 4 }, chain: ['button'] } }))
    expect(reply?.ok).toBe(true)
    expect(reply?.node?.name).toBe('Kaydet')
    expect(parseDescribeReply('{bozuk')).toBeUndefined()
    expect(parseDescribeReply('[1,2]')).toBeUndefined()
    expect(parseDescribeReply('null')).toBeUndefined()
  })
})
