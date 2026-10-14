/**
 * `/dsh_restart` — operator self-restart of the running backend.
 *
 * The command replaces the ad-hoc "kill the PID, relaunch from a batch file"
 * dance: it re-launches THIS process with its own argv/cwd/env, detached and
 * unref'd (so it survives this process), then exits cleanly. The child waits
 * for the old listener to release the port before booting, which makes a
 * `/dsh_restart` followed by a browser refresh a complete cycle.
 *
 * Design constraints that shaped this module:
 * - **No supervisor needed.** The relaunch is a detached sibling process, not a
 *   child we must keep alive, so the restart survives even if the parent is
 *   killed immediately after.
 * - **No lost work.** Sessions and queues are persisted by the host before the
 *   exit; this command only swaps the process, it never touches journal state.
 * - **Honest outcomes.** A refused environment (tests, no argv to mirror) is a
 *   clear error row, never a silent no-op that pretends to have restarted.
 * @module @deepseek-ai/dsh-command-restart
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RESTART_WAIT_PORT_ENV } from '@deepseek-ai/dsh-app-boot/src/restart-wait.ts'

export const name = 'command-restart'
export const inject = ['commands', 'tools']

const USAGE = 'Usage: /dsh_restart (no arguments)'

/** Delay before this process exits, so the HTTP answer reaches the client. */
const EXIT_GRACE_MS = 150

/** Minimal seam so the lifecycle is testable without killing the test runner. */
export interface RestartEnvironment {
  /**
   * Full relaunch vector: the executable, the interpreter flags, then the
   * script arguments. NOT `process.argv` verbatim — Node consumes its own
   * flags (like `--import tsx/esm`) before argv exists, so a bare argv mirror
   * spawns a loader-less `node bin.ts` that cannot read TypeScript.
   */
  readonly argv: readonly string[]
  /** Working directory the backend runs in. */
  readonly cwd: string
  /** Environment handed to the relaunched process. */
  readonly env: NodeJS.ProcessEnv
  /** Port the backend listens on, when known. */
  readonly port?: number | undefined
  /** Relaunch a detached process. The optional `on` hook surfaces async spawn failures. */
  readonly launch: (command: string, args: readonly string[], options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly detached: boolean
    readonly stdio: 'ignore'
    readonly windowsHide?: boolean | undefined
  }) => {
    readonly unref: () => void
    readonly on?: (event: 'error', listener: (error: Error) => void) => void
  }
  /** Schedule the graceful exit after the answer has been delivered. */
  readonly schedule: (run: () => void, delayMs: number) => void
  /** Terminate this process after the answer has been delivered. */
  readonly exit: (code: number) => void
}

/**
 * Extract listen port from environment or argv flags (--port <number>).
 */
export function resolveProcessPort(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): number | undefined {
  const fromEnv = Number.parseInt(env['DSH_WEB_PORT'] ?? '', 10)
  if (!Number.isNaN(fromEnv) && fromEnv > 0) return fromEnv
  const portIndex = argv.indexOf('--port')
  if (portIndex !== -1 && portIndex + 1 < argv.length) {
    const fromArg = Number.parseInt(argv[portIndex + 1] ?? '', 10)
    if (!Number.isNaN(fromArg) && fromArg > 0) return fromArg
  }
  return undefined
}

/** The real process environment. */
export const processEnvironment: RestartEnvironment = {
  argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  cwd: process.cwd(),
  env: process.env,
  port: resolveProcessPort(),
  launch: (command, args, options) => spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: options.windowsHide ?? true,
  }),
  schedule: (run, delayMs) => { setTimeout(run, delayMs) },
  exit: (code) => { process.exit(code) },
}

/**
 * Start the replacement backend as a detached, unref'd sibling process.
 * @param environment - process seam carrying argv/cwd/env.
 */
