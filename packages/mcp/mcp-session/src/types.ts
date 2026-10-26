/** Wire vocabulary of the per-session MCP server plane. */

/** One MCP server as one session sees it. */
export interface McpSessionServerView {
  /** Configured `serverName` namespace of the server's public tool names. */
  readonly serverName: string
  /** Public `mcp__<serverName>__` tools the process currently registers for it. */
  readonly toolCount: number
  /**
   * Loader enablement of the row that configures the server: a session can
   * withhold a connected server, but a Host-disabled one exposes no tools
   * regardless of this session's switch.
   */
  readonly hostEnabled: boolean
  /** Whether this session currently exposes those tools to the model. */
  readonly enabled: boolean
}

/** Point-in-time per-session MCP visibility. */
export interface McpSessionSnapshot {
  /** Servers this process knows about, ordered by `serverName`. */
  readonly servers: readonly McpSessionServerView[]
}

/** Request: read one session's MCP visibility. */
export interface McpSessionListRequest {
  /** Session whose visibility to read. */
  readonly sessionId: string
}

/** Request: set one server's visibility for one session. */
export interface McpSessionSetRequest {
  /** Session whose visibility changes. */
  readonly sessionId: string
  /** Configured `serverName` of the server to switch. */
  readonly serverName: string
  /** Desired visibility. */
  readonly enabled: boolean
}
