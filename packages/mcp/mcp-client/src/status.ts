/**
 * MCP connection status registry: the observation plane one layer above the
 * connection supervisor. Each live `mcp-client` instance records its lifecycle
 * transitions here; the Settings UI reads the projection, and the JSONL status
 * log keeps connection history outside the process.
 *
 * Registry entries are keyed by (scope, serverName): the same `serverName` may
 * be live in the global plane and in a preset plane at once, so `serverName`
 * alone is not an identity.
 *
 * @module @deepseek-ai/dsh-mcp-client/status
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** Lifecycle states one MCP server instance passes through. */
export type McpConnectionState =
  /** The first connection attempt of a generation is in flight. */
  | 'connecting'
  /** The server is connected and its tool generation is registered. */
  | 'connected'
  /** A connection was lost or an attempt failed; a retry is scheduled. */
  | 'reconnecting'
  /** Reconnection gave up, or reconnect is disabled after a loss; tools are unregistered or stale. */
  | 'failed'
  /** The plugin instance was disposed (unload, HMR swap, Host shutdown). */
  | 'stopped'

/** One recorded status for one (scope, serverName) MCP instance. */
export interface McpStatus {
  /** Configured `serverName` of the instance. */
  readonly serverName: string
  /** Registration plane: `global` for host-plane instances, `preset` for Agent-scoped ones. */
  readonly scope: string
  readonly state: McpConnectionState
  /** Wall-clock milliseconds of the recorded transition. */
  readonly at: number
  /** Registered tool count at this transition; 0 outside `connected`. */
  readonly toolCount: number
  /** Public tool names (`mcp__<serverName>__<raw>`) at this transition. */
  readonly toolNames: readonly string[]
  /** Consecutive failed attempt behind a `reconnecting` transition. */
  readonly attempt?: number
  /** Error text behind `reconnecting`/`failed`. */
  readonly lastError?: string
}

/** Listener invoked on every recorded transition or removal. */
export type McpStatusListener = (statuses: readonly McpStatus[]) => void

/**
 * Live registry of MCP connection statuses. The connection supervisor records
 * transitions; readers poll `list()` or `subscribe()`. The registry holds state
 * only — writing the JSONL history is the caller's explicit side effect through
 * {@link appendStatusLog}.
 */
export class McpStatusRegistry {
  readonly #entries = new Map<string, McpStatus>()
  readonly #listeners = new Set<McpStatusListener>()

  /** Records one transition, replacing the entry for its (scope, serverName). */
  record(status: McpStatus): void {
    this.#entries.set(key(status.scope, status.serverName), status)
    this.#notify()
  }

  /** Removes the entry for an instance that will never record again. */
  remove(scope: string, serverName: string): void {
    if (this.#entries.delete(key(scope, serverName))) this.#notify()
  }

  /** All recorded statuses, sorted by (scope, serverName) for stable UI ordering. */
  list(): readonly McpStatus[] {
    return [...this.#entries.values()].sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.serverName.localeCompare(b.serverName),
    )
  }

  /** Subscribes to transitions; the returned function unsubscribes. */
  subscribe(listener: McpStatusListener): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Drops every entry and listener; test scaffolding only. */
  clear(): void {
    this.#entries.clear()
    this.#listeners.clear()
  }

  #notify(): void {
    const snapshot = this.list()
    for (const listener of this.#listeners) listener(snapshot)
  }
}

function key(scope: string, serverName: string): string {
  return `${scope}\u0000${serverName}`
}

/**
 * The one explicit resolve step from the optional `statusLogPath` config to a
 * concrete log location. File logging is opt-in: without a configured path the
 * registry stays the only status plane, so no process — tests included — ever
 * writes connection history outside a location the deployment declared.
 *
 * @param configured - Raw `statusLogPath` config value.
 * @returns Absolute path of the JSONL status log, or `undefined` when file logging stays off.
 */
export function resolveStatusLogPath(configured: string | undefined): string | undefined {
  if (configured === undefined || configured === '') return undefined
  return path.resolve(configured)
}

/**
 * Appends one status transition to the JSONL log, creating its directory on
 * first write. The status log is observability, not transport: a refused write
 * must never break the connection supervisor.
 *
 * @param logPath - Absolute JSONL path from {@link resolveStatusLogPath}.
 * @param status - Transition to append.
 * @returns `true` when the line was appended, `false` when the filesystem refused it.
 */
export function appendStatusLog(logPath: string, status: McpStatus): boolean {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(status) + '\n')
    return true
  } catch (error: unknown) {
    // A full disk or a locked file degrades to "no history", never to a broken
    // MCP connection; the swallowed cause is a filesystem refusal of one line.
    void error
    return false
  }
}

/** Process-wide registry shared by every `mcp-client` instance in one Host. */
export const mcpStatusRegistry = new McpStatusRegistry()