/**
 * Frame grammar of the pipe gateway.
 *
 * One frame is `[u32 total][header JSON][0x0A][body]`: a big-endian byte
 * count, a single-line JSON envelope, a newline, then the raw body the
 * envelope describes. The newline is unambiguous because `JSON.stringify`
 * never emits a raw one, so the reader recovers the header before it has to
 * buffer a body and can refuse an oversized frame the moment its type is known.
 *
 * Caps are the Hermes numbers: 64 KiB for a request frame, 512 KiB for a
 * response frame, and 2000 ms as the default per-request budget. Every
 * violation raises a typed error the peer turns into an explicit `error`
 * message plus a closed connection — never a silent truncation.
 *
 * @module @deepseek-ai/dsh-ipc-pipe/protocol
 */

import { GatewayPayloadTooLargeError, GatewayProtocolError } from './errors.ts'

/** Protocol generation carried in the handshake; a mismatch refuses the peer. */
export const PROTOCOL_VERSION = 1

/** Largest request frame: header plus body, 64 KiB (the Hermes figure). */
export const MAX_REQUEST_BYTES = 64 * 1024

/** Largest response frame: header plus body, 512 KiB (the Hermes figure). */
export const MAX_RESPONSE_BYTES = 512 * 1024

/** Default per-request budget in milliseconds (the Hermes figure). */
export const DEFAULT_TIMEOUT_MS = 2000

/** How long a peer that half-closed may still receive an answer, in milliseconds (the Cursor pattern). */
export const HALF_CLOSE_TOLERANCE_MS = 30_000

/** Largest control frame (handshake, ping, error) before the body type is known. */
export const MAX_CONTROL_BYTES = 8 * 1024

/** A message the gateway exchanges; `body` rides the frame, not the envelope. */
export type GatewayMessage =
  | { readonly t: 'hello'; readonly v: number; readonly digest: string }
  | { readonly t: 'welcome'; readonly v: number }
  | {
    readonly t: 'req'
    readonly id: number
    readonly method: string
    readonly url: string
    readonly headers?: Record<string, string>
    readonly stream?: boolean
    readonly timeoutMs?: number
  }
  | {
    readonly t: 'res'
    readonly id: number
    readonly status: number
    readonly headers?: Record<string, string>
    readonly stream?: boolean
  }
  | { readonly t: 'chunk'; readonly id: number }
  | { readonly t: 'end'; readonly id: number }
  | { readonly t: 'abort'; readonly id: number }
  | { readonly t: 'error'; readonly id?: number; readonly code: string; readonly message: string }
  | { readonly t: 'ping'; readonly id: number }
  | { readonly t: 'pong'; readonly id: number }
  | { readonly t: 'bye' }

/**
 * Encode one frame.
 * @param message - envelope to write on the header line.
 * @param body - raw payload appended after the newline.
 * @returns the length-prefixed frame ready for `socket.write`.
 */
export function encodeFrame(message: GatewayMessage, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
  const frame = Buffer.allocUnsafe(4 + header.length + body.length)
  frame.writeUInt32BE(header.length + body.length, 0)
  header.copy(frame, 4)
  body.copy(frame, 4 + header.length)
  return frame
}

/** One decoded frame: envelope plus the body bytes the envelope describes. */
export interface DecodedFrame {
  /** The parsed header envelope. */
  readonly message: GatewayMessage
  /** Raw body bytes; empty for control frames. */
  readonly body: Buffer
}

/**
 * Size cap a message type must respect.
 * @param type - the envelope discriminant.
 * @returns the byte cap for header plus body of that frame.
 */
function capFor(type: string): number {
  if (type === 'req') return MAX_REQUEST_BYTES
  if (type === 'res' || type === 'chunk' || type === 'end') return MAX_RESPONSE_BYTES
  return MAX_CONTROL_BYTES
}

/**
 * Incremental frame reader: feed it socket chunks, take back whole frames.
 * The buffer never grows past one frame's cap, so a peer cannot pin memory
 * with a declared length it never sends.
 */
export class FrameReader {
  /** Bytes received but not yet decoded. */
  #buffer: Buffer = Buffer.alloc(0)

  /**
   * Append a socket chunk and decode every frame it completes.
   * @param chunk - bytes straight off the wire.
   * @returns the frames this chunk finished, in arrival order.
   * @throws GatewayProtocolError when the byte stream violates the grammar.
   * @throws GatewayPayloadTooLargeError when a frame passes its type's cap.
   */
  push(chunk: Buffer): DecodedFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames: DecodedFrame[] = []
    for (;;) {
      if (this.#buffer.length < 4) break
      const total = this.#buffer.readUInt32BE(0)
      if (total > MAX_RESPONSE_BYTES + MAX_CONTROL_BYTES) {
        throw new GatewayProtocolError(`frame length ${String(total)} exceeds the ${String(MAX_RESPONSE_BYTES + MAX_CONTROL_BYTES)} byte ceiling`)
      }
      const need = 4 + total
      if (this.#buffer.length < need) break
      const payload = this.#buffer.subarray(4, need)
      const newline = payload.indexOf(0x0a)
      if (newline < 0) {
        throw new GatewayProtocolError('frame header is not newline terminated')
      }
      let message: GatewayMessage
      try {
        message = JSON.parse(payload.subarray(0, newline).toString('utf8')) as GatewayMessage
      } catch {
        throw new GatewayProtocolError('frame header is not valid JSON')
      }
      if (typeof message !== 'object' || message === null || typeof (message as { t?: unknown }).t !== 'string') {
        throw new GatewayProtocolError('frame header carries no message type')
      }
      const cap = capFor((message as { t: string }).t)
      if (total > cap) {
        throw new GatewayPayloadTooLargeError(
          `a "${(message as { t: string }).t}" frame of ${String(total)} bytes passes the ${String(cap)} byte cap`,
        )
      }
      frames.push({ message, body: payload.subarray(newline + 1) })
      this.#buffer = this.#buffer.subarray(need)
    }
    return frames
  }

  /** Drop buffered bytes after a connection is finished with the reader. */
  reset(): void {
    this.#buffer = Buffer.alloc(0)
  }
}
