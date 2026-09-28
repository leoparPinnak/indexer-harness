/**
 * @deepseek-ai/dsh-cdp — the network capture model. `CaptureStore` retains the
 * request/response exchanges the proxy observed, applying the redaction policy
 * and every configured bound at capture time, so no raw credential value ever
 * reaches stored state. The module reads and returns plain data only — no
 * socket, no timer, no file — and takes its clock and ceilings as parameters,
 * so one input always yields one output.
 * @module @deepseek-ai/dsh-cdp/net/capture
 */

import { createHash } from 'node:crypto'

/** One ordered HTTP header field. */
export interface CaptureHeader {
  /** Header name as received; redaction matching is case-insensitive. */
  readonly name: string
  /** Header value; `CAPTURE_REDACTED_MARKER` when a redaction rule matched the name. */
  readonly value: string
}

/** One message body held as bytes, with its original byte count kept so truncation stays observable. */
export interface CaptureBody {
  /** Stored bytes, a strict prefix of the original whenever `truncated`. */
  readonly bytes: Uint8Array
  /** Complete body byte count before any bound applied. */
  readonly originalLength: number
  /** True when `bytes` is shorter than `originalLength`. */
  readonly truncated: boolean
}

/** Kind `classifyCaptureBody` reports for the inspected prefix of a body. */
export type CaptureBodyKind = 'json' | 'text' | 'binary'

/** Fields shared by a captured request and a captured response. */
export interface CapturedMessage {
  /** Retained headers in wire order, at most the configured header-count bound. */
  readonly headers: readonly CaptureHeader[]
  /** Retained body bytes with the original length. */
  readonly body: CaptureBody
  /** True when the header-count bound dropped trailing headers. */
  readonly headersTruncated: boolean
  /** Epoch milliseconds the message started, as the caller supplied it. */
  readonly startedAt: number
  /** Epoch milliseconds the message finished, as the caller supplied it. */
  readonly finishedAt: number
}

/** One captured request. */
export interface CapturedRequest extends CapturedMessage {
  /** HTTP method. */
  readonly method: string
  /** Request URL with every configured sensitive query value replaced by the redaction marker. */
  readonly url: string
  /** HTTP version the request arrived with, for example `HTTP/1.1`. */
  readonly httpVersion: string
}

/** One captured response. */
export interface CapturedResponse extends CapturedMessage {
  /** HTTP status code. */
  readonly status: number
  /** HTTP reason phrase; empty when the protocol carried none. */
  readonly statusText: string
  /** Response media type as reported; empty when unknown. */
  readonly mimeType: string
}

/** One request as the capture point observed it, before redaction and bounds. */
export interface CaptureRequestInput {
  /** HTTP method. */
  readonly method: string
  /** Full request URL, including any sensitive query value. */
  readonly url: string
  /** HTTP version. */
  readonly httpVersion: string
  /** Headers in wire order. */
  readonly headers: readonly CaptureHeader[]
  /** Complete request body bytes. */
  readonly body: Uint8Array
  /** Epoch milliseconds the request started. */
  readonly startedAt: number
  /** Epoch milliseconds the request finished. */
  readonly finishedAt: number
}

/** One response as the capture point observed it, before redaction and bounds. */
export interface CaptureResponseInput {
  /** HTTP status code. */
  readonly status: number
  /** HTTP reason phrase; empty when the protocol carried none. */
  readonly statusText: string
  /** Headers in wire order. */
  readonly headers: readonly CaptureHeader[]
  /** Complete response body bytes. */
  readonly body: Uint8Array
  /** Response media type. */
  readonly mimeType: string
  /** Epoch milliseconds the response started. */
  readonly startedAt: number
  /** Epoch milliseconds the response finished. */
  readonly finishedAt: number
}

/** One complete request/response pair offered to `CaptureStore.add`. */
export interface CaptureExchangeInput {
  /** Identifier of the proxy flow that carried the exchange. */
  readonly flowId: string
  /** The request half. */
  readonly request: CaptureRequestInput
  /** The response half. */
  readonly response: CaptureResponseInput
}

