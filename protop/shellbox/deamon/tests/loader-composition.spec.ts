/**
 * The Deamon bundle through a real Loader composition: the shipped bundle
 * patch boots every row against the fixture registries and mounts the frozen
 * `/api/server/sandbox/*` route surface, the viewer upgrade route, and the
 * model-visible `app:shellbox-surface` prompt section.
 */

import { describe, expect, it } from 'vitest'
import { loadComposition } from './helpers.ts'

/** The frozen HTTP wire surface shared with the ui-sandbox-view pane. */
const ROUTES = [
  '/api/server/sandbox/stream',
  '/api/server/sandbox/fps',
  '/api/server/sandbox/status',
  '/api/server/sandbox/instances',
  '/api/server/sandbox/instances/create',
  '/api/server/sandbox/instances/attach',
  '/api/server/sandbox/instances/detach',
  '/api/server/sandbox/instances/terminate',
  '/api/server/sandbox/size',
  '/api/server/sandbox/launch',
  '/api/server/shellbox/launch',
  '/api/server/sandbox/stop',
  '/api/server/sandbox/input',
  '/api/server/sandbox/windows',
  '/api/server/sandbox/windows/focus',
  '/api/server/sandbox/windows/close',
  '/api/server/sandbox/changes',
]

describe('deamon bundle through a real Loader composition', () => {
  it('boots every patch row and mounts the frozen sandbox route surface', { timeout: 60_000 }, async () => {
    const { context, routes, upgrades, warnings } = await loadComposition()
    expect(warnings).toEqual([])
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect([...routes]).toEqual(expect.arrayContaining(ROUTES))
    expect([...upgrades]).toContain('/api/server/sandbox/ws')
  })

  it('publishes the Shellbox surface section through the injected systemPrompt', { timeout: 60_000 }, async () => {
    const { context, sections } = await loadComposition()
    const bundleRows = [...context.loader.entries()]
      .filter(entry => entry.options.name === '@deepseek-ai/dsh-deamon' || entry.options.name === '@deepseek-ai/dsh-client-ui-sandbox-view')
    expect(bundleRows).toHaveLength(2)
    expect(sections.map(section => section.name)).toContain('app:shellbox-surface')
    const section = sections.find(entry => entry.name === 'app:shellbox-surface')
    expect(section?.order).toBe(105)
    expect(section?.text()).toContain('NOT Windows Sandbox')
    expect(section?.text()).toContain('Load the `shellbox` skill for the full usage manual')
  })

  it('keeps the surface section out when the profile composes it off', { timeout: 60_000 }, async () => {
    const { sections } = await loadComposition({ surfaceContext: false })
    expect(sections.map(section => section.name)).not.toContain('app:shellbox-surface')
    expect(sections.map(section => section.name)).not.toContain('app:shellbox-changes')
  })

  it('publishes the shellbox changes section with empty text when nothing observes a dirty projection', { timeout: 60_000 }, async () => {
    const { sections } = await loadComposition()
    const section = sections.find(entry => entry.name === 'app:shellbox-changes')
    expect(section).toBeDefined()
    expect(section?.order).toBe(106)
    // No agent in the fixture assemble context, and no projection registry in
    // this composition: both absences contribute nothing.
    expect(section?.text()).toBe('')
    const withAgent = (section?.text as (context?: unknown) => string)({ agent: { session: {} } })
    expect(withAgent).toBe('')
  })

  it('drops the shellbox changes section when the bundle row is disposed', { timeout: 60_000 }, async () => {
    const { context, sections } = await loadComposition()
    expect(sections.map(section => section.name)).toContain('app:shellbox-changes')
    const row = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-deamon')
    expect(row?.fiber).toBeDefined()
    await row?.fiber?.dispose()
    expect(sections.map(section => section.name)).not.toContain('app:shellbox-changes')
  })
})
