/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { mcpStatusRegistry, SERVER_NAME_PATTERN, serverNameOfLoaderEntry } from '@deepseek-ai/dsh-mcp-client'
import path from 'node:path'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { addServerRow, readDeclaredIds, toggleEntryDisabled } from './patch.ts'
import type {
  AddMcpServerRequest,
  AgentPresetPluginGroup,
  McpServerView,
  McpServersSnapshot,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/**
 * The one explicit resolve step from deployment state to the patch file the
 * toggle and the add-server writer both edit: the home patch
 * (`$DSH_HOME/cordis.patch.yml`) composes after every bundle and profile
 * patch, so an id-targeted `disabled` row there wins over the `insert` row
 * that introduced the server.
 *
 * @returns Absolute path of the home patch file.
 */
function homePatchPath(): string {
  const home = process.env.DSH_HOME
  if (home === undefined || home === '') {
    throw new Error('plugin-inventory: DSH_HOME is required to manage MCP servers')
  }
  return path.join(home, 'cordis.patch.yml')
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   * @returns Current non-group Loader entries in Loader order, with per-preset
   * compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { entries }
    const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
      composition => ({
        ...composition,
        rows: composition.rows.map(({ fiberState, ...row }) => ({
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
        })),
      }),
    )
    return { entries, agentPresets }
  }

  /**
   * One row per configured `@deepseek-ai/dsh-mcp-client` entry: the Loader's
   * live enablement and fiber phase joined with the connection status and tool
   * count the mcp-client supervisor last recorded.
   *
   * @returns Current MCP server rows in Loader order.
   */
  @Remote('mcpServers')
  async mcpServers(): Promise<McpServersSnapshot> {
    const statuses = mcpStatusRegistry.list()
    const servers: McpServerView[] = []
    for (const entry of this.ctx.loader.entries()) {
      const serverName = serverNameOfLoaderEntry(entry.options)
      if (serverName === undefined) continue
      const status = statuses.find((candidate) => candidate.serverName === serverName)
      servers.push({
        // Patch lists address a row by the id it declares, not by the
        // tree-qualified path `Entry.id` composes (`include:mcp-rea`), so the
        // toggle key is the declared id.
        /* v8 ignore next -- Tree.ensureId stamps an id on every mounted row; the fallback only satisfies the optional type */
        entryId: pluginEntryId(entry.options.id ?? entry.id),
        serverName,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        toolCount: status?.toolCount ?? 0,
        state: status?.state ?? null,
        lastError: status?.lastError ?? null,
      })
    }
    return { servers }
  }

  /**
   * Enable or disable one MCP server by writing an id-targeted `disabled` row
   * into the home patch file; `patchReload: live` recomposes the Loader from
   * the edit. Re-enabling removes the managed row only — the `insert` row that
   * defines the server is never touched.
   *
   * @param entryId - Loader entry id of the server, e.g. `mcp-rea`.
   * @param enabled - Desired enablement.
   * @returns The MCP server rows after the rewrite, as {@link mcpServers} reports them.
   */
  @Remote('setMcpServerEnabled')
  async setMcpServerEnabled(entryId: string, enabled: boolean): Promise<McpServersSnapshot> {
    toggleEntryDisabled(homePatchPath(), entryId, enabled)
    return this.mcpServers()
  }

  /**
   * Add one MCP server by writing an id-keyed `insert` row into the same
   * managed patch block the toggle uses. The row mounts through `patchReload:
   * live` like any other patch edit — no Host restart — and the next
   * {@link mcpServers} call lists it.
   *
   * @param request - the new server's transport choice and its fields.
   * @returns The MCP server rows after the write, as {@link mcpServers} reports them.
   */
  @Remote('addMcpServer')
  async addMcpServer(request: AddMcpServerRequest): Promise<McpServersSnapshot> {
    const serverName = validateServerName(request.serverName)
    validateTransportFields(request)
    const entryId = `mcp-${serverName}`
    const liveNames = [...this.ctx.loader.entries()]
      .map(entry => serverNameOfLoaderEntry(entry.options))
      .filter((candidate): candidate is string => candidate !== undefined)
    if (liveNames.includes(serverName)) {
      throw new Error(`plugin-inventory: an MCP server named "${serverName}" is already configured`)
    }
    const declared = readDeclaredIds(homePatchPath())
    if (declared.has(entryId)) {
      throw new Error(`plugin-inventory: a patch row with id "${entryId}" already exists`)
    }
    addServerRow(homePatchPath(), {
      id: entryId,
      name: '@deepseek-ai/dsh-mcp-client',
      config: request.transport === 'stdio'
        ? {
            serverName,
            transport: 'stdio',
            command: request.command ?? '',
            ...(request.args === undefined ? {} : { args: request.args }),
            ...(request.env === undefined ? {} : { env: request.env }),
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            ...(request.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: request.toolCallTimeoutMs }),
          }
        : {
            serverName,
            transport: 'streamable-http',
            url: request.url ?? '',
            ...(request.headers === undefined ? {} : { headers: request.headers }),
            ...(request.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: request.toolCallTimeoutMs }),
          },
    })
    return this.mcpServers()
  }
}


/** The transport fields each `transport` choice requires. */
function validateTransportFields(request: AddMcpServerRequest): void {
  if (request.transport === 'stdio') {
    if (typeof request.command !== 'string' || request.command.trim() === '') {
      throw new Error('plugin-inventory: a stdio MCP server requires its command field')
    }
    for (const field of ['args', 'env', 'cwd'] as const) {
      const value = request[field]
      if (value === undefined) continue
      if (field === 'args') {
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
          throw new Error('plugin-inventory: args must be an array of strings')
        }
      } else if (field === 'env') {
        if (!isStringRecord(value)) {
          throw new Error('plugin-inventory: env must map names to plain strings')
        }
      } else if (typeof value !== 'string') {
        throw new Error('plugin-inventory: cwd must be a string')
      }
    }
    return
  }
  const url = request.url
  if (typeof url !== 'string' || !URL.canParse(url) || !/^https?:/i.test(new URL(url).protocol)) {
    throw new Error('plugin-inventory: a streamable-http MCP server requires an http(s) url field')
  }
  if (request.headers !== undefined && !isStringRecord(request.headers)) {
    throw new Error('plugin-inventory: headers must map names to plain strings')
  }
}

/** Whether a candidate is a record whose every own member is a plain string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every(member => typeof member === 'string')
}

/** Whether a candidate is a flat string-keyed record (JSON-payload guard). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The one explicit validation step from a form-submitted name to the namespace
 * the bridge will own. Duplication is checked by the caller against live rows
 * and the managed block; this judge owns syntax only.
 */
function validateServerName(serverName: string): string {
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error('plugin-inventory: serverName must match [A-Za-z0-9_-]{1,32}')
  }
  return serverName
}

export default PluginInventoryGateway
