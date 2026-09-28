/**
 * The CDP bundle through a real Loader composition: the shipped bundle patch
 * boots every row against the fixture registries and mounts the
 * `/api/server/cdp/status` route, the `cdp_status` tool, and the model-visible
 * `app:cdp-status` prompt section.
 */

import { describe, expect, it } from 'vitest'
import { CDP_STATUS_PATH } from '../src/status.ts'
import { loadComposition } from './helpers.ts'

describe('cdp bundle through a real Loader composition', () => {
  it('boots every patch row and mounts the status route', { timeout: 60_000 }, async () => {
    const { context, routes, tools, warnings } = await loadComposition()
    expect(warnings).toEqual([])
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect([...routes]).toContain(CDP_STATUS_PATH)
    expect([...tools]).toContain('cdp_status')
    /* plan06: the screenshot/viewport additions mount through the same composition. */
    expect([...tools]).toContain('cdp_screenshot')
    expect([...tools]).toContain('cdp_viewport')
    /* plan02: the locator read tools + framework-safe fill mount through the same composition. */
    expect([...tools]).toContain('cdp_text')
    expect([...tools]).toContain('cdp_expect')
    expect([...tools]).toContain('cdp_fill')
    expect([...routes]).toContain('/api/server/cdp/screenshot')
    expect([...routes]).toContain('/api/server/cdp/viewport')
    /* plan04: the pool surface (endpoint discovery, briefs, contexts, detach). */
    expect([...tools]).toContain('cdp_endpoints')
    expect([...tools]).toContain('cdp_contexts')
    expect([...routes]).toContain('/api/server/cdp/endpoints')
    expect([...routes]).toContain('/api/server/cdp/connections')
    expect([...routes]).toContain('/api/server/cdp/contexts')
    expect([...routes]).toContain('/api/server/cdp/disconnect')
    /* plan08: find/extract (discovery + projection) mount through the same composition. */
    expect([...tools]).toContain('cdp_find')
    expect([...tools]).toContain('cdp_extract')
    expect([...routes]).toContain('/api/server/cdp/find')
    expect([...routes]).toContain('/api/server/cdp/extract')
  })

  it('publishes the app:cdp-status section through the injected systemPrompt', { timeout: 60_000 }, async () => {
    const { context, sections } = await loadComposition()
    const bundleRows = [...context.loader.entries()]
      .filter(entry => entry.options.name === '@deepseek-ai/dsh-cdp'
        || entry.options.name === '@deepseek-ai/dsh-client-ui-cdp-view')
    expect(bundleRows).toHaveLength(2)
    const section = sections.find(entry => entry.name === 'app:cdp-status')
    expect(section?.order).toBe(107)
    expect(section?.text()).toContain('cdp_status')
  })

  it('drops the prompt section and the status route when the bundle row is disposed', { timeout: 60_000 }, async () => {
    const { context, routes, sections } = await loadComposition()
    const row = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-cdp')
    expect(row?.fiber).toBeDefined()
    await row?.fiber?.dispose()
    expect(sections.map(section => section.name)).not.toContain('app:cdp-status')
    expect([...routes]).toEqual([])
  })

  it('rejects a proxy port that collides with the debugging port at load', { timeout: 60_000 }, async () => {
    await expect(loadComposition({ proxyListenPort: 9222 })).rejects.toThrow()
  })
})
