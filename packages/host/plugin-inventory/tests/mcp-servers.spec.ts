import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { mcpStatusRegistry } from '@deepseek-ai/dsh-mcp-client'
import PluginInventoryGateway from '../src/index.ts'
import { readManagedRows } from '../src/patch.ts'

/** Declared row ids in block order, the shape `readDeclaredIds` reports. */
function readDeclaredIdsShape(patchPath: string): string[] {
  return [...readManagedRows(patchPath).map(row => 'insert' in row ? row.insert[0]?.id ?? '' : row.id).filter(id => id !== '')]
}

const contexts: Context[] = []
let savedHome: string | undefined
let directory: string

beforeEach(() => {
  savedHome = process.env.DSH_HOME
  directory = mkdtempSync(path.join(tmpdir(), 'dsh-mcp-servers-'))
  process.env.DSH_HOME = directory
  mcpStatusRegistry.clear()
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  mcpStatusRegistry.clear()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(directory, { recursive: true, force: true })
})

const activePlugin: Plugin.Function = () => {}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway.mcpServers', () => {
  it('joins each mcp-client row with the status registry and skips other rows', async () => {
    const { ctx, inventory } = await harness()
    const mcpId = await ctx.loader.create({
      name: '@deepseek-ai/dsh-mcp-client',
      disabled: true,
      config: { serverName: 'rea' },
    })
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-mcp-client',
      disabled: true,
      config: {},
    })
    await ctx.loader.create({ name: 'cordis:active' })
    mcpStatusRegistry.record({
      serverName: 'rea',
      scope: 'global',
      state: 'failed',
      at: 1_000,
      toolCount: 2,
      toolNames: ['mcp__rea__a', 'mcp__rea__b'],
      lastError: 'connection lost and reconnect is disabled',
    })

    const snapshot = await inventory.mcpServers()

    expect(snapshot.servers).toEqual([
      {
        entryId: mcpId,
        serverName: 'rea',
        enabled: false,
        fiberPhase: null,
        toolCount: 2,
        state: 'failed',
        lastError: 'connection lost and reconnect is disabled',
      },
    ])
  })

  it('reports unrecorded servers as zero tools and no transition', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-mcp-client',
      disabled: true,
      config: { serverName: 'web' },
    })

    const snapshot = await inventory.mcpServers()

    expect(snapshot.servers).toEqual([
      {
        entryId: expect.any(String),
        serverName: 'web',
        enabled: false,
        fiberPhase: null,
        toolCount: 0,
        state: null,
        lastError: null,
      },
    ])
  })

  it('reports the id a patch list addresses, not the tree-qualified path', async () => {
    const { ctx, inventory } = await harness()
    // A group tree is the shape every profile patch builds. The deployment's
    // include tree reports `include:mcp-rea` for the row its patch list calls
    // `mcp-rea`, and a patch list can only address the id the row declares.
    // The qualification is injected here because a bare Loader harness has no
    // enclosing include tree to compose it.
    ctx.loader.builtins.group = Group
    await ctx.loader.create({
      id: 'include',
      name: 'cordis:group',
      group: true,
      config: [{
        id: 'mcp-rea',
        name: '@deepseek-ai/dsh-mcp-client',
        disabled: true,
        config: { serverName: 'rea' },
      }],
    } as never)
    const nested = [...ctx.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')!
    Object.defineProperty(nested, 'id', { get: () => `include:${String(nested.options.id)}` })

    expect(nested.id).toBe('include:mcp-rea')

    const snapshot = await inventory.mcpServers()

    expect(snapshot.servers).toEqual([
      {
        entryId: 'mcp-rea',
        serverName: 'rea',
        enabled: false,
        fiberPhase: null,
        toolCount: 0,
        state: null,
        lastError: null,
      },
    ])
  })

  it('projects a loaded row with its active fiber phase and recorded transitions', async () => {
    const { ctx, inventory } = await harness()
    ctx.loader.builtins['@deepseek-ai/dsh-mcp-client'] = activePlugin
    const entryId = await ctx.loader.create({
      name: 'cordis:@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'silent' },
    })
    mcpStatusRegistry.record({
      serverName: 'silent',
      scope: 'global',
      state: 'connected',
      at: 2_000,
      toolCount: 3,
      toolNames: ['mcp__silent__a', 'mcp__silent__b', 'mcp__silent__c'],
    })

    const snapshot = await inventory.mcpServers()

    expect(snapshot.servers).toEqual([
      {
        entryId,
        serverName: 'silent',
        enabled: true,
        fiberPhase: 'active',
        toolCount: 3,
        state: 'connected',
        lastError: null,
      },
    ])
  })
})

