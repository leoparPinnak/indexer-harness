import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

/** Hosting directories created per test, removed after it settles. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A Fast Session root inside the OS temp directory, so the created folder is real. */
async function fastRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-fast-spec-'))
  roots.push(created)
  return created
}

function controllerAgents(overrides: object = {}): ApiSessionAgentController {
  return {
    ensureSession: () => Promise.resolve(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForSession: () => undefined,
    presetForObservation: () => undefined,
    ...overrides,
  } as unknown as ApiSessionAgentController
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

describe('Fast Session creation', () => {
  it('creates the working directory, owns it as a Workspace, and attaches the Session', async () => {
    const root = await fastRoot()
    const ctx = await baseContext()
    const attachSession = vi.fn(() => Promise.resolve())
    const workspace = {
      id: 'fast-workspace' as WorkspaceId,
      path: '',
      attachSession,
    } as unknown as Workspace
    const create = vi.fn((path: string, title?: string) => {
      workspace.path = path
      expect(title).toBe('Quick session')
      return Promise.resolve(workspace)
    })
    ctx.provide('workspaceRegistry', { create, get: () => undefined, list: () => [] } as never)
    const ensureSession = vi.fn((sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      return Promise.resolve({ id: sessionId, session } as Agent)
    })
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession }),
      '/default',
    )

    const created = await controller.createFast({ workspaceTitle: 'Quick session' }, root)

    expect(created.sessionId).toMatch(/^session-/u)
    // The folder is named by the Session id and is the reported working directory.
    expect(created.cwd).toBe(join(root, created.sessionId))
    expect((await stat(created.cwd)).isDirectory()).toBe(true)
    // The Workspace over that folder is what the created Session owns.
    expect(create).toHaveBeenCalledWith(created.cwd, 'Quick session')
    expect(ensureSession).toHaveBeenCalledWith(created.sessionId, created.cwd, false, undefined)
    expect(attachSession).toHaveBeenCalledWith(created.sessionId)
    await ctx.fiber.dispose()
  })

  it('falls back to the folder name when the caller supplies no title', async () => {
    const root = await fastRoot()
    const ctx = await baseContext()
    const workspace = {
      id: 'fast-workspace' as WorkspaceId,
      path: '',
      attachSession: () => Promise.resolve(),
    } as unknown as Workspace
    const create = vi.fn((path: string, title?: string) => {
      workspace.path = path
      expect(title).toBeUndefined()
      return Promise.resolve(workspace)
    })
    ctx.provide('workspaceRegistry', { create, get: () => undefined, list: () => [] } as never)
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    const created = await controller.createFast({}, root)

    expect(created.cwd).toBe(join(root, created.sessionId))
    await ctx.fiber.dispose()
  })

  it('reports a root that cannot host the folder as an infrastructure failure', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { create: vi.fn(), get: () => undefined, list: () => [] } as never)
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
    // A regular file where the root must be a directory makes mkdir fail.
    const file = join(await fastRoot(), 'occupied')
    await writeFile(file, '')

    await expect(controller.createFast({}, file)).rejects.toMatchObject({ code: 'gateway/internal' })
    await ctx.fiber.dispose()
  })

  it('reports a Session that cannot be created and a Workspace that refuses the attach', async () => {
    const root = await fastRoot()
    const failed = await baseContext()
    const workspace = {
      id: 'fast-workspace' as WorkspaceId,
      path: '',
      attachSession: () => Promise.resolve(),
    } as unknown as Workspace
    failed.provide('workspaceRegistry', {
      create: (path: string) => {
        workspace.path = path
        return Promise.resolve(workspace)
      },
      get: () => undefined,
      list: () => [],
    } as never)
    const rejected = new SessionCommandController(
      failed,
      controllerAgents({ ensureSession: () => Promise.reject(new Error('session store refused')) }),
      '/default',
    )
    await expect(rejected.createFast({}, root)).rejects.toMatchObject({ code: 'gateway/internal' })
    await failed.fiber.dispose()

    const unattachable = await baseContext()
    const unowned = {
      id: 'fast-workspace' as WorkspaceId,
      path: '',
      attachSession: () => Promise.reject(new Error('read-only registry')),
    } as unknown as Workspace
    unattachable.provide('workspaceRegistry', {
      create: (path: string) => {
        unowned.path = path
        return Promise.resolve(unowned)
      },
      get: () => undefined,
      list: () => [],
    } as never)
    const refused = new SessionCommandController(unattachable, controllerAgents(), '/default')
    await expect(refused.createFast({}, root))
      .rejects.toMatchObject({ code: 'session/workspace-attach-failed' })
    await unattachable.fiber.dispose()
  })
})
