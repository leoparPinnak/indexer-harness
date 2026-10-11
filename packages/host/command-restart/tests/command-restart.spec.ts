import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as commandRestart from '@deepseek-ai/dsh-command-restart'

interface LaunchRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly detached: boolean
  readonly unrefed: boolean
  readonly env: NodeJS.ProcessEnv
  readonly windowsHide?: boolean | undefined
}
/** A fully faked process environment: nothing spawns, nothing exits. */
function fakeEnvironment(overrides: Partial<commandRestart.RestartEnvironment> = {}): {
  readonly environment: commandRestart.RestartEnvironment
  readonly launches: LaunchRecord[]
  readonly scheduled: { readonly delayMs: number; readonly run: () => void }[]
  readonly exits: number[]
} {
  const launches: LaunchRecord[] = []
  const scheduled: { readonly delayMs: number; readonly run: () => void }[] = []
  const exits: number[] = []
  // Default: no port, so no `DSH_RESTART_WAIT_PORT` hand-over flag appears in
  // the spawn env; a `port` override exercises that contract.
  const environment: commandRestart.RestartEnvironment = {
    argv: ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', '4004'],
    cwd: 'C:\\repo',
    env: { DSH_HOME: 'C:\\home' },
    port: undefined,
    launch: (command, args, options) => {
      launches.push({
        command,
        args,
        detached: options.detached,
        unrefed: false,
        env: options.env,
        windowsHide: options.windowsHide,
      })
      return {
        unref: () => {
          const last = launches[launches.length - 1]
          if (last !== undefined) launches[launches.length - 1] = { ...last, unrefed: true }
        },
      }
    },
    schedule: (run, delayMs) => { scheduled.push({ delayMs, run }) },
    exit: (code) => { exits.push(code) },
    ...overrides,
  }
  return { environment, launches, scheduled, exits }
}

function stubAgent(ctx: Context, id: string): Agent {
  return {
    ctx,
    session: Session.create(SessionId(id)),
    options: {},
  } as unknown as Agent
}

async function harness(): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  // ToolRuntime's `inject = ['systemPrompt']` makes it a class plugin that
  // constructs only behind the service chain it names (the tool-goal harness
  // mounts the same prefix), so `ctx.tools` exists for the eager registration.
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const plugin = await ctx.plugin(commandRestart)
  return { ctx, agent: stubAgent(ctx, 'command-restart'), plugin }
}

describe('@deepseek-ai/dsh-command-restart registration', () => {
  it('registers one argument-free command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandRestart.name).toBe('command-restart')
    expect(commandRestart.inject).toEqual(['commands', 'tools'])
    expect('default' in commandRestart).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandRestart)).toBe(commandRestart)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-restart',
      name: 'dsh_restart',
      description: 'Restart the backend process (it relaunches itself after a short pause)',
    })

    expect(test.ctx.tools.schemas().map(schema => schema.name)).toContain('dsh_server_restart')

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'dsh_restart')).toBeUndefined()
    expect(test.ctx.tools.schemas().map(schema => schema.name)).not.toContain('dsh_server_restart')
  })
})

/** Pinned model-facing `dsh_server_restart` tool description. */
const TOOL_DESCRIPTION = 'Restart the running dsh backend process: this process schedules its replacement '
  + '(waiting for the port to free), answers this call, then exits — you continue against the fresh '
  + 'backend and the session log carries over. Use only when the operator asks to restart or reboot '
  + 'the harness, or when a rebuilt backend must take over. Argument-free.'

