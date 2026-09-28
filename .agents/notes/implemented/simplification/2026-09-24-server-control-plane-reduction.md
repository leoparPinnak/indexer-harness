# Agent Note: Server control plane reduced to process-exit shutdown

Status: implemented

English | [中文](2026-09-24-server-control-plane-reduction.zh.md)

## Problem

The settings power dialog shipped three controls: a soft refresh, a hard reset that wrote `.dsh/restart.signal` through `POST /api/server/restart` while polling `GET /api/server/ping`, and the process-exit shutdown. Outside the tree, restarts depended on unowned helpers — `baslat.bat`/`kapat.bat` driving `scripts/launcher.ps1`, whose watchdog loop held its own terminal, `scripts/hard-reset.*` background watchers, and a home-level `heartbeat.mjs` probing the web and daemon ports every 10 seconds. The user reported the start/stop helpers and the program watcher as unreliable and asked to keep only the button that exits the server process.

## Decision

- The settings power button opens a shutdown-only dialog: one danger card posting `/api/server/shutdown`, which answers, emits `SIGTERM`, and falls through to `process.exit(0)`. The `power.*` locale keys, the stage machine, the ping polling, and the orb/pill status face are gone from en/zh/tr.
- `@deepseek-ai/dsh-web-app` drops `POST /api/server/restart`, `GET /api/server/ping`, and both `.dsh/*.signal` writers; the shutdown route keeps its origin fence and method check.
- The helper scripts are deleted (`scripts/launcher.ps1`, `scripts/hard-reset.ps1`, `scripts/hard-reset.bat`, `baslat.bat`, `kapat.bat`) as is the heartbeat watcher with its `heartbeat.log`. Starting again is the documented `dsh web` launch.
- [server-death-evidence](../bug-fix/2026-09-23-server-death-evidence.md) stays active: its log-reading authority (tee, exit witness, alive tick, port-owner message) still ships; its helper and heartbeat actor rows were rewritten in place under that partial supersession.

## Consequences

One exit path remains (GUI → shutdown route → SIGTERM → exit), and restart or recovery is a manual `dsh web` start from a terminal. Death evidence stays in `$DSH_HOME/logs/dsh-web.log`; a second manual start ends with `stopping code=1` and the named port owner.

## Alternatives considered

**Keep restart behind a config flag.** Rejected: the failing machinery was the reported problem, and no current consumer would remain behind a flag.

**Keep `/api/server/ping` as a generic health endpoint.** Rejected: its only consumer was the removed hard-reset poller, so it fails the current-owner rule.

## Testing

`settings-root.client.spec.tsx` pins the shutdown-only dialog (soft and hard absent) and the `POST /api/server/shutdown` completion copy; `test:gui`, typecheck, oxlint, and doc-sync cover the host route removal.
