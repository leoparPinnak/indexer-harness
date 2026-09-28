/**
 * Tests for the network capture model: CaptureStore redaction, bounds enforcement,
 * body classification, safe JSON parsing, query extraction, duplicate detection,
 * host grouping, and timeline building.
 */

import { describe, expect, it } from 'vitest'
import {
  buildCaptureTimeline,
  CAPTURE_REDACTED_MARKER,
  CaptureStore,
  classifyCaptureBody,
  extractCaptureQuery,
  findDuplicateCaptureRequests,
  groupCaptureByHost,
  parseCaptureJson,
  type CaptureBody,
  type CaptureExchangeInput,
  type CaptureRequestInput,
  type CaptureResponseInput,
} from '../src/net/capture.ts'

describe('CaptureStore & Analysis', () => {
  const encoder = new TextEncoder()

  function makeRequest(overrides?: Partial<CaptureRequestInput>): CaptureRequestInput {
    return {
      method: 'GET',
      url: 'https://example.com/api/v1?token=secret123&public=ok',
      httpVersion: '1.1',
      headers: [
        { name: 'Authorization', value: 'Bearer super-secret-token' },
        { name: 'X-Api-Key', value: 'secret-key-1' },
        { name: 'X-Vendor-Token', value: 'secret-token-2' },
        { name: 'User-Agent', value: 'Mozilla/5.0' },
      ],
      body: encoder.encode('{"req":true}'),
      startedAt: 1000,
      finishedAt: 1050,
      ...overrides,
    }
  }

  function makeResponse(overrides?: Partial<CaptureResponseInput>): CaptureResponseInput {
    return {
      status: 200,
      statusText: 'OK',
      headers: [
        { name: 'Set-Cookie', value: 'session=abc; Secure' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      body: encoder.encode('{"res":true}'),
      mimeType: 'application/json',
      startedAt: 1050,
      finishedAt: 1100,
      ...overrides,
    }
  }

  function makeExchange(overrides?: {
    flowId?: string
    request?: Partial<CaptureRequestInput>
    response?: Partial<CaptureResponseInput>
  }): CaptureExchangeInput {
    return {
      flowId: overrides?.flowId ?? 'flow-1',
      request: makeRequest(overrides?.request),
      response: makeResponse(overrides?.response),
    }
  }

  it('redacts sensitive headers (case-insensitive) and configured query params at capture time', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 1024,
        maxTotalBodyBytes: 10240,
        maxExchanges: 10,
        maxHeadersPerMessage: 10,
      },
      redaction: {
        headerNames: ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'],
        queryParameters: ['token'],
      },
    })

    const { exchange } = store.add(makeExchange())
    expect(exchange.redacted).toBe(true)

    // Request URL redaction
    expect(exchange.request.url).toBe(`https://example.com/api/v1?token=${CAPTURE_REDACTED_MARKER}&public=ok`)
    expect(exchange.request.url).not.toContain('secret123')

    // Request headers redaction
    const auth = exchange.request.headers.find(h => h.name.toLowerCase() === 'authorization')
    expect(auth?.value).toBe(CAPTURE_REDACTED_MARKER)

    const apiKey = exchange.request.headers.find(h => h.name.toLowerCase() === 'x-api-key')
    expect(apiKey?.value).toBe(CAPTURE_REDACTED_MARKER)

    const vendorToken = exchange.request.headers.find(h => h.name.toLowerCase() === 'x-vendor-token')
    expect(vendorToken?.value).toBe(CAPTURE_REDACTED_MARKER)

    const ua = exchange.request.headers.find(h => h.name.toLowerCase() === 'user-agent')
    expect(ua?.value).toBe('Mozilla/5.0')

    // Response header redaction
    const setCookie = exchange.response.headers.find(h => h.name.toLowerCase() === 'set-cookie')
    expect(setCookie?.value).toBe(CAPTURE_REDACTED_MARKER)
  })

  it('truncates message bodies at maxBodyBytesPerMessage and flags truncation', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 10,
        maxTotalBodyBytes: 1024,
        maxExchanges: 10,
        maxHeadersPerMessage: 10,
      },
    })

    const longBody = encoder.encode('0123456789extra-bytes') // 21 bytes
    const exactBody = encoder.encode('0123456789') // 10 bytes

    const res1 = store.add(makeExchange({
      request: {
        method: 'POST',
        url: 'https://example.com/upload',
        headers: [],
        body: longBody,
        startedAt: 1000,
      },
    }))

    expect(res1.exchange.request.body.bytes.length).toBe(10)
    expect(res1.exchange.request.body.originalLength).toBe(21)
    expect(res1.exchange.request.body.truncated).toBe(true)

    const res2 = store.add(makeExchange({
      request: {
        method: 'POST',
        url: 'https://example.com/upload2',
        headers: [],
        body: exactBody,
        startedAt: 1000,
      },
    }))

    expect(res2.exchange.request.body.bytes.length).toBe(10)
    expect(res2.exchange.request.body.originalLength).toBe(10)
    expect(res2.exchange.request.body.truncated).toBe(false)
  })

  it('evicts oldest exchanges when maxExchanges limit is exceeded', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 100,
        maxTotalBodyBytes: 1000,
        maxExchanges: 2,
        maxHeadersPerMessage: 10,
      },
    })

    const e1 = store.add(makeExchange({ flowId: 'flow-1' }))
    store.add(makeExchange({ flowId: 'flow-2' }))
    expect(store.size).toBe(2)

    const e3 = store.add(makeExchange({ flowId: 'flow-3' }))
    expect(store.size).toBe(2)
    expect(e3.evicted.length).toBe(1)
    expect(e3.evicted[0]?.id).toBe(e1.exchange.id)
    expect(store.get(e1.exchange.id)).toBeUndefined()
    expect(store.evictionCount).toBe(1)
  })

  it('releases oldest bodies when maxTotalBodyBytes limit is exceeded', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 100,
        maxTotalBodyBytes: 30,
        maxExchanges: 10,
        maxHeadersPerMessage: 10,
      },
    })

    const e1 = store.add(makeExchange({
      request: { method: 'GET', url: 'https://e.com/1', headers: [], body: encoder.encode('1234567890'), startedAt: 1 },
      response: { status: 200, statusText: 'OK', headers: [], body: encoder.encode('1234567890'), startedAt: 2, finishedAt: 3 },
    })) // 20 bytes total

    expect(e1.exchange.bodiesEvicted).toBe(false)
    expect(store.totalBodyBytes).toBe(20)

    const e2 = store.add(makeExchange({
      request: { method: 'GET', url: 'https://e.com/2', headers: [], body: encoder.encode('1234567890'), startedAt: 4 },
      response: { status: 200, statusText: 'OK', headers: [], body: encoder.encode('1234567890'), startedAt: 5, finishedAt: 6 },
    })) // Another 20 bytes -> total would be 40 > 30 -> e1 bodies released

    expect(store.totalBodyBytes).toBeLessThanOrEqual(30)
    const e1Stored = store.get(e1.exchange.id)
    expect(e1Stored?.bodiesEvicted).toBe(true)
    expect(e1Stored?.request.body.bytes.length).toBe(0)
    expect(e1Stored?.request.body.truncated).toBe(true)
    expect(e2.exchange.bodiesEvicted).toBe(false)
  })

  it('truncates headers when maxHeadersPerMessage limit is exceeded', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 100,
        maxTotalBodyBytes: 1000,
        maxExchanges: 10,
        maxHeadersPerMessage: 2,
      },
    })

    const res = store.add(makeExchange({
      request: {
        method: 'GET',
        url: 'https://example.com',
        headers: [
          { name: 'H1', value: 'V1' },
          { name: 'H2', value: 'V2' },
          { name: 'H3', value: 'V3' },
        ],
        body: new Uint8Array(),
        startedAt: 1,
      },
    }))

    expect(res.exchange.request.headers.length).toBe(2)
    expect(res.exchange.request.headersTruncated).toBe(true)
  })

  it('classifies bodies as json, text, or binary', () => {
    const jsonBody: CaptureBody = {
      bytes: encoder.encode('{"key":"value"}'),
      originalLength: 15,
      truncated: false,
    }
    const textBody: CaptureBody = {
      bytes: encoder.encode('Hello World, this is plain text'),
      originalLength: 31,
      truncated: false,
    }
    const binaryBody: CaptureBody = {
      bytes: new Uint8Array([0x00, 0xFF, 0x12, 0x89, 0x01]),
      originalLength: 5,
      truncated: false,
    }

    expect(classifyCaptureBody(jsonBody)).toBe('json')
    expect(classifyCaptureBody(textBody)).toBe('text')
    expect(classifyCaptureBody(binaryBody)).toBe('binary')
  })

  it('safely parses JSON bodies and handles invalid JSON gracefully', () => {
    const valid: CaptureBody = {
      bytes: encoder.encode('{"count":42}'),
      originalLength: 12,
      truncated: false,
    }
    const invalid: CaptureBody = {
      bytes: encoder.encode('{not-valid-json}'),
      originalLength: 16,
      truncated: false,
    }

    const resValid = parseCaptureJson(valid)
    expect(resValid.ok).toBe(true)
    expect(resValid.value).toEqual({ count: 42 })

    const resInvalid = parseCaptureJson(invalid)
    expect(resInvalid.ok).toBe(false)
    expect(resInvalid.error).toBeDefined()
    expect(resInvalid.value).toBeUndefined()
  })

  it('extracts query parameters correctly', () => {
    const params = extractCaptureQuery('https://example.com/path?search=term&flag=&page=2')
    expect(params).toEqual([
      { name: 'search', value: 'term' },
      { name: 'flag', value: '' },
      { name: 'page', value: '2' },
    ])

    expect(extractCaptureQuery('https://example.com/no-query')).toEqual([])
  })

  it('groups exchanges by host and detects duplicate requests in window', () => {
    const store = new CaptureStore({
      limits: {
        maxBodyBytesPerMessage: 100,
        maxTotalBodyBytes: 1000,
        maxExchanges: 10,
        maxHeadersPerMessage: 10,
      },
    })

    const e1 = store.add(makeExchange({
      request: { method: 'POST', url: 'https://api.github.com/v1', headers: [], body: encoder.encode('data'), startedAt: 100 },
      response: { status: 200, statusText: 'OK', headers: [], body: encoder.encode('res1'), startedAt: 110, finishedAt: 120 },
    }))

    const e2 = store.add(makeExchange({
      request: { method: 'POST', url: 'https://api.github.com/v1', headers: [], body: encoder.encode('data'), startedAt: 200 },
      response: { status: 200, statusText: 'OK', headers: [], body: encoder.encode('res2'), startedAt: 210, finishedAt: 220 },
    }))

    store.add(makeExchange({
      request: { method: 'GET', url: 'https://google.com/search', headers: [], body: encoder.encode(''), startedAt: 300 },
      response: { status: 200, statusText: 'OK', headers: [], body: encoder.encode('res3'), startedAt: 310, finishedAt: 320 },
    }))

    const hostGroups = groupCaptureByHost(store.list())
    expect(hostGroups.length).toBe(2)
    const gh = hostGroups.find(h => h.host === 'api.github.com')
    expect(gh?.exchanges).toBe(2)
    const g = hostGroups.find(h => h.host === 'google.com')
    expect(g?.exchanges).toBe(1)

    // Duplicate detection
    const duplicates = findDuplicateCaptureRequests(store.list(), {
      windowMs: 500,
      now: () => 400,
    })
    expect(duplicates.length).toBe(1)
    expect(duplicates[0]?.ids).toEqual([e1.exchange.id, e2.exchange.id])

    // Timeline building
    const timeline = buildCaptureTimeline(store.list())
    expect(timeline.length).toBe(3)
    expect(timeline[0]?.id).toBe(e1.exchange.id)
    expect(timeline[0]?.durationMs).toBe(20)
  })
})
