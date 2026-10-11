/**
 * Wire protocol for the CodexNative computer-use helper: newline-delimited
 * JSON over stdio, mirroring Codex's `helper_transport.js` framing.
 *
 * Request:  `{ id, method, params, meta }` - `meta` always carries the
 *           request budget key (`x-oai-cua-request-budget-ms`) with the
 *           caller's timeout, exactly like the Codex transport.
 * Response: `{ id, ok: true, result }` | `{ id, error }`
 *           | `{ id, approvalRequest: { app, displayName, riskLevel } }`.
 */

/** Budget key the transport stamps into every request's `meta`. */
export const REQUEST_BUDGET_META_KEY = 'x-oai-cua-request-budget-ms'

/** Meta key that marks a launch as user-approved on a retry. */
export const APPROVED_APP_META_KEY = 'x-oai-cua-approved-app'

/** Codex gives `launch_app` 15s; every other method gets 10s. */
export const LAUNCH_APP_TIMEOUT_MS = 15_000
/** Budget for every method other than `launch_app`, mirroring Codex's transport. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/**
 * Per-method request timeout, mirroring the Codex transport defaults.
 * @param method - helper method name; `launch_app` gets the longer budget.
 * @param timeoutMs - explicit override that wins when present.
 * @returns the budget in milliseconds.
 */
export function requestTimeoutFor(method: string, timeoutMs?: number): number {
  if (timeoutMs !== undefined) return timeoutMs
  return method === 'launch_app' ? LAUNCH_APP_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS
}

/** Free-form `meta` bag the transport merges into each request under the budget key. */
export type CuaRequestMeta = Record<string, unknown>

/**
 * Serialize one request as a single NDJSON line (terminating newline included).
 * @param id - request id the response echoes back.
 * @param method - helper method name.
 * @param params - method params serialized as-is.
 * @param meta - extra meta merged with the request-budget stamp.
 * @param timeoutMs - budget stamped as the request-budget value; defaults per method.
 * @returns one NDJSON line including its terminating newline.
 */
export function encodeRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  meta: CuaRequestMeta = {},
  timeoutMs?: number,
): string {
  const withBudget: CuaRequestMeta = {
    ...meta,
    [REQUEST_BUDGET_META_KEY]: requestTimeoutFor(method, timeoutMs),
  }
  return `${JSON.stringify({ id, method, params, meta: withBudget })}\n`
}

/** A user-approval pause emitted by the helper instead of a result. */
export interface CuaApprovalRequest {
  readonly app: string
  readonly displayName: string
  readonly riskLevel?: 'high' | 'low'
}

/** One helper line after {@link decodeLine}: result, error, approval, invalid, or ignored. */
export type DecodedLine =
  | { readonly kind: 'result'; readonly id: number; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: number; readonly error: string }
  | { readonly kind: 'approval'; readonly id: number; readonly approval: CuaApprovalRequest }
  | { readonly kind: 'invalid'; readonly line: string; readonly cause: string }
  | { readonly kind: 'ignored'; readonly line: string; readonly reason: 'no-id' | 'unknown-shape' }

function approvalFrom(value: unknown): CuaApprovalRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const app = typeof candidate['app'] === 'string' && candidate['app'].trim() !== '' ? candidate['app'].trim() : null
  if (app === null) return null
  const displayNameRaw = candidate['displayName']
  const displayName = typeof displayNameRaw === 'string' && displayNameRaw.trim() !== '' ? displayNameRaw.trim() : app
  const riskRaw = candidate['riskLevel']
  const riskLevel = riskRaw === 'high' || riskRaw === 'low' ? riskRaw : undefined
  return riskLevel === undefined ? { app, displayName } : { app, displayName, riskLevel }
}

/**
 * Parse one response line into a discriminated transport message.
 * @param line - one response line from the helper's stdout.
 * @returns the classified message; malformed lines degrade to `invalid` or `ignored` instead of throwing.
 */
export function decodeLine(line: string): DecodedLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { kind: 'invalid', line, cause }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'ignored', line, reason: 'unknown-shape' }
  }
  const message = parsed as Record<string, unknown>
  const id = message['id']
  if (typeof id !== 'number' || !Number.isFinite(id)) return { kind: 'ignored', line, reason: 'no-id' }
  if (message['ok']) return { kind: 'result', id, result: message['result'] }
  const approval = approvalFrom(message['approvalRequest'])
  if (approval !== null) return { kind: 'approval', id, approval }
  const errorRaw = message['error']
  const error = typeof errorRaw === 'string' ? errorRaw : 'computer-use helper request failed'
  return { kind: 'error', id, error }
}

/** Incremental NDJSON splitter: feeds chunks in, receives decoded lines out. */
export class NdjsonDecoder {
  #buffer = ''

  /**
   * Feed the next stdout chunk; complete lines decode immediately.
   * @param chunk - utf8 text straight from the helper's stdout.
   * @returns every message this chunk completed; a partial tail waits for more data.
   */
  push(chunk: string): DecodedLine[] {
    this.#buffer += chunk
    const messages: DecodedLine[] = []
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      const raw = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      const line = raw.trim()
      if (line === '') continue
      messages.push(decodeLine(line))
    }
    return messages
  }
}
