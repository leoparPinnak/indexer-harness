/**
 * `@deepseek-ai/dsh-ipc-pipe` — the named-pipe gateway the Deamon bridge and
 * helper daemon speak over: a Windows named pipe (`\\.\pipe\dsh-gateway-<homehash16>`)
 * with a unix socket fallback, framed request/response messages under the
 * Hermes caps (64 KiB request, 512 KiB response, 2000 ms default budget), a
 * `sha256` key-digest handshake, a single-instance lock, and 30 s of
 * half-close tolerance.
 *
 * @module @deepseek-ai/dsh-ipc-pipe
 */

export {
  digestMatches,
  GATEWAY_HASH_LENGTH,
  GATEWAY_KEY_ENV,
  GATEWAY_PATH_ENV,
  GATEWAY_PREFIX,
  gatewayCoordinates,
  type GatewayCoordinateOptions,
  type GatewayCoordinates,
} from './coords.ts'
export {
  GatewayAlreadyRunningError,
  GatewayAuthError,
  GatewayClosedError,
  GatewayError,
  GatewayPayloadTooLargeError,
  GatewayProtocolError,
  GatewayTimeoutError,
} from './errors.ts'
export {
  DEFAULT_TIMEOUT_MS,
  encodeFrame,
  FrameReader,
  HALF_CLOSE_TOLERANCE_MS,
  MAX_CONTROL_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  type DecodedFrame,
  type GatewayMessage,
} from './protocol.ts'
export {
  type GatewayHandler,
  type GatewayLogger,
  GatewayRequest,
  GatewayResponse,
  startPipeGateway,
  type PipeGateway,
  type StartPipeGatewayOptions,
} from './server.ts'
export {
  type GatewayClientOptions,
  type GatewayRequestInit,
  type GatewayResponsePayload,
  GatewayStream,
  PipeGatewayClient,
} from './client.ts'
