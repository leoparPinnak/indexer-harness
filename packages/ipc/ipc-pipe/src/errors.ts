/**
 * Error vocabulary of the pipe gateway. Every refusal carries a stable
 * `code` so a caller can branch without parsing the message, and the
 * message itself stays human-readable for the log line it lands in.
 *
 * @module @deepseek-ai/dsh-ipc-pipe/errors
 */

/** Base class of every gateway failure. */
export class GatewayError extends Error {
  /** Stable machine-readable code (`ALREADY_RUNNING`, `AUTH_FAILED`, …). */
  readonly code: string

  /**
   * @param code - stable machine-readable code.
   * @param message - human-readable description.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/** The gateway endpoint is already mounted by a live process; the second mount refuses. */
export class GatewayAlreadyRunningError extends GatewayError {
  /**
   * @param message - which endpoint is taken and by whom.
   */
  constructor(message: string) {
    super('ALREADY_RUNNING', message)
    this.name = 'GatewayAlreadyRunningError'
  }
}

/** The first handshake carried the wrong `sha256` key digest; the connection is closed. */
export class GatewayAuthError extends GatewayError {
  /**
   * @param message - what mismatched.
   */
  constructor(message: string) {
    super('AUTH_FAILED', message)
    this.name = 'GatewayAuthError'
  }
}

/** A request produced no response header inside its budget. */
export class GatewayTimeoutError extends GatewayError {
  /**
   * @param message - which request ran out of time.
   */
  constructor(message: string) {
    super('TIMEOUT', message)
    this.name = 'GatewayTimeoutError'
  }
}

/** The peer spoke the frame grammar wrongly; the connection is closed. */
export class GatewayProtocolError extends GatewayError {
  /**
   * @param message - what the frame violated.
   */
  constructor(message: string) {
    super('PROTOCOL', message)
    this.name = 'GatewayProtocolError'
  }
}

/** A frame exceeded the request or response size cap; the connection is closed. */
export class GatewayPayloadTooLargeError extends GatewayError {
  /**
   * @param message - which cap the frame passed.
   */
  constructor(message: string) {
    super('PAYLOAD_TOO_LARGE', message)
    this.name = 'GatewayPayloadTooLargeError'
  }
}

/** The connection closed (or never opened) while a caller still waited on it. */
export class GatewayClosedError extends GatewayError {
  /**
   * @param message - why the connection is gone.
   */
  constructor(message: string) {
    super('CLOSED', message)
    this.name = 'GatewayClosedError'
  }
}