/** Ceilings `CaptureStore` enforces on every retained exchange. Every field is a non-negative integer. */
export interface CaptureLimits {
  /** Maximum body bytes retained from each message; each body is cut to this many bytes. */
  readonly maxBodyBytesPerMessage: number
  /** Maximum total body bytes retained across all retained exchanges. */
  readonly maxTotalBodyBytes: number
  /** Maximum exchanges retained; the oldest exchange is evicted first once the count is exceeded. */
  readonly maxExchanges: number
  /** Maximum headers retained per message; trailing headers beyond it are dropped. */
  readonly maxHeadersPerMessage: number
}

/**
 * Names whose values are replaced at capture time. Both lists are matched
 * case-insensitively; a header outside `headerNames` is still redacted when it
 * matches the vendor-key pattern documented on `isRedactedHeaderName`.
 */
export interface CaptureRedactionPolicy {
  /** Header names to redact. */
  readonly headerNames: readonly string[]
  /** Query parameter names to redact. */
  readonly queryParameters: readonly string[]
}

/** Construction options of a `CaptureStore`. */
export interface CaptureStoreOptions {
  /** Ceilings applied to every stored exchange. Every field is validated at construction. */
  readonly limits: CaptureLimits
  /** Redaction policy; omitted uses `DEFAULT_CAPTURE_REDACTION`. */
  readonly redaction?: CaptureRedactionPolicy
}

/** One retained request/response pair. */
export interface CapturedExchange {
  /** Store-assigned identifier, unique for the store's lifetime. */
  readonly id: string
  /** Identifier of the proxy flow the exchange arrived on. */
  readonly flowId: string
  /** The captured request, already redacted and bounded. */
  readonly request: CapturedRequest
  /** The captured response, already redacted and bounded. */
  readonly response: CapturedResponse
  /** True when a redaction rule replaced at least one header or query value. */
  readonly redacted: boolean
  /** True when any bound shortened a body or dropped a header. */
  readonly truncated: boolean
  /** True when the total-byte bound released this exchange's stored bodies. */
  readonly bodiesEvicted: boolean
  /** True when the exchange-count bound removed this exchange; observable when `add` returned it. */
  readonly evicted: boolean
}

/** Outcome of one `CaptureStore.add`. */
export interface CaptureAddResult {
  /** The stored exchange, with every bound and redaction applied. */
  readonly exchange: CapturedExchange
  /** Exchanges this addition evicted, oldest first; each still carries `evicted: true` and released bodies. */
  readonly evicted: readonly CapturedExchange[]
}

/** Result of parsing a JSON body; an invalid document is reported, never thrown. */
export interface CaptureJsonParse {
  /** True when the inspected prefix parsed as JSON. */
  readonly ok: boolean
  /** Parsed JSON value when `ok`; absent otherwise. */
  readonly value?: unknown
  /** Parse failure message when not `ok`; absent otherwise. */
  readonly error?: string
  /** True when only the first `maxBytes` bytes were inspected because the body was longer. */
  readonly truncated: boolean
}

/** One decoded query parameter. */
export interface CaptureQueryParameter {
  /** Decoded parameter name. */
  readonly name: string
  /** Decoded parameter value; `CAPTURE_REDACTED_MARKER` when the name matched the policy. */
  readonly value: string
}

/** Request count and retained body bytes for one host. */
export interface CaptureHostGroup {
  /** Host and port the request URLs named; empty when a URL carried no authority. */
  readonly host: string
  /** Retained exchanges whose request targeted this host. */
  readonly exchanges: number
  /** Retained request body bytes across those exchanges. */
  readonly requestBodyBytes: number
  /** Retained response body bytes across those exchanges. */
  readonly responseBodyBytes: number
  /** `requestBodyBytes` plus `responseBodyBytes`. */
  readonly totalBodyBytes: number
}

/** Retained exchanges repeating one method, URL, and request body digest inside the window. */
export interface CaptureDuplicateGroup {
  /** Digest of the repeated method, URL, original body length, and retained request body bytes. */
  readonly digest: string
  /** Identifiers of the duplicates, earliest request start first. */
  readonly ids: readonly string[]
}

