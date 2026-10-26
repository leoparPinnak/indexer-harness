/**
 * Per-session MCP server visibility: one durable disable list per session,
 * applied as a tool restriction inside that session's Agent scope.
 *
 * The MCP bridge registers a server's tools process-wide, so "this session
 * does not use that server" is not a mount question — the ToolRuntime already
 * models it as a scope restriction (`agent.ctx.tools.restrict()`). Confining
 * the restriction to the Agent scope is what keeps one session's choice out of
 * every other session's tool surface, and what makes a switch reach the model
 * on the next request instead of at the next process start.
 *
 * @module @deepseek-ai/dsh-mcp-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { mcpStatusRegistry, serverNameOfLoaderEntry } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: the Loader's entry tree is how the roster sees configured-but-
// not-yet-connected servers and their Host enablement.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Side-effect type imports: declaration-merge ctx.agents, ctx.sessions,
// ctx.sessionProjections, and ctx.tools onto Context.
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import type {
  McpSessionListRequest,
  McpSessionServerView,
  McpSessionSetRequest,
  McpSessionSnapshot,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpSession: McpSessionService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable per-session MCP server visibility. Log-only user intent: the
     * last event wins, the fold is the projection below, and the event never
     * enters the model transcript.
     */
    'mcp/session-servers': { disabled: readonly string[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Per-session MCP server visibility. */
    mcpServers: McpSessionServersState
  }
}

/** Folded per-session MCP visibility. */
export interface McpSessionServersState {
  /** Configured server names this session does not expose to the model. */
  readonly disabled: readonly string[]
}

/** State for the empty log: every known MCP server visible. */
const EMPTY_STATE: McpSessionServersState = { disabled: [] }

const stateSchema: z.ZodType<McpSessionServersState> = z.object({
  disabled: z.array(z.string().min(1)),
}).strict()

/**
 * One-event fold: the newest visibility list replaces the previous one.
 * @param state - state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference for an unrelated event.
 */
function applySessionServers(state: McpSessionServersState, event: SessionEvent): McpSessionServersState {
  if (event.type !== 'mcp/session-servers') return state
  return { disabled: [...event.data.disabled] }
}

/** Public prefix every tool of one server carries (`mcp__<serverName>__`). */
function toolPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/** One roster row: registered tool count plus the Loader row's enablement. */
interface McpRosterEntry {
  /** Registered `mcp__<serverName>__` tools right now. */
  toolCount: number
  /** Effective Loader enablement of the row that configures the server. */
  hostEnabled: boolean
}

/** Identity of one applied deny set, for cheap no-op detection. */
function signature(deny: readonly string[]): string {
  return [...deny].sort().join('\n')
}

/**
 * Remote face of the per-session MCP plane. The read side is this service, the
 * write side is {@link McpSessionService.setServerEnabled}; the Agent scope
 * carries the effect.
 */