describe('PluginInventoryGateway.setMcpServerEnabled', () => {
  it('writes a managed disable row into the home patch and returns the refreshed rows', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-mcp-client',
      disabled: true,
      config: { serverName: 'rea' },
    })
    const patchPath = path.join(directory, 'cordis.patch.yml')

    const disabled = await inventory.setMcpServerEnabled('mcp-rea', false)

    expect(readFileSync(patchPath, 'utf8')).toContain('- {"id":"mcp-rea","disabled":true}')
    expect(disabled.servers).toHaveLength(1)

    const enabled = await inventory.setMcpServerEnabled('mcp-rea', true)

    expect(readFileSync(patchPath, 'utf8')).not.toContain('"mcp-rea"')
    expect(enabled.servers).toHaveLength(1)
  })

  it('sweeps a stale path-qualified disable row when toggling', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({ name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'rea' } })
    const patchPath = path.join(directory, 'cordis.patch.yml')
    // An older writer left a tree-qualified row: the re-enable kept failing
    // because the toggle had no key that matched it.
    writeFileSync(
      patchPath,
      '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\n'
      + '- {"id":"include:mcp-rea","disabled":true}\n'
      + '# --- end dsh-mcp-toggle ---\n',
    )

    const enabled = await inventory.setMcpServerEnabled('mcp-rea', true)

    expect(readFileSync(patchPath, 'utf8')).not.toContain('"mcp-rea"')
    expect(enabled.servers).toHaveLength(1)
  })

  it('adds a managed server insert row and lists it', async () => {
    const { inventory } = await harness()
    const patchPath = path.join(directory, 'cordis.patch.yml')

    const added = await inventory.addMcpServer({
      serverName: 'github',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: { KEY: 'value' },
    })

    // The write lands on disk; a unit harness has no live recomposition, so
    // the loader presents the row only after `patchReload: live` picks it up.
    const text = readFileSync(patchPath, 'utf8')
    const row = JSON.parse(text.split('\n').find(line => line.startsWith('- {"insert":'))!.slice(2))
    expect(row).toEqual({
      insert: [{
        id: 'mcp-github',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'github',
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: { KEY: 'value' },
        },
      }],
    })
    expect(added.servers).toEqual([])
    expect(readDeclaredIdsShape(patchPath)).toEqual(['mcp-github'])
  })

  it('refuses a server name that is already configured or malformed', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({ name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'rea' } })

    await expect(inventory.addMcpServer({
      serverName: 'rea',
      transport: 'stdio',
      command: 'node',
    })).rejects.toThrow(/already configured/)
    await expect(inventory.addMcpServer({
      serverName: 'bad name!',
      transport: 'stdio',
      command: 'node',
    })).rejects.toThrow(/serverName must match/)
    await expect(inventory.addMcpServer({
      serverName: 'web',
      transport: 'stdio',
    })).rejects.toThrow(/requires its command field/)
  })

  it('refuses to add without a harness home to hold the patch', async () => {
    const { inventory } = await harness()
    delete process.env.DSH_HOME

    await expect(inventory.addMcpServer({
      serverName: 'github',
      transport: 'stdio',
      command: 'node',
    })).rejects.toThrow(/DSH_HOME is required/)
  })

  it('refuses to toggle without a harness home to hold the patch', async () => {
    const { inventory } = await harness()
    delete process.env.DSH_HOME

    await expect(inventory.setMcpServerEnabled('mcp-rea', false)).rejects.toThrow(/DSH_HOME is required/)
  })
})