/**
 * Best-effort owner lookup for a taken TCP port, feeding the single-instance
 * guard's diagnostic. It runs one platform command and parses its listening
 * table; an absent tool, a missing match, or a missing permission all read as
 * `unknown` so the already-failed boot never fails a second time here.
 * @module @deepseek-ai/dsh-host-webserver/port-owner
 */

import { spawnSync } from 'node:child_process'

/** Runs one diagnostic command and returns its stdout, or null when the command is unusable. */
export type ProbeRunner = (cmd: string, args: readonly string[]) => string | null

/** The platform command listing listening sockets with owning processes. */
const defaultProbeRunner: ProbeRunner = (cmd, args) => spawnSync(cmd, [...args], { encoding: 'utf-8', windowsHide: true, timeout: 3_000 }).stdout

/** Extract the PID listening on `port` from one port-table dump. */
function parseListeningPid(output: string, port: number, win32: boolean): string | undefined {
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim()
    if (win32) {
      // netstat -ano columns: protocol, local address, foreign address, state, PID.
      const cols = line.split(/\s+/u)
      if (cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING') return cols[4]
    } else if (line.startsWith('LISTEN') && line.includes(`:${port} `)) {
      // ss -lptn: users:(("node",pid=<PID>,fd=<fd>)) appears only for readable owners.
      const pid = /pid=(\d+)/u.exec(line)?.[1]
      if (pid !== undefined) return pid
    }
  }
  return undefined
}

/**
 * Probe who listens on `port` right now. Best effort by design: the guard's
 * message degrades to `PID=unknown` instead of delaying the diagnostic.
 * @param port - TCP port whose listener is wanted.
 * @param platform - OS selecting the command; defaults to this process's platform.
 * @param run - command runner; specs inject fixture dumps.
 * @returns the owner PID as text, or `unknown`.
 */
export function probePortOwnerPid(
  port: number,
  platform: NodeJS.Platform = process.platform,
  run: ProbeRunner = defaultProbeRunner,
): string {
  const win32 = platform === 'win32'
  const output = run(win32 ? 'netstat' : 'ss', win32 ? ['-ano'] : ['-lptn'])
  if (output === null) return 'unknown'
  return parseListeningPid(output, port, win32) ?? 'unknown'
}
