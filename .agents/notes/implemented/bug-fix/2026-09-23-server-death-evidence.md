# Agent Note: Server death evidence — exit witness, alive tick, second-instance guard

Status: implemented

English | [中文](2026-09-23-server-death-evidence.zh.md)

## Problem

Three outages in one night ended identically: `$DSH_HOME/logs/dsh-web.log` stopped mid-routine with no error line and no exit line, Windows Event Log carried no node entry, and the process was simply gone — so an external force kill, the launcher's kill-then-start, and a hypothetical hang were indistinguishable from disk evidence. A second `dsh web` on the taken port died with a raw EADDRINUSE naming no owner, and `baslat.bat` re-runs could not be told apart from a first-death restart by anything on disk. The heartbeat watcher had also died at 05:10, so its `DEAD:` line was missing exactly when it was needed. The log tee that records this file was built by [shellbox-stream-liveness](2026-09-22-shellbox-stream-liveness.md); the restart helpers (`baslat.bat`, `kapat.bat`, `scripts/launcher.ps1`) and the heartbeat watcher were removed by [server-control-plane-reduction](../simplification/2026-09-24-server-control-plane-reduction.md), so the kill-then-start row and the heartbeat rows below no longer have live actors.

## Decision

- `packages/bundle/web-app/src/server-log.ts` installs an **exit witness**: a `process.on('exit')` handler appends `stopping code=<code> uptime=<seconds>s` synchronously to the log file. Every Node-driven exit (deliberate shutdown, uncaught-exception exit, CLI rejection) produces the line; a force kill terminates the process without running `exit` listeners, so the line's absence is the external-kill signature.
- An **alive tick** writes `alive uptime=<seconds>s` through the logger once per `ALIVE_TICK_MS` (60 seconds, `unref`'d), and `startup.ts` installs the tee plus the witness before parsing the command so boot-phase failures reach the file. The evidence reads as this table:

| Log evidence | Reading |
|---|---|
| `stopping code=0` after a normal boot | deliberate graceful shutdown |
| `stopping code=1` with `port <n> taken by PID=…, refusing second instance` — the guard text prints on the refused launch's console, the file carries the stopping line | refused second instance; the first server kept running |
| `stopping code=<other>` with a diagnostic line above it | startup rejection (bad flag, failed composition) with its cause recorded |
| last line `alive uptime=Xs`, no stopping line, no error, process gone | H1 external force kill (taskkill / console close / antivirus) |
| alive lines stop but the process still holds the port | H4 event-loop hang |
| no `alive` line at all after boot | death inside the first 60 seconds, or an instance running pre-witness code |
| gap between the last line and the next `dsh web:` URL line | outage window until the replacement start |

- The webserver's `EADDRINUSE` handler now rejects with `port <n> taken by PID=<pid|unknown>, refusing second instance (EADDRINUSE)`, the owner PID coming from one best-effort `netstat -ano` / `ss -lptn` probe in `packages/host/webserver/src/port-owner.ts` with a fixture-injectable runner; an unusable command reads `unknown` instead of delaying an already-failed boot. The probe runs when binding fails rather than before binding — the message is the plan's, the timing closes the time-of-check/time-of-use window and costs healthy boots nothing.
- `vitest.config.ts` narrows the `packages/host/webserver/src/*` coverage exemption to `index.ts` and `injections.ts`, so the new `port-owner.ts` stays under the per-file 100% gate.

## Alternatives considered

**Probe the port before binding.** Rejected as an implementation: binding and probing in one failure path yields the same user-visible message while closing the time-of-check/time-of-use gap and charging nothing to healthy boots; the plan's pre-bind probe survives as that message.

**Write the stopping line from a shutdown route.** Rejected: a shutdown route never runs on the failure paths being diagnosed; one `exit` registration covers every Node-driven exit.

**Keep the heartbeat watcher as the only probe.** Rejected: it died silently at 05:10 and none of that night's outages left a `DEAD:` line — the log file is the authority because the server writes it itself.

## Consequences

- Each outage after the restart leaves a readable death cause in one file. Production already exercised the protocol: instance A logged `alive uptime=68s` at 06:43:34, was force-killed by a second `baslat.bat` at 06:44:32 with no stopping line (the helper's kill-then-start, an H1 signature), and the current instance writes `alive` lines every 60 seconds.
- A refused second instance ends with `stopping code=1` and a named owner PID instead of a bare errno.
- The absence of a stopping line is now positive evidence of an external kill rather than an unmeasurable gap.

## Testing

- `packages/bundle/web-app/tests/server-log.spec.ts` pins the witness line (`stopping code=7 uptime=<n>s`), the no-witness no-op, one alive line per interval until disposal, and the 60-second default cadence.
- `packages/bundle/web-app/tests/startup.spec.ts` pins that boot-phase output reaches the file before later rows run; `tests/web-app.spec.ts` mounts the plugin and pins an alive line in the log file.
- `packages/host/webserver/tests/webserver.spec.ts` pins both `failed to apply loader entry.*EADDRINUSE` and the new `port \d+ taken by PID=\S+, refusing second instance` on a real double-bind; `tests/port-owner.spec.ts` injects win32 and ss dumps and pins match, no-match, unreadable owner, and unusable-command degradation.
- The `$DSH_HOME/heartbeat.mjs` watcher and the restart helper scripts were removed by [server-control-plane-reduction](../simplification/2026-09-24-server-control-plane-reduction.md); the log tee, exit witness, alive tick, and port-owner probe remain the shipped evidence surface.
