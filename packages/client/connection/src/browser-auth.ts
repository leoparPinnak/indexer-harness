/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/**
 * Username/password presented by a browser that has no session cookie yet —
 * the prompt replaces the old `?token=` launch URL. The defaults are what a
 * local deployment ships; `DSH_WEB_USER` / `DSH_WEB_PASSWORD` override them
 * for a deployment reachable beyond this machine (a tunnel hostname).
 */
const CREDENTIAL_USER = process.env.DSH_WEB_USER ?? 'dsh'
const CREDENTIAL_PASSWORD = process.env.DSH_WEB_PASSWORD ?? 'dsh'
/** Realm shown by the browser's native username/password prompt. */
const BASIC_REALM = 'dsh web'
const BASIC_CHALLENGE = `Basic realm="${BASIC_REALM}", charset="UTF-8"`
const BASIC_SCHEME_PATTERN = /^Basic\s+(\S+)$/iu

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

/**
 * Validate an `Authorization: Basic …` header against the deployment
 * credentials. Both halves are compared even when the username already failed,
 * so a wrong password costs the same time as a wrong username.
 * @param headers - request headers carrying `authorization`.
 * @returns true only for a well-formed header naming both credentials.
 */
function basicAuthorized(headers: ConnectionTrustRequest['headers']): boolean {
  const raw = header(headers, 'authorization')
  if (raw === undefined) return false
  const match = BASIC_SCHEME_PATTERN.exec(raw.trim())
  if (match?.[1] === undefined) return false
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const at = decoded.indexOf(':')
  if (at === -1) return false
  const userOk = tokenMatches(decoded.slice(0, at), CREDENTIAL_USER)
  const passwordOk = tokenMatches(decoded.slice(at + 1), CREDENTIAL_PASSWORD)
  return userOk && passwordOk
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Username/password exchange and persistent signed-cookie verification.
 *
 * A browser arriving with no cookie is challenged once (the native HTTP Basic
 * prompt); the answered challenge mints the authority-bound cookie that every
 * later request — index, Host API and WebSocket — authenticates with, so an
 * established browser is never prompted again. Connection loads the credential
 * provider's signing secret during activation and retains it for synchronous
 * request authentication.
 */
export class BrowserAuth {
  private readonly maxAgeMilliseconds: number

  private constructor(
    /** Root application context owning this activation (signature kept for callers). */
    _processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
  ) {
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining activation scope.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays)
  }

  /**
   * Resolve the ordinary application root URL: authentication is the browser
   * prompt, so the printed address carries no credential of its own.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns clean root URL.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.href
  }

  /**
   * Authenticate an index request. A valid cookie lets the caller serve the
   * index directly; valid username/password mints the cookie and redirects to
   * clean `/`; every other request receives a 401 carrying the Basic challenge
   * that makes the browser prompt for username and password.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    // 1. Username/password answered: mint the cookie once, then serve.
    if (basicAuthorized(req.headers)) {
      const authority = requestAuthority(req.headers)
      if (authority !== undefined && !this.hasValidCookie(req)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.maxAgeMilliseconds
        const value = encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': sessionCookie(
            cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
          ),
        })
        res.end()
        return false
      }
      return true
    }

    // 2. An established browser keeps its cookie — never prompted again.
    if (this.hasValidCookie(req)) return true

    // 3. A new browser: challenge it so the browser prompts for username/password.
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Verify the authority-bound browser cookie, or valid username/password,
   * on a Host request.
   * @param request - request headers carrying Host, Cookie and Authorization.
   * @returns true only for an unexpired cookie signed by this activation's
   *   loaded secret, or a header naming both deployment credentials.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    if (basicAuthorized(request.headers)) return true
    return this.hasValidCookie(request)
  }

  /** Verify only the persistent authority-bound cookie (never credentials). */
  private hasValidCookie(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': BASIC_CHALLENGE,
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web username/password required; enter dsh / dsh in the browser prompt.\n')
  }
}