/** Options of `findDuplicateCaptureRequests`. */
export interface CaptureDuplicateOptions {
  /** Window length in milliseconds ending at `now()`. */
  readonly windowMs: number
  /** Injected clock returning epoch milliseconds; the detector never reads a real clock. */
  readonly now: () => number
}

/** One exchange's position and duration on the capture timeline. */
export interface CaptureTimelineEntry {
  /** Identifier of the exchange. */
  readonly id: string
  /** Flow the exchange arrived on. */
  readonly flowId: string
  /** Request method. */
  readonly method: string
  /** Redacted request URL. */
  readonly url: string
  /** Response status code. */
  readonly status: number
  /** Epoch milliseconds the request started. */
  readonly startedAt: number
  /** Milliseconds from the request start to the response finish. */
  readonly durationMs: number
}

/** Marker written into redacted header values and query parameter values when a custom redaction policy is active. */
export const CAPTURE_REDACTED_MARKER = '[redacted]'

/**
 * Header names redacted by the default policy. Alongside these exact names,
 * `isRedactedHeaderName` also redacts any `x-<segment>-key`, `x-<segment>-token`,
 * or `x-<segment>-secret` header, which is how vendor API-key headers arrive.
 */
export const DEFAULT_REDACTED_HEADER_NAMES: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
]

/**
 * Default redaction policy: empty — no headers or query parameters are redacted
 * by default. A caller that needs redaction configures it explicitly through
 * `CaptureStoreOptions.redaction`.
 */
export const DEFAULT_CAPTURE_REDACTION: CaptureRedactionPolicy = {
  headerNames: [],
  queryParameters: [],
}

/** Mutable body retention state the store keeps per exchange. */
interface StoreEntry {
  readonly id: string
  readonly flowId: string
  request: CapturedRequest
  response: CapturedResponse
  readonly redacted: boolean
  bodiesEvicted: boolean
  evicted: boolean
}

/** Mutable aggregation state `groupCaptureByHost` folds before it returns immutable groups. */
interface HostAggregate {
  readonly host: string
  exchanges: number
  requestBodyBytes: number
  responseBodyBytes: number
}

/**
 * Whether one header name is sensitive under the policy: an exact
 * case-insensitive member of `headerNames`, or a vendor API-key pattern
 * `x-<segment>-key`, `x-<segment>-token`, or `x-<segment>-secret`. The pattern
 * is fixed rather than configurable because it is a security default, and it
 * never matches a name ending in `-key` without a separator before `key`.
 * @param name - header name as received.
 * @param policy - the policy whose explicit names are checked.
 * @returns true when the header's value must be replaced.
 */
function isRedactedHeaderName(name: string, policy: CaptureRedactionPolicy): boolean {
  const lower = name.toLowerCase()
  for (const candidate of policy.headerNames) {
    if (candidate.toLowerCase() === lower) return true
  }
  return /^x-(?:[a-z0-9_.]+-)*(?:key|token|secret)$/u.test(lower)
}

/**
 * Whether one query parameter name is sensitive under the policy, compared
 * case-insensitively.
 * @param name - decoded parameter name.
 * @param policy - the policy whose query names are checked.
 * @returns true when the parameter's value must be replaced.
 */
function isRedactedQueryName(name: string, policy: CaptureRedactionPolicy): boolean {
  const lower = name.toLowerCase()
  for (const candidate of policy.queryParameters) {
    if (candidate.toLowerCase() === lower) return true
  }
  return false
}

/**
 * Percent-decode one query component, treating `+` as a space and falling back
 * to the raw text when the encoding is malformed.
 * @param value - raw component text.
 * @returns the decoded component.
 */
function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    // Malformed percent-encoding stays raw; the parameter is still reported and matchable by its literal name.
    return value
  }
}

/**
 * Validate one ceiling so a negative or fractional limit fails at construction
 * instead of silently changing a bound.
 * @param name - field name named in the failure.
 * @param value - value to validate.
 * @throws Error when the value is not a non-negative integer.
 */
function requireCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`cdp capture: ${name} must be a non-negative integer, received ${String(value)}`)
  }
}

/**
 * Store one message body under the per-message byte bound, copying the retained
 * bytes so later caller mutation cannot change stored state.
 * @param bytes - complete body bytes.
 * @param maxBytes - maximum bytes to retain.
 * @returns the stored body, flagged when the bound cut it.
 */
