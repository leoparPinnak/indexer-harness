/** Protocol encode/decode: pure NDJSON framing, meta budget, response shapes. */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LAUNCH_APP_TIMEOUT_MS,
  NdjsonDecoder,
  REQUEST_BUDGET_META_KEY,
  decodeLine,
  encodeRequest,
  requestTimeoutFor,
} from '../src/protocol.ts'

describe('encodeRequest', () => {
  it('emits one newline-terminated JSON line with the request budget stamped into meta', () => {
    const line = encodeRequest(7, 'get_window_state', { include_text: true })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed).toEqual({
      id: 7,
      method: 'get_window_state',
      params: { include_text: true },
      meta: { [REQUEST_BUDGET_META_KEY]: DEFAULT_REQUEST_TIMEOUT_MS },
    })
  })

  it('gives launch_app the 15s budget and merges caller meta under it', () => {
    const line = encodeRequest(1, 'launch_app', { app: 'notepad.exe' }, { trace: 'abc' })
    const parsed = JSON.parse(line) as { meta: Record<string, unknown> }
    expect(parsed.meta).toEqual({ trace: 'abc', [REQUEST_BUDGET_META_KEY]: LAUNCH_APP_TIMEOUT_MS })
  })

  it('lets an explicit timeout win the budget value', () => {
    const parsed = JSON.parse(encodeRequest(2, 'press_key', {}, {}, 4321)) as { meta: Record<string, unknown> }
    expect(parsed.meta[REQUEST_BUDGET_META_KEY]).toBe(4321)
    expect(requestTimeoutFor('press_key', 4321)).toBe(4321)
  })

  it('mirrors the Codex per-method timeout defaults', () => {
    expect(requestTimeoutFor('launch_app')).toBe(15_000)
    expect(requestTimeoutFor('get_window_state')).toBe(10_000)
    expect(requestTimeoutFor('close')).toBe(10_000)
  })
})

describe('decodeLine', () => {
  it('routes a truthy ok to the result', () => {
    expect(decodeLine('{"id":3,"ok":true,"result":{"a":1}}')).toEqual({ kind: 'result', id: 3, result: { a: 1 } })
  })

  it('treats ok without a result as success with undefined', () => {
    expect(decodeLine('{"id":4,"ok":true}')).toEqual({ kind: 'result', id: 4, result: undefined })
  })

  it('routes an error string', () => {
    expect(decodeLine('{"id":5,"error":"boom"}')).toEqual({ kind: 'error', id: 5, error: 'boom' })
  })

  it('falls back to the transport default error text when error is not a string', () => {
    expect(decodeLine('{"id":5,"error":42}')).toEqual({
      kind: 'error',
      id: 5,
      error: 'computer-use helper request failed',
    })
  })

  it('decodes a full approvalRequest', () => {
    expect(decodeLine('{"id":6,"approvalRequest":{"app":"x.exe","displayName":"X","riskLevel":"high"}}')).toEqual({
      kind: 'approval',
      id: 6,
      approval: { app: 'x.exe', displayName: 'X', riskLevel: 'high' },
    })
  })

  it('defaults displayName to app and drops an invalid riskLevel', () => {
    expect(decodeLine('{"id":7,"approvalRequest":{"app":"y.exe","riskLevel":"maximal"}}')).toEqual({
      kind: 'approval',
      id: 7,
      approval: { app: 'y.exe', displayName: 'y.exe' },
    })
  })

  it('rejects an approvalRequest without a usable app', () => {
    expect(decodeLine('{"id":8,"approvalRequest":{"app":"  "}}')).toEqual({
      kind: 'error',
      id: 8,
      error: 'computer-use helper request failed',
    })
  })

  it('flags invalid JSON and messages without an id', () => {
    const invalid = decodeLine('not json')
    expect(invalid.kind).toBe('invalid')
    expect(decodeLine('{"ok":true}')).toEqual({ kind: 'ignored', line: '{"ok":true}', reason: 'no-id' })
    expect(decodeLine('[1,2]')).toEqual({ kind: 'ignored', line: '[1,2]', reason: 'unknown-shape' })
  })
})

describe('NdjsonDecoder', () => {
  it('splits chunks across arbitrary boundaries', () => {
    const decoder = new NdjsonDecoder()
    const first = decoder.push('{"id":1,"ok":true,"resu')
    expect(first).toHaveLength(0)
    const second = decoder.push('lt":1}\n{"id":2,"error":"e"}\n')
    expect(second).toEqual([
      { kind: 'result', id: 1, result: 1 },
      { kind: 'error', id: 2, error: 'e' },
    ])
  })

  it('tolerates CRLF, blank lines, and a trailing partial line', () => {
    const decoder = new NdjsonDecoder()
    const messages = decoder.push('\r\n{"id":1,"ok":true}\r\n\r\n{"id":2,"ok":tru')
    expect(messages).toEqual([{ kind: 'result', id: 1, result: undefined }])
    expect(decoder.push('e}\n')).toEqual([{ kind: 'result', id: 2, result: undefined }])
  })

  it('keeps every message of a multi-line burst in order', () => {
    const decoder = new NdjsonDecoder()
    const messages = decoder.push('{"id":1,"error":"a"}\n{"id":2,"ok":true,"result":true}\n')
    expect(messages.map(message => message.kind)).toEqual(['error', 'result'])
  })
})