describe('dsh_server_restart tool', () => {
  it('builds an argument-free tool whose description pins the model-facing contract', () => {
    const { environment } = fakeEnvironment()
    const tool = commandRestart.makeServerRestartTool(environment)
    expect(tool.name).toBe('dsh_server_restart')
    expect(tool.description).toBe(TOOL_DESCRIPTION)
    expect(Object.keys(tool.parameters['properties'] ?? {})).toEqual([])
  })

  it('spawns the replacement before scheduling the exit and reports the swap', async () => {
    const { environment, launches, scheduled, exits } = fakeEnvironment()
    const tool = commandRestart.makeServerRestartTool(environment)
    const result = await tool.execute({}, {} as never)
    expect(result).toEqual({
      ok: true,
      detail: expect.stringContaining('Restarting the backend'),
    })
    expect(launches.length).toBe(1)
    expect(launches[0]!.unrefed).toBe(true)
    expect(scheduled.length).toBe(1)
    for (const entry of scheduled) entry.run()
    expect(exits).toEqual([0])
  })

  it('refuses an environment with no command line to mirror', async () => {
    const empty = fakeEnvironment({ argv: [] })
    const tool = commandRestart.makeServerRestartTool(empty.environment)
    const result = await tool.execute({}, {} as never)
    expect(result).toEqual({
      ok: false,
      detail: 'Restart is unavailable: this process has no command line to mirror.',
    })
    expect(empty.launches).toEqual([])
    expect(empty.scheduled).toEqual([])
    expect(empty.exits).toEqual([])
  })
})

describe('/dsh_restart execution', () => {
  it('spawns its own replacement immediately and schedules only the graceful exit', async () => {
    const { environment, launches, scheduled, exits } = fakeEnvironment({ port: 4004 })
    const result = await commandRestart.executeRestart(environment, {
      agent: {} as Agent,
      commandId: 'cmd-1',
      rawInput: '',
    } as unknown as Parameters<typeof commandRestart.executeRestart>[1])

    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain('Restarting the backend')
    // The spawn happens BEFORE this process can exit: `process.exit` erases
    // pending timers, so a relaunch scheduled after the exit would never run.
    expect(launches.length).toBe(1)
    const launch = launches[0]!
    expect(launch.command).toBe('node')
    expect(launch.args).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', '4004'])
    expect(launch.detached).toBe(true)
    expect(launch.windowsHide).toBe(true)
    // A detached child that is not unref'd would die with this process.
    expect(launch.unrefed).toBe(true)
    // listener to release port 4004 before binding.
    expect(launch.env['DSH_RESTART_WAIT_PORT']).toBe('4004')
    expect(exits).toEqual([])
    expect(scheduled.length).toBe(1)
    for (const entry of scheduled) entry.run()
    expect(exits).toEqual([0])
  })

  it('carries no hand-over env when the port is unknown, and refuses an environment with no command line', async () => {
    const { environment, launches, scheduled } = fakeEnvironment()
    const result = await commandRestart.executeRestart(environment, {
      rawInput: '',
    } as unknown as Parameters<typeof commandRestart.executeRestart>[1])
    expect(result.kind).toBe('success')
    expect(launches[0]!.env['DSH_RESTART_WAIT_PORT']).toBeUndefined()
    expect(scheduled.length).toBe(1)

    const empty = fakeEnvironment({ argv: [] })
    const refused = await commandRestart.executeRestart(empty.environment, {
      rawInput: '',
    } as unknown as Parameters<typeof commandRestart.executeRestart>[1])
    expect(refused).toEqual({
      kind: 'error',
      text: 'Restart is unavailable: this process has no command line to mirror.',
    })
    expect(empty.scheduled).toEqual([])
    expect(empty.exits).toEqual([])
  })

  it('rejects arguments', async () => {
    const { environment } = fakeEnvironment()
    const withArgs = await commandRestart.executeRestart(environment, {
      rawInput: ' now',
    } as unknown as Parameters<typeof commandRestart.executeRestart>[1])
    expect(withArgs).toEqual({ kind: 'error', text: 'Usage: /dsh_restart (no arguments)' })
  })
})

describe('resolveProcessPort', () => {
  it('resolves port from DSH_WEB_PORT environment variable', () => {
    expect(commandRestart.resolveProcessPort({ DSH_WEB_PORT: '4004' }, [])).toBe(4004)
  })

  it('resolves port from --port CLI flag when env is absent', () => {
    expect(commandRestart.resolveProcessPort({}, ['node', 'bin.ts', 'web', '--port', '4004'])).toBe(4004)
  })

  it('returns undefined when neither is set or valid', () => {
    expect(commandRestart.resolveProcessPort({}, ['node', 'bin.ts', 'web'])).toBeUndefined()
    expect(commandRestart.resolveProcessPort({ DSH_WEB_PORT: 'invalid' }, [])).toBeUndefined()
  })
})