function storeBody(bytes: Uint8Array, maxBytes: number): CaptureBody {
  if (bytes.byteLength <= maxBytes) {
    return { bytes: bytes.slice(), originalLength: bytes.byteLength, truncated: false }
  }
  return { bytes: bytes.slice(0, maxBytes), originalLength: bytes.byteLength, truncated: true }
}

/**
 * Release one body's stored bytes while preserving its original length, so an
 * exchange evicted for byte pressure still reports the complete body size.
 * @param body - body whose bytes are released.
 * @returns the body with no stored bytes and `truncated` reporting whether any byte existed.
 */
function releaseBody(body: CaptureBody): CaptureBody {
  return { bytes: new Uint8Array(0), originalLength: body.originalLength, truncated: body.originalLength > 0 }
}

/**
 * Retain a message's headers under the header-count bound, replacing every
 * sensitive value with the redaction marker.
 * @param headers - headers in wire order.
 * @param maxHeaders - maximum headers to retain.
 * @param policy - redaction policy.
 * @returns retained headers, whether the bound dropped any, and whether any value was replaced.
 */
function storeHeaders(
  headers: readonly CaptureHeader[],
  maxHeaders: number,
  policy: CaptureRedactionPolicy,
): { headers: CaptureHeader[]; headersTruncated: boolean; redacted: boolean } {
  let redacted = false
  const retained = headers.slice(0, maxHeaders).map((header): CaptureHeader => {
    if (!isRedactedHeaderName(header.name, policy)) return { name: header.name, value: header.value }
    redacted = true
    return { name: header.name, value: CAPTURE_REDACTED_MARKER }
  })
  return { headers: retained, headersTruncated: headers.length > maxHeaders, redacted }
}

/**
 * Replace the value of every configured sensitive query parameter, preserving
 * parameter order and every byte of the URL outside the replaced values.
 * @param url - request URL as received.
 * @param policy - redaction policy whose query names are matched.
 * @returns the redacted URL and whether any value was replaced.
 */
function redactQuery(url: string, policy: CaptureRedactionPolicy): { url: string; redacted: boolean } {
  const hashIndex = url.indexOf('#')
  const searchIndex = url.indexOf('?')
  if (searchIndex === -1 || (hashIndex !== -1 && searchIndex > hashIndex)) {
    return { url, redacted: false }
  }
  const end = hashIndex === -1 ? url.length : hashIndex
  let redacted = false
  const pairs = url.slice(searchIndex + 1, end).split('&').map((pair): string => {
    const equals = pair.indexOf('=')
    const rawName = equals === -1 ? pair : pair.slice(0, equals)
    if (!isRedactedQueryName(decodeQueryComponent(rawName), policy)) return pair
    redacted = true
    return `${rawName}=${CAPTURE_REDACTED_MARKER}`
  })
  return { url: `${url.slice(0, searchIndex)}?${pairs.join('&')}${url.slice(end)}`, redacted }
}

/**
 * Build one stored request from its observed form.
 * @param input - the observed request.
 * @param limits - ceilings to apply.
 * @param policy - redaction policy to apply.
 * @returns the stored request and whether any header or query value was replaced.
 */
