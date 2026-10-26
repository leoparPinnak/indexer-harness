import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Effective enablement of one preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row an agent preset's composition names. */
export interface AgentPresetPluginRow {
  /** Composition row id, or null when the row declares none. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /**
   * Effective enablement, including disabled ancestor groups. `'conditional'`
   * marks a `!!js` disabled expression on a composition no session has
   * mounted, which only a Loader context can decide.
   */
  readonly enabled: PresetPluginEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber phase when the composition is live; null otherwise. */
  readonly fiberPhase: PluginFiberPhase
}

/** One agent preset's identity and flattened composition in the inventory. */
export interface AgentPresetPluginGroup {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Display name the preset published; a reader falls back to the id. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  /** Plugin rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetPluginRow[]
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * Per-preset compositions, present only when an agent-preset roster is
   * composed in this deployment.
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}

/** Connection lifecycle state one MCP server instance reported. */
export type McpServerConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'stopped'

/** Point-in-time view of one configured MCP server. */
export interface McpServerView {
  /**
   * Entry id a patch list addresses: the id the row declares (`mcp-rea`),
   * never the tree-qualified path (`include:mcp-rea`). This is the toggle key
   * `setMcpServerEnabled` writes into the managed patch block.
   */
  readonly entryId: PluginEntryId
  /** Configured `serverName` namespace of the server's tool names. */
  readonly serverName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  /** Tools currently registered under `mcp__<serverName>__`. */
  readonly toolCount: number
  /** Last connection transition the status registry recorded; null before the first. */
  readonly state: McpServerConnectionState | null
  /** Error text behind the last `reconnecting`/`failed` transition; null otherwise. */
  readonly lastError: string | null
}

/** Point-in-time MCP server list returned by the plugin inventory Remote. */
export interface McpServersSnapshot {
  readonly servers: readonly McpServerView[]
}

/** Remote-payload config the add-MCP-server form submits. */
export interface AddMcpServerRequest {
  /**
   * Stable local namespace for the server's tool names
   * (`mcp__<serverName>__<tool>`); `[A-Za-z0-9_-]{1,32}`.
   */
  readonly serverName: string
  /** The transport the server speaks. */
  readonly transport: 'stdio' | 'streamable-http'
  /** stdio: executable used to start the server. */
  readonly command?: string
  /** stdio: arguments passed directly, without shell interpolation. */
  readonly args?: readonly string[]
  /** stdio: extra environment variables merged on top of scrubbed ambient env. */
  readonly env?: Readonly<Record<string, string>>
  /** stdio: working directory for the child process. */
  readonly cwd?: string
  /** Streamable HTTP: the MCP endpoint URL. */
  readonly url?: string
  /** Streamable HTTP: additional headers attached to MCP requests. */
  readonly headers?: Readonly<Record<string, string>>
  /** Per-tool-call timeout in milliseconds; omission keeps the bridge default. */
  readonly toolCallTimeoutMs?: number
}