export class McpSessionService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionProjections', 'tools']

  /** Restriction disposers for live agents, by agent id. */
  private readonly restrictions = new Map<SessionId, () => void>()
  /**
   * Signature of the deny set each live agent's restriction currently carries.
   * Recorded BEFORE `restrict()` is called: applying a restriction emits
   * `tools/change`, so the re-entrant pass must already see this agent as done.
   */
  private readonly applied = new Map<SessionId, string>()

  constructor(ctx: Context) {
    super(ctx, 'mcpSession')
  }

  protected [Service.init](): void {
    this.ctx.sessionProjections.register({
      key: 'mcpServers',
      stateVersion: 1,
      stateSchema,
      init: () => EMPTY_STATE,
      apply: applySessionServers,
    })
    this.ctx.effect(() => {
      const created = this.ctx.on('agent/created', ({ agent }) => { this.applyTo(agent) })
      const disposed = this.ctx.on('agent/disposed', ({ agent }) => { this.forget(agent.id) })
      // A registration change is how a reconnected MCP server publishes a new
      // tool generation. Without this pass, the names added after a reconnect
      // would stay visible in a session that switched the server off.
      const changed = this.ctx.on('tools/change', () => {
        for (const agent of this.ctx.agents.list()) this.applyTo(agent)
      })
      return () => {
        created()
        disposed()
        changed()
      }
    }, 'mcp-session: agent scope wiring')
  }

  /**
   * Read one session's MCP server visibility.
   * @param request - the session to read.
   * @returns every known server with this session's effective visibility.
   */
  @Remote('list')
  list(request: McpSessionListRequest): McpSessionSnapshot {
    return this.snapshot(this.sessionOf(request.sessionId))
  }

  /**
   * Switch one MCP server for one session. The appended event is the durable
   * decision; the Agent-scope restriction applied here is what the next model
   * request sees.
   * @param request - the session, the server, and the desired visibility.
   * @returns the session's visibility after the write.
   */
  @Remote('setServerEnabled')
  setServerEnabled(request: McpSessionSetRequest): McpSessionSnapshot {
    const agent = this.agentOf(request.sessionId)
    if (!this.roster().has(request.serverName)) {
      throw new Error(`mcp-session: this Host knows no MCP server named "${request.serverName}"`)
    }
    const disabled = new Set(this.stateOf(agent.session).disabled)
    if (request.enabled) disabled.delete(request.serverName)
    else disabled.add(request.serverName)
    agent.session.append('mcp/session-servers', { disabled: [...disabled].sort() })
    this.applyTo(agent)
    return this.snapshot(agent.session)
  }

  /** The live Session for one id, whether or not an Agent currently drives it. */
  private sessionOf(sessionId: string): Session {
    const id = SessionId(sessionId)
    const session = this.ctx.agents.get(id)?.session ?? this.ctx.sessions.get(id)
    if (session === undefined) throw new Error(`mcp-session: session "${sessionId}" is not live`)
    return session
  }

  /** The live Agent for one id; a switch has nowhere to land without it. */
  private agentOf(sessionId: string): Agent {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) {
      throw new Error(`mcp-session: session "${sessionId}" has no live agent to switch tools for`)
    }
    return agent
  }

  /** Folded visibility for one session, treating an unwatched key as "all visible". */
  private stateOf(session: Session): McpSessionServersState {
    return this.ctx.sessionProjections.stateOf(session, 'mcpServers') ?? EMPTY_STATE
  }

  /**
   * Public tool count per MCP server this Host knows about. A server is known
   * once its bridge recorded any lifecycle transition OR its Loader row is
   * composed — a configured-but-never-connected (or Host-disabled) server
   * lists with zero tools rather than disappearing, so a session switch can
   * pre-commit its choice before the server ever connects.
   */
  private roster(): Map<string, McpRosterEntry> {
    const entries = new Map<string, McpRosterEntry>()
    for (const status of mcpStatusRegistry.list()) {
      if (entries.has(status.serverName)) continue
      entries.set(status.serverName, { toolCount: 0, hostEnabled: true })
    }
    // Optional read: contexts without a Loader (test kits, isolated scopes)
    // know servers through the status registry alone, the shape every plane
    // behaved on before Loader rows joined the roster.
    const loader = this.ctx.get('loader')
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        const serverName = serverNameOfLoaderEntry(entry.options)
        if (serverName === undefined) continue
        const known = entries.get(serverName)
        // One public namespace may carry rows on several scopes: the session
        // panel reads "the Host can mount it" — any enabled row counts.
        const hostEnabled = known === undefined
          ? !entry.disabled
          : known.hostEnabled || !entry.disabled
        entries.set(serverName, { toolCount: known?.toolCount ?? 0, hostEnabled })
      }
    }
    const schemas = this.ctx.tools.schemas()
    for (const [serverName, entry] of entries) {
      const prefix = toolPrefix(serverName)
      entry.toolCount = schemas.filter(schema => schema.name.startsWith(prefix)).length
    }
    return entries
  }

  /** One session's visibility snapshot over the current roster. */
  private snapshot(session: Session): McpSessionSnapshot {
    const disabled = new Set(this.stateOf(session).disabled)
    const servers: McpSessionServerView[] = [...this.roster().entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serverName, entry]) => ({
        serverName,
        toolCount: entry.toolCount,
        hostEnabled: entry.hostEnabled,
        enabled: entry.hostEnabled && !disabled.has(serverName),
      }))
    return { servers }
  }

  /**
   * The exact names one session's visibility withholds. Always derived from the
   * currently registered tools, never from stored names: `tools.restrict()`
   * refuses a name the registry does not know, and a stale name would either
   * throw or silently fail to cover a re-registered tool.
   */
  private denyNames(session: Session): string[] {
    const disabled = this.stateOf(session).disabled
    if (disabled.length === 0) return []
    const prefixes = disabled.map(serverName => toolPrefix(serverName))
    return this.ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => prefixes.some(prefix => name.startsWith(prefix)))
  }

  /** Apply one live agent's restriction, skipping the no-op pass. */
  private applyTo(agent: Agent): void {
    const deny = this.denyNames(agent.session)
    const next = signature(deny)
    if (this.applied.get(agent.id) === next) return
    // Recorded before the call: `restrict()` emits `tools/change`, which
    // re-enters this method for every live agent.
    this.applied.set(agent.id, next)
    this.restrictions.get(agent.id)?.()
    this.restrictions.delete(agent.id)
    if (deny.length === 0) return
    try {
      this.restrictions.set(agent.id, agent.ctx.tools.restrict({ deny }))
    } catch (error: unknown) {
      // A refused restriction must not wedge the Agent loop or the registry's
      // change dispatch; dropping the record lets the next change retry.
      /* v8 ignore start -- deny names come from the same synchronous global read `restrict()` re-validates, so no refusal is reachable from this call site */
      this.applied.delete(agent.id)
      this.ctx.logger.warn(`mcp-session: could not restrict tools for session "${agent.id}": ${String(error)}`)
      /* v8 ignore stop */
    }
  }

  /** Drop one disposed agent's bookkeeping; its scope unwind already lifted the restriction. */
  private forget(agentId: SessionId): void {
    this.restrictions.delete(agentId)
    this.applied.delete(agentId)
  }
}

export default McpSessionService