function buildRequest(
  input: CaptureRequestInput,
  limits: CaptureLimits,
  policy: CaptureRedactionPolicy,
): { request: CapturedRequest; redacted: boolean } {
  const headers = storeHeaders(input.headers, limits.maxHeadersPerMessage, policy)
  const query = redactQuery(input.url, policy)
  return {
    request: {
      method: input.method,
      url: query.url,
      httpVersion: input.httpVersion,
      headers: headers.headers,
      body: storeBody(input.body, limits.maxBodyBytesPerMessage),
      headersTruncated: headers.headersTruncated,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
    redacted: headers.redacted || query.redacted,
  }
}

/**
 * Build one stored response from its observed form.
 * @param input - the observed response.
 * @param limits - ceilings to apply.
 * @param policy - redaction policy to apply.
 * @returns the stored response and whether any header value was replaced.
 */
function buildResponse(
  input: CaptureResponseInput,
  limits: CaptureLimits,
  policy: CaptureRedactionPolicy,
): { response: CapturedResponse; redacted: boolean } {
  const headers = storeHeaders(input.headers, limits.maxHeadersPerMessage, policy)
  return {
    response: {
      status: input.status,
      statusText: input.statusText,
      headers: headers.headers,
      body: storeBody(input.body, limits.maxBodyBytesPerMessage),
      mimeType: input.mimeType,
      headersTruncated: headers.headersTruncated,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
    redacted: headers.redacted,
  }
}

/** Immutable view of one store entry, built on every read so no caller holds stale flags. */
function toExchange(entry: StoreEntry): CapturedExchange {
  return {
    id: entry.id,
    flowId: entry.flowId,
    request: entry.request,
    response: entry.response,
    redacted: entry.redacted,
    truncated: entry.request.body.truncated || entry.response.body.truncated
      || entry.request.headersTruncated || entry.response.headersTruncated,
    bodiesEvicted: entry.bodiesEvicted,
    evicted: entry.evicted,
  }
}

/** Body bytes one entry still holds. */
function storedBytes(entry: StoreEntry): number {
  return entry.request.body.bytes.byteLength + entry.response.body.bytes.byteLength
}

/**
 * Whether one URL names a host; a URL without an authority reports the empty
 * host instead of failing the aggregation.
 * @param url - request URL.
 * @returns the host and port, or `''` for a non-absolute URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // A non-absolute URL carries no authority; its exchanges group under the empty host.
    return ''
  }
}

/**
 * Digest of one request's method, redacted URL, original body length, and
 * retained body bytes. Two requests rightly detected as duplicates digest
 * identically; a request whose stored body was truncated differs from an
 * untruncated one only when the retained prefix and length differ.
 * @param request - the captured request.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
function requestDigest(request: CapturedRequest): string {
  const hash = createHash('sha256')
  hash.update(request.method)
  hash.update('\n')
  hash.update(request.url)
  hash.update('\n')
  hash.update(String(request.body.originalLength))
  hash.update('\n')
  hash.update(request.body.bytes)
  return hash.digest('hex')
}

/**
 * Bounded store of captured HTTP exchanges.
 *
 * The bounds and their documented consequences:
 *
 * - `maxBodyBytesPerMessage` cuts each request body and each response body to
 *   that many bytes; the cut body keeps its original byte length and reports
 *   `truncated`.
 * - `maxHeadersPerMessage` keeps the first headers in wire order and reports
 *   `headersTruncated` when it dropped any.
 * - `maxTotalBodyBytes` is enforced after each addition by releasing the stored
 *   bodies of the oldest exchange that still holds bytes, oldest first, until
 *   the total fits. The exchange stays retrievable and reports
 *   `bodiesEvicted`; its bodies report `truncated` with their original lengths
 *   preserved. When one exchange alone exceeds the total budget, its own bodies
 *   are released the same way.
 * - `maxExchanges` is enforced after the byte bound by removing the oldest
 *   retained exchange, oldest first. A removed exchange is returned from the
 *   `add` call that evicted it with `evicted: true` and its bodies released;
 *   `get` no longer finds it.
 *
 * Redaction happens while an exchange is built, before any bytes or headers are
 * retained, so no raw credential value is ever stored.
 */
export class CaptureStore {
  private readonly limits: CaptureLimits
  private readonly redaction: CaptureRedactionPolicy
  private readonly retained = new Map<string, StoreEntry>()
  private totalBytes = 0
  private nextId = 1
  private evictions = 0

  /**
   * @param options - the ceilings and optional redaction policy; every ceiling is validated here.
   * @throws Error when a ceiling is not a non-negative integer.
   */
  constructor(options: CaptureStoreOptions) {
    const { limits } = options
    requireCount('maxBodyBytesPerMessage', limits.maxBodyBytesPerMessage)
    requireCount('maxTotalBodyBytes', limits.maxTotalBodyBytes)
    requireCount('maxExchanges', limits.maxExchanges)
    requireCount('maxHeadersPerMessage', limits.maxHeadersPerMessage)
    this.limits = limits
    this.redaction = options.redaction ?? DEFAULT_CAPTURE_REDACTION
  }

  /**
   * Add one exchange, applying redaction and every bound. The body, header,
   * total-byte, and exchange-count bounds take effect before this call returns,
   * and every eviction it caused is reported on the result.
   * @param input - the request/response pair as the capture point observed it.
   * @returns the stored exchange and every exchange this addition evicted, oldest first.
   */
  add(input: CaptureExchangeInput): CaptureAddResult {
    const request = buildRequest(input.request, this.limits, this.redaction)
    const response = buildResponse(input.response, this.limits, this.redaction)
    const entry: StoreEntry = {
      id: `capture-${String(this.nextId)}`,
      flowId: input.flowId,
      request: request.request,
      response: response.response,
      redacted: request.redacted || response.redacted,
      bodiesEvicted: false,
      evicted: false,
    }
    this.nextId += 1
    this.retained.set(entry.id, entry)
    this.totalBytes += storedBytes(entry)

    this.releaseBodiesForTotal()

    const evicted: CapturedExchange[] = []
    while (this.retained.size > this.limits.maxExchanges) {
      let oldest: StoreEntry | undefined
      for (const candidate of this.retained.values()) {
        oldest = candidate
        break
      }
      if (oldest === undefined) break
      this.retained.delete(oldest.id)
      this.totalBytes -= storedBytes(oldest)
      oldest.evicted = true
      this.evictions += 1
      evicted.push(toExchange(oldest))
    }
    return { exchange: toExchange(entry), evicted }
  }

  /**
   * Read one retained exchange.
   * @param id - identifier returned by `add`.
   * @returns the exchange, or undefined when no retained exchange has that id.
   */
  get(id: string): CapturedExchange | undefined {
    const entry = this.retained.get(id)
    return entry === undefined ? undefined : toExchange(entry)
  }

  /**
   * List retained exchanges in arrival order.
   * @returns every retained exchange, oldest first.
   */
  list(): readonly CapturedExchange[] {
    return [...this.retained.values()].map(toExchange)
  }

  /** Number of retained exchanges. */
  get size(): number {
    return this.retained.size
  }

  /** Total body bytes retained across all retained exchanges. */
  get totalBodyBytes(): number {
    return this.totalBytes
  }

  /** Number of exchanges the exchange-count bound evicted since construction. */
  get evictionCount(): number {
    return this.evictions
  }

  /**
   * Release whole exchanges' stored bodies, oldest first, until the total-byte
   * bound holds. Stops when no retained exchange holds bytes, so a total budget
   * below one exchange's stored bytes leaves the oldest bodies released and
   * every flag observably set rather than looping.
   */
  private releaseBodiesForTotal(): void {
    while (this.totalBytes > this.limits.maxTotalBodyBytes) {
      let released = false
      for (const entry of this.retained.values()) {
        const prior = storedBytes(entry)
        if (prior === 0) continue
        entry.request = { ...entry.request, body: releaseBody(entry.request.body) }
        entry.response = { ...entry.response, body: releaseBody(entry.response.body) }
        this.totalBytes -= prior
        entry.bodiesEvicted = true
        released = true
        break
      }
      if (!released) break
    }
  }
}

/**
 * Classify a body's kind from its stored bytes.
 * @param body - body to inspect.
 * @returns 'json', 'text', or 'binary'.
 */
export function classifyCaptureBody(body: CaptureBody): CaptureBodyKind {
  if (body.bytes.length === 0) return 'text'
  for (const byte of body.bytes) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return 'binary'
    }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes)
  } catch {
    return 'binary'
  }
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // Valid UTF-8 text that is not valid JSON falls through to text.
    }
  }
  return 'text'
}