function launchDetached(environment: RestartEnvironment): void {
  const [command, ...args] = environment.argv
  if (command === undefined || environment.argv.length === 0) return
  const child = environment.launch(command, args, {
    cwd: environment.cwd,
    // The replacement waits for this process's listener to release the port
    // before it binds (the hand-over contract in `@deepseek-ai/dsh-app-boot`).
    env: environment.port === undefined
      ? environment.env
      : { ...environment.env, [RESTART_WAIT_PORT_ENV]: String(environment.port) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  // Surface the hand-over in the server log and make an asynchronous spawn
  // failure loud: with stdio ignored and nobody listening for `error`, a failed
  // CreateProcess would otherwise die silently and the swap would look like a
  // plain crash.
  console.error(`[command-restart] spawning replacement: ${command} ${args.slice(0, 4).join(' ')}${args.length > 4 ? ' …' : ''}`)
  child.on?.('error', (error) => {
    console.error(`[command-restart] replacement spawn failed: ${String(error)}`)
  })
  // Detached + unref: the child must outlive this process, and this process
  // must be free to exit without waiting on it.
  child.unref()
}

/**
 * Schedule the restart swap and the graceful exit, shared by the operator
 * command and the `dsh_server_restart` model tool. The relaunch and the exit
 * are scheduled, never run inline, so whatever channel is answering right now
 * reaches its caller before this process goes away.
 * @param environment - process seam (overridable for tests).
 * @returns whether a restart was scheduled, with the caller-facing text.
 */
export function requestRestart(environment: RestartEnvironment): { readonly ok: boolean; readonly text: string } {
  if (environment.argv.length === 0 || environment.argv[0] === undefined) {
    return {
      ok: false,
      text: 'Restart is unavailable: this process has no command line to mirror.',
    }
  }
  // Spawn BEFORE the exit can ever fire: `process.exit` erases every pending
  // timer, so a relaunch scheduled after the exit would never run. The
  // replacement survives this process (detached + unref) and waits for the
  // port release itself.
  launchDetached(environment)
  environment.schedule(() => { environment.exit(0) }, EXIT_GRACE_MS)
  return {
    ok: true,
    text: `Restarting the backend in ~${environment.port === undefined ? 'a moment' : 'a few seconds'}… this page will reconnect automatically.`,
  }
}

/**
 * Execute the restart request.
 * @param environment - process seam (overridable for tests).
 * @param invocation - the human command invocation.
 * @returns the operator-facing outcome.
 */
export async function executeRestart(
  environment: RestartEnvironment,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  const outcome = requestRestart(environment)
  return outcome.ok
    ? { kind: 'success', text: outcome.text }
    : { kind: 'error', text: outcome.text }
}

/**
 * Build the `dsh_server_restart` model tool over one process seam. The tool is
 * the model-facing twin of the `/dsh_restart` operator command: same
 * relaunch-and-exit mechanics, argument-free, mounted exactly once on the host
 * plane so a restart can never register per session.
 * @param environment - process seam (overridable for tests).
 * @returns the composed tool definition.
 */
export function makeServerRestartTool(environment: RestartEnvironment): ToolDefinition {
  return defineTool({
    name: 'dsh_server_restart',
    description: 'Restart the running dsh backend process: this process schedules its replacement '
      + '(waiting for the port to free), answers this call, then exits — you continue against the fresh '
      + 'backend and the session log carries over. Use only when the operator asks to restart or reboot '
      + 'the harness, or when a rebuilt backend must take over. Argument-free.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Sunucuyu yeniden başlat',
      kind: 'execute',
    }),
    execute: async () => {
      const outcome = requestRestart(environment)
      return { ok: outcome.ok, detail: outcome.text }
    },
  })
}

/**
 * Register `/dsh_restart` on the host plane. One effect per registration so
 * each disposal stands alone: a process -level restart must never register per
 * session. The `dsh_server_restart` model twin is NO LONGER registered (see the
 * note in `apply`); its builder and relaunch mechanics stay in this module.
 * @param ctx - context carrying the command and tool registries.
 */
export function apply(ctx: Context): void {
  const runtimeEnv: RestartEnvironment = {
    ...processEnvironment,
    get port() {
      const serverPort = (ctx.get('webServer') as { port?: number } | undefined)?.port
      if (serverPort !== undefined && serverPort > 0) return serverPort
      const startupPort = (ctx.get('webStartup') as { port?: number } | undefined)?.port
      if (startupPort !== undefined && startupPort > 0) return startupPort
      return resolveProcessPort()
    },
  }
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-restart'),
    name: 'dsh_restart',
    description: 'Restart the backend process (it relaunches itself after a short pause)',
    handler: (invocation: CommandInvocation) => executeRestart(runtimeEnv, invocation),
  }), 'command-restart command')
  // MODEL ENJEKSİYONU PASİFİZE EDİLMİŞTİR: restart sonrası meydana gelen sürekli
  // cmd ekranı çıkma sorunu yüzünden pasifize edilmiştir. Aracın kendisi
  // (makeServerRestartTool) ve restart mekanizması duruyor; yalnızca model araç
  // listesine sunulmuyor — yani ajan böyle bir araçtan haberi olmadığı için
  // çağıramaz. Operatör komutu /dsh_restart etkilenmedi.
  // Yeniden etkinleştirmek istenirse aşağıdaki satırın yorumunu kaldırman yeterli:
  // ctx.effect(() => ctx.tools.register(makeServerRestartTool(runtimeEnv)), 'command-restart tool')
}
