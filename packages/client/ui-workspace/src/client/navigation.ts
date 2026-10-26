/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param sessionId - listed or retained Session to display.
   */
  openSession(sessionId: SessionId): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session and open the child unless a later navigation supersedes it.
   * @param sessionId - source Session.
   * @returns completion; a superseded request leaves its child available without selecting it.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @param excludeSession - Session the reuse scan must skip; the explicit New
   *   Session flow passes the open Session so a click inside a blank chat
   *   starts its successor instead of re-opening the view already on screen.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId, excludeSession?: SessionId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Create a Fast Session — a Session owning a fresh folder under the Host's
   * Fast Session root — and open it.
   * @param workspaceTitle - display title for the Workspace the Session owns.
   */
  startFastSession(workspaceTitle?: string): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchNavigation(), 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId, excludeSession?: SessionId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary === undefined || summary.id === excludeSession || !summary.blank) continue
      if (summary.cwd !== workspace.path) continue
      if (!workspace.sessionIds.includes(summary.id)) continue
      if (archived.includes(summary.id)) continue
      return summary.id
    }

    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  openSession(sessionId: SessionId): void {
    this.sessions.open(sessionId)
    this.ctx.layout.selectPanel(null)
  }

  async openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    excludeSession?: SessionId,
  ): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const isCurrent = (): boolean => !navigation.aborted
    const sessionId = await this.connectWorkspace(workspaceId, excludeSession)
    if (!isCurrent()) return
    beforeOpen?.(sessionId)
    if (isCurrent()) this.openSession(sessionId)
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const childId = await this.sessions.fork({ sessionId, increaseTitle: true })
    if (!navigation.aborted) this.openSession(childId)
  }

  startSession(workspaceId?: WorkspaceId): void {
    if (this.listsReady()) {
      this.resolveNewSession(workspaceId)
      return
    }
    // A click that lands before the Workspace and Session feeds report `ready`
    // waits for them: resolving the target from a partial snapshot found no
    // Workspace at all and cleared the view, which read as a dead button.
    void this.whenListsReady().then(
      () => {
        if (this.lifetime.signal.aborted) return
        this.resolveNewSession(workspaceId)
      },
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  /**
   * Create a Fast Session and open it. The Host mints the folder name and the
   * working directory, so this path takes no target Workspace; the caller
   * supplies only the title the resulting Workspace displays.
   * @param workspaceTitle - display title for the Workspace the Session owns.
   */
  startFastSession(workspaceTitle?: string): void {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    void this.sessions.createFast(workspaceTitle).then(
      (sessionId) => { if (!navigation.aborted) this.openSession(sessionId) },
      (reason: unknown) => { console.warn('fast session failed:', reason) },
    )
  }

  /**
   * Resolve the New Session target from a complete snapshot and start it.
   *
   * The open Session is excluded from blank reuse, so the explicit action
   * always leaves the operator in a chat they have not seen instead of
   * re-opening the blank view already on screen.
   *
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  private resolveNewSession(workspaceId?: WorkspaceId): void {
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = sessions.current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId ?? recentWorkspace(workspace.items, sessions.byId)
    if (target === undefined) {
      this.sessions.clear()
      this.ctx.layout.selectPanel(null)
      return
    }
    void this.openWorkspace(target, undefined, current).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  /**
   * Resolve once both list feeds report `ready`, or immediately when they do.
   * @returns fulfillment when Workspace and Session snapshots are complete.
   */
  private whenListsReady(): Promise<void> {
    if (this.listsReady()) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    const settle = (): void => {
      if (!this.listsReady() && !this.lifetime.signal.aborted) return
      offWorkspaces()
      offSessions()
      resolve()
    }
    const offWorkspaces = this.workspaces.list.subscribe(settle)
    const offSessions = this.sessions.list.subscribe(settle)
    settle()
    return promise
  }

  /** @returns whether both list feeds are past their loading phase. */
  private listsReady(): boolean {
    return this.workspaces.list.getSnapshot().phase === 'ready'
      && this.sessions.list.getSnapshot().phase === 'ready'
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.archiveSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (sessions.current !== undefined) {
        initial = 'done'
        return
      }
      const target = recentWorkspace(workspace.items, sessions.byId)
      if (target === undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.connectWorkspace(target).then(
        (sessionId) => {
          if (this.lifetime.signal.aborted) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          initial = 'done'
        },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial workspace selection failed:', reason)
        },
      )
    }
    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.sessions.clear()
    return true
  }

}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
