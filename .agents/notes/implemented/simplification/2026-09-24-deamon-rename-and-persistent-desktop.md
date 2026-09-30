# Agent Note: DEAMON is the bundle identity and the desktop lives until explicit stop

Status: implemented

English | [中文](2026-09-24-deamon-rename-and-persistent-desktop.zh.md)

## Problem

The Shellbox bundle carried a second identity: the npm package, directory, host row id, daemon source files, discovery file, log prefixes, and profile markers all spelled `shellbox`/`ShellboxDaemon`, while the name the system presents to operators is DEAMON, so every reading of a manifest, log line, or dump-config marker required mapping one name onto the other.

The 30-second idle stop that reaped a helper after the last viewer left fought the product expectation: an operator who opens the desktop once expects the normal desktop to stay there until they shut it down, and every close of the Sidebar tab silently ended that session's desktop.

## Decision

- The bundle's identity is DEAMON everywhere: package `@deepseek-ai/dsh-deamon` at `protop/shellbox/deamon`, host row `id: deamon`, sources `src/deamon.ts` and `src/deamon-manager.ts`, classes `DeamonManager`/`DeamonHandle`, environment `DEAMON_PORT` and `DEAMON_DISCOVERY_FILE`, discovery file `deamon.json`, health `service: 'deamon'`, log prefixes `[deamon]`, and the dump-config marker `# == @deepseek-ai/dsh-deamon`.
- Shellbox stays the feature and surface name: the `dsh-shellbox`/`dsh-sb-<session>` desktop names, `shellbox_launch` tool, `shellbox` skill, `app:shellbox-surface` section, `ShellboxDock` tab, `/api/server/shellbox/launch` route alias, the frozen `/api/server/sandbox/*` wire, and the `shellbox-profiles` browser profile directory are untouched.
- The idle stop is gone: `internals.idleStopMs`, the idle timer, and their arm/disarm call sites in `stream()`, `launch()`, `stop()`, and `settleChild()` are deleted, so closing the last viewer leaves the helper capturing; `publish()` already drops frames while no client is connected, so that path changes nothing else.
- A desktop now ends only through an explicit action: `POST /api/server/sandbox/stop`, an instance terminate, the manager's shutdown sweep, or a server shutdown; a helper crash still respawns the helper and relaunches the shell on the same desktop.
- First start shows the normal desktop with no extra step: `sandbox-host.ps1` launches `explorer.exe` on the private desktop before capture begins, so the first frame the pane paints is the desktop shell rather than an empty surface.

## Alternatives considered

**Keep the idle stop and only rename.** Rejected: the operator contract is persistence until explicit shutdown, and a reaping timer cannot satisfy it without a keep-alive channel the product does not have; once persistence is the rule, the timer's arm/disarm bookkeeping across four methods is deleted code.

**Move the reaper into a plugin.** Rejected in the removal decision: the desktop feature wants no separate lifecycle owner — the controller that starts the helper is the one that stops it, on explicit commands only.

## Consequences

- Capture keeps running at full frame rate while a desktop is alive even with no viewer, a continuous CPU cost accepted for the desktop's whole lifetime.
- Desktops and their helpers accumulate across sessions until an explicit stop or a server shutdown sweeps them; the sweep remains the backstop for forgetting.
- `POST /api/server/sandbox/stop` and the server shutdown button are now the only ways a healthy desktop ends, so the GUI stop button and the route contract carry more weight.
- [stream-liveness](../bug-fix/2026-09-22-shellbox-stream-liveness.md) previously owned the idle-grace decision; this note supersedes that part and leaves its reconnect and proxy decisions intact. [shellbox-bundle-extraction](../architecture/2026-09-24-shellbox-bundle-extraction.md) keeps owning the extraction decision with its identifiers updated in place.

## Testing

- `protop/shellbox/deamon/tests/sandbox-routes.spec.ts` replaces the idle-reap case with `keeps the helper alive after the last viewer leaves`: stream to a viewer, close it, wait past the old window's test substitute (2.5 seconds), and assert `isActive()` is still true; every other route pin is unchanged.
- `protop/shellbox/deamon/tests/deamon.spec.ts` pins `service: 'deamon'`, the `deamon.json` discovery file, `DEAMON_DISCOVERY_FILE` isolation, and the `deamon stdout:` relay lines through `DeamonManager`.
- `protop/shellbox/deamon/tests/loader-composition.spec.ts` boots the shipped patch with row id `deamon`, `verify-config-catalog` pins the `# == @deepseek-ai/dsh-deamon` section, and `profile.spec.ts` together with `built-bin.e2e.ts` assert the `web` profile template tuple and the dump-config marker.
