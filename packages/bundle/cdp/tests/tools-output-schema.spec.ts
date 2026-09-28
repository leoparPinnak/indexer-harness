/**
 * Output-schema conformance for the model-facing tools: every `execute` body
 * must satisfy its own declared `output.schema`, because the tool runtime
 * validates each successful value and throws `ToolOutputError
 * INVALID_TOOL_OUTPUT` otherwise (packages/core/tools createSuccessResult).
 *
 * The first regression captured here: `cdp_tabs` returned raw `TargetInfo`
 * rows — which always carry `attached: boolean` (src/targets.ts) — under an
 * `additionalProperties:false` schema that never declared it, so every call
 * with at least one tracked target failed validation.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, DEFAULT_PROXY_LISTEN_PORT, DEFAULT_REMOTE_DEBUGGING_PORT } from '../src/index.ts'
import type { Config as CdpConfig } from '../src/index.ts'

/** The shipped deployment settings, as the bundle patch restates them. */
const CONFIG: CdpConfig = {
  remoteDebuggingPort: DEFAULT_REMOTE_DEBUGGING_PORT,
  proxyListenPort: DEFAULT_PROXY_LISTEN_PORT,
  guideAssetsDir: '',
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the plugin on a fresh context and return its registered tools. */
async function registeredTools(config: CdpConfig = CONFIG): Promise<Map<string, ToolDefinition>> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('webServer', {
    host: '127.0.0.1',
    port: 4567,
    register: () => () => {},
  })
  ctx.reflect.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
    // plan05: registerCdpTools mounts a monotonic dialog guard (disposer).
    guard: () => () => {},
  })
  apply(ctx, config)
  // Deferred inject callbacks settle one macrotask after their services resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return tools
}

describe('tool output schema conformance', () => {
  it('cdp_tabs accepts a real TargetInfo row, attached field included', async () => {
    const tools = await registeredTools()
    const tabs = tools.get('cdp_tabs')
    expect(tabs, 'cdp_tabs must be registered').toBeDefined()

    // Exactly what execute returns: [...service.targets], and every tracked
    // TargetInfo (src/targets.ts) carries the five fields below.
    const value = {
      ok: true,
      tabs: [{
        targetId: 'TARGET-ID-1',
        type: 'page',
        title: 'Example',
        url: 'https://example.com/',
        attached: true,
      }],
    }

    const violations = validateJsonSchemaValue(tabs?.output.schema as never, value)
    expect(violations).toEqual([])
  })

  it('cdp_tabs still rejects undeclared keys, keeping the schema strict', async () => {
    const tools = await registeredTools()
    const tabs = tools.get('cdp_tabs')
    expect(tabs, 'cdp_tabs must be registered').toBeDefined()

    const value = {
      ok: true,
      tabs: [{
        targetId: 'T',
        type: 'page',
        title: '',
        url: 'about:blank',
        attached: false,
        unexpected: 'field',
      }],
    }

    const violations = validateJsonSchemaValue(tabs?.output.schema as never, value)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unexpected')
  })

  it('cdp_tabs renders a realistic row without throwing', async () => {
    const tools = await registeredTools()
    const tabs = tools.get('cdp_tabs')
    expect(tabs, 'cdp_tabs must be registered').toBeDefined()

    const value = {
      ok: true,
      tabs: [{ targetId: 'T1', type: 'page', title: 'Doc', url: 'https://a.test/', attached: true }],
    } as never
    const blocks = tabs?.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks?.[0]).toMatchObject({ type: 'text' })
  })
})
