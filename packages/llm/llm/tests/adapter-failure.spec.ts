import { describe, expect, it } from 'vitest'
import { normalizeLlmFailure } from '../src/adapter-failure.ts'

describe('adapter failure normalization', () => {
  it('contains hostile non-Error coercion', () => {
    const thrown = { [Symbol.toPrimitive]: () => { throw new Error('coercion failed') } }
    expect(normalizeLlmFailure(thrown)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('normalizes empty primitive throws and data descriptors without values', () => {
    expect(normalizeLlmFailure('')).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
    expect(normalizeLlmFailure(null)).toEqual({ message: 'null', code: 'UNKNOWN' })

    const error = new Error('provider failed')
    Object.defineProperty(error, 'failure', { get: () => ({ message: 'ignored', code: 'IGNORED' }) })
    Object.defineProperty(error, 'code', { get: () => 'IGNORED' })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorCode = Object.assign(new Error('provider failed'), {
      failure: { message: 'provider failed', code: 'FOREIGN' },
    })
    Object.defineProperty(accessorCode, 'code', { get: () => 'FOREIGN' })
    expect(normalizeLlmFailure(accessorCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const primitiveFailure = Object.assign(new Error('provider failed'), {
      failure: null,
      code: 'FOREIGN',
    })
    expect(normalizeLlmFailure(primitiveFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('contains hostile Error property reflection', () => {
    const withFailure = new Error('provider failed') as Error & { failure: unknown; code: string }
    withFailure.failure = { message: 'provider failed', code: 'FOREIGN' }
    withFailure.code = 'FOREIGN'
    const hostileCode = new Proxy(withFailure, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'code') throw new Error('code descriptor failed')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(normalizeLlmFailure(hostileCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const hostileFailure = new Proxy(new Error('provider failed'), {
      getOwnPropertyDescriptor() { throw new Error('failure descriptor failed') },
    })
    expect(normalizeLlmFailure(hostileFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('rejects malformed or accessor-backed failure snapshots', () => {
    const malformed = new Error('provider failed') as Error & { failure: unknown; code: string }
    malformed.failure = { message: 'provider failed', code: 'FOREIGN', requestId: '' }
    malformed.code = 'FOREIGN'
    expect(normalizeLlmFailure(malformed)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorBacked = new Error('provider failed') as Error & { failure: unknown }
    accessorBacked.failure = Object.defineProperty({}, 'message', {
      get() { throw new Error('failure getter failed') },
    })
    expect(normalizeLlmFailure(accessorBacked)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('falls back when an Error message accessor throws', () => {
    const error = new Error('provider failed')
    Object.defineProperty(error, 'message', { get() { throw new Error('message getter failed') } })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('keeps a non-empty message when the thrown value renders to nothing', () => {
    const nameless = new Error('')
    Object.defineProperty(nameless, 'name', { configurable: true, value: '' })
    expect(normalizeLlmFailure(nameless)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('renders a transport failure through its cause chain', () => {
    // undici reports every transport failure as the bare "fetch failed"; the
    // address, TLS, or reset reason behind it lives only on the cause.
    const transport = new Error('DeepSeek API request to https://api.example failed', {
      cause: new TypeError('fetch failed', { cause: new Error('connect ECONNRESET') }),
    })
    expect(normalizeLlmFailure(transport).message)
      .toBe('DeepSeek API request to https://api.example failed: fetch failed: connect ECONNRESET')
  })

  it('keeps carried provider facts while the message still walks the chain', () => {
    const carried = Object.assign(new Error('request failed', { cause: new Error('ECONNRESET') }), {
      code: 'TRANSPORT',
      failure: { message: 'request failed', code: 'TRANSPORT', requestId: 'req-1' },
    })
    expect(normalizeLlmFailure(carried)).toEqual({
      message: 'request failed: ECONNRESET',
      code: 'TRANSPORT',
      requestId: 'req-1',
    })
  })

  it('leaves an answered provider response out of the message', () => {
    // A provider that answered already had its response summarized into `message`;
    // its status marks that, and the body stays on the cause.
    const answered = Object.assign(new Error('failed with 401', { cause: new Error('{"error":{}}') }), {
      code: 'AUTH',
      failure: { message: 'failed with 401', code: 'AUTH', status: 401 },
    })
    expect(normalizeLlmFailure(answered)).toEqual({ message: 'failed with 401', code: 'AUTH', status: 401 })
  })

  it('does not restate a raw provider payload sitting on the cause', () => {
    // The HTTP path names the failure in `message` and keeps the response body as
    // the cause, so only an Error cause is a chain worth rendering.
    const body = '{"error":{"message":"failed with 401"}}'
    expect(normalizeLlmFailure(new Error('failed with 401', { cause: body })))
      .toEqual({ message: 'failed with 401', code: 'UNKNOWN' })
  })
})
