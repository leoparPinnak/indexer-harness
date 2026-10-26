// The shipped Web composition owns one real MCP session plane: an MCP bridge
// row inserted through the same profile-patch channel a deployment uses, the
// composer's session switch driven over `mcpSession`, and the model-facing
// tool list assembled after each write. Keyless — no model call is issued —
// and hermetic: the overlay and every temp root live outside the checkout.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const fixtureServer = resolve(import.meta.dirname, '../../../packages/mcp/mcp-client/tests/fixture-server.ts')

/** One server row the session plane reports. */
interface SessionServerView {
  serverName: string
  toolCount: number
  hostEnabled: boolean
  enabled: boolean
}

/** The session-plane surface this scenario drives, as the composer Remote reaches it. */
interface SessionPlane {
  list: (request: { sessionId: string }) => { servers: readonly SessionServerView[] }
  setServerEnabled: (request: { sessionId: string, serverName: string, enabled: boolean }) => { servers: readonly SessionServerView[] }
}

let scaffold: WebScaffold | undefined
let scratch: string | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

it('withholds and restores one MCP server for one session through the shipped composition', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-mcp-session-e2e-'))
  const overlayPath = join(scratch, 'mcp-overlay.yml')
  await writeFile(overlayPath, [
    '- insert:',
    '    - id: mcp-shipped-e2e',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: rea',
    '        transport: stdio',
    '        command: node',
    '        args:',
    `          - '${fixtureServer.replaceAll('\\', '/')}'`,
    '        toolCallTimeoutMs: 5000',
    '        failOnStartupError: false',
  ].join('\n'))

  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlayPath })
  const ctx = scaffold.ctx as unknown as {
    tools: { schemas: (agent?: unknown) => { name: string }[] }
    agents: { create: (options: Record<string, unknown>) => Promise<Record<string, unknown>> }
    get: (name: string) => unknown
    systemPrompt: { assemble: (options: Record<string, unknown>) => Promise<{ tools: { name: string }[] }> }
    agentPresets: { mount: (agentCtx: unknown) => Promise<unknown> }
  }
  const sessionId = 'mcp-shipped-e2e'

  // The bridge published the fixture server's tools on the Host plane.
  const deadline = Date.now() + 30_000
  while (!ctx.tools.schemas().some(schema => schema.name === 'mcp__rea__greet')) {
    if (Date.now() >= deadline) throw new Error('the MCP fixture never registered mcp__rea__greet')
    await new Promise(resolveWait => { setTimeout(resolveWait, 100) })
  }

  const plane = ctx.get('mcpSession') as SessionPlane | undefined
  expect(plane).toBeDefined()

  const handle = await ctx.agents.create({
    sessionId,
    setup: (agentCtx: unknown) => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  const agent = (handle as { agent: unknown }).agent
  const mcpNames = (): string[] =>
    ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith('mcp__'))

  // A configured, connected server: reachable, Host-enabled, session-visible.
  expect(plane!.list({ sessionId }).servers).toEqual([
    { serverName: 'rea', toolCount: 6, hostEnabled: true, enabled: true },
  ])
  expect(mcpNames().length).toBe(6)

  // The composer's write is the session's own decision: the next model request
  // — the assembled tool list — no longer offers that server.
  expect(plane!.setServerEnabled({ sessionId, serverName: 'rea', enabled: false }).servers).toEqual([
    { serverName: 'rea', toolCount: 6, hostEnabled: true, enabled: false },
  ])
  expect(mcpNames()).toEqual([])
  const withheld = await ctx.systemPrompt.assemble({ scope: agent })
  expect(withheld.tools.filter(tool => tool.name.startsWith('mcp__'))).toEqual([])

  // Switching back restores the same generation.
  expect(plane!.setServerEnabled({ sessionId, serverName: 'rea', enabled: true }).servers).toEqual([
    { serverName: 'rea', toolCount: 6, hostEnabled: true, enabled: true },
  ])
  const restored = await ctx.systemPrompt.assemble({ scope: agent })
  expect(restored.tools.map(tool => tool.name).filter(name => name.startsWith('mcp__'))).toContain('mcp__rea__greet')
  await handle.dispose()
}, 240_000)
