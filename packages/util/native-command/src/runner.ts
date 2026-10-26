/**
 * Shared no-shell `execFile` runner for host-native OS integrations.
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile } from 'node:child_process'

/** Per-command launch policy. */
export interface NativeCommandOptions {
  /**
   * Hide the child's window on Windows. Console helpers leave this unset, since
   * they must never flash a console; a command that shows its OWN GUI window —
   * the file manager this package opens — must pass `false`, because the hidden
   * startup state is inherited by the window the child creates.
   */
  readonly windowsHide?: boolean
}

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  options?: NativeCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

/**
 * Run a host command with utf8 stdio, abort propagation, and Windows hide.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @param options - launch policy; the child window stays hidden unless the caller opts out.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: options?.windowsHide ?? true },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
