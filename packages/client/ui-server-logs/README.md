---
description: "The settings Server Logs section for the dsh web client: the Web host's server log file tail as newest-first text, with live refresh, a substring filter, and a clear action."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-server-logs

English | [中文](README.zh.md)

## Summary

The settings Server Logs section: the tail of the Web host process log file (`$DSH_HOME/logs/dsh-web.log`), drawn newest-first so the freshest lines stay visible without scroll anchoring. It refreshes every two seconds, filters by substring, and truncates the file on demand. The host tee that writes the file and the tail routes live in `packages/bundle/web-app/src/server-log.ts`.

## Table of Contents

- [What it registers](#what-it-registers)
- [The log pane](#the-log-pane)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The section** — a `settings.section` entry with id `server-logs`, order 90 (diagnostics sit last), label from the `serverLogs` dictionary: the log pane and its filter/refresh/clear controls.

One source file under `src/client/`: `ServerLogsSection.tsx` (the pane and its controls), with `locales.ts` (what it says) and `index.ts` (the wiring).

<a id="the-log-pane"></a>
## The log pane

The section pulls `GET /api/server/logs?limit=300` on mount, every two seconds while auto-refresh is on, and on manual refresh; the response carries `{ ok, lines, truncated }` with lines oldest-first. The pane renders them newest-first as one `<pre>`, so following the log is re-rendering, not scrolling. A search box filters by case-insensitive substring; the clear button posts to `/api/server/logs/clear` and empties the pane. A refused load or clear leaves a one-line notice. The file outlives the host process, so the pane shows the previous run's tail after a restart — which is what makes a crash diagnosable.

<a id="model-experience"></a>
## Model Experience

None, as this package draws the host log file in the browser and registers nothing model-facing.

#### KV Cache effect

None; the tail travels over the Web host's own route and assembles no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **No structured levels.** The file holds raw console lines, so the pane filters by substring only; there is no level or source facet.
- **Single backup.** The host rotates the live file into one `dsh-web.log.1` past five megabytes; older history is not kept.
- **Reachability follows registration.** Whether the section exists at all is decided by the profile that mounts this package; the shipped bundles do not mount it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The section's only runtime state is the fetched lines plus its filter/refresh/clear controls, owned by the mounted component and released with its timer; there is no second observation of them to compare against.