/**
 * Safely parse a body as JSON with an optional byte ceiling.
 * @param body - body to parse.
 * @param maxBytes - maximum bytes to inspect before parsing.
 * @returns parse result carrying the parsed value or an error message.
 */
export function parseCaptureJson(body: CaptureBody, maxBytes?: number): CaptureJsonParse {
  const truncated = maxBytes !== undefined && body.bytes.length > maxBytes
  const bytes = truncated ? body.bytes.subarray(0, maxBytes) : body.bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    return { ok: true, value, truncated }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      truncated,
    }
  }
}

/**
 * Extract and decode query parameters from a URL.
 * @param url - URL containing query string.
 * @returns decoded query parameters in occurrence order.
 */
export function extractCaptureQuery(url: string): readonly CaptureQueryParameter[] {
  const searchIndex = url.indexOf('?')
  if (searchIndex === -1) return []
  const hashIndex = url.indexOf('#')
  const end = hashIndex === -1 || hashIndex < searchIndex ? url.length : hashIndex
  const queryString = url.slice(searchIndex + 1, end)
  if (queryString.length === 0) return []
  const result: CaptureQueryParameter[] = []
  for (const pair of queryString.split('&')) {
    if (pair.length === 0) continue
    const equals = pair.indexOf('=')
    if (equals === -1) {
      result.push({ name: decodeQueryComponent(pair), value: '' })
    } else {
      result.push({
        name: decodeQueryComponent(pair.slice(0, equals)),
        value: decodeQueryComponent(pair.slice(equals + 1)),
      })
    }
  }
  return result
}

/**
 * Group retained exchanges by host, summarizing counts and byte sizes.
 * @param exchanges - exchanges to group.
 * @returns groups aggregated by host.
 */
export function groupCaptureByHost(exchanges: readonly CapturedExchange[]): readonly CaptureHostGroup[] {
  const map = new Map<string, HostAggregate>()
  for (const exchange of exchanges) {
    const host = hostOf(exchange.request.url)
    let aggregate = map.get(host)
    if (aggregate === undefined) {
      aggregate = { host, exchanges: 0, requestBodyBytes: 0, responseBodyBytes: 0 }
      map.set(host, aggregate)
    }
    aggregate.exchanges += 1
    aggregate.requestBodyBytes += exchange.request.body.bytes.length
    aggregate.responseBodyBytes += exchange.response.body.bytes.length
  }
  return [...map.values()].map(agg => ({
    host: agg.host,
    exchanges: agg.exchanges,
    requestBodyBytes: agg.requestBodyBytes,
    responseBodyBytes: agg.responseBodyBytes,
    totalBodyBytes: agg.requestBodyBytes + agg.responseBodyBytes,
  }))
}

/**
 * Detect requests repeating a method, URL, and body digest within a time window.
 * @param exchanges - exchanges to inspect.
 * @param options - window length and clock.
 * @returns duplicate groups containing two or more exchanges.
 */
export function findDuplicateCaptureRequests(
  exchanges: readonly CapturedExchange[],
  options: CaptureDuplicateOptions,
): readonly CaptureDuplicateGroup[] {
  const currentTime = options.now()
  const cutoff = currentTime - options.windowMs
  const groups = new Map<string, { digest: string; ids: string[]; earliest: number }>()

  for (const exchange of exchanges) {
    if (exchange.request.startedAt < cutoff || exchange.request.startedAt > currentTime) continue
    const digest = requestDigest(exchange.request)
    let group = groups.get(digest)
    if (group === undefined) {
      group = { digest, ids: [], earliest: exchange.request.startedAt }
      groups.set(digest, group)
    }
    group.ids.push(exchange.id)
    if (exchange.request.startedAt < group.earliest) {
      group.earliest = exchange.request.startedAt
    }
  }

  const duplicates: CaptureDuplicateGroup[] = []
  for (const group of groups.values()) {
    if (group.ids.length > 1) {
      duplicates.push({ digest: group.digest, ids: group.ids })
    }
  }
  return duplicates
}

/**
 * Build a timeline of captured exchanges ordered by start time.
 * @param exchanges - exchanges to order.
 * @returns timeline entries with calculated durations.
 */
export function buildCaptureTimeline(exchanges: readonly CapturedExchange[]): readonly CaptureTimelineEntry[] {
  return [...exchanges]
    .sort((a, b) => a.request.startedAt - b.request.startedAt)
    .map(exchange => ({
      id: exchange.id,
      flowId: exchange.flowId,
      method: exchange.request.method,
      url: exchange.request.url,
      status: exchange.response.status,
      startedAt: exchange.request.startedAt,
      durationMs: Math.max(0, exchange.response.finishedAt - exchange.request.startedAt),
    }))
}
